/**
 * Creates a Stripe Checkout session for a customer to subscribe to the
 * FleetMagnify platform fee. Truck/machine fee quantities are added to
 * the subscription later via api/sync-subscription-quantities.js once
 * the customer's asset count is known.
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

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    var userId = req.body && req.body.userId;
    var email = req.body && req.body.email;
    var successUrl = req.body && req.body.successUrl;
    var cancelUrl = req.body && req.body.cancelUrl;

    if (!userId || !email) {
      return res.status(400).json({ error: 'userId and email are required' });
    }

    var supabase = createSupabaseClient();
    var stripe = createStripeClient();

    var profileResult = await supabase
      .from('profiles')
      .select('id, stripe_customer_id, company_name')
      .eq('id', userId)
      .maybeSingle();

    if (profileResult.error) {
      console.error('create-checkout-session: profile lookup failed', profileResult.error.message);
      return res.status(500).json({ error: 'Could not look up account' });
    }

    if (!profileResult.data) {
      return res.status(404).json({ error: 'Account not found' });
    }

    var stripeCustomerId = profileResult.data.stripe_customer_id;

    if (!stripeCustomerId) {
      var customer = await stripe.customers.create({
        email: email,
        name: profileResult.data.company_name || undefined,
        metadata: { supabase_user_id: userId },
      });
      stripeCustomerId = customer.id;

      var updateResult = await supabase
        .from('profiles')
        .update({ stripe_customer_id: stripeCustomerId })
        .eq('id', userId);

      if (updateResult.error) {
        console.error('create-checkout-session: failed to save stripe_customer_id', updateResult.error.message);
      }
    }

    var session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      mode: 'subscription',
      line_items: [
        {
          price: process.env.STRIPE_PRICE_PLATFORM,
          quantity: 1,
        },
      ],
      success_url: successUrl || 'https://fleetmagnify.com/home.html?upgraded=1',
      cancel_url: cancelUrl || 'https://fleetmagnify.com/upgrade.html',
      allow_promotion_codes: true,
      metadata: { supabase_user_id: userId },
      subscription_data: {
        metadata: { supabase_user_id: userId },
      },
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('create-checkout-session: unhandled error', err.message);
    return res.status(500).json({ error: 'Could not start checkout' });
  }
};
