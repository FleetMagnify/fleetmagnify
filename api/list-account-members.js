const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  var authHeader = req.headers.authorization || '';
  var token = authHeader.replace('Bearer ', '').trim();
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  var supabase = createClient(
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
  var supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  // Temporary: auth.admin.* methods are incompatible with the newer sb_secret_
  // key format, so this dedicated client uses the legacy service_role JWT
  // solely for the getUserById calls below.
  var supabaseLegacyAdmin = createClient(
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
      .select('id, member_auth_user_id, role, can_edit_assets, can_edit_jobs, can_view_change_log, created_at')
      .eq('account_owner_user_id', callerId)
      .order('created_at', { ascending: true });

    if (membersResult.error) {
      return res.status(500).json({ error: 'Failed to load team members: ' + membersResult.error.message });
    }

    var rows = membersResult.data || [];

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
        created_at: row.created_at
      };
    }));

    return res.status(200).json({ ok: true, members: members });

  } catch (err) {
    return res.status(500).json({ error: err.message || 'Failed to list team members' });
  }
};
