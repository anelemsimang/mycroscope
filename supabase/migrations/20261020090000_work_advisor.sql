-- =============================================================================
-- Mycroscope: written advice for managers
--   * Off until the owner turns it on. Business, Enterprise, and the trial.
--   * A manager's question is answered by OpenAI, which may call only the existing
--     reports (trends, workload, capacity, software). It cannot write SQL.
--   * Names are replaced with stable codes before anything is sent, then put back
--     in the answer stored here. Pay figures are not sent.
--   * A weekly note per team is written by a scheduled job and can be emailed.
-- Run after 20261019090000_ai_tools.sql.
-- =============================================================================

create or replace function public.plan_features(p_plan text)
returns text[]
language sql
immutable
as $$
  select case p_plan
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

create or replace function public.save_compliance_settings(
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
  office_days integer;
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
  if coalesce((p ->> 'track_work_location')::boolean, false) and not cur.track_work_location
     and not public.org_has_feature(org_id, 'work_location') then
    raise exception 'Office and remote days are not included in your plan';
  end if;
  if coalesce((p ->> 'alert_unapproved_ai')::boolean, false) and not cur.alert_unapproved_ai
     and not public.org_has_feature(org_id, 'ai_tools') then
    raise exception 'AI tool reports are not included in your plan';
  end if;
  if (coalesce((p ->> 'advisor_enabled')::boolean, false) and not cur.advisor_enabled
      or coalesce((p ->> 'advisor_weekly_email')::boolean, false) and not cur.advisor_weekly_email)
     and not public.org_has_feature(org_id, 'work_advisor') then
    raise exception 'Written advice is not included in your plan';
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
  if p ? 'office_days_per_week' then
    if p -> 'office_days_per_week' = 'null'::jsonb or nullif(btrim(p ->> 'office_days_per_week'), '') is null then
      office_days := null;
    elsif (p ->> 'office_days_per_week') !~ '^[0-9]+$'
          or (p ->> 'office_days_per_week')::integer not between 1 and 7 then
      raise exception 'Office days per week must be from 1 to 7, or empty when there is no target';
    else
      office_days := (p ->> 'office_days_per_week')::integer;
    end if;
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
      track_work_location = coalesce((p ->> 'track_work_location')::boolean, track_work_location),
      office_days_per_week = case when p ? 'office_days_per_week' then office_days else office_days_per_week end,
      alert_unapproved_ai = coalesce((p ->> 'alert_unapproved_ai')::boolean, alert_unapproved_ai),
      advisor_enabled = coalesce((p ->> 'advisor_enabled')::boolean, advisor_enabled),
      advisor_weekly_email = coalesce((p ->> 'advisor_weekly_email')::boolean, advisor_weekly_email),
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

-- -----------------------------------------------------------------------------
-- Registered offices, and one result per person per day
-- -----------------------------------------------------------------------------

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
  office_names text;
  team_office text;
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
  if s.track_work_location then
    select string_agg(n.name, ', ' order by lower(n.name)) into office_names
    from public.office_networks n where n.organization_id = p_org;
    items := items || E'\n  - Whether this computer is on a registered office network. Mycroscope compares the office public internet address or Wi-Fi name with this computer and records each day as in the office, working remotely, or mixed. Your home address and the name of your home network are not stored.';
    if office_names is not null then
      items := items || format(' Registered offices: %s.', office_names);
    end if;
    if s.office_days_per_week is not null then
      items := items || format(
        ' The company looks for %s office %s in a week. A day counts when you were in an office for part of it.',
        s.office_days_per_week, case when s.office_days_per_week = 1 then 'day' else 'days' end);
    end if;
    select string_agg(format('%s: %s', t.name, t.office_days_per_week), ', ' order by lower(t.name))
    into team_office
    from public.teams t where t.organization_id = p_org and t.office_days_per_week is not null;
    if team_office is not null then
      items := items || format(' Some teams have their own weekly number: %s.', team_office);
    end if;
  end if;
  if s.alert_unapproved_ai then
    items := items || E'\n  - When you use an AI tool your company has marked as not approved, your managers are told which tool it was and for how long. Mycroscope keeps the list of AI tools; your company marks each one approved or not.';
  end if;
  if s.advisor_enabled then
    items := items || E'\n  - Written advice for your managers. When a manager asks a question, and for a weekly note, Mycroscope sends team totals and per-person hours to OpenAI in the United States. Your name is replaced with a code such as Person 1 before it is sent, and put back in the answer your managers see. A question is sent after names that match people in the company are replaced. Pay figures are not sent. OpenAI''s terms apply to that transfer.';
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

alter table public.organization_settings
  add column advisor_enabled boolean not null default false,
  add column advisor_weekly_email boolean not null default false,
  add column advisor_salt text not null default encode(gen_random_bytes(16), 'hex');

create table public.advisor_questions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  asked_by uuid references public.employees (id) on delete set null,
  team_id uuid references public.teams (id) on delete set null,
  question text not null check (length(question) between 1 and 800),
  answer text not null check (length(answer) between 1 and 8000),
  created_at timestamptz not null default now()
);
create index advisor_questions_org_idx on public.advisor_questions (organization_id, created_at desc);

create table public.coaching_notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  team_id uuid references public.teams (id) on delete cascade,
  week_start date not null,
  body text not null check (length(body) between 1 and 8000),
  created_at timestamptz not null default now()
);
create unique index coaching_notes_week_key
  on public.coaching_notes (organization_id, coalesce(team_id, '00000000-0000-0000-0000-000000000000'::uuid), week_start);

-- Stable codes for the people this manager can see. Person 1 is the same person every time.
create function public.advisor_directory(p_team uuid default null)
returns table (employee_id uuid, name text, pseudo text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  org_id uuid := public.my_organization_id();
  salt text;
begin
  if org_id is null or not public.is_manager_of(org_id) or not public.mfa_ok(org_id) then
    raise exception 'Not allowed';
  end if;
  if not public.org_has_feature(org_id, 'work_advisor') then
    raise exception 'Written advice is not included in your plan';
  end if;
  if not exists (select 1 from public.organization_settings s
                 where s.organization_id = org_id and s.advisor_enabled) then
    raise exception 'Written advice is switched off';
  end if;
  select s.advisor_salt into salt from public.organization_settings s where s.organization_id = org_id;
  return query
  select e.id, e.name,
         ('Person ' || row_number() over (order by encode(digest(e.id::text || salt, 'sha256'), 'hex')))::text
  from public.employees e
  where e.organization_id = org_id and e.is_active and e.auth_user_id is not null
    and (p_team is null or e.team_id = p_team)
    and public.can_view_employee(e.id);
end;
$$;

create function public.save_advisor_question(p_question text, p_answer text, p_team uuid default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid := public.my_organization_id();
  q text := btrim(p_question);
  a text := btrim(p_answer);
  id uuid;
begin
  if org_id is null or not public.is_manager_of(org_id) or not public.mfa_ok(org_id) then
    raise exception 'Not allowed';
  end if;
  if not public.org_has_feature(org_id, 'work_advisor') then
    raise exception 'Written advice is not included in your plan';
  end if;
  if not exists (select 1 from public.organization_settings s
                 where s.organization_id = org_id and s.advisor_enabled) then
    raise exception 'Written advice is switched off';
  end if;
  if p_team is not null and not public.can_manage_team(p_team) then
    raise exception 'Not allowed';
  end if;
  if q is null or length(q) > 800 or a is null or length(a) > 8000 then
    raise exception 'The question can be 800 characters and the answer 8000';
  end if;
  insert into public.advisor_questions (organization_id, asked_by, team_id, question, answer)
  values (org_id, public.my_employee_id(), p_team, q, a)
  returning advisor_questions.id into id;
  perform public.write_audit(org_id, 'advisor_question', 'organization', org_id::text,
    jsonb_build_object('question', left(q, 120)));
  return id;
end;
$$;

create function public.list_advisor_questions()
returns table (id uuid, question text, answer text, team_id uuid, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  org_id uuid := public.my_organization_id();
  me uuid := public.my_employee_id();
begin
  if org_id is null or not public.is_manager_of(org_id) then
    raise exception 'Not allowed';
  end if;
  return query
  select q.id, q.question, q.answer, q.team_id, q.created_at
  from public.advisor_questions q
  where q.organization_id = org_id
    and (public.is_org_wide_manager(org_id) or q.asked_by = me
         or (q.team_id is not null and public.can_manage_team(q.team_id)))
  order by q.created_at desc
  limit 30;
end;
$$;

create function public.list_coaching_notes()
returns table (id uuid, team_id uuid, team_name text, week_start date, body text, created_at timestamptz)
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
  return query
  select n.id, n.team_id, t.name, n.week_start, n.body, n.created_at
  from public.coaching_notes n
  left join public.teams t on t.id = n.team_id
  where n.organization_id = org_id
    and (public.is_org_wide_manager(org_id)
         or (n.team_id is not null and public.can_manage_team(n.team_id)))
  order by n.week_start desc, lower(coalesce(t.name, ''))
  limit 40;
end;
$$;

-- Figures for the weekly note. Names stay in "names"; "model" uses Person N only. Service role only.
create function public.advisor_pack(p_org uuid, p_team uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  salt text;
  result jsonb;
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 90 then
    raise exception 'Choose a period of at most 90 days';
  end if;
  select s.advisor_salt into salt from public.organization_settings s where s.organization_id = p_org;
  if salt is null then
    raise exception 'Unknown organisation';
  end if;
  with people as (
    select e.id, e.name, e.team_id,
           ('Person ' || row_number() over (order by encode(digest(e.id::text || salt, 'sha256'), 'hex')))::text as pseudo
    from public.employees e
    where e.organization_id = p_org and e.is_active and e.auth_user_id is not null
      and (p_team is null or e.team_id = p_team)
  ),
  usage as (
    select u.employee_id, u.day, u.app_name, u.active_seconds,
           public.category_of(p_org, p.team_id, u.app_name, nullif(u.domain, '')) as category
    from public.usage_between(p_org, p_from, p_to) u
    join people p on p.id = u.employee_id
  ),
  per_day as (
    select u.day,
           count(distinct u.employee_id) filter (where u.active_seconds > 0)::integer as people,
           round(sum(u.active_seconds)::numeric / 3600, 1) as active_hours,
           round(coalesce(sum(u.active_seconds) filter (where u.category = 'productive'), 0)::numeric / 3600, 1) as productive_hours
    from usage u
    group by u.day
  ),
  away as (
    select o.day, round(sum(o.productive_offline_seconds)::numeric / 3600, 1) as productive_away_hours
    from public.offline_day_seconds(p_org, p_from, p_to) o
    join people p on p.id = o.employee_id
    group by o.day
  ),
  load as (
    select p.pseudo, p.team_id,
           count(distinct u.day) filter (where u.active_seconds > 0)::integer as days,
           round(coalesce(sum(u.active_seconds), 0)::numeric / 3600, 1) as active_hours,
           round(coalesce(sum(u.active_seconds) filter (where u.category = 'productive'), 0)::numeric / 3600, 1) as productive_hours
    from people p
    left join usage u on u.employee_id = p.id
    group by p.pseudo, p.team_id
  ),
  scored as (
    select l.pseudo, l.days, l.active_hours, l.productive_hours,
           case when g.productive_hours is not null and l.days > 0
                then round(l.productive_hours / l.days / g.productive_hours * 100, 1) end as utilisation,
           case
             when g.productive_hours is null or l.days = 0 then 'no_goal'
             when l.productive_hours / l.days / g.productive_hours * 100 < g.under_percent then 'under'
             when l.productive_hours / l.days / g.productive_hours * 100 > g.over_percent then 'over'
             else 'healthy'
           end as status
    from load l
    left join lateral (
      select pg.productive_hours, pg.under_percent, pg.over_percent
      from public.productivity_goals pg
      where pg.organization_id = p_org and (pg.team_id = l.team_id or pg.team_id is null)
      order by (pg.team_id is not null) desc
      limit 1
    ) g on true
  ),
  apps as (
    select u.app_name as name,
           count(distinct u.employee_id) filter (where u.active_seconds > 0)::integer as users,
           round(sum(u.active_seconds)::numeric / 3600, 1) as hours
    from usage u
    where u.active_seconds > 0
    group by u.app_name
    order by sum(u.active_seconds) desc
    limit 8
  )
  select jsonb_build_object(
    'model', jsonb_build_object(
      'from', p_from, 'to', p_to,
      'team', (select t.name from public.teams t where t.id = p_team),
      'trend', coalesce((select jsonb_agg(jsonb_build_object(
                  'day', d.day, 'people', d.people, 'productive_hours', d.productive_hours,
                  'active_hours', d.active_hours,
                  'productive_away_hours', coalesce(a.productive_away_hours, 0)) order by d.day)
                from per_day d left join away a on a.day = d.day), '[]'::jsonb),
      'workload', coalesce((select jsonb_agg(jsonb_build_object(
                  'person', s.pseudo, 'days', s.days, 'productive_hours', s.productive_hours,
                  'active_hours', s.active_hours, 'utilisation', s.utilisation, 'status', s.status)
                  order by s.pseudo) from scored s), '[]'::jsonb),
      'software', coalesce((select jsonb_agg(jsonb_build_object(
                  'name', a.name, 'users', a.users, 'hours', a.hours) order by a.hours desc) from apps a), '[]'::jsonb)
    ),
    'names', coalesce((select jsonb_agg(jsonb_build_object('person', p.pseudo, 'name', p.name) order by p.pseudo)
                       from people p), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

create function public.coaching_queue()
returns table (organization_id uuid, team_id uuid, team_name text, timezone text,
               week_start date, week_end date, send_email boolean)
language sql
stable
security definer
set search_path = public
as $$
  with orgs as (
    select o.id, o.timezone, s.advisor_weekly_email as send_email,
           ((now() at time zone o.timezone)::date
             - extract(isodow from (now() at time zone o.timezone)::date)::int) as week_end
    from public.organizations o
    join public.organization_settings s on s.organization_id = o.id and s.advisor_enabled
    join public.subscriptions sub on sub.organization_id = o.id
    where public.org_has_feature(o.id, 'work_advisor')
      and public.subscription_level(sub) = 'full'
  ),
  targets as (
    select o.id, t.id as team_id, t.name as team_name, o.timezone, o.week_end - 6 as week_start, o.week_end, o.send_email
    from orgs o
    join public.teams t on t.organization_id = o.id
    union all
    select o.id, null::uuid, null::text, o.timezone, o.week_end - 6, o.week_end, o.send_email
    from orgs o
  )
  select t.id, t.team_id, t.team_name, t.timezone, t.week_start, t.week_end, t.send_email
  from targets t
  where not exists (
    select 1 from public.coaching_notes n
    where n.organization_id = t.id
      and n.team_id is not distinct from t.team_id
      and n.week_start = t.week_start);
$$;

create function public.save_coaching_note(p_org uuid, p_team uuid, p_week date, p_body text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_body is null or length(btrim(p_body)) = 0 or length(p_body) > 8000 then
    raise exception 'The note is empty or too long';
  end if;
  insert into public.coaching_notes (organization_id, team_id, week_start, body)
  values (p_org, p_team, p_week, btrim(p_body))
  on conflict (organization_id, coalesce(team_id, '00000000-0000-0000-0000-000000000000'::uuid), week_start)
  do update set body = excluded.body, created_at = now();
end;
$$;

create function public.coaching_recipients(p_org uuid, p_team uuid)
returns table (email text, name text)
language sql
stable
security definer
set search_path = public
as $$
  select m.email, m.name
  from public.employees m
  where m.organization_id = p_org and m.is_active and m.role in ('owner', 'manager')
    and m.email is not null
    and (m.role = 'owner'
         or not exists (select 1 from public.team_managers tm where tm.employee_id = m.id)
         or (p_team is not null and exists (
               select 1 from public.team_managers tm where tm.employee_id = m.id and tm.team_id = p_team)));
$$;

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
  n_places integer;
  n_advice integer;
  n_notes integer;
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
    delete from public.work_location_days
      where organization_id = s.organization_id
        and day < (now() - make_interval(days => s.retention_days))::date;
    get diagnostics n_places = row_count;
    delete from public.daily_summaries
      where organization_id = s.organization_id
        and day < (now() - make_interval(days => s.summary_retention_days))::date;
    get diagnostics n_summaries = row_count;
    delete from public.advisor_questions
      where organization_id = s.organization_id
        and created_at < now() - make_interval(days => s.summary_retention_days);
    get diagnostics n_advice = row_count;
    delete from public.coaching_notes
      where organization_id = s.organization_id
        and created_at < now() - make_interval(days => s.summary_retention_days);
    get diagnostics n_notes = row_count;
    n_advice := n_advice + n_notes;

    if n_segments + n_events + n_sessions + n_summaries + n_offline + n_places + n_advice > 0 then
      insert into public.audit_log (organization_id, action, target_type, details)
      values (s.organization_id, 'retention_purge', 'organization',
              jsonb_build_object('segments', n_segments, 'events', n_events,
                                 'sessions', n_sessions, 'summaries', n_summaries,
                                 'offline_entries', n_offline, 'work_location_days', n_places,
                                 'advice', n_advice, 'retention_days', s.retention_days));
    end if;
  end loop;
end;
$$;

alter table public.advisor_questions enable row level security;
alter table public.coaching_notes enable row level security;
revoke all on public.advisor_questions, public.coaching_notes from anon, authenticated;

revoke execute on function
  public.advisor_directory(uuid),
  public.save_advisor_question(text, text, uuid),
  public.list_advisor_questions(),
  public.list_coaching_notes(),
  public.advisor_pack(uuid, uuid, date, date),
  public.coaching_queue(),
  public.save_coaching_note(uuid, uuid, date, text),
  public.coaching_recipients(uuid, uuid)
from public, anon, authenticated;

grant execute on function
  public.advisor_directory(uuid),
  public.save_advisor_question(text, text, uuid),
  public.list_advisor_questions(),
  public.list_coaching_notes()
to authenticated;

grant execute on function
  public.advisor_pack(uuid, uuid, date, date),
  public.coaching_queue(),
  public.save_coaching_note(uuid, uuid, date, text),
  public.coaching_recipients(uuid, uuid)
to service_role;

notify pgrst, 'reload schema';
