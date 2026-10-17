-- A control-panel plan change is stored apart from payments. The rest of the app
-- treats that account as paid for one year, including the plan's unlimited seats.
-- A later real payment uses the normal purchased-seat rules from that payment on.

alter table public.subscriptions drop constraint if exists subscriptions_seats_check;
alter table public.subscriptions add constraint subscriptions_seats_check
  check (seats between 0 and 100000);

create table if not exists public.operator_grants (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  plan_key text not null,
  granted_at timestamptz not null default now(),
  until timestamptz not null
);

alter table public.operator_grants enable row level security;
revoke all on public.operator_grants from public, anon, authenticated;

create or replace function public.operator_grant_active(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.operator_grants g
    where g.organization_id = p_org
      and g.until > now()
      and not exists (
        select 1 from public.payments p
        where p.organization_id = p_org and p.paid_at > g.granted_at
      )
  );
$$;

revoke execute on function public.operator_grant_active(uuid) from public, anon, authenticated;

create or replace function public.seat_limit(s public.subscriptions)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select case
    when coalesce(p.net_price_cents, 0) = 0 then p.seat_cap
    when public.operator_grant_active(s.organization_id) then null
    else (
      select count(*)::integer from public.subscription_seats ss
      where ss.organization_id = s.organization_id
        and ss.ended_at is null
        and ss.period_end > now()
    )
  end
  from public.plans p
  where p.key = public.effective_plan(s);
$$;

create or replace function public.sync_purchased_seats(p_org uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.subscription_seats
  set ended_at = period_end
  where organization_id = p_org and ended_at is null and period_end <= now();

  update public.subscriptions s
  set seats = (
        select count(*)::integer from public.subscription_seats ss
        where ss.organization_id = p_org and ss.ended_at is null and ss.period_end > now()
      ),
      current_period_end = case
        when public.operator_grant_active(p_org) then s.current_period_end
        else coalesce(
          (select max(ss.period_end) from public.subscription_seats ss
           where ss.organization_id = p_org and ss.ended_at is null and ss.period_end > now()),
          s.current_period_end)
      end
  where s.organization_id = p_org
    and exists (
      select 1 from public.plans p
      where p.key = s.plan and p.net_price_cents > 0
    );
end;
$$;

create or replace function public.clear_operator_grant_on_free()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.plan = 'free' and old.plan is distinct from 'free' then
    delete from public.operator_grants where organization_id = new.organization_id;
  end if;
  return new;
end;
$$;

drop trigger if exists subscriptions_clear_operator_grant on public.subscriptions;
create trigger subscriptions_clear_operator_grant
  after update of plan on public.subscriptions
  for each row execute function public.clear_operator_grant_on_free();

create or replace function public.get_my_service_status()
returns table (
  level text, status text, plan text, current_period_end timestamptz,
  grace_until timestamptz, seats integer, seats_used integer, require_mfa boolean,
  seat_cap integer, cancel_at_period_end boolean, pending_plan text, next_seat_end timestamptz)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  org uuid := public.my_organization_id();
begin
  if org is not null then
    perform public.ensure_billing_state(org);
  end if;
  return query
  select public.subscription_level(s), s.status, s.plan, s.current_period_end,
         case when s.status in ('active', 'past_due') and s.current_period_end is not null
              then s.current_period_end + make_interval(days => (select grace_days from public.billing_config)) end,
         s.seats,
         (select count(*)::integer from public.employees e where e.organization_id = s.organization_id and e.is_active),
         coalesce((select os.require_mfa from public.organization_settings os where os.organization_id = s.organization_id), false),
         public.seat_limit(s),
         s.cancel_at_period_end,
         s.pending_plan,
         (select min(ss.period_end) from public.subscription_seats ss
          where ss.organization_id = s.organization_id and ss.ended_at is null and ss.period_end > now())
  from public.subscriptions s
  where s.organization_id = org;
end;
$$;

create or replace function public.op_update_subscription(
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
  paid boolean;
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
      cancelled_at = case when coalesce(p_status, status) = 'cancelled' then coalesce(cancelled_at, now()) else null end,
      pending_plan = case when p_plan is not null and p_plan is distinct from before_row.plan then null else pending_plan end,
      cancel_at_period_end = case when p_plan is not null and p_plan is distinct from before_row.plan then false else cancel_at_period_end end
  where organization_id = p_org
  returning * into result;

  select coalesce(p.net_price_cents, 0) > 0 into paid
  from public.plans p where p.key = result.plan;

  if result.plan = 'free' or not coalesce(paid, false) then
    delete from public.operator_grants where organization_id = p_org;
    update public.subscription_seats
    set ended_at = coalesce(ended_at, now())
    where organization_id = p_org and ended_at is null;
    update public.subscriptions set seats = 3 where organization_id = p_org;
    select * into result from public.subscriptions where organization_id = p_org;
  elsif p_plan is not null and p_plan is distinct from before_row.plan then
    if coalesce(p_status, '') not in ('suspended', 'cancelled') then
      update public.subscriptions
      set status = 'active',
          current_period_start = now(),
          current_period_end = now() + interval '1 year',
          pending_plan = null,
          cancel_at_period_end = false,
          cancelled_at = null
      where organization_id = p_org;
    else
      update public.subscriptions
      set current_period_start = now(),
          current_period_end = now() + interval '1 year',
          pending_plan = null,
          cancel_at_period_end = false
      where organization_id = p_org;
    end if;
    insert into public.operator_grants (organization_id, plan_key, granted_at, until)
    values (p_org, result.plan, now(), now() + interval '1 year')
    on conflict (organization_id) do update
    set plan_key = excluded.plan_key, granted_at = excluded.granted_at, until = excluded.until;

    with latest as (
      select distinct on (a.target_id)
             a.target_id,
             a.details #>> '{after,is_active}' as active
      from public.audit_log a
      where a.organization_id = p_org
        and a.action = 'employee_updated'
        and a.details #>> '{after,is_active}' in ('true', 'false')
      order by a.target_id, a.created_at desc
    )
    update public.employees e
    set is_active = true
    where e.organization_id = p_org
      and not e.is_active
      and not exists (
        select 1 from latest l
        where l.target_id = e.id::text and l.active = 'false'
      );
    select * into result from public.subscriptions where organization_id = p_org;
  end if;

  perform public.write_operator_audit('subscription_updated', p_org,
    jsonb_build_object('before', to_jsonb(before_row) - 'paystack_email_token',
                       'after', to_jsonb(result) - 'paystack_email_token', 'note', p_note,
                       'granted', public.operator_grant_active(p_org)));
  insert into public.audit_log (organization_id, actor_auth_id, action, target_type, target_id, details)
  values (p_org, auth.uid(), 'subscription_changed_by_provider', 'organization', p_org::text,
          jsonb_build_object('plan', result.plan, 'status', result.status, 'note', p_note));
  return result;
end;
$$;

drop function public.op_organizations();
create function public.op_organizations()
returns table (organization_id uuid, name text, created_at timestamptz, owner_name text, owner_email text,
               plan text, status text, level text, seats integer, active_employees integer,
               activated_employees integer, agents_online integer, last_activity_at timestamptz,
               current_period_end timestamptz, support_access_until timestamptz, granted boolean)
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
          where g.organization_id = o.id and g.revoked_at is null and g.expires_at > now()),
         public.operator_grant_active(o.id)
  from public.organizations o
  left join public.subscriptions s on s.organization_id = o.id
  left join lateral (select e.name, e.email from public.employees e
                     where e.organization_id = o.id and e.role = 'owner' order by e.created_at limit 1) ow on true
  order by o.created_at desc;
end;
$$;

revoke execute on function public.op_organizations() from public, anon;
grant execute on function public.op_organizations() to authenticated;

notify pgrst, 'reload schema';
