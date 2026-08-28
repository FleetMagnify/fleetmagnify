-- Optional columns used by the QA audit fixes (FM-02/04/09, Priority 2).
-- Safe to re-run. Existing rows keep NULL until the demo generator or
-- Assets page writes values.

ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS usage_profile text;

ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS ruc_rate_per_km numeric;

COMMENT ON COLUMN assets.usage_profile IS
  'regular | intermittent | on-call. Intermittent assets (e.g. plant transporters) are scored on days worked rather than a flat utilisation %, and skip target-exceeded flags on active days.';

COMMENT ON COLUMN assets.ruc_rate_per_km IS
  'NZ Road User Charges rate in NZD per kilometre. NULL = derive from GVM class.';
