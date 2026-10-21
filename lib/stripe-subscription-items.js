/**
 * Subscription line items are identified by Stripe price id.
 * A divisions add-on sits beside the platform price, so callers must
 * not assume how many items exist or which one is first.
 */

function itemPriceId(item) {
  if (!item) return null;
  if (typeof item.price === 'string') return item.price;
  if (item.price && item.price.id) return item.price.id;
  if (item.plan && typeof item.plan === 'string') return item.plan;
  if (item.plan && item.plan.id) return item.plan.id;
  return null;
}

function subscriptionItems(subscription) {
  var items = subscription && subscription.items && subscription.items.data;
  return items || [];
}

function subscriptionItemForPrice(subscription, priceId) {
  if (!priceId) return null;
  var items = subscriptionItems(subscription);
  for (var i = 0; i < items.length; i++) {
    if (itemPriceId(items[i]) === priceId) return items[i];
  }
  return null;
}

module.exports = {
  itemPriceId: itemPriceId,
  subscriptionItems: subscriptionItems,
  subscriptionItemForPrice: subscriptionItemForPrice
};
