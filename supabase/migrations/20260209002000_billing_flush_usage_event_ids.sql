-- Ensure flush windows can pin exact usage event IDs for retry safety.
alter table public.billing_stripe_flush_windows
  add column if not exists usage_event_ids uuid[] null;

