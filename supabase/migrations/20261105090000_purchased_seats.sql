-- Seats are purchased, not counted from whoever is active on the day of payment.
-- A seat bought later has its own year and its own VAT. Removing it waits until that seat's end date.

create table public.subscription_seats (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  period_start timestamptz not null,
  period_end timestamptz not null,
  cancel_at_period_end boolean not null default false,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  check (period_end > period_start)
);
create index subscription_seats_org_idx on public.subscription_seats (organization_id, period_end);

alter table public.checkout_intents drop constraint if exists checkout_intents_kind_check;
alter table public.checkout_intents add constraint checkout_intents_kind_check
  check (kind in ('new', 'renewal', 'upgrade', 'seats'));

-- Seats already paid for keep the period recorded on the subscription.
insert into public.subscription_seats (organization_id, period_start, period_end)
select s.organization_id,
       coalesce(s.current_period_start, s.current_period_end - interval '1 year'),
       s.current_period_end
from public.subscriptions s
join public.plans p on p.key = s.plan
cross join lateral generate_series(1, s.seats) as g(n)
where p.net_price_cents > 0
  and s.seats > 0
  and s.current_period_end is not null
  and s.current_period_end > now()
  and s.status in ('active', 'past_due');

alter table public.subscription_seats enable row level security;
revoke all on public.subscription_seats from public, anon, authenticated;
grant select on public.subscription_seats to authenticated;
create policy subscription_seats_select on public.subscription_seats
  for select to authenticated
  using (organization_id = public.my_organization_id());

-- Closes seats whose year has ended, then stores the count and the latest end date.
create function public.sync_purchased_seats(p_org uuid)
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
      current_period_end = coalesce(
        (select max(ss.period_end) from public.subscription_seats ss
         where ss.organization_id = p_org and ss.ended_at is null and ss.period_end > now()),
        s.current_period_end)
  where s.organization_id = p_org
    and exists (
      select 1 from public.plans p
      where p.key = s.plan and p.net_price_cents > 0
    );
end;
$$;

-- Free uses the catalogue cap. A paid plan uses the seats that are still inside their own year.
create or replace function public.seat_limit(s public.subscriptions)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select case
    when coalesce(p.net_price_cents, 0) = 0 then p.seat_cap
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

-- The owner is never paused. Everyone else past the purchased seats is.
create or replace function public.enforce_seat_cap(p_org uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  cap integer;
  paused integer;
  sub public.subscriptions;
begin
  select * into sub from public.subscriptions where organization_id = p_org;
  if not found then
    return 0;
  end if;
  cap := public.seat_limit(sub);
  if cap is null then
    return 0;
  end if;
  with ranked as (
    select e.id,
           row_number() over (
             order by (e.role = 'owner') desc,
                      coalesce((select max(st.last_seen_at) from public.agent_status st where st.employee_id = e.id), e.created_at) desc,
                      e.created_at desc
           ) as n
    from public.employees e
    where e.organization_id = p_org and e.is_active
  ),
  extra as (
    update public.employees e
    set is_active = false
    from ranked r
    where e.id = r.id and r.n > cap and e.role <> 'owner'
    returning e.id
  )
  select count(*)::integer into paused from extra;
  if paused > 0 then
    insert into public.audit_log (organization_id, action, target_type, target_id, details)
    values (p_org, 'seats_paused', 'organization', p_org::text,
            jsonb_build_object('paused', paused, 'seat_cap', cap));
  end if;
  return coalesce(paused, 0);
end;
$$;

create or replace function public.apply_plan_change(p_org uuid, p_plan text, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  active_people integer;
begin
  if not exists (select 1 from public.plans where key = p_plan) then
    raise exception 'Unknown plan';
  end if;
  update public.subscriptions
  set plan = p_plan,
      status = case
        when p_reason = 'lapsed' then 'lapsed'
        when p_plan = 'free' then 'active'
        else 'past_due'
      end,
      pending_plan = null,
      cancel_at_period_end = false,
      current_period_start = case when p_plan = 'free' then null else current_period_start end,
      current_period_end = case when p_plan = 'free' then null else current_period_end end,
      cancelled_at = case when p_reason = 'cancelled' then now() else cancelled_at end
  where organization_id = p_org;
  if p_plan = 'free' then
    update public.subscription_seats
    set ended_at = coalesce(ended_at, now())
    where organization_id = p_org and ended_at is null;
  end if;
  perform public.enforce_seat_cap(p_org);
  if p_plan = 'free' then
    select count(*)::integer into active_people
    from public.employees where organization_id = p_org and is_active;
    update public.subscriptions
    set seats = greatest(active_people, 1)
    where organization_id = p_org;
  else
    perform public.sync_purchased_seats(p_org);
  end if;
  insert into public.audit_log (organization_id, action, target_type, target_id, details)
  values (p_org, 'plan_changed', 'organization', p_org::text,
          jsonb_build_object('plan', p_plan, 'reason', p_reason));
end;
$$;

create or replace function public.ensure_billing_state(p_org uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.subscriptions%rowtype;
  grace integer;
begin
  perform public.sync_purchased_seats(p_org);
  select * into s from public.subscriptions where organization_id = p_org for update;
  if not found then
    return;
  end if;
  perform public.enforce_seat_cap(p_org);
  select grace_days into grace from public.billing_config;
  if s.pending_plan is not null and s.current_period_end is not null and s.current_period_end <= now() then
    perform public.apply_plan_change(p_org, s.pending_plan, 'scheduled');
    return;
  end if;
  if s.cancel_at_period_end and s.current_period_end is not null and s.current_period_end <= now() then
    perform public.apply_plan_change(p_org, 'free', 'cancelled');
    return;
  end if;
  if s.plan <> 'free' and s.status in ('active', 'past_due')
     and s.current_period_end is not null and s.current_period_end <= now() then
    if s.current_period_end + make_interval(days => grace) > now() then
      if s.status <> 'past_due' then
        update public.subscriptions set status = 'past_due' where organization_id = p_org;
      end if;
    else
      perform public.apply_plan_change(p_org, 'free', 'lapsed');
    end if;
  end if;
end;
$$;

drop function public.quote_plan_change(text, boolean);
create function public.quote_plan_change(p_plan text, p_commit boolean default false, p_seats integer default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  org uuid := public.my_organization_id();
  s public.subscriptions%rowtype;
  current public.plans%rowtype;
  target public.plans%rowtype;
  cfg public.billing_config%rowtype;
  people integer;
  in_force integer;
  kind text;
  quantity integer;
  per_new integer;
  per_old integer;
  cycle_seconds numeric;
  left_seconds numeric;
  raw integer := 0;
  net integer;
  vat integer;
  intent uuid;
  ends_on timestamptz;
  seat record;
  min_seats integer;
begin
  if org is null or not exists (
    select 1 from public.employees e
    where e.auth_user_id = auth.uid() and e.organization_id = org and e.role = 'owner' and e.is_active
  ) then
    raise exception 'Only the organisation owner can change the plan' using errcode = '42501';
  end if;
  if exists (select 1 from public.organization_settings os where os.organization_id = org and os.require_mfa)
     and coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'Your organisation requires two-factor login. Sign in with your code first.' using errcode = '42501';
  end if;
  perform public.ensure_billing_state(org);
  select * into s from public.subscriptions where organization_id = org;
  select * into current from public.plans where key = s.plan;
  select * into target from public.plans where key = p_plan;
  if not found then
    raise exception 'Unknown plan';
  end if;
  select * into cfg from public.billing_config;
  select count(*)::integer into people from public.employees e where e.organization_id = org and e.is_active;
  if people < 1 then
    people := 1;
  end if;
  select count(*)::integer into in_force from public.subscription_seats ss
  where ss.organization_id = org and ss.ended_at is null and ss.period_end > now();
  ends_on := s.current_period_end;

  if target.rank < current.rank then
    if s.current_period_end is null or s.current_period_end <= now() then
      if p_commit then
        perform public.apply_plan_change(org, target.key, case when target.key = 'free' then 'cancelled' else 'scheduled' end);
      end if;
      return jsonb_build_object(
        'kind', 'downgrade', 'gross_cents', 0, 'seats', in_force, 'min_seats', 0, 'plan', target.key,
        'message', case when p_commit
          then format('The account is on %s.', target.name)
          else format('This moves the account to %s now. Nothing is deleted.', target.name) end);
    end if;
    if not p_commit then
      return jsonb_build_object(
        'kind', 'downgrade', 'gross_cents', 0, 'seats', in_force, 'min_seats', 0, 'plan', target.key,
        'message', format('You keep %s until %s. Then the account moves to %s. Purchased seats are not refunded.',
          current.name, coalesce(to_char(ends_on, 'YYYY-MM-DD'), 'the end of the last seat'), target.name));
    end if;
    update public.subscriptions
    set pending_plan = target.key,
        cancel_at_period_end = (target.key = 'free')
    where organization_id = org;
    insert into public.audit_log (organization_id, action, target_type, target_id, details)
    values (org, 'plan_change_scheduled', 'organization', org::text,
            jsonb_build_object('plan', target.key, 'on', ends_on));
    return jsonb_build_object(
      'kind', 'downgrade', 'gross_cents', 0, 'seats', in_force, 'min_seats', 0, 'plan', target.key,
      'message', format('The change to %s is scheduled.', target.name));
  end if;

  if target.rank > current.rank and current.net_price_cents > 0 and in_force > 0
     and s.status = 'active' then
    kind := 'upgrade';
    quantity := in_force;
    min_seats := in_force;
  elsif target.key = current.key and in_force > 0 and s.status = 'active' then
    kind := 'seats';
    quantity := coalesce(p_seats, 1);
    min_seats := 1;
  else
    kind := case when current.net_price_cents = 0 then 'new' else 'renewal' end;
    min_seats := people;
    quantity := coalesce(p_seats, min_seats);
  end if;

  if kind in ('new', 'renewal', 'seats') and (quantity < 1 or quantity > 10000) then
    raise exception 'Choose how many seats to buy';
  end if;
  if kind in ('new', 'renewal') and quantity < min_seats then
    return jsonb_build_object(
      'kind', kind, 'gross_cents', 0, 'net_cents', 0, 'vat_cents', 0,
      'seats', quantity, 'min_seats', min_seats, 'plan', target.key,
      'message', format('Choose at least %s seats so the people who are active now stay covered.', min_seats));
  end if;

  per_new := public.gross_cents(target.net_price_cents) * 12;
  per_old := public.gross_cents(current.net_price_cents) * 12;
  if kind = 'upgrade' then
    for seat in
      select ss.period_start, ss.period_end
      from public.subscription_seats ss
      where ss.organization_id = org and ss.ended_at is null and ss.period_end > now()
    loop
      cycle_seconds := extract(epoch from (seat.period_end - seat.period_start));
      left_seconds := extract(epoch from (seat.period_end - now()));
      if cycle_seconds <= 0 or left_seconds >= cycle_seconds then
        raw := raw + (per_new - per_old);
      else
        raw := raw + round((left_seconds / cycle_seconds) * (per_new - per_old))::integer;
      end if;
    end loop;
  else
    raw := per_new * quantity;
  end if;
  if raw < 0 then
    raw := 0;
  elsif raw > 0 and raw < cfg.min_charge_cents then
    raw := cfg.min_charge_cents;
  end if;
  if cfg.vat_enabled and cfg.vat_rate > 0 and raw > 0 then
    net := round(raw / (1 + cfg.vat_rate))::integer;
    vat := raw - net;
  else
    net := raw;
    vat := 0;
  end if;

  if raw = 0 then
    return jsonb_build_object('kind', kind, 'gross_cents', 0, 'net_cents', 0, 'vat_cents', 0,
      'seats', quantity, 'min_seats', min_seats, 'plan', target.key, 'message', 'No payment is due.');
  end if;

  if not p_commit then
    return jsonb_build_object(
      'kind', kind, 'gross_cents', raw, 'net_cents', net, 'vat_cents', vat,
      'seats', quantity, 'min_seats', min_seats, 'plan', target.key,
      'message', case kind
        when 'upgrade' then 'This charges the price difference for the days left on each seat, with VAT. Each seat keeps its own end date.'
        when 'seats' then 'This charges one year for each new seat, with VAT. Each new seat has its own end date.'
        else 'This charges one year for the seats you choose, with VAT. They share one end date.' end);
  end if;

  update public.checkout_intents set status = 'expired'
  where organization_id = org and status = 'pending';
  insert into public.checkout_intents (
    organization_id, plan_key, seats, kind, net_cents, vat_cents, gross_cents)
  values (org, target.key, quantity, kind, net, vat, raw)
  returning id into intent;
  return jsonb_build_object(
    'kind', kind, 'gross_cents', raw, 'net_cents', net, 'vat_cents', vat,
    'seats', quantity, 'min_seats', min_seats, 'plan', target.key, 'intent_id', intent,
    'message', 'Continue to payment.');
end;
$$;

create or replace function public.apply_checkout_payment(
  p_intent uuid, p_reference text, p_amount integer, p_currency text, p_raw jsonb)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  intent public.checkout_intents%rowtype;
  cfg public.billing_config%rowtype;
  org_name text;
  plan_name text;
  description text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if exists (select 1 from public.payments where reference = p_reference) then
    return false;
  end if;
  select * into intent from public.checkout_intents where id = p_intent for update;
  if not found then
    raise exception 'Unknown checkout';
  end if;
  if intent.status = 'paid' then
    return false;
  end if;
  if intent.status <> 'pending' then
    raise exception 'This checkout is no longer payable';
  end if;
  if p_amount is distinct from intent.gross_cents or upper(coalesce(p_currency, '')) <> 'ZAR' then
    raise exception 'The payment amount does not match the checkout';
  end if;
  insert into public.payments (
    organization_id, provider, reference, amount_cents, currency, seats, months, raw, plan_key, kind)
  values (
    intent.organization_id, 'yoco', p_reference, p_amount, 'ZAR', intent.seats, 12,
    coalesce(p_raw, '{}'::jsonb), intent.plan_key, intent.kind);
  update public.checkout_intents set status = 'paid', paid_at = now() where id = intent.id;
  if intent.kind in ('new', 'renewal', 'seats') then
    insert into public.subscription_seats (organization_id, period_start, period_end)
    select intent.organization_id, now(), now() + interval '1 year'
    from generate_series(1, intent.seats);
  end if;
  update public.subscriptions
  set plan = intent.plan_key,
      status = 'active',
      pending_plan = null,
      cancel_at_period_end = false,
      cancelled_at = null,
      current_period_start = case
        when intent.kind in ('new', 'renewal') then now()
        else current_period_start
      end
  where organization_id = intent.organization_id;
  perform public.sync_purchased_seats(intent.organization_id);
  select * into cfg from public.billing_config;
  select name into org_name from public.organizations where id = intent.organization_id;
  select name into plan_name from public.plans where key = intent.plan_key;
  description := case intent.kind
    when 'upgrade' then format('%s, price difference for the days left on %s seats, with VAT', plan_name, intent.seats)
    when 'seats' then format('%s, %s additional seats, one year each, with VAT', plan_name, intent.seats)
    else format('%s, %s seats, one year, with VAT', plan_name, intent.seats)
  end;
  insert into public.invoices (
    number, organization_id, organization_name, plan_key, plan_name, description, seats,
    net_cents, vat_cents, gross_cents, vat_rate, vat_enabled,
    business_name, business_vat_number, business_address, payment_reference)
  values (
    'INV-' || lpad(nextval('public.invoice_number_seq')::text, 6, '0'),
    intent.organization_id, coalesce(org_name, 'Customer'), intent.plan_key, plan_name, description, intent.seats,
    intent.net_cents, intent.vat_cents, intent.gross_cents, cfg.vat_rate, cfg.vat_enabled,
    cfg.business_name, cfg.business_vat_number, cfg.business_address, p_reference);
  insert into public.audit_log (organization_id, action, target_type, target_id, details)
  values (intent.organization_id, 'payment_received', 'organization', intent.organization_id::text,
          jsonb_build_object('reference', p_reference, 'amount_cents', p_amount, 'plan', intent.plan_key,
                             'kind', intent.kind, 'seats', intent.seats, 'months', 12));
  return true;
end;
$$;

-- Reminds the owner about seats that end within a week and were not scheduled for removal.
create or replace function public.list_renewal_work()
returns table (
  intent_id uuid, organization_id uuid, gross_cents integer, period_end timestamptz,
  owner_email text, owner_name text, plan_name text, yoco_checkout_id text)
language plpgsql
security definer
set search_path = public
as $$
declare
  grp record;
  gross integer;
  net integer;
  vat integer;
  intent uuid;
  checkout text;
  cfg public.billing_config%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  perform public.run_billing_cycle();
  select * into cfg from public.billing_config;
  for grp in
    select ss.organization_id, ss.period_end, count(*)::integer as seat_count, p.net_price_cents, p.name
    from public.subscription_seats ss
    join public.subscriptions s on s.organization_id = ss.organization_id
    join public.plans p on p.key = s.plan
    where ss.ended_at is null
      and ss.cancel_at_period_end = false
      and ss.period_end > now() - interval '1 day'
      and ss.period_end <= now() + interval '7 days'
      and p.net_price_cents > 0
      and not exists (
        select 1 from public.billing_notices n
        where n.organization_id = ss.organization_id and n.kind = 'renewal' and n.period_end = ss.period_end)
    group by ss.organization_id, ss.period_end, p.net_price_cents, p.name
  loop
    intent := null;
    checkout := null;
    owner_email := null;
    owner_name := null;
    gross := public.gross_cents(grp.net_price_cents) * 12 * grp.seat_count;
    if gross > 0 and gross < cfg.min_charge_cents then gross := cfg.min_charge_cents; end if;
    if cfg.vat_enabled and cfg.vat_rate > 0 and gross > 0 then
      net := round(gross / (1 + cfg.vat_rate))::integer;
      vat := gross - net;
    else
      net := gross;
      vat := 0;
    end if;
    select c.id, c.yoco_checkout_id into intent, checkout
    from public.checkout_intents c
    where c.organization_id = grp.organization_id and c.status = 'pending' and c.kind = 'renewal'
      and c.seats = grp.seat_count and c.gross_cents = gross
    order by c.created_at desc
    limit 1;
    if intent is null then
      update public.checkout_intents set status = 'expired'
      where organization_id = grp.organization_id and status = 'pending';
      insert into public.checkout_intents (
        organization_id, plan_key, seats, kind, net_cents, vat_cents, gross_cents)
      select grp.organization_id, s.plan, grp.seat_count, 'renewal', net, vat, gross
      from public.subscriptions s
      where s.organization_id = grp.organization_id
      returning id into intent;
      checkout := null;
    end if;
    intent_id := intent;
    organization_id := grp.organization_id;
    gross_cents := gross;
    period_end := grp.period_end;
    plan_name := grp.name;
    yoco_checkout_id := checkout;
    select e.email, e.name into owner_email, owner_name
    from public.employees e
    where e.organization_id = grp.organization_id and e.role = 'owner' and e.is_active
    order by e.created_at
    limit 1;
    return next;
  end loop;
end;
$$;

drop function public.get_my_service_status();
create function public.get_my_service_status()
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
         case when coalesce(p.net_price_cents, 0) = 0 then p.seat_cap else s.seats end,
         s.cancel_at_period_end,
         s.pending_plan,
         (select min(ss.period_end) from public.subscription_seats ss
          where ss.organization_id = s.organization_id and ss.ended_at is null and ss.period_end > now())
  from public.subscriptions s
  join public.plans p on p.key = public.effective_plan(s)
  where s.organization_id = org;
end;
$$;

create function public.list_subscription_seats()
returns table (
  id uuid, period_start timestamptz, period_end timestamptz, cancel_at_period_end boolean)
language sql
stable
security definer
set search_path = public
as $$
  select ss.id, ss.period_start, ss.period_end, ss.cancel_at_period_end
  from public.subscription_seats ss
  where ss.organization_id = public.my_organization_id()
    and ss.ended_at is null
    and ss.period_end > now()
  order by ss.period_end, ss.created_at;
$$;

create function public.schedule_seat_removal(p_seat uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  org uuid := public.my_organization_id();
  seat public.subscription_seats%rowtype;
begin
  if org is null or not exists (
    select 1 from public.employees e
    where e.auth_user_id = auth.uid() and e.organization_id = org and e.role = 'owner' and e.is_active
  ) then
    raise exception 'Only the organisation owner can change seats' using errcode = '42501';
  end if;
  select * into seat from public.subscription_seats
  where id = p_seat and organization_id = org and ended_at is null and period_end > now();
  if not found then
    raise exception 'That seat is no longer active';
  end if;
  update public.subscription_seats set cancel_at_period_end = true where id = seat.id;
  insert into public.audit_log (organization_id, action, target_type, target_id, details)
  values (org, 'seat_removal_scheduled', 'organization', org::text,
          jsonb_build_object('seat', seat.id, 'on', seat.period_end));
end;
$$;

create function public.keep_subscription_seat(p_seat uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  org uuid := public.my_organization_id();
begin
  if org is null or not exists (
    select 1 from public.employees e
    where e.auth_user_id = auth.uid() and e.organization_id = org and e.role = 'owner' and e.is_active
  ) then
    raise exception 'Only the organisation owner can change seats' using errcode = '42501';
  end if;
  update public.subscription_seats
  set cancel_at_period_end = false
  where id = p_seat and organization_id = org and ended_at is null and period_end > now();
  if not found then
    raise exception 'That seat is no longer active';
  end if;
end;
$$;

create function public.op_subscription_seats(p_org uuid)
returns table (
  id uuid, period_start timestamptz, period_end timestamptz, cancel_at_period_end boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.require_platform_admin();
  return query
  select ss.id, ss.period_start, ss.period_end, ss.cancel_at_period_end
  from public.subscription_seats ss
  where ss.organization_id = p_org and ss.ended_at is null and ss.period_end > now()
  order by ss.period_end, ss.created_at;
end;
$$;

create or replace function public.create_employee(
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
  cap integer;
  paid boolean;
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
  cap := public.seat_limit(sub);
  if cap is not null and (select count(*) from public.employees e where e.organization_id = org_id and e.is_active) >= cap then
    select coalesce(p.net_price_cents, 0) > 0 into paid
    from public.plans p where p.key = public.effective_plan(sub);
    if paid then
      raise exception 'All % purchased seats are in use. Buy another seat or deactivate someone.', cap;
    end if;
    raise exception 'This plan includes % people. Deactivate someone or move to a paid plan.', cap;
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
  cap integer;
  paid boolean;
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
    cap := public.seat_limit(sub);
    if cap is not null
       and (select count(*) from public.employees e where e.organization_id = emp.organization_id and e.is_active) >= cap then
      select coalesce(p.net_price_cents, 0) > 0 into paid
      from public.plans p where p.key = public.effective_plan(sub);
      if paid then
        raise exception 'All % purchased seats are in use. Buy another seat or deactivate someone.', cap;
      end if;
      raise exception 'This plan includes % people. Deactivate someone or move to a paid plan.', cap;
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
  if result.plan = 'free' then
    update public.subscription_seats
    set ended_at = coalesce(ended_at, now())
    where organization_id = p_org and ended_at is null;
    update public.subscriptions set seats = 3 where organization_id = p_org;
    select * into result from public.subscriptions where organization_id = p_org;
  else
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

revoke execute on function
  public.sync_purchased_seats(uuid),
  public.quote_plan_change(text, boolean, integer),
  public.list_subscription_seats(),
  public.schedule_seat_removal(uuid),
  public.keep_subscription_seat(uuid),
  public.op_subscription_seats(uuid),
  public.get_my_service_status()
from public, anon;

grant execute on function
  public.quote_plan_change(text, boolean, integer),
  public.list_subscription_seats(),
  public.schedule_seat_removal(uuid),
  public.keep_subscription_seat(uuid),
  public.op_subscription_seats(uuid),
  public.get_my_service_status()
to authenticated;

notify pgrst, 'reload schema';
