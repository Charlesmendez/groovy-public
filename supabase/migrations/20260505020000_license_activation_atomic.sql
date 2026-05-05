create or replace function public.activate_license_device_atomic(
  p_license_id uuid,
  p_device_hash text,
  p_device_name text default null,
  p_platform text default null,
  p_app_version text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_max_devices integer;
  v_active_count integer;
  v_activation_id uuid;
begin
  if p_license_id is null or nullif(btrim(coalesce(p_device_hash, '')), '') is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_activation_request');
  end if;

  select max_devices
    into v_max_devices
    from public.licenses
   where id = p_license_id
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'missing_license');
  end if;

  select id
    into v_activation_id
    from public.license_devices
   where license_id = p_license_id
     and device_hash = p_device_hash
     and deactivated_at is null
   limit 1;

  if v_activation_id is not null then
    update public.license_devices
       set device_name = p_device_name,
           platform = p_platform,
           app_version = p_app_version,
           last_seen_at = now()
     where id = v_activation_id;

    return jsonb_build_object('ok', true, 'activation_id', v_activation_id);
  end if;

  if v_max_devices is not null and v_max_devices > 0 then
    select count(*)
      into v_active_count
      from public.license_devices
     where license_id = p_license_id
       and deactivated_at is null;

    if v_active_count >= v_max_devices then
      return jsonb_build_object('ok', false, 'reason', 'device_limit_reached');
    end if;
  end if;

  insert into public.license_devices (
    license_id,
    device_hash,
    device_name,
    platform,
    app_version
  )
  values (
    p_license_id,
    p_device_hash,
    p_device_name,
    p_platform,
    p_app_version
  )
  returning id into v_activation_id;

  return jsonb_build_object('ok', true, 'activation_id', v_activation_id);
exception
  when unique_violation then
    select id
      into v_activation_id
      from public.license_devices
     where license_id = p_license_id
       and device_hash = p_device_hash
       and deactivated_at is null
     limit 1;

    if v_activation_id is null then
      return jsonb_build_object('ok', false, 'reason', 'device_insert_failed');
    end if;

    update public.license_devices
       set device_name = p_device_name,
           platform = p_platform,
           app_version = p_app_version,
           last_seen_at = now()
     where id = v_activation_id;

    return jsonb_build_object('ok', true, 'activation_id', v_activation_id);
end;
$$;

revoke all on function public.activate_license_device_atomic(uuid, text, text, text, text) from public;
grant execute on function public.activate_license_device_atomic(uuid, text, text, text, text) to service_role;
