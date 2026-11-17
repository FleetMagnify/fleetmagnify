/**
 * Auth gate for the SendGrid inbound webhook.
 * Run: node scripts/test-email-inbound-auth.js
 *
 * Three cases:
 *   1. INBOUND_WEBHOOK_SECRET set and req.query.token matches
 *   2. secret set and token wrong or missing
 *   3. secret not set: refuse the request
 */
var assert = require('assert');
var handler = require('../api/email-inbound');

var SECRET = 'inbound-test-secret-value';

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status: function(code) {
      this.statusCode = code;
      return this;
    },
    json: function(payload) {
      this.body = payload;
      return this;
    },
  };
}

function fakeReq(query, url) {
  var state = { piped: false };
  return {
    method: 'POST',
    url: url || '/api/email-inbound',
    query: query || {},
    headers: { 'content-type': 'multipart/form-data; boundary=----test' },
    pipe: function() {
      state.piped = true;
      throw new Error('body parse started');
    },
    _state: state,
  };
}

function captureConsole() {
  var warns = [];
  var logs = [];
  var errors = [];
  var origWarn = console.warn;
  var origLog = console.log;
  var origError = console.error;
  console.warn = function() {
    warns.push(Array.prototype.slice.call(arguments).join(' '));
  };
  console.log = function() {
    logs.push(Array.prototype.slice.call(arguments).join(' '));
  };
  console.error = function() {
    errors.push(Array.prototype.slice.call(arguments).join(' '));
  };
  return {
    warns: warns,
    logs: logs,
    errors: errors,
    all: function() { return warns.concat(logs, errors).join('\n'); },
    restore: function() {
      console.warn = origWarn;
      console.log = origLog;
      console.error = origError;
    },
  };
}

function assertNoSecretLeak(text) {
  assert.strictEqual(text.indexOf(SECRET) === -1, true, 'logged the webhook secret');
  assert.strictEqual(text.indexOf('token=') === -1, true, 'logged a query string');
  assert.strictEqual(text.indexOf('http://') === -1, true, 'logged a full URL');
  assert.strictEqual(text.indexOf('https://') === -1, true, 'logged a full URL');
}

async function main() {
  var previous = process.env.INBOUND_WEBHOOK_SECRET;
  var cap = captureConsole();
  try {
    // 1. Secret set, token correct: past the gate, body parsing starts.
    process.env.INBOUND_WEBHOOK_SECRET = SECRET;
    var okReq = fakeReq(
      { token: SECRET },
      '/api/email-inbound?token=' + SECRET
    );
    var okRes = fakeRes();
    await handler(okReq, okRes);
    assert.strictEqual(okRes.statusCode, 200, 'correct token should not be 401');
    assert.strictEqual(okReq._state.piped, true, 'correct token should reach body parsing');
    assert.strictEqual(
      cap.warns.some(function(line) {
        return line.indexOf('INBOUND_WEBHOOK_SECRET not set') !== -1;
      }),
      false,
      'correct token should not warn that auth is off'
    );
    assertNoSecretLeak(cap.all());

    // 2a. Secret set, token wrong.
    cap.warns.length = 0;
    cap.logs.length = 0;
    cap.errors.length = 0;
    var badReq = fakeReq(
      { token: 'wrong-token' },
      '/api/email-inbound?token=' + SECRET
    );
    var badRes = fakeRes();
    await handler(badReq, badRes);
    assert.strictEqual(badRes.statusCode, 401);
    assert.deepStrictEqual(badRes.body, { error: 'Unauthorized' });
    assert.strictEqual(badReq._state.piped, false, 'wrong token must not parse the body');
    assert.strictEqual(cap.errors.length, 0, 'wrong token must not alert or log a parse error');
    assert.strictEqual(cap.warns.length, 1);
    assert.strictEqual(
      cap.warns[0],
      'email-inbound: rejected unauthenticated request /api/email-inbound'
    );
    assertNoSecretLeak(cap.all());

    // 2b. Secret set, token missing. Different length than the secret.
    cap.warns.length = 0;
    cap.logs.length = 0;
    cap.errors.length = 0;
    var missingReq = fakeReq({}, '/api/email-inbound?token=' + SECRET);
    var missingRes = fakeRes();
    await handler(missingReq, missingRes);
    assert.strictEqual(missingRes.statusCode, 401);
    assert.deepStrictEqual(missingRes.body, { error: 'Unauthorized' });
    assert.strictEqual(missingReq._state.piped, false, 'missing token must not parse the body');
    assert.strictEqual(cap.errors.length, 0);
    assert.strictEqual(
      cap.warns[0],
      'email-inbound: rejected unauthenticated request /api/email-inbound'
    );
    assertNoSecretLeak(cap.all());

    // 3. Secret not set: refuse the request, one warning, body is not parsed.
    delete process.env.INBOUND_WEBHOOK_SECRET;
    cap.warns.length = 0;
    cap.logs.length = 0;
    cap.errors.length = 0;
    var openReq = fakeReq({}, 'https://fleetmagnify.com/api/email-inbound?token=' + SECRET);
    var openRes = fakeRes();
    await handler(openReq, openRes);
    assert.strictEqual(openRes.statusCode, 503);
    assert.deepStrictEqual(openRes.body, { error: 'Inbound webhook is not configured' });
    assert.strictEqual(openReq._state.piped, false, 'unset secret must not parse the body');
    var unauthWarns = cap.warns.filter(function(line) {
      return line === 'email-inbound: INBOUND_WEBHOOK_SECRET is not set; refusing the request';
    });
    assert.strictEqual(unauthWarns.length, 1, 'warn once per invocation');
    assertNoSecretLeak(cap.all());

    cap.warns.length = 0;
    var openReq2 = fakeReq({});
    var openRes2 = fakeRes();
    await handler(openReq2, openRes2);
    assert.strictEqual(openRes2.statusCode, 503);
    assert.strictEqual(openReq2._state.piped, false);
    assert.strictEqual(
      cap.warns.filter(function(line) {
        return line === 'email-inbound: INBOUND_WEBHOOK_SECRET is not set; refusing the request';
      }).length,
      1,
      'a second invocation warns once more, not zero'
    );

    console.log('✓ inbound webhook auth: correct token, wrong or missing token, secret unset');
  } finally {
    cap.restore();
    if (previous === undefined) delete process.env.INBOUND_WEBHOOK_SECRET;
    else process.env.INBOUND_WEBHOOK_SECRET = previous;
  }
}

main().then(function() {
  console.log('\nAll inbound auth tests passed.');
}).catch(function(err) {
  console.error('\nFAILED:', err);
  process.exit(1);
});
