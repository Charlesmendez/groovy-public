-- Additive private accounting; existing runs remain explicitly unmetered.
-- No execution, binding activation, billing debit or history rewrite.
alter table public.home_inbox_decision_runs add column usage_receipt jsonb;
alter table public.home_inbox_decision_runs add constraint home_inbox_usage_receipt_shape check ((
  usage_receipt is null or (
    jsonb_typeof(usage_receipt)='object' and usage_receipt->>'version'='1'
    and usage_receipt->>'status' in ('partial','reported')
    and jsonb_typeof(usage_receipt->'components')='array'
    and jsonb_array_length(usage_receipt->'components')<=128
    and octet_length(usage_receipt::text)<=131072
  )
) is true);
-- The existing run table is service-role-only with RLS. A dedicated reporting
-- projection must authorize the exact Home tenant/project and omit payloads.
create index home_inbox_usage_reporting on public.home_inbox_decision_runs(binding_id,created_at);

create function public.home_inbox_usage_report(p_tenant uuid,p_project uuid,p_origin text,p_from timestamptz,p_to timestamptz)
returns jsonb language plpgsql stable security invoker set search_path=public as $$
declare result jsonb;
begin
  if p_tenant is null or p_project is null or p_origin is null or p_from is null or p_to is null
    or p_to<=p_from or p_to-p_from>interval '90 days' then raise exception 'invalid_usage_scope'; end if;
  with runs as (
    select r.id,r.usage_receipt from public.home_inbox_decision_runs r
    join public.home_inbox_bindings b on b.id=r.binding_id
    where b.tenant_id=p_tenant and b.project_id=p_project and b.home_origin=p_origin
      and r.created_at>=p_from and r.created_at<p_to
      -- Paused/revoked bindings and failed runs retain their historical costs.
  ), per_run as (
    select r.id,r.usage_receipt->>'status' as status,count(c.value) as components,
      sum((c.value->>'input_tokens')::bigint) as input_tokens,
      sum((c.value->>'output_tokens')::bigint) as output_tokens,
      sum((c.value->>'cached_input_tokens')::bigint) as cached_input_tokens,
      sum(round((c.value->>'provider_cost_usd')::numeric*1000000)) as cost,
      count(*) filter(where c.value->>'provider_cost_usd' is null) as unpriced
    from runs r left join lateral jsonb_array_elements(r.usage_receipt->'components') c(value) on true
    group by r.id,r.usage_receipt->>'status'
  ) select jsonb_build_object('records',count(*),
    'input_tokens',sum(input_tokens),'output_tokens',sum(output_tokens),'cached_input_tokens',sum(cached_input_tokens),
    'known_cost_micros',coalesce(sum(cost),0),
    'unmetered_records',count(*) filter(where status is distinct from 'reported'),
    'unpriced_records',count(*) filter(where components=0 or unpriced>0 or status is distinct from 'reported'))
  into result from per_run;
  return result;
end $$;
revoke all on function public.home_inbox_usage_report(uuid,uuid,text,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.home_inbox_usage_report(uuid,uuid,text,timestamptz,timestamptz) to service_role;
