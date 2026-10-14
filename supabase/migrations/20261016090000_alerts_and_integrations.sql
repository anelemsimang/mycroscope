-- =============================================================================
-- Mycroscope: alerts and integrations
--   * alert_rules + policy_violations: the company's own alarms on websites and apps, matched on the server
--     against incoming activity (the desktop app does not need to change and cannot skip them)
--   * file_events: USB drives, external disks and phones connected; names and sizes of files copied to
--     removable drives, cloud sync folders and network drives. Never file contents. Readable only through
--     get_file_activity, which records every view in the audit log.
--   * org_alerts: one alert feed (integrity, policy, file activity) for the app, the emails and the channels
--   * notification_channels: Slack, Microsoft Teams and signed webhooks (URLs are never returned to the app)
--   * api_keys: read-only REST access for one company (see supabase/functions/api)
-- Run after 20261015090000_workforce_analytics.sql.
-- =============================================================================

create or replace function public.plan_features(p_plan text)
returns text[]
language sql
immutable
as $$
  select case p_plan
    when 'standard' then array['team_categories', 'team_schedules', 'trends', 'alert_rules', 'channels']
    when 'business' then array['team_categories', 'team_schedules', 'trends', 'alert_rules', 'channels',
                               'goals', 'workload', 'software_usage', 'file_activity', 'api']
    when 'enterprise' then array['team_categories', 'team_schedules', 'trends', 'alert_rules', 'channels',
                                 'goals', 'workload', 'software_usage', 'file_activity', 'api']
    when 'trial' then array['team_categories', 'team_schedules', 'trends', 'alert_rules', 'channels',
                            'goals', 'workload', 'software_usage', 'file_activity', 'api']
    else array[]::text[]
  end;
$$;

create or replace function public.severity_rank(p_severity text)
returns integer
language sql
immutable
as $$
  select case p_severity when 'high' then 3 when 'medium' then 2 when 'low' then 1 else 0 end;
$$;

-- -----------------------------------------------------------------------------
-- Settings: file activity (all off by default; each one changes the monitoring notice)
-- -----------------------------------------------------------------------------
alter table public.organization_settings
  add column detect_removable_media boolean not null default false,
  add column detect_cloud_sync boolean not null default false,
  add column detect_network_drives boolean not null default false,
  add column file_retention_days integer not null default 30 check (file_retention_days between 7 and 365);

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
-- File activity
-- -----------------------------------------------------------------------------
create table public.file_events (
  id uuid primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  employee_id uuid not null references public.employees (id) on delete cascade,
  device_id uuid references public.devices (id) on delete set null,
  occurred_at timestamptz not null,
  event_type text not null check (event_type in ('drive_connected', 'phone_connected', 'file_copied')),
  destination text not null check (destination in ('removable', 'phone', 'cloud', 'network')),
  -- Drive label, phone name, cloud service ("OneDrive") or network share.
  label text check (length(label) <= 200),
  -- Null on a summary row (file_count > 1) written when many files were copied at once.
  file_name text check (length(file_name) <= 260),
  file_count integer not null default 1 check (file_count between 1 and 1000000),
  size_bytes bigint check (size_bytes >= 0),
  received_at timestamptz not null default now(),
  constraint file_events_destination check (
    (event_type = 'drive_connected' and destination = 'removable')
    or (event_type = 'phone_connected' and destination = 'phone')
    or (event_type = 'file_copied' and destination in ('removable', 'cloud', 'network')))
);
create index file_events_employee_time_idx on public.file_events (employee_id, occurred_at desc);
create index file_events_org_received_idx on public.file_events (organization_id, received_at);

-- Used by the insert policy: the signed-in person's company has this kind of detection switched on.
create or replace function public.file_detection_on(p_destination text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select case p_destination
             when 'removable' then s.detect_removable_media
             when 'phone' then s.detect_removable_media
             when 'cloud' then s.detect_cloud_sync
             when 'network' then s.detect_network_drives
             else false
           end
    from public.organization_settings s where s.organization_id = public.my_organization_id()), false);
$$;

-- Owners and managers who can see the person, or the person themselves. Every view by someone else is audited.
create or replace function public.get_file_activity(p_employee uuid, p_from timestamptz, p_to timestamptz)
returns table (id uuid, occurred_at timestamptz, event_type text, destination text, label text, file_name text,
               file_count integer, size_bytes bigint, hostname text)
language plpgsql
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
  if emp.id <> public.my_employee_id() then
    perform public.write_audit(emp.organization_id, 'file_activity_viewed', 'employee', emp.id::text,
      jsonb_build_object('from', p_from, 'to', p_to));
  end if;
  return query
    select f.id, f.occurred_at, f.event_type, f.destination, f.label, f.file_name, f.file_count, f.size_bytes,
           d.hostname
    from public.file_events f
    left join public.devices d on d.id = f.device_id
    where f.employee_id = emp.id and f.occurred_at >= p_from and f.occurred_at < p_to
    order by f.occurred_at desc
    limit 2000;
end;
$$;

-- -----------------------------------------------------------------------------
-- Alert rules (policy alarms), matched on the server
-- -----------------------------------------------------------------------------
create table public.alert_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 100),
  kind text not null check (kind in ('domain', 'app')),
  -- Lower case. Websites match the domain and its subdomains; * matches anything. Apps match the
  -- application name or the program file (with or without .exe).
  pattern text not null check (length(pattern) between 1 and 200 and pattern = lower(btrim(pattern))),
  severity text not null default 'medium' check (severity in ('low', 'medium', 'high')),
  work_hours_only boolean not null default false,
  enabled boolean not null default true,
  pack text,
  created_by uuid references public.employees (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint alert_rules_key unique (organization_id, kind, pattern)
);

create table public.policy_violations (
  segment_id uuid not null references public.activity_segments (id) on delete cascade,
  rule_id uuid not null references public.alert_rules (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  employee_id uuid not null references public.employees (id) on delete cascade,
  occurred_at timestamptz not null,
  seconds integer not null,
  matched text,
  detected_at timestamptz not null default now(),
  primary key (segment_id, rule_id)
);
create index policy_violations_org_detected_idx on public.policy_violations (organization_id, detected_at);
create index policy_violations_org_time_idx on public.policy_violations (organization_id, occurred_at);

create or replace function public.alert_rule_matches(
  p_kind text, p_pattern text, p_app text, p_process text, p_domain text)
returns boolean
language sql
immutable
as $$
  select case
    when p_kind = 'domain' then
      p_domain is not null and case
        when position('*' in p_pattern) > 0
          then lower(p_domain) like replace(replace(p_pattern, '_', '\_'), '*', '%')
        else lower(p_domain) = p_pattern or right(lower(p_domain), length(p_pattern) + 1) = '.' || p_pattern
      end
    when p_kind = 'app' then
      exists (
        select 1 from unnest(array[lower(p_app), lower(p_process), regexp_replace(lower(p_process), '\.exe$', '')]) v(x)
        where v.x is not null and case
          when position('*' in p_pattern) > 0 then v.x like replace(replace(p_pattern, '_', '\_'), '*', '%')
          else v.x = p_pattern
        end)
    else false
  end;
$$;

-- Never blocks an upload: a failure here only loses the alert.
create or replace function public.match_alert_rules()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.state <> 'active' then
    if tg_op = 'UPDATE' then
      delete from public.policy_violations where segment_id = new.id;
    end if;
    return null;
  end if;
  if not exists (select 1 from public.alert_rules r where r.organization_id = new.organization_id and r.enabled)
     or not public.org_has_feature(new.organization_id, 'alert_rules') then
    return null;
  end if;
  insert into public.policy_violations (segment_id, rule_id, organization_id, employee_id, occurred_at, seconds, matched)
  select new.id, r.id, new.organization_id, new.employee_id, new.started_at, new.duration_seconds,
         case when r.kind = 'domain' then lower(new.domain) else coalesce(new.app_name, new.process_name) end
  from public.alert_rules r
  where r.organization_id = new.organization_id and r.enabled
    and public.alert_rule_matches(r.kind, r.pattern, new.app_name, new.process_name, new.domain)
    and (not r.work_hours_only or public.is_employee_work_time(new.employee_id, new.started_at))
  on conflict (segment_id, rule_id) do update
    set seconds = excluded.seconds, occurred_at = excluded.occurred_at;
  return null;
exception when others then
  raise warning 'Alert rule matching failed for segment %: %', new.id, sqlerrm;
  return null;
end;
$$;

create trigger activity_segments_alert_rules
  after insert or update of state, started_at, ended_at, app_name, process_name, domain on public.activity_segments
  for each row execute function public.match_alert_rules();

create or replace function public.require_rule_manager()
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  org_id uuid := public.my_organization_id();
begin
  if org_id is null or not public.is_org_wide_manager(org_id) then
    raise exception 'Not allowed';
  end if;
  if not public.org_has_feature(org_id, 'alert_rules') then
    raise exception 'Alert rules are not included in your plan';
  end if;
  return org_id;
end;
$$;

create or replace function public.normalise_rule_pattern(p_kind text, p_pattern text)
returns text
language sql
immutable
as $$
  select case when p_kind = 'domain'
    then regexp_replace(regexp_replace(regexp_replace(lower(btrim(coalesce(p_pattern, ''))),
           '^[a-z]+://', ''), '^www\.', ''), '[/?#:].*$', '')
    else lower(btrim(coalesce(p_pattern, '')))
  end;
$$;

-- p_id null adds a rule; otherwise changes it.
create or replace function public.save_alert_rule(
  p_id uuid, p_name text, p_kind text, p_pattern text, p_severity text, p_work_hours_only boolean, p_enabled boolean)
returns public.alert_rules
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid := public.require_rule_manager();
  norm text := public.normalise_rule_pattern(p_kind, p_pattern);
  result public.alert_rules;
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
  if p_id is null then
    if (select count(*) from public.alert_rules where organization_id = org_id) >= 500 then
      raise exception 'A company can have at most 500 alert rules';
    end if;
    insert into public.alert_rules (organization_id, name, kind, pattern, severity, work_hours_only, enabled, created_by)
    values (org_id, btrim(p_name), p_kind, norm, p_severity, coalesce(p_work_hours_only, false),
            coalesce(p_enabled, true), public.my_employee_id())
    returning * into result;
  else
    update public.alert_rules
    set name = btrim(p_name), kind = p_kind, pattern = norm, severity = p_severity,
        work_hours_only = coalesce(p_work_hours_only, false), enabled = coalesce(p_enabled, true), updated_at = now()
    where id = p_id and organization_id = org_id
    returning * into result;
    if result.id is null then
      raise exception 'Rule not found';
    end if;
  end if;
  perform public.write_audit(org_id, 'alert_rule_saved', 'alert_rule', result.id::text,
    jsonb_build_object('name', result.name, 'kind', result.kind, 'pattern', result.pattern,
                       'severity', result.severity, 'enabled', result.enabled));
  return result;
exception when unique_violation then
  raise exception 'There is already a rule for %', norm;
end;
$$;

create or replace function public.delete_alert_rule(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid := public.require_rule_manager();
  removed public.alert_rules;
begin
  delete from public.alert_rules where id = p_id and organization_id = org_id returning * into removed;
  if removed.id is not null then
    perform public.write_audit(org_id, 'alert_rule_deleted', 'alert_rule', removed.id::text,
      jsonb_build_object('name', removed.name, 'pattern', removed.pattern));
  end if;
end;
$$;

-- Suggested lists. Rules that already exist (same website or app) are left as they are.
create or replace function public.alert_rule_pack(p_pack text)
returns table (name text, kind text, pattern text, severity text)
language sql
immutable
as $$
  select x.name, x.kind, x.pattern, x.severity
  from (values
    ('file_sharing', 'File sharing: WeTransfer', 'domain', 'wetransfer.com', 'medium'),
    ('file_sharing', 'File sharing: WeTransfer', 'domain', 'we.tl', 'medium'),
    ('file_sharing', 'File sharing: MEGA', 'domain', 'mega.nz', 'medium'),
    ('file_sharing', 'File sharing: MEGA', 'domain', 'mega.io', 'medium'),
    ('file_sharing', 'File sharing: Dropbox', 'domain', 'dropbox.com', 'medium'),
    ('file_sharing', 'File sharing: Google Drive', 'domain', 'drive.google.com', 'medium'),
    ('file_sharing', 'File sharing: OneDrive (personal)', 'domain', 'onedrive.live.com', 'medium'),
    ('file_sharing', 'File sharing: iCloud', 'domain', 'icloud.com', 'medium'),
    ('file_sharing', 'File sharing: Box', 'domain', 'box.com', 'medium'),
    ('file_sharing', 'File sharing: pCloud', 'domain', 'pcloud.com', 'medium'),
    ('file_sharing', 'File sharing: MediaFire', 'domain', 'mediafire.com', 'medium'),
    ('file_sharing', 'File sharing: Sendspace', 'domain', 'sendspace.com', 'medium'),
    ('file_sharing', 'File sharing: Filemail', 'domain', 'filemail.com', 'medium'),
    ('file_sharing', 'File sharing: 4shared', 'domain', '4shared.com', 'medium'),
    ('file_sharing', 'File sharing: Gofile', 'domain', 'gofile.io', 'medium'),
    ('file_sharing', 'File sharing: file.io', 'domain', 'file.io', 'medium'),
    ('file_sharing', 'File sharing: Smash', 'domain', 'fromsmash.com', 'medium'),
    ('file_sharing', 'File sharing: SwissTransfer', 'domain', 'swisstransfer.com', 'medium'),
    ('file_sharing', 'File sharing: TransferNow', 'domain', 'transfernow.net', 'medium'),
    ('file_sharing', 'File sharing: TeraBox', 'domain', 'terabox.com', 'medium'),
    ('personal_email', 'Personal email: Gmail', 'domain', 'mail.google.com', 'low'),
    ('personal_email', 'Personal email: Outlook.com', 'domain', 'outlook.live.com', 'low'),
    ('personal_email', 'Personal email: Yahoo Mail', 'domain', 'mail.yahoo.com', 'low'),
    ('personal_email', 'Personal email: Proton Mail', 'domain', 'mail.proton.me', 'low'),
    ('personal_email', 'Personal email: AOL Mail', 'domain', 'mail.aol.com', 'low'),
    ('personal_email', 'Personal email: GMX', 'domain', 'gmx.com', 'low'),
    ('personal_email', 'Personal email: GMX', 'domain', 'gmx.net', 'low'),
    ('personal_email', 'Personal email: Mail.com', 'domain', 'mail.com', 'low'),
    ('personal_email', 'Personal email: Tuta', 'domain', 'tuta.com', 'low'),
    ('personal_email', 'Personal email: Yandex Mail', 'domain', 'mail.yandex.com', 'low'),
    ('bluetooth', 'Bluetooth file transfer', 'app', 'fsquirt.exe', 'medium')
  ) as x(pack, name, kind, pattern, severity)
  where x.pack = p_pack;
$$;

create or replace function public.add_alert_rule_pack(p_pack text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid := public.require_rule_manager();
  added integer;
begin
  if p_pack not in ('file_sharing', 'personal_email', 'bluetooth') then
    raise exception 'Unknown list';
  end if;
  insert into public.alert_rules (organization_id, name, kind, pattern, severity, pack, created_by)
  select org_id, k.name, k.kind, k.pattern, k.severity, p_pack, public.my_employee_id()
  from public.alert_rule_pack(p_pack) k
  on conflict (organization_id, kind, pattern) do nothing;
  get diagnostics added = row_count;
  perform public.write_audit(org_id, 'alert_rule_pack_added', 'organization', org_id::text,
    jsonb_build_object('pack', p_pack, 'added', added));
  return added;
end;
$$;

-- -----------------------------------------------------------------------------
-- One alert feed for the whole company. Policy matches and copied files are grouped per person per hour.
-- p_by_received: filter on when the server received the data (emails, channels) instead of when it happened.
-- -----------------------------------------------------------------------------
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

create or replace function public.get_integrity_alerts(p_since timestamptz)
returns table (employee_id uuid, employee_name text, occurred_at timestamptz, kind text, severity text, details jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select a.employee_id, a.employee_name, a.occurred_at, a.kind, a.severity, a.details
  from public.employees me
  cross join lateral public.org_alerts(me.organization_id, p_since, false) a
  where me.auth_user_id = auth.uid() and me.is_active and me.role in ('owner', 'manager')
    and public.is_manager_of(me.organization_id)
    and public.can_view_employee(a.employee_id)
  order by a.occurred_at desc
  limit 500;
$$;

create or replace function public.email_alert_batch(p_since timestamptz)
returns table (recipient_email text, recipient_name text, organization_name text, alerts integer, high_alerts integer)
language sql
stable
security definer
set search_path = public
as $$
  with recipients as (
    select m.id, m.email, m.name, o.id as org_id, o.name as org_name,
           array(select public.employees_visible_to(m.id)) as visible
    from public.employees m
    join public.organizations o on o.id = m.organization_id
    join public.subscriptions s on s.organization_id = o.id
    left join public.notification_preferences np on np.employee_id = m.id
    where m.is_active and m.role in ('owner', 'manager') and m.auth_user_id is not null
      and coalesce(np.alert_emails, true)
      and public.subscription_level(s) = 'full'
  ),
  alerts as (
    select o.org_id, a.employee_id, a.severity
    from (select distinct org_id from recipients) o
    cross join lateral public.org_alerts(o.org_id, p_since, true) a
    where a.kind not in ('clock_skew', 'after_hours_use')
  ),
  counted as (
    select r.email, r.name, r.org_name, count(a.*)::integer as alerts,
           (count(a.*) filter (where a.severity = 'high'))::integer as high_alerts
    from recipients r
    join alerts a on a.org_id = r.org_id and a.employee_id = any(r.visible)
    group by r.email, r.name, r.org_name
  )
  select * from counted where alerts > 0;
$$;

-- -----------------------------------------------------------------------------
-- Slack, Microsoft Teams and webhook channels
-- -----------------------------------------------------------------------------
create table public.notification_channels (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  kind text not null check (kind in ('slack', 'teams', 'webhook')),
  name text not null check (length(btrim(name)) between 1 and 100),
  url text not null check (url ~ '^https://' and length(url) <= 2000),
  signing_secret text,
  min_severity text not null default 'medium' check (min_severity in ('low', 'medium', 'high')),
  enabled boolean not null default true,
  created_by uuid references public.employees (id) on delete set null,
  created_at timestamptz not null default now(),
  last_sent_at timestamptz,
  last_error text,
  last_error_at timestamptz
);
create index notification_channels_org_idx on public.notification_channels (organization_id);

-- Only these hosts receive Slack and Teams messages; webhooks may use any public https address.
create or replace function public.channel_url_ok(p_kind text, p_url text)
returns boolean
language sql
immutable
as $$
  with h as (select lower(substring(p_url from '^https://([^/?#@:\s]+)(:443)?([/?#]|$)')) as host)
  select p_url is not null and length(p_url) <= 2000 and p_url !~ '\s' and h.host is not null and case p_kind
    when 'slack' then h.host = 'hooks.slack.com'
    when 'teams' then h.host ~ '(^|\.)(webhook\.office\.com|logic\.azure\.com|api\.powerplatform\.com)$'
    when 'webhook' then h.host ~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$' and h.host !~ '^[0-9.]+$'
                        and h.host !~ '(\.local|\.internal|\.localhost|\.lan|\.home\.arpa)$'
    else false
  end
  from h;
$$;

create or replace function public.require_channel_manager()
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  org_id uuid := public.my_organization_id();
begin
  if org_id is null or not public.is_org_wide_manager(org_id) then
    raise exception 'Not allowed';
  end if;
  if not public.org_has_feature(org_id, 'channels') then
    raise exception 'Slack, Teams and webhook alerts are not included in your plan';
  end if;
  return org_id;
end;
$$;

create or replace function public.list_notification_channels()
returns table (id uuid, kind text, name text, url_hint text, min_severity text, enabled boolean,
               created_at timestamptz, last_sent_at timestamptz, last_error text, last_error_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  org_id uuid := public.my_organization_id();
begin
  if org_id is null or not public.is_org_wide_manager(org_id) then
    raise exception 'Not allowed';
  end if;
  return query
    select c.id, c.kind, c.name,
           substring(c.url from '^https://([^/?#]+)') || '/…' || right(c.url, 4),
           c.min_severity, c.enabled, c.created_at, c.last_sent_at, c.last_error, c.last_error_at
    from public.notification_channels c
    where c.organization_id = org_id
    order by c.created_at;
end;
$$;

-- The signing secret (webhooks only) is returned once, here.
create or replace function public.add_notification_channel(p_kind text, p_name text, p_url text, p_min_severity text)
returns table (id uuid, signing_secret text)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  org_id uuid := public.require_channel_manager();
  url text := btrim(coalesce(p_url, ''));
  secret text;
  new_id uuid;
begin
  if p_kind not in ('slack', 'teams', 'webhook') then
    raise exception 'Choose Slack, Microsoft Teams or webhook';
  end if;
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'Give the channel a name';
  end if;
  if coalesce(p_min_severity, '') not in ('low', 'medium', 'high') then
    raise exception 'Invalid severity';
  end if;
  if not public.channel_url_ok(p_kind, url) then
    raise exception '%', case p_kind
      when 'slack' then 'Paste a Slack incoming webhook address (https://hooks.slack.com/...)'
      when 'teams' then 'Paste a Microsoft Teams workflow webhook address'
      else 'Enter a public https address' end;
  end if;
  if (select count(*) from public.notification_channels c where c.organization_id = org_id) >= 20 then
    raise exception 'A company can have at most 20 channels';
  end if;
  if p_kind = 'webhook' then
    secret := 'whsec_' || encode(gen_random_bytes(24), 'hex');
  end if;
  insert into public.notification_channels (organization_id, kind, name, url, signing_secret, min_severity, created_by)
  values (org_id, p_kind, btrim(p_name), url, secret, p_min_severity, public.my_employee_id())
  returning notification_channels.id into new_id;
  perform public.write_audit(org_id, 'channel_added', 'notification_channel', new_id::text,
    jsonb_build_object('kind', p_kind, 'name', btrim(p_name)));
  return query select new_id, secret;
end;
$$;

create or replace function public.update_notification_channel(p_id uuid, p_name text, p_min_severity text, p_enabled boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid := public.require_channel_manager();
begin
  if coalesce(btrim(p_name), '') = '' or coalesce(p_min_severity, '') not in ('low', 'medium', 'high') then
    raise exception 'Invalid channel settings';
  end if;
  update public.notification_channels
  set name = btrim(p_name), min_severity = p_min_severity, enabled = coalesce(p_enabled, true)
  where id = p_id and organization_id = org_id;
  if not found then
    raise exception 'Channel not found';
  end if;
  perform public.write_audit(org_id, 'channel_updated', 'notification_channel', p_id::text,
    jsonb_build_object('min_severity', p_min_severity, 'enabled', coalesce(p_enabled, true)));
end;
$$;

create or replace function public.delete_notification_channel(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid := public.my_organization_id();
begin
  if org_id is null or not public.is_org_wide_manager(org_id) then
    raise exception 'Not allowed';
  end if;
  delete from public.notification_channels where id = p_id and organization_id = org_id;
  if found then
    perform public.write_audit(org_id, 'channel_deleted', 'notification_channel', p_id::text, '{}'::jsonb);
  end if;
end;
$$;

-- Called with the user's token by the channel-test function before it sends anything.
create or replace function public.request_channel_test(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid := public.require_channel_manager();
begin
  if not exists (select 1 from public.notification_channels where id = p_id and organization_id = org_id) then
    raise exception 'Channel not found';
  end if;
  perform public.write_audit(org_id, 'channel_tested', 'notification_channel', p_id::text, '{}'::jsonb);
  return true;
end;
$$;

-- Service role only.
create or replace function public.channel_delivery_info(p_id uuid)
returns table (id uuid, kind text, url text, signing_secret text, organization_name text, timezone text)
language sql
stable
security definer
set search_path = public
as $$
  select c.id, c.kind, c.url, c.signing_secret, o.name, o.timezone
  from public.notification_channels c
  join public.organizations o on o.id = c.organization_id
  where c.id = p_id;
$$;

-- Service role only: what each enabled channel should post for alerts received since p_since.
create or replace function public.channel_alert_batch(p_since timestamptz)
returns table (channel_id uuid, kind text, url text, signing_secret text, organization_name text, timezone text,
               alerts jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select c.id, c.kind, c.url, c.signing_secret, o.name, o.timezone,
         (select jsonb_agg(jsonb_build_object('employee_id', a.employee_id, 'employee_name', a.employee_name,
                                              'occurred_at', a.occurred_at, 'kind', a.kind,
                                              'severity', a.severity, 'details', a.details)
                           order by a.occurred_at)
          from (select * from public.org_alerts(o.id, p_since, true) x
                where public.severity_rank(x.severity) >= public.severity_rank(c.min_severity)
                  and x.kind not in ('clock_skew', 'after_hours_use')
                order by x.occurred_at desc limit 50) a)
  from public.notification_channels c
  join public.organizations o on o.id = c.organization_id
  join public.subscriptions s on s.organization_id = o.id
  where c.enabled and public.subscription_level(s) = 'full' and public.org_has_feature(o.id, 'channels');
$$;

-- Service role only. p_error null = delivered.
create or replace function public.record_channel_result(p_id uuid, p_error text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.notification_channels
  set last_sent_at = case when p_error is null then now() else last_sent_at end,
      last_error = left(p_error, 500),
      last_error_at = case when p_error is null then last_error_at else now() end
  where id = p_id;
$$;

-- -----------------------------------------------------------------------------
-- Read-only API keys
-- -----------------------------------------------------------------------------
create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 100),
  key_prefix text not null,
  key_hash text not null unique,
  created_by uuid references public.employees (id) on delete set null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index api_keys_org_idx on public.api_keys (organization_id);

create or replace function public.require_api_manager()
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  org_id uuid := public.my_organization_id();
begin
  if org_id is null or not public.is_org_wide_manager(org_id) then
    raise exception 'Not allowed';
  end if;
  return org_id;
end;
$$;

create or replace function public.list_api_keys()
returns table (id uuid, name text, key_prefix text, created_at timestamptz, last_used_at timestamptz,
               revoked_at timestamptz, created_by_name text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  org_id uuid := public.require_api_manager();
begin
  return query
    select k.id, k.name, k.key_prefix, k.created_at, k.last_used_at, k.revoked_at, e.name
    from public.api_keys k
    left join public.employees e on e.id = k.created_by
    where k.organization_id = org_id
    order by k.revoked_at nulls first, k.created_at desc;
end;
$$;

-- The key itself is returned once, here; only its hash is stored.
create or replace function public.create_api_key(p_name text)
returns table (id uuid, api_key text)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  org_id uuid := public.require_api_manager();
  plain text := 'myc_' || encode(gen_random_bytes(24), 'hex');
  new_id uuid;
begin
  if not public.org_has_feature(org_id, 'api') then
    raise exception 'API access is not included in your plan';
  end if;
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'Give the key a name, for example "Power BI"';
  end if;
  if (select count(*) from public.api_keys k where k.organization_id = org_id and k.revoked_at is null) >= 10 then
    raise exception 'A company can have at most 10 active API keys';
  end if;
  insert into public.api_keys (organization_id, name, key_prefix, key_hash, created_by)
  values (org_id, btrim(p_name), left(plain, 12), public.report_key_hash(plain), public.my_employee_id())
  returning api_keys.id into new_id;
  perform public.write_audit(org_id, 'api_key_created', 'api_key', new_id::text, jsonb_build_object('name', btrim(p_name)));
  return query select new_id, plain;
end;
$$;

create or replace function public.revoke_api_key(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid := public.require_api_manager();
begin
  update public.api_keys set revoked_at = now()
  where id = p_id and organization_id = org_id and revoked_at is null;
  if found then
    perform public.write_audit(org_id, 'api_key_revoked', 'api_key', p_id::text, '{}'::jsonb);
  end if;
end;
$$;

-- Service role only. Returns the company for a valid, active key on a plan that includes the API.
create or replace function public.api_authenticate(p_key text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  k public.api_keys;
begin
  if p_key is null or p_key !~ '^myc_[0-9a-f]{48}$' then
    return null;
  end if;
  select * into k from public.api_keys where key_hash = public.report_key_hash(p_key) and revoked_at is null;
  if k.id is null or not public.org_has_feature(k.organization_id, 'api') then
    return null;
  end if;
  if k.last_used_at is null or k.last_used_at < now() - interval '1 minute' then
    update public.api_keys set last_used_at = now() where id = k.id;
  end if;
  return k.organization_id;
end;
$$;

create or replace function public.api_check_period(p_from date, p_to date)
returns void
language plpgsql
immutable
as $$
begin
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'from and to must be dates (YYYY-MM-DD), with from on or before to';
  end if;
  if p_to - p_from > 92 then
    raise exception 'Ask for at most 93 days at a time';
  end if;
end;
$$;

-- Service role only (the api function).
create or replace function public.api_employees(p_org uuid)
returns table (id uuid, employee_code text, name text, email text, role text, team text, is_active boolean)
language sql
stable
security definer
set search_path = public
as $$
  select e.id, e.employee_code, e.name, e.email, e.role, t.name, e.is_active
  from public.employees e
  left join public.teams t on t.id = e.team_id
  where e.organization_id = p_org
  order by e.name;
$$;

create or replace function public.api_daily_totals(p_org uuid, p_from date, p_to date)
returns table (employee_id uuid, day date, active_seconds bigint, idle_seconds bigint,
               productive_seconds bigint, unproductive_seconds bigint)
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
  )
  select r.employee_id, r.day, sum(r.active_seconds)::bigint, sum(r.idle_seconds)::bigint,
         coalesce(sum(r.active_seconds) filter (where c.category = 'productive'), 0)::bigint,
         coalesce(sum(r.active_seconds) filter (where c.category = 'unproductive'), 0)::bigint
  from rows_ r
  join cats c on c.team_id is not distinct from r.team_id and c.app_name = r.app_name and c.domain = r.domain
  group by r.employee_id, r.day
  order by r.day, r.employee_id;
end;
$$;

create or replace function public.api_usage(p_org uuid, p_from date, p_to date)
returns table (employee_id uuid, day date, app_name text, domain text, active_seconds integer, idle_seconds integer,
               category text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.api_check_period(p_from, p_to);
  return query
    select u.employee_id, u.day, u.app_name, nullif(u.domain, ''), u.active_seconds, u.idle_seconds,
           public.category_of(p_org, e.team_id, u.app_name, nullif(u.domain, ''))
    from public.usage_between(p_org, p_from, p_to) u
    join public.employees e on e.id = u.employee_id
    order by u.day, u.employee_id, u.active_seconds desc;
end;
$$;

create or replace function public.api_alerts(p_org uuid, p_since timestamptz)
returns table (employee_id uuid, employee_name text, occurred_at timestamptz, kind text, severity text, details jsonb)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_since is null or p_since < now() - interval '93 days' then
    raise exception 'since must be a time within the last 93 days';
  end if;
  return query
    select a.employee_id, a.employee_name, a.occurred_at, a.kind, a.severity, a.details
    from public.org_alerts(p_org, p_since, false) a
    order by a.occurred_at desc
    limit 5000;
end;
$$;

-- -----------------------------------------------------------------------------
-- Retention and deletions
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
  files_purged integer;
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
  delete from public.file_events f
  using public.organization_settings s
  where s.organization_id = f.organization_id
    and f.occurred_at < now() - make_interval(days => s.file_retention_days);
  get diagnostics files_purged = row_count;

  delete from public.maintenance_runs where ran_at < now() - interval '90 days';
  insert into public.maintenance_runs (duration_ms, details)
  values ((extract(epoch from clock_timestamp() - started) * 1000)::integer,
          jsonb_build_object('stale_sessions_closed', stale, 'file_events_purged', files_purged));
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

  delete from public.daily_summaries
  where employee_id = p_employee
    and day between (p_from at time zone tz)::date and (p_to at time zone tz)::date;
  delete from public.daily_usage
  where employee_id = p_employee
    and day between (p_from at time zone tz)::date and (p_to at time zone tz)::date;

  perform public.write_audit(emp.organization_id, 'activity_deleted', 'employee', emp.id::text,
    jsonb_build_object('from', p_from, 'to', p_to, 'segments', removed, 'file_events', files, 'reason', p_reason));
  return removed;
end;
$$;

-- -----------------------------------------------------------------------------
-- Row level security and privileges
-- -----------------------------------------------------------------------------
alter table public.file_events enable row level security;
alter table public.alert_rules enable row level security;
alter table public.policy_violations enable row level security;
alter table public.notification_channels enable row level security;
alter table public.api_keys enable row level security;

-- File activity has no select policy: it is read through get_file_activity, which audits each view.
create policy file_events_insert on public.file_events for insert to authenticated
  with check (employee_id = public.my_employee_id()
              and organization_id = public.my_organization_id()
              and public.owns_device(device_id)
              and occurred_at > now() - interval '14 days'
              and occurred_at < now() + interval '10 minutes'
              and public.has_consented_before(occurred_at)
              and public.file_detection_on(destination));
create policy alert_rules_select on public.alert_rules for select to authenticated
  using (public.is_manager_of(organization_id));
create policy policy_violations_select on public.policy_violations for select to authenticated
  using (public.can_view_employee(employee_id) and public.is_manager_of(organization_id));

revoke all on public.file_events, public.alert_rules, public.policy_violations, public.notification_channels,
  public.api_keys from anon;
revoke all on public.notification_channels, public.api_keys from authenticated;
revoke select, update, delete, truncate on public.file_events from authenticated;
revoke insert, update, delete, truncate on public.alert_rules, public.policy_violations from authenticated;

revoke execute on function
  public.severity_rank(text),
  public.save_compliance_settings(jsonb, text, text),
  public.render_monitoring_notice(uuid),
  public.file_detection_on(text),
  public.get_file_activity(uuid, timestamptz, timestamptz),
  public.alert_rule_matches(text, text, text, text, text),
  public.match_alert_rules(),
  public.require_rule_manager(),
  public.normalise_rule_pattern(text, text),
  public.save_alert_rule(uuid, text, text, text, text, boolean, boolean),
  public.delete_alert_rule(uuid),
  public.alert_rule_pack(text),
  public.add_alert_rule_pack(text),
  public.org_alerts(uuid, timestamptz, boolean),
  public.get_integrity_alerts(timestamptz),
  public.email_alert_batch(timestamptz),
  public.channel_url_ok(text, text),
  public.require_channel_manager(),
  public.list_notification_channels(),
  public.add_notification_channel(text, text, text, text),
  public.update_notification_channel(uuid, text, text, boolean),
  public.delete_notification_channel(uuid),
  public.request_channel_test(uuid),
  public.channel_delivery_info(uuid),
  public.channel_alert_batch(timestamptz),
  public.record_channel_result(uuid, text),
  public.require_api_manager(),
  public.list_api_keys(),
  public.create_api_key(text),
  public.revoke_api_key(uuid),
  public.api_authenticate(text),
  public.api_check_period(date, date),
  public.api_employees(uuid),
  public.api_daily_totals(uuid, date, date),
  public.api_usage(uuid, date, date),
  public.api_alerts(uuid, timestamptz),
  public.run_nightly_maintenance(),
  public.delete_activity(uuid, timestamptz, timestamptz, text)
from public, anon;

grant execute on function
  public.save_compliance_settings(jsonb, text, text),
  public.file_detection_on(text),
  public.get_file_activity(uuid, timestamptz, timestamptz),
  public.save_alert_rule(uuid, text, text, text, text, boolean, boolean),
  public.delete_alert_rule(uuid),
  public.alert_rule_pack(text),
  public.add_alert_rule_pack(text),
  public.get_integrity_alerts(timestamptz),
  public.list_notification_channels(),
  public.add_notification_channel(text, text, text, text),
  public.update_notification_channel(uuid, text, text, boolean),
  public.delete_notification_channel(uuid),
  public.request_channel_test(uuid),
  public.list_api_keys(),
  public.create_api_key(text),
  public.revoke_api_key(uuid),
  public.delete_activity(uuid, timestamptz, timestamptz, text)
to authenticated;

revoke execute on function
  public.severity_rank(text),
  public.render_monitoring_notice(uuid),
  public.alert_rule_matches(text, text, text, text, text),
  public.match_alert_rules(),
  public.require_rule_manager(),
  public.normalise_rule_pattern(text, text),
  public.org_alerts(uuid, timestamptz, boolean),
  public.email_alert_batch(timestamptz),
  public.channel_url_ok(text, text),
  public.require_channel_manager(),
  public.channel_delivery_info(uuid),
  public.channel_alert_batch(timestamptz),
  public.record_channel_result(uuid, text),
  public.require_api_manager(),
  public.api_authenticate(text),
  public.api_check_period(date, date),
  public.api_employees(uuid),
  public.api_daily_totals(uuid, date, date),
  public.api_usage(uuid, date, date),
  public.api_alerts(uuid, timestamptz),
  public.run_nightly_maintenance()
from authenticated;

grant execute on function
  public.channel_delivery_info(uuid),
  public.channel_alert_batch(timestamptz),
  public.record_channel_result(uuid, text),
  public.api_authenticate(text),
  public.api_employees(uuid),
  public.api_daily_totals(uuid, date, date),
  public.api_usage(uuid, date, date),
  public.api_alerts(uuid, timestamptz),
  public.email_alert_batch(timestamptz)
to service_role;

notify pgrst, 'reload schema';
