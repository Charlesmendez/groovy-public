-- Add salesforce and web_pixel to datagran provider check constraint

-- Drop the existing constraint
alter table public.datagran_agent_configs 
drop constraint if exists datagran_agent_configs_provider_check;

-- Add the updated constraint with new providers
alter table public.datagran_agent_configs 
add constraint datagran_agent_configs_provider_check 
check (provider in (
  'facebook_ads', 'facebook_leads', 'instagram', 'google_ads', 
  'linkedin_ads', 'google_drive', 'tiktok', 'postgres', 'firecrawl',
  'salesforce', 'web_pixel'
));
