-- Per-company install key, plus two tamper signals: the agent starting late and being uninstalled.
--
-- Install key: every organisation gets a human-typable key (MYC-XXXX-XXXX-XXXX-XXXX). Owners and managers
-- see it in the app; the owner can rotate it. Whoever installs the agent must enter it, and the installer
-- checks it with verify_install_key (anon). An employee who removes the agent therefore cannot reinstall it
-- without the key, which only management holds.
--
-- tracking_late: the agent noticed the PC had already been awake and in use for a while during working hours
-- before it started (e.g. the agent was uninstalled, the PC restarted and used, then it was reinstalled).
-- agent_uninstalled: the uninstaller told the server, using the PC's existing report key, that it is removing
-- the agent. Both appear as integrity alerts and in the alert emails.

-- ---------------------------------------------------------------------------
-- Install keys
-- ---------------------------------------------------------------------------
create or replace function public.gen_install_key()
returns text
language plpgsql
volatile
set search_path = public, extensions
as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';  -- 30 chars, no 0/O/1/I/L ambiguity
  raw bytea := gen_random_bytes(16);
  s text := '';
  i integer;
begin
  for i in 0..15 loop
    s := s || substr(alphabet, 1 + (get_byte(raw, i) % 30), 1);
  end loop;
  return 'MYC-' || substr(s, 1, 4) || '-' || substr(s, 5, 4) || '-' || substr(s, 9, 4) || '-' || substr(s, 13, 4);
end;
$$;

create table public.org_install_keys (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  install_key text not null unique default public.gen_install_key(),
  updated_at timestamptz not null default now()
);

alter table public.org_install_keys enable row level security;
revoke all on public.org_install_keys from anon, authenticated;

insert into public.org_install_keys (organization_id)
select id from public.organizations
on conflict (organization_id) do nothing;

create or replace function public.org_install_key_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.org_install_keys (organization_id) values (new.id)
  on conflict (organization_id) do nothing;
  return new;
end;
$$;

create trigger organizations_install_key after insert on public.organizations
  for each row execute function public.org_install_key_after_insert();

-- Owners and managers may read their own organisation's key.
create or replace function public.get_install_key()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select k.install_key
  from public.org_install_keys k
  join public.employees e on e.organization_id = k.organization_id
  where e.auth_user_id = auth.uid() and e.is_active and e.role in ('owner', 'manager');
$$;

-- Only the owner can rotate it (old installs keep working; only new installs need the new key).
create or replace function public.rotate_install_key()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  org uuid;
  new_key text;
begin
  select organization_id into org from public.employees
  where auth_user_id = auth.uid() and is_active and role = 'owner';
  if org is null then
    raise exception 'Only the owner can change the install key';
  end if;
  new_key := public.gen_install_key();
  update public.org_install_keys set install_key = new_key, updated_at = now() where organization_id = org;
  return new_key;
end;
$$;

-- Used by the installer (no sign-in). Returns the organisation for a valid key, or no rows.
create or replace function public.verify_install_key(p_key text)
returns table (organization_id uuid, organization_name text)
language sql
stable
security definer
set search_path = public
as $$
  select o.id, o.name
  from public.org_install_keys k
  join public.organizations o on o.id = k.organization_id
  where p_key is not null and length(btrim(p_key)) >= 8
    and k.install_key = upper(btrim(p_key));
$$;

-- ---------------------------------------------------------------------------
-- New tamper event types
-- ---------------------------------------------------------------------------
alter table public.agent_events drop constraint agent_events_event_type_check;
alter table public.agent_events add constraint agent_events_event_type_check check (event_type in (
  'login', 'logout', 'pause', 'resume', 'project_switch', 'sleep', 'wake',
  'lock', 'unlock', 'agent_start', 'agent_stop', 'clock_skew', 'data_rejected',
  'agent_gap', 'vm_detected', 'remote_session', 'input_anomaly', 'after_hours_use',
  'work_hours_start', 'work_hours_end', 'service_inactive', 'unattended_use',
  'tracking_late', 'agent_uninstalled'));

-- Called by the uninstaller with the PC's existing report key (no sign-in). One event per 10 minutes.
create or replace function public.report_uninstalled(p_device uuid, p_key text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  k public.device_report_keys;
  d public.devices;
begin
  if p_key is null then
    return false;
  end if;
  select * into k from public.device_report_keys where device_id = p_device;
  if k.device_id is null or k.key_hash <> public.report_key_hash(p_key) then
    return false;
  end if;
  select * into d from public.devices where id = p_device;
  if exists (select 1 from public.agent_events
             where device_id = p_device and event_type = 'agent_uninstalled'
               and received_at > now() - interval '10 minutes') then
    return true;
  end if;
  insert into public.agent_events (id, organization_id, employee_id, device_id, occurred_at, event_type, details)
  values (gen_random_uuid(), d.organization_id, d.employee_id, d.id, now(), 'agent_uninstalled',
          jsonb_build_object('hostname', d.hostname));
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Alerts: include tracking_late (medium) and agent_uninstalled (high)
-- ---------------------------------------------------------------------------
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
           when ev.event_type = 'agent_uninstalled' then 'high'
           when ev.event_type in ('agent_gap', 'vm_detected', 'remote_session', 'input_anomaly',
                                  'unattended_use', 'tracking_late')
             then 'medium'
           else 'low'
         end,
         ev.details
  from me
  join public.agent_events ev on ev.organization_id = me.organization_id
  join public.employees e on e.id = ev.employee_id
  where ev.occurred_at >= p_since
    and ev.event_type in ('agent_gap', 'vm_detected', 'remote_session', 'input_anomaly', 'clock_skew',
                          'after_hours_use', 'unattended_use', 'tracking_late', 'agent_uninstalled')
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
           count(ev.*) filter (where (ev.event_type = 'agent_gap'
                                       and coalesce((ev.details ->> 'minutes')::numeric, 0) >= 10)
                                     or ev.event_type = 'agent_uninstalled')::integer as high_alerts
    from recipients r
    join public.agent_events ev on ev.organization_id = r.org_id and ev.employee_id = any(r.visible)
    where ev.received_at >= p_since
      and ev.event_type in ('agent_gap', 'vm_detected', 'remote_session', 'input_anomaly',
                            'unattended_use', 'tracking_late', 'agent_uninstalled')
    group by r.email, r.name, r.org_name
  )
  select * from counted where alerts > 0;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke execute on function public.gen_install_key() from public, anon, authenticated;
revoke execute on function public.get_install_key() from public, anon;
grant execute on function public.get_install_key() to authenticated;
revoke execute on function public.rotate_install_key() from public, anon;
grant execute on function public.rotate_install_key() to authenticated;
revoke execute on function public.verify_install_key(text) from public;
grant execute on function public.verify_install_key(text) to anon, authenticated;
revoke execute on function public.report_uninstalled(uuid, text) from public;
grant execute on function public.report_uninstalled(uuid, text) to anon, authenticated;

notify pgrst, 'reload schema';
