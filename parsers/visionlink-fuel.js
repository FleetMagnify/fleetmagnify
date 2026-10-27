/**
 * VisionLink Fleet Fuel report CSV parser.
 *
 * Preamble (typical):
 *   Fleet Fuel Report
 *   Report Date Range
 *   27/10/2026 00:00 - 27/10/2026 23:59
 *   Asset ID, Asset Serial Number, ..., Idle Fuel Burn (L), ..., Working Fuel Burn (L), ...
 *
 * Every scheduled file covers exactly one day. A multi-day range is rejected.
 * The date line is DD/MM/YYYY or MM/DD/YYYY depending on the account locale;
 * disambiguation matches parsers/parser-utils.js (resolveVisionLinkDateReading).
 *
 * Writes ONLY idle_fuel_litres and working_fuel_litres on telematics_records
 * (plus the conflict key and user_id). Utilization columns are omitted so a
 * merge leaves them untouched, and a later Utilization upsert that omits
 * these two columns leaves them alone.
 */

const {
  parseCsvLine,
  normalizeHeader,
  parseNumeric,
  updateImportStatus,
  parseVisionLinkFilenameRange,
  resolveVisionLinkDateReading,
  visionLinkOneDayMessage,
} = require('./parser-utils');
const { loadAssetMaps, matchAsset, stageUnmatchedVisionLinkAssets, visionLinkWaitingNote } = require('./visionlink');

var FUEL_SIGNATURE = [
  'Asset ID',
  'Idle Fuel Burn (L)',
  'Working Fuel Burn (L)',
  'Total Fuel Burned (L)',
];

var FUEL_DATE_UNRESOLVED =
  'VisionLink Fleet Fuel report date could not be resolved. Expected a one-day range like ' +
  '"27/10/2026 00:00 - 27/10/2026 23:59" (DD/MM or MM/DD). When both readings are valid, ' +
  'the end date must be within 7 days of the New Zealand date the file was received.';

// Two date-times separated by " - ", e.g. "27/10/2026 00:00 - 27/10/2026 23:59"
// or the US-locale "10/27/2026 00:00 - 10/27/2026 23:59".
var FUEL_RANGE_RE = /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AP]M)?\s+-\s+(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AP]M)?/i;

function isVisionLinkFuelHeaderRow(headers) {
  var normalized = headers.map(normalizeHeader);
  // Utilization layout has Hour Meter (Hours) and no Idle Fuel Burn (L).
  if (normalized.indexOf('Hour Meter (Hours)') !== -1) return false;
  return FUEL_SIGNATURE.every(function(col) {
    return normalized.indexOf(col) !== -1;
  });
}

function isVisionLinkFuelCsv(rawCsv) {
  if (!rawCsv || !String(rawCsv).trim()) return false;
  var lines = String(rawCsv).split(/\r?\n/);
  var scanLimit = Math.min(lines.length, 15);
  for (var i = 0; i < scanLimit; i++) {
    if (lines[i] && lines[i].trim() && isVisionLinkFuelHeaderRow(parseCsvLine(lines[i]))) {
      return true;
    }
  }
  return false;
}

function extractFuelRangeTokens(rawCsv) {
  var lines = String(rawCsv || '').split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    var match = lines[i].match(FUEL_RANGE_RE);
    if (!match) continue;
    return [
      { a: parseInt(match[1], 10), b: parseInt(match[2], 10), year: parseInt(match[3], 10) },
      { a: parseInt(match[4], 10), b: parseInt(match[5], 10), year: parseInt(match[6], 10) },
    ];
  }
  return null;
}

function parseFleetFuelDateRange(rawCsv, receivedAt) {
  var tokens = extractFuelRangeTokens(rawCsv);
  if (!tokens) return null;
  var dates = resolveVisionLinkDateReading(tokens, receivedAt);
  if (!dates) return null;
  return { start: dates[0], end: dates[1] };
}

function parseVisionLinkFuelRows(rawCsv) {
  var lines = String(rawCsv).split(/\r?\n/);
  var headerIdx = -1;
  var headers = [];
  for (var i = 0; i < Math.min(lines.length, 15); i++) {
    var candidate = parseCsvLine(lines[i]);
    if (isVisionLinkFuelHeaderRow(candidate)) {
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

function isFuelTotalRow(row) {
  var assetId = String(row['Asset ID'] || '').trim();
  var family = String(row['Product Family'] || '').trim();
  if (/^null$/i.test(assetId)) assetId = '';
  return !assetId && /^total$/i.test(family);
}

function filenameMismatchMessage(fileRange, bodyRange) {
  return 'VisionLink Fleet Fuel filename date range (' + fileRange.start + ' to ' + fileRange.end +
    ') does not match the report date range (' + bodyRange.start + ' to ' + bodyRange.end + ').';
}

async function parseVisionLinkFuelReport(supabase, options) {
  var userId = options.userId;
  var importId = options.importId;
  var rawCsv = options.rawCsv;
  var filename = options.filename;
  var receivedAt = options.receivedAt;

  try {
    if (!isVisionLinkFuelCsv(rawCsv)) {
      throw new Error('Not a VisionLink Fleet Fuel CSV');
    }

    var bodyRange = parseFleetFuelDateRange(rawCsv, receivedAt);
    if (!bodyRange) throw new Error(FUEL_DATE_UNRESOLVED);
    if (bodyRange.start !== bodyRange.end) {
      throw new Error(visionLinkOneDayMessage(bodyRange.start, bodyRange.end));
    }

    var fileRange = parseVisionLinkFilenameRange(filename, receivedAt);
    if (fileRange) {
      if (fileRange.start !== fileRange.end) {
        throw new Error(visionLinkOneDayMessage(fileRange.start, fileRange.end));
      }
      if (fileRange.start !== bodyRange.start || fileRange.end !== bodyRange.end) {
        throw new Error(filenameMismatchMessage(fileRange, bodyRange));
      }
    }

    var recordDate = bodyRange.start;
    var rows = parseVisionLinkFuelRows(rawCsv);
    var maps = await loadAssetMaps(supabase, userId);
    // Stage unknown machines, including ones with no idle/working split.
    // The Total row is not a machine.
    var toStage = [];
    rows.forEach(function(row) {
      if (isFuelTotalRow(row)) return;
      if (matchAsset(row, maps)) return;
      toStage.push(row);
    });
    var stageResult = await stageUnmatchedVisionLinkAssets(supabase, userId, toStage, 'visionlink-fuel');

    var records = [];
    var skippedNoSplit = 0;
    var skippedTotal = 0;
    var unmatched = [];

    rows.forEach(function(row, idx) {
      if (isFuelTotalRow(row)) {
        skippedTotal++;
        return;
      }

      // "-" , blank, and thousands-separated numbers. parseNumeric strips
      // every comma and returns null for blanks and "-".
      var idleFuel = parseNumeric(row['Idle Fuel Burn (L)']);
      var workingFuel = parseNumeric(row['Working Fuel Burn (L)']);
      if (idleFuel == null && workingFuel == null) {
        skippedNoSplit++;
        return;
      }

      var matched = matchAsset(row, maps);
      if (!matched) {
        var miss = {
          row: idx + 1,
          assetId: row['Asset ID'] || null,
          serial: row['Asset Serial Number'] || null,
          make: row['Make Display Name'] || null,
          model: row.Model || null,
        };
        unmatched.push(miss);
        console.warn(
          'visionlink-fuel: unmatched asset — Asset ID=' + JSON.stringify(miss.assetId) +
          ' Serial=' + JSON.stringify(miss.serial) +
          ' Make/Model=' + (miss.make || '') + ' ' + (miss.model || '') +
          ' (no assets.asset_name bracket match and no visionlink_serial match)'
        );
        return;
      }

      // Five columns only. postgrest-js bulk upsert sets `columns` to the
      // union of Object.keys; keys that are absent are not in the merge,
      // so Utilization values already stored on this asset/day stay put.
      // Explicit null on a column this parser does not own would wipe it.
      // idle/working are this parser's columns: a missing side is stored
      // as null (the key is present) so a partial split replaces that side.
      records.push({
        user_id: userId,
        asset_id: Number(matched.asset.id),
        record_date: recordDate,
        idle_fuel_litres: idleFuel,
        working_fuel_litres: workingFuel,
      });
    });

    if (records.length === 0) {
      // Processed plus a note does not throw, so the inbound failure alert
      // (which runs only from the catch) is not sent.
      if (stageResult.staged > 0 || stageResult.skippedIgnored > 0) {
        var waitingNote = visionLinkWaitingNote(stageResult.staged);
        await updateImportStatus(supabase, importId, 'processed', waitingNote, 'visionlink-fuel');
        return {
          ok: true,
          recordsUpserted: 0,
          skippedNoSplit: skippedNoSplit,
          skippedTotal: skippedTotal,
          unmatched: unmatched.length,
          unmatchedDetails: unmatched,
          recordDate: recordDate,
          pendingStaged: stageResult.staged,
          pendingIgnored: stageResult.skippedIgnored,
          importNote: waitingNote,
        };
      }
      if (unmatched.length === 0) {
        await updateImportStatus(supabase, importId, 'processed', null, 'visionlink-fuel');
        return {
          ok: true,
          recordsUpserted: 0,
          skippedNoSplit: skippedNoSplit,
          skippedTotal: skippedTotal,
          unmatched: 0,
          unmatchedDetails: [],
          recordDate: recordDate,
          pendingStaged: 0,
          pendingIgnored: 0,
        };
      }
      throw new Error(
        'No valid VisionLink Fleet Fuel records to import' +
        ' (noSplit=' + skippedNoSplit +
        ', unmatched=' + unmatched.length + ')'
      );
    }

    var upsertResult = await supabase
      .from('telematics_records')
      .upsert(records, { onConflict: 'asset_id,record_date' });
    if (upsertResult.error) {
      throw new Error('Failed to upsert VisionLink Fleet Fuel records: ' + upsertResult.error.message);
    }

    await updateImportStatus(supabase, importId, 'processed', null, 'visionlink-fuel');

    return {
      ok: true,
      recordsUpserted: records.length,
      skippedNoSplit: skippedNoSplit,
      skippedTotal: skippedTotal,
      unmatched: unmatched.length,
      unmatchedDetails: unmatched,
      recordDate: recordDate,
      pendingStaged: stageResult.staged,
      pendingIgnored: stageResult.skippedIgnored,
    };
  } catch (err) {
    await updateImportStatus(supabase, importId, 'failed', err.message, 'visionlink-fuel');
    throw err;
  }
}

module.exports = {
  isVisionLinkFuelCsv: isVisionLinkFuelCsv,
  isVisionLinkFuelHeaderRow: isVisionLinkFuelHeaderRow,
  parseVisionLinkFuelReport: parseVisionLinkFuelReport,
  parseVisionLinkFuelRows: parseVisionLinkFuelRows,
  parseFleetFuelDateRange: parseFleetFuelDateRange,
  FUEL_DATE_UNRESOLVED: FUEL_DATE_UNRESOLVED,
  FUEL_SIGNATURE: FUEL_SIGNATURE,
};
