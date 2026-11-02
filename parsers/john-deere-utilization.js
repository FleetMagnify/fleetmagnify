/**
 * John Deere Operations Center Utilization report.
 *
 * The daily email has no CSV attachment. The "CSV" link is an https
 * CloudFront URL. A GET returns a 302 to one pre-signed S3 object, or the
 * CSV itself. The "View in Machine Reports" link is the web app and is
 * never followed. The CloudFront URL and the S3 URL are credentials:
 * never log or store them. A hostname is not a secret.
 *
 * The filename date is not the data date. record_date is Report Start Date.
 * A midnight-to-midnight file (end date is the next day at 12:00 AM) is
 * one day, and the end instant is exclusive.
 *
 * assets.visionlink_serial is a historical column name. It now holds any
 * telematics serial or PIN, including a John Deere Machine Serial Number.
 * Follow-up: rename the column.
 *
 * operating_hours is working time and excludes idle (Total Hours − Idle).
 * This report has no hour meter, so total_engine_hours and
 * assets.current_hours are left untouched.
 */

const {
  parseCsvLine,
  normalizeHeader,
  parseNumeric,
  updateImportStatus,
  johnDeereMultiDayMessage,
} = require('./parser-utils');
const { extractBracketAssetId } = require('./visionlink');
const idleRates = require('./visionlink-idle-rate');
const {
  scrubLinkError,
  filenameFromContentDisposition,
  readLimitedBody,
  stripTags,
  mediaTypeOf,
  isRedirectStatus,
  MAX_BYTES,
  TIMEOUT_MS,
} = require('./email-report-link');

var SIGNATURE = [
  'Machine Serial Number',
  'Key On (l)',
  'Low Load (l)',
  'High Load (l)',
  'Idle (l)',
  'Total Fuel (l)',
  'Total Hours',
  'Report Start Date',
  'Report End Date',
];

var NUMERIC_FIELDS = [
  'Key On (l)', 'Low Load (l)', 'Medium Load (l)', 'High Load (l)',
  'Idle (l)', 'Working (l)', 'Transport (l)', 'Total Fuel (l)',
  'Key On (h)', 'Low Load (h)', 'Medium Load (h)', 'High Load (h)',
  'Idle (h)', 'Working (h)', 'Transport (h)', 'Total Hours',
];

var MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

var MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// The only host a CloudFront report link may redirect to. Change this if
// Deere moves the completed-report bucket.
var JOHN_DEERE_REPORT_S3_HOST = 'mhm-reports-completed-storage-prod.s3.us-east-1.amazonaws.com';
var MAX_LINKS = 3;
var MAX_REDIRECTS = 2;
var DEFAULT_FILENAME = 'John-Deere-Utilization.csv';
var LINK_FAILURE_SUFFIX = '; open the Machine Reports link in Operations Center, download the CSV and email it as an attachment';

function stripBom(text) {
  return String(text || '').replace(/^\uFEFF/, '');
}

function isJohnDeereHeaderRow(headers) {
  var normalized = headers.map(normalizeHeader);
  return SIGNATURE.every(function(col) {
    return normalized.indexOf(col) !== -1;
  });
}

function isJohnDeereUtilizationCsv(rawCsv) {
  var text = stripBom(rawCsv);
  if (!text.trim()) return false;
  var lines = text.split(/\r?\n/);
  var scanLimit = Math.min(lines.length, 15);
  for (var i = 0; i < scanLimit; i++) {
    if (lines[i] && lines[i].trim() && isJohnDeereHeaderRow(parseCsvLine(lines[i]))) {
      return true;
    }
  }
  return false;
}

function parseJohnDeereRows(rawCsv) {
  var lines = stripBom(rawCsv).split(/\r?\n/);
  var headerIdx = -1;
  var headers = [];
  for (var i = 0; i < Math.min(lines.length, 15); i++) {
    var candidate = parseCsvLine(lines[i]);
    if (isJohnDeereHeaderRow(candidate)) {
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

function parseJohnDeereDate(value) {
  var match = String(value || '').trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (!match) return null;
  var month = MONTHS[match[1].toLowerCase().slice(0, 3)];
  var day = parseInt(match[2], 10);
  var year = parseInt(match[3], 10);
  if (!month || !day || !year || year < 2000 || year > 2100) return null;
  var dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return null;
  }
  return year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
}

function parseJohnDeereTime(value) {
  var match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return null;
  var hour = parseInt(match[1], 10);
  var minute = parseInt(match[2], 10);
  if (hour < 1 || hour > 12 || minute > 59) return null;
  var ap = match[3].toUpperCase();
  if (ap === 'AM' && hour === 12) hour = 0;
  else if (ap === 'PM' && hour !== 12) hour += 12;
  return { hour: hour, minute: minute };
}

function isMidnight(time) {
  return !!(time && time.hour === 0 && time.minute === 0);
}

function addDays(iso, days) {
  var parts = String(iso).split('-').map(Number);
  var dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  dt.setUTCDate(dt.getUTCDate() + days);
  var y = dt.getUTCFullYear();
  var m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  var d = String(dt.getUTCDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

function formatDayMonth(iso) {
  var parts = String(iso).split('-');
  return Number(parts[2]) + ' ' + MONTH_LABELS[Number(parts[1]) - 1];
}

function formatRecordDate(iso) {
  var parts = String(iso).split('-');
  return formatDayMonth(iso) + ' ' + parts[0];
}

function rowWindow(row) {
  var startDate = parseJohnDeereDate(row['Report Start Date']);
  var endDate = parseJohnDeereDate(row['Report End Date']);
  var startTime = parseJohnDeereTime(row['Report Start Time']);
  var endTime = parseJohnDeereTime(row['Report End Time']);
  if (!startDate || !endDate || !startTime || !endTime) return null;
  return {
    startDate: startDate,
    endDate: endDate,
    startTime: startTime,
    endTime: endTime,
  };
}

function isSingleDayWindow(window) {
  if (window.endDate === window.startDate) return true;
  return window.endDate === addDays(window.startDate, 1) &&
    isMidnight(window.startTime) &&
    isMidnight(window.endTime);
}

function lastCoveredDay(window) {
  if (isMidnight(window.endTime)) return addDays(window.endDate, -1);
  return window.endDate;
}

function recordDateForRows(rows) {
  var windows = [];
  for (var i = 0; i < rows.length; i++) {
    var window = rowWindow(rows[i]);
    if (!window) throw new Error('John Deere report dates could not be read');
    windows.push(window);
  }
  var sameStart = windows.every(function(window) {
    return window.startDate === windows[0].startDate;
  });
  var allSingle = windows.every(isSingleDayWindow);
  if (allSingle && sameStart) return windows[0].startDate;

  var start = windows[0].startDate;
  var end = lastCoveredDay(windows[0]);
  windows.forEach(function(window) {
    if (window.startDate < start) start = window.startDate;
    var covered = lastCoveredDay(window);
    if (covered > end) end = covered;
  });
  throw new Error(johnDeereMultiDayMessage(formatDayMonth(start), formatDayMonth(end)));
}

function deereValue(value) {
  var text = String(value == null ? '' : value).trim();
  if (!text || text === '---' || /^null$/i.test(text)) return null;
  return parseNumeric(text);
}

function isEmptyActivityRow(row) {
  return NUMERIC_FIELDS.every(function(field) {
    return deereValue(row[field]) == null;
  });
}

function nicknameHead(nickname) {
  var text = String(nickname || '').trim();
  if (!text || text === '---') return '';
  var splitAt = text.indexOf(' - ');
  if (splitAt === -1) return text;
  var head = text.slice(0, splitAt).trim();
  return head || text;
}

function cleanText(value) {
  var text = String(value == null ? '' : value).trim();
  if (!text || text === '---' || /^null$/i.test(text)) return '';
  return text;
}

function johnDeereAssetType(typeText) {
  var text = cleanText(typeText);
  var lower = text.toLowerCase();
  if (!lower) return 'Other';
  if (lower.indexOf('excavator') !== -1) return 'Excavator';
  if (lower.indexOf('wheel loader') !== -1) return 'Wheel Loader';
  if (lower.indexOf('skidder') !== -1) return 'Skidder';
  if (lower.indexOf('dozer') !== -1 || lower.indexOf('crawler') !== -1) return 'Bulldozer';
  if (lower.indexOf('grader') !== -1) return 'Motor Grader';
  if (lower.indexOf('compactor') !== -1) return 'Compactor';
  if (lower.indexOf('forklift') !== -1 || lower.indexOf('telehandler') !== -1) return 'Forklift';
  if (lower.indexOf('crane') !== -1) return 'Crane';
  if (lower.indexOf('dump') !== -1 || lower.indexOf('articulated') !== -1) return 'Dump Truck';
  if (lower.indexOf('harvester') !== -1) return 'Forestry Harvester';
  if (lower.indexOf('swing') !== -1) return 'Swing Machine';
  return 'Other';
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function operatingHoursFor(row) {
  var total = deereValue(row['Total Hours']);
  var idle = deereValue(row['Idle (h)']);
  if (total != null && idle != null) return round2(total - idle);
  var low = deereValue(row['Low Load (h)']);
  var medium = deereValue(row['Medium Load (h)']);
  var high = deereValue(row['High Load (h)']);
  if (low != null && medium != null && high != null) return round2(low + medium + high);
  return null;
}

function workingFuelFor(row) {
  var low = deereValue(row['Low Load (l)']);
  var medium = deereValue(row['Medium Load (l)']);
  var high = deereValue(row['High Load (l)']);
  if (low == null || medium == null || high == null) return null;
  return round2(low + medium + high);
}

function loadBandsBlank(row) {
  return deereValue(row['Low Load (l)']) == null &&
    deereValue(row['Medium Load (l)']) == null &&
    deereValue(row['High Load (l)']) == null;
}

async function loadAssetMaps(supabase, userId) {
  var assetResult = await supabase
    .from('assets')
    .select('id, asset_name, visionlink_serial, current_hours, telematics_provider')
    .eq('user_id', userId);
  if (assetResult.error) throw new Error('Failed to load assets: ' + assetResult.error.message);

  var bySerial = {};
  var byName = {};
  var byBracket = {};
  (assetResult.data || []).forEach(function(asset) {
    var name = String(asset.asset_name || '').trim();
    if (name) byName[name] = asset;
    var bracket = extractBracketAssetId(name);
    if (bracket) byBracket[bracket.toLowerCase()] = asset;
    var serial = String(asset.visionlink_serial || '').trim();
    if (serial) bySerial[serial.toLowerCase()] = asset;
  });
  return { bySerial: bySerial, byName: byName, byBracket: byBracket };
}

function matchAsset(row, maps) {
  var serial = cleanText(row['Machine Serial Number']);
  if (serial && maps.bySerial[serial.toLowerCase()]) {
    return { asset: maps.bySerial[serial.toLowerCase()], method: 'serial' };
  }
  var head = nicknameHead(row.Nickname);
  if (head && maps.byName[head]) return { asset: maps.byName[head], method: 'nickname' };
  var full = cleanText(row.Nickname);
  if (full && maps.byName[full]) return { asset: maps.byName[full], method: 'nickname' };
  if (serial && maps.byBracket[serial.toLowerCase()]) {
    return { asset: maps.byBracket[serial.toLowerCase()], method: 'bracket' };
  }
  if (head && maps.byBracket[head.toLowerCase()]) {
    return { asset: maps.byBracket[head.toLowerCase()], method: 'bracket' };
  }
  return null;
}

async function loadIgnoredNames(supabase, userId) {
  var result = await supabase.from('ignored_assets').select('asset_name').eq('user_id', userId);
  if (result.error) throw new Error('Failed to load ignored assets: ' + result.error.message);
  var ignored = {};
  (result.data || []).forEach(function(row) {
    if (row && row.asset_name) ignored[String(row.asset_name).trim()] = true;
  });
  return ignored;
}

async function stageUnmatched(supabase, userId, rows) {
  var ignored = await loadIgnoredNames(supabase, userId);
  var seen = {};
  var staged = 0;
  var skippedIgnored = 0;
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var serial = cleanText(row['Machine Serial Number']);
    var name = nicknameHead(row.Nickname) || cleanText(row.Nickname);
    if (!name && serial) name = serial;
    if (!name) continue;
    if (seen[name]) continue;
    seen[name] = true;
    if (ignored[name]) {
      skippedIgnored++;
      continue;
    }
    var model = cleanText(row.Model);
    var pending = await supabase.from('pending_assets').upsert({
      user_id: userId,
      asset_name: name,
      asset_type: johnDeereAssetType(row.Type),
      registration: null,
      source: 'john-deere',
      raw_data: {
        assetId: null,
        serial: serial || null,
        make: 'John Deere',
        model: model || null,
        productFamily: null,
        source: 'john-deere',
        telematicsProvider: 'John Deere',
      },
    }, { onConflict: 'user_id,asset_name', ignoreDuplicates: true });
    if (pending.error) {
      console.warn('john-deere: failed to stage ' + JSON.stringify(name) + ': ' + pending.error.message);
      continue;
    }
    staged++;
    console.log('john-deere: staged pending asset ' + JSON.stringify(name));
  }
  return { staged: staged, skippedIgnored: skippedIgnored };
}

function importSummary(updated, staged, skipped, recordDate) {
  return updated + ' updated, ' + staged + ' staged, ' + skipped +
    ' skipped (no activity reported), record date ' + formatRecordDate(recordDate);
}

async function rememberProvider(supabase, userId, asset) {
  if (String(asset.telematics_provider || '').trim()) return;
  var upd = await supabase
    .from('assets')
    .update({ telematics_provider: 'John Deere' })
    .eq('id', Number(asset.id))
    .eq('user_id', userId);
  if (upd.error) {
    console.warn('john-deere: failed to set telematics provider for asset ' + asset.id + ': ' + upd.error.message);
    return;
  }
  asset.telematics_provider = 'John Deere';
}

async function parseJohnDeereUtilizationReport(supabase, options) {
  var userId = options.userId;
  var importId = options.importId;
  var rawCsv = options.rawCsv;
  try {
    var rows = parseJohnDeereRows(rawCsv);
    if (!rows.length) throw new Error('No John Deere data rows found');
    var recordDate = recordDateForRows(rows);
    var maps = await loadAssetMaps(supabase, userId);

    var toStage = [];
    rows.forEach(function(row) {
      if (!matchAsset(row, maps)) toStage.push(row);
    });
    var stageResult = await stageUnmatched(supabase, userId, toStage);

    var records = [];
    var skippedEmpty = 0;
    var providerTouched = {};

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var matched = matchAsset(row, maps);
      if (isEmptyActivityRow(row)) {
        skippedEmpty++;
        continue;
      }
      if (loadBandsBlank(row)) {
        var named = [];
        if (deereValue(row['Working (l)']) != null) named.push('Working (l)');
        if (deereValue(row['Transport (l)']) != null) named.push('Transport (l)');
        if (named.length) {
          console.warn(
            'john-deere: ' + named.join(' and ') +
            ' numeric while Low Load (l), Medium Load (l) and High Load (l) are blank; not guessing a fuel split'
          );
        }
      }
      if (!matched) continue;

      if (!providerTouched[matched.asset.id]) {
        providerTouched[matched.asset.id] = true;
        await rememberProvider(supabase, userId, matched.asset);
      }

      var record = {
        user_id: userId,
        asset_id: Number(matched.asset.id),
        record_date: recordDate,
        operating_hours: operatingHoursFor(row),
        idle_hours: deereValue(row['Idle (h)']),
        litres_consumed: deereValue(row['Total Fuel (l)']),
        idle_fuel_litres: deereValue(row['Idle (l)']),
      };
      var workingFuel = workingFuelFor(row);
      if (workingFuel != null) record.working_fuel_litres = workingFuel;
      records.push(record);
    }

    var summary = importSummary(records.length, stageResult.staged, skippedEmpty, recordDate);
    if (records.length) {
      var upsertResult = await supabase
        .from('telematics_records')
        .upsert(records, { onConflict: 'asset_id,record_date' });
      if (upsertResult.error) {
        throw new Error('Failed to upsert John Deere records: ' + upsertResult.error.message);
      }
      try {
        var assetIds = [];
        records.forEach(function(record) {
          if (assetIds.indexOf(record.asset_id) === -1) assetIds.push(record.asset_id);
        });
        await idleRates.recomputeMeasuredIdleRates(supabase, userId, assetIds);
      } catch (rateErr) {
        console.warn(
          'john-deere: idle rate recompute failed: ' +
          (rateErr && rateErr.message ? rateErr.message : 'error')
        );
      }
    }

    await updateImportStatus(supabase, importId, 'processed', summary, 'john-deere');
    console.log('john-deere: ' + summary);
    return {
      ok: true,
      recordsUpserted: records.length,
      skippedEmpty: skippedEmpty,
      pendingStaged: stageResult.staged,
      pendingIgnored: stageResult.skippedIgnored,
      recordDate: recordDate,
      summary: summary,
    };
  } catch (err) {
    await updateImportStatus(supabase, importId, 'failed', err.message, 'john-deere');
    throw err;
  }
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function hostOnly(hostname) {
  return String(hostname || '').toLowerCase().replace(/\.+$/, '');
}

function isCloudfrontHost(hostname) {
  var host = hostOnly(hostname);
  return host.length > '.cloudfront.net'.length && host.endsWith('.cloudfront.net');
}

function acceptCloudfrontUrl(raw) {
  var trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  var parsed;
  try { parsed = new URL(trimmed); } catch (err) { return null; }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password || parsed.port) return null;
  if (!isCloudfrontHost(parsed.hostname)) return null;
  return parsed;
}

function reportCompleted(subject, html, text) {
  var blob = [subject, html, text].join('\n');
  return /Report Completed/i.test(blob);
}

function pushLink(found, seen, raw) {
  if (found.length >= MAX_LINKS) return;
  var parsed = acceptCloudfrontUrl(decodeHtmlEntities(raw));
  if (!parsed) return;
  if (seen[parsed.href]) return;
  seen[parsed.href] = true;
  found.push(parsed.href);
}

function linksFromHtml(html, found, seen) {
  var source = String(html || '');
  var anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  var match;
  while ((match = anchorRe.exec(source))) {
    var visible = stripTags(match[2]);
    if (visible.toLowerCase() !== 'csv') continue;
    var hrefMatch = match[1].match(/href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i);
    var href = hrefMatch ? (hrefMatch[1] || hrefMatch[2] || hrefMatch[3] || '') : '';
    pushLink(found, seen, href);
  }
}

function linksFromText(text, found, seen) {
  var lines = String(text || '').split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var match = lines[i].match(/^\s*(?:[-*•]\s*)?CSV\s*\(\s*(https:\/\/[^)\s]+)\s*\)\s*$/i);
    if (!match) continue;
    pushLink(found, seen, match[1]);
  }
}

function extractJohnDeereReportLinks(html, text, subject) {
  if (!reportCompleted(subject, html, text)) return [];
  var found = [];
  var seen = {};
  linksFromHtml(html, found, seen);
  linksFromText(text, found, seen);
  return found;
}

function scrubDeere(message) {
  return scrubLinkError(message).replace(/handle=[^\s&]*/gi, '');
}

function linkError(message, filename) {
  var err = new Error(scrubDeere(message));
  err.reportFilename = filename || DEFAULT_FILENAME;
  return err;
}

function assertRedirectTarget(raw, base) {
  var parsed;
  try { parsed = new URL(String(raw || ''), base); } catch (err) {
    throw linkError('redirect host not allowed');
  }
  var host = hostOnly(parsed.hostname);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port ||
      host !== JOHN_DEERE_REPORT_S3_HOST) {
    throw linkError('redirect host not allowed: ' + (host || parsed.hostname || 'unknown'));
  }
  return parsed;
}

function unexpectedBodyMessage(status, contentType, buffer) {
  var text = stripBom(buffer.toString('utf8'));
  var snippet = stripTags(text).slice(0, 200);
  var message = 'John Deere report link did not return a Utilization CSV' +
    '; HTTP ' + status +
    ' Content-Type ' + (contentType || '(none)') +
    ' bytes ' + buffer.length;
  if (snippet) message += '; ' + snippet;
  return message;
}

async function fetchJohnDeereReportFromLink(url, options) {
  var timeoutMs = TIMEOUT_MS;
  if (options && options.timeoutMs && options.timeoutMs < timeoutMs) timeoutMs = options.timeoutMs;
  var doFetch = (options && options.fetch) || global.fetch;
  var start = acceptCloudfrontUrl(url);
  if (!start) throw linkError('download link was not a John Deere report link');

  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, timeoutMs);
  try {
    var current = start;
    var redirects = 0;
    while (redirects <= MAX_REDIRECTS) {
      console.log('john-deere-link: fetch host ' + hostOnly(current.hostname));
      var response;
      try {
        response = await doFetch(current.href, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch (err) {
        if (err && err.name === 'AbortError') throw linkError('download timed out');
        throw linkError(err && err.message ? err.message : 'download failed');
      }

      if (isRedirectStatus(response.status)) {
        if (response.body && typeof response.body.cancel === 'function') {
          try { await response.body.cancel(); } catch (cancelErr) { /* already closed */ }
        }
        redirects += 1;
        if (redirects > MAX_REDIRECTS) throw linkError('too many redirects');
        var location = response.headers.get('location');
        if (!location) throw linkError('redirect had no location');
        current = assertRedirectTarget(location, current);
        continue;
      }

      var filename = filenameFromContentDisposition(response.headers.get('content-disposition')) || DEFAULT_FILENAME;
      if (response.status !== 200) {
        var failedBody = Buffer.alloc(0);
        try { failedBody = await readLimitedBody(response, MAX_BYTES, 'download exceeded 5 MB'); } catch (readErr) {
          throw linkError(readErr && readErr.message ? readErr.message : 'download failed', filename);
        }
        throw linkError(
          unexpectedBodyMessage(response.status, mediaTypeOf(response), failedBody),
          filename
        );
      }

      var buffer = await readLimitedBody(response, MAX_BYTES, 'download exceeded 5 MB');
      var rawCsv = stripBom(buffer.toString('utf8'));
      if (!isJohnDeereUtilizationCsv(rawCsv)) {
        throw linkError(
          unexpectedBodyMessage(response.status, mediaTypeOf(response), buffer),
          filename
        );
      }
      console.log('john-deere-link: final host ' + hostOnly(current.hostname));
      return {
        filename: filename,
        buffer: Buffer.from(rawCsv, 'utf8'),
        mimeType: 'text/csv',
      };
    }
    throw linkError('too many redirects');
  } catch (err) {
    if (err && err.name === 'AbortError') throw linkError('download timed out');
    if (err && Object.prototype.hasOwnProperty.call(err, 'reportFilename')) throw err;
    throw linkError(err && err.message ? err.message : 'download failed');
  } finally {
    clearTimeout(timer);
  }
}

function johnDeereLinkFailureMessage(reason) {
  return 'John Deere download link could not be fetched: ' + scrubDeere(reason) + LINK_FAILURE_SUFFIX;
}

module.exports = {
  isJohnDeereUtilizationCsv: isJohnDeereUtilizationCsv,
  parseJohnDeereUtilizationReport: parseJohnDeereUtilizationReport,
  parseJohnDeereRows: parseJohnDeereRows,
  parseJohnDeereDate: parseJohnDeereDate,
  parseJohnDeereTime: parseJohnDeereTime,
  extractJohnDeereReportLinks: extractJohnDeereReportLinks,
  fetchJohnDeereReportFromLink: fetchJohnDeereReportFromLink,
  johnDeereLinkFailureMessage: johnDeereLinkFailureMessage,
  johnDeereAssetType: johnDeereAssetType,
  nicknameHead: nicknameHead,
  JOHN_DEERE_REPORT_S3_HOST: JOHN_DEERE_REPORT_S3_HOST,
  DEFAULT_FILENAME: DEFAULT_FILENAME,
  SIGNATURE: SIGNATURE,
};
