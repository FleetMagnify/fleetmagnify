/**
 * Daily reconciliation: set every trialing/active/past_due Stripe
 * subscription's platform-price quantity to the customer's real
 * non-ignored asset count, and reconcile the divisions add-on quantity
 * for accounts that have divisions or already have that line item.
 *
 * Vercel Cron invokes this as GET with Authorization: Bearer CRON_SECRET.
 * An allowlisted admin can also POST with Authorization: Bearer <access token>
 * to run it on demand.
 */
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const sync = require('../lib/sync-subscription-quantity');
const { requireAdminUser } = require('../lib/admin-auth');

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

async function isAuthorized(req, deps) {
  deps = deps || {};
  var cronSecret = process.env.CRON_SECRET;
  var auth = (req.headers && req.headers.authorization) || '';
  if (cronSecret && auth === 'Bearer ' + cronSecret) return true;
  var admin = await requireAdminUser(req, { supabase: deps.adminAuth });
  return admin.ok === true;
}

module.exports = async function handler(req, res, deps) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!(await isAuthorized(req, deps))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    var summary = await sync.syncAllBillableSubscriptions({
      supabase: createSupabaseClient(),
      stripe: createStripeClient()
    });
    var divisionResults = summary.divisions && summary.divisions.results || [];
    return res.status(200).json({
      ok: true,
      scanned: summary.scanned,
      changed: summary.changed,
      divisions: summary.divisions && summary.divisions.skipped
        ? { skipped: true, reason: summary.divisions.reason }
        : {
            updated: divisionResults.filter(function (row) {
              return row.action === 'add' || row.action === 'update' || row.action === 'remove';
            }).length
          }
    });
  } catch (err) {
    console.error('sync-subscription-quantities: unhandled error', err.message);
    return res.status(500).json({ error: 'Could not sync subscription quantities' });
  }
};
