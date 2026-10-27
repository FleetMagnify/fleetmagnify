/**
 * Measured machinery idle burn rate from VisionLink Fleet Fuel litres
 * and Utilization idle hours.
 *
 * Rate = SUM(idle_fuel_litres) / SUM(idle_hours) over the newest 120
 * qualifying days. Owner-set and truck-regression rates are left alone.
 * One asset failing does not stop the others, and this helper does not throw.
 *
 * Trucks are skipped with FCM.isOnRoad, which treats a recognised
 * asset_type as on-road by itself. assets has no is_on_road column.
 */

var FCM = require('../js/fleet-cost-model');

var MIN_DAYS = 3;
var MIN_IDLE_HOURS = 3;
var RATE_MIN = 0.5;
var RATE_MAX = 25;
var RECENT_LIMIT = 120;

function sourceOf(asset) {
  return String((asset && asset.idle_rate_source) || '').toLowerCase().trim();
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function finiteNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  var n = Number(v);
  return isFinite(n) ? n : null;
}

function firstAsset(data) {
  if (!data) return null;
  if (Array.isArray(data)) return data[0] || null;
  return data;
}

function qualifyingRows(rows) {
  var out = [];
  (rows || []).forEach(function(r) {
    if (!r || r.record_date == null || r.record_date === '') return;
    var litres = finiteNumber(r.idle_fuel_litres);
    var hours = finiteNumber(r.idle_hours);
    if (litres == null || hours == null || hours <= 0) return;
    out.push({ litres: litres, hours: hours, day: String(r.record_date).slice(0, 10) });
  });
  return out;
}

async function recomputeOne(supabase, userId, assetId) {
  var assetResult = await supabase
    .from('assets')
    .select('id, asset_type, idle_burn_rate_lph, idle_rate_source')
    .eq('id', assetId)
    .eq('user_id', userId)
    .limit(1);
  if (assetResult.error) throw new Error(assetResult.error.message || 'asset lookup failed');

  var asset = firstAsset(assetResult.data);
  if (!asset) return;
  if (FCM.isOnRoad(asset)) return;

  var src = sourceOf(asset);
  if (src === 'set' || src === 'calibrated') return;

  var tel = await supabase
    .from('telematics_records')
    .select('record_date, idle_fuel_litres, idle_hours')
    .eq('asset_id', assetId)
    .eq('user_id', userId)
    .not('idle_fuel_litres', 'is', null)
    .not('idle_hours', 'is', null)
    .gt('idle_hours', 0)
    .order('record_date', { ascending: false })
    .limit(RECENT_LIMIT);
  if (tel.error) throw new Error(tel.error.message || 'telematics lookup failed');

  var rows = qualifyingRows(tel.data);
  var dayCount = {};
  rows.forEach(function(r) { dayCount[r.day] = true; });
  if (Object.keys(dayCount).length < MIN_DAYS) {
    console.log('visionlink-idle-rate: not enough measured idle data yet ' + assetId);
    return;
  }

  var sumLitres = 0;
  var sumHours = 0;
  rows.forEach(function(r) {
    sumLitres += r.litres;
    sumHours += r.hours;
  });
  if (!(sumHours >= MIN_IDLE_HOURS)) {
    console.log('visionlink-idle-rate: not enough measured idle data yet ' + assetId);
    return;
  }

  var rate = sumLitres / sumHours;
  if (!(isFinite(rate) && rate >= RATE_MIN && rate <= RATE_MAX)) {
    console.warn('visionlink-idle-rate: ' + assetId + ' ' + rate);
    return;
  }

  var rounded = round2(rate);
  var stored = finiteNumber(asset.idle_burn_rate_lph);
  var storedRounded = stored == null ? null : round2(stored);
  if (src === 'measured' && storedRounded != null && Math.abs(storedRounded - rounded) < 0.001) return;

  var upd = await supabase
    .from('assets')
    .update({
      idle_burn_rate_lph: rounded,
      idle_rate_source: 'measured'
    })
    .eq('id', assetId)
    .eq('user_id', userId);
  if (upd.error) throw new Error(upd.error.message || 'asset update failed');
}

async function recomputeMeasuredIdleRates(supabase, userId, assetIds) {
  try {
    if (!supabase || !userId) return;
    var ids = [];
    var seen = {};
    (assetIds || []).forEach(function(id) {
      var n = Number(id);
      if (!isFinite(n)) return;
      var key = String(n);
      if (seen[key]) return;
      seen[key] = true;
      ids.push(n);
    });
    for (var i = 0; i < ids.length; i++) {
      try {
        await recomputeOne(supabase, userId, ids[i]);
      } catch (err) {
        console.warn(
          'visionlink-idle-rate: asset ' + ids[i] + ' failed: ' +
          (err && err.message ? err.message : 'error')
        );
      }
    }
  } catch (err) {
    console.warn(
      'visionlink-idle-rate: recompute failed: ' +
      (err && err.message ? err.message : 'error')
    );
  }
}

module.exports = {
  recomputeMeasuredIdleRates: recomputeMeasuredIdleRates
};
