-- Persist VisionLink (and future OEM) per-row data-quality warnings
-- Run in Supabase SQL Editor before VisionLink imports go live

ALTER TABLE telematics_records
  ADD COLUMN IF NOT EXISTS data_quality_notes text;

COMMENT ON COLUMN telematics_records.data_quality_notes IS
  'OEM data-quality warnings for this asset/date (e.g. VisionLink Callouts).';
