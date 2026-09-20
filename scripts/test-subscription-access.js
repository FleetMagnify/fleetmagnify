/**
 * Subscription guard, webhook status transitions, and quantity-sync helpers.
 *
 *   node scripts/test-subscription-access.js
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');

var guard = require('../js/subscription-guard');
var webhook = require('../api/stripe-webhook');
var sync = require('../lib/sync-subscription-quantity');

var now = Date.parse('2026-09-18T00:00:00.000Z');
var day = 24 * 60 * 60 * 1000;

function check(label, condition, detail) {
  assert.ok(condition, label + (detail ? ' — ' + detail : ''));
  console.log('[PASS] ' + label + (detail ? ' — ' + detail : ''));
}

function fakeSupabase(options) {
  options = options || {};
  var recorded = options.recorded || [];
  return {
    recorded: recorded,
    from: function (table) {
      return {
        select: function () {
          return {
            eq: function (col, val) {
              return {
                maybeSingle: function () {
                  var row = null;
                  if (col === 'stripe_customer_id' && options.customers) {
                    row = options.customers[val] || null;
                  } else if (col === 'stripe_subscription_id' && options.subscriptions) {
                    row = options.subscriptions[val] || null;
                  }
                  return Promise.resolve({ data: row || null, error: null });
                }
              };
            }
          };
        },
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

console.log('\n=== Guard: Stripe-native trialing + dunning past_due ===');

check(
  'trialing grants access (Stripe-native 10-day trial)',
  guard.hasAccess({ subscription_status: 'trialing', trial_ends_at: null }, now) === true
);
check(
  'past_due grants access (Stripe is still retrying the card)',
  guard.hasAccess({ subscription_status: 'past_due', trial_ends_at: null }, now) === true
);
check(
  'cancelled (British, existing DB spelling) blocks access',
  guard.hasAccess({ subscription_status: 'cancelled', trial_ends_at: null }, now) === false
);
check(
  'canceled (Stripe spelling) blocks access',
  guard.hasAccess({ subscription_status: 'canceled', trial_ends_at: null }, now) === false
);
check(
  'unpaid (dunning exhausted) blocks access',
  guard.hasAccess({ subscription_status: 'unpaid', trial_ends_at: null }, now) === false
);
check(
  'incomplete_expired blocks access',
  guard.hasAccess({ subscription_status: 'incomplete_expired', trial_ends_at: null }, now) === false
);
check(
  'terminal cancelled wins over a still-valid old trial_ends_at',
  guard.hasAccess({ subscription_status: 'cancelled', trial_ends_at: trialEnds }, now) === false
);
check(
  'old-model null status + valid trial_ends_at still allowed (coexistence)',
  guard.hasAccess({ subscription_status: null, trial_ends_at: trialEnds }, now) === true
);

console.log('\n=== signup.html card-upfront Checkout ===');

var signupPage = fs.readFileSync(path.join(__dirname, '..', 'signup.html'), 'utf8');
check(
  'signup.html loads subscription-guard.js',
  /<script src="js\/subscription-guard\.js"><\/script>/.test(signupPage)
);
check(
  'signup.html no longer writes a homegrown trial_ends_at (card-upfront + Stripe trial)',
  !/trial_ends_at:\s*window\.FleetMagnifySubscriptionGuard\.trialEndsAtFrom/.test(signupPage)
);
check(
  'signup.html starts a real Stripe Checkout session',
  /\/api\/create-checkout-session/.test(signupPage)
);
check(
  'signup.html requests Stripe-native trial_period_days: 10',
  /trialPeriodDays:\s*10/.test(signupPage)
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

check(
  'checkout.session.completed payload has no subscription.status unless expanded',
  webhook.checkoutSubscriptionStatus({ subscription: 'sub_test_456' }) === null
);
check(
  'expanded trial subscription on the session is read as trialing',
  webhook.checkoutSubscriptionStatus({ subscription: { id: 'sub_trial', status: 'trialing' } }) === 'trialing'
);

var recorded = [];
var fake = fakeSupabase({ recorded: recorded });
var userId = 'user-abc';

webhook.processStripeEvent(fake, {
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
    'unexpanded checkout session defaults to active (upgrade / paid path)',
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

  recorded.length = 0;
  return webhook.processStripeEvent(fake, {
    type: 'checkout.session.completed',
    data: {
      object: {
        customer: 'cus_trial_1',
        subscription: { id: 'sub_trial_2', status: 'trialing' },
        metadata: { supabase_user_id: userId }
      }
    }
  });
}).then(function () {
  check(
    'trialing Checkout writes subscription_status=trialing',
    recorded.length === 1 && recorded[0].payload.subscription_status === 'trialing',
    recorded[0] && JSON.stringify(recorded[0].payload)
  );
  check(
    'trialing Checkout still persists the subscription id',
    recorded[0].payload.stripe_subscription_id === 'sub_trial_2'
  );

  recorded.length = 0;
  return webhook.processStripeEvent(fake, {
    type: 'checkout.session.completed',
    data: {
      object: {
        customer: 'cus_retrieved',
        subscription: 'sub_retrieved',
        metadata: { supabase_user_id: userId }
      }
    }
  }, {
    retrieveSubscription: function (id) {
      check('retrieveSubscription is used when session.subscription is an id', id === 'sub_retrieved');
      return Promise.resolve({ id: id, status: 'trialing' });
    }
  });
}).then(function () {
  check(
    'retrieved subscription status wins over the active default',
    recorded[0].payload.subscription_status === 'trialing'
  );

  console.log('\n=== customer.subscription.updated ===');
  recorded.length = 0;
  return webhook.processStripeEvent(fake, {
    type: 'customer.subscription.updated',
    data: {
      object: {
        id: 'sub_live_2',
        status: 'active',
        customer: 'cus_live_1',
        metadata: { supabase_user_id: userId }
      }
    }
  });
}).then(function () {
  check(
    'subscription.updated trialing→active writes active',
    recorded[0].payload.subscription_status === 'active',
    recorded[0] && JSON.stringify(recorded[0].payload)
  );

  recorded.length = 0;
  return webhook.processStripeEvent(fake, {
    type: 'customer.subscription.updated',
    data: {
      object: {
        id: 'sub_live_2',
        status: 'trialing',
        customer: 'cus_live_1',
        metadata: { supabase_user_id: userId }
      }
    }
  });
}).then(function () {
  check(
    'subscription.updated can write trialing',
    recorded[0].payload.subscription_status === 'trialing'
  );

  recorded.length = 0;
  return webhook.processStripeEvent(fake, {
    type: 'customer.subscription.updated',
    data: {
      object: {
        id: 'sub_live_2',
        status: 'past_due',
        customer: 'cus_live_1',
        metadata: { supabase_user_id: userId }
      }
    }
  });
}).then(function () {
  check(
    'subscription.updated card-failure path writes past_due (access still granted)',
    recorded[0].payload.subscription_status === 'past_due'
  );

  recorded.length = 0;
  return webhook.processStripeEvent(fake, {
    type: 'customer.subscription.updated',
    data: {
      object: {
        id: 'sub_live_2',
        status: 'canceled',
        customer: 'cus_live_1',
        metadata: { supabase_user_id: userId }
      }
    }
  });
}).then(function () {
  check(
    'subscription.updated terminal canceled maps to cancelled and clears sub id',
    recorded[0].payload.subscription_status === 'cancelled' &&
      recorded[0].payload.stripe_subscription_id === null
  );

  console.log('\n=== invoice.payment_succeeded $0 trial invoice ===');
  recorded.length = 0;
  var paidFake = fakeSupabase({
    recorded: recorded,
    customers: { cus_live_1: { id: userId } }
  });
  return webhook.processStripeEvent(paidFake, {
    type: 'invoice.payment_succeeded',
    data: {
      object: {
        customer: 'cus_live_1',
        amount_paid: 0,
        billing_reason: 'subscription_create'
      }
    }
  });
}).then(function () {
  check(
    '$0 trial invoice.payment_succeeded does not flip the profile to active',
    recorded.length === 0,
    'writes=' + recorded.length
  );

  recorded.length = 0;
  var paidFake = fakeSupabase({
    recorded: recorded,
    customers: { cus_live_1: { id: userId } }
  });
  return webhook.processStripeEvent(paidFake, {
    type: 'invoice.payment_succeeded',
    data: {
      object: {
        customer: 'cus_live_1',
        amount_paid: 4900,
        billing_reason: 'subscription_cycle'
      }
    }
  });
}).then(function () {
  check(
    'real invoice.payment_succeeded still writes active',
    recorded.length === 1 && recorded[0].payload.subscription_status === 'active'
  );

  console.log('\n=== invoice.upcoming triggers quantity sync ===');
  var synced = [];
  var upcomingFake = fakeSupabase({
    customers: { cus_live_1: { id: userId } }
  });
  return webhook.processStripeEvent(upcomingFake, {
    type: 'invoice.upcoming',
    data: {
      object: {
        customer: 'cus_live_1',
        subscription: 'sub_live_2'
      }
    }
  }, {
    syncQuantityForUser: function (uid, subId) {
      synced.push({ uid: uid, subId: subId });
      return Promise.resolve({ changed: true });
    }
  }).then(function () {
    check('invoice.upcoming syncs the matching user', synced.length === 1 && synced[0].uid === userId);
    check('invoice.upcoming syncs that subscription id', synced[0].subId === 'sub_live_2');
  });
}).then(function () {
  console.log('\n=== Quantity sync from a simulated asset list ===');

  var assets = [
    { id: 1, is_ignored: false },
    { id: 2, is_ignored: false },
    { id: 3, is_ignored: true },
    { id: 4, is_ignored: false }
  ];
  check(
    'countBillableAssets ignores ignored rows',
    sync.countBillableAssets(assets) === 3
  );
  check(
    'countBillableAssets treats missing is_ignored as billable',
    sync.countBillableAssets([{ id: 1 }, { id: 2, is_ignored: false }]) === 2
  );
  check(
    'target quantity for 3 assets is 3',
    sync.targetSubscriptionQuantity(3) === 3
  );
  check(
    'target quantity floors at 1 (Stripe rejects quantity 0)',
    sync.targetSubscriptionQuantity(0) === 1
  );
  check(
    'empty asset list floors at 1',
    sync.targetSubscriptionQuantity(sync.countBillableAssets([])) === 1
  );

  return sync.syncUserSubscription({
    userId: 'user-fleet',
    subscriptionId: 'sub_fleet',
    supabase: {
      from: function () {
        return {
          select: function () {
            return {
              eq: function () {
                return Promise.resolve({
                  data: [
                    { id: 1, is_ignored: false },
                    { id: 2, is_ignored: false },
                    { id: 3, is_ignored: true },
                    { id: 4, is_ignored: false },
                    { id: 5, is_ignored: false }
                  ],
                  error: null
                });
              }
            };
          }
        };
      }
    },
    stripe: {
      subscriptions: {
        retrieve: function () {
          return Promise.resolve({
            id: 'sub_fleet',
            items: { data: [{ id: 'si_1', quantity: 1 }] }
          });
        },
        update: function (id, params) {
          this.lastUpdate = { id: id, params: params };
          return Promise.resolve({ id: id });
        },
        lastUpdate: null
      }
    }
  }).then(function (outcome) {
    check('sync reports a change when quantity differs', outcome.changed === true);
    check('sync computes 4 billable assets', outcome.billableAssets === 4);
    check('sync target quantity is 4', outcome.to === 4);
    check('sync previous quantity was 1', outcome.from === 1);
  });
}).then(function () {
  return sync.syncUserSubscription({
    userId: 'user-same',
    subscriptionId: 'sub_same',
    supabase: {
      from: function () {
        return {
          select: function () {
            return {
              eq: function () {
                return Promise.resolve({
                  data: [{ id: 1, is_ignored: false }],
                  error: null
                });
              }
            };
          }
        };
      }
    },
    stripe: {
      subscriptions: {
        retrieve: function () {
          return Promise.resolve({
            id: 'sub_same',
            items: { data: [{ id: 'si_1', quantity: 1 }] }
          });
        },
        update: function () {
          throw new Error('should not update when quantity already matches');
        }
      }
    }
  }).then(function (outcome) {
    check('sync is a no-op when Stripe quantity already matches', outcome.changed === false);
    check('unchanged sync still reports the matching quantity', outcome.quantity === 1);
  });
}).then(function () {
  console.log('\n=== Quantity sync isolates per-user Stripe failures ===');

  var updates = [];
  var batchProfiles = [
    { id: 'user-ok-1', stripe_subscription_id: 'sub-ok-1', subscription_status: 'trialing' },
    { id: 'user-bad', stripe_subscription_id: 'sub-bad', subscription_status: 'active' },
    { id: 'user-ok-2', stripe_subscription_id: 'sub-ok-2', subscription_status: 'past_due' }
  ];

  return sync.syncAllBillableSubscriptions({
    supabase: {
      from: function (table) {
        if (table === 'profiles') {
          return {
            select: function () {
              return {
                in: function () {
                  return {
                    not: function () {
                      return Promise.resolve({ data: batchProfiles, error: null });
                    }
                  };
                }
              };
            }
          };
        }
        return {
          select: function () {
            return {
              eq: function () {
                return Promise.resolve({
                  data: [{ id: 1, is_ignored: false }, { id: 2, is_ignored: false }],
                  error: null
                });
              }
            };
          }
        };
      }
    },
    stripe: {
      subscriptions: {
        retrieve: function (id) {
          if (id === 'sub-bad') {
            return Promise.reject(new Error('No such subscription: sub-bad'));
          }
          return Promise.resolve({
            id: id,
            items: { data: [{ id: 'si-' + id, quantity: 1 }] }
          });
        },
        update: function (id, params) {
          updates.push({ id: id, quantity: params.items[0].quantity });
          return Promise.resolve({ id: id });
        }
      }
    }
  }).then(function (summary) {
    check('batch sync does not reject when one retrieve throws', !!summary);
    check('scanned includes the failing profile', summary.scanned === 3);
    check('two successful quantity updates still ran', updates.length === 2);
    check(
      'successful updates are the two good subscriptions',
      updates[0].id === 'sub-ok-1' && updates[1].id === 'sub-ok-2',
      JSON.stringify(updates)
    );
    check('changed count is 2', summary.changed === 2);
    check('failed count is 1', summary.failed === 1);
    var failedRow = summary.results.filter(function (row) { return row.reason === 'sync_threw'; })[0];
    check('failure is captured on the bad user', !!(failedRow && failedRow.userId === 'user-bad'));
    check(
      'failure records the Stripe error message',
      !!(failedRow && failedRow.error && failedRow.error.indexOf('No such subscription') !== -1)
    );
    check('failure is not marked changed', !!(failedRow && failedRow.changed === false));
  });
}).then(function () {
  var vercel = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
  check(
    'vercel.json has a daily cron for quantity reconciliation',
    vercel.crons &&
      vercel.crons.some(function (job) {
        return job.path === '/api/sync-subscription-quantities';
      })
  );

  var adminPage = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
  check(
    'admin.html can trigger invoice billing with the asset-count bypass',
    /bypassAssetMinimum:\s*true/.test(adminPage)
  );

  console.log('\nAll subscription access tests passed.');
}).catch(function (err) {
  console.error('\nFAILED:', err && err.message ? err.message : err);
  process.exit(1);
});
