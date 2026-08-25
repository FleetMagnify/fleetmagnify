/**
 * VisionLink Fleet Utilisation Report CSV parser (Cat / Hitachi machinery).
 *
 * Headers (typical):
 *   Callouts, Asset ID, Asset Serial Number, Make, Model,
 *   Hour Meter (Hours), Hour Meter Last Reported Time, Latest Utilization Report,
 *   Timezone Offset, Time Zone, Timezone Display Name,
 *   Runtime (Hours), Idle Time (Hours), Working Time (Hours), Idle %,
 *   Total Fuel Burned (L), Total Fuel Burn Rate (L/Hour)
 *
 * Stores daily activity on telematics_records:
 *   operating_hours ← Working Time (Hours) (fallback: Runtime − Idle)
 *   idle_hours      ← Idle Time (Hours)
 *   total_engine_hours ← Hour Meter (Hours)  [cumulative snapshot]
 *   litres_consumed ← Total Fuel Burned (L)  [feeds machinery Fuel Analyst]
 *   data_quality_notes ← Callouts (OEM data-quality warnings)
 *
 * Overwrites assets.current_hours from Hour Meter (cumulative, not a delta).
 */

const {
  parseCsvLine,
  normalizeHeader,
  parseNumeric,
  updateImportStatus,
  detectAssetType,
} = require('./parser-utils');

// Distinctive VisionLink utilisation-report columns. Extra columns may appear;
// detection only requires these header names to be present.
var VISIONLINK_SIGNATURE = [
  'Asset ID',
  'Hour Meter (Hours)',
  'Runtime (Hours)',
  'Idle Time (Hours)',
  'Total Fuel Burned (L)',
];

function isVisionLinkHeaderRow(headers) {
  var normalized = headers.map(normalizeHeader);
  return VISIONLINK_SIGNATURE.every(function(col) {
    return normalized.indexOf(col) !== -1;
  });
}

function isVisionLinkCsv(rawCsv) {
  if (!rawCsv || !String(rawCsv).trim()) return false;
  var lines = String(rawCsv).split(/\r?\n/);
  var scanLimit = Math.min(lines.length, 15);
  for (var i = 0; i < scanLimit; i++) {
    if (lines[i] && lines[i].trim() && isVisionLinkHeaderRow(parseCsvLine(lines[i]))) {
      return true;
    }
  }
  return false;
}

/**
 * Parse a VisionLink report date into YYYY-MM-DD.
 *
 * VisionLink exports always include explicit NZ timezone metadata
 * (+12:00 / Pacific/Auckland / NZT). The calendar date written in
 * "Latest Utilization Report" / "Hour Meter Last Reported Time" is already
 * the NZ local date — do NOT apply any UTC day-shift.
 */
function parseVisionLinkDate(dateStr) {
  var raw = String(dateStr || '').trim();
  if (!raw) return null;

  // ISO / SQL-style: 2026-08-18 or 2026-08-18T00:00:00(+12:00)
  var iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    return iso[1] + '-' + iso[2] + '-' + iso[3];
  }

  // Take date token before time (handles "8/18/2026 12:00:00 AM")
  var dateToken = raw.split(/\s+/)[0];
  var parts = dateToken.split(/[-\/]/);
  if (parts.length !== 3) return null;

  var a = parseInt(parts[0], 10);
  var b = parseInt(parts[1], 10);
  var year = parseInt(parts[2], 10);
  // Also support YYYY/M/D
  if (String(parts[0]).length === 4) {
    year = parseInt(parts[0], 10);
    a = parseInt(parts[1], 10);
    b = parseInt(parts[2], 10);
    if (!year || year < 2000) return null;
    if (a < 1 || a > 12 || b < 1 || b > 31) return null;
    var dY = new Date(year, a - 1, b);
    if (dY.getFullYear() !== year || dY.getMonth() !== a - 1 || dY.getDate() !== b) return null;
    return year + '-' + String(a).padStart(2, '0') + '-' + String(b).padStart(2, '0');
  }

  if (!year || year < 2000 || year > 2100) return null;
  if (!a || !b) return null;

  var month;
  var day;
  // VisionLink UI/export commonly uses US M/D/YYYY. Prefer month-first when
  // ambiguous; disambiguate when one side is > 12.
  if (a > 12 && b >= 1 && b <= 12) {
    day = a;
    month = b;
  } else if (b > 12 && a >= 1 && a <= 12) {
    month = a;
    day = b;
  } else if (a >= 1 && a <= 12 && b >= 1 && b <= 31) {
    month = a;
    day = b;
  } else {
    return null;
  }

  var d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) {
    return null;
  }
  return year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
}

function parseVisionLinkRows(rawCsv) {
  var lines = String(rawCsv).split(/\r?\n/);
  var headerIdx = -1;
  var headers = [];
  for (var i = 0; i < Math.min(lines.length, 15); i++) {
    var candidate = parseCsvLine(lines[i]);
    if (isVisionLinkHeaderRow(candidate)) {
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

/** Extract EQ… / ID in parentheses from asset_name, e.g. "Cat 320FL (EQ030992)". */
function extractBracketAssetId(assetName) {
  var m = String(assetName || '').match(/\(([^)]+)\)\s*$/);
  return m ? String(m[1]).trim() : null;
}

function isBlankNumericField(value) {
  if (value == null) return true;
  var s = String(value).trim();
  if (!s) return true;
  // VisionLink sometimes emits literal "NULL"
  if (/^null$/i.test(s)) return true;
  return parseNumeric(s) === null;
}

/**
 * Empty-activity rows: Runtime, Idle, Working Time, and Fuel are all blank.
 * Skip entirely — do not insert zero-filled records ("flag rather than fabricate").
 */
function isEmptyActivityRow(row) {
  return (
    isBlankNumericField(row['Runtime (Hours)']) &&
    isBlankNumericField(row['Idle Time (Hours)']) &&
    isBlankNumericField(row['Working Time (Hours)']) &&
    isBlankNumericField(row['Total Fuel Burned (L)'])
  );
}

function rowRecordDate(row) {
  return (
    parseVisionLinkDate(row['Latest Utilization Report']) ||
    parseVisionLinkDate(row['Hour Meter Last Reported Time'])
  );
}

async function loadAssetMaps(supabase, userId) {
  var assetResult = await supabase
    .from('assets')
    .select('id, asset_name, visionlink_serial, current_hours')
    .eq('user_id', userId);
  if (assetResult.error) {
    throw new Error('Failed to load assets: ' + assetResult.error.message);
  }

  var byAssetId = {};   // bracket / VisionLink Asset ID → asset
  var bySerial = {};    // visionlink_serial → asset
  var byName = {};

  (assetResult.data || []).forEach(function(asset) {
    if (asset.asset_name) byName[asset.asset_name] = asset;
    var bracketId = extractBracketAssetId(asset.asset_name);
    if (bracketId) byAssetId[bracketId] = asset;
    if (asset.visionlink_serial) {
      bySerial[String(asset.visionlink_serial).trim()] = asset;
    }
  });

  return { byAssetId: byAssetId, bySerial: bySerial, byName: byName };
}

/**
 * Match priority:
 * 1. File Asset ID ↔ ID in parentheses on assets.asset_name
 * 2. If Asset ID null/blank → Asset Serial Number ↔ assets.visionlink_serial
 */
function matchAsset(row, maps) {
  var assetId = String(row['Asset ID'] || '').trim();
  if (assetId && !/^null$/i.test(assetId)) {
    if (maps.byAssetId[assetId]) {
      return { asset: maps.byAssetId[assetId], method: 'asset_id' };
    }
  }

  var serial = String(row['Asset Serial Number'] || '').trim();
  if (serial && !/^null$/i.test(serial) && maps.bySerial[serial]) {
    return { asset: maps.bySerial[serial], method: 'serial' };
  }

  return null;
}

async function parseVisionLinkReport(supabase, options) {
  var userId = options.userId;
  var importId = options.importId;
  var rawCsv = options.rawCsv;

  try {
    var rows = parseVisionLinkRows(rawCsv);
    if (rows.length === 0) throw new Error('No VisionLink data rows found');

    var maps = await loadAssetMaps(supabase, userId);
    var records = [];
    var hoursUpdates = []; // { assetId, hours }
    var skippedEmpty = 0;
    var skippedNoDate = 0;
    var unmatched = [];
    var calloutsLogged = 0;

    rows.forEach(function(row, idx) {
      var callouts = String(row.Callouts || '').trim();
      if (callouts && /^null$/i.test(callouts)) callouts = '';

      if (isEmptyActivityRow(row)) {
        skippedEmpty++;
        return;
      }

      var dateStr = rowRecordDate(row);
      if (!dateStr) {
        skippedNoDate++;
        console.warn(
          'visionlink: unparseable date on row ' + (idx + 1) +
          ' Latest Utilization Report=' + JSON.stringify(row['Latest Utilization Report']) +
          ' Hour Meter Last Reported Time=' + JSON.stringify(row['Hour Meter Last Reported Time'])
        );
        return;
      }

      var matched = matchAsset(row, maps);
      if (!matched) {
        var miss = {
          row: idx + 1,
          assetId: row['Asset ID'] || null,
          serial: row['Asset Serial Number'] || null,
          make: row.Make || null,
          model: row.Model || null,
        };
        unmatched.push(miss);
        console.warn(
          'visionlink: unmatched asset — Asset ID=' + JSON.stringify(miss.assetId) +
          ' Serial=' + JSON.stringify(miss.serial) +
          ' Make/Model=' + (miss.make || '') + ' ' + (miss.model || '') +
          ' (no assets.asset_name bracket match and no visionlink_serial match)'
        );
        return;
      }

      var runtime = parseNumeric(row['Runtime (Hours)']);
      var idle = parseNumeric(row['Idle Time (Hours)']);
      var working = parseNumeric(row['Working Time (Hours)']);
      var fuel = parseNumeric(row['Total Fuel Burned (L)']);
      var hourMeter = parseNumeric(row['Hour Meter (Hours)']);

      var operatingHours = working;
      if (operatingHours == null && runtime != null && idle != null) {
        operatingHours = Math.max(0, runtime - idle);
      } else if (operatingHours == null && runtime != null) {
        operatingHours = runtime;
      }

      if (callouts) calloutsLogged++;

      records.push({
        user_id: userId,
        asset_id: Number(matched.asset.id),
        record_date: dateStr,
        operating_hours: operatingHours,
        idle_hours: idle,
        total_engine_hours: hourMeter,
        litres_consumed: fuel,
        data_quality_notes: callouts || null,
      });

      if (hourMeter != null) {
        hoursUpdates.push({
          assetId: matched.asset.id,
          hours: hourMeter,
          matchMethod: matched.method,
        });
      }
    });

    if (records.length === 0) {
      throw new Error(
        'No valid VisionLink records to import' +
        ' (emptyActivity=' + skippedEmpty +
        ', noDate=' + skippedNoDate +
        ', unmatched=' + unmatched.length + ')'
      );
    }

    var upsertResult = await supabase
      .from('telematics_records')
      .upsert(records, { onConflict: 'asset_id,record_date' });
    if (upsertResult.error) {
      throw new Error('Failed to upsert VisionLink records: ' + upsertResult.error.message);
    }

    // Overwrite assets.current_hours with latest Hour Meter (cumulative, not add).
    // Deduplicate to the max hour meter per asset in this file.
    var latestHoursByAsset = {};
    hoursUpdates.forEach(function(u) {
      if (latestHoursByAsset[u.assetId] == null || u.hours > latestHoursByAsset[u.assetId]) {
        latestHoursByAsset[u.assetId] = u.hours;
      }
    });
    var hourAssetIds = Object.keys(latestHoursByAsset);
    for (var h = 0; h < hourAssetIds.length; h++) {
      var aid = hourAssetIds[h];
      var upd = await supabase
        .from('assets')
        .update({ current_hours: latestHoursByAsset[aid] })
        .eq('id', Number(aid))
        .eq('user_id', userId);
      if (upd.error) {
        console.warn(
          'visionlink: failed to update current_hours for asset ' + aid + ': ' + upd.error.message
        );
      }
    }

    await updateImportStatus(supabase, importId, 'processed', null, 'visionlink');

    return {
      ok: true,
      recordsUpserted: records.length,
      skippedEmpty: skippedEmpty,
      skippedNoDate: skippedNoDate,
      unmatched: unmatched.length,
      unmatchedDetails: unmatched,
      calloutsLogged: calloutsLogged,
      hoursUpdated: hourAssetIds.length,
    };
  } catch (err) {
    await updateImportStatus(supabase, importId, 'failed', err.message, 'visionlink');
    throw err;
  }
}

module.exports = {
  isVisionLinkCsv: isVisionLinkCsv,
  isVisionLinkHeaderRow: isVisionLinkHeaderRow,
  parseVisionLinkReport: parseVisionLinkReport,
  parseVisionLinkRows: parseVisionLinkRows,
  parseVisionLinkDate: parseVisionLinkDate,
  extractBracketAssetId: extractBracketAssetId,
  isEmptyActivityRow: isEmptyActivityRow,
  matchAsset: matchAsset,
  VISIONLINK_SIGNATURE: VISIONLINK_SIGNATURE,
};
