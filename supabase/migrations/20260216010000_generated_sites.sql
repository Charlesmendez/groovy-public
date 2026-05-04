-- Generated Sites: AI-built Next.js apps deployed to Vercel under our team account.
-- Users never need GitHub or Vercel accounts.

-- Sites table
create table if not exists public.generated_sites (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  slug text not null,
  name text not null default '',
  -- Vercel state (set after first deploy)
  vercel_project_id text,
  vercel_project_name text,
  latest_deployment_id text,
  latest_deployment_url text,
  latest_deployment_status text default 'none', -- none/QUEUED/BUILDING/READY/ERROR
  -- Local dev state
  local_path text,                               -- e.g. ~/.groovy/sites/<slug>
  -- Lifecycle
  status text not null default 'draft',          -- draft/dev/deploying/live/error
  deploy_count int not null default 0,
  deploy_count_window int not null default 0,
  deploy_window_started_at timestamptz not null default now(),
  last_build_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, slug)
);

alter table public.generated_sites enable row level security;

create policy "Users manage own sites"
  on public.generated_sites for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Custom domains attached to sites
create table if not exists public.generated_site_domains (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.generated_sites(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  domain text not null,
  verified boolean not null default false,
  verification_challenge jsonb,   -- TXT record details from Vercel
  dns_config jsonb,               -- A/CNAME records from GET /v6/domains/{domain}/config
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(site_id, domain)
);

alter table public.generated_site_domains enable row level security;

create policy "Users manage own site domains"
  on public.generated_site_domains for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Index for fast lookup
create index if not exists idx_generated_sites_user on public.generated_sites(user_id);
create index if not exists idx_generated_site_domains_site on public.generated_site_domains(site_id);
