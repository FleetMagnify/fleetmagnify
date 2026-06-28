-- Inbound email (SendGrid) setup for OEM telematics CSV imports
-- Run in Supabase SQL Editor

-- Per-user upload address prefix (e.g. monro-a3x9 from monro-a3x9@uploads.fleetmagnify.com)
ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS upload_email text;

CREATE UNIQUE INDEX IF NOT EXISTS user_settings_upload_email_key
  ON user_settings (upload_email)
  WHERE upload_email IS NOT NULL;

-- Raw CSV payloads received via inbound email webhook
CREATE TABLE IF NOT EXISTS email_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  received_at timestamptz NOT NULL DEFAULT now(),
  from_email text,
  to_email text NOT NULL,
  filename text,
  raw_csv text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_imports_user_id_idx ON email_imports (user_id);
CREATE INDEX IF NOT EXISTS email_imports_status_idx ON email_imports (status);
CREATE INDEX IF NOT EXISTS email_imports_received_at_idx ON email_imports (received_at DESC);

ALTER TABLE email_imports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own email imports"
  ON email_imports
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);
