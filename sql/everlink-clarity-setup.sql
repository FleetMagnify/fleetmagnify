-- Everlink Clarity asset matching key (Maugers-style on-site bowser exports).
-- Safe to re-run. Existing rows keep NULL until an asset register is linked.
--
-- Unique per account, not platform-wide: codes like P270 are only unique
-- within one Maugers-style customer, unlike BP card numbers.

ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS everlink_asset_no text;

CREATE UNIQUE INDEX IF NOT EXISTS assets_user_everlink_asset_no_key
  ON assets (user_id, everlink_asset_no)
  WHERE everlink_asset_no IS NOT NULL;

COMMENT ON COLUMN assets.everlink_asset_no IS
  'Everlink Clarity AssetNo. Unique within one user account (e.g. Maugers P270); not unique platform-wide.';
