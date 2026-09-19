/**
 * Sync a Stripe subscription's line-item quantity to the customer's
 * real non-ignored asset count. Used by the daily reconciliation job
 * and by the invoice.upcoming webhook (the charge-time sync).
 *
 * Stripe line items require quantity >= 1, so a fleet of 0 assets
 * stays at 1 (the Checkout starting quantity) rather than failing
 * the update.
 */

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

function firstSubscriptionItem(subscription) {
  var items = subscription && subscription.items && subscription.items.data;
  if (!items || !items.length) return null;
  return items[0];
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
    console.log('sync-subscription-quantities: no line items on', subscriptionId, 'user', userId);
    return { changed: false, reason: 'no_items', userId: userId, subscriptionId: subscriptionId };
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
    var outcome = await syncUserSubscription({
      supabase: supabase,
      stripe: stripe,
      userId: profile.id,
      subscriptionId: profile.stripe_subscription_id
    });
    results.push(outcome);
  }

  var changed = results.filter(function (row) { return row.changed; }).length;
  console.log(
    'sync-subscription-quantities: scanned',
    results.length,
    'subscriptions, updated',
    changed
  );

  return { scanned: results.length, changed: changed, results: results };
}

module.exports = {
  BILLABLE_STATUSES: BILLABLE_STATUSES,
  countBillableAssets: countBillableAssets,
  targetSubscriptionQuantity: targetSubscriptionQuantity,
  firstSubscriptionItem: firstSubscriptionItem,
  syncUserSubscription: syncUserSubscription,
  syncAllBillableSubscriptions: syncAllBillableSubscriptions
};
