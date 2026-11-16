/**
 * Admin sign-in is a Supabase access token plus the ADMIN_USER_IDS allowlist.
 * Invented ids only. No network.
 *
 *   node scripts/test-admin-auth.js
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');

var auth = require('../lib/admin-auth');
var adminUsers = require('../api/admin-users');
var bulkImport = require('../api/bulk-import');
var invoice = require('../api/create-invoice-subscription');
var missing = require('../api/check-missing-reports');
var syncQuantities = require('../api/sync-subscription-quantities');

var ADMIN_ID = '11111111-1111-4111-8111-111111111111';
var OTHER_ID = '22222222-2222-4222-8222-222222222222';
var ADMIN_EMAIL = 'admin@example.test';
var TOKEN = 'test-access-token';

function fakeSupabase(user, error) {
  var calls = [];
  return {
    calls: calls,
    auth: {
      getUser: async function (token) {
        calls.push(token);
        if (error) return { data: { user: null }, error: error };
        return { data: { user: user }, error: null };
      }
    }
  };
}

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader: function (name, value) { this.headers[name] = value; return this; },
    status: function (code) { this.statusCode = code; return this; },
    json: function (body) { this.body = body; return this; },
    end: function () { return this; }
  };
}

function call(handler, req) {
  var res = mockRes();
  return handler(req, res).then(function () { return res; });
}

var previousAllow = process.env.ADMIN_USER_IDS;
var previousCron = process.env.CRON_SECRET;

function restoreEnv() {
  if (previousAllow === undefined) delete process.env.ADMIN_USER_IDS;
  else process.env.ADMIN_USER_IDS = previousAllow;
  if (previousCron === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = previousCron;
}

var steps = [];
function check(label, fn) {
  steps.push({ label: label, fn: fn });
}

check('parseAdminUserIds trims, lower-cases, and drops empties and duplicates', function () {
  assert.deepStrictEqual(auth.parseAdminUserIds({ ADMIN_USER_IDS: undefined }), []);
  assert.deepStrictEqual(auth.parseAdminUserIds({}), []);
  assert.deepStrictEqual(auth.parseAdminUserIds({ ADMIN_USER_IDS: '' }), []);
  assert.deepStrictEqual(auth.parseAdminUserIds({ ADMIN_USER_IDS: ' , , ' }), []);
  assert.deepStrictEqual(auth.parseAdminUserIds({
    ADMIN_USER_IDS: ' ' + ADMIN_ID.toUpperCase() + ' , ' + ADMIN_ID + ' , ' + OTHER_ID.toUpperCase() + ' ,'
  }), [ADMIN_ID, OTHER_ID]);
});

check('a missing Authorization header is 401', function () {
  return auth.requireAdminUser({ headers: {} }, {
    supabase: fakeSupabase({ id: ADMIN_ID, email: ADMIN_EMAIL }),
    env: { ADMIN_USER_IDS: ADMIN_ID }
  }).then(function (result) {
    assert.deepStrictEqual(result, { ok: false, status: 401, error: 'Unauthorized' });
  });
});

check('a malformed Authorization header is 401', function () {
  var supabase = fakeSupabase({ id: ADMIN_ID, email: ADMIN_EMAIL });
  return Promise.all(['Bearer', 'Bearer ', 'Token ' + TOKEN, 'Bearer ' + TOKEN + ' extra'].map(function (header) {
    return auth.requireAdminUser({ headers: { authorization: header } }, {
      supabase: supabase,
      env: { ADMIN_USER_IDS: ADMIN_ID }
    });
  })).then(function (results) {
    results.forEach(function (result) {
      assert.strictEqual(result.status, 401);
      assert.strictEqual(result.ok, false);
    });
    assert.strictEqual(supabase.calls.length, 0);
  });
});

check('an invalid token is 401 and the token is passed to getUser', function () {
  var supabase = fakeSupabase(null, { message: 'invalid' });
  var logs = [];
  var original = console.log;
  console.log = function () { logs.push(Array.prototype.join.call(arguments, ' ')); };
  return auth.requireAdminUser({ headers: { authorization: 'Bearer ' + TOKEN } }, {
    supabase: supabase,
    env: { ADMIN_USER_IDS: ADMIN_ID }
  }).then(function (result) {
    console.log = original;
    assert.strictEqual(result.status, 401);
    assert.deepStrictEqual(supabase.calls, [TOKEN]);
    assert.strictEqual(logs.join('\n').indexOf(TOKEN), -1);
  }).catch(function (err) {
    console.log = original;
    throw err;
  });
});

check('a valid user who is not on the allowlist is 403', function () {
  return auth.requireAdminUser({ headers: { authorization: 'Bearer ' + TOKEN } }, {
    supabase: fakeSupabase({ id: OTHER_ID, email: 'person@example.test' }),
    env: { ADMIN_USER_IDS: ADMIN_ID }
  }).then(function (result) {
    assert.deepStrictEqual(result, { ok: false, status: 403, error: 'Not authorised' });
  });
});

check('a valid allowlisted token is accepted, including mixed-case ids', function () {
  return auth.requireAdminUser({ headers: { authorization: 'Bearer ' + TOKEN } }, {
    supabase: fakeSupabase({ id: ADMIN_ID.toUpperCase(), email: ADMIN_EMAIL }),
    env: { ADMIN_USER_IDS: ' ' + ADMIN_ID + ' , ' + ADMIN_ID + ' ' }
  }).then(function (result) {
    assert.deepStrictEqual(result, { ok: true, userId: ADMIN_ID.toUpperCase(), email: ADMIN_EMAIL });
  });
});

check('an unset or empty allowlist makes nobody an admin', function () {
  var supabase = fakeSupabase({ id: ADMIN_ID, email: ADMIN_EMAIL });
  return auth.requireAdminUser({ headers: { authorization: 'Bearer ' + TOKEN } }, {
    supabase: supabase,
    env: {}
  }).then(function (unset) {
    assert.strictEqual(unset.status, 403);
    return auth.requireAdminUser({ headers: { authorization: 'Bearer ' + TOKEN } }, {
      supabase: supabase,
      env: { ADMIN_USER_IDS: '' }
    });
  }).then(function (empty) {
    assert.strictEqual(empty.status, 403);
    assert.strictEqual(empty.ok, false);
  });
});

check('the old shared-password header alone is rejected by every admin endpoint', function () {
  var headerOnly = { 'x-admin-secret': 'old-shared-password' };
  return Promise.all([
    call(adminUsers, { method: 'GET', headers: headerOnly }),
    call(adminUsers, { method: 'POST', headers: headerOnly, body: { email: ADMIN_EMAIL } }),
    call(bulkImport, { method: 'POST', headers: headerOnly }),
    call(invoice, { method: 'POST', headers: headerOnly, body: { userId: OTHER_ID, email: 'person@example.test', bypassAssetMinimum: true } }),
    call(missing, { method: 'GET', headers: headerOnly, query: {} }),
    call(missing, { method: 'POST', headers: headerOnly, query: { dryRun: '1' }, url: '/api/check-missing-reports?dryRun=1' }),
    call(syncQuantities, { method: 'GET', headers: headerOnly }),
    call(syncQuantities, { method: 'POST', headers: headerOnly })
  ]).then(function (responses) {
    responses.forEach(function (res) {
      assert.strictEqual(res.statusCode, 401);
      assert.strictEqual(res.body.error, 'Unauthorized');
    });
  });
});

check('cron still authorises the quiet-feed check and dryRun stays admin-only', function () {
  process.env.CRON_SECRET = 'cron-test-secret';
  process.env.ADMIN_USER_IDS = ADMIN_ID;
  var calls = 0;
  var adminAuth = {
    auth: {
      getUser: async function () {
        calls += 1;
        return { data: { user: { id: ADMIN_ID, email: ADMIN_EMAIL } }, error: null };
      }
    }
  };
  return missing.isAuthorized({
    headers: { authorization: 'Bearer cron-test-secret', 'x-admin-secret': 'old-shared-password' }
  }, { adminAuth: adminAuth }).then(function (cronOk) {
    assert.strictEqual(cronOk, true);
    assert.strictEqual(calls, 0);
    return missing.isDryRun({
      method: 'POST',
      headers: { authorization: 'Bearer cron-test-secret' },
      query: { dryRun: '1' }
    }, { adminAuth: fakeSupabase(null, { message: 'invalid' }) });
  }).then(function (cronDry) {
    assert.strictEqual(cronDry, false);
    return missing.isDryRun({
      method: 'POST',
      headers: { authorization: 'Bearer ' + TOKEN },
      query: { dryRun: '1' }
    }, { adminAuth: fakeSupabase({ id: ADMIN_ID, email: ADMIN_EMAIL }) });
  }).then(function (adminDry) {
    assert.strictEqual(adminDry, true);
    return missing.isAuthorized({
      headers: { authorization: 'Bearer wrong', 'x-admin-secret': 'old-shared-password' }
    }, { adminAuth: fakeSupabase(null, { message: 'invalid' }) });
  }).then(function (rejected) {
    assert.strictEqual(rejected, false);
  });
});

check('api, lib, and the admin pages no longer mention the shared password', function () {
  var root = path.join(__dirname, '..');
  var files = [path.join(root, 'admin.html'), path.join(root, 'bulk-import.html')];
  function walk(dir) {
    fs.readdirSync(dir).forEach(function (name) {
      var full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else files.push(full);
    });
  }
  walk(path.join(root, 'api'));
  walk(path.join(root, 'lib'));
  var banned = ['x-admin-secret', 'ADMIN_SECRET', 'fm_admin_secret'];
  files.forEach(function (file) {
    var text = fs.readFileSync(file, 'utf8');
    banned.forEach(function (needle) {
      assert.strictEqual(text.indexOf(needle), -1, path.relative(root, file) + ' still contains ' + needle);
    });
  });
});

steps.reduce(function (chain, step) {
  return chain.then(function () {
    return Promise.resolve().then(step.fn).then(function () {
      console.log('[PASS] ' + step.label);
    });
  });
}, Promise.resolve()).then(function () {
  restoreEnv();
  console.log('\nAll admin auth tests passed.');
}).catch(function (err) {
  restoreEnv();
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
