-- RLS / security-definer hardening before onboarding a new customer.
-- Run in the Supabase SQL Editor (project pddsgvuzvuwueuvpoytw).
-- Idempotent: safe to re-run.
--
-- Priority 1 — jobs is missing UPDATE and DELETE policies.
--   Live UI in job-cost-analyst.html updates tonnes_moved and status, and
--   also deletes jobs. Without these policies PostgREST reports success
--   with zero rows affected, so the UI toasts success while the row never
--   changes.
-- Priority 2 — fuel_calibration_intervals has RLS enabled and no policies.
-- Priority 3 — pin is_account_member search_path.
-- Priority 4 — hide is_account_member from PostgREST /rest/v1/rpc without
--   revoking EXECUTE from authenticated (that would break every RLS policy
--   that calls this function).
--
-- Do NOT add the `private` schema to API "Exposed schemas". PostgREST only
-- needs the function for policy evaluation, which is a separate path from
-- the Data API. Confirmed against:
--   https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable
--   https://supabase.com/docs/guides/troubleshooting/do-i-need-to-expose-security-definer-functions-in-row-level-security-policies-iI0uOw
--   https://supabase.com/docs/guides/database/postgres/row-level-security
--     ("Never create [a security definer function] in a schema listed under
--      Exposed schemas"; helpers live in `private`.)

-- ---------------------------------------------------------------------------
-- Priority 4 + 3: private schema, move helper, pin search_path
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS private;

COMMENT ON SCHEMA private IS
  'Internal helpers for RLS. Not exposed via PostgREST. Do not add to API Exposed schemas.';

-- Policy evaluation runs as the querying role, so that role still needs
-- USAGE on this schema and EXECUTE on the function. Moving the function
-- out of `public` is what removes /rest/v1/rpc/is_account_member.
GRANT USAGE ON SCHEMA private TO authenticated, anon;

DO $$
DECLARE
  func_schema text;
BEGIN
  SELECT n.nspname INTO func_schema
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.proname = 'is_account_member'
    AND pg_get_function_identity_arguments(p.oid) = 'uuid'
  LIMIT 1;

  IF func_schema IS NULL THEN
    RAISE EXCEPTION 'is_account_member(uuid) not found';
  END IF;

  IF func_schema = 'public' THEN
    -- Existing pg_policy expressions store this function by OID, so they
    -- keep working after the move. New policies must schema-qualify.
    EXECUTE 'ALTER FUNCTION public.is_account_member(uuid) SET SCHEMA private';
  ELSIF func_schema <> 'private' THEN
    RAISE EXCEPTION 'is_account_member(uuid) lives in unexpected schema %', func_schema;
  END IF;
END $$;

-- Pin name resolution. `public` rather than '' so the existing function
-- body can keep unqualified public-table references (we are not rewriting
-- the body). This is the low-risk option from the advisor finding.
ALTER FUNCTION private.is_account_member(uuid) SET search_path = public;

-- Explicit grants BEFORE revoking PUBLIC, so authenticated/anon do not lose
-- EXECUTE when the default PUBLIC grant is removed. Do not revoke from
-- authenticated — Postgres requires the querying role to EXECUTE functions
-- referenced in policy expressions.
GRANT EXECUTE ON FUNCTION private.is_account_member(uuid) TO authenticated, anon;
REVOKE ALL ON FUNCTION private.is_account_member(uuid) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Priority 1: jobs UPDATE + DELETE
-- Same is_account_member(user_id) USING / WITH CHECK pattern as
-- fuel_purchases / telematics_records / assets.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Account members can update jobs" ON public.jobs;
CREATE POLICY "Account members can update jobs"
  ON public.jobs
  FOR UPDATE
  TO authenticated
  USING (private.is_account_member(user_id))
  WITH CHECK (private.is_account_member(user_id));

DROP POLICY IF EXISTS "Account members can delete jobs" ON public.jobs;
CREATE POLICY "Account members can delete jobs"
  ON public.jobs
  FOR DELETE
  TO authenticated
  USING (private.is_account_member(user_id));

-- ---------------------------------------------------------------------------
-- Priority 2: fuel_calibration_intervals full CRUD
-- Currently only service-role scripts touch this table. Policies make it
-- safe if a client feature ever reads it directly.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'fuel_calibration_intervals'
      AND column_name = 'user_id'
  ) THEN
    RAISE EXCEPTION 'fuel_calibration_intervals.user_id is missing; cannot create is_account_member policies';
  END IF;
END $$;

DROP POLICY IF EXISTS "Account members can select fuel calibration intervals"
  ON public.fuel_calibration_intervals;
CREATE POLICY "Account members can select fuel calibration intervals"
  ON public.fuel_calibration_intervals
  FOR SELECT
  TO authenticated
  USING (private.is_account_member(user_id));

DROP POLICY IF EXISTS "Account members can insert fuel calibration intervals"
  ON public.fuel_calibration_intervals;
CREATE POLICY "Account members can insert fuel calibration intervals"
  ON public.fuel_calibration_intervals
  FOR INSERT
  TO authenticated
  WITH CHECK (private.is_account_member(user_id));

DROP POLICY IF EXISTS "Account members can update fuel calibration intervals"
  ON public.fuel_calibration_intervals;
CREATE POLICY "Account members can update fuel calibration intervals"
  ON public.fuel_calibration_intervals
  FOR UPDATE
  TO authenticated
  USING (private.is_account_member(user_id))
  WITH CHECK (private.is_account_member(user_id));

DROP POLICY IF EXISTS "Account members can delete fuel calibration intervals"
  ON public.fuel_calibration_intervals;
CREATE POLICY "Account members can delete fuel calibration intervals"
  ON public.fuel_calibration_intervals
  FOR DELETE
  TO authenticated
  USING (private.is_account_member(user_id));

NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- Post-apply checks (run these in the same session; they do not change data)
-- ---------------------------------------------------------------------------
-- Function is no longer in public, search_path is pinned, still SECURITY DEFINER:
--   SELECT n.nspname, p.proname, p.prosecdef, p.proconfig
--   FROM pg_proc p
--   JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE p.proname = 'is_account_member';
--
-- jobs now has INSERT/SELECT/UPDATE/DELETE policies:
--   SELECT polname, polcmd FROM pg_policy
--   WHERE polrelid = 'public.jobs'::regclass
--   ORDER BY polcmd, polname;
--
-- fuel_calibration_intervals now has four policies:
--   SELECT polname, polcmd FROM pg_policy
--   WHERE polrelid = 'public.fuel_calibration_intervals'::regclass
--   ORDER BY polcmd, polname;
--
-- Existing policies still resolve the moved function (OID-stable):
--   SELECT c.relname, pol.polname, pg_get_expr(pol.polqual, pol.polrelid)
--   FROM pg_policy pol
--   JOIN pg_class c ON c.oid = pol.polrelid
--   WHERE pg_get_expr(pol.polqual, pol.polrelid) ILIKE '%is_account_member%'
--   ORDER BY c.relname, pol.polname;
--
-- The SQL editor runs as a superuser and bypasses RLS, so it cannot prove
-- that authenticated SELECT/INSERT/UPDATE still works. After this script,
-- confirm from a signed-in app session (or a JWT as authenticated) against
-- assets, fuel_purchases, and telematics_records.
