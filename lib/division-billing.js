/**
 * Division name rules and the Stripe quantity change for the divisions
 * add-on. STRIPE_DIVISION_PRICE_ID is read from the environment at call
 * time and is never hard-coded.
 */

var items = require('./stripe-subscription-items');

var NAME_MIN = 1;
var NAME_MAX = 60;

function validateDivisionName(name) {
  if (typeof name !== 'string') {
    return { ok: false, error: 'Name is required' };
  }
  var trimmed = name.trim();
  if (trimmed.length < NAME_MIN || trimmed.length > NAME_MAX) {
    return { ok: false, error: 'Name must be between 1 and 60 characters' };
  }
  return { ok: true, name: trimmed };
}

function normaliseCount(count) {
  var n = Number(count);
  if (!isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/**
 * Decide the Stripe subscription update for a divisions line item.
 * count 0 with no existing item is untouched: nothing is sent to Stripe.
 */
function planDivisionQuantityChange(count, existingItem, priceId) {
  var n = normaliseCount(count);
  if (n > 0 && !existingItem) {
    return {
      action: 'add',
      quantity: n,
      proration_behavior: 'create_prorations',
      items: [{ price: priceId, quantity: n }]
    };
  }
  if (n > 0 && existingItem) {
    if (Number(existingItem.quantity) === n) {
      return { action: 'unchanged', quantity: n, items: null };
    }
    return {
      action: 'update',
      quantity: n,
      from: existingItem.quantity,
      proration_behavior: 'create_prorations',
      items: [{ id: existingItem.id, quantity: n }]
    };
  }
  if (n === 0 && existingItem) {
    return {
      action: 'remove',
      proration_behavior: 'create_prorations',
      items: [{ id: existingItem.id, deleted: true }]
    };
  }
  return { action: 'untouched', items: null };
}

function divisionPriceId() {
  return process.env.STRIPE_DIVISION_PRICE_ID || '';
}

async function syncDivisionQuantity(stripe, subscriptionId, count) {
  var priceId = divisionPriceId();
  if (!priceId) {
    throw new Error('Divisions billing is not configured');
  }
  if (!subscriptionId) {
    throw new Error('No billing subscription found');
  }

  var subscription = await stripe.subscriptions.retrieve(subscriptionId);
  var existing = items.subscriptionItemForPrice(subscription, priceId);
  var plan = planDivisionQuantityChange(count, existing, priceId);
  if (!plan.items) return plan;

  await stripe.subscriptions.update(subscriptionId, {
    items: plan.items,
    proration_behavior: plan.proration_behavior
  });
  return plan;
}

function isUniqueViolation(error) {
  if (!error) return false;
  if (error.code === '23505') return true;
  var message = String(error.message || '');
  return /duplicate key|unique/i.test(message);
}

module.exports = {
  NAME_MAX: NAME_MAX,
  validateDivisionName: validateDivisionName,
  planDivisionQuantityChange: planDivisionQuantityChange,
  syncDivisionQuantity: syncDivisionQuantity,
  divisionPriceId: divisionPriceId,
  isUniqueViolation: isUniqueViolation
};
