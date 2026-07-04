/**
 * Creates a Stripe subscription billed via emailed invoice (rather than
 * auto-charged card) for customers with 10+ active assets. Invoices are
 * generated automatically by Stripe each month from the date this is called,
 * due 7 days after issue.
 */
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL =
  process.env.SUPABASE_URL || 'https://pddsgvuzvuwueuvpoytw.supabase.co';

const MIN_ASSETS_FOR_INVOICING = 10;

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
    var poNumber = req.body && req.body.poNumber ? String(req.body.poNumber).trim() : '';

    if (!userId || !email) {
      return res.status(400).json({ error: 'userId and email are required' });
    }

    var supabase = createSupabaseClient();
    var stripe = createStripeClient();

    // Eligibility check: 10+ active, non-ignored assets required for invoice billing.
    var countResult = await supabase
      .from('assets')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('is_ignored', false);

    if (countResult.error) {
      console.error('create-invoice-subscription: asset count failed', countResult.error.message);
      return res.status(500).json({ error: 'Could not verify fleet size' });
    }

    var assetCount = countResult.count || 0;

    if (assetCount < MIN_ASSETS_FOR_INVOICING) {
      return res.status(403).json({
        error: 'Invoice billing is available for fleets of ' + MIN_ASSETS_FOR_INVOICING +
          '+ assets. Your account currently has ' + assetCount +
          '. Please use card payment, or contact support@fleetmagnify.com to discuss your account.'
      });
    }

    var profileResult = await supabase
      .from('profiles')
      .select('id, stripe_customer_id, company_name')
      .eq('id', userId)
      .maybeSingle();

    if (profileResult.error || !profileResult.data) {
      console.error('create-invoice-subscription: profile lookup failed', profileResult.error && profileResult.error.message);
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

      await supabase.from('profiles').update({ stripe_customer_id: stripeCustomerId }).eq('id', userId);
    }

    // Attach PO number to the customer's invoice settings so it appears on
    // every invoice generated for this subscription, not just the first.
    if (poNumber) {
      await stripe.customers.update(stripeCustomerId, {
        invoice_settings: { custom_fields: [{ name: 'PO Number', value: poNumber.slice(0, 30) }] },
      });
    }

    var subscription = await stripe.subscriptions.create({
      customer: stripeCustomerId,
      items: [{ price: process.env.STRIPE_PRICE_PLATFORM, quantity: 1 }],
      collection_method: 'send_invoice',
      days_until_due: 7,
      metadata: {
        supabase_user_id: userId,
        billing_method: 'invoice',
        po_number: poNumber || '',
      },
    });

    await supabase
      .from('profiles')
      .update({
        subscription_status: 'active',
        stripe_subscription_id: subscription.id,
      })
      .eq('id', userId);

    return res.status(200).json({ ok: true, subscriptionId: subscription.id });
  } catch (err) {
    console.error('create-invoice-subscription: unhandled error', err.message);
    return res.status(500).json({ error: 'Could not set up invoice billing' });
  }
};
