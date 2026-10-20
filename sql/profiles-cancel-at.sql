-- Scheduled cancellation time copied from Stripe (customer.subscription.updated).
-- Null means the subscription is not set to end.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS cancel_at timestamptz;
