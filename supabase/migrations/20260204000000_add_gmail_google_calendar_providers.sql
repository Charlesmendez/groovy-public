-- Add gmail and google_calendar to datagran provider check constraint

alter table public.datagran_agent_configs
drop constraint if exists datagran_agent_configs_provider_check;

alter table public.datagran_agent_configs
add constraint datagran_agent_configs_provider_check
check (provider in (
  'facebook_ads', 'facebook_leads', 'instagram', 'google_ads',
  'google_calendar', 'gmail', 'linkedin_ads', 'google_drive',
  'tiktok', 'postgres', 'firecrawl', 'salesforce', 'hubspot',
  'web_pixel'
));
