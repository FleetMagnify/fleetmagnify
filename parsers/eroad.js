/**
 * eROAD Fleet Summary Report CSV parser (on-road trucking telematics).
 *
 * Layout:
 *   Row 1  — title: "EROAD Fleet Summary Report" + date range (SKIP — not data)
 *   Row 2  — header row
 *   Rows…  — one row per vehicle
 *   Last   — "Totals" aggregate row (SKIP — not a vehicle)
 *
 * Columns (typical):
 *   id, Type, Name, Rego/Plate, Asset Code, Distance (km), RUC Purchased ($),
 *   Running Time %, Running Time (hours), Stop Time (hours),
 *   Total Idle Time Minutes, …, Ehubo/Odo (km)
 *
 * Stores on telematics_records:
 *   daily_distance_km ← Distance (km)   [period distance, NOT cumulative]
 *   idle_hours        ← Total Idle Time Minutes / 60
 *                       *** CRITICAL: eROAD idle is MINUTES, unlike Navman/
 *                       VisionLink which already export hours. Always ÷ 60. ***
 *
 * Overwrites assets.current_odometer from Ehubo/Odo (km) (cumulative, not add).
 *
 * Zero-activity rows (all zeros) are VALID reported values — store them.
 * This is the opposite of VisionLink empty-activity skipping.
 *
 * RUC Purchased ($): intentionally unused. FleetMagnify calculates RUC via its
 * own GVM-based framework so methodology stays consistent across telematics
 * providers — never ingest provider-specific RUC figures.
 */

const {
  parseCsvLine,
  normalizeHeader,
  parseNumeric,
  updateImportStatus,
} = require('./parser-utils');

// Distinctive eROAD Fleet Summary header columns. Title-row detection is
// handled separately via isEroadTitleRow / isEroadCsv.
var EROAD_SIGNATURE = [
  'Name',
  'Distance (km)',
  'Ehubo/Odo (km)',
];

// Idle column may appear as "Total Idle Time Minutes" or "Total Idle Time"
var IDLE_HEADER_CANDIDATES = [
  'Total Idle Time Minutes',
  'Total Idle Time',
];

function isEroadTitleRow(cells) {
  var joined = (cells || []).join(' ').toLowerCase();
  return joined.indexOf('eroad fleet summary report') !== -1;
}

function isEroadHeaderRow(headers) {
  var normalized = headers.map(normalizeHeader);
  var hasCore = EROAD_SIGNATURE.every(function(col) {
    return normalized.indexOf(col) !== -1;
  });
  if (!hasCore) return false;
  // Prefer idle column present, but don't hard-fail detection if renamed slightly
  return true;
}

function findIdleHeader(headers) {
  for (var i = 0; i < IDLE_HEADER_CANDIDATES.length; i++) {
    if (headers.indexOf(IDLE_HEADER_CANDIDATES[i]) !== -1) {
      return IDLE_HEADER_CANDIDATES[i];
    }
  }
  // Fuzzy: any header containing "idle" and "time"
  for (var j = 0; j < headers.length; j++) {
    var h = String(headers[j] || '').toLowerCase();
    if (h.indexOf('idle') !== -1 && h.indexOf('time') !== -1) return headers[j];
  }
  return null;
}

function isEroadCsv(rawCsv) {
  if (!rawCsv || !String(rawCsv).trim()) return false;
  var lines = String(rawCsv).split(/\r?\n/);
  var scanLimit = Math.min(lines.length, 15);
  var sawTitle = false;
  for (var i = 0; i < scanLimit; i++) {
    if (!lines[i] || !lines[i].trim()) continue;
    var cells = parseCsvLine(lines[i]);
    if (isEroadTitleRow(cells)) {
      sawTitle = true;
      continue;
    }
    if (isEroadHeaderRow(cells)) return true;
  }
  // Title alone is a strong signal even if headers are delayed
  return sawTitle;
}

/**
 * Extract the report date (YYYY-MM-DD) from the eROAD title row.
 * Daily reports typically show a single day or a same-day range; we take
 * the end date of a range when present.
 *
 * Examples handled:
 *   "EROAD Fleet Summary Report,25/08/2026 - 25/08/2026"
 *   "EROAD Fleet Summary Report 2026-08-25"
 *   "EROAD Fleet Summary Report,8/25/2026"
 */
function extractEroadReportDate(titleLine, filename, receivedAt) {
  var text = String(titleLine || '');

  // Range: DD/MM/YYYY - DD/MM/YYYY or similar
  var range = text.match(
    /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\s*[-–to]+\s*(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/i
  );
  if (range) {
    return toIsoDate(range[4], range[5], range[6]) || toIsoDate(range[1], range[2], range[3]);
  }

  var iso = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[1] + '-' + iso[2] + '-' + iso[3];

  var dmy = text.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (dmy) return toIsoDate(dmy[1], dmy[2], dmy[3]);

  var name = filename || '';
  var isoFile = name.match(/(\d{4})[-_](\d{2})[-_](\d{2})/);
  if (isoFile) return isoFile[1] + '-' + isoFile[2] + '-' + isoFile[3];

  if (receivedAt) return String(receivedAt).slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

function toIsoDate(a, b, year) {
  var n1 = parseInt(a, 10);
  var n2 = parseInt(b, 10);
  var y = parseInt(year, 10);
  if (!y || y < 2000) return null;
  var month;
  var day;
  // Prefer DMY for NZ title strings when day > 12; else if month-first US
  if (n1 > 12 && n2 <= 12) {
    day = n1; month = n2;
  } else if (n2 > 12 && n1 <= 12) {
    month = n1; day = n2;
  } else {
    // Ambiguous — NZ reports commonly use DD/MM/YYYY in titles
    day = n1; month = n2;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  var d = new Date(y, month - 1, day);
  if (d.getFullYear() !== y || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return y + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
}

function isTotalsRow(row, nameHeader) {
  var name = String((nameHeader && row[nameHeader]) || row.Name || row.id || '').trim().toLowerCase();
  if (name === 'totals' || name === 'total') return true;
  // Sometimes Totals lands in the first column under a different header
  var vals = Object.keys(row).map(function(k) { return String(row[k] || '').trim().toLowerCase(); });
  return vals.indexOf('totals') !== -1 || vals.indexOf('total') !== -1;
}

function parseEroadRows(rawCsv) {
  var lines = String(rawCsv).split(/\r?\n/);
  var titleLine = '';
  var headerIdx = -1;
  var headers = [];

  for (var i = 0; i < Math.min(lines.length, 20); i++) {
    if (!lines[i] || !lines[i].trim()) continue;
    var cells = parseCsvLine(lines[i]);
    if (isEroadTitleRow(cells)) {
      titleLine = lines[i];
      continue;
    }
    if (isEroadHeaderRow(cells)) {
      headerIdx = i;
      headers = cells.map(normalizeHeader);
      break;
    }
  }

  if (headerIdx === -1) {
    return { titleLine: titleLine, headers: [], rows: [] };
  }

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
    if (isTotalsRow(row, 'Name')) continue;
    rows.push(row);
  }

  return { titleLine: titleLine, headers: headers, rows: rows };
}

/**
 * Convert eROAD Total Idle Time (MINUTES) → hours for telematics_records.idle_hours.
 *
 * CRITICAL UNIT CONVERSION — do not "fix" this away:
 * Navman idle CSVs and VisionLink utilisation reports already express idle in
 * HOURS. eROAD Fleet Summary reports Total Idle Time in MINUTES. Storing the
 * raw minute value into idle_hours would inflate idle by 60× and break every
 * idle-cost / fuel-regression calculation downstream. Always divide by 60.
 */
function idleMinutesToHours(minutes) {
  if (minutes == null || !isFinite(minutes)) return null;
  return minutes / 60;
}

async function loadAssetMap(supabase, userId) {
  var assetResult = await supabase
    .from('assets')
    .select('id, asset_name, current_odometer')
    .eq('user_id', userId);
  if (assetResult.error) {
    throw new Error('Failed to load assets: ' + assetResult.error.message);
  }
  var map = {};
  (assetResult.data || []).forEach(function(asset) {
    if (asset.asset_name) map[asset.asset_name] = asset;
  });
  return map;
}

async function parseEroadReport(supabase, options) {
  var userId = options.userId;
  var importId = options.importId;
  var rawCsv = options.rawCsv;
  var filename = options.filename;
  var receivedAt = options.receivedAt;

  try {
    var parsed = parseEroadRows(rawCsv);
    if (!parsed.rows.length) throw new Error('No eROAD vehicle rows found');

    var recordDate = extractEroadReportDate(parsed.titleLine, filename, receivedAt);
    var idleHeader = findIdleHeader(parsed.headers);
    var assetMap = await loadAssetMap(supabase, userId);

    var records = [];
    var odoUpdates = [];
    var unmatched = [];

    parsed.rows.forEach(function(row, idx) {
      var name = String(row.Name || '').trim();
      if (!name) {
        console.warn('eroad: row ' + (idx + 1) + ' missing Name — skipped');
        return;
      }

      var asset = assetMap[name];
      if (!asset) {
        unmatched.push({ row: idx + 1, name: name, rego: row['Rego/Plate'] || null, assetCode: row['Asset Code'] || null });
        console.warn(
          'eroad: unmatched vehicle — Name=' + JSON.stringify(name) +
          ' Rego/Plate=' + JSON.stringify(row['Rego/Plate'] || null) +
          ' Asset Code=' + JSON.stringify(row['Asset Code'] || null) +
          ' (exact assets.asset_name match required; Asset Code is not used)'
        );
        return;
      }

      var distance = parseNumeric(row['Distance (km)']);
      if (distance === null) distance = 0;

      // *** MINUTES → HOURS — see idleMinutesToHours comment above ***
      var idleMinutes = idleHeader ? parseNumeric(row[idleHeader]) : null;
      if (idleMinutes === null) idleMinutes = 0;
      var idleHours = idleMinutesToHours(idleMinutes);

      var odo = parseNumeric(row['Ehubo/Odo (km)']);

      // RUC Purchased ($): intentionally ignored — FleetMagnify uses its own
      // GVM-based RUC framework, not provider-reported RUC figures.

      records.push({
        user_id: userId,
        asset_id: Number(asset.id),
        record_date: recordDate,
        daily_distance_km: distance,
        idle_hours: idleHours,
      });

      if (odo != null) {
        odoUpdates.push({ assetId: asset.id, odometer: odo });
      }
    });

    if (records.length === 0) {
      throw new Error(
        'No valid eROAD records to import (unmatched=' + unmatched.length + ')'
      );
    }

    var upsertResult = await supabase
      .from('telematics_records')
      .upsert(records, { onConflict: 'asset_id,record_date' });
    if (upsertResult.error) {
      throw new Error('Failed to upsert eROAD records: ' + upsertResult.error.message);
    }

    // Overwrite assets.current_odometer with Ehubo/Odo (cumulative, not add).
    var latestOdo = {};
    odoUpdates.forEach(function(u) {
      if (latestOdo[u.assetId] == null || u.odometer > latestOdo[u.assetId]) {
        latestOdo[u.assetId] = u.odometer;
      }
    });
    var odoIds = Object.keys(latestOdo);
    for (var i = 0; i < odoIds.length; i++) {
      var aid = odoIds[i];
      var upd = await supabase
        .from('assets')
        .update({ current_odometer: latestOdo[aid] })
        .eq('id', Number(aid))
        .eq('user_id', userId);
      if (upd.error) {
        console.warn('eroad: failed to update current_odometer for asset ' + aid + ': ' + upd.error.message);
      }
    }

    await updateImportStatus(supabase, importId, 'processed', null, 'eroad');

    return {
      ok: true,
      recordDate: recordDate,
      recordsUpserted: records.length,
      unmatched: unmatched.length,
      unmatchedDetails: unmatched,
      odometerUpdated: odoIds.length,
    };
  } catch (err) {
    await updateImportStatus(supabase, importId, 'failed', err.message, 'eroad');
    throw err;
  }
}

module.exports = {
  isEroadCsv: isEroadCsv,
  isEroadTitleRow: isEroadTitleRow,
  isEroadHeaderRow: isEroadHeaderRow,
  parseEroadReport: parseEroadReport,
  parseEroadRows: parseEroadRows,
  extractEroadReportDate: extractEroadReportDate,
  idleMinutesToHours: idleMinutesToHours,
  isTotalsRow: isTotalsRow,
  EROAD_SIGNATURE: EROAD_SIGNATURE,
};
