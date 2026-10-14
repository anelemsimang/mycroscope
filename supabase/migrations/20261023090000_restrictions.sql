-- =============================================================================
-- Mycroscope: a rule can restrict a program or name a website.
--   * Programs: the desktop app minimises them and shows a short notice.
--   * Websites: an alert is recorded. The site is not blocked.
--   * The employee notice names them, and a new restriction waits for acknowledgement.
-- Run after 20261022090000_report_templates.sql.
-- =============================================================================

alter table public.alert_rules
  add column action text not null default 'alert' check (action in ('alert', 'restrict'));

create or replace function public.policy_settings_snapshot(p_org uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select (to_jsonb(s) - 'updated_by') || jsonb_build_object(
    'schedules', coalesce(
      (select jsonb_agg(jsonb_build_object('team_id', w.team_id, 'employee_id', w.employee_id, 'work_days', w.work_days,
                                           'work_start', w.work_start, 'work_end', w.work_end)
                        order by w.team_id, w.employee_id)
       from public.work_schedules w where w.organization_id = p_org), '[]'::jsonb),
    'office_networks', coalesce(
      (select jsonb_agg(jsonb_build_object('id', n.id, 'name', n.name, 'cidrs', n.cidrs, 'wifi_names', n.wifi_names)
                        order by lower(n.name))
       from public.office_networks n where n.organization_id = p_org), '[]'::jsonb),
    'team_office_days', coalesce(
      (select jsonb_agg(jsonb_build_object('team_id', t.id, 'days', t.office_days_per_week) order by lower(t.name))
       from public.teams t where t.organization_id = p_org and t.office_days_per_week is not null), '[]'::jsonb),
    'restrictions', coalesce(
      (select jsonb_agg(jsonb_build_object('kind', r.kind, 'pattern', r.pattern, 'work_hours_only', r.work_hours_only)
                        order by r.kind, r.pattern)
       from public.alert_rules r
       where r.organization_id = p_org and r.enabled and r.action = 'restrict'), '[]'::jsonb))
  from public.organization_settings s where s.organization_id = p_org;
$$;

drop function public.save_alert_rule(uuid, text, text, text, text, boolean, boolean);

create function public.save_alert_rule(
  p_id uuid, p_name text, p_kind text, p_pattern text, p_severity text,
  p_work_hours_only boolean, p_enabled boolean, p_action text default 'alert')
returns public.alert_rules
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid := public.require_rule_manager();
  norm text := public.normalise_rule_pattern(p_kind, p_pattern);
  result public.alert_rules;
  act text := coalesce(p_action, 'alert');
begin
  if p_kind not in ('domain', 'app') then
    raise exception 'Choose a website or an app';
  end if;
  if norm = '' or norm = '*' or length(norm) > 200 then
    raise exception 'Enter the website or app to watch for';
  end if;
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'Give the rule a name';
  end if;
  if coalesce(p_severity, '') not in ('low', 'medium', 'high') then
    raise exception 'Invalid severity';
  end if;
  if act not in ('alert', 'restrict') then
    raise exception 'Alert or restrict';
  end if;
  if p_id is null then
    if (select count(*) from public.alert_rules where organization_id = org_id) >= 500 then
      raise exception 'A company can have at most 500 alert rules';
    end if;
    insert into public.alert_rules (organization_id, name, kind, pattern, severity, work_hours_only, enabled, action, created_by)
    values (org_id, btrim(p_name), p_kind, norm, p_severity, coalesce(p_work_hours_only, false),
            coalesce(p_enabled, true), act, public.my_employee_id())
    returning * into result;
  else
    update public.alert_rules
    set name = btrim(p_name), kind = p_kind, pattern = norm, severity = p_severity,
        work_hours_only = coalesce(p_work_hours_only, false), enabled = coalesce(p_enabled, true),
        action = act, updated_at = now()
    where id = p_id and organization_id = org_id
    returning * into result;
    if result.id is null then
      raise exception 'Rule not found';
    end if;
  end if;
  perform public.write_audit(org_id, 'alert_rule_saved', 'alert_rule', result.id::text,
    jsonb_build_object('name', result.name, 'kind', result.kind, 'pattern', result.pattern,
                       'severity', result.severity, 'enabled', result.enabled, 'action', result.action));
  return result;
exception when unique_violation then
  raise exception 'There is already a rule for %', norm;
end;
$$;

create function public.republish_restrictions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if old.action = 'restrict' then
      perform public.publish_policy_internal(old.organization_id, public.my_employee_id());
    end if;
    return old;
  elsif tg_op = 'UPDATE' then
    if new.action = 'restrict' or old.action = 'restrict' then
      perform public.publish_policy_internal(new.organization_id, public.my_employee_id());
    end if;
  elsif new.action = 'restrict' then
    perform public.publish_policy_internal(new.organization_id, public.my_employee_id());
  end if;
  return new;
end;
$$;

create trigger alert_rules_restrictions
  after insert or update or delete on public.alert_rules
  for each row execute function public.republish_restrictions();

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
  restricted_apps text;
  restricted_sites text;
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
    items := items || E'\n  - Written reports for your managers. A manager can produce a short report for a period, and a weekly report is written for each team, from totals Mycroscope already stores: productive time, goals, and which apps were open. The report names the people it describes. It is written inside Mycroscope. Nothing is sent to another company, and pay figures are left out.';
  end if;

  select string_agg(pattern || case when work_hours_only then ' (working hours only)' else '' end, ', ' order by pattern)
    into restricted_apps
    from public.alert_rules
    where organization_id = p_org and enabled and action = 'restrict' and kind = 'app';
  select string_agg(pattern || case when work_hours_only then ' (working hours only)' else '' end, ', ' order by pattern)
    into restricted_sites
    from public.alert_rules
    where organization_id = p_org and enabled and action = 'restrict' and kind = 'domain';
  if restricted_apps is not null then
    items := items || format(E'\n  - These programs are not allowed while Mycroscope is monitoring: %s. If one comes to the front, Mycroscope minimises it, shows a short notice, and tells your managers. This does not need administrator rights on the computer. It applies after you acknowledge this notice.', restricted_apps);
  end if;
  if restricted_sites is not null then
    items := items || format(E'\n  - These websites are not allowed: %s. If one is opened, your managers are told. Mycroscope does not block the website.', restricted_sites);
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
         jsonb_build_object('rule', r.name, 'rule_kind', r.kind, 'action', r.action, 'seconds', sum(v.seconds),
                            'matched', to_jsonb((array_agg(distinct v.matched))[1:3]))
  from public.policy_violations v
  join public.alert_rules r on r.id = v.rule_id
  join public.employees e on e.id = v.employee_id
  where v.organization_id = p_org
    and (case when p_by_received then v.detected_at else v.occurred_at end) >= p_since
  group by e.id, e.name, r.id, r.name, r.kind, r.action, r.severity, date_trunc('hour', v.occurred_at)
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


revoke execute on function public.save_alert_rule(uuid, text, text, text, text, boolean, boolean, text) from public, anon;
grant execute on function public.save_alert_rule(uuid, text, text, text, text, boolean, boolean, text) to authenticated;
revoke execute on function public.republish_restrictions() from public, anon, authenticated;

notify pgrst, 'reload schema';
