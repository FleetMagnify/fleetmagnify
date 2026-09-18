/**
 * Subscription guard fail-closed + checkout webhook customer_id capture.
 *
 *   node scripts/test-subscription-access.js
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');

var guard = require('../js/subscription-guard');
var webhook = require('../api/stripe-webhook');

var now = Date.parse('2026-09-18T00:00:00.000Z');
var day = 24 * 60 * 60 * 1000;

function check(label, condition, detail) {
  assert.ok(condition, label + (detail ? ' — ' + detail : ''));
  console.log('[PASS] ' + label + (detail ? ' — ' + detail : ''));
}

console.log('\n=== Guard: fail closed ===');

check(
  'New signup with no subscription and no trial_ends_at is blocked',
  guard.hasAccess({ subscription_status: 'free', trial_ends_at: null }, now) === false
);
check(
  'Missing profile is blocked',
  guard.hasAccess(null, now) === false
);
check(
  'Empty trial_ends_at string is blocked',
  guard.hasAccess({ subscription_status: null, trial_ends_at: '' }, now) === false
);

console.log('\n=== Guard: trial window ===');

check(
  'Trial length is 10 days (terms-of-service.html §3, not an assumed 14)',
  guard.TRIAL_DAYS === 10
);

var signupAt = new Date(now);
var trialEnds = guard.trialEndsAtFrom(signupAt);
var trialEndsMs = Date.parse(trialEnds);
check(
  'trialEndsAtFrom is 10 days after signup',
  trialEndsMs === now + 10 * day,
  trialEnds
);

check(
  'Signup inside the trial window is allowed',
  guard.hasAccess({ subscription_status: 'free', trial_ends_at: trialEnds }, now + 5 * day) === true
);
check(
  'Signup on the last instant of the trial is still allowed',
  guard.hasAccess({ subscription_status: 'free', trial_ends_at: trialEnds }, trialEndsMs) === true
);
check(
  'Signup past the trial window is blocked',
  guard.hasAccess({ subscription_status: 'free', trial_ends_at: trialEnds }, trialEndsMs + 1) === false
);

console.log('\n=== Guard: active always allowed (ILS / Monro pattern) ===');

check(
  'subscription_status active with null trial_ends_at is allowed',
  guard.hasAccess({ subscription_status: 'active', trial_ends_at: null }, now) === true
);
check(
  'subscription_status active with expired trial_ends_at is allowed',
  guard.hasAccess({ subscription_status: 'active', trial_ends_at: '2020-01-01T00:00:00.000Z' }, now) === true
);
check(
  'subscription_status active with a future trial_ends_at is allowed',
  guard.hasAccess({ subscription_status: 'active', trial_ends_at: trialEnds }, now) === true
);

console.log('\n=== signup.html writes a real trial ===');

var signupPage = fs.readFileSync(path.join(__dirname, '..', 'signup.html'), 'utf8');
check(
  'signup.html loads subscription-guard.js',
  /<script src="js\/subscription-guard\.js"><\/script>/.test(signupPage)
);
check(
  'signup.html profile insert sets trial_ends_at from the shared helper',
  /trial_ends_at:\s*window\.FleetMagnifySubscriptionGuard\.trialEndsAtFrom\(new Date\(\)\)/.test(signupPage)
);

console.log('\n=== checkout.session.completed writes both Stripe ids ===');

var extra = webhook.extraFieldsForCheckoutSession({
  customer: 'cus_test_123',
  subscription: 'sub_test_456'
});
check(
  'extraFieldsForCheckoutSession includes stripe_customer_id',
  extra.stripe_customer_id === 'cus_test_123',
  JSON.stringify(extra)
);
check(
  'extraFieldsForCheckoutSession includes stripe_subscription_id',
  extra.stripe_subscription_id === 'sub_test_456',
  JSON.stringify(extra)
);

var recorded = [];
var fakeSupabase = {
  from: function (table) {
    return {
      update: function (payload) {
        return {
          eq: function (column, value) {
            recorded.push({ table: table, payload: payload, column: column, value: value });
            return Promise.resolve({ error: null });
          }
        };
      }
    };
  }
};

var userId = 'user-abc';
webhook.processStripeEvent(fakeSupabase, {
  type: 'checkout.session.completed',
  data: {
    object: {
      customer: 'cus_live_1',
      subscription: 'sub_live_2',
      metadata: { supabase_user_id: userId }
    }
  }
}).then(function () {
  check('checkout.session.completed updates profiles', recorded.length === 1 && recorded[0].table === 'profiles');
  check(
    'profile row is addressed by user id',
    recorded[0].column === 'id' && recorded[0].value === userId
  );
  check(
    'subscription_status is set to active',
    recorded[0].payload.subscription_status === 'active'
  );
  check(
    'stripe_customer_id is written from session.customer',
    recorded[0].payload.stripe_customer_id === 'cus_live_1',
    JSON.stringify(recorded[0].payload)
  );
  check(
    'stripe_subscription_id is written from session.subscription',
    recorded[0].payload.stripe_subscription_id === 'sub_live_2',
    JSON.stringify(recorded[0].payload)
  );
  console.log('\nAll subscription access tests passed.');
}).catch(function (err) {
  console.error('\nFAILED:', err && err.message ? err.message : err);
  process.exit(1);
});
