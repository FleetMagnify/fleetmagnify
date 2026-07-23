const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var authHeader = req.headers.authorization || '';
  var token = authHeader.replace('Bearer ', '').trim();
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  var memberId = req.body && req.body.member_id;

  if (!memberId) {
    return res.status(400).json({ error: 'member_id is required' });
  }

  var supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: 'Bearer ' + token } }
    }
  );

  // Clean service-role client with no Authorization header override — this is
  // the only client used for account_members reads/deletes below, so RLS is
  // actually bypassed via the service_role key rather than being evaluated
  // against the caller's own JWT (which is what `supabase` above sends).
  var supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  // Temporary: auth.admin.* methods are incompatible with the newer sb_secret_
  // key format, so this dedicated client uses the legacy service_role JWT
  // solely for the deleteUser call below. Everything else in this file
  // uses supabase (session verification only) or supabaseAdmin (database
  // reads/deletes) with the new-format key.
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
    // who was themselves invited into someone else's account) can remove
    // team members. This mirrors the resolveAccountId lookup used elsewhere
    // in the app — if the caller has an account_members row pointing at a
    // different owner, they're a member, not an owner, and can't remove
    // anyone.
    var callerMemberCheck = await supabaseAdmin
      .from('account_members')
      .select('account_owner_user_id')
      .eq('member_auth_user_id', callerId)
      .maybeSingle();

    if (callerMemberCheck.error) {
      return res.status(500).json({ error: 'Failed to verify account ownership: ' + callerMemberCheck.error.message });
    }

    if (callerMemberCheck.data && callerMemberCheck.data.account_owner_user_id && callerMemberCheck.data.account_owner_user_id !== callerId) {
      return res.status(403).json({ error: 'Only the account owner can remove team members.' });
    }

    // Look up the target membership row and confirm it belongs to the
    // caller's own account — otherwise one owner could remove another
    // account's members simply by guessing member_id values.
    var memberLookup = await supabaseAdmin
      .from('account_members')
      .select('id, account_owner_user_id, member_auth_user_id')
      .eq('id', memberId)
      .maybeSingle();

    if (memberLookup.error) {
      return res.status(500).json({ error: 'Failed to look up team member: ' + memberLookup.error.message });
    }

    if (!memberLookup.data || memberLookup.data.account_owner_user_id !== callerId) {
      return res.status(404).json({ error: 'Team member not found' });
    }

    var memberAuthUserId = memberLookup.data.member_auth_user_id;

    var deleteResult = await supabaseAdmin
      .from('account_members')
      .delete()
      .eq('id', memberId);

    if (deleteResult.error) {
      return res.status(500).json({ error: 'Failed to remove team member: ' + deleteResult.error.message });
    }

    // Membership row is gone at this point — now fully delete the underlying
    // login so the removed person can't sign in at all.
    var deleteUserResult = await supabaseLegacyAdmin.auth.admin.deleteUser(memberAuthUserId);

    if (deleteUserResult.error) {
      return res.status(500).json({ error: 'Team member access was revoked, but failed to fully delete the login: ' + deleteUserResult.error.message });
    }

    return res.status(200).json({ ok: true });

  } catch (err) {
    return res.status(500).json({ error: err.message || 'Failed to remove team member' });
  }
};
