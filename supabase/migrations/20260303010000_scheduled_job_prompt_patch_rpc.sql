-- Atomically update orchestrator scheduled job prompt without clobbering other task fields.
create or replace function public.scheduled_job_set_orchestrator_prompt(
  p_job_id uuid,
  p_message text
)
returns public.scheduled_jobs
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_job public.scheduled_jobs%rowtype;
  v_message text := btrim(coalesce(p_message, ''));
begin
  if v_message = '' then
    raise exception 'Task prompt cannot be empty.';
  end if;

  update public.scheduled_jobs
  set
    task = jsonb_set(
      case
        when jsonb_typeof(task) = 'object' then task
        else '{}'::jsonb
      end,
      '{message}',
      to_jsonb(v_message),
      true
    ),
    updated_at = now()
  where id = p_job_id
    and user_id = auth.uid()
    and kind = 'orchestrator'
  returning * into v_job;

  if not found then
    raise exception 'Scheduled orchestrator job not found.';
  end if;

  return v_job;
end;
$$;

grant execute on function public.scheduled_job_set_orchestrator_prompt(uuid, text) to authenticated;
