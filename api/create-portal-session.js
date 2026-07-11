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
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  var userResult = await supabase.auth.getUser(token);
  if (userResult.error || !userResult.data.user) {
    return res.status(401).json({ error: 'Invalid session' });
  }

  var userId = userResult.data.user.id;

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
