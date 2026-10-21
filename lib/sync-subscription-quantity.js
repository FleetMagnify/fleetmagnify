/**
 * Sync a Stripe subscription's line-item quantity to the customer's
 * real non-ignored asset count. Used by the daily reconciliation job
 * and by the invoice.upcoming webhook (the charge-time sync).
 *
 * Stripe line items require quantity >= 1, so a fleet of 0 assets
 * stays at 1 (the Checkout starting quantity) rather than failing
 * the update.
 */

var stripeItems = require('./stripe-subscription-items');
var divisionBilling = require('./division-billing');

var BILLABLE_STATUSES = ['trialing', 'active', 'past_due'];

function countBillableAssets(assets) {
  var count = 0;
  (assets || []).forEach(function (asset) {
    if (!asset || asset.is_ignored === true) return;
    count += 1;
  });
  return count;
}

function targetSubscriptionQuantity(billableCount) {
  var n = Number(billableCount);
  if (!n || n < 1) return 1;
  return n;
}

function platformPriceId() {
  return process.env.STRIPE_PRICE_PLATFORM || '';
}

/**
 * The asset quantity lives on the platform price only. A divisions item,
 * or any other price, is not the truck/machine quantity.
 */
function firstSubscriptionItem(subscription) {
  return stripeItems.subscriptionItemForPrice(subscription, platformPriceId());
}

async function syncUserSubscription(opts) {
  var supabase = opts.supabase;
  var stripe = opts.stripe;
  var userId = opts.userId;
  var subscriptionId = opts.subscriptionId;

  if (!userId || !subscriptionId) {
    return { changed: false, reason: 'missing_ids' };
  }

  var assetsResult = await supabase
    .from('assets')
    .select('id, is_ignored')
    .eq('user_id', userId);

  if (assetsResult.error) {
    console.error(
      'sync-subscription-quantities: asset count failed for',
      userId,
      assetsResult.error.message
    );
    return { changed: false, reason: 'asset_count_failed', userId: userId };
  }

  var billable = countBillableAssets(assetsResult.data);
  var target = targetSubscriptionQuantity(billable);
  var subscription = await stripe.subscriptions.retrieve(subscriptionId);
  var item = firstSubscriptionItem(subscription);

  if (!item) {
    console.log(
      'sync-subscription-quantities: no platform price item on',
      subscriptionId,
      'user',
      userId
    );
    return { changed: false, reason: 'no_platform_item', userId: userId, subscriptionId: subscriptionId };
  }

  if (item.quantity === target) {
    console.log(
      'sync-subscription-quantities: unchanged user',
      userId,
      'qty',
      target,
      'billableAssets',
      billable
    );
    return {
      changed: false,
      userId: userId,
      subscriptionId: subscriptionId,
      quantity: target,
      billableAssets: billable
    };
  }

  await stripe.subscriptions.update(subscriptionId, {
    items: [{ id: item.id, quantity: target }],
    proration_behavior: 'none'
  });

  console.log(
    'sync-subscription-quantities: updated user',
    userId,
    item.quantity,
    '->',
    target,
    'billableAssets',
    billable
  );

  return {
    changed: true,
    userId: userId,
    subscriptionId: subscriptionId,
    from: item.quantity,
    to: target,
    billableAssets: billable
  };
}

async function syncAllBillableSubscriptions(opts) {
  var supabase = opts.supabase;
  var stripe = opts.stripe;

  var profilesResult = await supabase
    .from('profiles')
    .select('id, stripe_subscription_id, subscription_status')
    .in('subscription_status', BILLABLE_STATUSES)
    .not('stripe_subscription_id', 'is', null);

  if (profilesResult.error) {
    console.error(
      'sync-subscription-quantities: profile listing failed',
      profilesResult.error.message
    );
    throw new Error('Could not list billable profiles');
  }

  var profiles = profilesResult.data || [];
  var results = [];

  for (var i = 0; i < profiles.length; i++) {
    var profile = profiles[i];
    try {
      var outcome = await syncUserSubscription({
        supabase: supabase,
        stripe: stripe,
        userId: profile.id,
        subscriptionId: profile.stripe_subscription_id
      });
      results.push(outcome);
    } catch (err) {
      var message = err && err.message ? err.message : String(err);
      console.error(
        'sync-subscription-quantities: sync threw for user',
        profile.id,
        profile.stripe_subscription_id,
        message
      );
      results.push({
        changed: false,
        reason: 'sync_threw',
        userId: profile.id,
        subscriptionId: profile.stripe_subscription_id,
        error: message
      });
    }
  }

  var changed = results.filter(function (row) { return row.changed; }).length;
  var failed = results.filter(function (row) { return row.reason === 'sync_threw'; }).length;
  console.log(
    'sync-subscription-quantities: scanned',
    results.length,
    'subscriptions, updated',
    changed,
    'failed',
    failed
  );

  var divisionSummary = await reconcileDivisionQuantities({
    supabase: supabase,
    stripe: stripe,
    profiles: profiles
  });

  return {
    scanned: results.length,
    changed: changed,
    failed: failed,
    results: results,
    divisions: divisionSummary
  };
}

/**
 * Daily reconciliation for the divisions add-on. Accounts with no divisions
 * and no divisions line item are left untouched. Asset quantity sync does
 * not call this; the cron does, via syncAllBillableSubscriptions.
 */
async function reconcileDivisionQuantities(opts) {
  if (!divisionBilling.divisionPriceId()) {
    return { skipped: true, reason: 'not_configured' };
  }

  var profiles = opts.profiles || [];
  var listed = await opts.supabase.from('divisions').select('account_owner_user_id');
  if (listed.error) {
    console.error('sync-subscription-quantities: division count failed', listed.error.message);
    return { skipped: true, reason: 'count_failed' };
  }

  var counts = {};
  (listed.data || []).forEach(function (row) {
    if (!row || !row.account_owner_user_id) return;
    counts[row.account_owner_user_id] = (counts[row.account_owner_user_id] || 0) + 1;
  });

  var results = [];
  for (var i = 0; i < profiles.length; i++) {
    var profile = profiles[i];
    var count = counts[profile.id] || 0;
    try {
      var subscription = await opts.stripe.subscriptions.retrieve(profile.stripe_subscription_id);
      var item = stripeItems.subscriptionItemForPrice(subscription, divisionBilling.divisionPriceId());
      if (count === 0 && !item) {
        results.push({ action: 'untouched', userId: profile.id });
        continue;
      }
      var outcome = await divisionBilling.syncDivisionQuantity(
        opts.stripe,
        profile.stripe_subscription_id,
        count
      );
      results.push(Object.assign({ userId: profile.id }, outcome));
    } catch (err) {
      var message = err && err.message ? err.message : String(err);
      console.error(
        'sync-subscription-quantities: division sync failed for',
        profile.id,
        message
      );
      results.push({ action: 'failed', userId: profile.id, error: message });
    }
  }

  return { skipped: false, results: results };
}

module.exports = {
  BILLABLE_STATUSES: BILLABLE_STATUSES,
  countBillableAssets: countBillableAssets,
  targetSubscriptionQuantity: targetSubscriptionQuantity,
  firstSubscriptionItem: firstSubscriptionItem,
  syncUserSubscription: syncUserSubscription,
  syncAllBillableSubscriptions: syncAllBillableSubscriptions,
  reconcileDivisionQuantities: reconcileDivisionQuantities
};
