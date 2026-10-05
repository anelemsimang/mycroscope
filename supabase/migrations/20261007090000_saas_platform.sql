-- =============================================================================
-- Mycroscope: SaaS platform features
--   * Working-hours schedule, after-hours flag, integrity (tamper) checks, MFA requirement
--   * Productivity categories
--   * Subscriptions, trials, seat limits and service levels
--   * Platform operator console with customer-approved ("break-glass") support access
--   * Teams (department-scoped managers)
--   * POPIA data subject requests
--   * Integrity alerts, maintenance run log
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Session helpers
-- -----------------------------------------------------------------------------
-- Authenticator assurance level of the current request ('aal2' after a second-factor check).
create or replace function public.session_aal()
returns text
language sql
stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'aal', 'aal1');
$$;

-- -----------------------------------------------------------------------------
-- Settings: schedule, integrity checks, MFA
-- -----------------------------------------------------------------------------
alter table public.organization_settings
  add column tracking_schedule text not null default 'always' check (tracking_schedule in ('always', 'work_hours')),
  add column work_days smallint[] not null default '{1,2,3,4,5}'
    check (cardinality(work_days) between 1 and 7 and work_days <@ '{1,2,3,4,5,6,7}'::smallint[]),
  add column work_start time not null default '08:00',
  add column work_end time not null default '17:00',
  add column flag_after_hours_use boolean not null default false,
  add column detect_tampering boolean not null default true,
  add column require_mfa boolean not null default false,
  add constraint organization_settings_work_hours_differ check (work_end <> work_start);

-- Managers' rights depend on a second factor when the organisation requires it.
create or replace function public.mfa_ok(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.session_aal() = 'aal2'
      or not coalesce((select require_mfa from public.organization_settings where organization_id = p_org), false);
$$;

-- True when p_at falls inside the organisation's working hours (end before start = overnight shift).
create or replace function public.is_work_time(p_org uuid, p_at timestamptz)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when s.work_start < s.work_end then
      extract(isodow from l.lt)::smallint = any (s.work_days) and l.lt::time >= s.work_start and l.lt::time < s.work_end
    else
      (extract(isodow from l.lt)::smallint = any (s.work_days) and l.lt::time >= s.work_start)
      or (extract(isodow from l.lt - interval '1 day')::smallint = any (s.work_days) and l.lt::time < s.work_end)
  end
  from public.organization_settings s
  join public.organizations o on o.id = s.organization_id
  cross join lateral (select (p_at at time zone o.timezone) as lt) l
  where s.organization_id = p_org;
$$;

-- -----------------------------------------------------------------------------
-- Teams (department-scoped managers)
-- -----------------------------------------------------------------------------
create table public.teams (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 100),
  created_at timestamptz not null default now()
);
create unique index teams_org_name_key on public.teams (organization_id, lower(name));

create table public.team_managers (
  team_id uuid not null references public.teams (id) on delete cascade,
  employee_id uuid not null references public.employees (id) on delete cascade,
  primary key (team_id, employee_id)
);
create index team_managers_employee_idx on public.team_managers (employee_id);

alter table public.employees add column team_id uuid references public.teams (id) on delete set null;
create index employees_team_idx on public.employees (team_id);

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
      and organization_id = p_org and role in ('owner', 'manager'))
    and public.mfa_ok(p_org);
$$;

-- Owners see everyone; a manager assigned to teams sees those teams; a manager without teams sees everyone.
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
           or (me.organization_id = target.organization_id
               and public.mfa_ok(me.organization_id)
               and (me.role = 'owner'
                    or (me.role = 'manager'
                        and (not exists (select 1 from public.team_managers tm where tm.employee_id = me.id)
                             or exists (select 1 from public.team_managers tm
                                        where tm.employee_id = me.id and tm.team_id = target.team_id)))))));
$$;

create or replace function public.can_manage_employee(p_employee uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.can_view_employee(p_employee)
     and public.is_manager_of((select organization_id from public.employees where id = p_employee));
$$;

-- -----------------------------------------------------------------------------
-- Subscriptions and service levels
-- -----------------------------------------------------------------------------
create table public.subscriptions (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  plan text not null default 'trial' check (plan in ('trial', 'standard', 'business', 'enterprise')),
  status text not null default 'trialing' check (status in ('trialing', 'active', 'past_due', 'cancelled', 'suspended')),
  seats integer not null default 25 check (seats between 1 and 100000),
  trial_ends_at timestamptz,
  current_period_end timestamptz,
  grace_days integer not null default 14 check (grace_days between 0 and 90),
  price_per_seat_cents integer check (price_per_seat_cents >= 0),
  currency text not null default 'ZAR',
  paystack_customer_code text,
  paystack_subscription_code text,
  paystack_email_token text,
  billing_email text,
  cancelled_at timestamptz,
  notes text,
  updated_at timestamptz not null default now()
);

create trigger subscriptions_touch before update on public.subscriptions
  for each row execute function public.touch_updated_at();

insert into public.subscriptions (organization_id, trial_ends_at)
select id, now() + interval '14 days' from public.organizations
on conflict do nothing;

-- full: everything works. read_only: data can be viewed and exported, nothing new is recorded or added.
create or replace function public.subscription_level(s public.subscriptions)
returns text
language sql
stable
as $$
  select case
    when s.organization_id is null then 'read_only'
    when s.status = 'suspended' then 'read_only'
    when s.status = 'trialing' then case when coalesce(s.trial_ends_at, now()) > now() then 'full' else 'read_only' end
    when s.status = 'active' then
      case when s.current_period_end is null or s.current_period_end + make_interval(days => s.grace_days) > now()
           then 'full' else 'read_only' end
    when s.status = 'past_due' then
      case when coalesce(s.current_period_end, now()) + make_interval(days => s.grace_days) > now()
           then 'full' else 'read_only' end
    else 'read_only'
  end;
$$;

create or replace function public.org_service_level(p_org uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select public.subscription_level(s) from public.subscriptions s where s.organization_id = p_org;
$$;

create or replace function public.org_accepts_data(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.org_service_level(p_org) = 'full', false);
$$;

create or replace function public.get_my_service_status()
returns table (level text, status text, plan text, trial_ends_at timestamptz, current_period_end timestamptz,
               grace_until timestamptz, seats integer, seats_used integer, require_mfa boolean)
language sql
stable
security definer
set search_path = public
as $$
  select public.subscription_level(s), s.status, s.plan, s.trial_ends_at, s.current_period_end,
         case when s.status in ('active', 'past_due') and s.current_period_end is not null
              then s.current_period_end + make_interval(days => s.grace_days) end,
         s.seats,
         (select count(*)::integer from public.employees e where e.organization_id = s.organization_id and e.is_active),
         coalesce((select os.require_mfa from public.organization_settings os where os.organization_id = s.organization_id), false)
  from public.subscriptions s
  where s.organization_id = public.my_organization_id();
$$;

-- Payments confirmed by the Paystack webhook (written with the service role only).
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  provider text not null default 'paystack',
  reference text not null unique,
  amount_cents integer not null check (amount_cents >= 0),
  currency text not null,
  seats integer not null check (seats > 0),
  months integer not null check (months > 0),
  paid_at timestamptz not null default now(),
  raw jsonb not null default '{}'::jsonb
);
create index payments_org_idx on public.payments (organization_id, paid_at desc);

-- Applies a verified payment exactly once (Paystack retries webhooks). Returns false if already applied.
create or replace function public.apply_payment(
  p_org uuid, p_reference text, p_amount_cents integer, p_currency text, p_seats integer, p_months integer,
  p_customer_code text, p_raw jsonb)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.payments (organization_id, reference, amount_cents, currency, seats, months, raw)
  values (p_org, p_reference, p_amount_cents, p_currency, p_seats, p_months, coalesce(p_raw, '{}'::jsonb))
  on conflict (reference) do nothing;
  if not found then
    return false;
  end if;
  update public.subscriptions
  set status = case when status = 'suspended' then status else 'active' end,
      plan = case when plan = 'trial' then 'standard' else plan end,
      seats = p_seats,
      current_period_end = greatest(coalesce(current_period_end, now()), now()) + make_interval(months => p_months),
      paystack_customer_code = coalesce(p_customer_code, paystack_customer_code),
      cancelled_at = null
  where organization_id = p_org;
  insert into public.audit_log (organization_id, action, target_type, target_id, details)
  values (p_org, 'payment_received', 'organization', p_org::text,
          jsonb_build_object('reference', p_reference, 'amount_cents', p_amount_cents, 'currency', p_currency,
                             'seats', p_seats, 'months', p_months));
  return true;
end;
$$;

-- Backstop: the agent stops recording when the service is not 'full'; the database refuses new activity too.
drop policy activity_segments_insert on public.activity_segments;
create policy activity_segments_insert on public.activity_segments for insert to authenticated
  with check (employee_id = public.my_employee_id()
              and organization_id = public.my_organization_id()
              and public.owns_device(device_id)
              and started_at > now() - interval '14 days'
              and public.has_consented_before(started_at)
              and public.org_accepts_data(organization_id));

-- -----------------------------------------------------------------------------
-- Platform operators (the SaaS provider). No access to activity data; customer-approved support access.
-- -----------------------------------------------------------------------------
create table public.platform_admins (
  auth_user_id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  created_at timestamptz not null default now()
);

-- Insert an email here (SQL editor), then create or sign up that user: it becomes an operator.
create table public.platform_admin_invites (
  email text primary key check (email = lower(btrim(email))),
  created_at timestamptz not null default now()
);

create table public.operator_audit_log (
  id bigint generated always as identity primary key,
  operator_auth_id uuid,
  operator_email text,
  action text not null,
  organization_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.support_access_grants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  granted_by uuid references public.employees (id) on delete set null,
  reason text not null check (length(btrim(reason)) between 3 and 1000),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index support_access_grants_org_idx on public.support_access_grants (organization_id, expires_at desc);

-- Signed-in user is an operator (used by the app to show the operator console).
create or replace function public.am_i_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.platform_admins where auth_user_id = auth.uid());
$$;

-- Operator privileges additionally require a second factor.
create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.am_i_platform_admin() and public.session_aal() = 'aal2';
$$;

create or replace function public.require_platform_admin()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.am_i_platform_admin() then
    raise exception 'Not allowed';
  end if;
  if public.session_aal() <> 'aal2' then
    raise exception 'Two-factor verification is required for the operator console';
  end if;
end;
$$;

create or replace function public.write_operator_audit(p_action text, p_org uuid, p_details jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.operator_audit_log (operator_auth_id, operator_email, action, organization_id, details)
  values (auth.uid(), (select email from public.platform_admins where auth_user_id = auth.uid()),
          p_action, p_org, coalesce(p_details, '{}'::jsonb));
$$;

create or replace function public.op_organizations()
returns table (organization_id uuid, name text, created_at timestamptz, owner_name text, owner_email text,
               plan text, status text, level text, seats integer, active_employees integer,
               activated_employees integer, agents_online integer, last_activity_at timestamptz,
               trial_ends_at timestamptz, current_period_end timestamptz, support_access_until timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.require_platform_admin();
  return query
  select o.id, o.name, o.created_at, ow.name, ow.email,
         s.plan, s.status, public.subscription_level(s), s.seats,
         (select count(*)::integer from public.employees e where e.organization_id = o.id and e.is_active),
         (select count(*)::integer from public.employees e where e.organization_id = o.id and e.is_active and e.auth_user_id is not null),
         (select count(*)::integer from public.agent_status st
          where st.organization_id = o.id and st.state <> 'logged_out' and st.last_seen_at > now() - interval '2 minutes'),
         (select max(st.last_seen_at) from public.agent_status st where st.organization_id = o.id),
         s.trial_ends_at, s.current_period_end,
         (select max(g.expires_at) from public.support_access_grants g
          where g.organization_id = o.id and g.revoked_at is null and g.expires_at > now())
  from public.organizations o
  left join public.subscriptions s on s.organization_id = o.id
  left join lateral (select e.name, e.email from public.employees e
                     where e.organization_id = o.id and e.role = 'owner' order by e.created_at limit 1) ow on true
  order by o.created_at desc;
end;
$$;

create or replace function public.op_update_subscription(
  p_org uuid, p_plan text, p_status text, p_seats integer, p_trial_ends_at timestamptz,
  p_current_period_end timestamptz, p_note text)
returns public.subscriptions
language plpgsql
security definer
set search_path = public
as $$
declare
  before_row public.subscriptions;
  result public.subscriptions;
begin
  perform public.require_platform_admin();
  if coalesce(btrim(p_note), '') = '' then
    raise exception 'A note explaining the change is required';
  end if;
  select * into before_row from public.subscriptions where organization_id = p_org;
  if before_row.organization_id is null then
    raise exception 'Organisation not found';
  end if;
  update public.subscriptions
  set plan = coalesce(p_plan, plan),
      status = coalesce(p_status, status),
      seats = coalesce(p_seats, seats),
      trial_ends_at = coalesce(p_trial_ends_at, trial_ends_at),
      current_period_end = coalesce(p_current_period_end, current_period_end),
      cancelled_at = case when coalesce(p_status, status) = 'cancelled' then coalesce(cancelled_at, now()) else null end
  where organization_id = p_org
  returning * into result;

  perform public.write_operator_audit('subscription_updated', p_org,
    jsonb_build_object('before', to_jsonb(before_row) - 'paystack_email_token',
                       'after', to_jsonb(result) - 'paystack_email_token', 'note', p_note));
  insert into public.audit_log (organization_id, actor_auth_id, action, target_type, target_id, details)
  values (p_org, auth.uid(), 'subscription_changed_by_provider', 'organization', p_org::text,
          jsonb_build_object('plan', result.plan, 'status', result.status, 'seats', result.seats, 'note', p_note));
  return result;
end;
$$;

create table public.maintenance_runs (
  id bigint generated always as identity primary key,
  ran_at timestamptz not null default now(),
  duration_ms integer,
  details jsonb not null default '{}'::jsonb
);

create or replace function public.op_system_health()
returns table (organizations integer, paying_organizations integer, trialing_organizations integer,
               active_employees integer, agents_online integer, segments_last_24h bigint,
               last_maintenance_at timestamptz, open_data_requests integer)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.require_platform_admin();
  return query
  select (select count(*)::integer from public.organizations),
         (select count(*)::integer from public.subscriptions s where s.status = 'active'),
         (select count(*)::integer from public.subscriptions s where s.status = 'trialing'),
         (select count(*)::integer from public.employees e where e.is_active),
         (select count(*)::integer from public.agent_status st
          where st.state <> 'logged_out' and st.last_seen_at > now() - interval '2 minutes'),
         (select count(*) from public.activity_segments a where a.received_at > now() - interval '24 hours'),
         (select max(m.ran_at) from public.maintenance_runs m),
         (select count(*)::integer from public.data_requests d where d.status in ('open', 'in_progress'));
end;
$$;

create or replace function public.op_operator_audit(p_limit integer default 100)
returns setof public.operator_audit_log
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.require_platform_admin();
  return query select * from public.operator_audit_log order by id desc limit least(greatest(p_limit, 1), 500);
end;
$$;

-- Support view of a customer: technical status only (no activity content), and only while the customer allows it.
create or replace function public.op_support_snapshot(p_org uuid)
returns table (employee_id uuid, name text, role text, is_active boolean, activated boolean,
               agent_version text, agent_state text, last_seen_at timestamptz, hostname text,
               os_version text, needs_acknowledgement boolean, recent_problems jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  grant_row public.support_access_grants;
begin
  perform public.require_platform_admin();
  select * into grant_row from public.support_access_grants
  where organization_id = p_org and revoked_at is null and expires_at > now()
  order by expires_at desc limit 1;
  if grant_row.id is null then
    raise exception 'The customer has not granted support access';
  end if;

  perform public.write_operator_audit('support_snapshot_viewed', p_org, jsonb_build_object('grant', grant_row.id));
  insert into public.audit_log (organization_id, actor_auth_id, action, target_type, target_id, details)
  values (p_org, auth.uid(), 'support_access_used', 'organization', p_org::text,
          jsonb_build_object('grant', grant_row.id, 'view', 'technical status'));

  return query
  select e.id, e.name, e.role, e.is_active, e.auth_user_id is not null,
         st.agent_version, st.state, st.last_seen_at, d.hostname, d.os_version,
         not exists (select 1 from public.consents c
                     where c.employee_id = e.id
                       and c.policy_id = (select p.id from public.monitoring_policies p
                                          where p.organization_id = p_org order by p.version desc limit 1)),
         coalesce((select jsonb_agg(jsonb_build_object('at', ev.occurred_at, 'type', ev.event_type) order by ev.occurred_at desc)
                   from (select * from public.agent_events ev2
                         where ev2.employee_id = e.id and ev2.occurred_at > now() - interval '7 days'
                           and ev2.event_type in ('data_rejected', 'clock_skew', 'agent_gap')
                         order by ev2.occurred_at desc limit 10) ev), '[]'::jsonb)
  from public.employees e
  left join public.agent_status st on st.employee_id = e.id
  left join lateral (select dv.hostname, dv.os_version from public.devices dv
                     where dv.employee_id = e.id order by dv.last_seen_at desc limit 1) d on true
  where e.organization_id = p_org
  order by e.name;
end;
$$;

-- Permanently deletes a cancelled customer and all of its data.
create or replace function public.op_delete_organization(p_org uuid, p_confirm_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  org public.organizations;
  sub public.subscriptions;
  account_ids uuid[];
begin
  perform public.require_platform_admin();
  select * into org from public.organizations where id = p_org;
  select * into sub from public.subscriptions where organization_id = p_org;
  if org.id is null then
    raise exception 'Organisation not found';
  end if;
  if coalesce(sub.status, '') <> 'cancelled' then
    raise exception 'Only cancelled organisations can be deleted';
  end if;
  if p_confirm_name is distinct from org.name then
    raise exception 'Type the organisation name exactly to confirm';
  end if;
  select array_agg(e.auth_user_id) into account_ids
  from public.employees e where e.organization_id = p_org and e.auth_user_id is not null;

  perform public.write_operator_audit('organization_deleted', p_org,
    jsonb_build_object('name', org.name, 'cancelled_at', sub.cancelled_at, 'accounts', coalesce(cardinality(account_ids), 0)));
  delete from public.organizations where id = p_org;

  -- Sign-in accounts: remove too where the database role may (otherwise delete them under Authentication -> Users).
  begin
    delete from auth.users where id = any (coalesce(account_ids, '{}'));
  exception when insufficient_privilege then
    raise notice 'Organisation deleted; remove its % sign-in account(s) under Authentication -> Users', cardinality(account_ids);
  end;
end;
$$;

-- Customer side: the owner grants or revokes time-limited support access.
create or replace function public.grant_support_access(p_hours integer, p_reason text)
returns public.support_access_grants
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid := public.my_organization_id();
  result public.support_access_grants;
begin
  if org_id is null or public.my_role() <> 'owner' or not public.mfa_ok(org_id) then
    raise exception 'Only the owner can grant support access';
  end if;
  if p_hours is null or p_hours not between 1 and 72 then
    raise exception 'Support access can be granted for 1 to 72 hours';
  end if;
  insert into public.support_access_grants (organization_id, granted_by, reason, expires_at)
  values (org_id, public.my_employee_id(), btrim(p_reason), now() + make_interval(hours => p_hours))
  returning * into result;
  perform public.write_audit(org_id, 'support_access_granted', 'organization', org_id::text,
    jsonb_build_object('hours', p_hours, 'reason', btrim(p_reason), 'expires_at', result.expires_at));
  return result;
end;
$$;

create or replace function public.revoke_support_access()
returns void
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
  update public.support_access_grants set revoked_at = now()
  where organization_id = org_id and revoked_at is null and expires_at > now();
  perform public.write_audit(org_id, 'support_access_revoked', 'organization', org_id::text, '{}'::jsonb);
end;
$$;

-- -----------------------------------------------------------------------------
-- Sign-up: operator invites, trials
-- -----------------------------------------------------------------------------
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
  if exists (select 1 from public.platform_admin_invites i where i.email = lower(new.email)) then
    return new;
  end if;

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
  if exists (select 1 from public.platform_admin_invites i where i.email = lower(new.email)) then
    insert into public.platform_admins (auth_user_id, email) values (new.id, lower(new.email));
    delete from public.platform_admin_invites where email = lower(new.email);
    insert into public.operator_audit_log (operator_auth_id, operator_email, action)
    values (new.id, lower(new.email), 'operator_created');
    return new;
  end if;

  if meta ->> 'signup_type' = 'owner' then
    insert into public.organizations (name)
    values (btrim(meta ->> 'organization_name'))
    returning id into org_id;

    insert into public.organization_settings (organization_id) values (org_id);
    insert into public.subscriptions (organization_id, trial_ends_at, billing_email)
    values (org_id, now() + interval '14 days', lower(new.email));

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

-- -----------------------------------------------------------------------------
-- Employee management, scoped to the manager's teams and limited by seats
-- -----------------------------------------------------------------------------
drop function public.create_employee(text, text, text, text);

create function public.create_employee(
  p_name text, p_email text, p_role text default 'employee', p_employee_code text default null,
  p_team_id uuid default null)
returns table (employee_id uuid, employee_code text, activation_code text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public, extensions
as $$
#variable_conflict use_column
declare
  org_id uuid := public.my_organization_id();
  my_role text := public.my_role();
  me uuid := public.my_employee_id();
  team uuid := p_team_id;
  new_id uuid;
  code text;
  org_name text;
  sub public.subscriptions;
begin
  if org_id is null or not public.is_manager_of(org_id) then
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

  select * into sub from public.subscriptions where organization_id = org_id;
  if public.subscription_level(sub) <> 'full' then
    raise exception 'Your subscription is not active. Renew it to add employees.';
  end if;
  if (select count(*) from public.employees e where e.organization_id = org_id and e.is_active) >= sub.seats then
    raise exception 'All % seats on your plan are in use. Add seats or deactivate someone first.', sub.seats;
  end if;

  if team is not null and not exists (select 1 from public.teams t where t.id = team and t.organization_id = org_id) then
    raise exception 'Unknown team';
  end if;
  if my_role = 'manager' and exists (select 1 from public.team_managers tm where tm.employee_id = me) then
    if team is null then
      select tm.team_id into team from public.team_managers tm where tm.employee_id = me limit 1;
    elsif not exists (select 1 from public.team_managers tm where tm.employee_id = me and tm.team_id = team) then
      raise exception 'You can only add people to your own teams';
    end if;
  end if;

  select name into org_name from public.organizations where id = org_id;
  code := coalesce(nullif(btrim(p_employee_code), ''), public.generate_employee_code(org_name));

  insert into public.employees (organization_id, employee_code, name, email, role, team_id)
  values (org_id, code, btrim(p_name), lower(btrim(p_email)), p_role, team)
  returning id into new_id;

  perform public.write_audit(org_id, 'employee_created', 'employee', new_id::text,
                             jsonb_build_object('role', p_role, 'email', lower(btrim(p_email)), 'team', team));

  return query
    select new_id, a.employee_code, a.activation_code, a.expires_at
    from public.issue_activation_code(new_id) a;
end;
$$;

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
  if emp.id is null or not public.can_manage_employee(emp.id) then
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
  sub public.subscriptions;
begin
  select * into emp from public.employees where id = p_employee;
  if emp.id is null or not public.can_manage_employee(emp.id) then
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
  if p_is_active is true and not emp.is_active then
    select * into sub from public.subscriptions where organization_id = emp.organization_id;
    if (select count(*) from public.employees e where e.organization_id = emp.organization_id and e.is_active) >= sub.seats then
      raise exception 'All % seats on your plan are in use. Add seats first.', sub.seats;
    end if;
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
  if emp.id is null or not public.can_manage_employee(emp.id) then
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
  if emp.id is null or not public.can_manage_employee(emp.id) then
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

-- Teams management (owner only)
create or replace function public.save_team(p_team uuid, p_name text)
returns public.teams
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid := public.my_organization_id();
  result public.teams;
begin
  if org_id is null or public.my_role() <> 'owner' or not public.mfa_ok(org_id) then
    raise exception 'Only the owner can manage teams';
  end if;
  if p_team is null then
    insert into public.teams (organization_id, name) values (org_id, btrim(p_name)) returning * into result;
  else
    update public.teams set name = btrim(p_name) where id = p_team and organization_id = org_id returning * into result;
    if result.id is null then
      raise exception 'Unknown team';
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
begin
  if org_id is null or public.my_role() <> 'owner' or not public.mfa_ok(org_id) then
    raise exception 'Only the owner can manage teams';
  end if;
  delete from public.teams where id = p_team and organization_id = org_id returning name into team_name;
  if team_name is null then
    raise exception 'Unknown team';
  end if;
  perform public.write_audit(org_id, 'team_deleted', 'team', p_team::text, jsonb_build_object('name', team_name));
end;
$$;

create or replace function public.set_employee_team(p_employee uuid, p_team uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid := public.my_organization_id();
  emp public.employees;
begin
  if org_id is null or public.my_role() <> 'owner' or not public.mfa_ok(org_id) then
    raise exception 'Only the owner can move people between teams';
  end if;
  select * into emp from public.employees where id = p_employee and organization_id = org_id;
  if emp.id is null then
    raise exception 'Unknown employee';
  end if;
  if p_team is not null and not exists (select 1 from public.teams where id = p_team and organization_id = org_id) then
    raise exception 'Unknown team';
  end if;
  update public.employees set team_id = p_team where id = p_employee;
  perform public.write_audit(org_id, 'employee_team_changed', 'employee', p_employee::text,
    jsonb_build_object('from', emp.team_id, 'to', p_team));
end;
$$;

create or replace function public.set_team_managers(p_team uuid, p_managers uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid := public.my_organization_id();
begin
  if org_id is null or public.my_role() <> 'owner' or not public.mfa_ok(org_id) then
    raise exception 'Only the owner can assign team managers';
  end if;
  if not exists (select 1 from public.teams where id = p_team and organization_id = org_id) then
    raise exception 'Unknown team';
  end if;
  if exists (select 1 from unnest(coalesce(p_managers, '{}')) m
             where not exists (select 1 from public.employees e
                               where e.id = m and e.organization_id = org_id and e.role = 'manager')) then
    raise exception 'Team managers must be managers in your organisation';
  end if;
  delete from public.team_managers where team_id = p_team;
  insert into public.team_managers (team_id, employee_id) select p_team, m from unnest(coalesce(p_managers, '{}')) m;
  perform public.write_audit(org_id, 'team_managers_changed', 'team', p_team::text,
    jsonb_build_object('managers', coalesce(p_managers, '{}')));
end;
$$;

-- -----------------------------------------------------------------------------
-- Productivity categories
-- -----------------------------------------------------------------------------
create table public.app_categories (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  kind text not null check (kind in ('app', 'domain')),
  pattern text not null check (length(pattern) between 1 and 200 and pattern = lower(btrim(pattern))),
  category text not null check (category in ('productive', 'neutral', 'unproductive')),
  created_by uuid references public.employees (id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index app_categories_key on public.app_categories (organization_id, kind, pattern);

-- A website rule also matches its subdomains (youtube.com matches m.youtube.com). Website rules win over app rules.
create or replace function public.category_of(p_org uuid, p_app text, p_domain text)
returns text
language sql
stable
set search_path = public
as $$
  select coalesce(
    (select c.category from public.app_categories c
     where c.organization_id = p_org and c.kind = 'domain' and p_domain is not null
       and (lower(p_domain) = c.pattern or right(lower(p_domain), length(c.pattern) + 1) = '.' || c.pattern)
     order by length(c.pattern) desc limit 1),
    (select c.category from public.app_categories c
     where c.organization_id = p_org and c.kind = 'app' and p_app is not null and lower(p_app) = c.pattern
     limit 1),
    'uncategorised');
$$;

create or replace function public.set_app_category(p_kind text, p_pattern text, p_category text)
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
  if p_kind = 'domain' then
    norm := regexp_replace(regexp_replace(norm, '^[a-z]+://', ''), '^www\.', '');
    norm := split_part(norm, '/', 1);
  end if;
  insert into public.app_categories (organization_id, kind, pattern, category, created_by)
  values (org_id, p_kind, norm, p_category, public.my_employee_id())
  on conflict (organization_id, kind, pattern) do update set category = excluded.category
  returning * into result;
  perform public.write_audit(org_id, 'category_set', 'app_category', result.id::text,
    jsonb_build_object('kind', p_kind, 'pattern', norm, 'category', p_category));
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
  delete from public.app_categories where id = p_id and organization_id = org_id returning * into row_;
  if row_.id is not null then
    perform public.write_audit(org_id, 'category_removed', 'app_category', p_id::text,
      jsonb_build_object('kind', row_.kind, 'pattern', row_.pattern));
  end if;
end;
$$;

create or replace function public.get_category_totals(p_employee uuid, p_from date, p_to date, p_project uuid default null)
returns table (category text, active_seconds bigint, idle_seconds bigint)
language sql
stable
set search_path = public
as $$
  select public.category_of(s.organization_id, s.app_name, s.domain),
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
-- POPIA data subject requests
-- -----------------------------------------------------------------------------
create table public.data_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  employee_id uuid not null references public.employees (id) on delete cascade,
  kind text not null check (kind in ('access', 'correction', 'objection', 'deletion', 'other')),
  message text not null check (length(btrim(message)) between 1 and 4000),
  status text not null default 'open' check (status in ('open', 'in_progress', 'completed', 'rejected')),
  response text check (response is null or length(response) <= 4000),
  handled_by uuid references public.employees (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index data_requests_org_idx on public.data_requests (organization_id, created_at desc);

create trigger data_requests_touch before update on public.data_requests
  for each row execute function public.touch_updated_at();

create or replace function public.submit_data_request(p_kind text, p_message text)
returns public.data_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.my_employee_id();
  org_id uuid := public.my_organization_id();
  result public.data_requests;
begin
  if me is null then
    raise exception 'Not allowed';
  end if;
  if (select count(*) from public.data_requests where employee_id = me and created_at > now() - interval '1 day') >= 5 then
    raise exception 'You have sent several requests today. Please wait for a response.';
  end if;
  insert into public.data_requests (organization_id, employee_id, kind, message)
  values (org_id, me, p_kind, btrim(p_message))
  returning * into result;
  perform public.write_audit(org_id, 'data_request_submitted', 'data_request', result.id::text,
    jsonb_build_object('kind', p_kind));
  return result;
end;
$$;

create or replace function public.respond_data_request(p_request uuid, p_status text, p_response text)
returns public.data_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  req public.data_requests;
  result public.data_requests;
begin
  select * into req from public.data_requests where id = p_request;
  if req.id is null or not public.can_manage_employee(req.employee_id) or req.employee_id = public.my_employee_id() then
    raise exception 'Not allowed';
  end if;
  if p_status not in ('in_progress', 'completed', 'rejected') then
    raise exception 'Invalid status';
  end if;
  if p_status in ('completed', 'rejected') and coalesce(btrim(p_response), '') = '' then
    raise exception 'Write a response to the employee';
  end if;
  update public.data_requests
  set status = p_status, response = nullif(btrim(p_response), ''), handled_by = public.my_employee_id()
  where id = p_request
  returning * into result;
  perform public.write_audit(req.organization_id, 'data_request_' || p_status, 'data_request', req.id::text,
    jsonb_build_object('employee', req.employee_id, 'kind', req.kind));
  return result;
end;
$$;

-- -----------------------------------------------------------------------------
-- Agent events, live states
-- -----------------------------------------------------------------------------
alter table public.agent_events drop constraint agent_events_event_type_check;
alter table public.agent_events add constraint agent_events_event_type_check check (event_type in (
  'login', 'logout', 'pause', 'resume', 'project_switch', 'sleep', 'wake',
  'lock', 'unlock', 'agent_start', 'agent_stop', 'clock_skew', 'data_rejected',
  'agent_gap', 'vm_detected', 'remote_session', 'input_anomaly', 'after_hours_use',
  'work_hours_start', 'work_hours_end', 'service_inactive'));

alter table public.agent_status drop constraint agent_status_state_check;
alter table public.agent_status add constraint agent_status_state_check check (state in (
  'active', 'idle', 'away', 'paused', 'logged_out', 'off_hours', 'inactive'));

create index agent_events_org_time_idx on public.agent_events (organization_id, occurred_at desc);

-- Things a manager should look at: integrity events, and people not reporting during working hours.
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
           when ev.event_type in ('agent_gap', 'vm_detected', 'remote_session', 'input_anomaly') then 'medium'
           else 'low'
         end,
         ev.details
  from me
  join public.agent_events ev on ev.organization_id = me.organization_id
  join public.employees e on e.id = ev.employee_id
  where ev.occurred_at >= p_since
    and ev.event_type in ('agent_gap', 'vm_detected', 'remote_session', 'input_anomaly', 'clock_skew', 'after_hours_use')
    and public.can_view_employee(e.id)
    and public.is_manager_of(me.organization_id)
  union all
  select e.id, e.name, st.last_seen_at, 'not_reporting', 'low',
         jsonb_build_object('last_state', st.state, 'minutes', round(extract(epoch from now() - st.last_seen_at) / 60))
  from me
  join public.employees e on e.organization_id = me.organization_id and e.is_active and e.auth_user_id is not null
  join public.agent_status st on st.employee_id = e.id
  where public.is_work_time(me.organization_id, now())
    and st.last_seen_at < now() - interval '30 minutes'
    and st.last_seen_at > now() - interval '7 days'
    and public.can_view_employee(e.id)
    and public.is_manager_of(me.organization_id)
  order by 3 desc
  limit 500;
$$;

-- -----------------------------------------------------------------------------
-- Team overview (team-scoped, with team names)
-- -----------------------------------------------------------------------------
drop function public.get_team_overview(date);

create function public.get_team_overview(p_day date default null)
returns table (employee_id uuid, name text, employee_code text, email text, role text, is_active boolean,
               activated boolean, is_online boolean, last_seen_at timestamptz, current_state text,
               current_app text, current_window_title text, current_domain text, current_project text,
               active_seconds bigint, idle_seconds bigint, away_seconds bigint, paused_seconds bigint,
               needs_acknowledgement boolean, team_id uuid, team_name text)
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
         coalesce(st.state not in ('logged_out', 'inactive') and st.last_seen_at > now() - interval '2 minutes', false),
         st.last_seen_at,
         case when st.last_seen_at > now() - interval '2 minutes' then st.state else 'offline' end,
         st.app_name, st.window_title, st.domain, pr.name,
         coalesce(t.active_s, 0)::bigint, coalesce(t.idle_s, 0)::bigint,
         coalesce(t.away_s, 0)::bigint, coalesce(t.paused_s, 0)::bigint,
         not exists (select 1 from public.consents c, latest_policy lp
                     where c.employee_id = e.id and c.policy_id = lp.id),
         e.team_id, tm.name
  from org
  join public.employees e on e.organization_id = org.id
  left join public.agent_status st on st.employee_id = e.id
  left join public.projects pr on pr.id = st.project_id
  left join public.teams tm on tm.id = e.team_id
  left join totals t on t.employee_id = e.id
  where public.can_view_employee(e.id)
  order by e.name;
$$;

-- -----------------------------------------------------------------------------
-- Monitoring notice: schedule and integrity checks are part of what employees are told
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
E'MONITORING NOTICE - %1$s\n\n%2$s\n\nWHAT IS RECORDED\nWhile you are logged in to Mycroscope on this computer, %1$s records:%3$s\n\nWHEN\n%8$s\n\nWHAT IS NOT RECORDED\nKeystrokes (what you type), screenshots, screen recordings, webcam or microphone, file contents, and the contents of emails or messages.\n\nWHY\nTo understand how working time is spent, to allocate time to projects, and to manage productivity and the proper use of company equipment.\n\nYOUR CONTROL\nA Mycroscope icon is shown in the system tray whenever monitoring is active. %4$s%9$s\n\nWHO CAN SEE IT\nOwners and managers of %1$s. You can view your own recorded activity from the Mycroscope tray icon.\n\nHOW LONG IT IS KEPT\nDetailed activity is deleted after %5$s days. Daily totals are kept for %6$s days.\n\nYOUR RIGHTS\nUnder the Protection of Personal Information Act, 2013 (POPIA) you may ask to access or correct your information and you may object to the processing. Contact %7$s, or send a request from the Mycroscope app. You may also lodge a complaint with the Information Regulator (https://inforegulator.org.za).\n\nThis notice is also given for the purposes of the Regulation of Interception of Communications and Provision of Communication-Related Information Act, 2002 (RICA). By selecting "I acknowledge" you confirm that you have read this notice and consent to the monitoring described above.',
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

-- Requiring two-factor login for managers is not something employees need to re-acknowledge.
create or replace function public.settings_after_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  ignored text[] := array['updated_at', 'updated_by'];
begin
  if (to_jsonb(old) - ignored) is distinct from (to_jsonb(new) - ignored) then
    insert into public.audit_log (organization_id, actor_employee_id, actor_auth_id, action, target_type, target_id, details)
    values (new.organization_id, public.my_employee_id(), auth.uid(), 'settings_updated', 'organization_settings',
            new.organization_id::text,
            jsonb_build_object('before', to_jsonb(old) - ignored, 'after', to_jsonb(new) - ignored));
    if (to_jsonb(old) - ignored - 'require_mfa') is distinct from (to_jsonb(new) - ignored - 'require_mfa') then
      perform public.publish_policy_internal(new.organization_id, public.my_employee_id());
    end if;
  end if;
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Saving compliance settings (all keys optional; missing keys keep their value)
-- -----------------------------------------------------------------------------
drop function public.save_compliance_settings(boolean, boolean, boolean, boolean, integer, boolean,
  integer, integer, text, text, text);

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
-- Nightly maintenance: record each run
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
  end loop;

  perform public.purge_expired_data();

  delete from public.maintenance_runs where ran_at < now() - interval '90 days';
  insert into public.maintenance_runs (duration_ms, details)
  values ((extract(epoch from clock_timestamp() - started) * 1000)::integer,
          jsonb_build_object('stale_sessions_closed', stale));
end;
$$;

-- -----------------------------------------------------------------------------
-- Email notifications. Sent by the notify-managers edge function (service role). Emails carry counts only:
-- no names or activity details, because email is not protected by the app's sign-in and two-factor checks.
-- -----------------------------------------------------------------------------
create table public.notification_preferences (
  employee_id uuid primary key references public.employees (id) on delete cascade,
  weekly_digest boolean not null default true,
  alert_emails boolean not null default true,
  updated_at timestamptz not null default now()
);

create table public.email_runs (
  kind text primary key check (kind in ('digest', 'alerts')),
  last_run_at timestamptz not null
);

create or replace function public.get_my_notification_preferences()
returns table (weekly_digest boolean, alert_emails boolean)
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(p.weekly_digest, true), coalesce(p.alert_emails, true)
  from public.employees e
  left join public.notification_preferences p on p.employee_id = e.id
  where e.id = public.my_employee_id();
$$;

create or replace function public.set_my_notification_preferences(p_weekly_digest boolean, p_alert_emails boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.my_employee_id();
begin
  if me is null then
    raise exception 'Not signed in';
  end if;
  insert into public.notification_preferences (employee_id, weekly_digest, alert_emails)
  values (me, coalesce(p_weekly_digest, true), coalesce(p_alert_emails, true))
  on conflict (employee_id) do update
  set weekly_digest = excluded.weekly_digest, alert_emails = excluded.alert_emails, updated_at = now();
end;
$$;

-- Same rule as can_view_employee, for a given viewer instead of the signed-in user.
create or replace function public.employees_visible_to(p_viewer uuid)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select t.id
  from public.employees me
  join public.employees t on t.organization_id = me.organization_id
  where me.id = p_viewer and me.is_active
    and (me.role = 'owner'
         or (me.role = 'manager'
             and (not exists (select 1 from public.team_managers tm where tm.employee_id = me.id)
                  or exists (select 1 from public.team_managers tm where tm.employee_id = me.id and tm.team_id = t.team_id))));
$$;

-- Records this run and returns when the previous one happened (or now - p_default on the first run).
create or replace function public.claim_email_window(p_kind text, p_default interval)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  prev timestamptz;
begin
  select last_run_at into prev from public.email_runs where kind = p_kind for update;
  insert into public.email_runs (kind, last_run_at) values (p_kind, now())
  on conflict (kind) do update set last_run_at = now();
  return greatest(coalesce(prev, now() - p_default), now() - interval '8 days');
end;
$$;

create or replace function public.email_digest_batch()
returns table (recipient_email text, recipient_name text, role text, organization_name text,
               week_start date, week_end date, people integer, activated integer, active_seconds bigint,
               idle_seconds bigint, person_days integer, integrity_alerts integer, high_alerts integer,
               open_requests integer)
language sql
stable
security definer
set search_path = public
as $$
  with recipients as (
    select m.id, m.email, m.name, m.role, o.id as org_id, o.name as org_name,
           (now() at time zone o.timezone)::date - 7 as wk_start,
           (now() at time zone o.timezone)::date - 1 as wk_end
    from public.employees m
    join public.organizations o on o.id = m.organization_id
    join public.subscriptions s on s.organization_id = o.id
    left join public.notification_preferences np on np.employee_id = m.id
    where m.is_active and m.role in ('owner', 'manager') and m.auth_user_id is not null
      and coalesce(np.weekly_digest, true)
      and public.subscription_level(s) = 'full'
  ),
  scoped as (
    select r.*, array(select public.employees_visible_to(r.id)) as visible from recipients r
  )
  select s.email, s.name, s.role, s.org_name, s.wk_start, s.wk_end,
         (select count(*)::integer from public.employees t where t.id = any(s.visible) and t.is_active),
         (select count(*)::integer from public.employees t
          where t.id = any(s.visible) and t.is_active and t.auth_user_id is not null),
         (select coalesce(sum(d.active_seconds), 0)::bigint from public.daily_summaries d
          where d.employee_id = any(s.visible) and d.day between s.wk_start and s.wk_end),
         (select coalesce(sum(d.idle_seconds), 0)::bigint from public.daily_summaries d
          where d.employee_id = any(s.visible) and d.day between s.wk_start and s.wk_end),
         (select count(*)::integer from public.daily_summaries d
          where d.employee_id = any(s.visible) and d.day between s.wk_start and s.wk_end and d.active_seconds > 0),
         (select count(*)::integer from public.agent_events ev
          where ev.organization_id = s.org_id and ev.employee_id = any(s.visible)
            and ev.occurred_at >= now() - interval '7 days'
            and ev.event_type in ('agent_gap', 'vm_detected', 'remote_session', 'input_anomaly')),
         (select count(*)::integer from public.agent_events ev
          where ev.organization_id = s.org_id and ev.employee_id = any(s.visible)
            and ev.occurred_at >= now() - interval '7 days'
            and ev.event_type = 'agent_gap' and coalesce((ev.details ->> 'minutes')::numeric, 0) >= 10),
         (select count(*)::integer from public.data_requests dr
          where dr.organization_id = s.org_id and dr.employee_id = any(s.visible)
            and dr.status in ('open', 'in_progress'))
  from scoped s;
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
  counted as (
    select r.email, r.name, r.org_name,
           count(ev.*)::integer as alerts,
           count(ev.*) filter (where ev.event_type = 'agent_gap'
                                 and coalesce((ev.details ->> 'minutes')::numeric, 0) >= 10)::integer as high_alerts
    from recipients r
    join public.agent_events ev on ev.organization_id = r.org_id and ev.employee_id = any(r.visible)
    where ev.occurred_at >= p_since
      and ev.event_type in ('agent_gap', 'vm_detected', 'remote_session', 'input_anomaly')
    group by r.email, r.name, r.org_name
  )
  select * from counted where alerts > 0;
$$;

-- -----------------------------------------------------------------------------
-- Row level security for new tables
-- -----------------------------------------------------------------------------
alter table public.teams enable row level security;
alter table public.team_managers enable row level security;
alter table public.subscriptions enable row level security;
alter table public.platform_admins enable row level security;
alter table public.platform_admin_invites enable row level security;
alter table public.operator_audit_log enable row level security;
alter table public.support_access_grants enable row level security;
alter table public.app_categories enable row level security;
alter table public.data_requests enable row level security;
alter table public.maintenance_runs enable row level security;
alter table public.payments enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.email_runs enable row level security;

create policy payments_select on public.payments for select to authenticated
  using (public.is_manager_of(organization_id));
create policy teams_select on public.teams for select to authenticated
  using (organization_id = public.my_organization_id());
create policy team_managers_select on public.team_managers for select to authenticated
  using (exists (select 1 from public.teams t where t.id = team_id and t.organization_id = public.my_organization_id()));
create policy subscriptions_select on public.subscriptions for select to authenticated
  using (public.is_manager_of(organization_id));
create policy platform_admins_select_self on public.platform_admins for select to authenticated
  using (auth_user_id = auth.uid());
create policy support_access_grants_select on public.support_access_grants for select to authenticated
  using (public.is_manager_of(organization_id));
create policy app_categories_select on public.app_categories for select to authenticated
  using (organization_id = public.my_organization_id());
create policy data_requests_select on public.data_requests for select to authenticated
  using (employee_id = public.my_employee_id() or public.can_manage_employee(employee_id));

-- -----------------------------------------------------------------------------
-- Privileges
-- -----------------------------------------------------------------------------
revoke all on public.teams, public.team_managers, public.subscriptions, public.platform_admins,
  public.platform_admin_invites, public.operator_audit_log, public.support_access_grants,
  public.app_categories, public.data_requests, public.maintenance_runs, public.payments from anon;
revoke insert, update, delete on public.teams, public.team_managers, public.subscriptions, public.platform_admins,
  public.platform_admin_invites, public.operator_audit_log, public.support_access_grants,
  public.app_categories, public.data_requests, public.maintenance_runs, public.payments from authenticated;
revoke all on public.platform_admin_invites, public.operator_audit_log, public.maintenance_runs,
  public.notification_preferences, public.email_runs from anon, authenticated;

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
  public.write_audit(uuid, text, text, text, jsonb),
  public.write_operator_audit(text, uuid, jsonb),
  public.org_service_level(uuid),
  public.subscription_level(public.subscriptions),
  public.is_work_time(uuid, timestamptz),
  public.apply_payment(uuid, text, integer, text, integer, integer, text, jsonb),
  public.employees_visible_to(uuid),
  public.claim_email_window(text, interval),
  public.email_digest_batch(),
  public.email_alert_batch(timestamptz)
from authenticated;
grant execute on function public.resolve_login_email(text) to anon;
grant execute on function
  public.apply_payment(uuid, text, integer, text, integer, integer, text, jsonb),
  public.claim_email_window(text, interval),
  public.email_digest_batch(),
  public.email_alert_batch(timestamptz)
to service_role;

notify pgrst, 'reload schema';
