-- Mycroscope: remove the 14-day trial and case studies.
-- The free plan stays. Every existing organisation is moved onto it.
-- People are not deactivated and activity rows are not deleted here.
-- Run after 20261027090000_advisor_digest.sql.

-- -----------------------------------------------------------------------------
-- Existing organisations
-- -----------------------------------------------------------------------------
update public.subscriptions
set plan = 'free',
    status = case when status = 'trialing' then 'active' else status end,
    seats = least(seats, 3);

-- Companies keep the history length they already chose. A later migration hides
-- activity outside the current plan and only deletes history past the longest plan.

alter table public.subscriptions drop constraint subscriptions_plan_check;
alter table public.subscriptions add constraint subscriptions_plan_check
  check (plan in ('free', 'standard', 'business', 'enterprise'));

do $$
declare
  cname text;
begin
  select con.conname into cname
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'subscriptions'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%trialing%';
  if cname is not null then
    execute format('alter table public.subscriptions drop constraint %I', cname);
  end if;
end $$;

alter table public.subscriptions add constraint subscriptions_status_check
  check (status in ('active', 'past_due', 'cancelled', 'suspended'));

alter table public.subscriptions alter column plan set default 'free';
alter table public.subscriptions alter column status set default 'active';

-- -----------------------------------------------------------------------------
-- Plan rules. Trial is no longer a plan.
-- -----------------------------------------------------------------------------
create or replace function public.plan_features(p_plan text)
returns text[]
language sql
immutable
as $$
  select case p_plan
    when 'free' then array[]::text[]
    when 'standard' then array['team_categories', 'team_schedules', 'trends', 'alert_rules', 'channels', 'work_location']
    when 'business' then array['team_categories', 'team_schedules', 'trends', 'alert_rules', 'channels', 'work_location', 'ai_tools', 'work_advisor',
                               'goals', 'workload', 'software_usage', 'file_activity', 'api']
    when 'enterprise' then array['team_categories', 'team_schedules', 'trends', 'alert_rules', 'channels', 'work_location', 'ai_tools', 'work_advisor',
                                 'goals', 'workload', 'software_usage', 'file_activity', 'api']
    else array[]::text[]
  end;
$$;

create or replace function public.effective_plan(s public.subscriptions)
returns text
language sql
stable
as $$
  select case
    when s.organization_id is null then 'free'
    when s.plan = 'free' then 'free'
    else s.plan
  end;
$$;

create or replace function public.subscription_level(s public.subscriptions)
returns text
language sql
stable
as $$
  select case
    when s.organization_id is null then 'read_only'
    when s.status = 'suspended' then 'read_only'
    when s.status = 'active' then
      case when s.current_period_end is null or s.current_period_end + make_interval(days => s.grace_days) > now()
           then 'full' else 'read_only' end
    when s.status = 'past_due' then
      case when coalesce(s.current_period_end, now()) + make_interval(days => s.grace_days) > now()
           then 'full' else 'read_only' end
    else 'read_only'
  end;
$$;

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
      plan = case when plan = 'free' then 'standard' else plan end,
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

-- New companies start on the free plan: 3 people, 30 days of detailed activity.
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

    insert into public.organization_settings (organization_id, retention_days) values (org_id, 30);
    insert into public.subscriptions (organization_id, plan, status, seats, billing_email)
    values (org_id, 'free', 'active', 3, lower(new.email));

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

drop function public.convert_expired_trials();

-- -----------------------------------------------------------------------------
-- Case studies
-- -----------------------------------------------------------------------------
drop trigger if exists employees_case_study_invite on public.employees;

drop function public.op_set_case_study(uuid, integer, text);
drop function public.op_invite_case_study(text, integer, text);
drop function public.op_case_study_invites();
drop function public.op_cancel_case_study_invite(text);
drop function public.start_case_study(uuid, integer);
drop function public.apply_case_study_invite();

drop table public.case_study_invites;

-- Return types change, so these are recreated without trial or case-study fields.
drop function public.get_my_service_status();
create function public.get_my_service_status()
returns table (level text, status text, plan text, current_period_end timestamptz,
               grace_until timestamptz, seats integer, seats_used integer, require_mfa boolean)
language sql
stable
security definer
set search_path = public
as $$
  select public.subscription_level(s), s.status, s.plan, s.current_period_end,
         case when s.status in ('active', 'past_due') and s.current_period_end is not null
              then s.current_period_end + make_interval(days => s.grace_days) end,
         s.seats,
         (select count(*)::integer from public.employees e where e.organization_id = s.organization_id and e.is_active),
         coalesce((select os.require_mfa from public.organization_settings os where os.organization_id = s.organization_id), false)
  from public.subscriptions s
  where s.organization_id = public.my_organization_id();
$$;

drop function public.op_organizations();
create function public.op_organizations()
returns table (organization_id uuid, name text, created_at timestamptz, owner_name text, owner_email text,
               plan text, status text, level text, seats integer, active_employees integer,
               activated_employees integer, agents_online integer, last_activity_at timestamptz,
               current_period_end timestamptz, support_access_until timestamptz)
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
         s.current_period_end,
         (select max(g.expires_at) from public.support_access_grants g
          where g.organization_id = o.id and g.revoked_at is null and g.expires_at > now())
  from public.organizations o
  left join public.subscriptions s on s.organization_id = o.id
  left join lateral (select e.name, e.email from public.employees e
                     where e.organization_id = o.id and e.role = 'owner' order by e.created_at limit 1) ow on true
  order by o.created_at desc;
end;
$$;

drop function public.op_update_subscription(uuid, text, text, integer, timestamptz, timestamptz, text);
create function public.op_update_subscription(
  p_org uuid, p_plan text, p_status text, p_seats integer,
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

drop function public.op_system_health();
create function public.op_system_health()
returns table (organizations integer, paying_organizations integer, free_organizations integer,
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
         (select count(*)::integer from public.subscriptions s where s.status = 'active' and s.plan <> 'free'),
         (select count(*)::integer from public.subscriptions s where s.plan = 'free'),
         (select count(*)::integer from public.employees e where e.is_active),
         (select count(*)::integer from public.agent_status st
          where st.state <> 'logged_out' and st.last_seen_at > now() - interval '2 minutes'),
         (select count(*) from public.activity_segments a where a.received_at > now() - interval '24 hours'),
         (select max(m.ran_at) from public.maintenance_runs m),
         (select count(*)::integer from public.data_requests d where d.status in ('open', 'in_progress'));
end;
$$;

alter table public.subscriptions drop column trial_ends_at;
alter table public.subscriptions drop column case_study_until;

revoke execute on function
  public.get_my_service_status(),
  public.op_organizations(),
  public.op_update_subscription(uuid, text, text, integer, timestamptz, text),
  public.op_system_health()
from public, anon;

grant execute on function
  public.get_my_service_status(),
  public.op_organizations(),
  public.op_update_subscription(uuid, text, text, integer, timestamptz, text),
  public.op_system_health()
to authenticated;

notify pgrst, 'reload schema';
