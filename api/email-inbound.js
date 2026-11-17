/**
 * SendGrid Inbound Parse webhook — receives OEM telematics CSV attachments
 * sent to per-user upload addresses (e.g. monro-a3x9@uploads.fleetmagnify.com).
 */
const crypto = require('crypto');
const Busboy = require('busboy');
const { createClient } = require('@supabase/supabase-js');
const { isNavmanCsv, parseNavmanReport } = require('../parsers/navman');
const { isBpCsv, parseBpReport } = require('../parsers/bp');
const { isBpTransactionCsv, parseBpTransactionReport } = require('../parsers/bp-transaction');
const { isMobilCsv, parseMobilReport } = require('../parsers/mobil');
const { isNavmanMileageCsv, parseNavmanMileageReport } = require('../parsers/navman-mileage');
const { isNavmanIdleCsv, parseNavmanIdleReport } = require('../parsers/navman-idle');
const { isVisionLinkCsv, parseVisionLinkReport } = require('../parsers/visionlink');
const { isVisionLinkFuelCsv, parseVisionLinkFuelReport } = require('../parsers/visionlink-fuel');
const { isEroadCsv, parseEroadReport } = require('../parsers/eroad');
const { isJohnDeereUtilizationCsv, parseJohnDeereUtilizationReport, extractJohnDeereReportLinks, fetchJohnDeereReportFromLink, johnDeereLinkFailureMessage } = require('../parsers/john-deere-utilization');
const {
  extractVisionLinkReportLinks,
  fetchReportFromLink,
  scrubLinkError,
} = require('../parsers/email-report-link');
const escapeHtml = require('../lib/escape-html');
const knownSenders = require('../lib/known-senders');
const missingFeedAlert = require('../lib/missing-feed-alert');

function classifyUnknownCsv(rawCsv) {
  var lines = String(rawCsv).split(/\r?\n/);
  var headerLine = '';
  var scanText = '';
  var nonEmpty = 0;
  for (var i = 0; i < Math.min(lines.length, 30); i++) {
    if (lines[i] && lines[i].trim()) {
      if (!headerLine) headerLine = lines[i];
      scanText += ' ' + lines[i].toLowerCase();
      nonEmpty++;
      // eROAD puts a title on row 1 and headers on row 2 — scan both
      if (nonEmpty >= 3) break;
    }
  }
  var headerLower = (scanText || headerLine).toLowerCase();

  var categories = {
    on_road_telematics: [
      'mileage', 'odometer', 'distance', 'trip', 'idle',
      // eROAD Fleet Summary Report (title often on row 1, headers on row 2)
      'eroad fleet summary', 'ehubo', 'ruc purchased', 'total idle time', 'rego/plate',
    ],
    fuel_provider: ['litres', 'card number', 'fuel', 'customer value', 'transaction'],
    oem_machinery_telematics: [
      'productive', 'idle fuel', 'operating fuel', 'engine hours', 'machine',
      // VisionLink Fleet Utilisation exports
      'hour meter', 'total fuel burned', 'working time', 'asset serial number',
      'timezone display name', 'runtime (hours)',
    ],
  };

  var bestCategory = 'unknown';
  var bestScore = 0;

  for (var cat in categories) {
    var score = 0;
    var keywords = categories[cat];
    for (var k = 0; k < keywords.length; k++) {
      if (headerLower.indexOf(keywords[k]) !== -1) {
        score++;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestCategory = cat;
    }
  }

  var detectedCategory = bestScore >= 2 ? bestCategory : 'unknown';

  return { detectedCategory: detectedCategory, headerLine: headerLine };
}

const SUPABASE_URL =
  process.env.SUPABASE_URL || 'https://pddsgvuzvuwueuvpoytw.supabase.co';

function extractEmailAddress(raw) {
  return knownSenders.extractEmailAddress(raw);
}

function extractLocalPart(email) {
  var at = email.indexOf('@');
  return at === -1 ? email : email.slice(0, at);
}

function isCsvAttachment(filename, mimeType) {
  var name = (filename || '').toLowerCase();
  if (name.endsWith('.csv')) return true;
  var mime = (mimeType || '').toLowerCase();
  return mime === 'text/csv' || mime === 'application/csv' || mime === 'text/comma-separated-values';
}

function isXlsAttachment(filename, mimeType) {
  var name = (filename || '').toLowerCase();
  if (/\.xlsx?$/.test(name)) return true;
  var mime = (mimeType || '').toLowerCase();
  return mime === 'application/vnd.ms-excel' ||
    mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
}

function parseMultipart(req) {
  return new Promise(function (resolve, reject) {
    var fields = {};
    var files = [];

    var busboy = Busboy({ headers: req.headers });

    busboy.on('file', function (fieldname, file, info) {
      var filename = info.filename;
      var mimeType = info.mimeType;
      var chunks = [];

      file.on('data', function (chunk) {
        chunks.push(chunk);
      });

      file.on('end', function () {
        files.push({
          fieldname: fieldname,
          filename: filename,
          mimeType: mimeType,
          buffer: Buffer.concat(chunks),
        });
      });
    });

    busboy.on('field', function (name, val) {
      if (fields[name]) {
        if (Array.isArray(fields[name])) {
          fields[name].push(val);
        } else {
          fields[name] = [fields[name], val];
        }
      } else {
        fields[name] = val;
      }
    });

    busboy.on('finish', function () {
      resolve({ fields: fields, files: files });
    });

    busboy.on('error', reject);
    req.pipe(busboy);
  });
}

function getField(fields, name) {
  var val = fields[name];
  if (Array.isArray(val)) return val[0];
  return val || '';
}

var EMAIL_SUBJECT_LIMIT = 200;
var EMAIL_BODY_LIMIT = 20000;

function subjectAsFilename(subject) {
  var text = String(subject == null ? '' : subject).trim();
  if (!text) return '(no subject)';
  if (text.length > EMAIL_SUBJECT_LIMIT) return text.slice(0, EMAIL_SUBJECT_LIMIT);
  return text;
}

function stripHtmlToText(html) {
  var source = String(html || '');
  source = source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ');
  source = source.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
  source = source.replace(/<[^>]+>/g, ' ');
  source = source
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
  return source.replace(/\s+/g, ' ').trim();
}

function emailBodyForStorage(fields) {
  var plain = String(getField(fields, 'text') || '');
  var body = plain.trim() ? plain : stripHtmlToText(getField(fields, 'html'));
  if (!body) return '';
  if (body.length > EMAIL_BODY_LIMIT) return body.slice(0, EMAIL_BODY_LIMIT);
  return body;
}

var RECIPIENT_CAP = 10;

function splitAddressList(raw) {
  if (!raw) return [];
  var parts = [];
  var current = '';
  var inQuote = false;
  var inAngle = false;
  var text = String(raw);
  for (var i = 0; i < text.length; i++) {
    var ch = text.charAt(i);
    if (ch === '"' && !inAngle) {
      inQuote = !inQuote;
      current += ch;
      continue;
    }
    if (ch === '<' && !inQuote) {
      inAngle = true;
      current += ch;
      continue;
    }
    if (ch === '>' && !inQuote) {
      inAngle = false;
      current += ch;
      continue;
    }
    if (ch === ',' && !inQuote && !inAngle) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) parts.push(current);
  var out = [];
  for (var p = 0; p < parts.length; p++) {
    var addr = extractEmailAddress(parts[p]);
    if (addr && addr.indexOf('@') !== -1) out.push(addr);
  }
  return out;
}

function envelopeRecipients(fields) {
  var envelopeRaw = getField(fields, 'envelope');
  if (!envelopeRaw) return [];
  try {
    var envelope = JSON.parse(envelopeRaw);
    var list = envelope && envelope.to;
    if (!Array.isArray(list)) return [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      if (typeof list[i] !== 'string') continue;
      var addr = extractEmailAddress(list[i]);
      if (addr && addr.indexOf('@') !== -1) out.push(addr);
    }
    return out;
  } catch (err) {
    console.warn('email-inbound: could not parse envelope field', err.message);
    return [];
  }
}

function candidateRecipients(fields) {
  var ordered = envelopeRecipients(fields).concat(splitAddressList(getField(fields, 'to')));
  var seen = {};
  var out = [];
  for (var i = 0; i < ordered.length; i++) {
    var addr = ordered[i];
    if (seen[addr]) continue;
    seen[addr] = true;
    out.push(addr);
    if (out.length >= RECIPIENT_CAP) break;
  }
  return out;
}

function createSupabaseClient() {
  var serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
  }

  return createClient(SUPABASE_URL, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function sendFailureAlert(filename, errorMessage, userId) {
  var apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'alerts@fleetmagnify.com',
        to: 'fleetmagnify@gmail.com',
        subject: '⚠️ FleetMagnify Import Failed: ' + (filename || 'unknown file'),
        html: '<p><strong>Import failed</strong></p>' +
          '<p><strong>File:</strong> ' + escapeHtml(filename || 'unknown') + '</p>' +
          '<p><strong>Error:</strong> ' + escapeHtml(errorMessage) + '</p>' +
          '<p><strong>User ID:</strong> ' + escapeHtml(userId) + '</p>' +
          '<p>Check the email_imports table in Supabase for details.</p>'
      })
    });
  } catch (alertErr) {
    console.error('email-inbound: failed to send alert email', alertErr.message);
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

function requestPath(req) {
  var raw = req && req.url ? String(req.url) : '';
  try {
    return new URL(raw, 'http://localhost').pathname || '/api/email-inbound';
  } catch (err) {
    var q = raw.indexOf('?');
    return (q === -1 ? raw : raw.slice(0, q)) || '/api/email-inbound';
  }
}

// SendGrid Inbound Parse destination:
//   https://<host>/api/email-inbound?token=<secret>
// Rotate the secret by changing the Vercel env var INBOUND_WEBHOOK_SECRET
// and the token query parameter in the SendGrid destination URL together.
// If INBOUND_WEBHOOK_SECRET is unset or empty, this refuses the request.
// It does not accept unauthenticated mail.
//
// Only known report senders are imported. Built-in provider domains live in
// lib/known-senders.js. INBOUND_EXTRA_SENDERS is a comma-separated list of
// extra exact addresses (name@example.test) or bare domains (example.test).
// A sender that is not on either list is stored on email_imports with status
// held_unapproved and error_message "sender not approved", and is not parsed.
// After that sender is allowed, scripts/reprocess-held-imports.js can import
// the stored file. No real addresses belong in this file.
function authorizeInbound(req, res) {
  var secret = process.env.INBOUND_WEBHOOK_SECRET;
  if (typeof secret !== 'string' || secret.trim() === '') {
    console.warn('email-inbound: INBOUND_WEBHOOK_SECRET is not set; refusing the request');
    res.status(503).json({ error: 'Inbound webhook is not configured' });
    return false;
  }
  var token = req && req.query ? req.query.token : '';
  // Hash both sides first so timingSafeEqual always sees equal-length buffers.
  var provided = typeof token === 'string' ? token : '';
  if (!crypto.timingSafeEqual(sha256(provided), sha256(secret))) {
    console.warn('email-inbound: rejected unauthenticated request ' + requestPath(req));
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

function oneLine(value) {
  return String(value || '').replace(/[\r\n]/g, ' ');
}

function reportFiles(files) {
  return (files || []).filter(function (f) {
    return isCsvAttachment(f.filename, f.mimeType) || isXlsAttachment(f.filename, f.mimeType);
  });
}

function storedReport(attachment) {
  var isXls = isXlsAttachment(attachment.filename, attachment.mimeType);
  var rawCsv = isXls ? '' : attachment.buffer.toString('utf8');
  var storedRaw = isXls ? ('BASE64_XLS:' + attachment.buffer.toString('base64')) : rawCsv;
  return {
    isXls: isXls,
    rawCsv: rawCsv,
    storedRaw: storedRaw,
    filename: attachment.filename || null,
    buffer: attachment.buffer,
  };
}

async function importSavedAttachment(supabase, spec) {
  var isXls = spec.isXls;
  var rawCsv = spec.rawCsv;
  var userId = spec.userId;
  var importId = spec.importId;
  var filename = spec.filename;
  var receivedAt = spec.receivedAt;
  var buffer = spec.buffer;

  if (isXls) {
    try {
      var bpXlsResult = await parseBpTransactionReport(supabase, {
        userId: userId,
        importId: importId,
        fileBuffer: buffer,
      });
      console.log(
        'email-inbound: BP transaction (XLS) parse complete',
        filename,
        bpXlsResult.recordsUpserted + ' purchases'
      );
    } catch (bpXlsErr) {
      console.error(
        'email-inbound: BP transaction (XLS) parse failed',
        filename,
        bpXlsErr.message
      );
      await sendFailureAlert(filename, bpXlsErr.message, userId);
    }
  } else if (isNavmanCsv(rawCsv)) {
    try {
      var parseResult = await parseNavmanReport(supabase, {
        userId: userId,
        importId: importId,
        rawCsv: rawCsv,
        filename: filename,
        receivedAt: receivedAt,
      });
      console.log(
        'email-inbound: Navman parse complete',
        filename,
        parseResult.recordsUpserted + ' records,',
        parseResult.assetsCreated + ' assets created'
      );
    } catch (parseErr) {
      console.error(
        'email-inbound: Navman parse failed',
        filename,
        parseErr.message
      );
      await sendFailureAlert(filename, parseErr.message, userId);
    }
  } else if (isBpTransactionCsv(rawCsv)) {
    try {
      var bpTransactionResult = await parseBpTransactionReport(supabase, {
        userId: userId,
        importId: importId,
        rawCsv: rawCsv,
      });
      console.log(
        'email-inbound: BP transaction parse complete',
        filename,
        bpTransactionResult.recordsUpserted + ' purchases'
      );
    } catch (bpTransactionErr) {
      console.error(
        'email-inbound: BP transaction parse failed',
        filename,
        bpTransactionErr.message
      );
      await sendFailureAlert(filename, bpTransactionErr.message, userId);
    }
  } else if (isBpCsv(rawCsv)) {
    try {
      var bpResult = await parseBpReport(supabase, {
        userId: userId,
        importId: importId,
        rawCsv: rawCsv,
      });
      console.log(
        'email-inbound: BP parse complete',
        filename,
        bpResult.recordsUpserted + ' purchases,',
        bpResult.assetsCreated + ' assets created'
      );
    } catch (bpErr) {
      console.error(
        'email-inbound: BP parse failed',
        filename,
        bpErr.message
      );
      await sendFailureAlert(filename, bpErr.message, userId);
    }
  } else if (isMobilCsv(rawCsv)) {
    try {
      var mobilResult = await parseMobilReport(supabase, {
        userId: userId,
        importId: importId,
        rawCsv: rawCsv,
      });
      console.log(
        'email-inbound: Mobil parse complete',
        filename,
        mobilResult.recordsUpserted + ' purchases'
      );
    } catch (mobilErr) {
      console.error(
        'email-inbound: Mobil parse failed',
        filename,
        mobilErr.message
      );
      await sendFailureAlert(filename, mobilErr.message, userId);
    }
  } else if (isNavmanMileageCsv(rawCsv)) {
    try {
      // A header-only mileage export returns processed with
      // recordsUpserted 0 and does not throw, so this catch must not
      // send a failure email for it.
      var mileageResult = await parseNavmanMileageReport(supabase, {
        userId: userId,
        importId: importId,
        rawCsv: rawCsv,
      });
      console.log(
        'email-inbound: Navman mileage parse complete',
        filename,
        mileageResult.recordsUpserted + ' records,',
        mileageResult.pendingAdded + ' pending assets added'
      );
    } catch (mileageErr) {
      console.error(
        'email-inbound: Navman mileage parse failed',
        filename,
        mileageErr.message
      );
      await sendFailureAlert(filename, mileageErr.message, userId);
    }
  } else if (isNavmanIdleCsv(rawCsv)) {
    try {
      // Header-only exports, and files whose events are all Duration 0,
      // return processed with recordsUpserted 0 and do not throw.
      // This catch is only for real failures, so those must not alert.
      var idleResult = await parseNavmanIdleReport(supabase, {
        userId: userId,
        importId: importId,
        rawCsv: rawCsv,
      });
      console.log(
        'email-inbound: Navman idle parse complete',
        filename,
        idleResult.recordsUpserted + ' records,',
        idleResult.pendingAdded + ' pending assets added'
      );
    } catch (idleErr) {
      console.error(
        'email-inbound: Navman idle parse failed',
        filename,
        idleErr.message
      );
      await sendFailureAlert(filename, idleErr.message, userId);
    }
  } else if (isVisionLinkFuelCsv(rawCsv)) {
    try {
      var visionFuelResult = await parseVisionLinkFuelReport(supabase, {
        userId: userId,
        importId: importId,
        rawCsv: rawCsv,
        filename: filename,
        receivedAt: receivedAt,
      });
      console.log(
        'email-inbound: VisionLink Fleet Fuel parse complete',
        filename,
        visionFuelResult.recordsUpserted + ' records,',
        visionFuelResult.skippedNoSplit + ' without fuel split skipped,',
        visionFuelResult.unmatched + ' unmatched,',
        'date=' + visionFuelResult.recordDate
      );
    } catch (visionFuelErr) {
      console.error(
        'email-inbound: VisionLink Fleet Fuel parse failed',
        filename,
        visionFuelErr.message
      );
      await sendFailureAlert(filename, visionFuelErr.message, userId);
    }
  } else if (isVisionLinkCsv(rawCsv)) {
    try {
      var visionResult = await parseVisionLinkReport(supabase, {
        userId: userId,
        importId: importId,
        rawCsv: rawCsv,
        filename: filename,
        receivedAt: receivedAt,
      });
      console.log(
        'email-inbound: VisionLink parse complete',
        filename,
        visionResult.recordsUpserted + ' records,',
        visionResult.skippedEmpty + ' empty skipped,',
        visionResult.unmatched + ' unmatched,',
        visionResult.hoursUpdated + ' hour meters updated'
      );
    } catch (visionErr) {
      console.error(
        'email-inbound: VisionLink parse failed',
        filename,
        visionErr.message
      );
      await sendFailureAlert(filename, visionErr.message, userId);
    }
  } else if (isJohnDeereUtilizationCsv(rawCsv)) {
    try {
      var deereResult = await parseJohnDeereUtilizationReport(supabase, {
        userId: userId,
        importId: importId,
        rawCsv: rawCsv,
        filename: filename,
        receivedAt: receivedAt,
      });
      console.log(
        'email-inbound: John Deere Utilization parse complete',
        filename,
        deereResult.summary
      );
    } catch (deereErr) {
      console.error(
        'email-inbound: John Deere Utilization parse failed',
        filename,
        deereErr.message
      );
      await sendFailureAlert(filename, deereErr.message, userId);
    }
  } else if (isEroadCsv(rawCsv)) {
    try {
      var eroadResult = await parseEroadReport(supabase, {
        userId: userId,
        importId: importId,
        rawCsv: rawCsv,
        filename: filename,
        receivedAt: receivedAt,
      });
      console.log(
        'email-inbound: eROAD parse complete',
        filename,
        eroadResult.recordsUpserted + ' records,',
        eroadResult.unmatched + ' unmatched,',
        eroadResult.odometerUpdated + ' odometers updated,',
        'date=' + eroadResult.recordDate
      );
    } catch (eroadErr) {
      console.error(
        'email-inbound: eROAD parse failed',
        filename,
        eroadErr.message
      );
      await sendFailureAlert(filename, eroadErr.message, userId);
    }
  } else {
    var classification = classifyUnknownCsv(rawCsv);
    var updateResult = await supabase
      .from('email_imports')
      .update({
        status: 'unrecognized',
        detected_category: classification.detectedCategory,
        detected_headers: classification.headerLine,
      })
      .eq('id', importId);
    if (updateResult.error) {
      console.error(
        'email-inbound: failed to mark import as unrecognized',
        filename,
        updateResult.error.message
      );
    }
    console.log(
      'email-inbound: unrecognized CSV format',
      filename,
      'classified as',
      classification.detectedCategory
    );
  }
}

function holdNoticeHtml(fromEmail, filenames, userId) {
  var fileLabel = filenames.length ? filenames.join(', ') : '(no file)';
  return '<p><strong>Inbound report held</strong></p>' +
    '<p><strong>Sender:</strong> ' + escapeHtml(fromEmail || '') + '</p>' +
    '<p><strong>File:</strong> ' + escapeHtml(fileLabel) + '</p>' +
    '<p><strong>User ID:</strong> ' + escapeHtml(userId) + '</p>' +
    '<p>' + escapeHtml('held because the sender is not allowed; add it to INBOUND_EXTRA_SENDERS or to lib/known-senders.js if it is real') + '</p>';
}

async function sendHoldNotice(fromEmail, filenames, userId) {
  var apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: missingFeedAlert.ALERT_FROM,
        to: missingFeedAlert.ALERT_TO,
        subject: 'FleetMagnify held an inbound report',
        html: holdNoticeHtml(fromEmail, filenames, userId)
      })
    });
  } catch (err) {
    console.error('email-inbound: held-sender notice failed', err && err.message ? err.message : err);
  }
}

async function priorHeldSender(supabase, fromEmail, receivedAt, insertedIds) {
  var receivedMs = new Date(receivedAt).getTime();
  if (isNaN(receivedMs)) receivedMs = Date.now();
  var since = new Date(receivedMs - 24 * 60 * 60 * 1000).toISOString();
  var query = supabase.from('email_imports').select('id');
  if (fromEmail) query = query.eq('from_email', fromEmail);
  else query = query.is('from_email', null);
  var result = await query.eq('status', 'held_unapproved').gte('received_at', since);
  if (!result || result.error) {
    var message = result && result.error && result.error.message ? result.error.message : 'notice check failed';
    return { error: message };
  }
  var rows = result.data || [];
  for (var i = 0; i < rows.length; i++) {
    var id = rows[i] && rows[i].id;
    if (id && !insertedIds[id]) return { found: true };
  }
  return { found: false };
}

async function holdUnapprovedSender(supabase, input) {
  var reports = reportFiles(input.files);
  var stored = [];
  if (!reports.length) {
    stored.push({
      filename: subjectAsFilename(getField(input.fields, 'subject')),
      raw_csv: emailBodyForStorage(input.fields),
    });
  } else {
    reports.forEach(function (attachment) {
      var report = storedReport(attachment);
      stored.push({ filename: report.filename, raw_csv: report.storedRaw });
    });
  }

  var insertedIds = {};
  var filenames = [];
  for (var i = 0; i < stored.length; i++) {
    var item = stored[i];
    filenames.push(item.filename || '(no file)');
    try {
      var saved = await supabase.from('email_imports').insert({
        user_id: input.userId,
        received_at: input.receivedAt,
        from_email: input.fromEmail || null,
        to_email: input.toEmail,
        filename: item.filename,
        raw_csv: item.raw_csv,
        status: 'held_unapproved',
        error_message: 'sender not approved',
      }).select('id').single();
      if (saved.error) {
        console.error('email-inbound: failed to hold unapproved sender', saved.error.message);
        continue;
      }
      if (saved.data && saved.data.id) insertedIds[saved.data.id] = true;
    } catch (saveErr) {
      console.error('email-inbound: failed to hold unapproved sender', saveErr.message);
    }
  }

  if (!Object.keys(insertedIds).length) return;

  try {
    var prior = await priorHeldSender(supabase, input.fromEmail, input.receivedAt, insertedIds);
    if (prior.error) {
      console.error('email-inbound: held-sender notice check failed', prior.error);
      return;
    }
    if (prior.found) return;
  } catch (checkErr) {
    console.error('email-inbound: held-sender notice check failed', checkErr && checkErr.message ? checkErr.message : checkErr);
    return;
  }

  await sendHoldNotice(input.fromEmail, filenames, input.userId);
}

async function processInboundEmail(supabase, input) {
  var receivedAt = input.receivedAt;
  var fields = input.fields || {};
  var files = input.files || [];

  try {
    var candidates = candidateRecipients(fields);
    var fromEmail = extractEmailAddress(getField(fields, 'from'));

    if (!candidates.length) {
      console.error('email-inbound: missing to address in webhook payload');
      return { ok: true, message: 'Received — no to address' };
    }

    if (!supabase) supabase = createSupabaseClient();

    var matched = null;
    for (var c = 0; c < candidates.length; c++) {
      var candidate = candidates[c];
      var uploadPrefix = extractLocalPart(candidate);
      var lookup = await supabase
        .from('user_settings')
        .select('user_id, upload_email')
        .eq('upload_email', uploadPrefix)
        .maybeSingle();

      if (lookup.error) {
        console.error('email-inbound: user lookup failed', lookup.error.message);
        return { ok: true, message: 'Received — user lookup error logged' };
      }

      if (lookup.data) {
        matched = { toEmail: candidate, user: lookup.data };
        break;
      }
    }

    if (!matched) {
      console.error(
        'email-inbound: no user_settings row for upload_email prefix',
        extractLocalPart(candidates[0])
      );
      return { ok: true, message: 'Received — unknown upload address' };
    }

    var toEmail = matched.toEmail;
    var userResult = { data: matched.user };
    console.log('email-inbound: received mail for', toEmail, 'from', fromEmail || '(unknown)');

    var senderAllowed = false;
    try {
      senderAllowed = knownSenders.isAllowedSender(fromEmail, process.env) === true;
    } catch (allowErr) {
      console.error(
        'email-inbound: sender check failed',
        allowErr && allowErr.message ? allowErr.message : allowErr
      );
      senderAllowed = false;
    }
    if (!senderAllowed) {
      try {
        await holdUnapprovedSender(supabase, {
          userId: userResult.data.user_id,
          toEmail: toEmail,
          fromEmail: fromEmail,
          receivedAt: receivedAt,
          fields: fields,
          files: files,
        });
      } catch (holdErr) {
        console.error(
          'email-inbound: hold failed',
          holdErr && holdErr.message ? holdErr.message : holdErr
        );
      }
      return { ok: true, message: 'Received' };
    }

    console.log(
      'email-inbound: accepted sender domain ' + knownSenders.senderDomain(fromEmail) +
      ' spf=' + oneLine(getField(fields, 'SPF')) +
      ' dkim=' + oneLine(getField(fields, 'dkim'))
    );

    // Now includes XLS/XLSX attachments alongside CSV — BP is the only
    // provider currently known to send XLS (see bp-transaction.js /
    // bulk-import.js for the same XLS-via-SheetJS pattern already proven
    // there). Variable name kept as csvFiles to minimize diff footprint
    // elsewhere in this file, even though it now covers both formats.
    var csvFiles = files.filter(function (f) {
      return isCsvAttachment(f.filename, f.mimeType) || isXlsAttachment(f.filename, f.mimeType);
    });

    if (csvFiles.length === 0) {
      var reportLinks = extractVisionLinkReportLinks(getField(fields, 'html'), getField(fields, 'text'));
      if (!reportLinks.length) {
        var deereLinks = extractJohnDeereReportLinks(
          getField(fields, 'html'),
          getField(fields, 'text'),
          getField(fields, 'subject')
        );
        if (deereLinks.length) {
          console.log('email-inbound: fetching', deereLinks.length, 'John Deere report link(s)');
          for (var deereIndex = 0; deereIndex < deereLinks.length; deereIndex++) {
            try {
              var deereFile = await fetchJohnDeereReportFromLink(deereLinks[deereIndex]);
              csvFiles.push({
                filename: deereFile.filename,
                mimeType: deereFile.mimeType,
                buffer: deereFile.buffer,
              });
            } catch (deereLinkErr) {
              var deereFailName = (deereLinkErr && deereLinkErr.reportFilename) || 'John-Deere-Utilization.csv';
              var deereReason = scrubLinkError(deereLinkErr && deereLinkErr.message);
              var deereError = johnDeereLinkFailureMessage(deereReason);
              console.error('email-inbound: John Deere download link failed', deereReason);
              var deereFailInsert = await supabase.from('email_imports').insert({
                user_id: userResult.data.user_id,
                received_at: receivedAt,
                from_email: fromEmail || null,
                to_email: toEmail,
                filename: deereFailName,
                raw_csv: '',
                status: 'failed',
                error_message: deereError,
              }).select('id').single();
              if (deereFailInsert.error) {
                console.error('email-inbound: failed to record John Deere link failure', deereFailInsert.error.message);
              }
              await sendFailureAlert(deereFailName, deereError, userResult.data.user_id);
            }
          }
          if (csvFiles.length === 0) {
            return {
              ok: true,
              message: 'Received',
              saved: [],
              user_id: userResult.data.user_id,
            };
          }
        } else {
          console.warn('email-inbound: no CSV attachments for', toEmail);
          // Not a failed import. Save the message so a sign-in code, a
          // forwarding confirmation, or an unparsed report can be read later.
          // status is no_attachment, so nothing that scans pending or failed
          // rows will parse it. No alert.
          try {
            var savedMail = await supabase.from('email_imports').insert({
              user_id: userResult.data.user_id,
              received_at: receivedAt,
              from_email: fromEmail || null,
              to_email: toEmail,
              filename: subjectAsFilename(getField(fields, 'subject')),
              raw_csv: emailBodyForStorage(fields),
              status: 'no_attachment',
              error_message: 'No CSV attachment or report link; email saved for review',
            }).select('id').single();
            if (savedMail.error) {
              console.error('email-inbound: failed to save email with no attachment', savedMail.error.message);
            }
          } catch (saveErr) {
            console.error('email-inbound: failed to save email with no attachment', saveErr.message);
          }
          return { ok: true, message: 'Received — no CSV attachments' };
        }
      } else {
        console.log('email-inbound: fetching', reportLinks.length, 'VisionLink report link(s)');
        for (var linkIndex = 0; linkIndex < reportLinks.length; linkIndex++) {
          try {
            var downloaded = await fetchReportFromLink(reportLinks[linkIndex]);
            csvFiles.push({
              filename: downloaded.filename,
              mimeType: downloaded.mimeType,
              buffer: downloaded.buffer,
            });
          } catch (linkErr) {
            var failName = (linkErr && linkErr.reportFilename) || 'VisionLink report link';
            var reason = scrubLinkError(linkErr && linkErr.message);
            var errorMessage = 'VisionLink download link could not be fetched: ' + reason +
              '; try Download Report manually and email the file';
            console.error('email-inbound: VisionLink download link failed', reason);
            var failInsert = await supabase.from('email_imports').insert({
              user_id: userResult.data.user_id,
              received_at: receivedAt,
              from_email: fromEmail || null,
              to_email: toEmail,
              filename: failName,
              raw_csv: '',
              status: 'failed',
              error_message: errorMessage,
            }).select('id').single();
            if (failInsert.error) {
              console.error('email-inbound: failed to record link failure', failInsert.error.message);
            }
            await sendFailureAlert(failName, errorMessage, userResult.data.user_id);
          }
        }
        if (csvFiles.length === 0) {
          return {
            ok: true,
            message: 'Received',
            saved: [],
            user_id: userResult.data.user_id,
          };
        }
      }
    }

    var saved = [];

    for (var i = 0; i < csvFiles.length; i++) {
      var attachment = csvFiles[i];
      var isXls = isXlsAttachment(attachment.filename, attachment.mimeType);
      // XLS is binary — decoding it as utf8 text would produce corrupted
      // garbage, not something anyone could inspect later. Store the
      // actual original bytes as base64 instead, tagged with a prefix so
      // it's clearly distinguishable from plain-text CSV content when
      // browsing email_imports directly. This preserves the same "go back
      // and inspect exactly what arrived" audit trail CSV imports already
      // have.
      var rawCsv = isXls ? '' : attachment.buffer.toString('utf8');
      var storedRaw = isXls ? ('BASE64_XLS:' + attachment.buffer.toString('base64')) : rawCsv;

      var insertResult = await supabase.from('email_imports').insert({
        user_id: userResult.data.user_id,
        received_at: receivedAt,
        from_email: fromEmail || null,
        to_email: toEmail,
        filename: attachment.filename || null,
        raw_csv: storedRaw,
        status: 'pending',
      }).select('id').single();

      if (insertResult.error) {
        console.error(
          'email-inbound: failed to save import',
          attachment.filename,
          insertResult.error.message
        );
        continue;
      }

      var importId = insertResult.data.id;

      await importSavedAttachment(supabase, {
        userId: userResult.data.user_id,
        importId: importId,
        filename: attachment.filename || null,
        rawCsv: rawCsv,
        buffer: attachment.buffer,
        isXls: isXls,
        receivedAt: receivedAt,
      });

      saved.push(attachment.filename || ('attachment-' + (i + 1)));
      console.log('email-inbound: saved CSV import', attachment.filename, 'for user', userResult.data.user_id);
    }

    return {
      ok: true,
      message: 'Received',
      saved: saved,
      user_id: userResult.data.user_id,
    };
  } catch (err) {
    console.error('email-inbound: unhandled error', err.message, err.stack);
    return { ok: true, message: 'Received — error logged' };
  }
}

async function handler(req, res) {
  if (!authorizeInbound(req, res)) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var receivedAt = new Date().toISOString();

  try {
    var parsed = await parseMultipart(req);
    var result = await processInboundEmail(null, {
      fields: parsed.fields,
      files: parsed.files,
      receivedAt: receivedAt,
    });
    return res.status(200).json(result);
  } catch (err) {
    console.error('email-inbound: unhandled error', err.message, err.stack);
    return res.status(200).json({ ok: true, message: 'Received — error logged' });
  }
}

module.exports = handler;
module.exports.processInboundEmail = processInboundEmail;
module.exports.importSavedAttachment = importSavedAttachment;
module.exports.sendFailureAlert = sendFailureAlert;

module.exports.config = {
  api: {
    bodyParser: false,
  },
};
