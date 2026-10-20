const { createClient } = require('@supabase/supabase-js');

async function handler(req, res, deps) {
  deps = deps || {};
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  var authHeader = req.headers.authorization || '';
  var token = authHeader.replace('Bearer ', '').trim();
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  var supabase = deps.supabase || createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: 'Bearer ' + token } }
    }
  );

  // Clean service-role client with no Authorization header override — used
  // for all account_members reads below, so RLS is bypassed via the
  // service_role key rather than being evaluated against the caller's own JWT
  // (which is what `supabase` above sends).
  var supabaseAdmin = deps.supabaseAdmin || createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  // Temporary: auth.admin.* methods are incompatible with the newer sb_secret_
  // key format, so this dedicated client uses the legacy service_role JWT
  // solely for the getUserById calls below.
  var supabaseLegacyAdmin = deps.supabaseLegacyAdmin || createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY_LEGACY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  var userResult = await supabase.auth.getUser();
  if (userResult.error || !userResult.data.user) {
    return res.status(401).json({ error: 'Invalid session' });
  }
  var callerId = userResult.data.user.id;

  try {
    // Authorization: only the actual account owner (never a delegated member
    // who was themselves invited into someone else's account) can list the
    // account's team members. This mirrors the resolveAccountId lookup used
    // elsewhere in the app — if the caller has an account_members row
    // pointing at a different owner, they're a member, not an owner.
    var callerMemberCheck = await supabaseAdmin
      .from('account_members')
      .select('account_owner_user_id')
      .eq('member_auth_user_id', callerId)
      .maybeSingle();

    if (callerMemberCheck.error) {
      return res.status(500).json({ error: 'Failed to verify account ownership: ' + callerMemberCheck.error.message });
    }

    if (callerMemberCheck.data && callerMemberCheck.data.account_owner_user_id && callerMemberCheck.data.account_owner_user_id !== callerId) {
      return res.status(403).json({ error: 'Only the account owner can view team members.' });
    }

    var membersResult = await supabaseAdmin
      .from('account_members')
      .select('id, member_auth_user_id, role, can_edit_assets, can_edit_jobs, can_view_change_log, created_at, scope')
      .eq('account_owner_user_id', callerId)
      .order('created_at', { ascending: true });

    if (membersResult.error) {
      return res.status(500).json({ error: 'Failed to load team members: ' + membersResult.error.message });
    }

    var rows = membersResult.data || [];
    var divisionIdsByMember = {};
    var divisionRows = await supabaseAdmin
      .from('divisions')
      .select('id')
      .eq('account_owner_user_id', callerId);

    if (divisionRows.error) {
      return res.status(500).json({ error: 'Failed to load divisions: ' + divisionRows.error.message });
    }

    var ownedDivisionIds = (divisionRows.data || []).map(function (row) { return row.id; });
    if (ownedDivisionIds.length) {
      var assignments = await supabaseAdmin
        .from('division_managers')
        .select('division_id, member_auth_user_id')
        .in('division_id', ownedDivisionIds);
      if (assignments.error) {
        return res.status(500).json({ error: 'Failed to load division managers: ' + assignments.error.message });
      }
      (assignments.data || []).forEach(function (assignment) {
        var key = assignment.member_auth_user_id;
        if (!divisionIdsByMember[key]) divisionIdsByMember[key] = [];
        divisionIdsByMember[key].push(assignment.division_id);
      });
    }

    var members = await Promise.all(rows.map(async function(row) {
      var email = null;
      var userLookup = await supabaseLegacyAdmin.auth.admin.getUserById(row.member_auth_user_id);
      if (!userLookup.error && userLookup.data && userLookup.data.user) {
        email = userLookup.data.user.email;
      }

      return {
        id: row.id,
        email: email,
        role: row.role,
        can_edit_assets: row.can_edit_assets,
        can_edit_jobs: row.can_edit_jobs,
        can_view_change_log: row.can_view_change_log,
        created_at: row.created_at,
        scope: row.scope || 'all',
        division_ids: divisionIdsByMember[row.member_auth_user_id] || []
      };
    }));

    return res.status(200).json({ ok: true, members: members });

  } catch (err) {
    return res.status(500).json({ error: err.message || 'Failed to list team members' });
  }
}

module.exports = handler;
