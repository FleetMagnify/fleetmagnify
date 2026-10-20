const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

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

  var userResult = await supabase.auth.getUser();
  if (userResult.error || !userResult.data.user) {
    return res.status(401).json({ error: 'Invalid session' });
  }

  var userId = userResult.data.user.id;

  // The client above sends the caller's JWT, so PostgREST would evaluate
  // RLS as that user. Membership is checked with a clean service-role
  // client, the same way invite-account-member.js does.
  var supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  var memberCheck = await supabaseAdmin
    .from('account_members')
    .select('account_owner_user_id')
    .eq('member_auth_user_id', userId)
    .maybeSingle();

  if (memberCheck.error) {
    console.error('create-portal-session: membership lookup failed', memberCheck.error.message);
    return res.status(500).json({ error: 'Could not verify account ownership' });
  }

  if (memberCheck.data) {
    return res.status(403).json({ error: 'Billing is managed by your account owner' });
  }

  var profileResult = await supabase
    .from('profiles')
    .select('stripe_customer_id')
    .eq('id', userId)
    .maybeSingle();

  if (profileResult.error || !profileResult.data || !profileResult.data.stripe_customer_id) {
    return res.status(400).json({ error: 'No billing account found' });
  }

  var stripe = Stripe(process.env.STRIPE_SECRET_KEY);

  var session = await stripe.billingPortal.sessions.create({
    customer: profileResult.data.stripe_customer_id,
    return_url: 'https://fleetmagnify.com/settings.html',
  });

  return res.status(200).json({ url: session.url });
};
