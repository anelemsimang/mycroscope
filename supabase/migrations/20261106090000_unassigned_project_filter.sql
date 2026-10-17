-- "No project" is computer time recorded while no project was selected.
-- p_unassigned limits a report to those segments. A named p_project is ignored when it is true.
-- Time away stays on the unfiltered report: those answers are not stored against a project.

drop function public.get_daily_totals(uuid, date, date, uuid);
drop function public.get_app_totals(uuid, date, date, uuid);
drop function public.get_domain_totals(uuid, date, date, uuid);
drop function public.get_timeline(uuid, date, uuid);
drop function public.get_category_totals(uuid, date, date, uuid);

create function public.get_daily_totals(
  p_employee uuid, p_from date, p_to date, p_project uuid default null, p_unassigned boolean default false)
returns table (day date, active_seconds bigint, idle_seconds bigint, away_seconds bigint, paused_seconds bigint,
               first_activity_at timestamptz, last_activity_at timestamptz, meeting_seconds bigint,
               call_seconds bigint, break_seconds bigint, other_seconds bigint, productive_offline_seconds bigint)
language sql
stable
security definer
set search_path = public
as $$
  with emp as (
    select e.id, e.organization_id, o.timezone
    from public.employees e
    join public.organizations o on o.id = e.organization_id
    where e.id = p_employee and public.can_view_employee(e.id)
  ),
  days as (
    select d::date as day,
           (d::date)::timestamp at time zone emp.timezone as day_start,
           (d::date + 1)::timestamp at time zone emp.timezone as day_end
    from emp, generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') d
  ),
  clipped as (
    select days.day, s.state,
           greatest(s.started_at, days.day_start) as cs,
           least(s.ended_at, days.day_end) as ce
    from days
    join public.activity_segments s
      on s.employee_id = p_employee and s.started_at < days.day_end and s.ended_at > days.day_start
     and case
           when p_unassigned then s.project_id is null
           when p_project is not null then s.project_id = p_project
           else true
         end
  ),
  seg as (
    select days.day,
           coalesce(sum(extract(epoch from c.ce - c.cs)) filter (where c.state = 'active'), 0)::bigint as active_seconds,
           coalesce(sum(extract(epoch from c.ce - c.cs)) filter (where c.state = 'idle'), 0)::bigint as idle_seconds,
           coalesce(sum(extract(epoch from c.ce - c.cs)) filter (where c.state = 'away'), 0)::bigint as away_seconds,
           coalesce(sum(extract(epoch from c.ce - c.cs)) filter (where c.state = 'paused'), 0)::bigint as paused_seconds,
           min(c.cs) filter (where c.state = 'active') as first_activity_at,
           max(c.ce) filter (where c.state = 'active') as last_activity_at
    from days left join clipped c on c.day = days.day
    group by days.day
  ),
  off as (
    select o.day, o.meeting_seconds, o.call_seconds, o.break_seconds, o.other_seconds, o.productive_offline_seconds
    from emp
    join public.offline_day_seconds(emp.organization_id, p_from, p_to) o on o.employee_id = emp.id
    where not p_unassigned and p_project is null
  )
  select seg.day, seg.active_seconds, seg.idle_seconds, seg.away_seconds, seg.paused_seconds,
         seg.first_activity_at, seg.last_activity_at,
         case when not p_unassigned and p_project is null then coalesce(off.meeting_seconds, 0) else 0 end,
         case when not p_unassigned and p_project is null then coalesce(off.call_seconds, 0) else 0 end,
         case when not p_unassigned and p_project is null then coalesce(off.break_seconds, 0) else 0 end,
         case when not p_unassigned and p_project is null then coalesce(off.other_seconds, 0) else 0 end,
         case when not p_unassigned and p_project is null then coalesce(off.productive_offline_seconds, 0) else 0 end
  from seg
  left join off on off.day = seg.day
  order by seg.day;
$$;

create function public.get_app_totals(
  p_employee uuid, p_from date, p_to date, p_project uuid default null, p_unassigned boolean default false)
returns table (app_name text, active_seconds bigint, idle_seconds bigint, last_used_at timestamptz)
language sql
stable
set search_path = public
as $$
  select coalesce(s.app_name, 'Unknown'),
         coalesce(sum(extract(epoch from least(s.ended_at, b.range_end) - greatest(s.started_at, b.range_start)))
                  filter (where s.state = 'active'), 0)::bigint,
         coalesce(sum(extract(epoch from least(s.ended_at, b.range_end) - greatest(s.started_at, b.range_start)))
                  filter (where s.state = 'idle'), 0)::bigint,
         max(s.ended_at)
  from public.period_bounds(p_employee, p_from, p_to) b
  join public.activity_segments s
    on s.employee_id = p_employee and s.started_at < b.range_end and s.ended_at > b.range_start
  where s.state in ('active', 'idle')
    and case
          when p_unassigned then s.project_id is null
          when p_project is not null then s.project_id = p_project
          else true
        end
  group by 1
  order by 2 desc;
$$;

create function public.get_domain_totals(
  p_employee uuid, p_from date, p_to date, p_project uuid default null, p_unassigned boolean default false)
returns table (domain text, active_seconds bigint, idle_seconds bigint, last_visited_at timestamptz, sample_title text)
language sql
stable
set search_path = public
as $$
  select s.domain,
         coalesce(sum(extract(epoch from least(s.ended_at, b.range_end) - greatest(s.started_at, b.range_start)))
                  filter (where s.state = 'active'), 0)::bigint,
         coalesce(sum(extract(epoch from least(s.ended_at, b.range_end) - greatest(s.started_at, b.range_start)))
                  filter (where s.state = 'idle'), 0)::bigint,
         max(s.ended_at),
         (array_agg(s.window_title order by s.ended_at desc))[1]
  from public.period_bounds(p_employee, p_from, p_to) b
  join public.activity_segments s
    on s.employee_id = p_employee and s.started_at < b.range_end and s.ended_at > b.range_start
  where s.domain is not null and s.state in ('active', 'idle')
    and case
          when p_unassigned then s.project_id is null
          when p_project is not null then s.project_id = p_project
          else true
        end
  group by s.domain
  order by 2 desc;
$$;

create function public.get_timeline(
  p_employee uuid, p_day date, p_project uuid default null, p_unassigned boolean default false)
returns table (id uuid, state text, started_at timestamptz, ended_at timestamptz, duration_seconds integer,
               app_name text, window_title text, url text, domain text, project_name text)
language sql
stable
set search_path = public
as $$
  select s.id, s.state,
         greatest(s.started_at, b.range_start), least(s.ended_at, b.range_end),
         extract(epoch from least(s.ended_at, b.range_end) - greatest(s.started_at, b.range_start))::integer,
         s.app_name, s.window_title, s.url, s.domain, p.name
  from public.period_bounds(p_employee, p_day, p_day) b
  join public.activity_segments s
    on s.employee_id = p_employee and s.started_at < b.range_end and s.ended_at > b.range_start
  left join public.projects p on p.id = s.project_id
  where case
          when p_unassigned then s.project_id is null
          when p_project is not null then s.project_id = p_project
          else true
        end
  order by s.started_at;
$$;

create function public.get_category_totals(
  p_employee uuid, p_from date, p_to date, p_project uuid default null, p_unassigned boolean default false)
returns table (category text, active_seconds bigint, idle_seconds bigint)
language sql
stable
set search_path = public
as $$
  select public.category_of(s.organization_id, (select e.team_id from public.employees e where e.id = p_employee),
                            s.app_name, s.domain),
         coalesce(sum(extract(epoch from least(s.ended_at, b.range_end) - greatest(s.started_at, b.range_start)))
                  filter (where s.state = 'active'), 0)::bigint,
         coalesce(sum(extract(epoch from least(s.ended_at, b.range_end) - greatest(s.started_at, b.range_start)))
                  filter (where s.state = 'idle'), 0)::bigint
  from public.period_bounds(p_employee, p_from, p_to) b
  join public.activity_segments s
    on s.employee_id = p_employee and s.started_at < b.range_end and s.ended_at > b.range_start
  where s.state in ('active', 'idle')
    and case
          when p_unassigned then s.project_id is null
          when p_project is not null then s.project_id = p_project
          else true
        end
  group by 1
  order by 2 desc;
$$;

revoke execute on function
  public.get_daily_totals(uuid, date, date, uuid, boolean),
  public.get_app_totals(uuid, date, date, uuid, boolean),
  public.get_domain_totals(uuid, date, date, uuid, boolean),
  public.get_timeline(uuid, date, uuid, boolean),
  public.get_category_totals(uuid, date, date, uuid, boolean)
from public, anon;

grant execute on function
  public.get_daily_totals(uuid, date, date, uuid, boolean),
  public.get_app_totals(uuid, date, date, uuid, boolean),
  public.get_domain_totals(uuid, date, date, uuid, boolean),
  public.get_timeline(uuid, date, uuid, boolean),
  public.get_category_totals(uuid, date, date, uuid, boolean)
to authenticated;

notify pgrst, 'reload schema';
