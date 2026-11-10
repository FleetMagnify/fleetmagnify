/**
 * Creates a Stripe Checkout session for a customer to subscribe to the
 * FleetMagnify platform fee. Truck/machine fee quantities are added to
 * the subscription later via api/sync-subscription-quantities.js (daily
 * reconciliation) and the invoice.upcoming webhook (charge-time sync).
 *
 * This creates one line item, identified by STRIPE_PRICE_PLATFORM. It does
 * not read or reorder existing subscription items. The divisions add-on is
 * a separate price added later by the division routes.
 *
 * Requires a signed-in user. The id and email come from that session.
 * userId and email in the request body are not used.
 */
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const { TRIAL_DAYS, isTrialEligible } = require('../js/subscription-guard');

const SUPABASE_URL =
  process.env.SUPABASE_URL || 'https://pddsgvuzvuwueuvpoytw.supabase.co';
const DEFAULT_SUCCESS_URL = 'https://fleetmagnify.com/home.html?upgraded=1';
const DEFAULT_CANCEL_URL = 'https://fleetmagnify.com/upgrade.html';
const ALLOWED_RETURN_PREFIXES = [
  'https://fleetmagnify.com/',
  'https://www.fleetmagnify.com/'
];

function returnUrl(value, fallback) {
  if (typeof value === 'string') {
    for (var i = 0; i < ALLOWED_RETURN_PREFIXES.length; i++) {
      if (value.indexOf(ALLOWED_RETURN_PREFIXES[i]) === 0) return value;
    }
  }
  return fallback;
}

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

function createAuthClient(token) {
  var serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
  }
  return createClient(SUPABASE_URL, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: 'Bearer ' + token } }
  });
}

async function requireSignedInUser(req) {
  var authHeader = (req.headers && req.headers.authorization) || '';
  var token = authHeader.replace('Bearer ', '').trim();
  if (!token) {
    return { errorStatus: 401, error: 'Unauthorized' };
  }

  var userResult = await createAuthClient(token).auth.getUser();
  if (userResult.error || !userResult.data || !userResult.data.user || !userResult.data.user.id || !userResult.data.user.email) {
    return { errorStatus: 401, error: 'Invalid session' };
  }
  return { user: userResult.data.user };
}

async function teamMemberBlock(supabase, userId) {
  var memberCheck = await supabase
    .from('account_members')
    .select('account_owner_user_id')
    .eq('member_auth_user_id', userId)
    .maybeSingle();

  if (memberCheck.error) {
    console.error('create-checkout-session: membership lookup failed', memberCheck.error.message);
    return { errorStatus: 500, error: 'Could not verify account ownership' };
  }
  if (memberCheck.data) {
    return { errorStatus: 403, error: 'Billing is managed by your account owner' };
  }
  return null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    var signedIn = await requireSignedInUser(req);
    if (signedIn.errorStatus) {
      return res.status(signedIn.errorStatus).json({ error: signedIn.error });
    }

    var userId = signedIn.user.id;
    var email = signedIn.user.email;
    var successUrl = returnUrl(req.body && req.body.successUrl, DEFAULT_SUCCESS_URL);
    var cancelUrl = returnUrl(req.body && req.body.cancelUrl, DEFAULT_CANCEL_URL);

    var supabase = createSupabaseClient();
    var blocked = await teamMemberBlock(supabase, userId);
    if (blocked) {
      return res.status(blocked.errorStatus).json({ error: blocked.error });
    }
    var stripe = createStripeClient();

    var profileResult = await supabase
      .from('profiles')
      .select('id, stripe_customer_id, company_name, subscription_status, trial_ends_at, stripe_subscription_id')
      .eq('id', userId)
      .maybeSingle();

    if (profileResult.error) {
      console.error('create-checkout-session: profile lookup failed', profileResult.error.message);
      return res.status(500).json({ error: 'Could not look up account' });
    }

    if (!profileResult.data) {
      return res.status(404).json({ error: 'Account not found' });
    }

    // The client's trialPeriodDays value is ignored. A trial is applied only
    // when this profile is eligible. An ineligible account that asked for a
    // trial continues with no trial_period_days and is not rejected.
    var trialPeriodDays = isTrialEligible(profileResult.data) ? TRIAL_DAYS : 0;

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
      success_url: successUrl,
      cancel_url: cancelUrl,
      allow_promotion_codes: true,
      metadata: { supabase_user_id: userId },
      subscription_data: Object.assign(
        { metadata: { supabase_user_id: userId } },
        trialPeriodDays > 0 ? { trial_period_days: trialPeriodDays } : {}
      ),
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('create-checkout-session: unhandled error', err.message);
    return res.status(500).json({ error: 'Could not start checkout' });
  }
};
