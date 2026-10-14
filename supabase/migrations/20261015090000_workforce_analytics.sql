-- =============================================================================
-- Mycroscope: workforce analytics
--   * daily_usage keeps app + website pairs, so productivity categories can be applied afterwards
--   * get_trend: active / productive / unproductive time per day, week or month
--   * get_software_usage + software_licences: company-wide app and website use, licence seats used
--   * get_workload: each person's productive time against their goal (under / healthy / over)
--   * get_capacity + workforce_costs: the gap to the goal per team in hours, FTE and salary cost
-- Days before yesterday come from daily_usage (filled nightly); yesterday and today are read live.
-- Run after 20261014090000_team_settings_and_goals.sql.
-- =============================================================================

create or replace function public.plan_features(p_plan text)
returns text[]
language sql
immutable
as $$
  select case p_plan
    when 'standard' then array['team_categories', 'team_schedules', 'trends']
    when 'business' then array['team_categories', 'team_schedules', 'trends', 'goals', 'workload', 'software_usage']
    when 'enterprise' then array['team_categories', 'team_schedules', 'trends', 'goals', 'workload', 'software_usage']
    when 'trial' then array['team_categories', 'team_schedules', 'trends', 'goals', 'workload', 'software_usage']
    else array[]::text[]
  end;
$$;

-- -----------------------------------------------------------------------------
-- Daily usage per person, day, application and website ('' when no website)
-- -----------------------------------------------------------------------------
drop table public.daily_usage;
create table public.daily_usage (
  employee_id uuid not null references public.employees (id) on delete cascade,
  day date not null,
  app_name text not null,
  domain text not null default '',
  organization_id uuid not null references public.organizations (id) on delete cascade,
  active_seconds integer not null default 0,
  idle_seconds integer not null default 0,
  primary key (employee_id, day, app_name, domain)
);
create index daily_usage_org_day_idx on public.daily_usage (organization_id, day);

create or replace function public.usage_for_day(p_org uuid, p_day date)
returns table (employee_id uuid, app_name text, domain text, active_seconds integer, idle_seconds integer)
language sql
stable
security definer
set search_path = public
as $$
  with b as (
    select (p_day::timestamp at time zone o.timezone) as ds, ((p_day + 1)::timestamp at time zone o.timezone) as de
    from public.organizations o where o.id = p_org
  )
  select s.employee_id, coalesce(s.app_name, 'Unknown'), coalesce(s.domain, ''),
         coalesce(sum(extract(epoch from least(s.ended_at, b.de) - greatest(s.started_at, b.ds)))
                  filter (where s.state = 'active'), 0)::integer,
         coalesce(sum(extract(epoch from least(s.ended_at, b.de) - greatest(s.started_at, b.ds)))
                  filter (where s.state = 'idle'), 0)::integer
  from b
  join public.activity_segments s
    on s.organization_id = p_org and s.state in ('active', 'idle') and s.started_at < b.de and s.ended_at > b.ds
  group by 1, 2, 3;
$$;

create or replace function public.refresh_daily_usage(p_org uuid, p_day date)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  delete from public.daily_usage where organization_id = p_org and day = p_day;
  insert into public.daily_usage (employee_id, day, app_name, domain, organization_id, active_seconds, idle_seconds)
  select u.employee_id, p_day, u.app_name, u.domain, p_org, u.active_seconds, u.idle_seconds
  from public.usage_for_day(p_org, p_day) u;
  get diagnostics affected = row_count;
  return affected;
end;
$$;

-- Usage rows for a date range: stored days, plus yesterday and today read live.
create or replace function public.usage_between(p_org uuid, p_from date, p_to date)
returns table (employee_id uuid, day date, app_name text, domain text, active_seconds integer, idle_seconds integer)
language sql
stable
security definer
set search_path = public
as $$
  with t as (select (now() at time zone o.timezone)::date as today from public.organizations o where o.id = p_org)
  select u.employee_id, u.day, u.app_name, u.domain, u.active_seconds, u.idle_seconds
  from t join public.daily_usage u
    on u.organization_id = p_org and u.day between p_from and least(p_to, t.today - 2)
  union all
  select l.employee_id, d.day::date, l.app_name, l.domain, l.active_seconds, l.idle_seconds
  from t
  cross join lateral generate_series(greatest(p_from, t.today - 1)::timestamp, least(p_to, t.today)::timestamp,
                                     interval '1 day') d(day)
  cross join lateral public.usage_for_day(p_org, d.day::date) l;
$$;

-- Per person and day: active, idle, productive and unproductive seconds (categories as they are now).
create or replace function public.person_days(p_org uuid, p_team uuid, p_employee uuid, p_from date, p_to date)
returns table (employee_id uuid, day date, active_seconds bigint, idle_seconds bigint,
               productive_seconds bigint, unproductive_seconds bigint)
language sql
stable
security definer
set search_path = public
as $$
  with people as (
    select e.id, e.team_id from public.employees e
    where e.organization_id = p_org
      and (p_team is null or e.team_id = p_team)
      and (p_employee is null or e.id = p_employee)
      and public.can_view_employee(e.id)
  ),
  rows_ as (
    select u.*, p.team_id from public.usage_between(p_org, p_from, p_to) u join people p on p.id = u.employee_id
  ),
  cats as (
    select k.team_id, k.app_name, k.domain,
           public.category_of(p_org, k.team_id, k.app_name, nullif(k.domain, '')) as category
    from (select distinct r.team_id, r.app_name, r.domain from rows_ r) k
  )
  select r.employee_id, r.day,
         sum(r.active_seconds)::bigint,
         sum(r.idle_seconds)::bigint,
         coalesce(sum(r.active_seconds) filter (where c.category = 'productive'), 0)::bigint,
         coalesce(sum(r.active_seconds) filter (where c.category = 'unproductive'), 0)::bigint
  from rows_ r
  join cats c on c.team_id is not distinct from r.team_id and c.app_name = r.app_name and c.domain = r.domain
  group by r.employee_id, r.day;
$$;

create or replace function public.require_analytics(p_feature text, p_from date, p_to date)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  org_id uuid := public.my_organization_id();
begin
  if org_id is null or not public.is_manager_of(org_id) then
    raise exception 'Not allowed';
  end if;
  if not public.org_has_feature(org_id, p_feature) then
    raise exception 'This report is not included in your plan';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'Invalid period';
  end if;
  if p_to - p_from > 400 then
    raise exception 'Choose a period of at most 400 days';
  end if;
  return org_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Trends
-- -----------------------------------------------------------------------------
create or replace function public.get_trend(
  p_from date, p_to date, p_granularity text default 'day', p_team uuid default null, p_employee uuid default null)
returns table (period_start date, people integer, person_days integer, active_seconds bigint, idle_seconds bigint,
               productive_seconds bigint, unproductive_seconds bigint)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  org_id uuid := public.require_analytics('trends', p_from, p_to);
begin
  if p_granularity not in ('day', 'week', 'month') then
    raise exception 'Granularity must be day, week or month';
  end if;
  return query
  with d as (select * from public.person_days(org_id, p_team, p_employee, p_from, p_to)),
  periods as (
    select g::date as ps
    from generate_series(date_trunc(p_granularity, p_from::timestamp), p_to::timestamp,
                         ('1 ' || p_granularity)::interval) g
  )
  select p.ps,
         (count(distinct d.employee_id) filter (where d.active_seconds > 0))::integer,
         (count(*) filter (where d.active_seconds > 0))::integer,
         coalesce(sum(d.active_seconds), 0)::bigint,
         coalesce(sum(d.idle_seconds), 0)::bigint,
         coalesce(sum(d.productive_seconds), 0)::bigint,
         coalesce(sum(d.unproductive_seconds), 0)::bigint
  from periods p
  left join d on date_trunc(p_granularity, d.day::timestamp)::date = p.ps
  group by p.ps
  order by p.ps;
end;
$$;

-- -----------------------------------------------------------------------------
-- Software usage and licences
-- -----------------------------------------------------------------------------
create table public.software_licences (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  kind text not null check (kind in ('app', 'domain')),
  name text not null check (length(name) between 1 and 200 and name = lower(btrim(name))),
  seats integer not null check (seats between 1 and 100000),
  monthly_cost_per_seat numeric(12, 2) check (monthly_cost_per_seat >= 0),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.employees (id) on delete set null,
  constraint software_licences_key unique (organization_id, kind, name)
);

create or replace function public.set_software_licence(p_kind text, p_name text, p_seats integer, p_monthly_cost_per_seat numeric)
returns public.software_licences
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid := public.my_organization_id();
  norm text := lower(btrim(p_name));
  result public.software_licences;
begin
  if org_id is null or not public.is_org_wide_manager(org_id) then
    raise exception 'Not allowed';
  end if;
  if not public.org_has_feature(org_id, 'software_usage') then
    raise exception 'Software usage is not included in your plan';
  end if;
  if p_kind not in ('app', 'domain') then
    raise exception 'Invalid kind';
  end if;
  if p_kind = 'domain' then
    norm := split_part(regexp_replace(regexp_replace(norm, '^[a-z]+://', ''), '^www\.', ''), '/', 1);
  end if;
  if coalesce(norm, '') = '' then
    raise exception 'Enter the application or website';
  end if;
  if coalesce(p_seats, 0) not between 1 and 100000 then
    raise exception 'Seats must be between 1 and 100000';
  end if;
  if p_monthly_cost_per_seat < 0 then
    raise exception 'The cost cannot be negative';
  end if;
  insert into public.software_licences (organization_id, kind, name, seats, monthly_cost_per_seat, updated_by)
  values (org_id, p_kind, norm, p_seats, p_monthly_cost_per_seat, public.my_employee_id())
  on conflict (organization_id, kind, name) do update
    set seats = excluded.seats, monthly_cost_per_seat = excluded.monthly_cost_per_seat,
        updated_by = excluded.updated_by, updated_at = now()
  returning * into result;
  perform public.write_audit(org_id, 'licence_saved', 'software_licence', result.id::text,
    jsonb_build_object('kind', p_kind, 'name', norm, 'seats', p_seats, 'monthly_cost_per_seat', p_monthly_cost_per_seat));
  return result;
end;
$$;

create or replace function public.delete_software_licence(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid := public.my_organization_id();
  row_ public.software_licences;
begin
  if org_id is null or not public.is_org_wide_manager(org_id) then
    raise exception 'Not allowed';
  end if;
  delete from public.software_licences where id = p_id and organization_id = org_id returning * into row_;
  if row_.id is not null then
    perform public.write_audit(org_id, 'licence_removed', 'software_licence', p_id::text,
      jsonb_build_object('kind', row_.kind, 'name', row_.name));
  end if;
end;
$$;

-- people = activated, active people in scope; users = how many of them used it in the period.
create or replace function public.get_software_usage(p_from date, p_to date, p_kind text default 'app', p_team uuid default null)
returns table (name text, active_seconds bigint, users integer, people integer, category text,
               licence_id uuid, licence_seats integer, monthly_cost_per_seat numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  org_id uuid := public.require_analytics('software_usage', p_from, p_to);
  headcount integer;
begin
  if p_kind not in ('app', 'domain') then
    raise exception 'Invalid kind';
  end if;
  select count(*)::integer into headcount from public.employees e
  where e.organization_id = org_id and e.is_active and e.auth_user_id is not null
    and (p_team is null or e.team_id = p_team) and public.can_view_employee(e.id);

  return query
  with people as (
    select e.id from public.employees e
    where e.organization_id = org_id and (p_team is null or e.team_id = p_team) and public.can_view_employee(e.id)
  ),
  named as (
    select case when p_kind = 'app' then u.app_name else u.domain end as n, u.employee_id, u.active_seconds
    from public.usage_between(org_id, p_from, p_to) u
    join people p on p.id = u.employee_id
    where p_kind = 'app' or u.domain <> ''
  ),
  agg as (
    select n, sum(named.active_seconds)::bigint as secs,
           (count(distinct named.employee_id) filter (where named.active_seconds > 0))::integer as used_by
    from named group by n having sum(named.active_seconds) > 0
  ),
  combined as (
    select a.n, a.secs, a.used_by, l.id as lid, l.seats, l.monthly_cost_per_seat as cost
    from agg a
    left join public.software_licences l on l.organization_id = org_id and l.kind = p_kind and l.name = lower(a.n)
    union all
    select l.name, 0::bigint, 0, l.id, l.seats, l.monthly_cost_per_seat
    from public.software_licences l
    where l.organization_id = org_id and l.kind = p_kind
      and p_team is null and public.is_org_wide_manager(org_id)
      and not exists (select 1 from agg a where lower(a.n) = l.name)
  )
  select c.n, c.secs, c.used_by, headcount,
         public.category_of(org_id, p_team,
                            case when p_kind = 'app' then c.n end, case when p_kind = 'domain' then c.n end),
         c.lid, c.seats, c.cost
  from combined c
  order by c.secs desc, c.n
  limit 300;
end;
$$;

-- -----------------------------------------------------------------------------
-- Workload balance: productive hours per day worked against the person's goal
-- -----------------------------------------------------------------------------
create or replace function public.get_workload(p_from date, p_to date, p_team uuid default null)
returns table (employee_id uuid, name text, team_id uuid, team_name text, days_worked integer,
               active_seconds bigint, productive_seconds bigint, goal_hours numeric, under_percent integer,
               over_percent integer, utilisation numeric, status text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  org_id uuid := public.require_analytics('workload', p_from, p_to);
begin
  return query
  with per as (
    select d.employee_id, (count(*) filter (where d.active_seconds > 0))::integer as days,
           sum(d.active_seconds)::bigint as active, sum(d.productive_seconds)::bigint as productive
    from public.person_days(org_id, p_team, null, p_from, p_to) d
    group by d.employee_id
  ),
  emp as (
    select e.id, e.name, e.team_id, t.name as tname
    from public.employees e left join public.teams t on t.id = e.team_id
    where e.organization_id = org_id and e.is_active and e.auth_user_id is not null
      and (p_team is null or e.team_id = p_team) and public.can_view_employee(e.id)
  ),
  scored as (
    select e.*, coalesce(p.days, 0) as days, coalesce(p.active, 0)::bigint as active,
           coalesce(p.productive, 0)::bigint as productive, g.productive_hours, g.under_percent, g.over_percent,
           case when g.productive_hours is not null and coalesce(p.days, 0) > 0
                then round(p.productive::numeric / p.days / 3600 / g.productive_hours * 100, 1) end as util
    from emp e
    left join per p on p.employee_id = e.id
    left join lateral (
      select pg.productive_hours, pg.under_percent, pg.over_percent from public.productivity_goals pg
      where pg.organization_id = org_id and (pg.team_id = e.team_id or pg.team_id is null)
      order by (pg.team_id is not null) desc limit 1
    ) g on true
  )
  select s.id, s.name, s.team_id, s.tname, s.days, s.active, s.productive, s.productive_hours, s.under_percent,
         s.over_percent, s.util,
         case when s.productive_hours is null then 'no_goal'
              when s.days = 0 then 'no_data'
              when s.util < s.under_percent then 'under'
              when s.util > s.over_percent then 'over'
              else 'healthy' end
  from scored s
  order by s.util nulls last, s.name;
end;
$$;

-- -----------------------------------------------------------------------------
-- Capacity and financial impact per team
-- -----------------------------------------------------------------------------
-- Average annual salary per team (or the company), used only for capacity cost estimates.
create table public.workforce_costs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  team_id uuid references public.teams (id) on delete cascade,
  annual_salary numeric(14, 2) not null check (annual_salary > 0),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.employees (id) on delete set null
);
create unique index workforce_costs_scope_key on public.workforce_costs
  (organization_id, (coalesce(team_id, '00000000-0000-0000-0000-000000000000'::uuid)));

-- p_annual_salary null removes it. Owners and managers not limited to teams only.
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
  if not public.org_has_feature(org_id, 'workload') then
    raise exception 'Capacity planning is not included in your plan';
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

-- Salaries are only readable through this function; the table has no select policy.
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
  return query
    select c.team_id, c.annual_salary from public.workforce_costs c where c.organization_id = org_id;
end;
$$;

-- gap = goal - average productive hours per person per day worked (negative: above the goal).
-- fte_gap = gap x people / goal. Costs only for owners and managers not limited to teams.
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
  org_id uuid := public.require_analytics('workload', p_from, p_to);
  see_costs boolean := public.is_org_wide_manager(org_id);
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

-- -----------------------------------------------------------------------------
-- Back-fill daily usage in the new shape (whole days up to yesterday)
-- -----------------------------------------------------------------------------
do $$
declare
  o record;
  d date;
begin
  for o in select org.id, org.timezone, min(s.started_at) as first_at
           from public.organizations org
           join public.activity_segments s on s.organization_id = org.id
           group by org.id, org.timezone loop
    d := (o.first_at at time zone o.timezone)::date;
    while d < (now() at time zone o.timezone)::date loop
      perform public.refresh_daily_usage(o.id, d);
      d := d + 1;
    end loop;
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- Row level security and privileges
-- -----------------------------------------------------------------------------
alter table public.daily_usage enable row level security;
alter table public.software_licences enable row level security;
alter table public.workforce_costs enable row level security;

create policy daily_usage_select on public.daily_usage for select to authenticated
  using (public.can_view_employee(employee_id));
create policy software_licences_select on public.software_licences for select to authenticated
  using (public.is_manager_of(organization_id));
revoke all on public.daily_usage, public.software_licences, public.workforce_costs from anon;
revoke insert, update, delete, truncate on public.daily_usage, public.software_licences, public.workforce_costs
  from authenticated;

revoke execute on function
  public.plan_features(text),
  public.usage_for_day(uuid, date),
  public.refresh_daily_usage(uuid, date),
  public.usage_between(uuid, date, date),
  public.person_days(uuid, uuid, uuid, date, date),
  public.require_analytics(text, date, date),
  public.get_trend(date, date, text, uuid, uuid),
  public.set_software_licence(text, text, integer, numeric),
  public.delete_software_licence(uuid),
  public.get_software_usage(date, date, text, uuid),
  public.get_workload(date, date, uuid),
  public.set_workforce_cost(uuid, numeric),
  public.get_workforce_costs(),
  public.get_capacity(date, date)
from public, anon;

grant execute on function
  public.get_trend(date, date, text, uuid, uuid),
  public.set_software_licence(text, text, integer, numeric),
  public.delete_software_licence(uuid),
  public.get_software_usage(date, date, text, uuid),
  public.get_workload(date, date, uuid),
  public.set_workforce_cost(uuid, numeric),
  public.get_workforce_costs(),
  public.get_capacity(date, date)
to authenticated;

revoke execute on function
  public.plan_features(text),
  public.usage_for_day(uuid, date),
  public.refresh_daily_usage(uuid, date),
  public.usage_between(uuid, date, date),
  public.person_days(uuid, uuid, uuid, date, date),
  public.require_analytics(text, date, date)
from authenticated;

notify pgrst, 'reload schema';
