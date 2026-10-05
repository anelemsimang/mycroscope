-- The monitoring notice now explains the sign-in reminder and the "used without signing in" alert
-- (20261009090000_unattended_use.sql), and every organisation gets a new notice version.
-- Settings do not change, so tracking carries on; employees are asked to acknowledge the new version.

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

revoke execute on function public.render_monitoring_notice(uuid) from public, anon;

do $$
declare
  org record;
begin
  for org in select id from public.organizations loop
    perform public.publish_policy_internal(org.id, null);
  end loop;
end;
$$;
