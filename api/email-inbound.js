/**
 * SendGrid Inbound Parse webhook — receives OEM telematics CSV attachments
 * sent to per-user upload addresses (e.g. monro-a3x9@uploads.fleetmagnify.com).
 */
const Busboy = require('busboy');
const { createClient } = require('@supabase/supabase-js');
const { isNavmanCsv, parseNavmanReport } = require('./parsers/navman');
const { isBpCsv, parseBpReport } = require('./parsers/bp');

function classifyUnknownCsv(rawCsv) {
  var lines = String(rawCsv).split(/\r?\n/);
  var headerLine = '';
  for (var i = 0; i < Math.min(lines.length, 30); i++) {
    if (lines[i] && lines[i].trim()) {
      headerLine = lines[i];
      break;
    }
  }
  var headerLower = headerLine.toLowerCase();

  var categories = {
    on_road_telematics: ['mileage', 'odometer', 'distance', 'trip', 'idle'],
    fuel_provider: ['litres', 'card number', 'fuel', 'customer value', 'transaction'],
    oem_machinery_telematics: ['productive', 'idle fuel', 'operating fuel', 'engine hours', 'machine'],
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
  if (!raw) return '';
  var str = String(raw).trim();
  var match = str.match(/<([^>]+)>/);
  return (match ? match[1] : str).trim().toLowerCase();
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

function resolveToEmail(fields) {
  var to = getField(fields, 'to');
  if (!to) {
    var envelopeRaw = getField(fields, 'envelope');
    if (envelopeRaw) {
      try {
        var envelope = JSON.parse(envelopeRaw);
        if (envelope.to && envelope.to.length) {
          to = envelope.to[0];
        }
      } catch (err) {
        console.warn('email-inbound: could not parse envelope field', err.message);
      }
    }
  }
  return extractEmailAddress(to);
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
        from: 'onboarding@resend.dev',
        to: 'fleetmagnify@gmail.com',
        subject: '⚠️ FleetMagnify Import Failed: ' + (filename || 'unknown file'),
        html: '<p><strong>Import failed</strong></p>' +
          '<p><strong>File:</strong> ' + (filename || 'unknown') + '</p>' +
          '<p><strong>Error:</strong> ' + errorMessage + '</p>' +
          '<p><strong>User ID:</strong> ' + userId + '</p>' +
          '<p>Check the email_imports table in Supabase for details.</p>'
      })
    });
  } catch (alertErr) {
    console.error('email-inbound: failed to send alert email', alertErr.message);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var receivedAt = new Date().toISOString();

  try {
    var parsed = await parseMultipart(req);
    var fields = parsed.fields;
    var files = parsed.files;

    var toEmail = resolveToEmail(fields);
    var fromEmail = extractEmailAddress(getField(fields, 'from'));

    if (!toEmail) {
      console.error('email-inbound: missing to address in webhook payload');
      return res.status(200).json({ ok: true, message: 'Received — no to address' });
    }

    var uploadPrefix = extractLocalPart(toEmail);
    console.log('email-inbound: received mail for', toEmail, 'from', fromEmail || '(unknown)');

    var supabase = createSupabaseClient();

    var userResult = await supabase
      .from('user_settings')
      .select('user_id, upload_email')
      .eq('upload_email', uploadPrefix)
      .maybeSingle();

    if (userResult.error) {
      console.error('email-inbound: user lookup failed', userResult.error.message);
      return res.status(200).json({ ok: true, message: 'Received — user lookup error logged' });
    }

    if (!userResult.data) {
      console.error('email-inbound: no user_settings row for upload_email prefix', uploadPrefix);
      return res.status(200).json({ ok: true, message: 'Received — unknown upload address' });
    }

    var csvFiles = files.filter(function (f) {
      return isCsvAttachment(f.filename, f.mimeType);
    });

    if (csvFiles.length === 0) {
      console.warn('email-inbound: no CSV attachments for', toEmail);
      return res.status(200).json({ ok: true, message: 'Received — no CSV attachments' });
    }

    var saved = [];

    for (var i = 0; i < csvFiles.length; i++) {
      var attachment = csvFiles[i];
      var rawCsv = attachment.buffer.toString('utf8');

      var insertResult = await supabase.from('email_imports').insert({
        user_id: userResult.data.user_id,
        received_at: receivedAt,
        from_email: fromEmail || null,
        to_email: toEmail,
        filename: attachment.filename || null,
        raw_csv: rawCsv,
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

      if (isNavmanCsv(rawCsv)) {
        try {
          var parseResult = await parseNavmanReport(supabase, {
            userId: userResult.data.user_id,
            importId: importId,
            rawCsv: rawCsv,
            filename: attachment.filename || null,
            receivedAt: receivedAt,
          });
          console.log(
            'email-inbound: Navman parse complete',
            attachment.filename,
            parseResult.recordsUpserted + ' records,',
            parseResult.assetsCreated + ' assets created'
          );
        } catch (parseErr) {
          console.error(
            'email-inbound: Navman parse failed',
            attachment.filename,
            parseErr.message
          );
          await sendFailureAlert(
            attachment.filename,
            parseErr.message,
            userResult.data.user_id
          );
        }
      } else if (isBpCsv(rawCsv)) {
        try {
          var bpResult = await parseBpReport(supabase, {
            userId: userResult.data.user_id,
            importId: importId,
            rawCsv: rawCsv,
          });
          console.log(
            'email-inbound: BP parse complete',
            attachment.filename,
            bpResult.recordsUpserted + ' purchases,',
            bpResult.assetsCreated + ' assets created'
          );
        } catch (bpErr) {
          console.error(
            'email-inbound: BP parse failed',
            attachment.filename,
            bpErr.message
          );
          await sendFailureAlert(
            attachment.filename,
            bpErr.message,
            userResult.data.user_id
          );
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
            attachment.filename,
            updateResult.error.message
          );
        }
        console.log(
          'email-inbound: unrecognized CSV format',
          attachment.filename,
          'classified as',
          classification.detectedCategory
        );
      }

      saved.push(attachment.filename || ('attachment-' + (i + 1)));
      console.log('email-inbound: saved CSV import', attachment.filename, 'for user', userResult.data.user_id);
    }

    return res.status(200).json({
      ok: true,
      message: 'Received',
      saved: saved,
      user_id: userResult.data.user_id,
    });
  } catch (err) {
    console.error('email-inbound: unhandled error', err.message, err.stack);
    return res.status(200).json({ ok: true, message: 'Received — error logged' });
  }
};

module.exports.config = {
  api: {
    bodyParser: false,
  },
};
