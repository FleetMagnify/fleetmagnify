/**
 * Navman Daily Mileage Report CSV parser.
 * Headers: Vehicle, Registration, VehicleGroup, ActivityDate, ActualDistance, Units
 */

const { parseCsvLine, normalizeHeader, parseNumeric, updateImportStatus, detectAssetType } = require('./parser-utils');

var MILEAGE_SIGNATURE = ['Vehicle', 'ActivityDate', 'ActualDistance'];

function isNavmanMileageHeaderRow(headers) {
  var normalized = headers.map(normalizeHeader);
  return MILEAGE_SIGNATURE.every(function(col) {
    return normalized.indexOf(col) !== -1;
  });
}

function isNavmanMileageCsv(rawCsv) {
  if (!rawCsv || !String(rawCsv).trim()) return false;
  var lines = String(rawCsv).split(/\r?\n/);
  var scanLimit = Math.min(lines.length, 10);
  for (var i = 0; i < scanLimit; i++) {
    if (lines[i] && lines[i].trim() && isNavmanMileageHeaderRow(parseCsvLine(lines[i]))) {
      return true;
    }
  }
  return false;
}

function parseDMY(dateStr) {
  // Parse DD/MM/YYYY explicitly — never use auto-detection
  var parts = String(dateStr || '').trim().split('/');
  if (parts.length !== 3) return null;
  var day = parts[0].padStart(2, '0');
  var month = parts[1].padStart(2, '0');
  var year = parts[2];
  if (year.length !== 4) return null;
  return year + '-' + month + '-' + day;
}

function parseNavmanMileageRows(rawCsv) {
  var lines = String(rawCsv).split(/\r?\n/);
  var headerIdx = -1;
  var headers = [];
  for (var i = 0; i < Math.min(lines.length, 10); i++) {
    var candidate = parseCsvLine(lines[i]);
    if (isNavmanMileageHeaderRow(candidate)) {
      headerIdx = i;
      headers = candidate.map(normalizeHeader);
      break;
    }
  }
  if (headerIdx === -1) return [];
  var rows = [];
  for (var j = headerIdx + 1; j < lines.length; j++) {
    var line = lines[j];
    if (!line || !line.trim()) continue;
    var values = parseCsvLine(line);
    if (values.every(function(v) { return !String(v).trim(); })) continue;
    var row = {};
    headers.forEach(function(h, idx) {
      if (h) row[h] = values[idx] != null ? String(values[idx]).trim() : '';
    });
    rows.push(row);
  }
  return rows;
}

async function loadAssetMap(supabase, userId) {
  var assetResult = await supabase.from('assets').select('id, asset_name, current_odometer').eq('user_id', userId);
  if (assetResult.error) throw new Error('Failed to load assets: ' + assetResult.error.message);
  var ignoredResult = await supabase.from('ignored_assets').select('asset_name').eq('user_id', userId);
  if (ignoredResult.error) throw new Error('Failed to load ignored assets: ' + ignoredResult.error.message);
  var ignoredSet = {};
  (ignoredResult.data || []).forEach(function(r) { ignoredSet[String(r.asset_name).trim()] = true; });
  var map = {};
  (assetResult.data || []).forEach(function(asset) {
    if (asset.asset_name) {
      map[asset.asset_name] = {
        id: asset.id,
        current_odometer: asset.current_odometer != null ? parseFloat(asset.current_odometer) : null
      };
    }
  });
  return { assetMap: map, ignoredSet: ignoredSet };
}

async function getRunningOdometer(supabase, userId, assetId) {
  var result = await supabase
    .from('telematics_records')
    .select('odometer_km')
    .eq('user_id', userId)
    .eq('asset_id', Number(assetId))
    .not('odometer_km', 'is', null)
    .order('record_date', { ascending: false })
    .limit(1);
  if (result.error || !result.data || !result.data.length) return null;
  var val = parseFloat(result.data[0].odometer_km);
  return isNaN(val) ? null : val;
}

async function ensureAssets(supabase, userId, rows) {
  var loaded = await loadAssetMap(supabase, userId);
  var assetMap = loaded.assetMap;
  var ignoredSet = loaded.ignoredSet;
  var pendingAdded = 0;
  var seen = {};
  for (var i = 0; i < rows.length; i++) {
    var vehicleName = rows[i].Vehicle;
    if (!vehicleName || seen[vehicleName]) continue;
    seen[vehicleName] = true;
    if (assetMap[vehicleName] || ignoredSet[vehicleName]) continue;
    var reg = rows[i].Registration ? String(rows[i].Registration).trim() : null;
    var pendingResult = await supabase.from('pending_assets').upsert({
      user_id: userId,
      asset_name: vehicleName,
      asset_type: detectAssetType(vehicleName),
      registration: reg || null,
      source: 'navman-mileage',
      raw_data: rows[i]
    }, { onConflict: 'user_id,asset_name', ignoreDuplicates: true });
    if (!pendingResult.error) pendingAdded++;
  }
  return { assetMap: assetMap, pendingAdded: pendingAdded };
}

async function parseNavmanMileageReport(supabase, options) {
  var userId = options.userId;
  var importId = options.importId;
  var rawCsv = options.rawCsv;

  try {
    var rows = parseNavmanMileageRows(rawCsv);
    if (rows.length === 0) throw new Error('No mileage data rows found');

    var assetResult = await ensureAssets(supabase, userId, rows);
    var assetMap = assetResult.assetMap;

    // Aggregate distance per vehicle per date — deduplicate same-day entries by summing
    // then taking the MAX (same-day duplicates from overlapping exports should be same value)
    var dailyMap = {};
    rows.forEach(function(row) {
      var vehicleName = String(row.Vehicle || '').trim();
      var dateStr = parseDMY(row.ActivityDate);
      var distance = parseNumeric(row.ActualDistance);
      if (!vehicleName || !dateStr || distance === null) return;
      var assetEntry = assetMap[vehicleName];
      if (!assetEntry) return;
      var key = assetEntry.id + '|' + dateStr;
      if (!dailyMap[key]) {
        dailyMap[key] = { assetId: assetEntry.id, assetEntry: assetEntry, date: dateStr, distances: [] };
      }
      dailyMap[key].distances.push(distance);
    });

    // Build records
    var records = [];
    var keys = Object.keys(dailyMap);
    for (var i = 0; i < keys.length; i++) {
      var entry = dailyMap[keys[i]];
      // Take max distance for same-day duplicates (overlapping export dedup)
      var dailyDistanceKm = Math.max.apply(null, entry.distances);
      if (dailyDistanceKm <= 0) continue;

      var cumulativeOdometer = null;
      var runningOdo = await getRunningOdometer(supabase, userId, entry.assetId);
      if (runningOdo !== null) {
        cumulativeOdometer = runningOdo + dailyDistanceKm;
      } else if (entry.assetEntry.current_odometer !== null) {
        cumulativeOdometer = entry.assetEntry.current_odometer + dailyDistanceKm;
      }

      records.push({
        user_id: userId,
        asset_id: Number(entry.assetId),
        record_date: entry.date,
        odometer_km: cumulativeOdometer,
        litres_consumed: null,
      });
    }

    if (records.length === 0) throw new Error('No valid mileage records to import');

    var upsertResult = await supabase
      .from('telematics_records')
      .upsert(records, { onConflict: 'asset_id,record_date' });

    if (upsertResult.error) throw new Error('Failed to upsert mileage records: ' + upsertResult.error.message);

    await updateImportStatus(supabase, importId, 'processed', null, 'navman-mileage');

    return {
      ok: true,
      recordsUpserted: records.length,
      pendingAdded: assetResult.pendingAdded,
    };
  } catch (err) {
    await updateImportStatus(supabase, importId, 'failed', err.message, 'navman-mileage');
    throw err;
  }
}

module.exports = {
  isNavmanMileageCsv: isNavmanMileageCsv,
  parseNavmanMileageReport: parseNavmanMileageReport,
};
