/**
 * Daily reconciliation: set every trialing/active/past_due Stripe
 * subscription's quantity to the customer's real non-ignored asset count.
 *
 * Vercel Cron invokes this as GET with Authorization: Bearer CRON_SECRET.
 * Admins can also POST with x-admin-secret to run it on demand.
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

function isAuthorized(req) {
  var cronSecret = process.env.CRON_SECRET;
  var adminSecret = process.env.ADMIN_SECRET;
  var auth = req.headers.authorization || '';
  if (cronSecret && auth === 'Bearer ' + cronSecret) return true;
  if (adminSecret && req.headers['x-admin-secret'] === adminSecret) return true;
  return false;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    var summary = await sync.syncAllBillableSubscriptions({
      supabase: createSupabaseClient(),
      stripe: createStripeClient()
    });
    return res.status(200).json({
      ok: true,
      scanned: summary.scanned,
      changed: summary.changed
    });
  } catch (err) {
    console.error('sync-subscription-quantities: unhandled error', err.message);
    return res.status(500).json({ error: 'Could not sync subscription quantities' });
  }
};
