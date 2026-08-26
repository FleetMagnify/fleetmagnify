-- Per-account feature flag for the Orion Work Order Fuel Report.
-- Run in Supabase SQL Editor before deploying the gated UI.
--
-- Gate on the resolved account owner (effectiveAccountId via account_members),
-- never on auth.uid() alone — members of ILS (e.g. Riki, Peter) resolve to
-- the ILS owner row below and inherit this flag.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS has_work_order_report boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN profiles.has_work_order_report IS
  'When true, account may access the Orion Work Order Fuel Report (and its nav link).';

-- Independent Line Services (directors' fleet / toby@svce.co.nz)
UPDATE profiles
SET has_work_order_report = true
WHERE id = 'd2ed89c3-dcaf-48b3-826a-f73802e4cf74';

-- Manual check (optional):
--   ILS owner  d2ed89c3-dcaf-48b3-826a-f73802e4cf74 → true
--   Monro      59dd8c6a-1146-4245-978b-6550095ea6c8 → false (default)
-- SELECT id, company_name, has_work_order_report
-- FROM profiles
-- WHERE id IN (
--   'd2ed89c3-dcaf-48b3-826a-f73802e4cf74',
--   '59dd8c6a-1146-4245-978b-6550095ea6c8'
-- );
