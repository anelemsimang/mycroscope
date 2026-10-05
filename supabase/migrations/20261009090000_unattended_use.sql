-- PCs used while nobody is tracked.
--
-- After someone signs in, the desktop agent registers a random per-PC key. While nobody is signed in
-- (or the monitoring notice has not been accepted) and the PC is in use, the agent shows a sign-in reminder;
-- after 15 minutes of use it reports with that key, without any employee session. The first report of an
-- episode creates an 'unattended_use' event on the device's last signed-in employee, which managers see as an
-- alert. Later reports update the duration. Nothing about what the PC was used for is sent.

create table public.device_report_keys (
  device_id uuid primary key references public.devices (id) on delete cascade,
  key_hash text not null,
  unattended_since timestamptz,
  unattended_seen_at timestamptz,
  unattended_event_id uuid,
  updated_at timestamptz not null default now()
);

alter table public.device_report_keys enable row level security;
revoke all on public.device_report_keys from anon, authenticated;

alter table public.agent_events drop constraint agent_events_event_type_check;
alter table public.agent_events add constraint agent_events_event_type_check check (event_type in (
  'login', 'logout', 'pause', 'resume', 'project_switch', 'sleep', 'wake',
  'lock', 'unlock', 'agent_start', 'agent_stop', 'clock_skew', 'data_rejected',
  'agent_gap', 'vm_detected', 'remote_session', 'input_anomaly', 'after_hours_use',
  'work_hours_start', 'work_hours_end', 'service_inactive', 'unattended_use'));

create or replace function public.report_key_hash(p_key text)
returns text
language sql
immutable
set search_path = public
as $$
  select encode(sha256(convert_to(p_key, 'UTF8')), 'hex');
$$;

-- Called by the signed-in agent; replaces the PC's key and ends any open episode.
create or replace function public.set_device_report_key(p_device uuid, p_key text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.owns_device(p_device) then
    raise exception 'Not allowed';
  end if;
  if p_key is null or length(p_key) < 32 or length(p_key) > 200 then
    raise exception 'Invalid key';
  end if;
  insert into public.device_report_keys (device_id, key_hash)
  values (p_device, public.report_key_hash(p_key))
  on conflict (device_id) do update
    set key_hash = excluded.key_hash, unattended_since = null, unattended_seen_at = null,
        unattended_event_id = null, updated_at = now();
end;
$$;

-- Called by the agent while nobody is signed in. Returns false for an unknown device or wrong key.
create or replace function public.report_unattended_use(p_device uuid, p_key text, p_minutes integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  k public.device_report_keys;
  d public.devices;
  mins integer := least(greatest(coalesce(p_minutes, 0), 0), 720);
  event_id uuid;
begin
  if mins < 15 or p_key is null then
    return false;
  end if;
  select * into k from public.device_report_keys where device_id = p_device for update;
  if k.device_id is null or k.key_hash <> public.report_key_hash(p_key) then
    return false;
  end if;
  select * into d from public.devices where id = p_device;

  if k.unattended_seen_at is null or k.unattended_seen_at < now() - interval '10 minutes'
     or k.unattended_event_id is null then
    event_id := gen_random_uuid();
    insert into public.agent_events (id, organization_id, employee_id, device_id, occurred_at, event_type, details)
    values (event_id, d.organization_id, d.employee_id, d.id, now() - make_interval(mins => mins),
            'unattended_use', jsonb_build_object('hostname', d.hostname, 'minutes', mins));
    update public.device_report_keys
    set unattended_since = now() - make_interval(mins => mins), unattended_seen_at = now(),
        unattended_event_id = event_id, updated_at = now()
    where device_id = p_device;
  else
    update public.agent_events
    set details = details || jsonb_build_object(
          'minutes', greatest(mins, round(extract(epoch from now() - k.unattended_since) / 60)::integer))
    where id = k.unattended_event_id;
    update public.device_report_keys set unattended_seen_at = now(), updated_at = now()
    where device_id = p_device;
  end if;
  return true;
end;
$$;

-- Same as before, plus 'unattended_use'.
create or replace function public.get_integrity_alerts(p_since timestamptz)
returns table (employee_id uuid, employee_name text, occurred_at timestamptz, kind text, severity text, details jsonb)
language sql
stable
security definer
set search_path = public
as $$
  with me as (
    select organization_id from public.employees
    where auth_user_id = auth.uid() and is_active and role in ('owner', 'manager')
  )
  select e.id, e.name, ev.occurred_at, ev.event_type,
         case
           when ev.event_type = 'agent_gap' and coalesce((ev.details ->> 'minutes')::numeric, 0) >= 10 then 'high'
           when ev.event_type in ('agent_gap', 'vm_detected', 'remote_session', 'input_anomaly', 'unattended_use')
             then 'medium'
           else 'low'
         end,
         ev.details
  from me
  join public.agent_events ev on ev.organization_id = me.organization_id
  join public.employees e on e.id = ev.employee_id
  where ev.occurred_at >= p_since
    and ev.event_type in ('agent_gap', 'vm_detected', 'remote_session', 'input_anomaly', 'clock_skew',
                          'after_hours_use', 'unattended_use')
    and public.can_view_employee(e.id)
    and public.is_manager_of(me.organization_id)
  union all
  select e.id, e.name, st.last_seen_at, 'not_reporting', 'low',
         jsonb_build_object('last_state', st.state, 'minutes', round(extract(epoch from now() - st.last_seen_at) / 60))
  from me
  join public.employees e on e.organization_id = me.organization_id and e.is_active and e.auth_user_id is not null
  join public.agent_status st on st.employee_id = e.id
  where public.is_work_time(me.organization_id, now())
    and st.last_seen_at < now() - interval '30 minutes'
    and st.last_seen_at > now() - interval '7 days'
    and public.can_view_employee(e.id)
    and public.is_manager_of(me.organization_id)
  order by 3 desc
  limit 500;
$$;

-- Plus 'unattended_use'; windowed on received_at so back-dated or late-uploaded events are not missed.
create or replace function public.email_alert_batch(p_since timestamptz)
returns table (recipient_email text, recipient_name text, organization_name text, alerts integer, high_alerts integer)
language sql
stable
security definer
set search_path = public
as $$
  with recipients as (
    select m.id, m.email, m.name, o.id as org_id, o.name as org_name,
           array(select public.employees_visible_to(m.id)) as visible
    from public.employees m
    join public.organizations o on o.id = m.organization_id
    join public.subscriptions s on s.organization_id = o.id
    left join public.notification_preferences np on np.employee_id = m.id
    where m.is_active and m.role in ('owner', 'manager') and m.auth_user_id is not null
      and coalesce(np.alert_emails, true)
      and public.subscription_level(s) = 'full'
  ),
  counted as (
    select r.email, r.name, r.org_name,
           count(ev.*)::integer as alerts,
           count(ev.*) filter (where ev.event_type = 'agent_gap'
                                 and coalesce((ev.details ->> 'minutes')::numeric, 0) >= 10)::integer as high_alerts
    from recipients r
    join public.agent_events ev on ev.organization_id = r.org_id and ev.employee_id = any(r.visible)
    where ev.received_at >= p_since
      and ev.event_type in ('agent_gap', 'vm_detected', 'remote_session', 'input_anomaly', 'unattended_use')
    group by r.email, r.name, r.org_name
  )
  select * from counted where alerts > 0;
$$;

revoke execute on function public.report_key_hash(text) from public, anon, authenticated;
revoke execute on function public.set_device_report_key(uuid, text) from public, anon;
grant execute on function public.set_device_report_key(uuid, text) to authenticated;
revoke execute on function public.report_unattended_use(uuid, text, integer) from public;
grant execute on function public.report_unattended_use(uuid, text, integer) to anon, authenticated;

notify pgrst, 'reload schema';
