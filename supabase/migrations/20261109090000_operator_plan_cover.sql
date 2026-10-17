-- A control-panel plan change does not take a payment. It still behaves like a paid
-- subscription: the plan's features apply, and the people already on the account keep
-- a seat for one year. Someone a manager turned off stays off. Customers still pay
-- to change their own plan.

alter table public.subscriptions drop constraint if exists subscriptions_seats_check;
alter table public.subscriptions add constraint subscriptions_seats_check
  check (seats between 0 and 100000);

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
  covered integer;
  in_force integer;
  shortfall integer;
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
    update public.subscription_seats
    set ended_at = coalesce(ended_at, now())
    where organization_id = p_org and ended_at is null;
    update public.subscriptions set seats = 3 where organization_id = p_org;
    select * into result from public.subscriptions where organization_id = p_org;
  else
    -- The seat cap is the only automatic deactivation. A manager's own choice is an
    -- employee update whose latest active flag is false.
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

    select count(*)::integer into covered
    from public.employees e
    where e.organization_id = p_org and e.is_active;
    if covered < 1 then
      covered := 1;
    end if;

    select count(*)::integer into in_force
    from public.subscription_seats ss
    where ss.organization_id = p_org and ss.ended_at is null and ss.period_end > now();
    shortfall := covered - in_force;
    if shortfall > 0 then
      insert into public.subscription_seats (organization_id, period_start, period_end)
      select p_org, now(), now() + interval '1 year'
      from generate_series(1, shortfall);
      if in_force = 0 then
        update public.subscriptions
        set current_period_start = now()
        where organization_id = p_org;
      end if;
    end if;
    perform public.sync_purchased_seats(p_org);
    select * into result from public.subscriptions where organization_id = p_org;
  end if;

  perform public.write_operator_audit('subscription_updated', p_org,
    jsonb_build_object('before', to_jsonb(before_row) - 'paystack_email_token',
                       'after', to_jsonb(result) - 'paystack_email_token', 'note', p_note));
  insert into public.audit_log (organization_id, actor_auth_id, action, target_type, target_id, details)
  values (p_org, auth.uid(), 'subscription_changed_by_provider', 'organization', p_org::text,
          jsonb_build_object('plan', result.plan, 'status', result.status, 'seats', result.seats, 'note', p_note));
  return result;
end;
$$;
