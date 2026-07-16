/**
 * Navman Idle Events Report CSV parser.
 * Headers: Vehicle, Registration, VehicleGroup, IdleStart, IdleEnd, Duration, Unit, Location
 * Aggregates idle events by vehicle by day into total idle minutes.
 */

const { parseCsvLine, normalizeHeader, parseNumeric, updateImportStatus, detectAssetType } = require('./parser-utils');

var IDLE_SIGNATURE = ['Vehicle', 'IdleStart', 'IdleEnd', 'Duration'];

function isNavmanIdleHeaderRow(headers) {
  var normalized = headers.map(normalizeHeader);
  return IDLE_SIGNATURE.every(function(col) {
    return normalized.indexOf(col) !== -1;
  });
}

function isNavmanIdleCsv(rawCsv) {
  if (!rawCsv || !String(rawCsv).trim()) return false;
  var lines = String(rawCsv).split(/\r?\n/);
  var scanLimit = Math.min(lines.length, 10);
  for (var i = 0; i < scanLimit; i++) {
    if (lines[i] && lines[i].trim() && isNavmanIdleHeaderRow(parseCsvLine(lines[i]))) {
      return true;
    }
  }
  return false;
}

function parseDMYFromDatetime(datetimeStr) {
  // Parse "DD/MM/YYYY HH:MM" explicitly
  var parts = String(datetimeStr || '').trim().split(' ');
  if (!parts[0]) return null;
  var dateParts = parts[0].split('/');
  if (dateParts.length !== 3) return null;
  var day = dateParts[0].padStart(2, '0');
  var month = dateParts[1].padStart(2, '0');
  var year = dateParts[2];
  if (year.length !== 4) return null;
  return year + '-' + month + '-' + day;
}

function parseNavmanIdleRows(rawCsv) {
  var lines = String(rawCsv).split(/\r?\n/);
  var headerIdx = -1;
  var headers = [];
  for (var i = 0; i < Math.min(lines.length, 10); i++) {
    var candidate = parseCsvLine(lines[i]);
    if (isNavmanIdleHeaderRow(candidate)) {
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
  var assetResult = await supabase.from('assets').select('id, asset_name').eq('user_id', userId);
  if (assetResult.error) throw new Error('Failed to load assets: ' + assetResult.error.message);
  var ignoredResult = await supabase.from('ignored_assets').select('asset_name').eq('user_id', userId);
  if (ignoredResult.error) throw new Error('Failed to load ignored assets: ' + ignoredResult.error.message);
  var ignoredSet = {};
  (ignoredResult.data || []).forEach(function(r) { ignoredSet[String(r.asset_name).trim()] = true; });
  var map = {};
  (assetResult.data || []).forEach(function(asset) {
    if (asset.asset_name) map[asset.asset_name] = { id: asset.id };
  });
  return { assetMap: map, ignoredSet: ignoredSet };
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
      source: 'navman-idle',
      raw_data: rows[i]
    }, { onConflict: 'user_id,asset_name', ignoreDuplicates: true });
    if (!pendingResult.error) pendingAdded++;
  }
  return { assetMap: assetMap, pendingAdded: pendingAdded };
}

async function parseNavmanIdleReport(supabase, options) {
  var userId = options.userId;
  var importId = options.importId;
  var rawCsv = options.rawCsv;

  try {
    var rows = parseNavmanIdleRows(rawCsv);
    if (rows.length === 0) throw new Error('No idle event rows found');

    var assetResult = await ensureAssets(supabase, userId, rows);
    var assetMap = assetResult.assetMap;

    // Aggregate idle minutes per vehicle per day
    var dailyIdleMap = {};
    rows.forEach(function(row) {
      var vehicleName = String(row.Vehicle || '').trim();
      var dateStr = parseDMYFromDatetime(row.IdleStart);
      var duration = parseNumeric(row.Duration);
      var unit = String(row.Unit || '').trim().toLowerCase();
      if (!vehicleName || !dateStr || duration === null) return;
      // Only process minutes — if unit is not min, skip
      if (unit && unit !== 'min') return;
      var assetEntry = assetMap[vehicleName];
      if (!assetEntry) return;
      var key = assetEntry.id + '|' + dateStr;
      if (!dailyIdleMap[key]) {
        dailyIdleMap[key] = { assetId: assetEntry.id, date: dateStr, idleMinutes: 0 };
      }
      dailyIdleMap[key].idleMinutes += duration;
    });

    // Batch upsert all idle records in one call instead of one per record
    var records = [];
    Object.keys(dailyIdleMap).forEach(function(key) {
      var entry = dailyIdleMap[key];
      if (entry.idleMinutes <= 0) return;
      records.push({
        user_id: userId,
        asset_id: Number(entry.assetId),
        record_date: entry.date,
        idle_hours: entry.idleMinutes / 60,
      });
    });

    if (records.length === 0) throw new Error('No valid idle records to import');

    // Single batch upsert — merges with existing mileage records via onConflict
    // Only sets idle_hours — does not touch odometer_km or other fields
    var upsertResult = await supabase
      .from('telematics_records')
      .upsert(records, { 
        onConflict: 'asset_id,record_date',
        ignoreDuplicates: false
      });

    if (upsertResult.error) throw new Error('Failed to upsert idle records: ' + upsertResult.error.message);

    var upserted = records.length;

    await updateImportStatus(supabase, importId, 'processed', null, 'navman-idle');

    return {
      ok: true,
      recordsUpserted: upserted,
      pendingAdded: assetResult.pendingAdded,
    };
  } catch (err) {
    await updateImportStatus(supabase, importId, 'failed', err.message, 'navman-idle');
    throw err;
  }
}

module.exports = {
  isNavmanIdleCsv: isNavmanIdleCsv,
  parseNavmanIdleReport: parseNavmanIdleReport,
};
