-- Optional columns used by the QA audit fixes (FM-02/04/09, Priority 2).
-- Safe to re-run. Existing rows keep NULL until the demo generator or
-- Assets page writes values.

ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS usage_profile text;

ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS ruc_rate_per_km numeric;

ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS idle_rate_source text;

COMMENT ON COLUMN assets.usage_profile IS
  'regular | intermittent | on-call. Intermittent assets (e.g. plant transporters) are scored on days worked rather than a flat utilisation %, and skip target-exceeded flags on active days.';

COMMENT ON COLUMN assets.ruc_rate_per_km IS
  'NZ Road User Charges rate in NZD per kilometre. NULL = derive from GVM class.';

COMMENT ON COLUMN assets.idle_rate_source IS
  'calibrated = fill-to-fill residual was accepted and stored; set = entered on the asset; NULL = use the class default estimate. last_calibrated_at is the travel-rate timestamp and must not be used as the idle Calibrated flag.';
