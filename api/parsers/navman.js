/**
 * Navman Executive Summary Report CSV parser for the email import pipeline.
 */

var NAVMAN_SIGNATURE = ['VehicleName', 'TotalHours', 'IdleTime'];

function parseCsvLine(line) {
  var result = [];
  var cur = '';
  var inQuotes = false;

  for (var i = 0; i < line.length; i++) {
    var ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }

  result.push(cur);
  return result;
}

function normalizeHeader(header) {
  return String(header || '').replace(/^\uFEFF/, '').trim();
}

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

function parseNumeric(value) {
  if (value === '' || value == null) {
    return null;
  }
  var n = parseFloat(String(value).replace(/,/g, '').trim());
  return isNaN(n) ? null : n;
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

async function updateImportStatus(supabase, importId, status, errorMessage) {
  var payload = { status: status };
  if (errorMessage) {
    payload.error_message = errorMessage;
  } else {
    payload.error_message = null;
  }

  var result = await supabase
    .from('email_imports')
    .update(payload)
    .eq('id', importId);

  if (result.error) {
    console.error('navman: failed to update email_imports status', importId, result.error.message);
  }
}

async function loadAssetMap(supabase, userId) {
  var result = await supabase
    .from('assets')
    .select('id, asset_name')
    .eq('user_id', userId);

  if (result.error) {
    throw new Error('Failed to load assets: ' + result.error.message);
  }

  var map = {};
  (result.data || []).forEach(function(asset) {
    if (asset.asset_name) {
      map[asset.asset_name] = asset.id;
    }
  });

  return map;
}

function detectAssetType(vehicleName) {
  var name = String(vehicleName || '').toLowerCase();

  var rigidTruckKeywords = ['hino', 'isuzu', 'fuso', 'ud ', 'rigid', 'truck'];
  var hasTruckKeyword = false;
  for (var t = 0; t < rigidTruckKeywords.length; t++) {
    if (name.indexOf(rigidTruckKeywords[t]) !== -1) {
      hasTruckKeyword = true;
      break;
    }
  }

  var semiTrailerKeywords = [
    'semi', 'kenworth', 'freightliner', 'mack', 'volvo', 'scania', 'man ', 'daf',
    'prime mover', 'b-train', 'a-train',
  ];
  for (var j = 0; j < semiTrailerKeywords.length; j++) {
    if (name.indexOf(semiTrailerKeywords[j]) !== -1) {
      return 'Semi Trailer';
    }
  }

  if (hasTruckKeyword) {
    return 'Rigid Truck';
  }

  var lightVehicleKeywords = [
    'ranger', 'hilux', 'navara', 'triton', 'colorado', 'd-max', 'bt-50', 'amarok',
    'ute', 'suv', 'car', 'sedan', 'wagon', 'van', 'transit', 'sprinter', 'hiace',
  ];
  for (var i = 0; i < lightVehicleKeywords.length; i++) {
    if (name.indexOf(lightVehicleKeywords[i]) !== -1) {
      return 'Light Vehicle';
    }
  }

  if (name.indexOf('bulldozer') !== -1 || name.indexOf('dozer') !== -1) {
    return 'Bulldozer';
  }
  if (name.indexOf('excavator') !== -1 || name.indexOf('digger') !== -1) {
    return 'Excavator';
  }
  if (name.indexOf('grader') !== -1) {
    return 'Motor Grader';
  }
  if (name.indexOf('forklift') !== -1) {
    return 'Forklift';
  }
  if (name.indexOf('crane') !== -1) {
    return 'Crane';
  }
  if (name.indexOf('loader') !== -1) {
    return 'Wheel Loader';
  }
  if (name.indexOf('roller') !== -1 || name.indexOf('scraper') !== -1) {
    return 'Other';
  }

  return 'Rigid Truck';
}

async function ensureAssets(supabase, userId, rows) {
  var assetMap = await loadAssetMap(supabase, userId);
  var created = 0;
  var seen = {};

  for (var i = 0; i < rows.length; i++) {
    var vehicleName = rows[i].VehicleName;
    if (!vehicleName || seen[vehicleName]) {
      continue;
    }
    seen[vehicleName] = true;

    if (assetMap[vehicleName]) {
      continue;
    }

    var registration = rows[i].Registration ? String(rows[i].Registration).trim() : null;

    var insertResult = await supabase
      .from('assets')
      .insert({
        user_id: userId,
        asset_name: vehicleName,
        asset_type: detectAssetType(vehicleName),
        registration: registration || null,
        fuel_type: 'Diesel',
      })
      .select('id, asset_name')
      .single();

    if (insertResult.error) {
      throw new Error('Failed to create asset "' + vehicleName + '": ' + insertResult.error.message);
    }

    assetMap[insertResult.data.asset_name] = insertResult.data.id;
    created++;
  }

  return { assetMap: assetMap, assetsCreated: created };
}

function buildTelematicsRecords(userId, assetMap, rows, recordDate) {
  var records = [];
  var skipped = 0;

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var vehicleName = row.VehicleName ? String(row.VehicleName).trim() : '';
    var totalHours = parseNumeric(row.TotalHours);
    var idleTime = parseNumeric(row.IdleTime);

    if (!vehicleName || totalHours === null || totalHours === 0) {
      skipped++;
      continue;
    }

    var assetId = assetMap[vehicleName];
    if (!assetId) {
      skipped++;
      continue;
    }

    var idleMinutes = idleTime != null ? idleTime : 0;

    records.push({
      user_id: userId,
      asset_id: Number(assetId),
      record_date: recordDate,
      operating_hours: (totalHours - idleMinutes) / 60,
      idle_hours: idleMinutes / 60,
      total_engine_hours: totalHours / 60,
      odometer_km: parseNumeric(row.AverageDailyIgnitionTime) || null,
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
    var telematics = buildTelematicsRecords(
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

    await updateImportStatus(supabase, importId, 'processed', null);

    return {
      ok: true,
      recordDate: recordDate,
      assetsCreated: assetResult.assetsCreated,
      recordsUpserted: telematics.records.length,
      rowsSkipped: telematics.skipped,
    };
  } catch (err) {
    await updateImportStatus(supabase, importId, 'failed', err.message || 'Navman parse failed');
    throw err;
  }
}

module.exports = {
  isNavmanCsv: isNavmanCsv,
  parseNavmanReport: parseNavmanReport,
};
