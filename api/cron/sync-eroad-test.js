/**
 * TEST/POC cron only — sync-eroad-test inserts a placeholder telematics row.
 * Replace with real eRoad sync logic once API credentials are available.
 * Scheduled via vercel.json for 2:00 AM New Zealand (UTC+13), which is 13:00 UTC
 * the previous calendar day (cron: "0 13 * * *").
 */
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://pddsgvuzvuwueuvpoytw.supabase.co';

module.exports = async function handler(req, res) {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const testUserId = process.env.TEST_USER_ID;
  const testAssetId = process.env.TEST_ASSET_ID;

  if (!serviceRoleKey) {
    return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY is not configured' });
  }
  if (!testUserId) {
    return res.status(500).json({ error: 'TEST_USER_ID is not configured' });
  }
  if (!testAssetId) {
    return res.status(500).json({ error: 'TEST_ASSET_ID is not configured' });
  }

  const supabase = createClient(SUPABASE_URL, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const recordDate = new Date().toISOString().slice(0, 10);
  const timestamp = new Date().toISOString();

  const row = {
    user_id: testUserId,
    asset_id: Number(testAssetId),
    record_date: recordDate,
    total_engine_hours: 0,
    operating_hours: 0,
    idle_hours: 0,
    odometer_km: 0
  };

  const { error } = await supabase.from('telematics_records').insert(row);

  if (error) {
    console.error('Cron test sync failed:', error.message);
    return res.status(500).json({ error: error.message });
  }

  console.log('Cron test sync ran successfully at ' + timestamp);

  return res.status(200).json({
    message: 'Cron test sync completed successfully',
    timestamp,
    record_date: recordDate,
    inserted: row
  });
};
