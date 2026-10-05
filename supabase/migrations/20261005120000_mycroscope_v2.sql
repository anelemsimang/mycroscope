-- =============================================================================
-- Mycroscope v2 schema (fresh install).
-- Apply once to a NEW Supabase project: Dashboard -> SQL Editor -> paste -> Run,
-- or `supabase db push` when the project is linked.
--
-- Model
--   * Everyone signs in with Supabase Auth. public.employees links an auth user
--     to an organisation and a role (owner / manager / employee).
--   * Owners self-register (signup_type = 'owner'); employees are created by a
--     manager and activate with a one-time code (signup_type = 'employee_activation').
--     Any other sign-up is rejected.
--   * The desktop agent uploads immutable time segments with client-generated
--     ids (idempotent upsert). Overlapping time on one device is rejected.
--   * Activity is only accepted after the employee acknowledged a monitoring
--     notice. The notice is generated from the organisation's settings and a new
--     version is published whenever those settings change.
--   * All reporting is computed server-side in the organisation's timezone.
-- =============================================================================

create extension if not exists pgcrypto;
create extension if not exists btree_gist;

-- -----------------------------------------------------------------------------
-- Utility
-- -----------------------------------------------------------------------------
create or replace function public.is_valid_timezone(p_tz text)
returns boolean
language sql
stable
as $$
  select exists (select 1 from pg_timezone_names where name = p_tz);
$$;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.random_code(p_len integer)
returns text
language plpgsql
volatile
set search_path = public, extensions
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  bytes bytea := gen_random_bytes(p_len);
  result text := '';
  i integer;
begin
  for i in 0 .. p_len - 1 loop
    result := result || substr(alphabet, (get_byte(bytes, i) % 32) + 1, 1);
  end loop;
  return result;
end;
$$;

-- -----------------------------------------------------------------------------
-- Organisations & settings
-- -----------------------------------------------------------------------------
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 2 and 200),
  timezone text not null default 'Africa/Johannesburg' check (public.is_valid_timezone(timezone)),
  information_officer_name text,
  information_officer_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger organizations_touch before update on public.organizations
  for each row execute function public.touch_updated_at();

create table public.organization_settings (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  track_apps boolean not null default true,
  track_window_titles boolean not null default true,
  track_web_domains boolean not null default true,
  track_full_urls boolean not null default true,
  idle_threshold_seconds integer not null default 300 check (idle_threshold_seconds between 60 and 3600),
  allow_pause boolean not null default true,
  retention_days integer not null default 90 check (retention_days between 7 and 1825),
  summary_retention_days integer not null default 730 check (summary_retention_days between 30 and 3650),
  notice_custom_text text check (notice_custom_text is null or length(notice_custom_text) <= 4000),
  updated_at timestamptz not null default now(),
  updated_by uuid
);

create trigger organization_settings_touch before update on public.organization_settings
  for each row execute function public.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Employees (every user of the system, including owners and managers)
-- -----------------------------------------------------------------------------
create table public.employees (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  auth_user_id uuid unique references auth.users (id) on delete set null,
  employee_code text not null check (employee_code ~ '^[A-Za-z0-9_-]{3,32}$'),
  name text not null check (length(btrim(name)) between 1 and 200),
  email text not null check (position('@' in email) > 1),
  role text not null default 'employee' check (role in ('owner', 'manager', 'employee')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index employees_code_key on public.employees (lower(employee_code));
create unique index employees_email_key on public.employees (lower(email));
create index employees_org_idx on public.employees (organization_id);

create trigger employees_touch before update on public.employees
  for each row execute function public.touch_updated_at();

alter table public.organization_settings
  add constraint organization_settings_updated_by_fkey
  foreign key (updated_by) references public.employees (id) on delete set null;

-- One-time activation codes. No policies: only security-definer functions read it.
create table public.employee_activations (
  employee_id uuid primary key references public.employees (id) on delete cascade,
  code_hash text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  created_by uuid references public.employees (id) on delete set null
);

-- -----------------------------------------------------------------------------
-- Projects
-- -----------------------------------------------------------------------------
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 200),
  description text,
  is_active boolean not null default true,
  created_by uuid references public.employees (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index projects_org_name_key on public.projects (organization_id, lower(name));

create trigger projects_touch before update on public.projects
  for each row execute function public.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Desktop agent data
-- -----------------------------------------------------------------------------
create table public.devices (
  id uuid primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  employee_id uuid not null references public.employees (id) on delete cascade,
  hostname text,
  os_version text,
  agent_version text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index devices_employee_idx on public.devices (employee_id);

create table public.agent_sessions (
  id uuid primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  employee_id uuid not null references public.employees (id) on delete cascade,
  device_id uuid not null references public.devices (id) on delete cascade,
  started_at timestamptz not null,
  ended_at timestamptz,
  end_reason text check (end_reason in ('logout', 'shutdown', 'crash', 'stale')),
  received_at timestamptz not null default now(),
  constraint agent_sessions_time_order check (ended_at is null or ended_at >= started_at)
);

create index agent_sessions_employee_idx on public.agent_sessions (employee_id, started_at desc);
create index agent_sessions_open_idx on public.agent_sessions (employee_id) where ended_at is null;

create table public.activity_segments (
  id uuid primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  employee_id uuid not null references public.employees (id) on delete cascade,
  device_id uuid not null references public.devices (id) on delete cascade,
  session_id uuid references public.agent_sessions (id) on delete set null,
  project_id uuid references public.projects (id) on delete set null,
  state text not null check (state in ('active', 'idle', 'away', 'paused')),
  started_at timestamptz not null,
  ended_at timestamptz not null,
  duration_seconds integer generated always as (extract(epoch from (ended_at - started_at))::integer) stored,
  app_name text,
  process_name text,
  window_title text,
  url text,
  domain text,
  received_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint activity_segments_time_order check (ended_at >= started_at),
  constraint activity_segments_max_length check (ended_at - started_at <= interval '1 hour'),
  constraint activity_segments_not_future check (ended_at <= updated_at + interval '10 minutes'),
  constraint activity_segments_no_overlap
    exclude using gist (device_id with =, tstzrange(started_at, ended_at, '[)') with &&)
);

create index activity_segments_employee_time_idx on public.activity_segments (employee_id, started_at);
create index activity_segments_org_time_idx on public.activity_segments (organization_id, started_at);

create trigger activity_segments_touch before update on public.activity_segments
  for each row execute function public.touch_updated_at();

-- One row per employee: what the agent is doing right now (live dashboard).
create table public.agent_status (
  employee_id uuid primary key references public.employees (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  device_id uuid references public.devices (id) on delete set null,
  state text not null check (state in ('active', 'idle', 'away', 'paused', 'logged_out')),
  app_name text,
  window_title text,
  url text,
  domain text,
  project_id uuid references public.projects (id) on delete set null,
  agent_version text,
  last_seen_at timestamptz not null default now()
);

create index agent_status_org_idx on public.agent_status (organization_id);

create table public.agent_events (
  id uuid primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  employee_id uuid not null references public.employees (id) on delete cascade,
  device_id uuid references public.devices (id) on delete set null,
  occurred_at timestamptz not null,
  event_type text not null check (event_type in (
    'login', 'logout', 'pause', 'resume', 'project_switch', 'sleep', 'wake',
    'lock', 'unlock', 'agent_start', 'agent_stop', 'clock_skew', 'data_rejected')),
  details jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now()
);

create index agent_events_employee_time_idx on public.agent_events (employee_id, occurred_at desc);

-- -----------------------------------------------------------------------------
-- Compliance: notices, consents, audit trail, summaries
-- -----------------------------------------------------------------------------
create table public.monitoring_policies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  version integer not null check (version > 0),
  notice_text text not null,
  settings_snapshot jsonb not null,
  published_at timestamptz not null default now(),
  published_by uuid references public.employees (id) on delete set null,
  constraint monitoring_policies_org_version_key unique (organization_id, version)
);

create table public.consents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  employee_id uuid not null references public.employees (id) on delete cascade,
  policy_id uuid not null references public.monitoring_policies (id) on delete cascade,
  device_id uuid references public.devices (id) on delete set null,
  agent_version text,
  acknowledged_at timestamptz not null default now(),
  constraint consents_employee_policy_key unique (employee_id, policy_id)
);

create index consents_employee_idx on public.consents (employee_id, acknowledged_at desc);

create table public.audit_log (
  id bigint generated always as identity primary key,
  organization_id uuid references public.organizations (id) on delete cascade,
  actor_employee_id uuid references public.employees (id) on delete set null,
  actor_auth_id uuid,
  action text not null,
  target_type text,
  target_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index audit_log_org_time_idx on public.audit_log (organization_id, created_at desc);

create table public.daily_summaries (
  employee_id uuid not null references public.employees (id) on delete cascade,
  day date not null,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  active_seconds integer not null default 0,
  idle_seconds integer not null default 0,
  away_seconds integer not null default 0,
  paused_seconds integer not null default 0,
  first_activity_at timestamptz,
  last_activity_at timestamptz,
  top_apps jsonb not null default '[]'::jsonb,
  top_domains jsonb not null default '[]'::jsonb,
  computed_at timestamptz not null default now(),
  primary key (employee_id, day)
);

create index daily_summaries_org_day_idx on public.daily_summaries (organization_id, day);

-- -----------------------------------------------------------------------------
-- Identity helpers (security definer so RLS policies can use them without recursion)
-- -----------------------------------------------------------------------------
create or replace function public.my_employee_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.employees where auth_user_id = auth.uid() and is_active limit 1;
$$;

create or replace function public.my_organization_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select organization_id from public.employees where auth_user_id = auth.uid() and is_active limit 1;
$$;

create or replace function public.my_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.employees where auth_user_id = auth.uid() and is_active limit 1;
$$;

create or replace function public.is_manager_of(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.employees
    where auth_user_id = auth.uid() and is_active
      and organization_id = p_org and role in ('owner', 'manager'));
$$;

create or replace function public.can_view_employee(p_employee uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.employees target
    join public.employees me on me.auth_user_id = auth.uid() and me.is_active
    where target.id = p_employee
      and (me.id = target.id
           or (me.organization_id = target.organization_id and me.role in ('owner', 'manager'))));
$$;

create or replace function public.owns_device(p_device uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.devices d
    where d.id = p_device and d.employee_id = public.my_employee_id());
$$;

create or replace function public.has_consented_before(p_at timestamptz)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.consents c
    where c.employee_id = public.my_employee_id()
      and c.acknowledged_at <= p_at + interval '5 minutes');
$$;

create or replace function public.write_audit(
  p_org uuid, p_action text, p_target_type text, p_target_id text, p_details jsonb default '{}'::jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.audit_log (organization_id, actor_employee_id, actor_auth_id, action, target_type, target_id, details)
  values (p_org, public.my_employee_id(), auth.uid(), p_action, p_target_type, p_target_id, coalesce(p_details, '{}'::jsonb));
$$;

-- -----------------------------------------------------------------------------
-- Monitoring notice
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

  contact := coalesce(nullif(btrim(o.information_officer_name), ''), 'the organisation''s Information Officer')
             || coalesce(' (' || nullif(btrim(o.information_officer_email), '') || ')', '');

  pause_text := case when s.allow_pause
    then 'You can pause monitoring at any time from the tray icon, for example for personal use. Pause periods are recorded and visible to managers.'
    else 'Monitoring cannot be paused while you are logged in. Log out of Mycroscope when you are not working.'
  end;

  return format(
E'MONITORING NOTICE - %1$s\n\n%2$s\n\nWHAT IS RECORDED\nWhile you are logged in to Mycroscope on this computer, %1$s records:%3$s\n\nWHAT IS NOT RECORDED\nKeystrokes (what you type), screenshots, screen recordings, webcam or microphone, file contents, and the contents of emails or messages.\n\nWHY\nTo understand how working time is spent, to allocate time to projects, and to manage productivity and the proper use of company equipment.\n\nYOUR CONTROL\nA Mycroscope icon is shown in the system tray whenever monitoring is active. %4$s\n\nWHO CAN SEE IT\nOwners and managers of %1$s. You can view your own recorded activity from the Mycroscope tray icon.\n\nHOW LONG IT IS KEPT\nDetailed activity is deleted after %5$s days. Daily totals are kept for %6$s days.\n\nYOUR RIGHTS\nUnder the Protection of Personal Information Act, 2013 (POPIA) you may ask to access or correct your information and you may object to the processing. Contact %7$s. You may also lodge a complaint with the Information Regulator (https://inforegulator.org.za).\n\nThis notice is also given for the purposes of the Regulation of Interception of Communications and Provision of Communication-Related Information Act, 2002 (RICA). By selecting "I acknowledge" you confirm that you have read this notice and consent to the monitoring described above.',
    o.name,
    coalesce(nullif(btrim(s.notice_custom_text), ''), 'Please read this notice before you start working.'),
    items,
    pause_text,
    s.retention_days,
    s.summary_retention_days,
    contact);
end;
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

create or replace function public.settings_after_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (to_jsonb(old) - 'updated_at' - 'updated_by') is distinct from (to_jsonb(new) - 'updated_at' - 'updated_by') then
    insert into public.audit_log (organization_id, actor_employee_id, actor_auth_id, action, target_type, target_id, details)
    values (new.organization_id, public.my_employee_id(), auth.uid(), 'settings_updated', 'organization_settings',
            new.organization_id::text,
            jsonb_build_object('before', to_jsonb(old) - 'updated_at' - 'updated_by',
                               'after', to_jsonb(new) - 'updated_at' - 'updated_by'));
    perform public.publish_policy_internal(new.organization_id, public.my_employee_id());
  end if;
  return new;
end;
$$;

create trigger organization_settings_audit after update on public.organization_settings
  for each row execute function public.settings_after_update();

create or replace function public.organizations_after_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (to_jsonb(old) - 'updated_at') is distinct from (to_jsonb(new) - 'updated_at') then
    insert into public.audit_log (organization_id, actor_employee_id, actor_auth_id, action, target_type, target_id, details)
    values (new.id, public.my_employee_id(), auth.uid(), 'organization_updated', 'organization', new.id::text,
            jsonb_build_object('before', to_jsonb(old) - 'updated_at', 'after', to_jsonb(new) - 'updated_at'));
    if old.name is distinct from new.name
       or old.information_officer_name is distinct from new.information_officer_name
       or old.information_officer_email is distinct from new.information_officer_email then
      perform public.publish_policy_internal(new.id, public.my_employee_id());
    end if;
  end if;
  return new;
end;
$$;

create trigger organizations_audit after update on public.organizations
  for each row execute function public.organizations_after_update();

-- -----------------------------------------------------------------------------
-- Sign-up handling (auth.users triggers)
-- -----------------------------------------------------------------------------
create or replace function public.generate_employee_code(p_org_name text)
returns text
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  words text[];
  prefix text;
  candidate text;
  attempt integer := 0;
begin
  words := regexp_split_to_array(upper(regexp_replace(coalesce(p_org_name, ''), '[^A-Za-z ]', '', 'g')), '\s+');
  words := array_remove(words, '');
  if array_length(words, 1) is null then
    prefix := 'EMP';
  elsif array_length(words, 1) = 1 then
    prefix := left(words[1], 3);
  else
    select left(string_agg(left(w, 1), ''), 4) into prefix from unnest(words) w;
  end if;
  if length(prefix) < 2 then
    prefix := 'EMP';
  end if;

  loop
    attempt := attempt + 1;
    candidate := prefix || lpad(((get_byte(gen_random_bytes(2), 0) * 256 + get_byte(gen_random_bytes(2), 1)) % 10000)::text, 4, '0');
    exit when not exists (select 1 from public.employees where lower(employee_code) = lower(candidate));
    if attempt > 50 then
      candidate := prefix || public.random_code(6);
      exit when not exists (select 1 from public.employees where lower(employee_code) = lower(candidate));
    end if;
  end loop;
  return candidate;
end;
$$;

create or replace function public.handle_auth_user_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  signup_type text := meta ->> 'signup_type';
  emp public.employees;
  act public.employee_activations;
begin
  if signup_type = 'owner' then
    if coalesce(btrim(meta ->> 'organization_name'), '') = '' or coalesce(btrim(meta ->> 'full_name'), '') = '' then
      raise exception 'organization_name and full_name are required';
    end if;
    if exists (select 1 from public.employees where lower(email) = lower(new.email)) then
      raise exception 'This email address is already registered';
    end if;
    return new;

  elsif signup_type = 'employee_activation' then
    select e.* into emp
    from public.employees e
    where lower(e.employee_code) = lower(coalesce(meta ->> 'employee_code', ''))
      and e.auth_user_id is null
      and e.is_active;
    if emp.id is null or lower(emp.email) <> lower(new.email) then
      raise exception 'Invalid activation details';
    end if;

    select * into act from public.employee_activations where employee_id = emp.id;
    if act.employee_id is null
       or act.expires_at < now()
       or act.code_hash <> crypt(upper(coalesce(meta ->> 'activation_code', '')), act.code_hash) then
      raise exception 'Invalid or expired activation code';
    end if;

    new.email_confirmed_at := coalesce(new.email_confirmed_at, now());
    new.raw_user_meta_data := meta - 'activation_code';
    return new;
  end if;

  raise exception 'Sign-up is not open. Ask your organisation for an activation code.';
end;
$$;

create or replace function public.handle_auth_user_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  org_id uuid;
  emp_id uuid;
begin
  if meta ->> 'signup_type' = 'owner' then
    insert into public.organizations (name)
    values (btrim(meta ->> 'organization_name'))
    returning id into org_id;

    insert into public.organization_settings (organization_id) values (org_id);

    insert into public.employees (organization_id, auth_user_id, employee_code, name, email, role)
    values (org_id, new.id, public.generate_employee_code(meta ->> 'organization_name'),
            btrim(meta ->> 'full_name'), new.email, 'owner')
    returning id into emp_id;

    insert into public.audit_log (organization_id, actor_employee_id, actor_auth_id, action, target_type, target_id)
    values (org_id, emp_id, new.id, 'organization_created', 'organization', org_id::text);

    perform public.publish_policy_internal(org_id, emp_id);

  elsif meta ->> 'signup_type' = 'employee_activation' then
    update public.employees
    set auth_user_id = new.id
    where lower(employee_code) = lower(meta ->> 'employee_code') and auth_user_id is null
    returning id, organization_id into emp_id, org_id;

    delete from public.employee_activations where employee_id = emp_id;

    insert into public.audit_log (organization_id, actor_employee_id, actor_auth_id, action, target_type, target_id)
    values (org_id, emp_id, new.id, 'employee_activated', 'employee', emp_id::text);
  end if;
  return new;
end;
$$;

drop trigger if exists mycroscope_before_auth_user_insert on auth.users;
create trigger mycroscope_before_auth_user_insert
  before insert on auth.users
  for each row execute function public.handle_auth_user_before_insert();

drop trigger if exists mycroscope_after_auth_user_insert on auth.users;
create trigger mycroscope_after_auth_user_insert
  after insert on auth.users
  for each row execute function public.handle_auth_user_after_insert();

-- Lets the desktop agent sign in / activate with an employee code instead of an email.
create or replace function public.resolve_login_email(p_identifier text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when position('@' in coalesce(p_identifier, '')) > 0 then lower(btrim(p_identifier))
    else (select lower(email) from public.employees
          where lower(employee_code) = lower(btrim(p_identifier)) and is_active)
  end;
$$;

-- -----------------------------------------------------------------------------
-- Management RPCs (called by the mobile app / admin dashboard)
-- -----------------------------------------------------------------------------
create or replace function public.issue_activation_code(p_employee uuid)
returns table (employee_code text, activation_code text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public, extensions
as $$
#variable_conflict use_column
declare
  emp public.employees;
  code text := public.random_code(10);
  expiry timestamptz := now() + interval '7 days';
begin
  select * into emp from public.employees where id = p_employee;
  if emp.id is null or not public.is_manager_of(emp.organization_id) then
    raise exception 'Not allowed';
  end if;
  if emp.auth_user_id is not null then
    raise exception 'This employee has already activated their account. Use "forgot password" to reset it.';
  end if;

  insert into public.employee_activations (employee_id, code_hash, expires_at, created_by)
  values (emp.id, crypt(code, gen_salt('bf')), expiry, public.my_employee_id())
  on conflict (employee_id) do update
    set code_hash = excluded.code_hash, expires_at = excluded.expires_at,
        created_at = now(), created_by = excluded.created_by;

  perform public.write_audit(emp.organization_id, 'activation_code_issued', 'employee', emp.id::text);
  return query select emp.employee_code, code, expiry;
end;
$$;

create or replace function public.create_employee(
  p_name text, p_email text, p_role text default 'employee', p_employee_code text default null)
returns table (employee_id uuid, employee_code text, activation_code text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public, extensions
as $$
#variable_conflict use_column
declare
  org_id uuid := public.my_organization_id();
  my_role text := public.my_role();
  new_id uuid;
  code text;
  org_name text;
begin
  if org_id is null or my_role not in ('owner', 'manager') then
    raise exception 'Not allowed';
  end if;
  if p_role not in ('employee', 'manager') then
    raise exception 'Role must be employee or manager';
  end if;
  if p_role = 'manager' and my_role <> 'owner' then
    raise exception 'Only the owner can add managers';
  end if;
  if exists (select 1 from public.employees where lower(email) = lower(btrim(p_email))) then
    raise exception 'An account with this email already exists';
  end if;

  select name into org_name from public.organizations where id = org_id;
  code := coalesce(nullif(btrim(p_employee_code), ''), public.generate_employee_code(org_name));

  insert into public.employees (organization_id, employee_code, name, email, role)
  values (org_id, code, btrim(p_name), lower(btrim(p_email)), p_role)
  returning id into new_id;

  perform public.write_audit(org_id, 'employee_created', 'employee', new_id::text,
                             jsonb_build_object('role', p_role, 'email', lower(btrim(p_email))));

  return query
    select new_id, a.employee_code, a.activation_code, a.expires_at
    from public.issue_activation_code(new_id) a;
end;
$$;

create or replace function public.update_employee(
  p_employee uuid, p_name text default null, p_role text default null, p_is_active boolean default null)
returns public.employees
language plpgsql
security definer
set search_path = public
as $$
declare
  emp public.employees;
  my_role text := public.my_role();
  result public.employees;
begin
  select * into emp from public.employees where id = p_employee;
  if emp.id is null or not public.is_manager_of(emp.organization_id) then
    raise exception 'Not allowed';
  end if;
  if emp.role = 'owner' and my_role <> 'owner' then
    raise exception 'Only the owner can change the owner account';
  end if;
  if p_role is not null and p_role is distinct from emp.role then
    if my_role <> 'owner' then
      raise exception 'Only the owner can change roles';
    end if;
    if emp.id = public.my_employee_id() then
      raise exception 'You cannot change your own role';
    end if;
    if p_role not in ('employee', 'manager', 'owner') then
      raise exception 'Invalid role';
    end if;
  end if;
  if p_is_active is false and emp.id = public.my_employee_id() then
    raise exception 'You cannot deactivate yourself';
  end if;

  update public.employees
  set name = coalesce(nullif(btrim(p_name), ''), name),
      role = coalesce(p_role, role),
      is_active = coalesce(p_is_active, is_active)
  where id = p_employee
  returning * into result;

  perform public.write_audit(emp.organization_id, 'employee_updated', 'employee', emp.id::text,
    jsonb_build_object('before', jsonb_build_object('name', emp.name, 'role', emp.role, 'is_active', emp.is_active),
                       'after', jsonb_build_object('name', result.name, 'role', result.role, 'is_active', result.is_active)));
  return result;
end;
$$;

-- Deletes an employee and all of their activity (POPIA erasure request / leaver).
create or replace function public.delete_employee(p_employee uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  emp public.employees;
begin
  select * into emp from public.employees where id = p_employee;
  if emp.id is null or not public.is_manager_of(emp.organization_id) then
    raise exception 'Not allowed';
  end if;
  if emp.role = 'owner' then
    raise exception 'The owner account cannot be deleted';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'A reason is required';
  end if;
  perform public.write_audit(emp.organization_id, 'employee_deleted', 'employee', emp.id::text,
    jsonb_build_object('name', emp.name, 'email', emp.email, 'employee_code', emp.employee_code, 'reason', p_reason));
  delete from public.employees where id = p_employee;
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
  removed integer;
begin
  select * into emp from public.employees where id = p_employee;
  if emp.id is null or not public.is_manager_of(emp.organization_id) then
    raise exception 'Not allowed';
  end if;
  if p_to <= p_from then
    raise exception 'Invalid time range';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'A reason is required';
  end if;

  delete from public.activity_segments
  where employee_id = p_employee and started_at >= p_from and started_at < p_to;
  get diagnostics removed = row_count;

  delete from public.daily_summaries
  where employee_id = p_employee
    and day between (p_from at time zone (select timezone from public.organizations where id = emp.organization_id))::date
                and (p_to at time zone (select timezone from public.organizations where id = emp.organization_id))::date;

  perform public.write_audit(emp.organization_id, 'activity_deleted', 'employee', emp.id::text,
    jsonb_build_object('from', p_from, 'to', p_to, 'segments', removed, 'reason', p_reason));
  return removed;
end;
$$;

create or replace function public.publish_policy()
returns public.monitoring_policies
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid := public.my_organization_id();
begin
  if org_id is null or not public.is_manager_of(org_id) then
    raise exception 'Not allowed';
  end if;
  return public.publish_policy_internal(org_id, public.my_employee_id());
end;
$$;

-- Logged so that managers' access to individual monitoring data is accountable.
create or replace function public.log_data_access(p_employee uuid, p_action text, p_details jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid;
begin
  if p_action not in ('viewed_employee', 'exported_report', 'exported_data') then
    raise exception 'Invalid action';
  end if;
  select organization_id into org_id from public.employees where id = p_employee;
  if org_id is null or not public.can_view_employee(p_employee) then
    raise exception 'Not allowed';
  end if;
  if p_employee = public.my_employee_id() then
    return;
  end if;
  perform public.write_audit(org_id, p_action, 'employee', p_employee::text, p_details);
end;
$$;

-- Current notice for the signed-in user and whether they still need to acknowledge it.
create or replace function public.get_my_policy_status()
returns table (policy_id uuid, version integer, notice_text text, settings jsonb,
               acknowledged boolean, acknowledged_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.version, p.notice_text, p.settings_snapshot,
         c.id is not null, c.acknowledged_at
  from public.monitoring_policies p
  left join public.consents c on c.policy_id = p.id and c.employee_id = public.my_employee_id()
  where p.organization_id = public.my_organization_id()
  order by p.version desc
  limit 1;
$$;

-- -----------------------------------------------------------------------------
-- Reporting (security invoker: row level security decides what the caller sees)
-- -----------------------------------------------------------------------------
create or replace function public.get_daily_totals(p_employee uuid, p_from date, p_to date)
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

create or replace function public.period_bounds(p_employee uuid, p_from date, p_to date)
returns table (range_start timestamptz, range_end timestamptz)
language sql
stable
set search_path = public
as $$
  select (p_from::timestamp at time zone o.timezone), ((p_to + 1)::timestamp at time zone o.timezone)
  from public.employees e join public.organizations o on o.id = e.organization_id
  where e.id = p_employee;
$$;

create or replace function public.get_app_totals(p_employee uuid, p_from date, p_to date)
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
  where s.state in ('active', 'idle')
  group by 1
  order by 2 desc;
$$;

create or replace function public.get_domain_totals(p_employee uuid, p_from date, p_to date)
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
  where s.domain is not null and s.state in ('active', 'idle')
  group by s.domain
  order by 2 desc;
$$;

create or replace function public.get_project_totals(p_employee uuid, p_from date, p_to date)
returns table (project_id uuid, project_name text, active_seconds bigint, idle_seconds bigint)
language sql
stable
set search_path = public
as $$
  select s.project_id,
         coalesce(p.name, 'No project'),
         coalesce(sum(extract(epoch from least(s.ended_at, b.range_end) - greatest(s.started_at, b.range_start)))
                  filter (where s.state = 'active'), 0)::bigint,
         coalesce(sum(extract(epoch from least(s.ended_at, b.range_end) - greatest(s.started_at, b.range_start)))
                  filter (where s.state = 'idle'), 0)::bigint
  from public.period_bounds(p_employee, p_from, p_to) b
  join public.activity_segments s
    on s.employee_id = p_employee and s.started_at < b.range_end and s.ended_at > b.range_start
  left join public.projects p on p.id = s.project_id
  where s.state in ('active', 'idle')
  group by s.project_id, p.name
  order by 3 desc;
$$;

create or replace function public.get_timeline(p_employee uuid, p_day date)
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
  order by s.started_at;
$$;

create or replace function public.get_team_overview(p_day date default null)
returns table (employee_id uuid, name text, employee_code text, email text, role text, is_active boolean,
               activated boolean, is_online boolean, last_seen_at timestamptz, current_state text,
               current_app text, current_window_title text, current_domain text, current_project text,
               active_seconds bigint, idle_seconds bigint, away_seconds bigint, paused_seconds bigint,
               needs_acknowledgement boolean)
language sql
stable
set search_path = public
as $$
  with org as (
    select o.id, o.timezone,
           coalesce(p_day, (now() at time zone o.timezone)::date) as day
    from public.organizations o
    where o.id = public.my_organization_id() and public.is_manager_of(o.id)
  ),
  bounds as (
    select org.*, (org.day::timestamp at time zone org.timezone) as day_start,
           ((org.day + 1)::timestamp at time zone org.timezone) as day_end
    from org
  ),
  latest_policy as (
    select p.id from public.monitoring_policies p, org
    where p.organization_id = org.id order by p.version desc limit 1
  ),
  totals as (
    select s.employee_id,
           sum(extract(epoch from least(s.ended_at, b.day_end) - greatest(s.started_at, b.day_start)))
             filter (where s.state = 'active') as active_s,
           sum(extract(epoch from least(s.ended_at, b.day_end) - greatest(s.started_at, b.day_start)))
             filter (where s.state = 'idle') as idle_s,
           sum(extract(epoch from least(s.ended_at, b.day_end) - greatest(s.started_at, b.day_start)))
             filter (where s.state = 'away') as away_s,
           sum(extract(epoch from least(s.ended_at, b.day_end) - greatest(s.started_at, b.day_start)))
             filter (where s.state = 'paused') as paused_s
    from bounds b
    join public.activity_segments s
      on s.organization_id = b.id and s.started_at < b.day_end and s.ended_at > b.day_start
    group by s.employee_id
  )
  select e.id, e.name, e.employee_code, e.email, e.role, e.is_active,
         e.auth_user_id is not null,
         coalesce(st.state <> 'logged_out' and st.last_seen_at > now() - interval '2 minutes', false),
         st.last_seen_at,
         case when st.last_seen_at > now() - interval '2 minutes' then st.state else 'offline' end,
         st.app_name, st.window_title, st.domain, pr.name,
         coalesce(t.active_s, 0)::bigint, coalesce(t.idle_s, 0)::bigint,
         coalesce(t.away_s, 0)::bigint, coalesce(t.paused_s, 0)::bigint,
         not exists (select 1 from public.consents c, latest_policy lp
                     where c.employee_id = e.id and c.policy_id = lp.id)
  from org
  join public.employees e on e.organization_id = org.id
  left join public.agent_status st on st.employee_id = e.id
  left join public.projects pr on pr.id = st.project_id
  left join totals t on t.employee_id = e.id
  order by e.name;
$$;

-- -----------------------------------------------------------------------------
-- Maintenance (run nightly by pg_cron as the database owner)
-- -----------------------------------------------------------------------------
create or replace function public.refresh_daily_summaries(p_org uuid, p_day date)
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

  with clipped as (
    select s.employee_id, s.state, s.app_name, s.domain,
           greatest(s.started_at, day_start) as cs, least(s.ended_at, day_end) as ce
    from public.activity_segments s
    where s.organization_id = p_org and s.started_at < day_end and s.ended_at > day_start
  ),
  totals as (
    select employee_id,
           coalesce(sum(extract(epoch from ce - cs)) filter (where state = 'active'), 0)::integer as active_s,
           coalesce(sum(extract(epoch from ce - cs)) filter (where state = 'idle'), 0)::integer as idle_s,
           coalesce(sum(extract(epoch from ce - cs)) filter (where state = 'away'), 0)::integer as away_s,
           coalesce(sum(extract(epoch from ce - cs)) filter (where state = 'paused'), 0)::integer as paused_s,
           min(cs) filter (where state = 'active') as first_at,
           max(ce) filter (where state = 'active') as last_at
    from clipped group by employee_id
  ),
  apps as (
    select employee_id, jsonb_agg(jsonb_build_object('app_name', app_name, 'active_seconds', secs) order by secs desc) as top
    from (
      select employee_id, coalesce(app_name, 'Unknown') as app_name, sum(extract(epoch from ce - cs))::integer as secs,
             row_number() over (partition by employee_id order by sum(extract(epoch from ce - cs)) desc) as rn
      from clipped where state = 'active' group by employee_id, coalesce(app_name, 'Unknown')
    ) ranked where rn <= 10 group by employee_id
  ),
  domains as (
    select employee_id, jsonb_agg(jsonb_build_object('domain', domain, 'active_seconds', secs) order by secs desc) as top
    from (
      select employee_id, domain, sum(extract(epoch from ce - cs))::integer as secs,
             row_number() over (partition by employee_id order by sum(extract(epoch from ce - cs)) desc) as rn
      from clipped where state = 'active' and domain is not null group by employee_id, domain
    ) ranked where rn <= 10 group by employee_id
  )
  insert into public.daily_summaries (employee_id, day, organization_id, active_seconds, idle_seconds, away_seconds,
                                      paused_seconds, first_activity_at, last_activity_at, top_apps, top_domains, computed_at)
  select t.employee_id, p_day, p_org, t.active_s, t.idle_s, t.away_s, t.paused_s, t.first_at, t.last_at,
         coalesce(a.top, '[]'::jsonb), coalesce(d.top, '[]'::jsonb), now()
  from totals t
  left join apps a on a.employee_id = t.employee_id
  left join domains d on d.employee_id = t.employee_id
  on conflict (employee_id, day) do update set
    active_seconds = excluded.active_seconds, idle_seconds = excluded.idle_seconds,
    away_seconds = excluded.away_seconds, paused_seconds = excluded.paused_seconds,
    first_activity_at = excluded.first_activity_at, last_activity_at = excluded.last_activity_at,
    top_apps = excluded.top_apps, top_domains = excluded.top_domains, computed_at = now();
  get diagnostics affected = row_count;
  return affected;
end;
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
    delete from public.daily_summaries
      where organization_id = s.organization_id
        and day < (now() - make_interval(days => s.summary_retention_days))::date;
    get diagnostics n_summaries = row_count;

    if n_segments + n_events + n_sessions + n_summaries > 0 then
      insert into public.audit_log (organization_id, action, target_type, details)
      values (s.organization_id, 'retention_purge', 'organization',
              jsonb_build_object('segments', n_segments, 'events', n_events,
                                 'sessions', n_sessions, 'summaries', n_summaries,
                                 'retention_days', s.retention_days));
    end if;
  end loop;
end;
$$;

create or replace function public.run_nightly_maintenance()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  o record;
  local_today date;
begin
  -- Sessions whose agent stopped reporting (crash, power loss) are closed at their last recorded activity.
  update public.agent_sessions ses
  set ended_at = greatest(ses.started_at, coalesce(
        (select max(a.ended_at) from public.activity_segments a where a.session_id = ses.id), ses.started_at)),
      end_reason = 'stale'
  where ses.ended_at is null
    and not exists (select 1 from public.agent_status st
                    where st.employee_id = ses.employee_id and st.device_id = ses.device_id
                      and st.last_seen_at > now() - interval '30 minutes');

  for o in select id, timezone from public.organizations loop
    local_today := (now() at time zone o.timezone)::date;
    perform public.refresh_daily_summaries(o.id, local_today - 1);
    perform public.refresh_daily_summaries(o.id, local_today - 2);
  end loop;

  perform public.purge_expired_data();
end;
$$;

-- -----------------------------------------------------------------------------
-- Row level security
-- -----------------------------------------------------------------------------
alter table public.organizations enable row level security;
alter table public.organization_settings enable row level security;
alter table public.employees enable row level security;
alter table public.employee_activations enable row level security;
alter table public.projects enable row level security;
alter table public.devices enable row level security;
alter table public.agent_sessions enable row level security;
alter table public.activity_segments enable row level security;
alter table public.agent_status enable row level security;
alter table public.agent_events enable row level security;
alter table public.monitoring_policies enable row level security;
alter table public.consents enable row level security;
alter table public.audit_log enable row level security;
alter table public.daily_summaries enable row level security;

-- organizations
create policy organizations_select on public.organizations for select to authenticated
  using (id = public.my_organization_id());
create policy organizations_update on public.organizations for update to authenticated
  using (public.is_manager_of(id)) with check (public.is_manager_of(id));

-- organization_settings
create policy settings_select on public.organization_settings for select to authenticated
  using (organization_id = public.my_organization_id());
create policy settings_update on public.organization_settings for update to authenticated
  using (public.is_manager_of(organization_id)) with check (public.is_manager_of(organization_id));

-- employees: writes go through the management RPCs only
create policy employees_select on public.employees for select to authenticated
  using (public.can_view_employee(id));

-- projects
create policy projects_select on public.projects for select to authenticated
  using (organization_id = public.my_organization_id());
create policy projects_insert on public.projects for insert to authenticated
  with check (organization_id = public.my_organization_id() and created_by = public.my_employee_id());
create policy projects_update on public.projects for update to authenticated
  using (public.is_manager_of(organization_id)) with check (public.is_manager_of(organization_id));

-- devices
create policy devices_select on public.devices for select to authenticated
  using (public.can_view_employee(employee_id));
create policy devices_insert on public.devices for insert to authenticated
  with check (employee_id = public.my_employee_id() and organization_id = public.my_organization_id());
create policy devices_update on public.devices for update to authenticated
  using (employee_id = public.my_employee_id())
  with check (employee_id = public.my_employee_id() and organization_id = public.my_organization_id());

-- agent_sessions
create policy agent_sessions_select on public.agent_sessions for select to authenticated
  using (public.can_view_employee(employee_id));
create policy agent_sessions_insert on public.agent_sessions for insert to authenticated
  with check (employee_id = public.my_employee_id() and organization_id = public.my_organization_id()
              and public.owns_device(device_id));
create policy agent_sessions_update on public.agent_sessions for update to authenticated
  using (employee_id = public.my_employee_id())
  with check (employee_id = public.my_employee_id() and organization_id = public.my_organization_id()
              and public.owns_device(device_id));

-- activity_segments: own data only, recent only, and only after consent
create policy activity_segments_select on public.activity_segments for select to authenticated
  using (public.can_view_employee(employee_id));
create policy activity_segments_insert on public.activity_segments for insert to authenticated
  with check (employee_id = public.my_employee_id()
              and organization_id = public.my_organization_id()
              and public.owns_device(device_id)
              and started_at > now() - interval '14 days'
              and public.has_consented_before(started_at));
create policy activity_segments_update on public.activity_segments for update to authenticated
  using (employee_id = public.my_employee_id() and received_at > now() - interval '2 days')
  with check (employee_id = public.my_employee_id()
              and organization_id = public.my_organization_id()
              and public.owns_device(device_id)
              and public.has_consented_before(started_at));

-- agent_status
create policy agent_status_select on public.agent_status for select to authenticated
  using (public.can_view_employee(employee_id));
create policy agent_status_insert on public.agent_status for insert to authenticated
  with check (employee_id = public.my_employee_id() and organization_id = public.my_organization_id());
create policy agent_status_update on public.agent_status for update to authenticated
  using (employee_id = public.my_employee_id())
  with check (employee_id = public.my_employee_id() and organization_id = public.my_organization_id());

-- agent_events
create policy agent_events_select on public.agent_events for select to authenticated
  using (public.can_view_employee(employee_id));
create policy agent_events_insert on public.agent_events for insert to authenticated
  with check (employee_id = public.my_employee_id() and organization_id = public.my_organization_id()
              and occurred_at > now() - interval '14 days');

-- monitoring_policies: inserts via publish functions only
create policy monitoring_policies_select on public.monitoring_policies for select to authenticated
  using (organization_id = public.my_organization_id());

-- consents
create policy consents_select on public.consents for select to authenticated
  using (public.can_view_employee(employee_id));
create policy consents_insert on public.consents for insert to authenticated
  with check (employee_id = public.my_employee_id()
              and organization_id = public.my_organization_id()
              and acknowledged_at between now() - interval '5 minutes' and now() + interval '5 minutes'
              and exists (select 1 from public.monitoring_policies p
                          where p.id = policy_id and p.organization_id = public.my_organization_id()));

-- audit_log: managers read, nobody writes directly
create policy audit_log_select on public.audit_log for select to authenticated
  using (public.is_manager_of(organization_id));

-- daily_summaries
create policy daily_summaries_select on public.daily_summaries for select to authenticated
  using (public.can_view_employee(employee_id));

-- -----------------------------------------------------------------------------
-- Privileges
-- -----------------------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke insert, update, delete on public.employees, public.employee_activations, public.monitoring_policies,
  public.audit_log, public.daily_summaries from authenticated;
revoke delete on public.organizations, public.organization_settings, public.projects, public.devices,
  public.agent_sessions, public.activity_segments, public.agent_status, public.agent_events,
  public.consents from authenticated;
revoke all on public.employee_activations from authenticated;

revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
revoke execute on function
  public.publish_policy_internal(uuid, uuid),
  public.refresh_daily_summaries(uuid, date),
  public.purge_expired_data(),
  public.run_nightly_maintenance(),
  public.handle_auth_user_before_insert(),
  public.handle_auth_user_after_insert(),
  public.settings_after_update(),
  public.organizations_after_update(),
  public.generate_employee_code(text),
  public.write_audit(uuid, text, text, text, jsonb)
from authenticated;
grant execute on function public.resolve_login_email(text) to anon;

-- -----------------------------------------------------------------------------
-- Realtime (live dashboard) and nightly schedule. Both are optional extras:
-- the migration still succeeds if they are unavailable.
-- -----------------------------------------------------------------------------
do $$
begin
  alter publication supabase_realtime add table public.agent_status, public.activity_segments;
exception when others then
  raise notice 'Realtime publication not configured: %', sqlerrm;
end;
$$;

do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule('mycroscope-nightly', '15 0 * * *', 'select public.run_nightly_maintenance()');
exception when others then
  raise notice 'pg_cron not available (enable it under Database -> Extensions, then run: select cron.schedule(''mycroscope-nightly'', ''15 0 * * *'', ''select public.run_nightly_maintenance()'');): %', sqlerrm;
end;
$$;
