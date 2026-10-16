-- Mycroscope: plan catalogue. This seed is the only place a price, seat cap,
-- retention window, or feature grant is defined. The app reads it from here.
-- Features are introduced on one tier and included in every higher tier.
-- Run after 20261028090000_remove_trial_and_case_studies.sql.

-- -----------------------------------------------------------------------------
-- Catalogue
-- -----------------------------------------------------------------------------
create table public.billing_config (
  id boolean primary key default true check (id),
  vat_enabled boolean not null default true,
  vat_rate numeric(6, 4) not null default 0.1500 check (vat_rate >= 0 and vat_rate < 1)
);

insert into public.billing_config (id, vat_enabled, vat_rate) values (true, true, 0.1500);

create table public.plans (
  key text primary key,
  name text not null,
  rank integer not null unique check (rank > 0),
  net_price_cents integer not null check (net_price_cents >= 0),
  seat_cap integer check (seat_cap is null or seat_cap > 0),
  retention interval not null,
  check (retention > interval '0')
);

-- One row per capability: the tier that introduces it. Higher ranks include it.
create table public.plan_feature_grants (
  feature_key text primary key,
  plan_key text not null references public.plans (key)
);

-- Old check names that still appear in existing functions. They follow the grant row.
create table public.feature_aliases (
  legacy_key text primary key,
  feature_key text not null references public.plan_feature_grants (feature_key)
);

create table public.plan_addons (
  key text primary key,
  name text not null,
  description text not null,
  net_price_cents integer check (net_price_cents is null or net_price_cents >= 0),
  min_rank integer not null check (min_rank > 1),
  enabled boolean not null default false
);

create table public.organization_addons (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  addon_key text not null references public.plan_addons (key),
  primary key (organization_id, addon_key)
);

insert into public.plans (key, name, rank, net_price_cents, seat_cap, retention) values
  ('free', 'Free', 1, 0, 3, interval '30 days'),
  ('work_activity', 'Work Activity Tracking', 2, 15000, null, interval '6 months'),
  ('workforce', 'Workforce Management', 3, 23000, null, interval '6 months'),
  ('productivity', 'Productivity Optimization', 4, 32000, null, interval '12 months');

insert into public.plan_feature_grants (feature_key, plan_key) values
  ('real_time_visibility', 'work_activity'),
  ('time_tracking', 'work_activity'),
  ('schedule_adherence', 'work_activity'),
  ('website_tracking', 'work_activity'),
  ('teams', 'workforce'),
  ('work_location_insights', 'workforce'),
  ('productivity_goals', 'workforce'),
  ('workload_planning', 'workforce'),
  ('capacity_planning', 'productivity'),
  ('financial_estimates', 'productivity'),
  ('coaching', 'productivity'),
  ('software_usage', 'work_activity'),
  ('channels', 'work_activity'),
  ('file_activity', 'workforce'),
  ('ai_tools', 'workforce'),
  ('trends', 'productivity'),
  ('api', 'productivity');

insert into public.feature_aliases (legacy_key, feature_key) values
  ('team_schedules', 'schedule_adherence'),
  ('alert_rules', 'website_tracking'),
  ('team_categories', 'teams'),
  ('goals', 'productivity_goals'),
  ('workload', 'workload_planning'),
  ('work_location', 'work_location_insights'),
  ('work_advisor', 'coaching');

insert into public.plan_addons (key, name, description, net_price_cents, min_rank, enabled) values
  ('screen_details', 'Screen Details', 'Optional paid extra for a paid plan. Not available yet.', null, 2, false);

-- Old paid plan names, if any remain, move to the matching new tier.
update public.subscriptions
set plan = case plan
  when 'standard' then 'work_activity'
  when 'business' then 'workforce'
  when 'enterprise' then 'productivity'
  else 'free'
end
where plan not in (select key from public.plans);

alter table public.subscriptions drop constraint subscriptions_plan_check;
alter table public.subscriptions
  add constraint subscriptions_plan_fkey foreign key (plan) references public.plans (key);

-- -----------------------------------------------------------------------------
-- Readers. Moving a feature is an update of plan_feature_grants.plan_key.
-- -----------------------------------------------------------------------------
create function public.gross_cents(p_net integer)
returns integer
language sql
stable
as $$
  select case
    when p_net is null then null
    when c.vat_enabled then round(p_net * (1 + c.vat_rate))::integer
    else p_net
  end
  from public.billing_config c;
$$;

create function public.retention_label(p_retention interval)
returns text
language sql
immutable
as $$
  select case
    when extract(year from p_retention)::integer > 0
      then (extract(year from p_retention)::integer * 12 + extract(month from p_retention)::integer)::text || ' months'
    when extract(month from p_retention)::integer > 0
      then extract(month from p_retention)::integer::text || ' months'
    else extract(day from p_retention)::integer::text || ' days'
  end;
$$;

create function public.features_for_plan(p_plan text)
returns text[]
language sql
stable
as $$
  select coalesce((
    select array_agg(feature order by feature)
    from (
      select g.feature_key as feature
      from public.plans mine
      join public.plans introduced on introduced.rank <= mine.rank
      join public.plan_feature_grants g on g.plan_key = introduced.key
      where mine.key = p_plan
      union
      select a.legacy_key
      from public.plans mine
      join public.plans introduced on introduced.rank <= mine.rank
      join public.plan_feature_grants g on g.plan_key = introduced.key
      join public.feature_aliases a on a.feature_key = g.feature_key
      where mine.key = p_plan
    ) granted
  ), array[]::text[]);
$$;

create or replace function public.plan_features(p_plan text)
returns text[]
language sql
stable
as $$
  select public.features_for_plan(p_plan);
$$;

create or replace function public.seat_limit(s public.subscriptions)
returns integer
language sql
stable
as $$
  select p.seat_cap
  from public.plans p
  where p.key = public.effective_plan(s);
$$;

create or replace function public.apply_payment(
  p_org uuid, p_reference text, p_amount_cents integer, p_currency text, p_seats integer, p_months integer,
  p_customer_code text, p_raw jsonb)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  entry_plan text;
begin
  insert into public.payments (organization_id, reference, amount_cents, currency, seats, months, raw)
  values (p_org, p_reference, p_amount_cents, p_currency, p_seats, p_months, coalesce(p_raw, '{}'::jsonb))
  on conflict (reference) do nothing;
  if not found then
    return false;
  end if;
  select p.key into entry_plan
  from public.plans p
  where p.net_price_cents > 0
  order by p.rank
  limit 1;
  update public.subscriptions
  set status = case when status = 'suspended' then status else 'active' end,
      plan = case when plan = 'free' then entry_plan else plan end,
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

create or replace function public.handle_auth_user_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  org_id uuid;
  emp_id uuid;
  free_seats integer;
  free_retention integer;
begin
  if exists (select 1 from public.platform_admin_invites i where i.email = lower(new.email)) then
    insert into public.platform_admins (auth_user_id, email) values (new.id, lower(new.email));
    delete from public.platform_admin_invites where email = lower(new.email);
    insert into public.operator_audit_log (operator_auth_id, operator_email, action)
    values (new.id, lower(new.email), 'operator_created');
    return new;
  end if;

  if meta ->> 'signup_type' = 'owner' then
    select p.seat_cap,
           (current_date - (current_date - p.retention)::date)
      into free_seats, free_retention
    from public.plans p
    where p.key = 'free';

    insert into public.organizations (name)
    values (btrim(meta ->> 'organization_name'))
    returning id into org_id;

    insert into public.organization_settings (organization_id, retention_days) values (org_id, free_retention);
    insert into public.subscriptions (organization_id, plan, status, seats, billing_email)
    values (org_id, 'free', 'active', free_seats, lower(new.email));

    insert into public.employees (organization_id, auth_user_id, employee_code, name, email, role)
    values (org_id, new.id, public.generate_employee_code(meta ->> 'organization_name'),
            btrim(meta ->> 'full_name'), new.email, 'owner')
    returning id into emp_id;

    insert into public.audit_log (organization_id, actor_employee_id, actor_auth_id, action, target_type, target_id)
    values (org_id, emp_id, new.id, 'organization_created', 'organization', org_id::text);

    perform public.publish_policy_internal(org_id, emp_id);

  elsif meta ->> 'signup_type' = 'employee_activation' then
    update public.employees
    set auth_user_id = new.id
    where lower(employee_code) = lower(meta ->> 'employee_code') and auth_user_id is null
    returning id, organization_id into emp_id, org_id;

    delete from public.employee_activations where employee_id = emp_id;

    insert into public.audit_log (organization_id, actor_employee_id, actor_auth_id, action, target_type, target_id)
    values (org_id, emp_id, new.id, 'employee_activated', 'employee', emp_id::text);
  end if;
  return new;
end;
$$;

-- A null seat cap means unlimited. Callers must test for null before comparing.
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
  cap integer;
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
  cap := public.seat_limit(sub);
  if cap is not null and (select count(*) from public.employees e where e.organization_id = org_id and e.is_active) >= cap then
    raise exception 'This plan includes % people. Deactivate someone or upgrade.', cap;
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
  cap integer;
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
    cap := public.seat_limit(sub);
    if cap is not null
       and (select count(*) from public.employees e where e.organization_id = emp.organization_id and e.is_active) >= cap then
      raise exception 'This plan includes % people. Deactivate someone or upgrade.', cap;
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

-- Owners cannot set a history longer than the plan. Calendar months are compared as dates.
create or replace function public.enforce_free_retention()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  sub public.subscriptions;
  allowed interval;
begin
  select * into sub from public.subscriptions where organization_id = new.organization_id;
  select p.retention into allowed from public.plans p where p.key = public.effective_plan(sub);
  if allowed is not null
     and now() - make_interval(days => new.retention_days) < now() - allowed then
    raise exception 'Your plan keeps detailed activity for %', public.retention_label(allowed);
  end if;
  return new;
end;
$$;

create or replace function public.set_workforce_cost(p_team uuid, p_annual_salary numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid := public.my_organization_id();
begin
  if org_id is null or not public.is_org_wide_manager(org_id) then
    raise exception 'Not allowed';
  end if;
  if not public.org_has_feature(org_id, 'financial_estimates') then
    raise exception 'Financial estimates are not included in your plan';
  end if;
  if p_team is not null and not exists (select 1 from public.teams where id = p_team and organization_id = org_id) then
    raise exception 'Unknown team';
  end if;
  if p_annual_salary is null then
    delete from public.workforce_costs where organization_id = org_id and team_id is not distinct from p_team;
  else
    if p_annual_salary <= 0 or p_annual_salary > 100000000 then
      raise exception 'Enter an average annual salary above zero';
    end if;
    insert into public.workforce_costs (organization_id, team_id, annual_salary, updated_by)
    values (org_id, p_team, round(p_annual_salary, 2), public.my_employee_id())
    on conflict (organization_id, (coalesce(team_id, '00000000-0000-0000-0000-000000000000'::uuid)))
    do update set annual_salary = excluded.annual_salary, updated_by = excluded.updated_by, updated_at = now();
  end if;
  perform public.write_audit(org_id, 'workforce_cost_saved', case when p_team is null then 'organization' else 'team' end,
    coalesce(p_team, org_id)::text, jsonb_build_object('set', p_annual_salary is not null));
end;
$$;

create or replace function public.get_workforce_costs()
returns table (team_id uuid, annual_salary numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  org_id uuid := public.my_organization_id();
begin
  if org_id is null or not public.is_org_wide_manager(org_id) then
    raise exception 'Not allowed';
  end if;
  if not public.org_has_feature(org_id, 'financial_estimates') then
    raise exception 'Financial estimates are not included in your plan';
  end if;
  return query
    select c.team_id, c.annual_salary from public.workforce_costs c where c.organization_id = org_id;
end;
$$;

create or replace function public.get_capacity(p_from date, p_to date)
returns table (team_id uuid, team_name text, people integer, person_days integer, productive_seconds bigint,
               goal_hours numeric, avg_productive_hours numeric, gap_hours numeric, fte_gap numeric,
               annual_salary numeric, annual_cost numeric, monthly_cost numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  org_id uuid := public.require_analytics('capacity_planning', p_from, p_to);
  see_costs boolean := public.is_org_wide_manager(org_id) and public.org_has_feature(org_id, 'financial_estimates');
begin
  return query
  with w as (select * from public.get_workload(p_from, p_to, null) x where x.days_worked > 0),
  grouped as (
    select w.team_id as tid, max(w.team_name) as tname, count(*)::integer as n,
           sum(w.days_worked)::integer as pdays, sum(w.productive_seconds)::bigint as prod
    from w group by w.team_id
  ),
  scored as (
    select g.*, goal.productive_hours as goal_h,
           round(g.prod::numeric / g.pdays / 3600, 2) as avg_h,
           (select c.annual_salary from public.workforce_costs c
            where c.organization_id = org_id and (c.team_id = g.tid or c.team_id is null)
            order by (c.team_id is not null) desc limit 1) as salary
    from grouped g
    left join lateral (
      select pg.productive_hours from public.productivity_goals pg
      where pg.organization_id = org_id and (pg.team_id = g.tid or pg.team_id is null)
      order by (pg.team_id is not null) desc limit 1
    ) goal on true
  )
  select s.tid, s.tname, s.n, s.pdays, s.prod, s.goal_h, s.avg_h,
         round(s.goal_h - s.avg_h, 2),
         round((s.goal_h - s.avg_h) * s.n / s.goal_h, 2),
         case when see_costs then s.salary end,
         case when see_costs then round((s.goal_h - s.avg_h) * s.n / s.goal_h * s.salary, 2) end,
         case when see_costs then round((s.goal_h - s.avg_h) * s.n / s.goal_h * s.salary / 12, 2) end
  from scored s
  order by s.tname nulls last;
end;
$$;

drop function public.get_my_service_status();
create function public.get_my_service_status()
returns table (level text, status text, plan text, current_period_end timestamptz,
               grace_until timestamptz, seats integer, seats_used integer, require_mfa boolean,
               seat_cap integer)
language sql
stable
security definer
set search_path = public
as $$
  select public.subscription_level(s), s.status, s.plan, s.current_period_end,
         case when s.status in ('active', 'past_due') and s.current_period_end is not null
              then s.current_period_end + make_interval(days => s.grace_days) end,
         s.seats,
         (select count(*)::integer from public.employees e where e.organization_id = s.organization_id and e.is_active),
         coalesce((select os.require_mfa from public.organization_settings os where os.organization_id = s.organization_id), false),
         (select p.seat_cap from public.plans p where p.key = public.effective_plan(s))
  from public.subscriptions s
  where s.organization_id = public.my_organization_id();
$$;

create function public.get_plan_catalogue()
returns table (
  key text,
  name text,
  rank integer,
  net_price_cents integer,
  vat_cents integer,
  gross_price_cents integer,
  seat_cap integer,
  retention_label text,
  vat_enabled boolean,
  vat_rate numeric,
  features text[]
)
language sql
stable
security definer
set search_path = public
as $$
  select p.key, p.name, p.rank, p.net_price_cents,
         public.gross_cents(p.net_price_cents) - p.net_price_cents,
         public.gross_cents(p.net_price_cents),
         p.seat_cap,
         public.retention_label(p.retention),
         c.vat_enabled,
         c.vat_rate,
         coalesce((
           select array_agg(g.feature_key order by g.feature_key)
           from public.plans introduced
           join public.plan_feature_grants g on g.plan_key = introduced.key
           where introduced.rank <= p.rank
         ), array[]::text[])
  from public.plans p
  cross join public.billing_config c
  order by p.rank;
$$;

create function public.org_has_addon(p_org uuid, p_addon text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organization_addons oa
    join public.plan_addons a on a.key = oa.addon_key
    join public.subscriptions s on s.organization_id = oa.organization_id
    join public.plans p on p.key = public.effective_plan(s)
    where oa.organization_id = p_org
      and oa.addon_key = p_addon
      and a.enabled
      and p.rank >= a.min_rank
  );
$$;

alter table public.billing_config enable row level security;
alter table public.plans enable row level security;
alter table public.plan_feature_grants enable row level security;
alter table public.feature_aliases enable row level security;
alter table public.plan_addons enable row level security;
alter table public.organization_addons enable row level security;

revoke all on public.billing_config, public.plans, public.plan_feature_grants, public.feature_aliases,
  public.plan_addons, public.organization_addons from public, anon, authenticated;

revoke execute on function
  public.gross_cents(integer),
  public.retention_label(interval),
  public.features_for_plan(text),
  public.get_plan_catalogue(),
  public.org_has_addon(uuid, text),
  public.get_my_service_status()
from public, anon;

grant execute on function
  public.get_plan_catalogue(),
  public.get_my_service_status()
to authenticated;

notify pgrst, 'reload schema';
