/**
 * Owner-only division routes. Writes use the service role because a new
 * division changes the Stripe bill. Authenticated users have SELECT only.
 */
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const billing = require('./division-billing');

var LIVE_STATUSES = { active: true, trialing: true };

function bearerToken(req) {
  var authHeader = (req.headers && req.headers.authorization) || '';
  return authHeader.replace(/^Bearer\s+/i, '').trim();
}

function userClient(token) {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: 'Bearer ' + token } }
    }
  );
}

function adminClient() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

function stripeClient() {
  return Stripe(process.env.STRIPE_SECRET_KEY);
}

/**
 * Caller must be the account owner (any account_members row means they are
 * a team member) and profiles.subscription_status must be active or trialing.
 * Returns null after writing the error response.
 */
async function requireDivisionOwner(req, res, deps) {
  deps = deps || {};
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return null;
  }

  var token = bearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }

  var supabaseUser = deps.supabaseUser || userClient(token);
  var userResult = await supabaseUser.auth.getUser();
  if (userResult.error || !userResult.data || !userResult.data.user) {
    res.status(401).json({ error: 'Invalid session' });
    return null;
  }
  var callerId = userResult.data.user.id;

  var admin = deps.supabaseAdmin || adminClient();
  var memberCheck = await admin
    .from('account_members')
    .select('account_owner_user_id')
    .eq('member_auth_user_id', callerId)
    .maybeSingle();

  if (memberCheck.error) {
    console.error('divisions: membership lookup failed', memberCheck.error.message);
    res.status(500).json({ error: 'Could not verify account ownership' });
    return null;
  }

  if (memberCheck.data) {
    res.status(403).json({ error: 'Only the account owner can manage divisions' });
    return null;
  }

  var profileResult = await admin
    .from('profiles')
    .select('subscription_status, stripe_subscription_id')
    .eq('id', callerId)
    .maybeSingle();

  if (profileResult.error) {
    console.error('divisions: profile lookup failed', profileResult.error.message);
    res.status(500).json({ error: 'Could not verify the subscription' });
    return null;
  }

  var profile = profileResult.data;
  if (!profile || !LIVE_STATUSES[profile.subscription_status]) {
    res.status(403).json({ error: 'An active subscription is required to manage divisions' });
    return null;
  }

  if (!billing.divisionPriceId()) {
    res.status(500).json({ error: 'Divisions billing is not configured' });
    return null;
  }

  return {
    callerId: callerId,
    admin: admin,
    profile: profile,
    stripe: deps.stripe || stripeClient()
  };
}

async function countDivisions(admin, ownerId) {
  var result = await admin
    .from('divisions')
    .select('id')
    .eq('account_owner_user_id', ownerId);
  if (result.error) {
    throw new Error(result.error.message || 'Could not count divisions');
  }
  return (result.data || []).length;
}

async function loadOwnedDivision(admin, callerId, divisionId) {
  var id = Number(divisionId);
  if (!Number.isInteger(id) || id <= 0) return { error: 'division_id is required', status: 400 };
  var result = await admin
    .from('divisions')
    .select('id, name, account_owner_user_id')
    .eq('id', id)
    .maybeSingle();
  if (result.error) return { error: 'Could not load the division', status: 500 };
  if (!result.data || result.data.account_owner_user_id !== callerId) {
    return { error: 'Division not found', status: 404 };
  }
  return { division: result.data };
}

async function createDivision(req, res, deps) {
  var gate = await requireDivisionOwner(req, res, deps);
  if (!gate) return;

  var parsed = billing.validateDivisionName(req.body && req.body.name);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  if (!gate.profile.stripe_subscription_id) {
    return res.status(400).json({ error: 'No billing subscription found' });
  }

  var insertResult = await gate.admin
    .from('divisions')
    .insert({ account_owner_user_id: gate.callerId, name: parsed.name })
    .select('id, name')
    .single();

  if (insertResult.error) {
    if (billing.isUniqueViolation(insertResult.error)) {
      return res.status(409).json({ error: 'A division with that name already exists' });
    }
    console.error('divisions: insert failed', insertResult.error.message);
    return res.status(500).json({ error: 'Could not create the division' });
  }

  var created = insertResult.data;
  try {
    var count = await countDivisions(gate.admin, gate.callerId);
    await billing.syncDivisionQuantity(gate.stripe, gate.profile.stripe_subscription_id, count);
  } catch (err) {
    console.error('divisions: stripe update failed, removing division', created.id, err.message);
    var rollback = await gate.admin.from('divisions').delete().eq('id', created.id);
    if (rollback.error) {
      console.error('divisions: rollback delete failed', created.id, rollback.error.message);
    }
    return res.status(502).json({ error: 'Could not update division billing. The division was not saved.' });
  }

  return res.status(200).json({ ok: true, division: { id: created.id, name: created.name } });
}

async function renameDivision(req, res, deps) {
  var gate = await requireDivisionOwner(req, res, deps);
  if (!gate) return;

  var loaded = await loadOwnedDivision(gate.admin, gate.callerId, req.body && req.body.division_id);
  if (!loaded.division) return res.status(loaded.status).json({ error: loaded.error });

  var parsed = billing.validateDivisionName(req.body && req.body.name);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  var updateResult = await gate.admin
    .from('divisions')
    .update({ name: parsed.name })
    .eq('id', loaded.division.id)
    .eq('account_owner_user_id', gate.callerId)
    .select('id, name')
    .single();

  if (updateResult.error) {
    if (billing.isUniqueViolation(updateResult.error)) {
      return res.status(409).json({ error: 'A division with that name already exists' });
    }
    console.error('divisions: rename failed', updateResult.error.message);
    return res.status(500).json({ error: 'Could not rename the division' });
  }

  return res.status(200).json({ ok: true, division: { id: updateResult.data.id, name: updateResult.data.name } });
}

async function deleteDivision(req, res, deps) {
  var gate = await requireDivisionOwner(req, res, deps);
  if (!gate) return;

  var loaded = await loadOwnedDivision(gate.admin, gate.callerId, req.body && req.body.division_id);
  if (!loaded.division) return res.status(loaded.status).json({ error: loaded.error });

  if (!gate.profile.stripe_subscription_id) {
    return res.status(400).json({ error: 'No billing subscription found' });
  }

  var managers = await gate.admin
    .from('division_managers')
    .select('member_auth_user_id')
    .eq('division_id', loaded.division.id);

  if (managers.error) {
    console.error('divisions: manager lookup failed', managers.error.message);
    return res.status(500).json({ error: 'Could not check divisional managers' });
  }

  if ((managers.data || []).length > 0) {
    return res.status(409).json({
      error: 'This division still has divisional managers. Reassign or remove them before deleting it.'
    });
  }

  var before = await countDivisions(gate.admin, gate.callerId);
  var after = Math.max(0, before - 1);

  try {
    await billing.syncDivisionQuantity(gate.stripe, gate.profile.stripe_subscription_id, after);
  } catch (err) {
    console.error('divisions: stripe update failed, division kept', loaded.division.id, err.message);
    return res.status(502).json({ error: 'Could not update division billing. The division was not deleted.' });
  }

  var deleted = await gate.admin.from('divisions').delete().eq('id', loaded.division.id);
  if (deleted.error) {
    console.error('divisions: delete failed after stripe update', deleted.error.message);
    try {
      await billing.syncDivisionQuantity(gate.stripe, gate.profile.stripe_subscription_id, before);
    } catch (restoreErr) {
      console.error('divisions: could not restore division quantity', restoreErr.message);
    }
    return res.status(500).json({ error: 'Could not delete the division' });
  }

  return res.status(200).json({ ok: true });
}

function parseManagerIds(value) {
  if (!Array.isArray(value)) {
    return { ok: false, error: 'member_auth_user_ids must be a list' };
  }
  var ids = [];
  var seen = {};
  for (var i = 0; i < value.length; i++) {
    if (typeof value[i] !== 'string' || !value[i].trim()) {
      return { ok: false, error: 'member_auth_user_ids must be user ids' };
    }
    var id = value[i].trim();
    if (seen[id]) continue;
    seen[id] = true;
    ids.push(id);
  }
  return { ok: true, ids: ids };
}

async function setDivisionManagers(req, res, deps) {
  var gate = await requireDivisionOwner(req, res, deps);
  if (!gate) return;

  var loaded = await loadOwnedDivision(gate.admin, gate.callerId, req.body && req.body.division_id);
  if (!loaded.division) return res.status(loaded.status).json({ error: loaded.error });

  var parsed = parseManagerIds(req.body && req.body.member_auth_user_ids);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  var members = await gate.admin
    .from('account_members')
    .select('member_auth_user_id, scope')
    .eq('account_owner_user_id', gate.callerId)
    .eq('scope', 'division');

  if (members.error) {
    console.error('divisions: member lookup failed', members.error.message);
    return res.status(500).json({ error: 'Could not load divisional managers' });
  }

  var allowed = {};
  (members.data || []).forEach(function (row) {
    if (row && row.member_auth_user_id) allowed[row.member_auth_user_id] = true;
  });

  for (var i = 0; i < parsed.ids.length; i++) {
    if (!allowed[parsed.ids[i]]) {
      return res.status(400).json({ error: 'Each manager must be a divisional manager on this account' });
    }
  }

  var current = await gate.admin
    .from('division_managers')
    .select('member_auth_user_id')
    .eq('division_id', loaded.division.id);

  if (current.error) {
    console.error('divisions: current managers lookup failed', current.error.message);
    return res.status(500).json({ error: 'Could not load the current managers' });
  }

  var have = {};
  (current.data || []).forEach(function (row) {
    if (row && row.member_auth_user_id) have[row.member_auth_user_id] = true;
  });

  var want = {};
  parsed.ids.forEach(function (id) { want[id] = true; });

  var toAdd = parsed.ids.filter(function (id) { return !have[id]; });
  var toRemove = Object.keys(have).filter(function (id) { return !want[id]; });

  if (toAdd.length) {
    var inserted = await gate.admin.from('division_managers').insert(toAdd.map(function (id) {
      return { division_id: loaded.division.id, member_auth_user_id: id };
    }));
    if (inserted.error) {
      console.error('divisions: manager insert failed', inserted.error.message);
      return res.status(500).json({ error: 'Could not assign divisional managers' });
    }
  }

  if (toRemove.length) {
    var removed = await gate.admin
      .from('division_managers')
      .delete()
      .eq('division_id', loaded.division.id)
      .in('member_auth_user_id', toRemove);
    if (removed.error) {
      console.error('divisions: manager delete failed', removed.error.message);
      return res.status(500).json({ error: 'Could not update the full manager list' });
    }
  }

  return res.status(200).json({ ok: true, member_auth_user_ids: parsed.ids });
}

module.exports = {
  requireDivisionOwner: requireDivisionOwner,
  createDivision: createDivision,
  renameDivision: renameDivision,
  deleteDivision: deleteDivision,
  setDivisionManagers: setDivisionManagers,
  parseManagerIds: parseManagerIds
};
