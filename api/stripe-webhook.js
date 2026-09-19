/**
 * Stripe webhook handler — listens for subscription lifecycle events and
 * updates profiles.subscription_status accordingly. Requires raw body
 * (see module.exports.config below) so the Stripe signature can be verified.
 *
 * Event processing lives in processStripeEvent() so tests can drive the
 * switch without constructing a signed payload.
 */
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const sync = require('../lib/sync-subscription-quantity');

const SUPABASE_URL =
  process.env.SUPABASE_URL || 'https://pddsgvuzvuwueuvpoytw.supabase.co';

function createSupabaseClient() {
  var serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
  }
  return createClient(SUPABASE_URL, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function createStripeClient() {
  var secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY is not configured');
  }
  return new Stripe(secretKey);
}

function getRawBody(req) {
  return new Promise(function (resolve, reject) {
    var chunks = [];
    req.on('data', function (chunk) {
      chunks.push(chunk);
    });
    req.on('end', function () {
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function stripeId(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value.id) return value.id;
  return null;
}

function extraFieldsForCheckoutSession(session) {
  return {
    stripe_subscription_id: stripeId(session && session.subscription),
    stripe_customer_id: stripeId(session && session.customer),
  };
}

/**
 * checkout.session.completed does not carry subscription.status unless the
 * subscription is expanded. A 10-day trial Checkout starts the subscription
 * as `trialing`, not `active` — never assume active from the session alone.
 */
function checkoutSubscriptionStatus(session) {
  var sub = session && session.subscription;
  if (sub && typeof sub === 'object' && sub.status) return sub.status;
  return null;
}

function profileStatusFromStripe(status) {
  if (status === 'canceled') return 'cancelled';
  return status;
}

async function setSubscriptionStatus(supabase, userId, status, extra) {
  var payload = Object.assign({ subscription_status: status }, extra || {});
  var result = await supabase.from('profiles').update(payload).eq('id', userId);
  if (result.error) {
    console.error('stripe-webhook: failed to update subscription_status for', userId, result.error.message);
  } else {
    console.log('stripe-webhook: set subscription_status =', status, 'for user', userId);
  }
  return result;
}

async function findUserIdForCustomer(supabase, stripeCustomerId) {
  if (!stripeCustomerId) return null;
  var result = await supabase
    .from('profiles')
    .select('id')
    .eq('stripe_customer_id', stripeCustomerId)
    .maybeSingle();
  if (result.error || !result.data) {
    return null;
  }
  return result.data.id;
}

async function findUserIdForSubscription(supabase, stripeSubscriptionId) {
  if (!stripeSubscriptionId) return null;
  var result = await supabase
    .from('profiles')
    .select('id')
    .eq('stripe_subscription_id', stripeSubscriptionId)
    .maybeSingle();
  if (result.error || !result.data) {
    return null;
  }
  return result.data.id;
}

async function resolveUserId(supabase, object) {
  var metaId = object && object.metadata && object.metadata.supabase_user_id;
  if (metaId) return metaId;
  var fromCustomer = await findUserIdForCustomer(supabase, stripeId(object && object.customer));
  if (fromCustomer) return fromCustomer;
  return findUserIdForSubscription(supabase, stripeId(object && object.subscription) || (object && object.id));
}

async function processStripeEvent(supabase, event, deps) {
  deps = deps || {};

  switch (event.type) {
    case 'checkout.session.completed': {
      var session = event.data.object;
      var userId = session.metadata && session.metadata.supabase_user_id;
      if (!userId) {
        console.warn('stripe-webhook: checkout.session.completed with no supabase_user_id metadata');
        break;
      }

      var status = checkoutSubscriptionStatus(session);
      if (!status && deps.retrieveSubscription) {
        var subId = stripeId(session.subscription);
        if (subId) {
          var retrieved = await deps.retrieveSubscription(subId);
          if (retrieved && retrieved.status) status = retrieved.status;
        }
      }
      if (!status) {
        // Upgrade/card Checkout without an expanded subscription: paid immediately.
        status = 'active';
      }

      await setSubscriptionStatus(supabase, userId, status, extraFieldsForCheckoutSession(session));
      break;
    }

    case 'customer.subscription.updated': {
      var updatedSub = event.data.object;
      var updatedUid = await resolveUserId(supabase, updatedSub);
      if (!updatedUid) {
        console.warn('stripe-webhook: customer.subscription.updated with no matching profile');
        break;
      }
      var mapped = profileStatusFromStripe(updatedSub.status);
      var extra = { stripe_subscription_id: stripeId(updatedSub) };
      if (mapped === 'cancelled') {
        extra.stripe_subscription_id = null;
      }
      await setSubscriptionStatus(supabase, updatedUid, mapped, extra);
      break;
    }

    case 'invoice.upcoming': {
      var upcoming = event.data.object;
      var upcomingUid = await resolveUserId(supabase, upcoming);
      var upcomingSubId = stripeId(upcoming.subscription);
      if (!upcomingUid) {
        console.warn('stripe-webhook: invoice.upcoming with no matching profile');
        break;
      }
      if (!deps.syncQuantityForUser) {
        console.warn('stripe-webhook: invoice.upcoming has no syncQuantityForUser dep');
        break;
      }
      console.log('stripe-webhook: invoice.upcoming quantity sync for', upcomingUid, upcomingSubId);
      await deps.syncQuantityForUser(upcomingUid, upcomingSubId);
      break;
    }

    case 'invoice.payment_succeeded': {
      var invoice = event.data.object;
      // $0 invoices fire at trial start (subscription_create). Do not promote
      // those to active — that fights Stripe's trialing → active transition.
      if (typeof invoice.amount_paid === 'number' && invoice.amount_paid <= 0) {
        console.log('stripe-webhook: ignoring $0 invoice.payment_succeeded');
        break;
      }
      var custId = stripeId(invoice.customer);
      var uid = await findUserIdForCustomer(supabase, custId);
      if (uid) {
        await setSubscriptionStatus(supabase, uid, 'active');
      }
      break;
    }

    case 'invoice.payment_failed': {
      var failedInvoice = event.data.object;
      var failedCustId = stripeId(failedInvoice.customer);
      var failedUid = await findUserIdForCustomer(supabase, failedCustId);
      if (failedUid) {
        await setSubscriptionStatus(supabase, failedUid, 'past_due');
      }
      break;
    }

    case 'customer.subscription.deleted': {
      var subscription = event.data.object;
      var deletedUid = await resolveUserId(supabase, subscription);
      if (deletedUid) {
        await setSubscriptionStatus(supabase, deletedUid, 'cancelled', {
          stripe_subscription_id: null,
        });
      }
      break;
    }

    default:
      console.log('stripe-webhook: unhandled event type', event.type);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var stripe = createStripeClient();
  var webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error('stripe-webhook: STRIPE_WEBHOOK_SECRET is not configured');
    return res.status(500).json({ error: 'Webhook not configured' });
  }

  var event;

  try {
    var rawBody = await getRawBody(req);
    var signature = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    console.error('stripe-webhook: signature verification failed', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  var supabase = createSupabaseClient();

  try {
    await processStripeEvent(supabase, event, {
      retrieveSubscription: function (id) {
        return stripe.subscriptions.retrieve(id);
      },
      syncQuantityForUser: function (userId, subscriptionId) {
        return sync.syncUserSubscription({
          supabase: supabase,
          stripe: stripe,
          userId: userId,
          subscriptionId: subscriptionId
        });
      }
    });
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('stripe-webhook: error processing event', event.type, err.message);
    return res.status(500).json({ error: 'Error processing webhook' });
  }
};

module.exports.config = {
  api: {
    bodyParser: false,
  },
};

module.exports.processStripeEvent = processStripeEvent;
module.exports.extraFieldsForCheckoutSession = extraFieldsForCheckoutSession;
module.exports.checkoutSubscriptionStatus = checkoutSubscriptionStatus;
module.exports.profileStatusFromStripe = profileStatusFromStripe;
