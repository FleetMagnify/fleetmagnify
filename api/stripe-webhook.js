/**
 * Stripe webhook handler — listens for subscription lifecycle events and
 * updates profiles.subscription_status accordingly. Requires raw body
 * (see module.exports.config below) so the Stripe signature can be verified.
 */
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

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

async function setSubscriptionStatus(supabase, userId, status, extra) {
  var payload = Object.assign({ subscription_status: status }, extra || {});
  var result = await supabase.from('profiles').update(payload).eq('id', userId);
  if (result.error) {
    console.error('stripe-webhook: failed to update subscription_status for', userId, result.error.message);
  } else {
    console.log('stripe-webhook: set subscription_status =', status, 'for user', userId);
  }
}

async function findUserIdForCustomer(supabase, stripeCustomerId) {
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
    switch (event.type) {
      case 'checkout.session.completed': {
        var session = event.data.object;
        var userId = session.metadata && session.metadata.supabase_user_id;
        if (userId) {
          await setSubscriptionStatus(supabase, userId, 'active', {
            stripe_subscription_id: session.subscription || null,
          });
        } else {
          console.warn('stripe-webhook: checkout.session.completed with no supabase_user_id metadata');
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        var invoice = event.data.object;
        var custId = invoice.customer;
        var uid = await findUserIdForCustomer(supabase, custId);
        if (uid) {
          await setSubscriptionStatus(supabase, uid, 'active');
        }
        break;
      }

      case 'invoice.payment_failed': {
        var failedInvoice = event.data.object;
        var failedCustId = failedInvoice.customer;
        var failedUid = await findUserIdForCustomer(supabase, failedCustId);
        if (failedUid) {
          await setSubscriptionStatus(supabase, failedUid, 'past_due');
        }
        break;
      }

      case 'customer.subscription.deleted': {
        var subscription = event.data.object;
        var subUserId = subscription.metadata && subscription.metadata.supabase_user_id;
        var deletedUid = subUserId || await findUserIdForCustomer(supabase, subscription.customer);
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
