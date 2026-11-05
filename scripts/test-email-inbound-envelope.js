/**
 * Inbound mail is matched on the SMTP envelope recipient before the To header.
 * Invented addresses only. No network.
 *
 *   node scripts/test-email-inbound-envelope.js
 */
var assert = require('assert');
var inbound = require('../api/email-inbound');

var OWNER = '00000000-0000-4000-8000-0000000000e1';
var LATE = '00000000-0000-4000-8000-0000000000e2';
var UPLOAD = 'abc-1234@uploads.example.com';
var SUPPORT = 'support@example.com';
var SENDER = 'reports@plant.example';
var VL_TOKEN = 'FAKEENVELOPETOKEN';
var VL_LINK = 'https://vl.cat.com/downloadreport?token=' + VL_TOKEN;
var DEERE_HANDLE = '00000000-0000-4000-8000-0000000000ee';
var DEERE_TOKEN = 'fakedeeeretoken0123456789abcdef0123456789abcdef01234567';
var DEERE_LINK = 'https://dexample1234.cloudfront.net/?handle=' + DEERE_HANDLE + '&token=' + DEERE_TOKEN;
var S3_HOST = 'example-bucket.s3.us-east-2.amazonaws.com';
var S3_URL = 'https://' + S3_HOST + '/FAKEKEY/Fleet_Utilization_28-10-2026.csv?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=FAKESIG';
var RECEIVED = '2026-11-04T18:00:00.000Z';

var USERS = {
  'abc-1234': { user_id: OWNER, upload_email: 'abc-1234' },
  'late-9999': { user_id: LATE, upload_email: 'late-9999' },
};

function captureConsole() {
  var lines = [];
  var origLog = console.log;
  var origWarn = console.warn;
  var origError = console.error;
  function push(args) { lines.push(Array.prototype.slice.call(args).join(' ')); }
  console.log = function() { push(arguments); origLog.apply(console, arguments); };
  console.warn = function() { push(arguments); origWarn.apply(console, arguments); };
  console.error = function() { push(arguments); origError.apply(console, arguments); };
  return {
    lines: lines,
    restore: function() {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    },
  };
}

function createMock(options) {
  options = options || {};
  var state = { inserts: [], updates: [], upserts: [], lookups: [] };
  var assets = options.assets || [];

  function read(table) {
    if (table === 'assets') return { data: assets, error: null };
    return { data: [], error: null };
  }

  function supabaseFrom(table) {
    return {
      select: function() {
        var filters = [];
        var chain = {
          eq: function(col, val) {
            filters.push({ col: col, val: val });
            return chain;
          },
          in: function() { return chain; },
          not: function() { return chain; },
          gt: function() { return chain; },
          order: function() { return chain; },
          limit: function() { return chain; },
          maybeSingle: function() {
            if (table !== 'user_settings') return Promise.resolve({ data: null, error: null });
            var prefix = null;
            filters.forEach(function(filter) {
              if (filter.col === 'upload_email') prefix = filter.val;
            });
            state.lookups.push(prefix);
            if (options.lookupError) {
              return Promise.resolve({ data: null, error: { message: 'db down' } });
            }
            return Promise.resolve({ data: (prefix && USERS[prefix]) || null, error: null });
          },
          single: function() { return Promise.resolve(read(table)); },
          then: function(resolve) { resolve(read(table)); },
        };
        return chain;
      },
      insert: function(row) {
        state.inserts.push({ table: table, row: row });
        return {
          select: function() {
            return {
              single: function() {
                return Promise.resolve({ data: { id: 'import-' + state.inserts.length }, error: null });
              },
            };
          },
        };
      },
      update: function(payload) {
        var updateFilters = [];
        var chain = {
          eq: function(col, val) {
            updateFilters.push({ col: col, val: val });
            return chain;
          },
          then: function(resolve) {
            state.updates.push({ table: table, payload: payload, filters: updateFilters.slice() });
            resolve({ error: null });
          },
        };
        return chain;
      },
      upsert: function(rows, opts) {
        state.upserts.push({ table: table, rows: rows, opts: opts });
        return Promise.resolve({ error: null });
      },
    };
  }

  return { supabase: { from: supabaseFrom }, state: state };
}

function mail(fields, files) {
  return { receivedAt: RECEIVED, fields: fields, files: files || [] };
}

function envelope(list) {
  return JSON.stringify({ to: list, from: SENDER });
}

function importRows(state) {
  return state.inserts.filter(function(entry) { return entry.table === 'email_imports'; });
}

function receivedLines(lines) {
  return lines.filter(function(line) { return line.indexOf('received mail for') !== -1; });
}

function csvFile(name, body) {
  return { filename: name, mimeType: 'text/csv', buffer: Buffer.from(body) };
}

function quoted(values) {
  return values.map(function(value) {
    return '"' + String(value).replace(/"/g, '""') + '"';
  }).join(',');
}

var VL_CSV = [
  'Callouts,Asset ID,Asset Serial Number,Make,Model,Hour Meter (Hours),Hour Meter Last Reported Time,Latest Utilization Report,Timezone Offset,Time Zone,Timezone Display Name,Runtime (Hours),Idle Time (Hours),Working Time (Hours),Idle %,Total Fuel Burned (L),Total Fuel Burn Rate (L/Hour)',
  ',EQ000041,AAA00041,CAT,320,100,2026-10-28T10:00:00Z,2026-10-28T10:00:00Z,+13:00,Pacific/Auckland,NZDT,4,1,3,25,10,2.5',
].join('\n');

var JD_HEADER = [
  'Nickname', 'Machine Serial Number', 'Make', 'Type', 'Model',
  'Key On (l)', 'Low Load (l)', 'Medium Load (l)', 'High Load (l)', 'Idle (l)', 'Working (l)', 'Transport (l)', 'Total Fuel (l)',
  'Key On (h)', 'Low Load (h)', 'Medium Load (h)', 'High Load (h)', 'Idle (h)', 'Working (h)', 'Transport (h)', 'Total Hours',
  'Report Start Date', 'Report Start Time', 'Report End Date', 'Report End Time',
];
var JD_ROW = [
  'Yard Loader', '1T0000ENVELOPE000001', 'JOHN DEERE', 'Excavator', '200G',
  '---', '5', '5', '5', '2', '---', '---', '20',
  '---', '1', '1', '1', '1', '---', '---', '4',
  'Nov 1, 2026', '12:00 AM', 'Nov 2, 2026', '12:00 AM',
];
var JD_CSV = quoted(JD_HEADER) + '\n' + quoted(JD_ROW) + '\n';

function forwardFields(extra) {
  var fields = {
    to: SUPPORT,
    from: 'Report Desk <' + SENDER + '>',
    subject: 'Scheduled report',
    text: 'Hours for the yard loader.',
    html: '',
    envelope: envelope([UPLOAD]),
  };
  if (extra) {
    Object.keys(extra).forEach(function(key) { fields[key] = extra[key]; });
  }
  return fields;
}

async function main() {
  var previousFetch = global.fetch;
  var cap = captureConsole();
  global.fetch = function() {
    throw new Error('unexpected fetch');
  };

  try {
    var forwarded = createMock();
    var forwardedResult = await inbound.processInboundEmail(forwarded.supabase, mail(forwardFields({
      envelope: envelope(['ABC-1234@Uploads.Example.com']),
    }), [csvFile('yard-hours.csv', 'Machine,Hours\nLoader,4\n')]));
    assert.strictEqual(forwardedResult.ok, true);
    assert.strictEqual(forwardedResult.user_id, OWNER);
    assert.deepStrictEqual(forwarded.state.lookups, ['abc-1234']);
    var forwardedRow = importRows(forwarded.state)[0].row;
    assert.strictEqual(forwardedRow.user_id, OWNER);
    assert.strictEqual(forwardedRow.to_email, UPLOAD);
    assert.strictEqual(forwardedRow.from_email, SENDER);
    assert.strictEqual(forwardedRow.status, 'pending');
    assert.ok(forwarded.state.updates.some(function(entry) {
      return entry.table === 'email_imports' && entry.payload.status === 'unrecognized';
    }));
    var forwardedLog = receivedLines(cap.lines);
    assert.strictEqual(forwardedLog.length, 1);
    assert.ok(forwardedLog[0].indexOf(UPLOAD) !== -1);
    assert.ok(forwardedLog[0].indexOf(SENDER) !== -1);
    assert.strictEqual(forwardedLog[0].indexOf(SUPPORT), -1);
    console.log('✓ a server-side forward imports the CSV for the envelope upload address');

    cap.lines.length = 0;
    var quiet = createMock();
    var quietResult = await inbound.processInboundEmail(quiet.supabase, mail(forwardFields()));
    assert.strictEqual(quietResult.ok, true);
    assert.strictEqual(quietResult.message, 'Received — no CSV attachments');
    assert.strictEqual(importRows(quiet.state).length, 1);
    assert.strictEqual(importRows(quiet.state)[0].row.status, 'no_attachment');
    assert.strictEqual(importRows(quiet.state)[0].row.to_email, UPLOAD);
    assert.strictEqual(importRows(quiet.state)[0].row.from_email, SENDER);
    assert.strictEqual(importRows(quiet.state)[0].row.user_id, OWNER);
    console.log('✓ a forward with no attachment is stored against the upload address');

    cap.lines.length = 0;
    var normal = createMock();
    var normalResult = await inbound.processInboundEmail(normal.supabase, mail({
      to: 'Yard Desk <' + UPLOAD + '>',
      from: SENDER,
      envelope: envelope([UPLOAD]),
      subject: 'Note',
      text: 'No file today.',
    }));
    assert.strictEqual(normalResult.message, 'Received — no CSV attachments');
    assert.deepStrictEqual(normal.state.lookups, ['abc-1234']);
    assert.strictEqual(importRows(normal.state)[0].row.to_email, UPLOAD);
    console.log('✓ mail whose To header and envelope agree is unchanged');

    cap.lines.length = 0;
    var headerOnly = createMock();
    var headerResult = await inbound.processInboundEmail(headerOnly.supabase, mail({
      to: UPLOAD,
      from: SENDER,
      subject: 'Note',
      text: 'No file today.',
    }));
    assert.strictEqual(headerResult.message, 'Received — no CSV attachments');
    assert.deepStrictEqual(headerOnly.state.lookups, ['abc-1234']);
    assert.strictEqual(importRows(headerOnly.state)[0].row.to_email, UPLOAD);
    console.log('✓ a missing envelope falls back to the To header');

    cap.lines.length = 0;
    var brokenEnvelope = createMock();
    var brokenResult = await inbound.processInboundEmail(brokenEnvelope.supabase, mail({
      to: UPLOAD,
      from: SENDER,
      envelope: '{not json',
      subject: 'Note',
      text: 'No file today.',
    }));
    assert.strictEqual(brokenResult.ok, true);
    assert.strictEqual(brokenResult.message, 'Received — no CSV attachments');
    assert.deepStrictEqual(brokenEnvelope.state.lookups, ['abc-1234']);
    assert.ok(cap.lines.some(function(line) {
      return line.indexOf('could not parse envelope field') !== -1;
    }));
    console.log('✓ malformed envelope JSON falls back to the To header');

    cap.lines.length = 0;
    var second = createMock();
    var secondResult = await inbound.processInboundEmail(second.supabase, mail({
      to: SUPPORT,
      from: SENDER,
      envelope: envelope(['other-desk@example.com', UPLOAD]),
      subject: 'Note',
      text: 'No file today.',
    }));
    assert.strictEqual(importRows(second.state)[0].row.user_id, OWNER);
    assert.deepStrictEqual(second.state.lookups, ['other-desk', 'abc-1234']);
    assert.strictEqual(importRows(second.state)[0].row.to_email, UPLOAD);
    assert.strictEqual(receivedLines(cap.lines).join('\n').indexOf('other-desk@example.com'), -1);
    console.log('✓ the second envelope recipient is used when it is the one that matches');

    cap.lines.length = 0;
    var display = createMock();
    var displayResult = await inbound.processInboundEmail(display.supabase, mail({
      to: '"Smith, Pat" <' + SUPPORT + '>, Yard Desk <' + UPLOAD + '>',
      from: SENDER,
      subject: 'Note',
      text: 'No file today.',
    }));
    assert.strictEqual(displayResult.message, 'Received — no CSV attachments');
    assert.deepStrictEqual(display.state.lookups, ['support', 'abc-1234']);
    assert.strictEqual(importRows(display.state)[0].row.to_email, UPLOAD);
    console.log('✓ a To header with display names still finds the upload address');

    cap.lines.length = 0;
    var unknown = createMock();
    var unknownResult = await inbound.processInboundEmail(unknown.supabase, mail({
      to: '"Support" <' + SUPPORT + '>',
      from: SENDER,
      envelope: envelope([SUPPORT, 'nobody-zz99@example.com']),
      subject: 'Note',
      text: 'Do not store this.',
    }));
    assert.strictEqual(unknownResult.ok, true);
    assert.strictEqual(unknownResult.message, 'Received — unknown upload address');
    assert.strictEqual(unknown.state.inserts.length, 0);
    assert.strictEqual(receivedLines(cap.lines).length, 0);
    console.log('✓ an unmatched envelope and To header store nothing');

    var missing = createMock();
    var missingResult = await inbound.processInboundEmail(missing.supabase, mail({
      from: SENDER,
      subject: 'Note',
      text: 'No recipient.',
    }));
    assert.strictEqual(missingResult.ok, true);
    assert.strictEqual(missingResult.message, 'Received — no to address');
    assert.strictEqual(missing.state.lookups.length, 0);
    console.log('✓ no envelope and no To header keeps the missing-address result');

    cap.lines.length = 0;
    var lookupDown = createMock({ lookupError: true });
    var lookupResult = await inbound.processInboundEmail(lookupDown.supabase, mail(forwardFields(), [
      csvFile('yard-hours.csv', 'Machine,Hours\nLoader,4\n'),
    ]));
    assert.strictEqual(lookupResult.ok, true);
    assert.strictEqual(lookupResult.message, 'Received — user lookup error logged');
    assert.strictEqual(lookupDown.state.inserts.length, 0);
    assert.deepStrictEqual(lookupDown.state.lookups, ['abc-1234']);
    assert.ok(cap.lines.some(function(line) { return line.indexOf('user lookup failed') !== -1; }));
    console.log('✓ a user lookup error returns ok and writes nothing');

    var fillers = [];
    for (var n = 1; n <= 9; n++) fillers.push('r' + n + '@example.com');
    var capped = createMock();
    var cappedResult = await inbound.processInboundEmail(capped.supabase, mail({
      to: 'late-9999@uploads.example.com',
      from: SENDER,
      envelope: envelope(fillers.concat([UPLOAD, 'late-9999@uploads.example.com'])),
      subject: 'Note',
      text: 'Tenth address matches.',
    }));
    assert.strictEqual(capped.state.lookups.length, 10);
    assert.strictEqual(capped.state.lookups[9], 'abc-1234');
    assert.strictEqual(capped.state.lookups.indexOf('late-9999'), -1);
    assert.strictEqual(importRows(capped.state)[0].row.to_email, UPLOAD);
    assert.strictEqual(importRows(capped.state)[0].row.user_id, OWNER);
    var pastCap = createMock();
    var pastResult = await inbound.processInboundEmail(pastCap.supabase, mail({
      to: SUPPORT,
      from: SENDER,
      envelope: envelope(fillers.concat(['other-desk@example.com', 'late-9999@uploads.example.com'])),
      subject: 'Note',
      text: 'The match is past the cap.',
    }));
    assert.strictEqual(pastResult.message, 'Received — unknown upload address');
    assert.strictEqual(pastCap.state.lookups.length, 10);
    assert.strictEqual(pastCap.state.lookups.indexOf('late-9999'), -1);
    assert.strictEqual(pastCap.state.inserts.length, 0);
    console.log('✓ only the first 10 unique recipients are looked up');

    global.fetch = function(url) {
      var href = String(url);
      if (href.indexOf('api.cat.com') !== -1) {
        return Promise.resolve(new Response(JSON.stringify({ downloadUrl: S3_URL }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }));
      }
      if (href.indexOf(S3_HOST) !== -1) {
        return Promise.resolve(new Response(VL_CSV, {
          status: 200,
          headers: {
            'content-type': 'text/csv',
            'content-disposition': 'attachment; filename="Fleet_Utilization_28-10-2026_28-10-2026_28-10-2026.csv"',
          },
        }));
      }
      if (href.indexOf('cloudfront.net') !== -1) {
        return Promise.resolve(new Response(JD_CSV, {
          status: 200,
          headers: {
            'content-type': 'text/csv',
            'content-disposition': 'attachment; filename="DailyUtilization_2026-11-02.csv"',
          },
        }));
      }
      return Promise.reject(new Error('unexpected url'));
    };

    cap.lines.length = 0;
    var vision = createMock({
      assets: [{
        id: 41,
        asset_name: 'CAT 320 (EQ000041)',
        visionlink_serial: 'AAA00041',
        current_hours: 10,
        telematics_provider: 'VisionLink',
      }],
    });
    var visionResult = await inbound.processInboundEmail(vision.supabase, mail(forwardFields({
      from: 'Vision Desk <reports@vl.example>',
      subject: 'Scheduled utilization',
      text: 'Download Report ' + VL_LINK,
      html: '<a href="' + VL_LINK + '">Download Report</a>',
    })));
    assert.strictEqual(visionResult.ok, true);
    assert.strictEqual(visionResult.user_id, OWNER);
    assert.strictEqual(importRows(vision.state)[0].row.to_email, UPLOAD);
    assert.strictEqual(importRows(vision.state)[0].row.from_email, 'reports@vl.example');
    var visionRows = vision.state.upserts.filter(function(entry) { return entry.table === 'telematics_records'; });
    assert.strictEqual(visionRows.length, 1);
    assert.strictEqual(visionRows[0].rows[0].asset_id, 41);
    assert.ok(vision.state.updates.some(function(entry) {
      return entry.payload.status === 'processed';
    }));
    var visionBlob = cap.lines.join('\n') + JSON.stringify(vision.state);
    assert.strictEqual(visionBlob.indexOf(VL_TOKEN), -1);
    assert.strictEqual(visionBlob.indexOf(S3_URL), -1);
    assert.strictEqual(visionBlob.indexOf('FAKESIG'), -1);
    assert.strictEqual(visionBlob.indexOf(SUPPORT), -1);
    console.log('✓ a forwarded VisionLink link still imports for the envelope address');

    cap.lines.length = 0;
    var deere = createMock({
      assets: [{
        id: 51,
        asset_name: 'Yard Loader',
        visionlink_serial: '1t0000envelope000001',
        current_hours: null,
        telematics_provider: null,
      }],
    });
    var deereResult = await inbound.processInboundEmail(deere.supabase, mail(forwardFields({
      from: 'Machine Desk <reports@machine.example>',
      subject: 'Daily Utilization (Utilization) Report Completed',
      text: '- CSV (' + DEERE_LINK + ')',
      html: '<a href="' + DEERE_LINK.replace(/&/g, '&amp;') + '">CSV</a>',
    })));
    assert.strictEqual(deereResult.ok, true);
    assert.strictEqual(deereResult.user_id, OWNER);
    assert.strictEqual(importRows(deere.state)[0].row.to_email, UPLOAD);
    assert.strictEqual(importRows(deere.state)[0].row.from_email, 'reports@machine.example');
    var deereRows = deere.state.upserts.filter(function(entry) { return entry.table === 'telematics_records'; });
    assert.strictEqual(deereRows.length, 1);
    assert.strictEqual(deereRows[0].rows[0].asset_id, 51);
    assert.strictEqual(deereRows[0].rows[0].record_date, '2026-11-01');
    assert.ok(deere.state.updates.some(function(entry) {
      return entry.payload.status === 'processed';
    }));
    var deereBlob = cap.lines.join('\n') + JSON.stringify(deere.state);
    assert.strictEqual(deereBlob.indexOf(DEERE_TOKEN), -1);
    assert.strictEqual(deereBlob.indexOf(DEERE_HANDLE), -1);
    assert.strictEqual(deereBlob.indexOf(SUPPORT), -1);
    console.log('✓ a forwarded John Deere link still imports for the envelope address');

    console.log('ALL ENVELOPE ROUTING TESTS PASSED');
  } finally {
    cap.restore();
    global.fetch = previousFetch;
  }
}

main().catch(function(err) {
  console.error('\nFAILED:', err);
  process.exit(1);
});
