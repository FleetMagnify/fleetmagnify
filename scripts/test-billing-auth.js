/**
 * Sign-in on the checkout and invoice endpoints.
 * Supabase and Stripe are in-memory. No network.
 * Invented ids only.
 *
 *   node scripts/test-billing-auth.js
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var Module = require('module');

var OWNER = '00000000-0000-4000-8000-0000000000a1';
var BODY_USER = '00000000-0000-4000-8000-0000000000b2';
var OWNER_EMAIL = 'owner-a1@example.com';
var BODY_EMAIL = 'other-b2@example.com';
var TOKEN = 'test-access-token';
var DEFAULT_SUCCESS = 'https://fleetmagnify.com/home.html?upgraded=1';
var DEFAULT_CANCEL = 'https://fleetmagnify.com/upgrade.html';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
process.env.STRIPE_SECRET_KEY = 'sk_test_example';
process.env.STRIPE_PRICE_PLATFORM = 'price_platform_test';
process.env.ADMIN_SECRET = 'test-admin-secret';

var state = {};

function reset() {
  state.user = { id: OWNER, email: OWNER_EMAIL };
  state.profile = {
    id: OWNER,
    stripe_customer_id: null,
    company_name: 'Example Quarry',
    subscription_status: null,
    trial_ends_at: null,
    stripe_subscription_id: null
  };
  state.member = null;
  state.assetCount = 12;
  state.customers = [];
  state.customerUpdates = [];
  state.sessions = [];
  state.subscriptions = [];
  state.profileUpdates = [];
  state.profileLookups = [];
  state.memberLookups = [];
  state.assetLookups = [];
  state.getUserCalls = 0;
  state.authClients = 0;
}

function eqValue(filters, column) {
  for (var i = 0; i < filters.length; i++) {
    if (filters[i][0] === column) return filters[i][1];
  }
  return null;
}

function createClient(url, key, options) {
  var authHeader = options && options.global && options.global.headers && options.global.headers.Authorization;
  if (authHeader) state.authClients += 1;
  return {
    auth: {
      getUser: async function() {
        state.getUserCalls += 1;
        var token = String(authHeader || '').replace('Bearer ', '').trim();
        if (token && token === TOKEN && state.user) {
          return { data: { user: state.user }, error: null };
        }
        return { data: { user: null }, error: { message: 'invalid' } };
      }
    },
    from: function(table) {
      var op = 'select';
      var payload = null;
      var filters = [];
      var finished = false;
      var result = null;
      function finish() {
        if (finished) return result;
        finished = true;
        if (table === 'profiles' && op === 'select') {
          var id = eqValue(filters, 'id');
          state.profileLookups.push(id);
          result = state.profile && state.profile.id === id
            ? { data: state.profile, error: null }
            : { data: null, error: null };
        } else if (table === 'profiles' && op === 'update') {
          var updateId = eqValue(filters, 'id');
          state.profileUpdates.push({ id: updateId, payload: payload });
          result = { data: null, error: null };
        } else if (table === 'account_members') {
          var memberId = eqValue(filters, 'member_auth_user_id');
          state.memberLookups.push(memberId);
          result = state.member && state.member.member_auth_user_id === memberId
            ? { data: state.member, error: null }
            : { data: null, error: null };
        } else if (table === 'assets') {
          state.assetLookups.push(eqValue(filters, 'user_id'));
          result = { data: null, error: null, count: state.assetCount };
        } else {
          result = { data: null, error: null };
        }
        return result;
      }
      var chain = {
        select: function() { op = 'select'; return chain; },
        update: function(row) { op = 'update'; payload = row; return chain; },
        eq: function(column, value) { filters.push([column, value]); return chain; },
        maybeSingle: function() { return Promise.resolve(finish()); },
        then: function(resolve, reject) { return Promise.resolve(finish()).then(resolve, reject); }
      };
      return chain;
    }
  };
}

var stripeApi = {
  customers: {
    create: async function(body) {
      state.customers.push(body);
      return { id: 'cus_test_created' };
    },
    update: async function(id, body) {
      state.customerUpdates.push({ id: id, body: body });
      return { id: id };
    }
  },
  checkout: {
    sessions: {
      create: async function(body) {
        state.sessions.push(body);
        return { id: 'cs_test', url: 'https://checkout.stripe.test/cs_test' };
      }
    }
  },
  subscriptions: {
    create: async function(body) {
      state.subscriptions.push(body);
      return { id: 'sub_test_invoice' };
    }
  }
};

function StripeCtor() {
  return stripeApi;
}

var originalRequire = Module.prototype.require;
Module.prototype.require = function(id) {
  if (id === '@supabase/supabase-js') return { createClient: createClient };
  if (id === 'stripe') return StripeCtor;
  return originalRequire.apply(this, arguments);
};

var checkout = require('../api/create-checkout-session');
var invoice = require('../api/create-invoice-subscription');
Module.prototype.require = originalRequire;

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status: function(code) { this.statusCode = code; return this; },
    json: function(body) { this.body = body; return this; }
  };
}

function call(handler, headers, body) {
  var res = mockRes();
  return handler({ method: 'POST', headers: headers || {}, body: body || {} }, res).then(function() {
    return res;
  });
}

function signedInHeaders() {
  return { authorization: 'Bearer ' + TOKEN };
}

function bodyForOtherUser(extra) {
  var body = {
    userId: BODY_USER,
    email: BODY_EMAIL,
    successUrl: 'https://example.org/x',
    cancelUrl: 'https://example.org/x'
  };
  if (extra) {
    Object.keys(extra).forEach(function(key) { body[key] = extra[key]; });
  }
  return body;
}

function assertOnlyOwner(label) {
  var blob = JSON.stringify({
    customers: state.customers,
    sessions: state.sessions,
    subscriptions: state.subscriptions,
    profileLookups: state.profileLookups,
    profileUpdates: state.profileUpdates,
    assetLookups: state.assetLookups,
    memberLookups: state.memberLookups
  });
  assert.strictEqual(blob.indexOf(BODY_USER), -1, label + ' used the body user id');
  assert.strictEqual(blob.indexOf(BODY_EMAIL), -1, label + ' used the body email');
  assert.ok(blob.indexOf(OWNER) !== -1, label + ' did not use the signed-in user');
}

reset();

var steps = [];
function check(label, fn) {
  steps.push({ label: label, fn: fn });
}

check('checkout without a token is 401', function() {
  reset();
  return call(checkout, {}, bodyForOtherUser()).then(function(res) {
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res.body.error, 'Unauthorized');
    assert.strictEqual(state.getUserCalls, 0);
    assert.strictEqual(state.sessions.length, 0);
  });
});

check('invoice without a token is 401', function() {
  reset();
  return call(invoice, {}, bodyForOtherUser()).then(function(res) {
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res.body.error, 'Unauthorized');
    assert.strictEqual(state.getUserCalls, 0);
    assert.strictEqual(state.subscriptions.length, 0);
  });
});

check('an invalid token is 401 on both endpoints', function() {
  reset();
  var headers = { authorization: 'Bearer not-the-token' };
  return call(checkout, headers, bodyForOtherUser()).then(function(checkoutRes) {
    assert.strictEqual(checkoutRes.statusCode, 401);
    assert.strictEqual(checkoutRes.body.error, 'Invalid session');
    return call(invoice, headers, bodyForOtherUser());
  }).then(function(invoiceRes) {
    assert.strictEqual(invoiceRes.statusCode, 401);
    assert.strictEqual(invoiceRes.body.error, 'Invalid session');
    assert.strictEqual(state.sessions.length, 0);
    assert.strictEqual(state.subscriptions.length, 0);
  });
});

check('checkout uses the signed-in user, not the body user', function() {
  reset();
  return call(checkout, signedInHeaders(), bodyForOtherUser()).then(function(res) {
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(state.customers.length, 1);
    assert.strictEqual(state.customers[0].email, OWNER_EMAIL);
    assert.strictEqual(state.customers[0].metadata.supabase_user_id, OWNER);
    assert.strictEqual(state.sessions.length, 1);
    assert.strictEqual(state.sessions[0].metadata.supabase_user_id, OWNER);
    assert.strictEqual(state.sessions[0].subscription_data.metadata.supabase_user_id, OWNER);
    assert.strictEqual(state.profileLookups[0], OWNER);
    assert.strictEqual(state.sessions[0].success_url, DEFAULT_SUCCESS);
    assert.strictEqual(state.sessions[0].cancel_url, DEFAULT_CANCEL);
    assert.strictEqual(state.sessions[0].line_items[0].price, 'price_platform_test');
    assertOnlyOwner('checkout');
  });
});

check('a fleetmagnify return URL is kept', function() {
  reset();
  return call(checkout, signedInHeaders(), bodyForOtherUser({
    successUrl: 'https://www.fleetmagnify.com/home.html',
    cancelUrl: 'https://fleetmagnify.com/upgrade.html'
  })).then(function(res) {
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(state.sessions[0].success_url, 'https://www.fleetmagnify.com/home.html');
    assert.strictEqual(state.sessions[0].cancel_url, 'https://fleetmagnify.com/upgrade.html');
  });
});

check('a lookalike host is not treated as an allowed return URL', function() {
  reset();
  return call(checkout, signedInHeaders(), bodyForOtherUser({
    successUrl: 'https://fleetmagnify.com.evil.example/home.html',
    cancelUrl: 'https://www.fleetmagnify.com.evil.example/upgrade.html'
  })).then(function(res) {
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(state.sessions[0].success_url, DEFAULT_SUCCESS);
    assert.strictEqual(state.sessions[0].cancel_url, DEFAULT_CANCEL);
  });
});

check('invoice uses the signed-in user, not the body user', function() {
  reset();
  return call(invoice, signedInHeaders(), bodyForOtherUser()).then(function(res) {
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.subscriptionId, 'sub_test_invoice');
    assert.strictEqual(state.assetLookups[0], OWNER);
    assert.strictEqual(state.customers[0].email, OWNER_EMAIL);
    assert.strictEqual(state.customers[0].metadata.supabase_user_id, OWNER);
    assert.strictEqual(state.subscriptions[0].metadata.supabase_user_id, OWNER);
    assert.strictEqual(state.subscriptions[0].items[0].price, 'price_platform_test');
    assert.strictEqual(state.profileLookups[0], OWNER);
    var statusWrite = state.profileUpdates.filter(function(update) {
      return update.payload && update.payload.subscription_status === 'active';
    })[0];
    assert.ok(statusWrite, 'invoice endpoint still records the profile status');
    assert.strictEqual(statusWrite.id, OWNER);
    assert.strictEqual(statusWrite.payload.stripe_subscription_id, 'sub_test_invoice');
    assertOnlyOwner('invoice');
  });
});

check('an account member is rejected on both endpoints', function() {
  reset();
  state.member = { member_auth_user_id: OWNER, account_owner_user_id: BODY_USER };
  state.assetCount = 0;
  return call(checkout, signedInHeaders(), bodyForOtherUser()).then(function(checkoutRes) {
    assert.strictEqual(checkoutRes.statusCode, 403);
    assert.strictEqual(checkoutRes.body.error, 'Billing is managed by your account owner');
    assert.strictEqual(state.sessions.length, 0);
    return call(invoice, signedInHeaders(), bodyForOtherUser());
  }).then(function(invoiceRes) {
    assert.strictEqual(invoiceRes.statusCode, 403);
    assert.strictEqual(invoiceRes.body.error, 'Billing is managed by your account owner');
    assert.strictEqual(state.subscriptions.length, 0);
    assert.strictEqual(state.assetLookups.length, 0);
  });
});

check('a valid admin secret on the invoice endpoint uses the body user', function() {
  reset();
  state.profile = {
    id: BODY_USER,
    stripe_customer_id: null,
    company_name: 'Example Quarry'
  };
  return call(invoice, { 'x-admin-secret': 'test-admin-secret' }, {
    userId: BODY_USER,
    email: BODY_EMAIL,
    bypassAssetMinimum: true
  }).then(function(res) {
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(state.getUserCalls, 0);
    assert.strictEqual(state.customers[0].email, BODY_EMAIL);
    assert.strictEqual(state.customers[0].metadata.supabase_user_id, BODY_USER);
    assert.strictEqual(state.subscriptions[0].metadata.supabase_user_id, BODY_USER);
    assert.strictEqual(state.subscriptions[0].metadata.admin_setup, 'true');
    assert.strictEqual(state.profileLookups[0], BODY_USER);
    var blob = JSON.stringify({
      customers: state.customers,
      subscriptions: state.subscriptions,
      profileLookups: state.profileLookups,
      profileUpdates: state.profileUpdates
    });
    assert.strictEqual(blob.indexOf(OWNER), -1);
    assert.ok(blob.indexOf(BODY_USER) !== -1);
  });
});

check('a wrong admin secret does not accept the body user', function() {
  reset();
  return call(invoice, { 'x-admin-secret': 'not-the-secret' }, {
    userId: BODY_USER,
    email: BODY_EMAIL,
    bypassAssetMinimum: true
  }).then(function(res) {
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(state.subscriptions.length, 0);
    assert.strictEqual(state.customers.length, 0);
  });
});

check('signup and upgrade send the session token', function() {
  var root = path.join(__dirname, '..');
  var signup = fs.readFileSync(path.join(root, 'signup.html'), 'utf8');
  var upgrade = fs.readFileSync(path.join(root, 'upgrade.html'), 'utf8');
  var login = fs.readFileSync(path.join(root, 'login.html'), 'utf8');
  var admin = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');

  var sessionAt = signup.indexOf('supabase.auth.getSession()');
  var redirectAt = signup.indexOf("window.location.href = 'login.html?next=upgrade.html'");
  var fetchAt = signup.indexOf("fetch('/api/create-checkout-session'");
  assert.ok(sessionAt !== -1 && redirectAt > sessionAt && fetchAt > redirectAt);
  assert.ok(signup.indexOf("'Authorization': 'Bearer ' + accessToken") !== -1);
  assert.ok(/trialPeriodDays:\s*window\.FleetMagnifySubscriptionGuard\.TRIAL_DAYS/.test(signup));

  assert.ok(upgrade.indexOf('supabase.auth.getSession()') !== -1);
  assert.ok(upgrade.indexOf("'Authorization': 'Bearer ' + accessToken") !== -1);
  assert.strictEqual(upgrade.split("fetch('/api/create-checkout-session'").length, 2);
  assert.strictEqual(upgrade.split("fetch('/api/create-invoice-subscription'").length, 2);
  assert.ok(upgrade.indexOf('headers: headers') !== -1);

  assert.ok(login.indexOf("get('next') === 'upgrade.html'") !== -1);
  assert.ok(login.indexOf("window.location.href = nextPage || 'home.html'") !== -1);
  assert.ok(login.indexOf('Your account is created. If you were asked to confirm your email') !== -1);

  assert.ok(admin.indexOf("'x-admin-secret': adminSecret") !== -1);
  assert.strictEqual(admin.indexOf('Authorization'), -1);
  return Promise.resolve();
});

steps.reduce(function(chain, step) {
  return chain.then(function() {
    return step.fn().then(function() {
      console.log('[PASS] ' + step.label);
    });
  });
}, Promise.resolve()).then(function() {
  console.log('\nAll billing auth tests passed.');
}).catch(function(err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
