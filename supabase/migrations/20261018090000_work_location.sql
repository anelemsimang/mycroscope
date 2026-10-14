-- =============================================================================
-- Mycroscope: office versus remote days
--   * Managers register office networks (a public IP address or range, and/or a Wi-Fi name).
--   * The desktop app compares those with this PC and stores only the day's result:
--     office, remote or mixed, and which office. Home addresses and home network
--     names are never stored.
--   * A company, and optionally a team, can set how many office days a week they look for.
--     A day counts when the person was in an office for part of it. A week is judged only
--     when it is a full Monday-Sunday week inside the report and at least one day was recorded.
--   * Standard plans and up. Off until a manager turns it on, which publishes a new notice.
-- Run after 20261017090000_offline_time.sql.
-- =============================================================================

create or replace function public.plan_features(p_plan text)
returns text[]
language sql
immutable
as $$
  select case p_plan
    when 'standard' then array['team_categories', 'team_schedules', 'trends', 'alert_rules', 'channels', 'work_location']
    when 'business' then array['team_categories', 'team_schedules', 'trends', 'alert_rules', 'channels', 'work_location',
                               'goals', 'workload', 'software_usage', 'file_activity', 'api']
    when 'enterprise' then array['team_categories', 'team_schedules', 'trends', 'alert_rules', 'channels', 'work_location',
                                 'goals', 'workload', 'software_usage', 'file_activity', 'api']
    when 'trial' then array['team_categories', 'team_schedules', 'trends', 'alert_rules', 'channels', 'work_location',
                            'goals', 'workload', 'software_usage', 'file_activity', 'api']
    else array[]::text[]
  end;
$$;

alter table public.organization_settings
  add column track_work_location boolean not null default false,
  add column office_days_per_week integer check (office_days_per_week between 1 and 7);

alter table public.teams
  add column office_days_per_week integer check (office_days_per_week between 1 and 7);

-- A public network small enough to be one office. Private, link-local and huge ranges are rejected.
create function public.is_public_network(p_text text)
returns boolean
language plpgsql
immutable
as $$
declare
  n cidr;
begin
  n := btrim(p_text)::cidr;
  if family(n) = 4 then
    if masklen(n) < 16 then return false; end if;
    return not (
      n <<= '0.0.0.0/8'::cidr or n <<= '10.0.0.0/8' or n <<= '127.0.0.0/8'
      or n <<= '169.254.0.0/16' or n <<= '172.16.0.0/12' or n <<= '192.168.0.0/16'
      or n <<= '100.64.0.0/10' or n <<= '224.0.0.0/4' or n <<= '240.0.0.0/4');
  end if;
  if masklen(n) < 48 then return false; end if;
  return not (n <<= '::1/128'::cidr or n <<= 'fc00::/7' or n <<= 'fe80::/10' or n <<= 'ff00::/8');
exception when others then
  return false;
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
create table public.office_networks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 60),
  cidrs cidr[] not null default '{}',
  wifi_names text[] not null default '{}',
  created_at timestamptz not null default now(),
  constraint office_networks_has_a_signal check (cardinality(cidrs) > 0 or cardinality(wifi_names) > 0)
);
create unique index office_networks_name_key on public.office_networks (organization_id, lower(name));
create index office_networks_org_idx on public.office_networks (organization_id);

create table public.work_location_days (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  employee_id uuid not null references public.employees (id) on delete cascade,
  day date not null,
  saw_office boolean not null,
  saw_remote boolean not null,
  office_id uuid references public.office_networks (id) on delete set null,
  location text not null check (location in ('office', 'remote', 'mixed')),
  primary key (employee_id, day),
  constraint work_location_days_consistent check (
    (saw_office or saw_remote)
    and location = case when saw_office and saw_remote then 'mixed' when saw_office then 'office' else 'remote' end)
);
create index work_location_days_org_day_idx on public.work_location_days (organization_id, day);

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
       from public.teams t where t.organization_id = p_org and t.office_days_per_week is not null), '[]'::jsonb))
  from public.organization_settings s where s.organization_id = p_org;
$$;

create function public.republish_if_location(p_org uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.organization_settings
             where organization_id = p_org and track_work_location) then
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

create function public.save_office_network(p_id uuid, p_name text, p_cidrs text[], p_wifi text[])
returns public.office_networks
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid := public.my_organization_id();
  office_name text := btrim(p_name);
  nets cidr[] := '{}';
  names text[] := '{}';
  item text;
  result public.office_networks;
begin
  if org_id is null or not public.is_org_wide_manager(org_id) or not public.mfa_ok(org_id) then
    raise exception 'Not allowed';
  end if;
  if not public.org_has_feature(org_id, 'work_location') then
    raise exception 'Office and remote days are not included in your plan';
  end if;
  if office_name is null or length(office_name) > 60 then
    raise exception 'Give the office a name of up to 60 characters';
  end if;
  if p_cidrs is not null then
    foreach item in array p_cidrs loop
      if not public.is_public_network(item) then
        raise exception 'Enter a public IP address or range, such as 41.0.0.1 or 41.0.0.0/24';
      end if;
      nets := nets || btrim(item)::cidr;
    end loop;
  end if;
  if p_wifi is not null then
    foreach item in array p_wifi loop
      item := btrim(item);
      if item is null or item = '' then continue; end if;
      if length(item) > 32 then
        raise exception 'A Wi-Fi name can be at most 32 characters';
      end if;
      if not exists (select 1 from unnest(names) n where lower(n) = lower(item)) then
        names := names || item;
      end if;
    end loop;
  end if;
  if cardinality(nets) = 0 and cardinality(names) = 0 then
    raise exception 'Add the office public IP address or its Wi-Fi name';
  end if;
  if exists (select 1 from public.office_networks
             where organization_id = org_id and lower(name) = lower(office_name) and id is distinct from p_id) then
    raise exception 'An office with this name already exists';
  end if;
  if cardinality(nets) > 8 or cardinality(names) > 8 then
    raise exception 'An office can have at most 8 addresses and 8 Wi-Fi names';
  end if;
  if (select count(*) from public.office_networks where organization_id = org_id and id is distinct from p_id) >= 20 then
    raise exception 'A company can register at most 20 offices';
  end if;

  if p_id is null then
    insert into public.office_networks (organization_id, name, cidrs, wifi_names)
    values (org_id, office_name, nets, names) returning * into result;
  else
    update public.office_networks
    set name = office_name, cidrs = nets, wifi_names = names
    where id = p_id and organization_id = org_id
    returning * into result;
    if result.id is null then
      raise exception 'Unknown office';
    end if;
  end if;
  perform public.write_audit(org_id, 'office_saved', 'office_network', result.id::text,
    jsonb_build_object('name', result.name));
  perform public.republish_if_location(org_id);
  return result;
end;
$$;

create function public.delete_office_network(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid := public.my_organization_id();
  office_name text;
begin
  if org_id is null or not public.is_org_wide_manager(org_id) or not public.mfa_ok(org_id) then
    raise exception 'Not allowed';
  end if;
  delete from public.office_networks where id = p_id and organization_id = org_id returning name into office_name;
  if office_name is null then
    raise exception 'Unknown office';
  end if;
  perform public.write_audit(org_id, 'office_deleted', 'office_network', p_id::text,
    jsonb_build_object('name', office_name));
  perform public.republish_if_location(org_id);
end;
$$;

-- Null clears the team's own target, so the company number applies.
create function public.set_team_office_days(p_team uuid, p_days integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid := public.my_organization_id();
begin
  if p_team is null or not public.can_manage_team(p_team) then
    raise exception 'Not allowed';
  end if;
  if not public.org_has_feature(org_id, 'work_location') then
    raise exception 'Office and remote days are not included in your plan';
  end if;
  if p_days is not null and p_days not between 1 and 7 then
    raise exception 'Office days per week must be from 1 to 7, or empty when the team uses the company number';
  end if;
  update public.teams set office_days_per_week = p_days
  where id = p_team and organization_id = org_id;
  if not found then
    raise exception 'Unknown team';
  end if;
  perform public.write_audit(org_id, 'team_office_days', 'team', p_team::text,
    jsonb_build_object('days', p_days));
  perform public.republish_if_location(org_id);
end;
$$;

-- One observation from this PC. A later observation from another PC is combined:
-- office plus remote becomes mixed, and the office is kept when there was only one.
create function public.record_work_location(p_day date, p_office uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid := public.my_organization_id();
  emp uuid := public.my_employee_id();
  tz text;
  today date;
  sub public.subscriptions;
  result text;
begin
  if emp is null or org_id is null then
    raise exception 'Not allowed';
  end if;
  if not public.org_has_feature(org_id, 'work_location') then
    raise exception 'Not allowed';
  end if;
  if not exists (select 1 from public.organization_settings
                 where organization_id = org_id and track_work_location) then
    raise exception 'Not allowed';
  end if;
  select * into sub from public.subscriptions where organization_id = org_id;
  if public.subscription_level(sub) <> 'full' then
    raise exception 'Not allowed';
  end if;
  select timezone into tz from public.organizations where id = org_id;
  today := (now() at time zone tz)::date;
  if p_day is null or p_day > today or p_day < today - 1 then
    raise exception 'That day cannot be recorded';
  end if;
  if not public.has_consented_before(p_day::timestamp at time zone tz) then
    raise exception 'Not allowed';
  end if;
  if p_office is not null and not exists (
    select 1 from public.office_networks where id = p_office and organization_id = org_id) then
    raise exception 'Unknown office';
  end if;

  insert into public.work_location_days as w
    (organization_id, employee_id, day, saw_office, saw_remote, office_id, location)
  values (org_id, emp, p_day, p_office is not null, p_office is null, p_office,
          case when p_office is null then 'remote' else 'office' end)
  on conflict (employee_id, day) do update set
    saw_office = w.saw_office or excluded.saw_office,
    saw_remote = w.saw_remote or excluded.saw_remote,
    office_id = case
      when w.office_id is null then excluded.office_id
      when excluded.office_id is null then w.office_id
      when w.office_id = excluded.office_id then w.office_id
      else null end,
    location = case
      when (w.saw_office or excluded.saw_office) and (w.saw_remote or excluded.saw_remote) then 'mixed'
      when w.saw_office or excluded.saw_office then 'office'
      else 'remote' end
  returning location into result;
  return result;
end;
$$;

create function public.get_work_locations(p_employee uuid, p_from date, p_to date)
returns table (day date, location text, office_name text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.can_view_employee(p_employee) then
    raise exception 'Not allowed';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 93 then
    raise exception 'Choose a period of at most 93 days';
  end if;
  return query
  select w.day, w.location, n.name
  from public.work_location_days w
  left join public.office_networks n on n.id = w.office_id
  where w.employee_id = p_employee and w.day between p_from and p_to
  order by w.day desc;
end;
$$;

create function public.get_office_adherence(p_from date, p_to date, p_team uuid default null)
returns table (employee_id uuid, name text, team_name text, office_days integer, remote_days integer,
               mixed_days integer, target_per_week integer, weeks_judged integer, weeks_met integer)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  org_id uuid := public.require_analytics('work_location', p_from, p_to);
begin
  return query
  with emp as (
    select e.id, e.name as ename, t.name as tname,
           coalesce(t.office_days_per_week, s.office_days_per_week) as target
    from public.employees e
    left join public.teams t on t.id = e.team_id
    join public.organization_settings s on s.organization_id = e.organization_id
    where e.organization_id = org_id and e.is_active and e.auth_user_id is not null
      and (p_team is null or e.team_id = p_team)
      and public.can_view_employee(e.id)
  ),
  days as (
    select w.employee_id, w.day, w.location, date_trunc('week', w.day::timestamp)::date as wk
    from public.work_location_days w
    where w.organization_id = org_id and w.day between p_from and p_to
  ),
  full_weeks as (
    select g::date as wk
    from generate_series(date_trunc('week', p_from::timestamp), p_to::timestamp, interval '1 week') g
    where g::date >= p_from and g::date + 6 <= p_to
  ),
  per_week as (
    select d.employee_id, d.wk,
           count(*) filter (where d.location in ('office', 'mixed'))::integer as office_n
    from days d
    where d.wk in (select f.wk from full_weeks f)
    group by d.employee_id, d.wk
  )
  select e.id, e.ename, e.tname,
         (select count(*)::integer from days d where d.employee_id = e.id and d.location in ('office', 'mixed')),
         (select count(*)::integer from days d where d.employee_id = e.id and d.location = 'remote'),
         (select count(*)::integer from days d where d.employee_id = e.id and d.location = 'mixed'),
         e.target,
         (select count(*)::integer from per_week p where p.employee_id = e.id),
         case when e.target is null then null
              else (select count(*)::integer from per_week p
                    where p.employee_id = e.id and p.office_n >= e.target) end
  from emp e
  order by e.ename;
end;
$$;

-- -----------------------------------------------------------------------------
-- Retention. The day's result is kept with detailed activity.
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
  n_places integer;
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

    if n_segments + n_events + n_sessions + n_summaries + n_offline + n_places > 0 then
      insert into public.audit_log (organization_id, action, target_type, details)
      values (s.organization_id, 'retention_purge', 'organization',
              jsonb_build_object('segments', n_segments, 'events', n_events,
                                 'sessions', n_sessions, 'summaries', n_summaries,
                                 'offline_entries', n_offline, 'work_location_days', n_places,
                                 'retention_days', s.retention_days));
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
  places integer;
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
  delete from public.work_location_days
  where employee_id = p_employee
    and day between (p_from at time zone tz)::date and (p_to at time zone tz)::date;
  get diagnostics places = row_count;

  delete from public.daily_summaries
  where employee_id = p_employee
    and day between (p_from at time zone tz)::date and (p_to at time zone tz)::date;
  delete from public.daily_usage
  where employee_id = p_employee
    and day between (p_from at time zone tz)::date and (p_to at time zone tz)::date;

  perform public.write_audit(emp.organization_id, 'activity_deleted', 'employee', emp.id::text,
    jsonb_build_object('from', p_from, 'to', p_to, 'segments', removed, 'file_events', files,
                       'offline_entries', offline, 'work_location_days', places, 'reason', p_reason));
  return removed;
end;
$$;

-- -----------------------------------------------------------------------------
-- Row level security and privileges
-- -----------------------------------------------------------------------------
alter table public.office_networks enable row level security;
alter table public.work_location_days enable row level security;

create policy office_networks_select on public.office_networks for select to authenticated
  using (public.is_manager_of(organization_id));

revoke all on public.office_networks from anon;
revoke insert, update, delete, truncate on public.office_networks from authenticated;

revoke all on public.work_location_days from anon, authenticated;

revoke execute on function
  public.is_public_network(text),
  public.republish_if_location(uuid),
  public.save_office_network(uuid, text, text[], text[]),
  public.delete_office_network(uuid),
  public.set_team_office_days(uuid, integer),
  public.record_work_location(date, uuid),
  public.get_work_locations(uuid, date, date),
  public.get_office_adherence(date, date, uuid)
from public, anon;

revoke execute on function
  public.is_public_network(text),
  public.republish_if_location(uuid)
from authenticated;

grant execute on function
  public.save_office_network(uuid, text, text[], text[]),
  public.delete_office_network(uuid),
  public.set_team_office_days(uuid, integer),
  public.record_work_location(date, uuid),
  public.get_work_locations(uuid, date, date),
  public.get_office_adherence(date, date, uuid)
to authenticated;

notify pgrst, 'reload schema';
