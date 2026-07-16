/**
 * Navman Executive Summary Report CSV parser for the email import pipeline.
 */

const { parseCsvLine, normalizeHeader, parseNumeric, updateImportStatus, detectAssetType } = require('./parser-utils');

var NAVMAN_SIGNATURE = ['VehicleName', 'TotalHours', 'IdleTime'];

function isNavmanHeaderRow(headers) {
  var normalized = headers.map(normalizeHeader);
  for (var i = 0; i < NAVMAN_SIGNATURE.length; i++) {
    if (normalized.indexOf(NAVMAN_SIGNATURE[i]) === -1) {
      return false;
    }
  }
  return true;
}

function isNavmanCsv(rawCsv) {
  if (!rawCsv || !String(rawCsv).trim()) {
    return false;
  }

  var lines = String(rawCsv).split(/\r?\n/);
  var scanLimit = Math.min(lines.length, 30);

  for (var i = 0; i < scanLimit; i++) {
    var line = lines[i];
    if (!line || !line.trim()) {
      continue;
    }
    if (isNavmanHeaderRow(parseCsvLine(line))) {
      return true;
    }
  }

  return false;
}

function parseNavmanRows(rawCsv) {
  var lines = String(rawCsv).split(/\r?\n/);
  var headerIdx = -1;
  var headers = [];
  var scanLimit = Math.min(lines.length, 30);

  for (var i = 0; i < scanLimit; i++) {
    var candidate = parseCsvLine(lines[i]);
    if (isNavmanHeaderRow(candidate)) {
      headerIdx = i;
      headers = candidate.map(normalizeHeader);
      break;
    }
  }

  if (headerIdx === -1) {
    return [];
  }

  var rows = [];

  for (var j = headerIdx + 1; j < lines.length; j++) {
    var line = lines[j];
    if (!line || !line.trim()) {
      continue;
    }

    var values = parseCsvLine(line);
    if (values.every(function(v) { return !String(v).trim(); })) {
      continue;
    }

    var row = {};
    headers.forEach(function(header, idx) {
      if (header) {
        row[header] = values[idx] != null ? String(values[idx]).trim() : '';
      }
    });
    rows.push(row);
  }

  return rows;
}

function extractRecordDate(filename, receivedAt) {
  var name = filename || '';

  var isoMatch = name.match(/(\d{4})[-_](\d{2})[-_](\d{2})/);
  if (isoMatch) {
    return isoMatch[1] + '-' + isoMatch[2] + '-' + isoMatch[3];
  }

  var dmyMatch = name.match(/(\d{2})[-_](\d{2})[-_](\d{4})/);
  if (dmyMatch) {
    return dmyMatch[3] + '-' + dmyMatch[2] + '-' + dmyMatch[1];
  }

  if (receivedAt) {
    return String(receivedAt).slice(0, 10);
  }

  return new Date().toISOString().slice(0, 10);
}

async function loadAssetMap(supabase, userId) {
  var assetResult = await supabase
    .from('assets')
    .select('id, asset_name, current_odometer')
    .eq('user_id', userId);

  if (assetResult.error) {
    throw new Error('Failed to load assets: ' + assetResult.error.message);
  }

  var ignoredResult = await supabase
    .from('ignored_assets')
    .select('asset_name')
    .eq('user_id', userId);

  if (ignoredResult.error) {
    throw new Error('Failed to load ignored assets: ' + ignoredResult.error.message);
  }

  var ignoredSet = {};
  (ignoredResult.data || []).forEach(function(r) {
    ignoredSet[String(r.asset_name).trim()] = true;
  });

  var map = {};
  (assetResult.data || []).forEach(function(asset) {
    if (asset.asset_name) {
      map[asset.asset_name] = {
        id: asset.id,
        current_odometer: asset.current_odometer != null 
          ? parseFloat(asset.current_odometer) : null
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

  if (result.error || !result.data || !result.data.length) {
    return null;
  }
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
    var vehicleName = rows[i].VehicleName;
    if (!vehicleName || seen[vehicleName]) {
      continue;
    }
    seen[vehicleName] = true;

    // Already a confirmed asset — skip
    if (assetMap[vehicleName]) {
      continue;
    }

    // Permanently ignored — skip silently
    if (ignoredSet[vehicleName]) {
      continue;
    }

    // New asset — add to pending_assets for customer review
    var registration = rows[i].Registration 
      ? String(rows[i].Registration).trim() : null;

    var pendingResult = await supabase
      .from('pending_assets')
      .upsert({
        user_id: userId,
        asset_name: vehicleName,
        asset_type: detectAssetType(vehicleName),
        registration: registration || null,
        source: 'navman',
        raw_data: rows[i]
      }, { onConflict: 'user_id,asset_name', ignoreDuplicates: true });

    if (pendingResult.error) {
      console.error('navman: failed to add pending asset', vehicleName, 
        pendingResult.error.message);
    } else {
      pendingAdded++;
    }
  }

  return { assetMap: assetMap, assetsCreated: 0, pendingAdded: pendingAdded };
}

async function buildTelematicsRecords(supabase, userId, assetMap, rows, recordDate) {
  var records = [];
  var skipped = 0;

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var vehicleName = row.VehicleName ? String(row.VehicleName).trim() : '';
    var totalHours = parseNumeric(row.TotalHours);
    var idleTime = parseNumeric(row.IdleTime);
    var dailyDistanceKm = parseNumeric(row.AverageDailyIgnitionTime);

    if (!vehicleName || totalHours === null || totalHours === 0) {
      skipped++;
      continue;
    }

    var assetEntry = assetMap[vehicleName];
    if (!assetEntry) {
      skipped++;
      continue;
    }

    var assetId = assetEntry.id;
    var idleMinutes = idleTime != null ? idleTime : 0;

    var cumulativeOdometer = null;
    if (dailyDistanceKm !== null && dailyDistanceKm > 0) {
      var runningOdo = await getRunningOdometer(supabase, userId, assetId);
      if (runningOdo !== null) {
        cumulativeOdometer = runningOdo + dailyDistanceKm;
      } else if (assetEntry.current_odometer !== null) {
        cumulativeOdometer = assetEntry.current_odometer + dailyDistanceKm;
      }
      // If neither is available, leave cumulativeOdometer as null
      // rather than storing a meaningless daily distance value
    }

    records.push({
      user_id: userId,
      asset_id: Number(assetId),
      record_date: recordDate,
      operating_hours: (totalHours - idleMinutes) / 60,
      idle_hours: idleMinutes / 60,
      total_engine_hours: totalHours / 60,
      odometer_km: cumulativeOdometer,
      litres_consumed: null,
    });
  }

  return { records: records, skipped: skipped };
}

async function parseNavmanReport(supabase, options) {
  var userId = options.userId;
  var importId = options.importId;
  var rawCsv = options.rawCsv;
  var filename = options.filename;
  var receivedAt = options.receivedAt;

  try {
    var rows = parseNavmanRows(rawCsv);
    if (rows.length === 0) {
      throw new Error('No Navman data rows found in CSV');
    }

    var recordDate = extractRecordDate(filename, receivedAt);
    var assetResult = await ensureAssets(supabase, userId, rows);
    var telematics = await buildTelematicsRecords(
      supabase,
      userId,
      assetResult.assetMap,
      rows,
      recordDate
    );

    if (telematics.records.length === 0) {
      throw new Error('No valid Navman telematics rows to import');
    }

    var upsertResult = await supabase
      .from('telematics_records')
      .upsert(telematics.records, { onConflict: 'asset_id,record_date' });

    if (upsertResult.error) {
      throw new Error('Failed to upsert telematics records: ' + upsertResult.error.message);
    }

    await updateImportStatus(supabase, importId, 'processed', null, 'navman');

    return {
      ok: true,
      recordDate: recordDate,
      assetsCreated: assetResult.assetsCreated,
      pendingAdded: assetResult.pendingAdded,
      recordsUpserted: telematics.records.length,
      rowsSkipped: telematics.skipped,
    };
  } catch (err) {
    await updateImportStatus(supabase, importId, 'failed', err.message || 'Navman parse failed', 'navman');
    throw err;
  }
}

module.exports = {
  isNavmanCsv: isNavmanCsv,
  parseNavmanReport: parseNavmanReport,
};
