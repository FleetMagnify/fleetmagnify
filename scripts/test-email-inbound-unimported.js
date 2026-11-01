/**
 * Emails with no CSV and no VisionLink link are saved for review.
 * Invented addresses and bodies only. No network.
 *
 *   node scripts/test-email-inbound-unimported.js
 */
var assert = require('assert');
var inbound = require('../api/email-inbound');

var USER = '00000000-0000-4000-8000-0000000000b2';
var TO = 'yard-a3x9@uploads.fleetmagnify.com';
var RECEIVED = '2026-11-02T01:15:00.000Z';
var REVIEW = 'No CSV attachment or report link; email saved for review';

function captureConsole() {
  var errors = [];
  var origError = console.error;
  console.error = function() {
    errors.push(Array.prototype.slice.call(arguments).join(' '));
  };
  return {
    errors: errors,
    restore: function() { console.error = origError; },
  };
}

function createMock(options) {
  options = options || {};
  var state = { inserts: [], updates: [] };
  var user = options.unknown ? null : { user_id: USER, upload_email: 'yard-a3x9' };
  var insertError = options.insertError || null;

  function supabaseFrom(table) {
    return {
      select: function() {
        var chain = {
          eq: function() { return chain; },
          in: function() { return chain; },
          order: function() { return chain; },
          limit: function() { return chain; },
          maybeSingle: function() {
            if (table === 'user_settings') return Promise.resolve({ data: user, error: null });
            return Promise.resolve({ data: null, error: null });
          },
          single: function() {
            if (table === 'user_settings') return Promise.resolve({ data: user, error: null });
            return Promise.resolve({ data: [], error: null });
          },
          then: function(resolve) { resolve({ data: [], error: null }); },
        };
        return chain;
      },
      insert: function(row) {
        state.inserts.push({ table: table, row: row });
        return {
          select: function() {
            return {
              single: function() {
                if (insertError) return Promise.resolve({ data: null, error: insertError });
                return Promise.resolve({ data: { id: state.inserts.length }, error: null });
              },
            };
          },
        };
      },
      update: function(payload) {
        var filters = [];
        var chain = {
          eq: function(col, val) {
            filters.push({ col: col, val: val });
            return chain;
          },
          then: function(resolve) {
            state.updates.push({ table: table, payload: payload, filters: filters.slice() });
            resolve({ error: null });
          },
        };
        return chain;
      },
      upsert: function() {
        return Promise.resolve({ error: null });
      },
    };
  }

  return { supabase: { from: supabaseFrom }, state: state };
}

function mail(fields, files) {
  return {
    receivedAt: RECEIVED,
    fields: fields,
    files: files || [],
  };
}

function importRows(state) {
  return state.inserts.filter(function(entry) { return entry.table === 'email_imports'; });
}

function noAttachmentRows(state) {
  return importRows(state).filter(function(entry) { return entry.row.status === 'no_attachment'; });
}

async function main() {
  var previousKey = process.env.RESEND_API_KEY;
  var previousFetch = global.fetch;
  var alerts = [];
  process.env.RESEND_API_KEY = 'test-resend-key';
  global.fetch = function(url, opts) {
    alerts.push({ url: String(url), body: opts && opts.body });
    return Promise.resolve(new Response('{}', { status: 200 }));
  };
  var cap = captureConsole();

  try {
    var plain = createMock();
    var plainResult = await inbound.processInboundEmail(plain.supabase, mail({
      to: 'Yard Desk <' + TO + '>',
      from: 'Setup Bot <setup@example.com>',
      subject: '  Team invite for Excavator 12  ',
      text: 'Your sign-in code is 482913.\nIt expires tonight.',
      html: '<p>ignore this html</p>',
    }));
    assert.strictEqual(plainResult.ok, true);
    assert.strictEqual(plainResult.message, 'Received — no CSV attachments');
    assert.strictEqual(importRows(plain.state).length, 1);
    var row = importRows(plain.state)[0].row;
    assert.strictEqual(row.user_id, USER);
    assert.strictEqual(row.received_at, RECEIVED);
    assert.strictEqual(row.from_email, 'setup@example.com');
    assert.strictEqual(row.to_email, TO);
    assert.strictEqual(row.filename, 'Team invite for Excavator 12');
    assert.strictEqual(row.raw_csv, 'Your sign-in code is 482913.\nIt expires tonight.');
    assert.strictEqual(row.status, 'no_attachment');
    assert.strictEqual(row.error_message, REVIEW);
    assert.notStrictEqual(row.status, 'pending');
    assert.strictEqual(alerts.length, 0);
    console.log('✓ a known address with no attachment and no report link is saved for review');

    var longSubject = 'S'.repeat(250);
    var truncated = createMock();
    await inbound.processInboundEmail(truncated.supabase, mail({
      to: TO,
      from: 'setup@example.com',
      subject: longSubject,
      text: 'code 100200',
    }));
    assert.strictEqual(importRows(truncated.state)[0].row.filename, 'S'.repeat(200));
    assert.strictEqual(importRows(truncated.state)[0].row.filename.length, 200);
    console.log('✓ the subject is trimmed and cut to 200 characters');

    var htmlOnly = createMock();
    var html = [
      '<html><body>',
      '<style>body { color: red; }</style>',
      '<p>  Sign-in&nbsp;code:   <strong>482913</strong> </p>',
      '<script>var secret = "do-not-keep";</script>',
      '<p>Forward   this.</p>',
      '</body></html>',
    ].join('');
    await inbound.processInboundEmail(htmlOnly.supabase, mail({
      to: TO,
      from: 'forwarding@example.com',
      subject: 'Confirm forwarding',
      text: '   ',
      html: html,
    }));
    assert.strictEqual(
      importRows(htmlOnly.state)[0].row.raw_csv,
      'Sign-in code: 482913 Forward this.'
    );
    assert.strictEqual(importRows(htmlOnly.state)[0].row.raw_csv.indexOf('do-not-keep'), -1);
    assert.strictEqual(importRows(htmlOnly.state)[0].row.raw_csv.indexOf('<'), -1);
    console.log('✓ an HTML-only body is stored with tags stripped and whitespace collapsed');

    var longBody = 'A'.repeat(20050);
    var clipped = createMock();
    await inbound.processInboundEmail(clipped.supabase, mail({
      to: TO,
      from: 'setup@example.com',
      subject: 'Long note',
      text: longBody,
    }));
    assert.strictEqual(importRows(clipped.state)[0].row.raw_csv.length, 20000);
    assert.strictEqual(importRows(clipped.state)[0].row.raw_csv, 'A'.repeat(20000));
    console.log('✓ the stored body is cut to 20000 characters');

    var empty = createMock();
    await inbound.processInboundEmail(empty.supabase, mail({
      to: TO,
      from: 'setup@example.com',
      subject: '   ',
      text: '',
      html: '',
    }));
    var emptyRow = importRows(empty.state)[0].row;
    assert.strictEqual(emptyRow.filename, '(no subject)');
    assert.strictEqual(emptyRow.raw_csv, '');
    assert.strictEqual(emptyRow.status, 'no_attachment');
    console.log('✓ an empty body is stored as an empty string');

    alerts.length = 0;
    var csv = createMock();
    var csvResult = await inbound.processInboundEmail(csv.supabase, mail({
      to: TO,
      from: 'reports@example.com',
      subject: 'Daily notes',
      text: 'see attached',
    }, [{
      filename: 'notes.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('Hello,World\n1,2\n'),
    }]));
    assert.strictEqual(csvResult.ok, true);
    assert.strictEqual(noAttachmentRows(csv.state).length, 0);
    assert.strictEqual(importRows(csv.state).length, 1);
    assert.strictEqual(importRows(csv.state)[0].row.status, 'pending');
    assert.strictEqual(importRows(csv.state)[0].row.filename, 'notes.csv');
    assert.strictEqual(alerts.length, 0);
    console.log('✓ a CSV attachment is imported as pending and does not add a no_attachment row');

    alerts.length = 0;
    var linkFetches = 0;
    global.fetch = function(url) {
      linkFetches += 1;
      alerts.push(String(url));
      return Promise.resolve(new Response('nope', {
        status: 400,
        headers: { 'content-type': 'text/plain' },
      }));
    };
    var linked = createMock();
    var linkResult = await inbound.processInboundEmail(linked.supabase, mail({
      to: TO,
      from: 'reports@example.com',
      subject: 'Your scheduled report',
      text: 'Download Report https://vl.cat.com/downloadreport?token=FAKETOKEN',
      html: '',
    }));
    assert.strictEqual(linkResult.ok, true);
    assert.notStrictEqual(linkResult.message, 'Received — no CSV attachments');
    assert.ok(linkFetches > 0);
    assert.strictEqual(noAttachmentRows(linked.state).length, 0);
    assert.strictEqual(importRows(linked.state).length, 1);
    assert.strictEqual(importRows(linked.state)[0].row.status, 'failed');
    console.log('✓ a VisionLink report link does not create a no_attachment row');

    global.fetch = function() {
      alerts.push('unexpected');
      throw new Error('unknown address must not be stored or fetched');
    };
    var unknown = createMock({ unknown: true });
    var unknownResult = await inbound.processInboundEmail(unknown.supabase, mail({
      to: 'nobody-zz99@uploads.fleetmagnify.com',
      from: 'setup@example.com',
      subject: 'A code',
      text: '482913',
    }));
    assert.strictEqual(unknownResult.ok, true);
    assert.strictEqual(unknownResult.message, 'Received — unknown upload address');
    assert.strictEqual(unknown.state.inserts.length, 0);
    console.log('✓ an unknown upload address stores nothing');

    cap.errors.length = 0;
    var broken = createMock({ insertError: { message: 'insert rejected' } });
    var brokenResult = await inbound.processInboundEmail(broken.supabase, mail({
      to: TO,
      from: 'setup@example.com',
      subject: 'Sign-in code',
      text: '482913',
    }));
    assert.strictEqual(brokenResult.ok, true);
    assert.strictEqual(brokenResult.message, 'Received — no CSV attachments');
    assert.strictEqual(importRows(broken.state).length, 1);
    assert.strictEqual(importRows(broken.state)[0].row.status, 'no_attachment');
    assert.ok(cap.errors.some(function(line) {
      return line.indexOf('failed to save email with no attachment') !== -1 &&
        line.indexOf('insert rejected') !== -1;
    }));
    console.log('✓ an insert error is logged and the webhook still returns ok');

    console.log('ALL UNIMPORTED EMAIL TESTS PASSED');
  } finally {
    cap.restore();
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previousKey;
  }
}

main().catch(function(err) {
  console.error('\nFAILED:', err);
  process.exit(1);
});
