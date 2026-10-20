-- Orion Work Order Fuel Report: vehicle ID mapping
-- Run in Supabase SQL Editor
--
-- Orion's monthly "Customer Hours" export uses its own Vehicle ID strings
-- (e.g. "T31 Traffic Leased", "LV1 - Bucket Leased") which don't always
-- exact-match FleetMagnify's assets.asset_name. This table lets a user map
-- an Orion Vehicle ID to a real asset once; the report auto-applies the
-- mapping on every future upload.

CREATE TABLE IF NOT EXISTS vehicle_id_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  raw_vehicle_id text NOT NULL,
  asset_id bigint REFERENCES assets(id) ON DELETE CASCADE,
  -- asset_id is nullable: a mapping can be explicitly "not tracked" (e.g.
  -- leased/traffic-control vehicles with no FleetMagnify telematics), which
  -- is recorded here so the report stops asking about it every month.
  not_tracked boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS vehicle_id_aliases_user_raw_key
  ON vehicle_id_aliases (user_id, raw_vehicle_id);

CREATE INDEX IF NOT EXISTS vehicle_id_aliases_user_id_idx ON vehicle_id_aliases (user_id);

ALTER TABLE vehicle_id_aliases ENABLE ROW LEVEL SECURITY;

-- Data API exposure is opt-in for new public tables from 30 Oct 2026.
-- The Orion report reads and upserts aliases as the signed-in user.
-- anon: none. Logged-out clients must not see or write mappings.
-- authenticated: SELECT, INSERT, UPDATE, DELETE, each limited to own rows.
-- service_role: same DML for server scripts. service_role bypasses RLS.
-- REVOKE first so a pre-cutoff auto-grant cannot leave anon access behind.
REVOKE ALL ON TABLE vehicle_id_aliases FROM PUBLIC;
REVOKE ALL ON TABLE vehicle_id_aliases FROM anon;
REVOKE ALL ON TABLE vehicle_id_aliases FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE vehicle_id_aliases TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE vehicle_id_aliases TO service_role;

DROP POLICY IF EXISTS "Users can read own vehicle aliases" ON vehicle_id_aliases;
CREATE POLICY "Users can read own vehicle aliases"
  ON vehicle_id_aliases
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own vehicle aliases" ON vehicle_id_aliases;
CREATE POLICY "Users can insert own vehicle aliases"
  ON vehicle_id_aliases
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own vehicle aliases" ON vehicle_id_aliases;
CREATE POLICY "Users can update own vehicle aliases"
  ON vehicle_id_aliases
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own vehicle aliases" ON vehicle_id_aliases;
CREATE POLICY "Users can delete own vehicle aliases"
  ON vehicle_id_aliases
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);
