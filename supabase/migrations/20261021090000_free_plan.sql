-- =============================================================================
-- Mycroscope: free plan after the trial
--   * Sign-up is still a 14-day trial with every feature.
--   * When the trial ends, the company stays on, on the free plan: 3 people,
--     30 days of detailed activity, and no paid reports. They upgrade with the
--     existing Paystack checkout, which moves a free company to Standard.
-- Run after 20261020090000_work_advisor.sql.
-- =============================================================================

alter table public.subscriptions drop constraint subscriptions_plan_check;
alter table public.subscriptions add constraint subscriptions_plan_check
  check (plan in ('trial', 'free', 'standard', 'business', 'enterprise'));

create or replace function public.plan_features(p_plan text)
returns text[]
language sql
immutable
as $$
  select case p_plan
    when 'free' then array[]::text[]
    when 'standard' then array['team_categories', 'team_schedules', 'trends', 'alert_rules', 'channels', 'work_location']
    when 'business' then array['team_categories', 'team_schedules', 'trends', 'alert_rules', 'channels', 'work_location', 'ai_tools', 'work_advisor',
                               'goals', 'workload', 'software_usage', 'file_activity', 'api']
    when 'enterprise' then array['team_categories', 'team_schedules', 'trends', 'alert_rules', 'channels', 'work_location', 'ai_tools', 'work_advisor',
                                 'goals', 'workload', 'software_usage', 'file_activity', 'api']
    when 'trial' then array['team_categories', 'team_schedules', 'trends', 'alert_rules', 'channels', 'work_location', 'ai_tools', 'work_advisor',
                            'goals', 'workload', 'software_usage', 'file_activity', 'api']
    else array[]::text[]
  end;
$$;

-- An expired trial is the free plan until the nightly job records that.
create function public.effective_plan(s public.subscriptions)
returns text
language sql
stable
as $$
  select case
    when s.organization_id is null then 'free'
    when s.plan = 'free' then 'free'
    when s.status = 'trialing' and coalesce(s.trial_ends_at, now()) <= now() then 'free'
    else s.plan
  end;
$$;

create function public.seat_limit(s public.subscriptions)
returns integer
language sql
stable
as $$
  select case when public.effective_plan(s) = 'free' then least(s.seats, 3) else s.seats end;
$$;

create or replace function public.subscription_level(s public.subscriptions)
returns text
language sql
stable
as $$
  select case
    when s.organization_id is null then 'read_only'
    when s.status = 'suspended' then 'read_only'
    when s.status = 'trialing' then 'full'
    when s.status = 'active' then
      case when s.current_period_end is null or s.current_period_end + make_interval(days => s.grace_days) > now()
           then 'full' else 'read_only' end
    when s.status = 'past_due' then
      case when coalesce(s.current_period_end, now()) + make_interval(days => s.grace_days) > now()
           then 'full' else 'read_only' end
    else 'read_only'
  end;
$$;

create or replace function public.org_has_feature(p_org uuid, p_feature text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select p_feature = any (public.plan_features(public.effective_plan(s)))
                   from public.subscriptions s where s.organization_id = p_org), false);
$$;

create or replace function public.get_my_features()
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select public.plan_features(public.effective_plan(s)) from public.subscriptions s
                   where s.organization_id = public.my_organization_id()), array[]::text[]);
$$;

create or replace function public.apply_payment(
  p_org uuid, p_reference text, p_amount_cents integer, p_currency text, p_seats integer, p_months integer,
  p_customer_code text, p_raw jsonb)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.payments (organization_id, reference, amount_cents, currency, seats, months, raw)
  values (p_org, p_reference, p_amount_cents, p_currency, p_seats, p_months, coalesce(p_raw, '{}'::jsonb))
  on conflict (reference) do nothing;
  if not found then
    return false;
  end if;
  update public.subscriptions
  set status = case when status = 'suspended' then status else 'active' end,
      plan = case when plan in ('trial', 'free') then 'standard' else plan end,
      seats = p_seats,
      current_period_end = greatest(coalesce(current_period_end, now()), now()) + make_interval(months => p_months),
      paystack_customer_code = coalesce(p_customer_code, paystack_customer_code),
      cancelled_at = null
  where organization_id = p_org;
  insert into public.audit_log (organization_id, action, target_type, target_id, details)
  values (p_org, 'payment_received', 'organization', p_org::text,
          jsonb_build_object('reference', p_reference, 'amount_cents', p_amount_cents, 'currency', p_currency,
                             'seats', p_seats, 'months', p_months));
  return true;
end;
$$;

-- Seat checks. The bodies match the existing functions, with the free cap applied.
create or replace function public.create_employee(
  p_name text, p_email text, p_role text default 'employee', p_employee_code text default null,
  p_team_id uuid default null)
returns table (employee_id uuid, employee_code text, activation_code text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public, extensions
as $$
#variable_conflict use_column
declare
  org_id uuid := public.my_organization_id();
  my_role text := public.my_role();
  me uuid := public.my_employee_id();
  team uuid := p_team_id;
  new_id uuid;
  code text;
  org_name text;
  sub public.subscriptions;
begin
  if org_id is null or not public.is_manager_of(org_id) then
    raise exception 'Not allowed';
  end if;
  if p_role not in ('employee', 'manager') then
    raise exception 'Role must be employee or manager';
  end if;
  if p_role = 'manager' and my_role <> 'owner' then
    raise exception 'Only the owner can add managers';
  end if;
  if exists (select 1 from public.employees where lower(email) = lower(btrim(p_email))) then
    raise exception 'An account with this email already exists';
  end if;

  select * into sub from public.subscriptions where organization_id = org_id;
  if public.subscription_level(sub) <> 'full' then
    raise exception 'Your subscription is not active. Renew it to add employees.';
  end if;
  if (select count(*) from public.employees e where e.organization_id = org_id and e.is_active) >= public.seat_limit(sub) then
    if public.effective_plan(sub) = 'free' then
      raise exception 'The free plan includes 3 people. Deactivate someone or upgrade.';
    end if;
    raise exception 'All % seats on your plan are in use. Add seats or deactivate someone first.', public.seat_limit(sub);
  end if;

  if team is not null and not exists (select 1 from public.teams t where t.id = team and t.organization_id = org_id) then
    raise exception 'Unknown team';
  end if;
  if my_role = 'manager' and exists (select 1 from public.team_managers tm where tm.employee_id = me) then
    if team is null then
      select tm.team_id into team from public.team_managers tm where tm.employee_id = me limit 1;
    elsif not exists (select 1 from public.team_managers tm where tm.employee_id = me and tm.team_id = team) then
      raise exception 'You can only add people to your own teams';
    end if;
  end if;

  select name into org_name from public.organizations where id = org_id;
  code := coalesce(nullif(btrim(p_employee_code), ''), public.generate_employee_code(org_name));

  insert into public.employees (organization_id, employee_code, name, email, role, team_id)
  values (org_id, code, btrim(p_name), lower(btrim(p_email)), p_role, team)
  returning id into new_id;

  perform public.write_audit(org_id, 'employee_created', 'employee', new_id::text,
                             jsonb_build_object('role', p_role, 'email', lower(btrim(p_email)), 'team', team));

  return query
    select new_id, a.employee_code, a.activation_code, a.expires_at
    from public.issue_activation_code(new_id) a;
end;
$$;

create or replace function public.update_employee(
  p_employee uuid, p_name text default null, p_role text default null, p_is_active boolean default null)
returns public.employees
language plpgsql
security definer
set search_path = public
as $$
declare
  emp public.employees;
  my_role text := public.my_role();
  result public.employees;
  sub public.subscriptions;
begin
  select * into emp from public.employees where id = p_employee;
  if emp.id is null or not public.can_manage_employee(emp.id) then
    raise exception 'Not allowed';
  end if;
  if emp.role = 'owner' and my_role <> 'owner' then
    raise exception 'Only the owner can change the owner account';
  end if;
  if p_role is not null and p_role is distinct from emp.role then
    if my_role <> 'owner' then
      raise exception 'Only the owner can change roles';
    end if;
    if emp.id = public.my_employee_id() then
      raise exception 'You cannot change your own role';
    end if;
    if p_role not in ('employee', 'manager', 'owner') then
      raise exception 'Invalid role';
    end if;
  end if;
  if p_is_active is false and emp.id = public.my_employee_id() then
    raise exception 'You cannot deactivate yourself';
  end if;
  if p_is_active is true and not emp.is_active then
    select * into sub from public.subscriptions where organization_id = emp.organization_id;
    if (select count(*) from public.employees e where e.organization_id = emp.organization_id and e.is_active) >= public.seat_limit(sub) then
      if public.effective_plan(sub) = 'free' then
        raise exception 'The free plan includes 3 people. Deactivate someone or upgrade.';
      end if;
      raise exception 'All % seats on your plan are in use. Add seats first.', public.seat_limit(sub);
    end if;
  end if;

  update public.employees
  set name = coalesce(nullif(btrim(p_name), ''), name),
      role = coalesce(p_role, role),
      is_active = coalesce(p_is_active, is_active)
  where id = p_employee
  returning * into result;

  perform public.write_audit(emp.organization_id, 'employee_updated', 'employee', emp.id::text,
    jsonb_build_object('before', jsonb_build_object('name', emp.name, 'role', emp.role, 'is_active', emp.is_active),
                       'after', jsonb_build_object('name', result.name, 'role', result.role, 'is_active', result.is_active)));
  return result;
end;
$$;

create function public.enforce_free_retention()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  sub public.subscriptions;
begin
  select * into sub from public.subscriptions where organization_id = new.organization_id;
  if public.effective_plan(sub) = 'free' and new.retention_days > 30 then
    raise exception 'The free plan keeps detailed activity for 30 days';
  end if;
  return new;
end;
$$;

create trigger organization_settings_free_retention
  before update on public.organization_settings
  for each row execute function public.enforce_free_retention();

create function public.convert_expired_trials()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  with moved as (
    update public.subscriptions
    set plan = 'free', status = 'active', seats = least(seats, 3)
    where status = 'trialing' and coalesce(trial_ends_at, now()) <= now()
    returning organization_id
  )
  update public.organization_settings s
  set retention_days = least(s.retention_days, 30)
  from moved m
  where s.organization_id = m.organization_id;
  get diagnostics n = row_count;
  return n;
end;
$$;

create or replace function public.run_nightly_maintenance()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  o record;
  local_today date;
  started timestamptz := clock_timestamp();
  stale integer;
  files_purged integer;
begin
  update public.agent_sessions ses
  set ended_at = greatest(ses.started_at, coalesce(
        (select max(a.ended_at) from public.activity_segments a where a.session_id = ses.id), ses.started_at)),
      end_reason = 'stale'
  where ses.ended_at is null
    and not exists (select 1 from public.agent_status st
                    where st.employee_id = ses.employee_id and st.device_id = ses.device_id
                      and st.last_seen_at > now() - interval '30 minutes');
  get diagnostics stale = row_count;

  for o in select id, timezone from public.organizations loop
    local_today := (now() at time zone o.timezone)::date;
    perform public.refresh_daily_summaries(o.id, local_today - 1);
    perform public.refresh_daily_summaries(o.id, local_today - 2);
    perform public.refresh_daily_usage(o.id, local_today - 1);
    perform public.refresh_daily_usage(o.id, local_today - 2);
  end loop;

  perform public.convert_expired_trials();
  perform public.purge_expired_data();
  delete from public.daily_usage u
  using public.organization_settings s
  where s.organization_id = u.organization_id
    and u.day < (now() - make_interval(days => s.summary_retention_days))::date;
  delete from public.file_events f
  using public.organization_settings s
  where s.organization_id = f.organization_id
    and f.occurred_at < now() - make_interval(days => s.file_retention_days);
  get diagnostics files_purged = row_count;

  delete from public.maintenance_runs where ran_at < now() - interval '90 days';
  insert into public.maintenance_runs (duration_ms, details)
  values ((extract(epoch from clock_timestamp() - started) * 1000)::integer,
          jsonb_build_object('stale_sessions_closed', stale, 'file_events_purged', files_purged));
end;
$$;

create or replace function public.op_system_health()
returns table (organizations integer, paying_organizations integer, trialing_organizations integer,
               active_employees integer, agents_online integer, segments_last_24h bigint,
               last_maintenance_at timestamptz, open_data_requests integer)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.require_platform_admin();
  return query
  select (select count(*)::integer from public.organizations),
         (select count(*)::integer from public.subscriptions s where s.status = 'active' and s.plan <> 'free'),
         (select count(*)::integer from public.subscriptions s where s.status = 'trialing'),
         (select count(*)::integer from public.employees e where e.is_active),
         (select count(*)::integer from public.agent_status st
          where st.state <> 'logged_out' and st.last_seen_at > now() - interval '2 minutes'),
         (select count(*) from public.activity_segments a where a.received_at > now() - interval '24 hours'),
         (select max(m.ran_at) from public.maintenance_runs m),
         (select count(*)::integer from public.data_requests d where d.status in ('open', 'in_progress'));
end;
$$;

revoke execute on function
  public.effective_plan(public.subscriptions),
  public.seat_limit(public.subscriptions),
  public.enforce_free_retention(),
  public.convert_expired_trials()
from public, anon, authenticated;

grant execute on function
  public.effective_plan(public.subscriptions),
  public.seat_limit(public.subscriptions)
to authenticated;

notify pgrst, 'reload schema';
