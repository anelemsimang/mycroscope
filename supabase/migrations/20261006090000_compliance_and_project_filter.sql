-- =============================================================================
-- Mycroscope v2, step 5: compliance controls and project filtering.
--   * Several changes saved together publish one notice version, not one per table.
--   * save_compliance_settings: tracking settings + Information Officer in one call.
--   * Reporting functions accept an optional project filter.
-- =============================================================================

-- now() is fixed for the whole transaction, so a policy published at now() was published by this
-- transaction and nobody can have acknowledged it yet: refresh it instead of adding a version.
create or replace function public.publish_policy_internal(p_org uuid, p_actor uuid)
returns public.monitoring_policies
language plpgsql
security definer
set search_path = public
as $$
declare
  next_version integer;
  result public.monitoring_policies;
begin
  perform pg_advisory_xact_lock(hashtext('mycroscope_policy_' || p_org::text));

  update public.monitoring_policies p
  set notice_text = public.render_monitoring_notice(p_org),
      settings_snapshot = (select to_jsonb(s) - 'updated_by' from public.organization_settings s
                           where s.organization_id = p_org),
      published_by = coalesce(p_actor, p.published_by)
  where p.organization_id = p_org and p.published_at = now()
    and p.version = (select max(version) from public.monitoring_policies where organization_id = p_org)
  returning * into result;
  if result.id is not null then
    return result;
  end if;

  select coalesce(max(version), 0) + 1 into next_version
  from public.monitoring_policies where organization_id = p_org;

  insert into public.monitoring_policies (organization_id, version, notice_text, settings_snapshot, published_by)
  select p_org, next_version, public.render_monitoring_notice(p_org), to_jsonb(s) - 'updated_by', p_actor
  from public.organization_settings s where s.organization_id = p_org
  returning * into result;

  insert into public.audit_log (organization_id, actor_employee_id, actor_auth_id, action, target_type, target_id, details)
  values (p_org, p_actor, auth.uid(), 'policy_published', 'monitoring_policy', result.id::text,
          jsonb_build_object('version', next_version));
  return result;
end;
$$;

revoke execute on function public.publish_policy_internal(uuid, uuid) from public, anon, authenticated;

-- Saves everything on the compliance screen in one transaction. Returns the current notice version
-- (unchanged if nothing that appears in the notice changed).
create or replace function public.save_compliance_settings(
  p_track_apps boolean,
  p_track_window_titles boolean,
  p_track_web_domains boolean,
  p_track_full_urls boolean,
  p_idle_threshold_seconds integer,
  p_allow_pause boolean,
  p_retention_days integer,
  p_summary_retention_days integer,
  p_notice_custom_text text,
  p_information_officer_name text,
  p_information_officer_email text)
returns public.monitoring_policies
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid := public.my_organization_id();
  officer_email text := nullif(btrim(p_information_officer_email), '');
  result public.monitoring_policies;
begin
  if org_id is null or not public.is_manager_of(org_id) then
    raise exception 'Not allowed';
  end if;
  if p_track_full_urls and not p_track_web_domains then
    raise exception 'Full web addresses can only be recorded when websites are recorded';
  end if;
  if officer_email is not null and officer_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'The Information Officer email address is not valid';
  end if;

  update public.organization_settings
  set track_apps = p_track_apps,
      track_window_titles = p_track_window_titles,
      track_web_domains = p_track_web_domains,
      track_full_urls = p_track_full_urls,
      idle_threshold_seconds = p_idle_threshold_seconds,
      allow_pause = p_allow_pause,
      retention_days = p_retention_days,
      summary_retention_days = p_summary_retention_days,
      notice_custom_text = nullif(btrim(p_notice_custom_text), ''),
      updated_by = public.my_employee_id()
  where organization_id = org_id;

  update public.organizations
  set information_officer_name = nullif(btrim(p_information_officer_name), ''),
      information_officer_email = officer_email
  where id = org_id;

  select * into result from public.monitoring_policies
  where organization_id = org_id order by version desc limit 1;
  return result;
end;
$$;

revoke execute on function public.save_compliance_settings(boolean, boolean, boolean, boolean, integer, boolean,
  integer, integer, text, text, text) from public, anon;
grant execute on function public.save_compliance_settings(boolean, boolean, boolean, boolean, integer, boolean,
  integer, integer, text, text, text) to authenticated;

-- -----------------------------------------------------------------------------
-- Optional project filter (null = all projects). The old signatures are dropped so that
-- PostgREST never has two candidate functions for the same named arguments.
-- -----------------------------------------------------------------------------
drop function public.get_daily_totals(uuid, date, date);
drop function public.get_app_totals(uuid, date, date);
drop function public.get_domain_totals(uuid, date, date);
drop function public.get_timeline(uuid, date);

create function public.get_daily_totals(p_employee uuid, p_from date, p_to date, p_project uuid default null)
returns table (day date, active_seconds bigint, idle_seconds bigint, away_seconds bigint, paused_seconds bigint,
               first_activity_at timestamptz, last_activity_at timestamptz)
language sql
stable
set search_path = public
as $$
  with emp as (
    select e.id, o.timezone
    from public.employees e join public.organizations o on o.id = e.organization_id
    where e.id = p_employee
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
     and (p_project is null or s.project_id = p_project)
  )
  select days.day,
         coalesce(sum(extract(epoch from c.ce - c.cs)) filter (where c.state = 'active'), 0)::bigint,
         coalesce(sum(extract(epoch from c.ce - c.cs)) filter (where c.state = 'idle'), 0)::bigint,
         coalesce(sum(extract(epoch from c.ce - c.cs)) filter (where c.state = 'away'), 0)::bigint,
         coalesce(sum(extract(epoch from c.ce - c.cs)) filter (where c.state = 'paused'), 0)::bigint,
         min(c.cs) filter (where c.state = 'active'),
         max(c.ce) filter (where c.state = 'active')
  from days left join clipped c on c.day = days.day
  group by days.day
  order by days.day;
$$;

create function public.get_app_totals(p_employee uuid, p_from date, p_to date, p_project uuid default null)
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
  where s.state in ('active', 'idle') and (p_project is null or s.project_id = p_project)
  group by 1
  order by 2 desc;
$$;

create function public.get_domain_totals(p_employee uuid, p_from date, p_to date, p_project uuid default null)
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
  where s.domain is not null and s.state in ('active', 'idle') and (p_project is null or s.project_id = p_project)
  group by s.domain
  order by 2 desc;
$$;

create function public.get_timeline(p_employee uuid, p_day date, p_project uuid default null)
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
  where p_project is null or s.project_id = p_project
  order by s.started_at;
$$;

revoke execute on function
  public.get_daily_totals(uuid, date, date, uuid),
  public.get_app_totals(uuid, date, date, uuid),
  public.get_domain_totals(uuid, date, date, uuid),
  public.get_timeline(uuid, date, uuid)
from public, anon;
grant execute on function
  public.get_daily_totals(uuid, date, date, uuid),
  public.get_app_totals(uuid, date, date, uuid),
  public.get_domain_totals(uuid, date, date, uuid),
  public.get_timeline(uuid, date, uuid)
to authenticated;

notify pgrst, 'reload schema';
