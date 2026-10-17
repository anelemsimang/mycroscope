-- A privileged account can add seats without a payment. Removing privilege in the
-- control panel stops that. Seats already added stay until their own end date.
-- Paying accounts still buy seats through checkout.

alter table public.subscription_seats
  add column if not exists granted boolean not null default false;

create or replace function public.add_granted_seats(p_seats integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  org uuid := public.my_organization_id();
  grant_until timestamptz;
begin
  if org is null or not exists (
    select 1 from public.employees e
    where e.auth_user_id = auth.uid() and e.organization_id = org and e.role = 'owner' and e.is_active
  ) then
    raise exception 'Only the organisation owner can change seats' using errcode = '42501';
  end if;
  if exists (select 1 from public.organization_settings os where os.organization_id = org and os.require_mfa)
     and coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'Your organisation requires two-factor login. Sign in with your code first.' using errcode = '42501';
  end if;
  if not public.operator_grant_active(org) then
    raise exception 'Buy seats from the billing page.' using errcode = '42501';
  end if;
  if p_seats is null or p_seats < 1 or p_seats > 10000 then
    raise exception 'Choose how many seats to add';
  end if;
  select g.until into grant_until
  from public.operator_grants g
  where g.organization_id = org;
  insert into public.subscription_seats (organization_id, period_start, period_end, granted)
  select org, now(), grant_until
  from generate_series(1, p_seats);
  perform public.sync_purchased_seats(org);
  insert into public.audit_log (organization_id, actor_auth_id, action, target_type, target_id, details)
  values (org, auth.uid(), 'seats_added', 'organization', org::text,
          jsonb_build_object('seats', p_seats, 'until', grant_until));
end;
$$;

create or replace function public.op_remove_operator_grant(p_org uuid, p_note text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_platform_admin();
  if coalesce(btrim(p_note), '') = '' then
    raise exception 'A note explaining the change is required';
  end if;
  if not exists (select 1 from public.operator_grants g where g.organization_id = p_org) then
    raise exception 'This organisation has no privilege';
  end if;
  delete from public.operator_grants where organization_id = p_org;
  perform public.sync_purchased_seats(p_org);
  perform public.enforce_seat_cap(p_org);
  perform public.write_operator_audit('privilege_removed', p_org,
    jsonb_build_object('note', p_note));
  insert into public.audit_log (organization_id, actor_auth_id, action, target_type, target_id, details)
  values (p_org, auth.uid(), 'subscription_changed_by_provider', 'organization', p_org::text,
          jsonb_build_object('note', p_note));
end;
$$;

-- Saving the same plan again must not put privilege back after it was removed.
-- Privilege is assigned only when the control panel changes the plan.
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

revoke execute on function
  public.add_granted_seats(integer),
  public.op_remove_operator_grant(uuid, text)
from public, anon;

grant execute on function
  public.add_granted_seats(integer),
  public.op_remove_operator_grant(uuid, text)
to authenticated;

notify pgrst, 'reload schema';
