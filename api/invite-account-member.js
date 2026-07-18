const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var authHeader = req.headers.authorization || '';
  var token = authHeader.replace('Bearer ', '').trim();
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  var email = req.body && req.body.email;
  var role = req.body && req.body.role;
  var canEditAssets = req.body ? req.body.can_edit_assets : undefined;
  var canEditJobs = req.body ? req.body.can_edit_jobs : undefined;
  var canViewChangeLog = req.body ? req.body.can_view_change_log : undefined;

  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'email is required' });
  }
  if (!role || typeof role !== 'string') {
    return res.status(400).json({ error: 'role is required' });
  }
  if (typeof canEditAssets !== 'boolean' || typeof canEditJobs !== 'boolean' || typeof canViewChangeLog !== 'boolean') {
    return res.status(400).json({ error: 'can_edit_assets, can_edit_jobs, and can_view_change_log must all be provided as booleans' });
  }

  var supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  var userResult = await supabase.auth.getUser(token);
  if (userResult.error || !userResult.data.user) {
    return res.status(401).json({ error: 'Invalid session' });
  }
  var callerId = userResult.data.user.id;

  try {
    // Authorization: only the actual account owner (never a delegated member
    // who was themselves invited into someone else's account) can invite new
    // people. This mirrors the resolveAccountId lookup used elsewhere in the
    // app — if the caller has an account_members row pointing at a different
    // owner, they're a member, not an owner, and can't invite anyone.
    var memberCheck = await supabase
      .from('account_members')
      .select('account_owner_user_id')
      .eq('member_auth_user_id', callerId)
      .maybeSingle();

    if (memberCheck.error) {
      return res.status(500).json({ error: 'Failed to verify account ownership: ' + memberCheck.error.message });
    }

    if (memberCheck.data && memberCheck.data.account_owner_user_id && memberCheck.data.account_owner_user_id !== callerId) {
      return res.status(403).json({ error: 'Only the account owner can invite team members.' });
    }

    // Creates the new person's auth account with no password and sends them
    // a real invite email.
    var inviteResult = await supabase.auth.admin.inviteUserByEmail(email, {
      redirectTo: 'https://fleetmagnify.com/accept-invite.html'
    });

    if (inviteResult.error) {
      return res.status(400).json({ error: inviteResult.error.message || 'Failed to send invite' });
    }

    var newUser = inviteResult.data && inviteResult.data.user;
    if (!newUser || !newUser.id) {
      return res.status(500).json({ error: 'Invite succeeded but no user was returned' });
    }

    // can_manage_users is intentionally hardcoded to false here and never
    // read from the request body — user management is owner-only, not
    // checkbox-grantable.
    var insertResult = await supabase
      .from('account_members')
      .insert({
        account_owner_user_id: callerId,
        member_auth_user_id: newUser.id,
        role: role,
        can_edit_assets: canEditAssets,
        can_edit_jobs: canEditJobs,
        can_view_change_log: canViewChangeLog,
        can_manage_users: false,
        invited_by: callerId
      });

    if (insertResult.error) {
      return res.status(500).json({ error: 'Invite sent, but failed to save member record: ' + insertResult.error.message });
    }

    return res.status(200).json({ ok: true });

  } catch (err) {
    return res.status(500).json({ error: err.message || 'Invite failed' });
  }
};
