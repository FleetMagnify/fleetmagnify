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
 * assets.current_hours takes the max Hour Meter in this file, and only when
 * the file's record_date is at least as new as the asset's newest stored
 * telematics day. An older file still upserts its telematics row.
 *
 * record_date is one calendar day. A Fleet_Utilization filename that names
 * a single day is used for every row. Otherwise the date is taken from
 * "Latest Utilization Report" / "Hour Meter Last Reported Time", which are
 * UTC instants, converted into the row's IANA time zone. Those strings are
 * not already New Zealand local dates.
 *
 * idle_fuel_litres and working_fuel_litres are owned by the Fleet Fuel
 * parser. This upsert omits them so a merge leaves them untouched.
 */

const {
  parseCsvLine,
  normalizeHeader,
  parseNumeric,
  updateImportStatus,
  parseVisionLinkFilenameRange,
  utcTimestampToLocalDate,
  visionLinkOneDayMessage,
} = require('./parser-utils');
const idleRates = require('./visionlink-idle-rate');

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
 * Extract a calendar date (YYYY-MM-DD) from a VisionLink date string that
 * is not a UTC instant: M/D/YYYY, D/M/YYYY, or a date-only token.
 *
 * Do not use this for "Latest Utilization Report" or "Hour Meter Last
 * Reported Time" when they are ISO instants. Those columns are true UTC
 * timestamps (they end in Z, or carry an explicit offset). The calendar
 * date written on a Z string is the UTC date and can be one day earlier
 * than the New Zealand date. Convert those with utcTimestampToLocalDate
 * and the row's Time Zone column. This helper only reads the date token
 * that is already written in the string; it does not shift time zones.
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

function isUtcInstant(value) {
  return /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(String(value || '').trim());
}

/**
 * Fallback record_date when the filename does not name a single day.
 * ISO instants are converted into the row's Time Zone (default
 * Pacific/Auckland). Non-instant strings (US M/D/YYYY exports) keep the
 * calendar date written in the cell.
 */
function rowRecordDate(row) {
  var zone = row['Time Zone'];
  var fields = ['Latest Utilization Report', 'Hour Meter Last Reported Time'];
  for (var i = 0; i < fields.length; i++) {
    var raw = String(row[fields[i]] || '').trim();
    if (!raw || /^null$/i.test(raw)) continue;
    if (isUtcInstant(raw)) {
      var local = utcTimestampToLocalDate(raw, zone);
      if (local) return local;
    }
    var parsed = parseVisionLinkDate(raw);
    if (parsed) return parsed;
  }
  return null;
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

var VISIONLINK_ASSET_TYPES = {
  Excavator: true,
  'Dump Truck': true,
  'Wheel Loader': true,
  'Motor Grader': true,
  Bulldozer: true,
  Skidder: true,
  Compactor: true,
  Crane: true,
  Forklift: true,
  'Light Vehicle': true,
  'Rigid Truck': true,
  'Semi Trailer': true,
  'Truck & Trailer': true,
  'Water Truck': true,
  Other: true,
};

function cleanVisionLinkToken(value) {
  var s = String(value == null ? '' : value).trim();
  if (!s || /^null$/i.test(s)) return '';
  return s;
}

/**
 * "<Make> <Model> (<Asset ID>)". The bracketed id is the last group so
 * extractBracketAssetId() finds it after the owner approves the name.
 * A blank Asset ID uses the serial in the brackets. Blank id and serial
 * returns null (nothing to match later).
 */
function visionLinkMachineName(row) {
  var make = cleanVisionLinkToken(row.Make || row['Make Display Name']);
  var model = cleanVisionLinkToken(row.Model);
  var assetId = cleanVisionLinkToken(row['Asset ID']);
  var serial = cleanVisionLinkToken(row['Asset Serial Number']);
  var bracket = assetId || serial;
  if (!bracket) return null;
  var head = (make + ' ' + model).replace(/\s+/g, ' ').trim();
  if (!head) return '(' + bracket + ')';
  return head + ' (' + bracket + ')';
}

/**
 * Default type for a pending machine. Product Family wins when the Fleet
 * Fuel report has one. Utilization has no family, so the model is used
 * only when it contains a type word — model numbers such as 326FL stay
 * 'Other'. Does not call detectAssetType (that fallback is Rigid Truck).
 */
function visionLinkAssetType(productFamily, model) {
  var family = String(productFamily || '').trim().toLowerCase();
  var fromFamily = family ? typeFromText(family) : null;
  if (fromFamily) return fromFamily;
  if (family) return 'Other';
  var fromModel = typeFromText(String(model || '').trim().toLowerCase());
  return fromModel || 'Other';
}

function typeFromText(text) {
  if (!text) return null;
  if (text.indexOf('excavator') !== -1) return 'Excavator';
  if (text.indexOf('wheel loader') !== -1) return 'Wheel Loader';
  if (text.indexOf('skidder') !== -1) return 'Skidder';
  if (text.indexOf('track-type tractor') !== -1 || text.indexOf('dozer') !== -1) return 'Bulldozer';
  if (text.indexOf('grader') !== -1) return 'Motor Grader';
  if (text.indexOf('compactor') !== -1 || text.indexOf('compact') !== -1) return 'Compactor';
  if (text.indexOf('telehandler') !== -1 || text.indexOf('forklift') !== -1) return 'Forklift';
  if (text.indexOf('crane') !== -1) return 'Crane';
  if (text.indexOf('articulated truck') !== -1 || text.indexOf('dump') !== -1) return 'Dump Truck';
  return null;
}

function visionLinkWaitingNote(stagedCount) {
  return 'No known machines yet: ' + stagedCount +
    ' machine(s) waiting for approval on the Assets page.';
}

async function loadIgnoredAssetNames(supabase, userId) {
  var ignoredResult = await supabase
    .from('ignored_assets')
    .select('asset_name')
    .eq('user_id', userId);
  if (ignoredResult.error) {
    throw new Error('Failed to load ignored assets: ' + ignoredResult.error.message);
  }
  var ignoredSet = {};
  (ignoredResult.data || []).forEach(function(row) {
    if (row && row.asset_name) ignoredSet[String(row.asset_name).trim()] = true;
  });
  return ignoredSet;
}

/**
 * Stage machines that are not on the asset list yet. Same name from
 * Utilization and Fleet Fuel so the pending_assets upsert dedupes them.
 * ignored_assets names are skipped. ignoreDuplicates leaves an existing
 * pending row untouched.
 */
async function stageUnmatchedVisionLinkAssets(supabase, userId, rows, source) {
  var ignoredSet = await loadIgnoredAssetNames(supabase, userId);
  var seen = {};
  var staged = [];
  var skippedIgnored = 0;
  var skippedNoId = 0;

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var name = visionLinkMachineName(row);
    if (!name) {
      skippedNoId++;
      console.warn(
        source + ': skipping row with no Asset ID and no serial — not staged'
      );
      continue;
    }
    if (seen[name]) continue;
    seen[name] = true;
    if (ignoredSet[name]) {
      skippedIgnored++;
      console.log(source + ': not staging ignored asset ' + JSON.stringify(name));
      continue;
    }

    var assetId = cleanVisionLinkToken(row['Asset ID']);
    var serial = cleanVisionLinkToken(row['Asset Serial Number']);
    var make = cleanVisionLinkToken(row.Make || row['Make Display Name']);
    var model = cleanVisionLinkToken(row.Model);
    var productFamily = cleanVisionLinkToken(row['Product Family']);
    var assetType = visionLinkAssetType(productFamily, model);
    if (!VISIONLINK_ASSET_TYPES[assetType]) assetType = 'Other';

    var pendingResult = await supabase.from('pending_assets').upsert({
      user_id: userId,
      asset_name: name,
      asset_type: assetType,
      registration: null,
      source: source,
      raw_data: {
        assetId: assetId || null,
        serial: serial || null,
        make: make || null,
        model: model || null,
        productFamily: productFamily || null,
        source: source,
      },
    }, { onConflict: 'user_id,asset_name', ignoreDuplicates: true });

    if (pendingResult.error) {
      console.warn(source + ': failed to stage ' + JSON.stringify(name) + ': ' + pendingResult.error.message);
      continue;
    }
    staged.push(name);
    console.log(source + ': staged pending asset ' + JSON.stringify(name));
  }

  if (staged.length || skippedIgnored) {
    console.log(
      source + ': staged ' + staged.length + ' machine(s) for approval' +
      (skippedIgnored ? ' (' + skippedIgnored + ' ignored)' : '')
    );
  }

  return {
    staged: staged.length,
    stagedNames: staged,
    skippedIgnored: skippedIgnored,
    skippedNoId: skippedNoId,
  };
}

async function newestStoredRecordDates(supabase, userId, assetIds) {
  var newest = {};
  // One row per asset. A single .in() select is capped at PostgREST's
  // default 1,000 rows, so a busy asset's newest day can fall off the page.
  for (var i = 0; i < assetIds.length; i++) {
    var assetId = assetIds[i];
    var result = await supabase
      .from('telematics_records')
      .select('record_date')
      .eq('asset_id', assetId)
      .eq('user_id', userId)
      .order('record_date', { ascending: false })
      .limit(1);
    if (result.error) {
      throw new Error('Failed to load telematics dates: ' + result.error.message);
    }
    var row = (result.data || [])[0];
    if (!row || !row.record_date) continue;
    newest[String(assetId)] = String(row.record_date).slice(0, 10);
  }
  return newest;
}

async function parseVisionLinkReport(supabase, options) {
  var userId = options.userId;
  var importId = options.importId;
  var rawCsv = options.rawCsv;
  var filename = options.filename;
  var receivedAt = options.receivedAt;

  try {
    var fileRange = parseVisionLinkFilenameRange(filename, receivedAt);
    var forcedDate = null;
    if (fileRange) {
      if (fileRange.start !== fileRange.end) {
        throw new Error(visionLinkOneDayMessage(fileRange.start, fileRange.end));
      }
      forcedDate = fileRange.start;
    } else {
      console.warn(
        'visionlink: fallback record_date — filename had no usable one-day range' +
        (filename ? ' (' + filename + ')' : ' (no filename)') +
        '; using Latest Utilization Report / Hour Meter Last Reported Time converted to the row Time Zone, not the UTC calendar date'
      );
    }

    var rows = parseVisionLinkRows(rawCsv);
    if (rows.length === 0) throw new Error('No VisionLink data rows found');

    var maps = await loadAssetMaps(supabase, userId);
    // Unknown machines are offered for approval even when they did not run
    // today. This runs before the empty-activity skip below, which only
    // decides whether a telematics row is written.
    var toStage = [];
    rows.forEach(function(row) {
      if (matchAsset(row, maps)) return;
      toStage.push(row);
    });
    var stageResult = await stageUnmatchedVisionLinkAssets(supabase, userId, toStage, 'visionlink');

    var records = [];
    var hoursUpdates = []; // { assetId, hours, recordDate }
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

      var dateStr = forcedDate || rowRecordDate(row);
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

      // Omit idle_fuel_litres and working_fuel_litres. supabase-js
      // (@supabase/postgrest-js 1.19.2) bulk-upserts with `columns` set to
      // the union of Object.keys and posts the objects unchanged. A key
      // that is absent is not updated on conflict. Setting either fuel
      // column to null would put it in `columns` and wipe the Fleet Fuel
      // parser's values.
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
          recordDate: dateStr,
        });
      }
    });

    // A processed import with a note does not throw, so email-inbound does
    // not send the failure alert (that alert runs only from the catch).
    if (records.length === 0) {
      if (stageResult.staged > 0 || stageResult.skippedIgnored > 0) {
        var waitingNote = visionLinkWaitingNote(stageResult.staged);
        await updateImportStatus(supabase, importId, 'processed', waitingNote, 'visionlink');
        return {
          ok: true,
          recordsUpserted: 0,
          skippedEmpty: skippedEmpty,
          skippedNoDate: skippedNoDate,
          unmatched: unmatched.length,
          unmatchedDetails: unmatched,
          calloutsLogged: calloutsLogged,
          hoursUpdated: 0,
          pendingStaged: stageResult.staged,
          pendingIgnored: stageResult.skippedIgnored,
          importNote: waitingNote,
        };
      }
      throw new Error(
        'No valid VisionLink records to import' +
        ' (emptyActivity=' + skippedEmpty +
        ', noDate=' + skippedNoDate +
        ', unmatched=' + unmatched.length + ')'
      );
    }

    var latestHoursByAsset = {};
    hoursUpdates.forEach(function(u) {
      var current = latestHoursByAsset[u.assetId];
      if (!current || u.hours > current.hours) {
        latestHoursByAsset[u.assetId] = { hours: u.hours, recordDate: u.recordDate };
      }
    });
    var hourAssetIds = Object.keys(latestHoursByAsset);
    var newestDates = await newestStoredRecordDates(
      supabase,
      userId,
      hourAssetIds.map(function(id) { return Number(id); })
    );

    var upsertResult = await supabase
      .from('telematics_records')
      .upsert(records, { onConflict: 'asset_id,record_date' });
    if (upsertResult.error) {
      throw new Error('Failed to upsert VisionLink records: ' + upsertResult.error.message);
    }

    // Max hour meter in this file, and only when the file is not older
    // than the newest day already stored for that asset.
    var hoursUpdated = 0;
    for (var h = 0; h < hourAssetIds.length; h++) {
      var aid = hourAssetIds[h];
      var entry = latestHoursByAsset[aid];
      var storedDate = newestDates[String(aid)];
      if (storedDate && entry.recordDate < storedDate) {
        console.log(
          'visionlink: skipping current_hours update for asset ' + aid +
          ' (file date ' + entry.recordDate + ' is older than newest stored ' + storedDate + ')'
        );
        continue;
      }
      var upd = await supabase
        .from('assets')
        .update({ current_hours: entry.hours })
        .eq('id', Number(aid))
        .eq('user_id', userId);
      if (upd.error) {
        console.warn(
          'visionlink: failed to update current_hours for asset ' + aid + ': ' + upd.error.message
        );
      } else {
        hoursUpdated++;
      }
    }

    try {
      var idleAssetIds = [];
      records.forEach(function(r) {
        if (idleAssetIds.indexOf(r.asset_id) === -1) idleAssetIds.push(r.asset_id);
      });
      await idleRates.recomputeMeasuredIdleRates(supabase, userId, idleAssetIds);
    } catch (rateErr) {
      console.warn(
        'visionlink: idle rate recompute failed: ' +
        (rateErr && rateErr.message ? rateErr.message : 'error')
      );
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
      hoursUpdated: hoursUpdated,
      pendingStaged: stageResult.staged,
      pendingIgnored: stageResult.skippedIgnored,
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
  loadAssetMaps: loadAssetMaps,
  stageUnmatchedVisionLinkAssets: stageUnmatchedVisionLinkAssets,
  visionLinkAssetType: visionLinkAssetType,
  visionLinkMachineName: visionLinkMachineName,
  visionLinkWaitingNote: visionLinkWaitingNote,
  VISIONLINK_SIGNATURE: VISIONLINK_SIGNATURE,
};
