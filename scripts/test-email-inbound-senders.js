/**
 * Inbound mail is imported only from an allowed sender, and the webhook
 * refuses to run when its secret is unset. Invented addresses only.
 *
 *   node scripts/test-email-inbound-senders.js
 */
var assert = require('assert');
var knownSenders = require('../lib/known-senders');
var inbound = require('../api/email-inbound');
var missingFeedAlert = require('../lib/missing-feed-alert');

var USER = '11111111-1111-4111-8111-111111111111';
var TO = 'yard-a3x9@uploads.example.test';
var SECRET = 'inbound-test-secret-value';
var FILE_MARKER = 'FILEBODYMARKER';
var RECEIVED = '2026-11-16T01:00:00.000Z';
var LATER = '2026-11-16T02:00:00.000Z';

function captureConsole() {
  var warns = [];
  var logs = [];
  var errors = [];
  var origWarn = console.warn;
  var origLog = console.log;
  var origError = console.error;
  console.warn = function () {
    warns.push(Array.prototype.slice.call(arguments).join(' '));
    origWarn.apply(console, arguments);
  };
  console.log = function () {
    logs.push(Array.prototype.slice.call(arguments).join(' '));
    origLog.apply(console, arguments);
  };
  console.error = function () {
    errors.push(Array.prototype.slice.call(arguments).join(' '));
    origError.apply(console, arguments);
  };
  return {
    warns: warns,
    logs: logs,
    errors: errors,
    restore: function () {
      console.warn = origWarn;
      console.log = origLog;
      console.error = origError;
    },
  };
}

function createMock(options) {
  options = options || {};
  var state = { inserts: [], updates: [], upserts: [], rows: options.rows || [] };
  var user = options.unknown ? null : { user_id: USER, upload_email: 'yard-a3x9' };

  function supabaseFrom(table) {
    return {
      select: function () {
        var filters = [];
        var chain = {
          eq: function (col, val) {
            filters.push({ op: 'eq', col: col, val: val });
            return chain;
          },
          is: function (col, val) {
            filters.push({ op: 'is', col: col, val: val });
            return chain;
          },
          gte: function (col, val) {
            filters.push({ op: 'gte', col: col, val: val });
            return chain;
          },
          in: function () { return chain; },
          order: function () { return chain; },
          limit: function () { return chain; },
          maybeSingle: function () {
            if (table === 'user_settings') return Promise.resolve({ data: user, error: null });
            return Promise.resolve({ data: null, error: null });
          },
          then: function (resolve) {
            if (options.queryError && table === 'email_imports') {
              resolve({ data: null, error: { message: 'db down' } });
              return;
            }
            var data = state.rows.filter(function (row) {
              if (table !== 'email_imports') return false;
              return filters.every(function (filter) {
                if (filter.op === 'eq' || filter.op === 'is') return row[filter.col] === filter.val;
                if (filter.op === 'gte') return String(row[filter.col] || '') >= String(filter.val);
                return false;
              });
            }).map(function (row) { return { id: row.id }; });
            resolve({ data: data, error: null });
          },
        };
        return chain;
      },
      insert: function (row) {
        var copy = Object.assign({}, row);
        copy.id = 'import-' + (state.rows.length + 1);
        state.rows.push(copy);
        state.inserts.push(copy);
        return {
          select: function () {
            return {
              single: function () {
                return Promise.resolve({ data: { id: copy.id }, error: null });
              },
            };
          },
        };
      },
      update: function (payload) {
        var filters = [];
        var chain = {
          eq: function (col, val) {
            filters.push({ col: col, val: val });
            return chain;
          },
          then: function (resolve) {
            state.updates.push({ table: table, payload: payload, filters: filters.slice() });
            resolve({ error: null });
          },
        };
        return chain;
      },
      upsert: function (rows) {
        state.upserts.push({ table: table, rows: rows });
        return Promise.resolve({ error: null });
      },
    };
  }

  return { supabase: { from: supabaseFrom }, state: state };
}

function mail(fields, files, receivedAt) {
  return {
    receivedAt: receivedAt || RECEIVED,
    fields: fields,
    files: files || [],
  };
}

function csvFile(name, body) {
  return { filename: name, mimeType: 'text/csv', buffer: Buffer.from(body) };
}

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status: function (code) { this.statusCode = code; return this; },
    json: function (payload) { this.body = payload; return this; },
  };
}

function fakeReq(query) {
  var state = { piped: false };
  return {
    method: 'POST',
    url: '/api/email-inbound',
    query: query || {},
    headers: { 'content-type': 'multipart/form-data; boundary=----test' },
    pipe: function () {
      state.piped = true;
      throw new Error('body parse started');
    },
    _state: state,
  };
}

function notices(alerts) {
  return alerts.filter(function (entry) {
    return String(entry.url).indexOf('api.resend.com') !== -1;
  });
}

async function main() {
  var previousExtra = process.env.INBOUND_EXTRA_SENDERS;
  var previousSecret = process.env.INBOUND_WEBHOOK_SECRET;
  var previousKey = process.env.RESEND_API_KEY;
  var previousFetch = global.fetch;
  delete process.env.INBOUND_EXTRA_SENDERS;

  var domains = ['teletracnavman.net', 'vl.cat.com', 'bp.com', 'johndeere.com'];
  assert.deepStrictEqual(knownSenders.BUILTIN_DOMAINS.slice(), domains);
  domains.forEach(function (domain) {
    assert.strictEqual(knownSenders.isAllowedSender('reports@' + domain, {}), true, domain);
    assert.strictEqual(knownSenders.isAllowedSender('reports@mail.' + domain, {}), true, 'subdomain ' + domain);
    assert.strictEqual(knownSenders.isAllowedSender('Reports@' + domain.toUpperCase(), {}), true, 'case ' + domain);
  });
  console.log('✓ each built-in provider domain and a true subdomain is allowed');

  assert.strictEqual(knownSenders.isAllowedSender('user@visionlink-fake.example.test', {}), false);
  assert.strictEqual(knownSenders.isAllowedSender('user@vl.cat.com.example.test', {}), false);
  assert.strictEqual(knownSenders.isAllowedSender('user@notvl.cat.com', {}), false);
  assert.strictEqual(knownSenders.isAllowedSender('vl.cat.com@gmail.com', {}), false);
  assert.strictEqual(knownSenders.isAllowedSender('reports+vl.cat.com@gmail.com', {}), false);
  assert.strictEqual(knownSenders.isAllowedSender('user@teletracnavman.net.example.test', {}), false);
  console.log('✓ look-alike domains and a provider name in the local part are rejected');

  var exactEnv = { INBOUND_EXTRA_SENDERS: ' Owner@Other.test , , ' };
  assert.strictEqual(knownSenders.isAllowedSender('Owner@Other.Test', exactEnv), true);
  assert.strictEqual(knownSenders.isAllowedSender('second@other.test', exactEnv), false);
  var domainEnv = { INBOUND_EXTRA_SENDERS: ' example.test , , ' };
  assert.strictEqual(knownSenders.isAllowedSender('owner@example.test', domainEnv), true);
  assert.strictEqual(knownSenders.isAllowedSender('Owner@Example.TEST', domainEnv), true);
  assert.strictEqual(knownSenders.isAllowedSender('person@sub.example.test', domainEnv), true);
  assert.strictEqual(knownSenders.isAllowedSender('person@notexample.test', domainEnv), false);
  assert.strictEqual(knownSenders.isAllowedSender('person@example.test.evil.test', domainEnv), false);
  assert.strictEqual(knownSenders.isAllowedSender('person@example.test', {}), false);
  assert.strictEqual(knownSenders.isAllowedSender('person@example.test', { INBOUND_EXTRA_SENDERS: '' }), false);
  assert.strictEqual(knownSenders.isAllowedSender('person@example.test', { INBOUND_EXTRA_SENDERS: ' , ' }), false);
  assert.strictEqual(knownSenders.isAllowedSender('', {}), false);
  assert.strictEqual(knownSenders.isAllowedSender('not-an-email', {}), false);
  assert.strictEqual(
    knownSenders.isAllowedSender('Name <Addr@Example.test>', { INBOUND_EXTRA_SENDERS: 'addr@example.test' }),
    true
  );
  console.log('✓ extra senders accept an exact address or a bare domain, and ignore empties');

  var alerts = [];
  process.env.RESEND_API_KEY = 'test-resend-key';
  global.fetch = function (url, opts) {
    alerts.push({ url: String(url), body: opts && opts.body ? JSON.parse(opts.body) : null });
    return Promise.resolve(new Response('{}', { status: 200 }));
  };
  var cap = captureConsole();

  try {
    var known = createMock();
    var knownResult = await inbound.processInboundEmail(known.supabase, mail({
      to: TO,
      from: 'Reports <reports@vl.cat.com>',
      subject: 'Hours',
      text: 'see attached',
      SPF: 'pass',
      dkim: 'pass',
    }, [csvFile('notes.csv', 'Hello,World\n' + FILE_MARKER + '\n')]));
    assert.strictEqual(knownResult.ok, true);
    assert.strictEqual(knownResult.message, 'Received');
    assert.strictEqual(known.state.inserts.length, 1);
    assert.strictEqual(known.state.inserts[0].status, 'pending');
    assert.strictEqual(known.state.inserts[0].filename, 'notes.csv');
    assert.ok(known.state.updates.some(function (entry) {
      return entry.payload.status === 'unrecognized';
    }));
    assert.strictEqual(known.state.upserts.length, 0);
    assert.strictEqual(notices(alerts).length, 0);
    assert.ok(cap.logs.some(function (line) {
      return line === 'email-inbound: accepted sender domain vl.cat.com spf=pass dkim=pass';
    }));
    assert.ok(cap.logs.every(function (line) {
      if (line.indexOf('accepted sender domain') === -1) return true;
      return line.indexOf('@') === -1 && line.indexOf(FILE_MARKER) === -1;
    }));
    console.log('✓ a known sender is imported as before');

    alerts.length = 0;
    cap.logs.length = 0;
    var held = createMock();
    var heldResult = await inbound.processInboundEmail(held.supabase, mail({
      to: TO,
      from: 'Stranger <sender@example.test>',
      subject: 'Hours',
      text: 'see attached',
    }, [csvFile('<script>.csv', 'Hello\n' + FILE_MARKER + '\n')]));
    assert.strictEqual(heldResult.ok, true);
    assert.strictEqual(heldResult.message, 'Received');
    assert.strictEqual(held.state.inserts.length, 1);
    assert.strictEqual(held.state.inserts[0].status, 'held_unapproved');
    assert.strictEqual(held.state.inserts[0].error_message, 'sender not approved');
    assert.strictEqual(held.state.inserts[0].from_email, 'sender@example.test');
    assert.strictEqual(held.state.inserts[0].user_id, USER);
    assert.strictEqual(held.state.inserts[0].filename, '<script>.csv');
    assert.ok(held.state.inserts[0].raw_csv.indexOf(FILE_MARKER) !== -1);
    assert.strictEqual(held.state.updates.length, 0);
    assert.strictEqual(held.state.upserts.length, 0);
    assert.strictEqual(notices(alerts).length, 1);
    var notice = notices(alerts)[0].body;
    assert.strictEqual(notice.from, missingFeedAlert.ALERT_FROM);
    assert.strictEqual(notice.to, missingFeedAlert.ALERT_TO);
    assert.ok(notice.html.indexOf('sender@example.test') !== -1);
    assert.ok(notice.html.indexOf(USER) !== -1);
    assert.ok(notice.html.indexOf('&lt;script&gt;.csv') !== -1);
    assert.strictEqual(notice.html.indexOf('<script>'), -1);
    assert.ok(notice.html.indexOf('held because the sender is not allowed; add it to INBOUND_EXTRA_SENDERS or to lib/known-senders.js if it is real') !== -1);
    assert.strictEqual(notice.html.indexOf(FILE_MARKER), -1);
    assert.ok(cap.logs.every(function (line) { return line.indexOf(FILE_MARKER) === -1; }));
    console.log('✓ an unknown sender is held, writes no data rows, and sends one notice');

    var again = createMock({ rows: held.state.rows.slice() });
    await inbound.processInboundEmail(again.supabase, mail({
      to: TO,
      from: 'sender@example.test',
      subject: 'Hours again',
    }, [csvFile('again.csv', FILE_MARKER + '\n')], LATER));
    assert.strictEqual(again.state.inserts.length, 1);
    assert.strictEqual(again.state.inserts[0].status, 'held_unapproved');
    assert.strictEqual(notices(alerts).length, 1);
    console.log('✓ a second held mail from the same sender within 24 hours sends no notice');

    alerts.length = 0;
    var brokenCheck = createMock({ queryError: true });
    var brokenResult = await inbound.processInboundEmail(brokenCheck.supabase, mail({
      to: TO,
      from: 'sender@example.test',
      subject: 'Hours',
    }, [csvFile('notes.csv', FILE_MARKER + '\n')]));
    assert.strictEqual(brokenResult.message, 'Received');
    assert.strictEqual(brokenCheck.state.inserts.length, 1);
    assert.strictEqual(brokenCheck.state.inserts[0].status, 'held_unapproved');
    assert.strictEqual(brokenCheck.state.upserts.length, 0);
    assert.strictEqual(notices(alerts).length, 0);
    assert.ok(cap.errors.some(function (line) {
      return line.indexOf('held-sender notice check failed') !== -1 && line.indexOf('db down') !== -1;
    }));
    console.log('✓ a failing notice check still holds the file');

    var emptyFrom = createMock();
    var emptyResult = await inbound.processInboundEmail(emptyFrom.supabase, mail({
      to: TO,
      from: '',
      subject: 'No sender',
    }, [csvFile('notes.csv', 'Hello\n')]));
    assert.strictEqual(emptyResult.message, 'Received');
    assert.strictEqual(emptyFrom.state.inserts[0].status, 'held_unapproved');
    assert.strictEqual(emptyFrom.state.inserts[0].from_email, null);
    assert.strictEqual(emptyFrom.state.upserts.length, 0);
    console.log('✓ an empty From is held');

    var originalCheck = knownSenders.isAllowedSender;
    knownSenders.isAllowedSender = function () { throw new Error('checker blew up'); };
    var blown = createMock();
    var blownResult = await inbound.processInboundEmail(blown.supabase, mail({
      to: TO,
      from: 'reports@vl.cat.com',
      subject: 'Hours',
    }, [csvFile('notes.csv', 'Hello\n')]));
    knownSenders.isAllowedSender = originalCheck;
    assert.strictEqual(blownResult.message, 'Received');
    assert.strictEqual(blown.state.inserts[0].status, 'held_unapproved');
    assert.strictEqual(blown.state.upserts.length, 0);
    console.log('✓ an unexpected sender-check error holds the file');

    process.env.INBOUND_WEBHOOK_SECRET = '';
    cap.warns.length = 0;
    var emptySecretReq = fakeReq({ token: SECRET });
    var emptySecretRes = fakeRes();
    await inbound(emptySecretReq, emptySecretRes);
    assert.strictEqual(emptySecretRes.statusCode, 503);
    assert.deepStrictEqual(emptySecretRes.body, { error: 'Inbound webhook is not configured' });
    assert.strictEqual(emptySecretReq._state.piped, false);

    delete process.env.INBOUND_WEBHOOK_SECRET;
    cap.warns.length = 0;
    var openReq = fakeReq({ token: SECRET });
    var openRes = fakeRes();
    await inbound(openReq, openRes);
    assert.strictEqual(openRes.statusCode, 503);
    assert.deepStrictEqual(openRes.body, { error: 'Inbound webhook is not configured' });
    assert.strictEqual(openReq._state.piped, false);
    assert.strictEqual(
      cap.warns.filter(function (line) {
        return line === 'email-inbound: INBOUND_WEBHOOK_SECRET is not set; refusing the request';
      }).length,
      1
    );
    console.log('✓ an unset or empty webhook secret returns 503');

    process.env.INBOUND_WEBHOOK_SECRET = SECRET;
    cap.warns.length = 0;
    var badReq = fakeReq({ token: 'wrong-token' });
    var badRes = fakeRes();
    await inbound(badReq, badRes);
    assert.strictEqual(badRes.statusCode, 401);
    assert.deepStrictEqual(badRes.body, { error: 'Unauthorized' });
    assert.strictEqual(badReq._state.piped, false);
    assert.strictEqual(cap.warns.join('\n').indexOf(SECRET), -1);
    console.log('✓ a wrong webhook token is 401');

    var okReq = fakeReq({ token: SECRET });
    var okRes = fakeRes();
    await inbound(okReq, okRes);
    assert.strictEqual(okReq._state.piped, true);
    assert.notStrictEqual(okRes.statusCode, 401);
    assert.notStrictEqual(okRes.statusCode, 503);
    console.log('✓ the right webhook token passes the gate');

    console.log('\nAll inbound sender tests passed.');
  } finally {
    cap.restore();
    global.fetch = previousFetch;
    if (previousExtra === undefined) delete process.env.INBOUND_EXTRA_SENDERS;
    else process.env.INBOUND_EXTRA_SENDERS = previousExtra;
    if (previousSecret === undefined) delete process.env.INBOUND_WEBHOOK_SECRET;
    else process.env.INBOUND_WEBHOOK_SECRET = previousSecret;
    if (previousKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previousKey;
    if (knownSenders.isAllowedSender !== require('../lib/known-senders').isAllowedSender) {
      knownSenders.isAllowedSender = require('../lib/known-senders').isAllowedSender;
    }
  }
}

main().catch(function (err) {
  console.error('\nFAILED:', err);
  process.exit(1);
});
