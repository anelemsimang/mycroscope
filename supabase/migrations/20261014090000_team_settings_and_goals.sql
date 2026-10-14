-- =============================================================================
-- Mycroscope: plan features, daily usage, per-team settings and productivity goals
--   * plan_features / org_has_feature / get_my_features: which plan includes what
--   * daily_usage: per-person, per-day app and website totals, filled nightly (company-wide reports)
--   * Productivity categories per team (team rules win over company rules)
--   * Working hours per team or per person, part of the notice and the policy snapshot
--   * Productivity goals per company or team, with under/over-utilisation thresholds
-- Run after 20261011090000_install_key_and_tamper.sql.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Plan features. Trials (including case studies) get everything.
-- -----------------------------------------------------------------------------
create or replace function public.plan_features(p_plan text)
returns text[]
language sql
immutable
as $$
  select case p_plan
    when 'standard' then array['team_categories', 'team_schedules']
    when 'business' then array['team_categories', 'team_schedules', 'goals']
    when 'enterprise' then array['team_categories', 'team_schedules', 'goals']
    when 'trial' then array['team_categories', 'team_schedules', 'goals']
    else array[]::text[]
  end;
$$;

create or replace function public.org_has_feature(p_org uuid, p_feature text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select p_feature = any (public.plan_features(s.plan))
                   from public.subscriptions s where s.organization_id = p_org), false);
$$;

create or replace function public.get_my_features()
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select public.plan_features(s.plan) from public.subscriptions s
                   where s.organization_id = public.my_organization_id()), array[]::text[]);
$$;

-- -----------------------------------------------------------------------------
-- Scope helpers
-- -----------------------------------------------------------------------------
-- Owner, or a manager who is not limited to particular teams.
create or replace function public.is_org_wide_manager(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_manager_of(p_org) and exists (
    select 1 from public.employees me
    where me.auth_user_id = auth.uid() and me.is_active and me.organization_id = p_org
      and (me.role = 'owner' or not exists (select 1 from public.team_managers tm where tm.employee_id = me.id)));
$$;

-- Owner, a manager without teams, or a manager of this team.
create or replace function public.can_manage_team(p_team uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.teams t
    join public.employees me on me.auth_user_id = auth.uid() and me.is_active and me.organization_id = t.organization_id
    where t.id = p_team and me.role in ('owner', 'manager') and public.mfa_ok(t.organization_id)
      and (me.role = 'owner'
           or not exists (select 1 from public.team_managers tm where tm.employee_id = me.id)
           or exists (select 1 from public.team_managers tm where tm.employee_id = me.id and tm.team_id = p_team)));
$$;

-- -----------------------------------------------------------------------------
-- Daily usage per person, app and website (company-wide reports read this, not raw segments)
-- -----------------------------------------------------------------------------
create table public.daily_usage (
  employee_id uuid not null references public.employees (id) on delete cascade,
  day date not null,
  kind text not null check (kind in ('app', 'domain')),
  name text not null,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  active_seconds integer not null default 0,
  idle_seconds integer not null default 0,
  primary key (employee_id, day, kind, name)
);
create index daily_usage_org_day_idx on public.daily_usage (organization_id, day);

create or replace function public.refresh_daily_usage(p_org uuid, p_day date)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  tz text;
  day_start timestamptz;
  day_end timestamptz;
  affected integer;
begin
  select timezone into tz from public.organizations where id = p_org;
  if tz is null then
    return 0;
  end if;
  day_start := p_day::timestamp at time zone tz;
  day_end := (p_day + 1)::timestamp at time zone tz;

  delete from public.daily_usage where organization_id = p_org and day = p_day;
  insert into public.daily_usage (employee_id, day, kind, name, organization_id, active_seconds, idle_seconds)
  select c.employee_id, p_day, k.kind, k.name, p_org,
         coalesce(sum(c.secs) filter (where c.state = 'active'), 0)::integer,
         coalesce(sum(c.secs) filter (where c.state = 'idle'), 0)::integer
  from (
    select s.employee_id, s.state, s.app_name, s.domain,
           extract(epoch from least(s.ended_at, day_end) - greatest(s.started_at, day_start)) as secs
    from public.activity_segments s
    where s.organization_id = p_org and s.state in ('active', 'idle')
      and s.started_at < day_end and s.ended_at > day_start
  ) c
  cross join lateral (values ('app', coalesce(c.app_name, 'Unknown')), ('domain', c.domain)) k(kind, name)
  where k.name is not null
  group by c.employee_id, k.kind, k.name;
  get diagnostics affected = row_count;
  return affected;
end;
$$;

-- -----------------------------------------------------------------------------
-- Productivity categories per team
-- -----------------------------------------------------------------------------
alter table public.app_categories add column team_id uuid references public.teams (id) on delete cascade;
drop index public.app_categories_key;
create unique index app_categories_key on public.app_categories
  (organization_id, (coalesce(team_id, '00000000-0000-0000-0000-000000000000'::uuid)), kind, pattern);

-- Website rules win over app rules; within each kind a rule for the person's team wins over a company rule.
create or replace function public.category_of(p_org uuid, p_team uuid, p_app text, p_domain text)
returns text
language sql
stable
set search_path = public
as $$
  select coalesce(
    (select c.category from public.app_categories c
     where c.organization_id = p_org and c.kind = 'domain' and p_domain is not null
       and (c.team_id is null or c.team_id = p_team)
       and (lower(p_domain) = c.pattern or right(lower(p_domain), length(c.pattern) + 1) = '.' || c.pattern)
     order by (c.team_id is not null) desc, length(c.pattern) desc limit 1),
    (select c.category from public.app_categories c
     where c.organization_id = p_org and c.kind = 'app' and p_app is not null and lower(p_app) = c.pattern
       and (c.team_id is null or c.team_id = p_team)
     order by (c.team_id is not null) desc limit 1),
    'uncategorised');
$$;

create or replace function public.category_of(p_org uuid, p_app text, p_domain text)
returns text
language sql
stable
set search_path = public
as $$
  select public.category_of(p_org, null::uuid, p_app, p_domain);
$$;

drop function public.set_app_category(text, text, text);
create function public.set_app_category(p_kind text, p_pattern text, p_category text, p_team uuid default null)
returns public.app_categories
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid := public.my_organization_id();
  norm text := lower(btrim(p_pattern));
  result public.app_categories;
begin
  if org_id is null or not public.is_manager_of(org_id) then
    raise exception 'Not allowed';
  end if;
  if p_team is not null then
    if not public.can_manage_team(p_team) then
      raise exception 'Not allowed';
    end if;
    if not public.org_has_feature(org_id, 'team_categories') then
      raise exception 'Team rules are not included in your plan';
    end if;
  end if;
  if p_kind = 'domain' then
    norm := regexp_replace(regexp_replace(norm, '^[a-z]+://', ''), '^www\.', '');
    norm := split_part(norm, '/', 1);
  end if;
  insert into public.app_categories (organization_id, team_id, kind, pattern, category, created_by)
  values (org_id, p_team, p_kind, norm, p_category, public.my_employee_id())
  on conflict (organization_id, (coalesce(team_id, '00000000-0000-0000-0000-000000000000'::uuid)), kind, pattern)
  do update set category = excluded.category
  returning * into result;
  perform public.write_audit(org_id, 'category_set', 'app_category', result.id::text,
    jsonb_build_object('kind', p_kind, 'pattern', norm, 'category', p_category, 'team', p_team));
  return result;
end;
$$;

create or replace function public.delete_app_category(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid := public.my_organization_id();
  row_ public.app_categories;
begin
  if org_id is null or not public.is_manager_of(org_id) then
    raise exception 'Not allowed';
  end if;
  select * into row_ from public.app_categories where id = p_id and organization_id = org_id;
  if row_.id is null then
    return;
  end if;
  if row_.team_id is not null and not public.can_manage_team(row_.team_id) then
    raise exception 'Not allowed';
  end if;
  delete from public.app_categories where id = p_id;
  perform public.write_audit(org_id, 'category_removed', 'app_category', p_id::text,
    jsonb_build_object('kind', row_.kind, 'pattern', row_.pattern, 'team', row_.team_id));
end;
$$;

create or replace function public.get_category_totals(p_employee uuid, p_from date, p_to date, p_project uuid default null)
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
  where s.state in ('active', 'idle') and (p_project is null or s.project_id = p_project)
  group by 1
  order by 2 desc;
$$;

-- -----------------------------------------------------------------------------
-- Working hours per team or per person. They only apply when monitoring is limited to working hours.
-- The policy snapshot carries them, so the desktop app enforces the hours the employee acknowledged.
-- -----------------------------------------------------------------------------
create table public.work_schedules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  team_id uuid references public.teams (id) on delete cascade,
  employee_id uuid references public.employees (id) on delete cascade,
  work_days smallint[] not null
    check (cardinality(work_days) between 1 and 7 and work_days <@ '{1,2,3,4,5,6,7}'::smallint[]),
  work_start time not null,
  work_end time not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.employees (id) on delete set null,
  constraint work_schedules_one_target check ((team_id is null) <> (employee_id is null)),
  constraint work_schedules_hours_differ check (work_end <> work_start)
);
create unique index work_schedules_team_key on public.work_schedules (team_id) where team_id is not null;
create unique index work_schedules_employee_key on public.work_schedules (employee_id) where employee_id is not null;
create index work_schedules_org_idx on public.work_schedules (organization_id);

create or replace function public.policy_settings_snapshot(p_org uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select (to_jsonb(s) - 'updated_by') || jsonb_build_object('schedules', coalesce(
    (select jsonb_agg(jsonb_build_object('team_id', w.team_id, 'employee_id', w.employee_id, 'work_days', w.work_days,
                                         'work_start', w.work_start, 'work_end', w.work_end)
                      order by w.team_id, w.employee_id)
     from public.work_schedules w where w.organization_id = p_org), '[]'::jsonb))
  from public.organization_settings s where s.organization_id = p_org;
$$;

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
      settings_snapshot = public.policy_settings_snapshot(p_org),
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
  values (p_org, next_version, public.render_monitoring_notice(p_org), public.policy_settings_snapshot(p_org), p_actor)
  returning * into result;

  insert into public.audit_log (organization_id, actor_employee_id, actor_auth_id, action, target_type, target_id, details)
  values (p_org, p_actor, auth.uid(), 'policy_published', 'monitoring_policy', result.id::text,
          jsonb_build_object('version', next_version));
  return result;
end;
$$;

-- Hours apply to a team or person only while monitoring is limited to working hours, so only then do
-- changes need a new notice.
create or replace function public.republish_if_work_hours(p_org uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.organization_settings
             where organization_id = p_org and tracking_schedule = 'work_hours') then
    perform public.publish_policy_internal(p_org, public.my_employee_id());
  end if;
end;
$$;

create or replace function public.render_monitoring_notice(p_org uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  o public.organizations;
  s public.organization_settings;
  items text := '';
  contact text;
  pause_text text;
  schedule_text text;
  integrity_text text;
  team_hours text;
  day_names text[] := array['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  days text;
begin
  select * into o from public.organizations where id = p_org;
  select * into s from public.organization_settings where organization_id = p_org;
  if o.id is null or s.organization_id is null then
    raise exception 'organisation % not found', p_org;
  end if;

  if s.track_apps then
    items := items || E'\n  - The name of the application in use (for example "Microsoft Excel") and how long it is used.';
  end if;
  if s.track_window_titles then
    items := items || E'\n  - Window titles of the application in use. Window titles can contain document names, email subjects or chat names.';
  end if;
  if s.track_web_domains then
    items := items || E'\n  - Websites visited in supported browsers (domain names such as "example.com") and how long they are open.';
  end if;
  if s.track_full_urls then
    items := items || E'\n  - Full web addresses (URLs) of pages visited, which can include search terms and page paths.';
  end if;
  items := items || format(
    E'\n  - Active time, idle time (no keyboard or mouse input for %s minutes) and away time (screen locked or computer asleep).',
    s.idle_threshold_seconds / 60);
  items := items || E'\n  - When you log in, log out, pause and resume monitoring, and the project you select.';

  select string_agg(day_names[d], ', ' order by d) into days from unnest(s.work_days) d;
  schedule_text := case when s.tracking_schedule = 'work_hours'
    then format('Monitoring is limited to working hours: %s, %s to %s (%s time). Outside these hours nothing is recorded%s.',
                days, to_char(s.work_start, 'HH24:MI'), to_char(s.work_end, 'HH24:MI'), o.timezone,
                case when s.flag_after_hours_use
                     then ', except a note that the computer was in use (not what it was used for)' else '' end)
    else 'Monitoring runs whenever you are signed in to Mycroscope on this computer.'
  end;
  if s.tracking_schedule = 'work_hours' then
    select string_agg(format('%s: %s, %s to %s', t.name, dl.days, to_char(w.work_start, 'HH24:MI'),
                             to_char(w.work_end, 'HH24:MI')), '; ' order by lower(t.name))
    into team_hours
    from public.work_schedules w
    join public.teams t on t.id = w.team_id
    cross join lateral (select string_agg(day_names[d], ', ' order by d) as days from unnest(w.work_days) d) dl
    where w.organization_id = p_org;
    if team_hours is not null then
      schedule_text := schedule_text || format(' Different working hours apply to these teams: %s.', team_hours);
    end if;
    if exists (select 1 from public.work_schedules where organization_id = p_org and employee_id is not null) then
      schedule_text := schedule_text
        || ' Some people have individual working hours agreed with them; the Mycroscope desktop app shows the hours that apply to you.';
    end if;
  end if;

  integrity_text := case when s.detect_tampering
    then E'\n\nINTEGRITY CHECKS\nTo keep records reliable, Mycroscope tells your managers if it is closed, stopped or removed while the computer is in use, if the computer clock is changed, if it runs inside a virtual machine or remote session, and if keyboard or mouse input follows an automated pattern. These checks record no content.'
    else ''
  end;

  contact := coalesce(nullif(btrim(o.information_officer_name), ''), 'the organisation''s Information Officer')
             || coalesce(' (' || nullif(btrim(o.information_officer_email), '') || ')', '');

  pause_text := case when s.allow_pause
    then 'You can pause monitoring at any time from the tray icon, for example for personal use. Pause periods are recorded and visible to managers.'
    else 'Monitoring cannot be paused while you are logged in. Log out of Mycroscope when you are not working.'
  end;

  return format(
E'MONITORING NOTICE - %1$s\n\n%2$s\n\nWHAT IS RECORDED\nWhile you are logged in to Mycroscope on this computer, %1$s records:%3$s\n\nWHEN\n%8$s\n\nWHAT IS NOT RECORDED\nKeystrokes (what you type), screenshots, screen recordings, webcam or microphone, file contents, and the contents of emails or messages.\n\nWHY\nTo understand how working time is spent, to allocate time to projects, and to manage productivity and the proper use of company equipment.\n\nYOUR CONTROL\nA Mycroscope icon is shown in the system tray whenever monitoring is active. %4$s%9$s\n\nSIGN-IN REMINDERS\nWhile this computer is in use and nobody is signed in to Mycroscope, or this notice has not been acknowledged, the Mycroscope window reappears on top of other windows every 2 minutes as a reminder to sign in. It never locks the computer, and you may sign out at any time. If the computer is used for 15 minutes in a row without anyone signed in, the managers of %1$s are told the computer''s name and for how long it was used. This is listed under the last person who signed in to Mycroscope on that computer. Nothing about what the computer was used for is recorded.\n\nWHO CAN SEE IT\nOwners and managers of %1$s. You can view your own recorded activity from the Mycroscope tray icon.\n\nHOW LONG IT IS KEPT\nDetailed activity is deleted after %5$s days. Daily totals are kept for %6$s days.\n\nYOUR RIGHTS\nUnder the Protection of Personal Information Act, 2013 (POPIA) you may ask to access or correct your information and you may object to the processing. Contact %7$s, or send a request from the Mycroscope app. You may also lodge a complaint with the Information Regulator (https://inforegulator.org.za).\n\nThis notice is also given for the purposes of the Regulation of Interception of Communications and Provision of Communication-Related Information Act, 2002 (RICA). By selecting "I acknowledge" you confirm that you have read this notice and consent to the monitoring described above.',
    o.name,
    coalesce(nullif(btrim(s.notice_custom_text), ''), 'Please read this notice before you start working.'),
    items,
    pause_text,
    s.retention_days,
    s.summary_retention_days,
    contact,
    schedule_text,
    integrity_text);
end;
$$;

-- The desktop app picks its own hours from the snapshot (person, then team, then company), so it needs its team.
drop function public.get_my_policy_status();
create function public.get_my_policy_status()
returns table (policy_id uuid, version integer, notice_text text, settings jsonb,
               acknowledged boolean, acknowledged_at timestamptz, team_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.version, p.notice_text, p.settings_snapshot,
         c.id is not null, c.acknowledged_at,
         (select e.team_id from public.employees e where e.id = public.my_employee_id())
  from public.monitoring_policies p
  left join public.consents c on c.policy_id = p.id and c.employee_id = public.my_employee_id()
  where p.organization_id = public.my_organization_id()
  order by p.version desc
  limit 1;
$$;

-- p_local is a local wall-clock time; an end before the start is a night shift belonging to the start day.
create or replace function public.in_work_hours(p_days smallint[], p_start time, p_end time, p_local timestamp)
returns boolean
language sql
immutable
as $$
  select case
    when p_start < p_end then
      extract(isodow from p_local)::smallint = any (p_days) and p_local::time >= p_start and p_local::time < p_end
    else
      (extract(isodow from p_local)::smallint = any (p_days) and p_local::time >= p_start)
      or (extract(isodow from p_local - interval '1 day')::smallint = any (p_days) and p_local::time < p_end)
  end;
$$;

-- Current hours for one person: their own, else their team's, else the company's.
create or replace function public.is_employee_work_time(p_employee uuid, p_at timestamptz)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.in_work_hours(
           coalesce(es.work_days, ts.work_days, s.work_days),
           coalesce(es.work_start, ts.work_start, s.work_start),
           coalesce(es.work_end, ts.work_end, s.work_end),
           p_at at time zone o.timezone)
  from public.employees e
  join public.organizations o on o.id = e.organization_id
  join public.organization_settings s on s.organization_id = e.organization_id
  left join public.work_schedules es on es.employee_id = e.id
  left join public.work_schedules ts on ts.team_id = e.team_id
  where e.id = p_employee;
$$;

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
  where public.is_employee_work_time(e.id, now())
    and st.last_seen_at < now() - interval '30 minutes'
    and st.last_seen_at > now() - interval '7 days'
    and public.can_view_employee(e.id)
    and public.is_manager_of(me.organization_id)
  order by 3 desc
  limit 500;
$$;

-- Saves the hours of one team (p_team) or one person (p_employee). Returns the current notice.
create or replace function public.save_work_schedule(
  p_team uuid, p_employee uuid, p_work_days integer[], p_work_start time, p_work_end time)
returns public.monitoring_policies
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid := public.my_organization_id();
  days smallint[];
  result public.monitoring_policies;
begin
  if org_id is null or not public.is_manager_of(org_id) then
    raise exception 'Not allowed';
  end if;
  if (p_team is null) = (p_employee is null) then
    raise exception 'Choose either a team or a person';
  end if;
  if p_team is not null and not public.can_manage_team(p_team) then
    raise exception 'Not allowed';
  end if;
  if p_employee is not null and not (public.can_manage_employee(p_employee)
       and exists (select 1 from public.employees where id = p_employee and organization_id = org_id)) then
    raise exception 'Not allowed';
  end if;
  if not public.org_has_feature(org_id, 'team_schedules') then
    raise exception 'Team and individual working hours are not included in your plan';
  end if;
  if p_work_days is null or cardinality(p_work_days) = 0
     or exists (select 1 from unnest(p_work_days) d where d not between 1 and 7) then
    raise exception 'Choose at least one working day';
  end if;
  if p_work_start is null or p_work_end is null or p_work_start = p_work_end then
    raise exception 'Working hours must start and end at different times';
  end if;
  days := array(select distinct d::smallint from unnest(p_work_days) d order by 1);

  delete from public.work_schedules
  where organization_id = org_id
    and (team_id = p_team or employee_id = p_employee);
  insert into public.work_schedules (organization_id, team_id, employee_id, work_days, work_start, work_end, updated_by)
  values (org_id, p_team, p_employee, days, p_work_start, p_work_end, public.my_employee_id());

  perform public.write_audit(org_id, 'work_schedule_saved', case when p_team is null then 'employee' else 'team' end,
    coalesce(p_team, p_employee)::text,
    jsonb_build_object('work_days', days, 'work_start', p_work_start, 'work_end', p_work_end));
  perform public.republish_if_work_hours(org_id);

  select * into result from public.monitoring_policies
  where organization_id = org_id order by version desc limit 1;
  return result;
end;
$$;

-- Removes a team's or person's own hours, so the team's or company's hours apply again.
create or replace function public.delete_work_schedule(p_team uuid, p_employee uuid)
returns public.monitoring_policies
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid := public.my_organization_id();
  removed integer;
  result public.monitoring_policies;
begin
  if org_id is null or not public.is_manager_of(org_id) then
    raise exception 'Not allowed';
  end if;
  if (p_team is null) = (p_employee is null) then
    raise exception 'Choose either a team or a person';
  end if;
  if (p_team is not null and not public.can_manage_team(p_team))
     or (p_employee is not null and not public.can_manage_employee(p_employee)) then
    raise exception 'Not allowed';
  end if;

  delete from public.work_schedules
  where organization_id = org_id and (team_id = p_team or employee_id = p_employee);
  get diagnostics removed = row_count;
  if removed > 0 then
    perform public.write_audit(org_id, 'work_schedule_removed', case when p_team is null then 'employee' else 'team' end,
      coalesce(p_team, p_employee)::text, '{}'::jsonb);
    perform public.republish_if_work_hours(org_id);
  end if;

  select * into result from public.monitoring_policies
  where organization_id = org_id order by version desc limit 1;
  return result;
end;
$$;

-- Team names appear in the notice next to their hours, so renaming or deleting such a team republishes it.
create or replace function public.save_team(p_team uuid, p_name text)
returns public.teams
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid := public.my_organization_id();
  old_name text;
  result public.teams;
begin
  if org_id is null or public.my_role() <> 'owner' or not public.mfa_ok(org_id) then
    raise exception 'Only the owner can manage teams';
  end if;
  if p_team is null then
    insert into public.teams (organization_id, name) values (org_id, btrim(p_name)) returning * into result;
  else
    select name into old_name from public.teams where id = p_team and organization_id = org_id;
    update public.teams set name = btrim(p_name) where id = p_team and organization_id = org_id returning * into result;
    if result.id is null then
      raise exception 'Unknown team';
    end if;
    if old_name is distinct from result.name and exists (select 1 from public.work_schedules where team_id = p_team) then
      perform public.republish_if_work_hours(org_id);
    end if;
  end if;
  perform public.write_audit(org_id, 'team_saved', 'team', result.id::text, jsonb_build_object('name', result.name));
  return result;
end;
$$;

create or replace function public.delete_team(p_team uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid := public.my_organization_id();
  team_name text;
  had_hours boolean;
begin
  if org_id is null or public.my_role() <> 'owner' or not public.mfa_ok(org_id) then
    raise exception 'Only the owner can manage teams';
  end if;
  had_hours := exists (select 1 from public.work_schedules where team_id = p_team and organization_id = org_id);
  delete from public.teams where id = p_team and organization_id = org_id returning name into team_name;
  if team_name is null then
    raise exception 'Unknown team';
  end if;
  perform public.write_audit(org_id, 'team_deleted', 'team', p_team::text, jsonb_build_object('name', team_name));
  if had_hours then
    perform public.republish_if_work_hours(org_id);
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Productivity goals: productive hours per person per day, for the company or a team
-- -----------------------------------------------------------------------------
create table public.productivity_goals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  team_id uuid references public.teams (id) on delete cascade,
  productive_hours numeric(4, 2) not null check (productive_hours between 0.5 and 16),
  under_percent integer not null default 80 check (under_percent between 10 and 99),
  over_percent integer not null default 120 check (over_percent between 101 and 300),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.employees (id) on delete set null
);
create unique index productivity_goals_scope_key on public.productivity_goals
  (organization_id, (coalesce(team_id, '00000000-0000-0000-0000-000000000000'::uuid)));

create or replace function public.save_goal(
  p_team uuid, p_productive_hours numeric, p_under_percent integer, p_over_percent integer)
returns public.productivity_goals
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid := public.my_organization_id();
  result public.productivity_goals;
begin
  if org_id is null or not public.is_manager_of(org_id) then
    raise exception 'Not allowed';
  end if;
  if (p_team is null and not public.is_org_wide_manager(org_id))
     or (p_team is not null and not public.can_manage_team(p_team)) then
    raise exception 'Not allowed';
  end if;
  if not public.org_has_feature(org_id, 'goals') then
    raise exception 'Productivity goals are not included in your plan';
  end if;
  if p_productive_hours is null or p_productive_hours < 0.5 or p_productive_hours > 16 then
    raise exception 'The daily goal must be between 0.5 and 16 hours';
  end if;
  if coalesce(p_under_percent, 0) not between 10 and 99 then
    raise exception 'The under-utilised threshold must be between 10%% and 99%%';
  end if;
  if coalesce(p_over_percent, 0) not between 101 and 300 then
    raise exception 'The over-utilised threshold must be between 101%% and 300%%';
  end if;

  insert into public.productivity_goals (organization_id, team_id, productive_hours, under_percent, over_percent, updated_by)
  values (org_id, p_team, round(p_productive_hours, 2), p_under_percent, p_over_percent, public.my_employee_id())
  on conflict (organization_id, (coalesce(team_id, '00000000-0000-0000-0000-000000000000'::uuid)))
  do update set productive_hours = excluded.productive_hours, under_percent = excluded.under_percent,
                over_percent = excluded.over_percent, updated_by = excluded.updated_by, updated_at = now()
  returning * into result;
  perform public.write_audit(org_id, 'goal_saved', case when p_team is null then 'organization' else 'team' end,
    coalesce(p_team, org_id)::text,
    jsonb_build_object('productive_hours', result.productive_hours, 'under_percent', result.under_percent,
                       'over_percent', result.over_percent));
  return result;
end;
$$;

create or replace function public.delete_goal(p_team uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid := public.my_organization_id();
  removed integer;
begin
  if org_id is null or not public.is_manager_of(org_id) then
    raise exception 'Not allowed';
  end if;
  if (p_team is null and not public.is_org_wide_manager(org_id))
     or (p_team is not null and not public.can_manage_team(p_team)) then
    raise exception 'Not allowed';
  end if;
  delete from public.productivity_goals
  where organization_id = org_id and team_id is not distinct from p_team;
  get diagnostics removed = row_count;
  if removed > 0 then
    perform public.write_audit(org_id, 'goal_removed', case when p_team is null then 'organization' else 'team' end,
      coalesce(p_team, org_id)::text, '{}'::jsonb);
  end if;
end;
$$;

-- The goal that applies to one person: their team's, else the company's. No row when neither is set.
create or replace function public.goal_for_employee(p_employee uuid)
returns table (productive_hours numeric, under_percent integer, over_percent integer, team_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select g.productive_hours, g.under_percent, g.over_percent, g.team_id
  from public.employees e
  join public.productivity_goals g on g.organization_id = e.organization_id
                                  and (g.team_id = e.team_id or g.team_id is null)
  where e.id = p_employee and public.can_view_employee(p_employee)
    and public.is_manager_of(e.organization_id)
  order by (g.team_id is not null) desc
  limit 1;
$$;

-- -----------------------------------------------------------------------------
-- Nightly maintenance and deletions also cover daily usage
-- -----------------------------------------------------------------------------
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

  perform public.purge_expired_data();
  delete from public.daily_usage u
  using public.organization_settings s
  where s.organization_id = u.organization_id
    and u.day < (now() - make_interval(days => s.summary_retention_days))::date;

  delete from public.maintenance_runs where ran_at < now() - interval '90 days';
  insert into public.maintenance_runs (duration_ms, details)
  values ((extract(epoch from clock_timestamp() - started) * 1000)::integer,
          jsonb_build_object('stale_sessions_closed', stale));
end;
$$;

create or replace function public.delete_activity(
  p_employee uuid, p_from timestamptz, p_to timestamptz, p_reason text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  emp public.employees;
  tz text;
  removed integer;
begin
  select * into emp from public.employees where id = p_employee;
  if emp.id is null or not public.can_manage_employee(emp.id) then
    raise exception 'Not allowed';
  end if;
  if p_to <= p_from then
    raise exception 'Invalid time range';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'A reason is required';
  end if;
  select timezone into tz from public.organizations where id = emp.organization_id;

  delete from public.activity_segments
  where employee_id = p_employee and started_at >= p_from and started_at < p_to;
  get diagnostics removed = row_count;

  delete from public.daily_summaries
  where employee_id = p_employee
    and day between (p_from at time zone tz)::date and (p_to at time zone tz)::date;
  delete from public.daily_usage
  where employee_id = p_employee
    and day between (p_from at time zone tz)::date and (p_to at time zone tz)::date;

  perform public.write_audit(emp.organization_id, 'activity_deleted', 'employee', emp.id::text,
    jsonb_build_object('from', p_from, 'to', p_to, 'segments', removed, 'reason', p_reason));
  return removed;
end;
$$;

-- Fill daily usage for the history that is already stored (whole days up to yesterday).
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
alter table public.work_schedules enable row level security;
alter table public.productivity_goals enable row level security;

create policy daily_usage_select on public.daily_usage for select to authenticated
  using (public.can_view_employee(employee_id));
create policy work_schedules_select on public.work_schedules for select to authenticated
  using (public.is_manager_of(organization_id));
create policy productivity_goals_select on public.productivity_goals for select to authenticated
  using (public.is_manager_of(organization_id));

revoke all on public.daily_usage, public.work_schedules, public.productivity_goals from anon;
revoke insert, update, delete, truncate on public.daily_usage, public.work_schedules, public.productivity_goals
  from authenticated;

revoke execute on function
  public.plan_features(text),
  public.org_has_feature(uuid, text),
  public.get_my_features(),
  public.is_org_wide_manager(uuid),
  public.can_manage_team(uuid),
  public.refresh_daily_usage(uuid, date),
  public.category_of(uuid, uuid, text, text),
  public.category_of(uuid, text, text),
  public.set_app_category(text, text, text, uuid),
  public.delete_app_category(uuid),
  public.get_category_totals(uuid, date, date, uuid),
  public.policy_settings_snapshot(uuid),
  public.publish_policy_internal(uuid, uuid),
  public.republish_if_work_hours(uuid),
  public.render_monitoring_notice(uuid),
  public.get_my_policy_status(),
  public.in_work_hours(smallint[], time, time, timestamp),
  public.is_employee_work_time(uuid, timestamptz),
  public.get_integrity_alerts(timestamptz),
  public.save_work_schedule(uuid, uuid, integer[], time, time),
  public.delete_work_schedule(uuid, uuid),
  public.save_team(uuid, text),
  public.delete_team(uuid),
  public.save_goal(uuid, numeric, integer, integer),
  public.delete_goal(uuid),
  public.goal_for_employee(uuid),
  public.run_nightly_maintenance(),
  public.delete_activity(uuid, timestamptz, timestamptz, text)
from public, anon;

grant execute on function
  public.get_my_features(),
  public.category_of(uuid, uuid, text, text),
  public.category_of(uuid, text, text),
  public.set_app_category(text, text, text, uuid),
  public.delete_app_category(uuid),
  public.get_category_totals(uuid, date, date, uuid),
  public.get_my_policy_status(),
  public.get_integrity_alerts(timestamptz),
  public.save_work_schedule(uuid, uuid, integer[], time, time),
  public.delete_work_schedule(uuid, uuid),
  public.save_team(uuid, text),
  public.delete_team(uuid),
  public.save_goal(uuid, numeric, integer, integer),
  public.delete_goal(uuid),
  public.goal_for_employee(uuid),
  public.delete_activity(uuid, timestamptz, timestamptz, text)
to authenticated;

revoke execute on function
  public.plan_features(text),
  public.org_has_feature(uuid, text),
  public.is_org_wide_manager(uuid),
  public.can_manage_team(uuid),
  public.refresh_daily_usage(uuid, date),
  public.policy_settings_snapshot(uuid),
  public.publish_policy_internal(uuid, uuid),
  public.republish_if_work_hours(uuid),
  public.render_monitoring_notice(uuid),
  public.in_work_hours(smallint[], time, time, timestamp),
  public.is_employee_work_time(uuid, timestamptz),
  public.run_nightly_maintenance()
from authenticated;

notify pgrst, 'reload schema';
