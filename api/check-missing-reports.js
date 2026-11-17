/**
 * Daily quiet-feed check.
 *
 * Vercel Cron invokes this as GET with Authorization: Bearer CRON_SECRET.
 * An allowlisted admin can POST with Authorization: Bearer <access token>.
 * POST ?dryRun=1 returns the overdue list and sends no email, and only an
 * allowlisted admin token can do that. A missing Resend key or a Resend
 * failure is returned as JSON and is not thrown, so the cron does not retry-loop.
 */
const { createClient } = require('@supabase/supabase-js');
const alert = require('../lib/missing-feed-alert');
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

function headerValue(req, name) {
  var headers = req && req.headers ? req.headers : {};
  var value = headers[name];
  if (Array.isArray(value)) value = value[0];
  return typeof value === 'string' ? value : '';
}

async function isAuthorized(req, deps) {
  deps = deps || {};
  var cronSecret = process.env.CRON_SECRET;
  var auth = headerValue(req, 'authorization');
  if (cronSecret && auth === 'Bearer ' + cronSecret) return true;
  var admin = await requireAdminUser(req, { supabase: deps.adminAuth });
  return admin.ok === true;
}

function queryValue(req, name) {
  if (req && req.query && req.query[name] != null && String(req.query[name]) !== '') {
    return String(req.query[name]);
  }
  var url = req && req.url ? String(req.url) : '';
  var q = url.indexOf('?');
  if (q === -1) return '';
  var parts = url.slice(q + 1).split('&');
  for (var i = 0; i < parts.length; i++) {
    var pair = parts[i].split('=');
    var key = '';
    var val = '';
    try {
      key = decodeURIComponent(pair[0] || '');
      val = decodeURIComponent(pair[1] || '');
    } catch (err) {
      key = pair[0] || '';
      val = pair[1] || '';
    }
    if (key === name) return val;
  }
  return '';
}

async function isDryRun(req, deps) {
  deps = deps || {};
  if (!req || req.method !== 'POST') return false;
  if (queryValue(req, 'dryRun') !== '1') return false;
  var admin = await requireAdminUser(req, { supabase: deps.adminAuth });
  return admin.ok === true;
}

async function handler(req, res, deps) {
  deps = deps || {};
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!(await isAuthorized(req, deps))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    var result = await alert.runCheck({
      supabase: deps.supabase || createSupabaseClient(),
      now: deps.now || new Date(),
      dryRun: await isDryRun(req, deps),
      fetch: deps.fetch || global.fetch
    });
    return res.status(200).json(result);
  } catch (err) {
    console.error('check-missing-reports: unhandled error', err && err.message ? err.message : err);
    return res.status(500).json({ error: 'Could not check missing reports' });
  }
}

module.exports = handler;
module.exports.isAuthorized = isAuthorized;
module.exports.isDryRun = isDryRun;
