/**
 * Admin requests must be a signed-in Supabase user whose id is listed in
 * ADMIN_USER_IDS (comma-separated Supabase user ids). An unset or empty
 * list means nobody is an admin. The access token is never logged.
 */
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL =
  process.env.SUPABASE_URL || 'https://pddsgvuzvuwueuvpoytw.supabase.co';

function parseAdminUserIds(env) {
  var raw = env && env.ADMIN_USER_IDS != null ? String(env.ADMIN_USER_IDS) : '';
  var seen = Object.create(null);
  var ids = [];
  raw.split(',').forEach(function (part) {
    var id = part.trim().toLowerCase();
    if (!id || seen[id]) return;
    seen[id] = true;
    ids.push(id);
  });
  return ids;
}

function authorizationHeader(req) {
  var headers = req && req.headers ? req.headers : {};
  var value = headers.authorization;
  if (value == null) value = headers.Authorization;
  if (Array.isArray(value)) value = value[0];
  return typeof value === 'string' ? value : '';
}

function createAuthClient() {
  var anonKey = process.env.SUPABASE_ANON_KEY;
  if (!anonKey) {
    throw new Error('Supabase auth is not configured');
  }
  return createClient(SUPABASE_URL, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

function unauthorised() {
  return { ok: false, status: 401, error: 'Unauthorized' };
}

async function requireAdminUser(req, deps) {
  deps = deps || {};
  var header = authorizationHeader(req).trim();
  var match = /^Bearer\s+(\S+)$/.exec(header);
  if (!match) return unauthorised();

  var supabase = deps.supabase;
  if (!supabase) {
    try {
      supabase = createAuthClient();
    } catch (err) {
      return unauthorised();
    }
  }

  var userResult;
  try {
    userResult = await supabase.auth.getUser(match[1]);
  } catch (err) {
    return unauthorised();
  }

  var user = userResult && userResult.data && userResult.data.user;
  if (!userResult || userResult.error || !user || !user.id) return unauthorised();

  var allowlist = parseAdminUserIds(deps.env || process.env);
  if (allowlist.indexOf(String(user.id).trim().toLowerCase()) === -1) {
    return { ok: false, status: 403, error: 'Not authorised' };
  }

  return {
    ok: true,
    userId: user.id,
    email: user.email || ''
  };
}

module.exports = {
  parseAdminUserIds: parseAdminUserIds,
  requireAdminUser: requireAdminUser
};
