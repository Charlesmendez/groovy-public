-- Kapso setup link + phone number metadata
alter table public.workspace_company_whatsapp
  add column if not exists kapso_customer_id text null,
  add column if not exists setup_link_id text null,
  add column if not exists setup_link_url text null,
  add column if not exists phone_number_id text null,
  add column if not exists business_account_id text null,
  add column if not exists provisioned_phone_number_id text null,
  add column if not exists display_phone_number text null;
