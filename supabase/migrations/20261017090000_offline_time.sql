-- =============================================================================
-- Mycroscope: time away from the computer (meetings, calls, breaks)
--   * offline_entries: the employee's own answer for a stretch of idle or away time.
--     Activity segments are unchanged; an entry overlaps the time it explains.
--   * Managers choose which reasons count as productive. That choice is applied when
--     reports are read, so changing it updates past days too (same as categories).
--   * Included in the productive total: Trends (the headline, not the computer-time bars),
--     Workload, Capacity, goals comparisons, and the read-only API daily totals.
--   * Shown separately, and not mixed into app or website totals: daily totals, the
--     employee page, and Trends. A project filter leaves this time out.
--   * The desktop app asks only after the notice that describes it has been acknowledged.
-- Run after 20261016090000_alerts_and_integrations.sql.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Settings. Off until a manager turns it on, which publishes a new notice.
-- -----------------------------------------------------------------------------
alter table public.organization_settings
  add column ask_offline_reason boolean not null default false,
  add column offline_prompt_minutes integer not null default 10
    check (offline_prompt_minutes between 1 and 120),
  add column productive_offline_reasons text[] not null default '{meeting,call}'
    check (productive_offline_reasons <@ array['meeting', 'call', 'break', 'other']::text[]);

drop function public.save_compliance_settings(jsonb, text, text);
create function public.save_compliance_settings(
  p_settings jsonb, p_information_officer_name text, p_information_officer_email text)
returns public.monitoring_policies
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid := public.my_organization_id();
  officer_email text := nullif(btrim(p_information_officer_email), '');
  cur public.organization_settings;
  p jsonb := coalesce(p_settings, '{}'::jsonb);
  web_domains boolean;
  full_urls boolean;
  reasons text[];
  result public.monitoring_policies;
begin
  if org_id is null or not public.is_manager_of(org_id) then
    raise exception 'Not allowed';
  end if;
  select * into cur from public.organization_settings where organization_id = org_id;
  if (p ->> 'require_mfa')::boolean is distinct from cur.require_mfa and p ? 'require_mfa'
     and public.my_role() <> 'owner' then
    raise exception 'Only the owner can change the two-factor requirement';
  end if;
  web_domains := coalesce((p ->> 'track_web_domains')::boolean, cur.track_web_domains);
  full_urls := coalesce((p ->> 'track_full_urls')::boolean, cur.track_full_urls);
  if full_urls and not web_domains then
    raise exception 'Full web addresses can only be recorded when websites are recorded';
  end if;
  if officer_email is not null and officer_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'The Information Officer email address is not valid';
  end if;
  if (coalesce((p ->> 'detect_removable_media')::boolean, false) and not cur.detect_removable_media
      or coalesce((p ->> 'detect_cloud_sync')::boolean, false) and not cur.detect_cloud_sync
      or coalesce((p ->> 'detect_network_drives')::boolean, false) and not cur.detect_network_drives)
     and not public.org_has_feature(org_id, 'file_activity') then
    raise exception 'File activity is not included in your plan';
  end if;
  if p ? 'offline_prompt_minutes' and (
       (p ->> 'offline_prompt_minutes') !~ '^[0-9]+$'
       or (p ->> 'offline_prompt_minutes')::integer not between 1 and 120) then
    raise exception 'Ask after between 1 and 120 minutes';
  end if;
  if p ? 'productive_offline_reasons' then
    if jsonb_typeof(p -> 'productive_offline_reasons') is distinct from 'array' then
      raise exception 'Choose which reasons count as productive';
    end if;
    if exists (
      select 1 from jsonb_array_elements_text(p -> 'productive_offline_reasons') x
      where x not in ('meeting', 'call', 'break', 'other')) then
      raise exception 'Unknown reason';
    end if;
    select coalesce(array_agg(distinct x order by x), '{}'::text[]) into reasons
    from jsonb_array_elements_text(p -> 'productive_offline_reasons') x;
  end if;

  update public.organization_settings
  set track_apps = coalesce((p ->> 'track_apps')::boolean, track_apps),
      track_window_titles = coalesce((p ->> 'track_window_titles')::boolean, track_window_titles),
      track_web_domains = web_domains,
      track_full_urls = full_urls,
      idle_threshold_seconds = coalesce((p ->> 'idle_threshold_seconds')::integer, idle_threshold_seconds),
      allow_pause = coalesce((p ->> 'allow_pause')::boolean, allow_pause),
      retention_days = coalesce((p ->> 'retention_days')::integer, retention_days),
      summary_retention_days = coalesce((p ->> 'summary_retention_days')::integer, summary_retention_days),
      notice_custom_text = case when p ? 'notice_custom_text' then nullif(btrim(p ->> 'notice_custom_text'), '')
                                else notice_custom_text end,
      tracking_schedule = coalesce(p ->> 'tracking_schedule', tracking_schedule),
      work_days = coalesce((select array_agg(distinct x::smallint order by x::smallint)
                            from jsonb_array_elements_text(case when jsonb_typeof(p -> 'work_days') = 'array'
                                                                then p -> 'work_days' end) x), work_days),
      work_start = coalesce((p ->> 'work_start')::time, work_start),
      work_end = coalesce((p ->> 'work_end')::time, work_end),
      flag_after_hours_use = coalesce((p ->> 'flag_after_hours_use')::boolean, flag_after_hours_use),
      detect_tampering = coalesce((p ->> 'detect_tampering')::boolean, detect_tampering),
      require_mfa = coalesce((p ->> 'require_mfa')::boolean, require_mfa),
      detect_removable_media = coalesce((p ->> 'detect_removable_media')::boolean, detect_removable_media),
      detect_cloud_sync = coalesce((p ->> 'detect_cloud_sync')::boolean, detect_cloud_sync),
      detect_network_drives = coalesce((p ->> 'detect_network_drives')::boolean, detect_network_drives),
      file_retention_days = coalesce((p ->> 'file_retention_days')::integer, file_retention_days),
      ask_offline_reason = coalesce((p ->> 'ask_offline_reason')::boolean, ask_offline_reason),
      offline_prompt_minutes = coalesce((p ->> 'offline_prompt_minutes')::integer, offline_prompt_minutes),
      productive_offline_reasons = coalesce(reasons, productive_offline_reasons),
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
  file_retention text := '';
  team_hours text;
  reason_names text;
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
  if s.detect_removable_media then
    items := items || E'\n  - When a USB drive, external disk or phone is connected to this computer: the kind of device and its name. For USB drives and external disks, also the names, sizes and times of files copied onto them.';
  end if;
  if s.detect_cloud_sync then
    items := items || E'\n  - The names, sizes and times of new files in OneDrive, Dropbox and Google Drive folders on this computer, which these services copy to the internet.';
  end if;
  if s.detect_network_drives then
    items := items || E'\n  - The names, sizes and times of files you copy to network drives.';
  end if;
  if s.detect_removable_media or s.detect_cloud_sync or s.detect_network_drives then
    file_retention := format(' Names and sizes of copied files are deleted after %s days.', s.file_retention_days);
  end if;
  if s.ask_offline_reason then
    select string_agg(v.label, ', ' order by v.ord) into reason_names
    from (values ('meeting', 'meetings', 1), ('call', 'calls', 2), ('break', 'breaks', 3),
                 ('other', 'other', 4)) as v(code, label, ord)
    where v.code = any (s.productive_offline_reasons);
    items := items || format(
      E'\n  - When you return after being idle or away for %s %s or more, Mycroscope asks what you were doing: a meeting, a call, a break, or other, with an optional note of up to 200 characters. You may dismiss the question. Your answer, including any note, is visible to your managers and to you.',
      s.offline_prompt_minutes, case when s.offline_prompt_minutes = 1 then 'minute' else 'minutes' end);
    items := items || case when reason_names is null
      then ' None of these answers are added to productive time.'
      else format(' Counted as productive time: %s.', reason_names) end;
  end if;

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
E'MONITORING NOTICE - %1$s\n\n%2$s\n\nWHAT IS RECORDED\nWhile you are logged in to Mycroscope on this computer, %1$s records:%3$s\n\nWHEN\n%8$s\n\nWHAT IS NOT RECORDED\nKeystrokes (what you type), screenshots, screen recordings, webcam or microphone, file contents, and the contents of emails or messages.\n\nWHY\nTo understand how working time is spent, to allocate time to projects, and to manage productivity and the proper use of company equipment.\n\nYOUR CONTROL\nA Mycroscope icon is shown in the system tray whenever monitoring is active. %4$s%9$s\n\nSIGN-IN REMINDERS\nWhile this computer is in use and nobody is signed in to Mycroscope, or this notice has not been acknowledged, the Mycroscope window reappears on top of other windows every 2 minutes as a reminder to sign in. It never locks the computer, and you may sign out at any time. If the computer is used for 15 minutes in a row without anyone signed in, the managers of %1$s are told the computer''s name and for how long it was used. This is listed under the last person who signed in to Mycroscope on that computer. Nothing about what the computer was used for is recorded.\n\nWHO CAN SEE IT\nOwners and managers of %1$s. You can view your own recorded activity from the Mycroscope tray icon.\n\nHOW LONG IT IS KEPT\nDetailed activity is deleted after %5$s days. Daily totals are kept for %6$s days.%10$s\n\nYOUR RIGHTS\nUnder the Protection of Personal Information Act, 2013 (POPIA) you may ask to access or correct your information and you may object to the processing. Contact %7$s, or send a request from the Mycroscope app. You may also lodge a complaint with the Information Regulator (https://inforegulator.org.za).\n\nThis notice is also given for the purposes of the Regulation of Interception of Communications and Provision of Communication-Related Information Act, 2002 (RICA). By selecting "I acknowledge" you confirm that you have read this notice and consent to the monitoring described above.',
    o.name,
    coalesce(nullif(btrim(s.notice_custom_text), ''), 'Please read this notice before you start working.'),
    items,
    pause_text,
    s.retention_days,
    s.summary_retention_days,
    contact,
    schedule_text,
    integrity_text,
    file_retention);
end;
$$;

-- -----------------------------------------------------------------------------
-- Answers. One person's entries never overlap. Readable only through the functions below.
-- -----------------------------------------------------------------------------
create table public.offline_entries (
  id uuid primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  employee_id uuid not null references public.employees (id) on delete cascade,
  device_id uuid references public.devices (id) on delete set null,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  reason text not null check (reason in ('meeting', 'call', 'break', 'other')),
  note text,
  received_at timestamptz not null default now(),
  constraint offline_entries_length check (ended_at > started_at and ended_at <= started_at + interval '16 hours'),
  constraint offline_entries_note check (note is null or length(btrim(note)) between 1 and 200),
  constraint offline_entries_no_overlap exclude using gist (
    employee_id with =, tstzrange(started_at, ended_at, '[)') with &&)
);
create index offline_entries_employee_time_idx on public.offline_entries (employee_id, started_at desc);
create index offline_entries_org_end_idx on public.offline_entries (organization_id, ended_at);

-- Used by the insert policy: the signed-in person's company asks this question.
create function public.offline_prompts_on()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select s.ask_offline_reason from public.organization_settings s
    where s.organization_id = public.my_organization_id()), false);
$$;

-- Seconds per person per local day. Reasons currently marked productive are summed apart.
-- Internal: it returns the whole company, so only other security-definer functions may call it.
create function public.offline_day_seconds(p_org uuid, p_from date, p_to date)
returns table (employee_id uuid, day date, meeting_seconds bigint, call_seconds bigint, break_seconds bigint,
               other_seconds bigint, offline_seconds bigint, productive_offline_seconds bigint)
language sql
stable
security definer
set search_path = public
as $$
  with org as (
    select o.timezone, s.productive_offline_reasons as productive
    from public.organizations o
    join public.organization_settings s on s.organization_id = o.id
    where o.id = p_org
  ),
  days as (
    select d::date as day,
           (d::date::timestamp at time zone org.timezone) as day_start,
           ((d::date + 1)::timestamp at time zone org.timezone) as day_end,
           org.productive
    from org
    cross join generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') d
  ),
  clipped as (
    select e.employee_id, days.day, e.reason, days.productive,
           extract(epoch from least(e.ended_at, days.day_end) - greatest(e.started_at, days.day_start)) as secs
    from days
    join public.offline_entries e
      on e.organization_id = p_org and e.started_at < days.day_end and e.ended_at > days.day_start
  )
  select c.employee_id, c.day,
         coalesce(sum(c.secs) filter (where c.reason = 'meeting'), 0)::bigint,
         coalesce(sum(c.secs) filter (where c.reason = 'call'), 0)::bigint,
         coalesce(sum(c.secs) filter (where c.reason = 'break'), 0)::bigint,
         coalesce(sum(c.secs) filter (where c.reason = 'other'), 0)::bigint,
         coalesce(sum(c.secs), 0)::bigint,
         coalesce(sum(c.secs) filter (where c.reason = any (c.productive)), 0)::bigint
  from clipped c
  group by c.employee_id, c.day, c.productive;
$$;

create function public.get_offline_entries(p_employee uuid, p_from timestamptz, p_to timestamptz)
returns table (id uuid, started_at timestamptz, ended_at timestamptz, reason text, note text, hostname text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  emp public.employees;
begin
  select * into emp from public.employees where employees.id = p_employee;
  if emp.id is null or not public.can_view_employee(emp.id) then
    raise exception 'Not allowed';
  end if;
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '93 days' then
    raise exception 'Choose a period of at most 93 days';
  end if;
  return query
    select e.id, e.started_at, e.ended_at, e.reason, e.note, d.hostname
    from public.offline_entries e
    left join public.devices d on d.id = e.device_id
    where e.employee_id = emp.id and e.started_at < p_to and e.ended_at > p_from
    order by e.started_at desc
    limit 2000;
end;
$$;

-- -----------------------------------------------------------------------------
-- Daily totals gain the four reasons. A project filter leaves them at zero.
-- -----------------------------------------------------------------------------
drop function public.get_daily_totals(uuid, date, date, uuid);
create function public.get_daily_totals(p_employee uuid, p_from date, p_to date, p_project uuid default null)
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
     and (p_project is null or s.project_id = p_project)
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
    where p_project is null
  )
  select seg.day, seg.active_seconds, seg.idle_seconds, seg.away_seconds, seg.paused_seconds,
         seg.first_activity_at, seg.last_activity_at,
         case when p_project is null then coalesce(off.meeting_seconds, 0) else 0 end,
         case when p_project is null then coalesce(off.call_seconds, 0) else 0 end,
         case when p_project is null then coalesce(off.break_seconds, 0) else 0 end,
         case when p_project is null then coalesce(off.other_seconds, 0) else 0 end,
         case when p_project is null then coalesce(off.productive_offline_seconds, 0) else 0 end
  from seg
  left join off on off.day = seg.day
  order by seg.day;
$$;

-- -----------------------------------------------------------------------------
-- Trends keep computer productive time separate. Workload and the API add the
-- productive reasons into the figure compared with a goal.
-- -----------------------------------------------------------------------------
drop function public.get_capacity(date, date);
drop function public.get_workload(date, date, uuid);
drop function public.get_trend(date, date, text, uuid, uuid);
drop function public.person_days(uuid, uuid, uuid, date, date);
drop function public.api_daily_totals(uuid, date, date);

create function public.person_days(p_org uuid, p_team uuid, p_employee uuid, p_from date, p_to date)
returns table (employee_id uuid, day date, active_seconds bigint, idle_seconds bigint,
               productive_seconds bigint, unproductive_seconds bigint,
               offline_seconds bigint, productive_offline_seconds bigint)
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
  ),
  classified as (
    select r.employee_id, r.day,
           sum(r.active_seconds)::bigint as active_seconds,
           sum(r.idle_seconds)::bigint as idle_seconds,
           coalesce(sum(r.active_seconds) filter (where c.category = 'productive'), 0)::bigint as productive_seconds,
           coalesce(sum(r.active_seconds) filter (where c.category = 'unproductive'), 0)::bigint as unproductive_seconds
    from rows_ r
    join cats c on c.team_id is not distinct from r.team_id and c.app_name = r.app_name and c.domain = r.domain
    group by r.employee_id, r.day
  ),
  off as (
    select o.employee_id, o.day, o.offline_seconds, o.productive_offline_seconds
    from public.offline_day_seconds(p_org, p_from, p_to) o
    join people p on p.id = o.employee_id
  )
  select coalesce(c.employee_id, o.employee_id),
         coalesce(c.day, o.day),
         coalesce(c.active_seconds, 0),
         coalesce(c.idle_seconds, 0),
         coalesce(c.productive_seconds, 0),
         coalesce(c.unproductive_seconds, 0),
         coalesce(o.offline_seconds, 0),
         coalesce(o.productive_offline_seconds, 0)
  from classified c
  full join off o on o.employee_id = c.employee_id and o.day = c.day;
$$;

create function public.get_trend(
  p_from date, p_to date, p_granularity text default 'day', p_team uuid default null, p_employee uuid default null)
returns table (period_start date, people integer, person_days integer, active_seconds bigint, idle_seconds bigint,
               productive_seconds bigint, unproductive_seconds bigint, offline_seconds bigint,
               productive_offline_seconds bigint)
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
         (count(distinct d.employee_id) filter (where d.active_seconds > 0 or d.productive_offline_seconds > 0))::integer,
         (count(*) filter (where d.active_seconds > 0 or d.productive_offline_seconds > 0))::integer,
         coalesce(sum(d.active_seconds), 0)::bigint,
         coalesce(sum(d.idle_seconds), 0)::bigint,
         coalesce(sum(d.productive_seconds), 0)::bigint,
         coalesce(sum(d.unproductive_seconds), 0)::bigint,
         coalesce(sum(d.offline_seconds), 0)::bigint,
         coalesce(sum(d.productive_offline_seconds), 0)::bigint
  from periods p
  left join d on date_trunc(p_granularity, d.day::timestamp)::date = p.ps
  group by p.ps
  order by p.ps;
end;
$$;

create function public.get_workload(p_from date, p_to date, p_team uuid default null)
returns table (employee_id uuid, name text, team_id uuid, team_name text, days_worked integer,
               active_seconds bigint, productive_seconds bigint, goal_hours numeric, under_percent integer,
               over_percent integer, utilisation numeric, status text, offline_seconds bigint)
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
    select d.employee_id,
           (count(*) filter (where d.active_seconds > 0 or d.productive_offline_seconds > 0))::integer as days,
           sum(d.active_seconds)::bigint as active,
           sum(d.productive_seconds + d.productive_offline_seconds)::bigint as productive,
           sum(d.offline_seconds)::bigint as offline
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
           coalesce(p.productive, 0)::bigint as productive, coalesce(p.offline, 0)::bigint as offline,
           g.productive_hours, g.under_percent, g.over_percent,
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
              else 'healthy' end,
         s.offline
  from scored s
  order by s.util nulls last, s.name;
end;
$$;

-- Unchanged apart from being recreated after get_workload. Productive seconds now include
-- the reasons counted as productive, so the capacity gap does too.
create function public.get_capacity(p_from date, p_to date)
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

create function public.api_daily_totals(p_org uuid, p_from date, p_to date)
returns table (employee_id uuid, day date, active_seconds bigint, idle_seconds bigint,
               productive_seconds bigint, unproductive_seconds bigint,
               offline_seconds bigint, productive_offline_seconds bigint)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.api_check_period(p_from, p_to);
  return query
  with rows_ as (
    select u.*, e.team_id from public.usage_between(p_org, p_from, p_to) u join public.employees e on e.id = u.employee_id
  ),
  cats as (
    select k.team_id, k.app_name, k.domain,
           public.category_of(p_org, k.team_id, k.app_name, nullif(k.domain, '')) as category
    from (select distinct r.team_id, r.app_name, r.domain from rows_ r) k
  ),
  computer as (
    select r.employee_id, r.day, sum(r.active_seconds)::bigint as active_seconds,
           sum(r.idle_seconds)::bigint as idle_seconds,
           coalesce(sum(r.active_seconds) filter (where c.category = 'productive'), 0)::bigint as productive_seconds,
           coalesce(sum(r.active_seconds) filter (where c.category = 'unproductive'), 0)::bigint as unproductive_seconds
    from rows_ r
    join cats c on c.team_id is not distinct from r.team_id and c.app_name = r.app_name and c.domain = r.domain
    group by r.employee_id, r.day
  ),
  off as (
    select o.employee_id, o.day, o.offline_seconds, o.productive_offline_seconds
    from public.offline_day_seconds(p_org, p_from, p_to) o
  )
  select coalesce(c.employee_id, o.employee_id), coalesce(c.day, o.day),
         coalesce(c.active_seconds, 0), coalesce(c.idle_seconds, 0),
         coalesce(c.productive_seconds, 0) + coalesce(o.productive_offline_seconds, 0),
         coalesce(c.unproductive_seconds, 0),
         coalesce(o.offline_seconds, 0), coalesce(o.productive_offline_seconds, 0)
  from computer c
  full join off o on o.employee_id = c.employee_id and o.day = c.day
  order by 2, 1;
end;
$$;

-- -----------------------------------------------------------------------------
-- Retention matches detailed activity. Deleting a person's activity deletes answers too.
-- -----------------------------------------------------------------------------
create or replace function public.purge_expired_data()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s record;
  cutoff timestamptz;
  n_segments integer;
  n_events integer;
  n_sessions integer;
  n_summaries integer;
  n_offline integer;
begin
  for s in select organization_id, retention_days, summary_retention_days from public.organization_settings loop
    cutoff := now() - make_interval(days => s.retention_days);
    delete from public.activity_segments where organization_id = s.organization_id and ended_at < cutoff;
    get diagnostics n_segments = row_count;
    delete from public.agent_events where organization_id = s.organization_id and occurred_at < cutoff;
    get diagnostics n_events = row_count;
    delete from public.agent_sessions
      where organization_id = s.organization_id and coalesce(ended_at, started_at) < cutoff;
    get diagnostics n_sessions = row_count;
    delete from public.offline_entries where organization_id = s.organization_id and ended_at < cutoff;
    get diagnostics n_offline = row_count;
    delete from public.daily_summaries
      where organization_id = s.organization_id
        and day < (now() - make_interval(days => s.summary_retention_days))::date;
    get diagnostics n_summaries = row_count;

    if n_segments + n_events + n_sessions + n_summaries + n_offline > 0 then
      insert into public.audit_log (organization_id, action, target_type, details)
      values (s.organization_id, 'retention_purge', 'organization',
              jsonb_build_object('segments', n_segments, 'events', n_events,
                                 'sessions', n_sessions, 'summaries', n_summaries,
                                 'offline_entries', n_offline, 'retention_days', s.retention_days));
    end if;
  end loop;
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
  files integer;
  offline integer;
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
  delete from public.file_events
  where employee_id = p_employee and occurred_at >= p_from and occurred_at < p_to;
  get diagnostics files = row_count;
  delete from public.offline_entries
  where employee_id = p_employee and started_at >= p_from and started_at < p_to;
  get diagnostics offline = row_count;

  delete from public.daily_summaries
  where employee_id = p_employee
    and day between (p_from at time zone tz)::date and (p_to at time zone tz)::date;
  delete from public.daily_usage
  where employee_id = p_employee
    and day between (p_from at time zone tz)::date and (p_to at time zone tz)::date;

  perform public.write_audit(emp.organization_id, 'activity_deleted', 'employee', emp.id::text,
    jsonb_build_object('from', p_from, 'to', p_to, 'segments', removed, 'file_events', files,
                       'offline_entries', offline, 'reason', p_reason));
  return removed;
end;
$$;

-- -----------------------------------------------------------------------------
-- Row level security and privileges
-- -----------------------------------------------------------------------------
alter table public.offline_entries enable row level security;

create policy offline_entries_insert on public.offline_entries for insert to authenticated
  with check (employee_id = public.my_employee_id()
              and organization_id = public.my_organization_id()
              and public.owns_device(device_id)
              and started_at > now() - interval '14 days'
              and ended_at < now() + interval '10 minutes'
              and public.has_consented_before(started_at)
              and public.offline_prompts_on());

revoke all on public.offline_entries from anon;
revoke select, update, delete, truncate on public.offline_entries from authenticated;

revoke execute on function
  public.save_compliance_settings(jsonb, text, text),
  public.offline_prompts_on(),
  public.offline_day_seconds(uuid, date, date),
  public.get_offline_entries(uuid, timestamptz, timestamptz),
  public.get_daily_totals(uuid, date, date, uuid),
  public.person_days(uuid, uuid, uuid, date, date),
  public.get_trend(date, date, text, uuid, uuid),
  public.get_workload(date, date, uuid),
  public.get_capacity(date, date),
  public.api_daily_totals(uuid, date, date)
from public, anon;

revoke execute on function
  public.offline_day_seconds(uuid, date, date),
  public.person_days(uuid, uuid, uuid, date, date),
  public.api_daily_totals(uuid, date, date)
from authenticated;

grant execute on function
  public.save_compliance_settings(jsonb, text, text),
  public.offline_prompts_on(),
  public.get_offline_entries(uuid, timestamptz, timestamptz),
  public.get_daily_totals(uuid, date, date, uuid),
  public.get_trend(date, date, text, uuid, uuid),
  public.get_workload(date, date, uuid),
  public.get_capacity(date, date)
to authenticated;

grant execute on function public.api_daily_totals(uuid, date, date) to service_role;

notify pgrst, 'reload schema';
