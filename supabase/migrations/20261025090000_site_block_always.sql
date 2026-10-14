-- =============================================================================
-- Mycroscope: a restricted website stays blocked, including after hours and while paused.
-- Run after 20261024090000_site_block.sql.
-- =============================================================================

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
  select string_agg(pattern, ', ' order by pattern)
    into restricted_sites
    from public.alert_rules
    where organization_id = p_org and enabled and action = 'restrict' and kind = 'domain';
  if restricted_apps is not null then
    items := items || format(E'\n  - These programs are not allowed while Mycroscope is monitoring: %s. If one comes to the front, Mycroscope minimises it, shows a short notice, and tells your managers. This does not need administrator rights on the computer. It applies after you acknowledge this notice.', restricted_apps);
  end if;
  if restricted_sites is not null then
    items := items || format(E'\n  - These websites are not allowed: %s. Google Chrome and Microsoft Edge refuse them on this computer the whole time you are signed in to Mycroscope, including outside working hours and while tracking is paused. Other sites keep working. If this computer already uses its own web proxy, the site is not blocked and your managers are told if it is opened. This applies after you acknowledge this notice.', restricted_sites);
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


do $$
declare
  org uuid;
begin
  for org in
    select distinct organization_id from public.alert_rules
    where action = 'restrict' and kind = 'domain' and enabled
  loop
    perform public.publish_policy_internal(org, null);
  end loop;
end $$;

notify pgrst, 'reload schema';
