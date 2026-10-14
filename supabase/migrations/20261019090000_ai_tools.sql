-- =============================================================================
-- Mycroscope: AI tool adoption
--   * Operators keep a list of AI tools, matched by website and app name.
--   * Each company marks a tool approved, not approved, or not reviewed.
--   * Insights shows how many people used each tool, how often, and a before/after
--     comparison of productive computer time. That comparison is a correlation, not proof.
--   * Optional alert when someone uses a tool the company marked as not approved.
--   * Business plans and up. The report uses activity already recorded.
-- Run after 20261018090000_work_location.sql.
-- =============================================================================

create or replace function public.plan_features(p_plan text)
returns text[]
language sql
immutable
as $$
  select case p_plan
    when 'standard' then array['team_categories', 'team_schedules', 'trends', 'alert_rules', 'channels', 'work_location']
    when 'business' then array['team_categories', 'team_schedules', 'trends', 'alert_rules', 'channels', 'work_location', 'ai_tools',
                               'goals', 'workload', 'software_usage', 'file_activity', 'api']
    when 'enterprise' then array['team_categories', 'team_schedules', 'trends', 'alert_rules', 'channels', 'work_location', 'ai_tools',
                                 'goals', 'workload', 'software_usage', 'file_activity', 'api']
    when 'trial' then array['team_categories', 'team_schedules', 'trends', 'alert_rules', 'channels', 'work_location', 'ai_tools',
                            'goals', 'workload', 'software_usage', 'file_activity', 'api']
    else array[]::text[]
  end;
$$;

alter table public.organization_settings
  add column alert_unapproved_ai boolean not null default false;

create table public.ai_tools (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 60),
  domains text[] not null default '{}',
  app_names text[] not null default '{}',
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index ai_tools_name_key on public.ai_tools (lower(name));

create table public.ai_tool_approvals (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  tool_id uuid not null references public.ai_tools (id) on delete cascade,
  approved boolean not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.employees (id) on delete set null,
  primary key (organization_id, tool_id)
);

-- A website matches the tool's domain or a subdomain of it. An app matches the name exactly.
create function public.ai_tool_matches(p_domain text, p_app text, p_domains text[], p_apps text[])
returns boolean
language sql
immutable
as $$
  select exists (
    select 1 from unnest(coalesce(p_domains, '{}')) d
    where d <> '' and (
      lower(coalesce(p_domain, '')) = lower(d)
      or lower(coalesce(p_domain, '')) like ('%.' || lower(d)))
  ) or exists (
    select 1 from unnest(coalesce(p_apps, '{}')) a
    where a <> '' and lower(coalesce(p_app, '')) = lower(a)
  );
$$;

insert into public.ai_tools (name, domains, app_names) values
  ('ChatGPT', array['chatgpt.com', 'chat.openai.com'], array['ChatGPT']),
  ('Claude', array['claude.ai'], array['Claude']),
  ('Gemini', array['gemini.google.com'], array['Gemini']),
  ('Microsoft Copilot', array['copilot.microsoft.com'], array['Copilot']),
  ('Perplexity', array['perplexity.ai'], array['Perplexity']);

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


create or replace function public.org_alerts(p_org uuid, p_since timestamptz, p_by_received boolean default false)
returns table (employee_id uuid, employee_name text, occurred_at timestamptz, received_at timestamptz,
               kind text, severity text, details jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select e.id, e.name, ev.occurred_at, ev.received_at, ev.event_type,
         case
           when ev.event_type = 'agent_gap' and coalesce((ev.details ->> 'minutes')::numeric, 0) >= 10 then 'high'
           when ev.event_type = 'agent_uninstalled' then 'high'
           when ev.event_type in ('agent_gap', 'vm_detected', 'remote_session', 'input_anomaly',
                                  'unattended_use', 'tracking_late')
             then 'medium'
           else 'low'
         end,
         ev.details
  from public.agent_events ev
  join public.employees e on e.id = ev.employee_id
  where ev.organization_id = p_org
    and (case when p_by_received then ev.received_at else ev.occurred_at end) >= p_since
    and ev.event_type in ('agent_gap', 'vm_detected', 'remote_session', 'input_anomaly', 'clock_skew',
                          'after_hours_use', 'unattended_use', 'tracking_late', 'agent_uninstalled')
  union all
  select e.id, e.name, min(v.occurred_at), max(v.detected_at), 'policy_violation', r.severity,
         jsonb_build_object('rule', r.name, 'rule_kind', r.kind, 'seconds', sum(v.seconds),
                            'matched', to_jsonb((array_agg(distinct v.matched))[1:3]))
  from public.policy_violations v
  join public.alert_rules r on r.id = v.rule_id
  join public.employees e on e.id = v.employee_id
  where v.organization_id = p_org
    and (case when p_by_received then v.detected_at else v.occurred_at end) >= p_since
  group by e.id, e.name, r.id, r.name, r.kind, r.severity, date_trunc('hour', v.occurred_at)
  union all
  select e.id, e.name, f.occurred_at, f.received_at, 'device_connected', 'medium',
         jsonb_build_object('destination', f.destination, 'label', f.label)
  from public.file_events f
  join public.employees e on e.id = f.employee_id
  where f.organization_id = p_org and f.event_type in ('drive_connected', 'phone_connected')
    and (case when p_by_received then f.received_at else f.occurred_at end) >= p_since
  union all
  select g.employee_id, g.name, g.first_at, g.last_received, 'files_copied',
         case when g.large and g.destination = 'removable' then 'high' else 'medium' end,
         jsonb_build_object('destination', g.destination, 'label', g.label, 'files', g.files, 'bytes', g.bytes,
                            'large', g.large)
  from (
    select e.id as employee_id, e.name, f.destination, f.label, min(f.occurred_at) as first_at,
           max(f.received_at) as last_received, sum(f.file_count)::integer as files,
           coalesce(sum(f.size_bytes), 0)::bigint as bytes,
           (sum(f.file_count) >= 50 or coalesce(sum(f.size_bytes), 0) >= 500 * 1024 * 1024) as large
    from public.file_events f
    join public.employees e on e.id = f.employee_id
    where f.organization_id = p_org and f.event_type = 'file_copied'
      and (case when p_by_received then f.received_at else f.occurred_at end) >= p_since
    group by e.id, e.name, f.destination, f.label, date_trunc('hour', f.occurred_at)
  ) g
  -- Cloud folders and network drives are part of normal work; only unusually large copies are alerts.
  where g.destination = 'removable' or g.large
  union all
  select e.id, e.name,
         (u.day::timestamp at time zone o.timezone),
         (u.day::timestamp at time zone o.timezone),
         'unapproved_ai', 'medium',
         jsonb_build_object('tool', u.tool_name, 'seconds', u.active_seconds)
  from (
    select du.employee_id, du.day, t.name as tool_name, sum(du.active_seconds)::integer as active_seconds
    from public.daily_usage du
    join public.ai_tools t on t.enabled and public.ai_tool_matches(du.domain, du.app_name, t.domains, t.app_names)
    join public.ai_tool_approvals ap on ap.organization_id = du.organization_id and ap.tool_id = t.id and not ap.approved
    join public.organization_settings s on s.organization_id = du.organization_id and s.alert_unapproved_ai
    join public.organizations o2 on o2.id = du.organization_id
    where du.organization_id = p_org and du.active_seconds > 0
      and public.org_has_feature(p_org, 'ai_tools')
      and du.day >= (p_since at time zone o2.timezone)::date
    group by du.employee_id, du.day, t.name
  ) u
  join public.employees e on e.id = u.employee_id
  join public.organizations o on o.id = p_org
  union all
  select e.id, e.name, st.last_seen_at, null::timestamptz, 'not_reporting', 'low',
         jsonb_build_object('last_state', st.state, 'minutes', round(extract(epoch from now() - st.last_seen_at) / 60))
  from public.employees e
  join public.agent_status st on st.employee_id = e.id
  where not p_by_received
    and e.organization_id = p_org and e.is_active and e.auth_user_id is not null
    and public.is_employee_work_time(e.id, now())
    and st.last_seen_at < now() - interval '30 minutes'
    and st.last_seen_at > now() - interval '7 days';
$$;

create function public.op_save_ai_tool(
  p_id uuid, p_name text, p_domains text[], p_apps text[], p_enabled boolean)
returns public.ai_tools
language plpgsql
security definer
set search_path = public
as $$
declare
  tool_name text := btrim(p_name);
  domains text[] := '{}';
  apps text[] := '{}';
  item text;
  result public.ai_tools;
begin
  perform public.require_platform_admin();
  if tool_name is null or length(tool_name) > 60 then
    raise exception 'Give the tool a name of up to 60 characters';
  end if;
  if p_domains is not null then
    foreach item in array p_domains loop
      item := lower(btrim(item));
      if item is null or item = '' then continue; end if;
      if item !~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)+$' then
        raise exception 'Enter a website like claude.ai, without https://';
      end if;
      if not exists (select 1 from unnest(domains) d where d = item) then
        domains := domains || item;
      end if;
    end loop;
  end if;
  if p_apps is not null then
    foreach item in array p_apps loop
      item := btrim(item);
      if item is null or item = '' then continue; end if;
      if length(item) > 80 then
        raise exception 'An app name can be at most 80 characters';
      end if;
      if not exists (select 1 from unnest(apps) a where lower(a) = lower(item)) then
        apps := apps || item;
      end if;
    end loop;
  end if;
  if cardinality(domains) = 0 and cardinality(apps) = 0 then
    raise exception 'Add a website or an app name';
  end if;
  if cardinality(domains) > 12 or cardinality(apps) > 8 then
    raise exception 'A tool can have at most 12 websites and 8 app names';
  end if;
  if exists (select 1 from public.ai_tools where lower(name) = lower(tool_name) and id is distinct from p_id) then
    raise exception 'A tool with this name already exists';
  end if;
  if p_id is null then
    insert into public.ai_tools (name, domains, app_names, enabled)
    values (tool_name, domains, apps, coalesce(p_enabled, true))
    returning * into result;
  else
    update public.ai_tools
    set name = tool_name, domains = domains, app_names = apps, enabled = coalesce(p_enabled, enabled)
    where id = p_id
    returning * into result;
    if result.id is null then
      raise exception 'Unknown tool';
    end if;
  end if;
  perform public.write_operator_audit('ai_tool_saved', null, jsonb_build_object('tool', result.name, 'enabled', result.enabled));
  return result;
end;
$$;

create function public.op_ai_tools()
returns table (id uuid, name text, domains text[], app_names text[], enabled boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.require_platform_admin();
  return query
  select t.id, t.name, t.domains, t.app_names, t.enabled
  from public.ai_tools t
  order by lower(t.name);
end;
$$;

create function public.get_ai_catalog()
returns table (id uuid, name text, domains text[], app_names text[], approved boolean)
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
  if not public.org_has_feature(org_id, 'ai_tools') then
    raise exception 'AI tool reports are not included in your plan';
  end if;
  return query
  select t.id, t.name, t.domains, t.app_names, a.approved
  from public.ai_tools t
  left join public.ai_tool_approvals a on a.tool_id = t.id and a.organization_id = org_id
  where t.enabled
  order by lower(t.name);
end;
$$;

-- p_status is approved, unapproved, or unset (no decision, and no alert).
create function public.set_ai_tool_approval(p_tool uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid := public.my_organization_id();
begin
  if org_id is null or not public.is_org_wide_manager(org_id) or not public.mfa_ok(org_id) then
    raise exception 'Not allowed';
  end if;
  if not public.org_has_feature(org_id, 'ai_tools') then
    raise exception 'AI tool reports are not included in your plan';
  end if;
  if p_status not in ('approved', 'unapproved', 'unset') then
    raise exception 'Choose approved, not approved, or no decision';
  end if;
  if not exists (select 1 from public.ai_tools where id = p_tool and enabled) then
    raise exception 'Unknown tool';
  end if;
  if p_status = 'unset' then
    delete from public.ai_tool_approvals where organization_id = org_id and tool_id = p_tool;
  else
    insert into public.ai_tool_approvals (organization_id, tool_id, approved, updated_by)
    values (org_id, p_tool, p_status = 'approved', public.my_employee_id())
    on conflict (organization_id, tool_id) do update
      set approved = excluded.approved, updated_at = now(), updated_by = excluded.updated_by;
  end if;
  perform public.write_audit(org_id, 'ai_tool_approval', 'ai_tool', p_tool::text,
    jsonb_build_object('status', p_status));
end;
$$;

create function public.get_ai_adoption(p_from date, p_to date, p_team uuid default null)
returns table (tool_id uuid, tool_name text, approved boolean, people_using integer, people integer)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  org_id uuid := public.require_analytics('ai_tools', p_from, p_to);
begin
  return query
  with people as (
    select e.id
    from public.employees e
    where e.organization_id = org_id and e.is_active and e.auth_user_id is not null
      and (p_team is null or e.team_id = p_team)
      and public.can_view_employee(e.id)
  ),
  used as (
    select t.id as tool_id, du.employee_id
    from public.daily_usage du
    join public.ai_tools t on t.enabled and public.ai_tool_matches(du.domain, du.app_name, t.domains, t.app_names)
    where du.organization_id = org_id and du.day between p_from and p_to and du.active_seconds > 0
      and du.employee_id in (select p.id from people p)
    group by t.id, du.employee_id
  )
  select t.id, t.name, a.approved,
         (select count(distinct u.employee_id)::integer from used u where u.tool_id = t.id),
         (select count(*)::integer from people)
  from public.ai_tools t
  left join public.ai_tool_approvals a on a.tool_id = t.id and a.organization_id = org_id
  where t.enabled
  order by lower(t.name);
end;
$$;

-- days_per_week is days used divided into the length of the period.
-- before/after is average productive computer hours per day worked, for 28 days either side of
-- the person's first use, and only when both sides have at least 5 such days. It is a correlation.
create function public.get_ai_person_usage(p_from date, p_to date, p_team uuid default null)
returns table (employee_id uuid, name text, tool_id uuid, tool_name text, days_used integer,
               days_per_week numeric, level text, before_hours numeric, after_hours numeric,
               before_days integer, after_days integer)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  org_id uuid := public.require_analytics('ai_tools', p_from, p_to);
  span numeric := greatest(p_to - p_from + 1, 1);
begin
  return query
  with people as (
    select e.id, e.name as ename
    from public.employees e
    where e.organization_id = org_id and e.is_active and e.auth_user_id is not null
      and (p_team is null or e.team_id = p_team)
      and public.can_view_employee(e.id)
  ),
  hits as (
    select du.employee_id, t.id as tool_id, t.name as tool_name, du.day
    from public.daily_usage du
    join public.ai_tools t on t.enabled and public.ai_tool_matches(du.domain, du.app_name, t.domains, t.app_names)
    where du.organization_id = org_id and du.active_seconds > 0
      and du.employee_id in (select p.id from people p)
  ),
  in_range as (
    select h.employee_id, h.tool_id, h.tool_name, count(distinct h.day)::integer as days
    from hits h
    where h.day between p_from and p_to
    group by h.employee_id, h.tool_id, h.tool_name
  ),
  firsts as (
    select h.employee_id, h.tool_id, min(h.day) as first_day
    from hits h
    group by h.employee_id, h.tool_id
  ),
  work as (
    select d.employee_id, d.day, d.productive_seconds
    from public.person_days(org_id, p_team, null, p_from - 28, p_to + 27) d
    where d.active_seconds > 0
  )
  select p.id, p.ename, r.tool_id, r.tool_name, r.days,
         round(r.days::numeric / span * 7, 1),
         case when r.days::numeric / span * 7 >= 2 then 'consistent' else 'occasional' end,
         case when b.days >= 5 and f.days >= 5 then round(b.hours, 2) end,
         case when b.days >= 5 and f.days >= 5 then round(f.hours, 2) end,
         case when b.days >= 5 and f.days >= 5 then b.days end,
         case when b.days >= 5 and f.days >= 5 then f.days end
  from in_range r
  join people p on p.id = r.employee_id
  join firsts s on s.employee_id = r.employee_id and s.tool_id = r.tool_id
  left join lateral (
    select count(*)::integer as days, avg(w.productive_seconds)::numeric / 3600 as hours
    from work w
    where w.employee_id = r.employee_id and s.first_day between p_from and p_to
      and w.day >= s.first_day - 28 and w.day < s.first_day
  ) b on true
  left join lateral (
    select count(*)::integer as days, avg(w.productive_seconds)::numeric / 3600 as hours
    from work w
    where w.employee_id = r.employee_id and s.first_day between p_from and p_to
      and w.day >= s.first_day and w.day < s.first_day + 28
  ) f on true
  order by p.ename, lower(r.tool_name);
end;
$$;

create function public.op_delete_ai_tool(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  tool_name text;
begin
  perform public.require_platform_admin();
  delete from public.ai_tools where id = p_id returning name into tool_name;
  if tool_name is null then
    raise exception 'Unknown tool';
  end if;
  perform public.write_operator_audit('ai_tool_deleted', null, jsonb_build_object('tool', tool_name));
end;
$$;

alter table public.ai_tools enable row level security;
alter table public.ai_tool_approvals enable row level security;
revoke all on public.ai_tools, public.ai_tool_approvals from anon, authenticated;

revoke execute on function
  public.ai_tool_matches(text, text, text[], text[]),
  public.op_save_ai_tool(uuid, text, text[], text[], boolean),
  public.op_delete_ai_tool(uuid),
  public.op_ai_tools(),
  public.get_ai_catalog(),
  public.set_ai_tool_approval(uuid, text),
  public.get_ai_adoption(date, date, uuid),
  public.get_ai_person_usage(date, date, uuid)
from public, anon;

revoke execute on function public.ai_tool_matches(text, text, text[], text[]) from authenticated;

grant execute on function
  public.op_save_ai_tool(uuid, text, text[], text[], boolean),
  public.op_delete_ai_tool(uuid),
  public.op_ai_tools(),
  public.get_ai_catalog(),
  public.set_ai_tool_approval(uuid, text),
  public.get_ai_adoption(date, date, uuid),
  public.get_ai_person_usage(date, date, uuid)
to authenticated;

notify pgrst, 'reload schema';

