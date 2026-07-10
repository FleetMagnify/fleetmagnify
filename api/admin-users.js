const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-secret');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // Gate: check shared secret
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  // LIST users
  if (req.method === 'GET') {
    try {
      const { data, error } = await supabase.auth.admin.listUsers({ perPage: 1000 });
      if (error) return res.status(500).json({ error: error.message });
      const users = (data.users || []).map(function(u) {
        return {
          id: u.id,
          email: u.email,
          created_at: u.created_at,
          last_sign_in_at: u.last_sign_in_at,
          company_name: (u.user_metadata && u.user_metadata.company_name) || null
        };
      });
      return res.status(200).json({ users });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // GENERATE magic link for a user
  if (req.method === 'POST') {
    try {
      const { email } = req.body;
      if (!email) return res.status(400).json({ error: 'Email required' });
      const { data, error } = await supabase.auth.admin.generateLink({
        type: 'magiclink',
        email: email,
        options: {
          redirectTo: 'https://fleetmagnify.com/home.html'
        }
      });
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ link: data.properties.action_link });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
