-- Mycroscope: enforce the plan catalogue.
-- Run after 20261029090000_plan_catalogue.sql. Do not apply until you mean to.
--
-- What a company can see is the shorter of the plan window and the length they chose.
-- What is deleted is the shorter of the longest plan (12 months) and the length they chose.
-- A downgrade hides the extra history. It does not delete it, so a later upgrade can show it again.
-- People over the seat cap are paused (is_active = false). They are never deleted.
--
-- Upgrades start as soon as the payment is confirmed, and a mid-cycle upgrade charges
-- the price difference for the days left. Free to paid charges a full month.
-- Downgrades and cancellation start when the current month ends. No refund.
-- A missed renewal stays on the paid plan for billing_config.grace_days (default 7),
-- then moves to the Free plan. Status becomes lapsed. Recording of Free features continues.

-- -----------------------------------------------------------------------------
-- Settings and subscription state
-- -----------------------------------------------------------------------------
alter table public.billing_config
  add column grace_days integer not null default 7 check (grace_days between 0 and 90),
  add column keep_downgraded_history boolean not null default true,
  add column min_charge_cents integer not null default 200 check (min_charge_cents >= 200),
  add column business_name text not null default 'Mycroscope',
  add column business_vat_number text,
  add column business_address text not null default '';

alter table public.subscriptions
  add column current_period_start timestamptz,
  add column cancel_at_period_end boolean not null default false,
  add column pending_plan text references public.plans (key);

alter table public.subscriptions drop constraint if exists subscriptions_status_check;
alter table public.subscriptions add constraint subscriptions_status_check
  check (status in ('active', 'past_due', 'lapsed', 'cancelled', 'suspended'));

alter table public.payments
  add column plan_key text,
  add column kind text;

create table public.checkout_intents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  plan_key text not null references public.plans (key),
  seats integer not null check (seats > 0),
  kind text not null check (kind in ('new', 'renewal', 'upgrade')),
  net_cents integer not null check (net_cents >= 0),
  vat_cents integer not null check (vat_cents >= 0),
  gross_cents integer not null check (gross_cents >= 0),
  yoco_checkout_id text,
  status text not null default 'pending' check (status in ('pending', 'paid', 'expired')),
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
create index checkout_intents_org_idx on public.checkout_intents (organization_id, created_at desc);

create sequence public.invoice_number_seq start 1001;

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  organization_name text not null,
  issued_at timestamptz not null default now(),
  plan_key text not null,
  plan_name text not null,
  description text not null,
  seats integer not null,
  net_cents integer not null,
  vat_cents integer not null,
  gross_cents integer not null,
  vat_rate numeric(6, 4) not null,
  vat_enabled boolean not null,
  business_name text not null,
  business_vat_number text,
  business_address text not null default '',
  payment_reference text not null
);
create index invoices_org_idx on public.invoices (organization_id, issued_at desc);

create table public.billing_notices (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  kind text not null,
  period_end timestamptz not null,
  sent_at timestamptz not null default now(),
  primary key (organization_id, kind, period_end)
);

-- -----------------------------------------------------------------------------
-- History windows
-- visible_from: rows at or after this moment are shown.
-- purge_before: rows before this moment are deleted. It is never later than visible_from
-- when downgraded history is kept, so a hidden stretch can remain on disk.
-- -----------------------------------------------------------------------------
create function public.activity_visible_from(p_org uuid)
returns timestamptz
language sql
stable
security definer
set search_path = public
as $$
  select greatest(
    now() - p.retention,
    now() - make_interval(days => coalesce(os.retention_days, 30))
  )
  from public.subscriptions s
  join public.plans p on p.key = public.effective_plan(s)
  join public.organization_settings os on os.organization_id = s.organization_id
  where s.organization_id = p_org;
$$;

create function public.activity_purge_before(p_org uuid)
returns timestamptz
language sql
stable
security definer
set search_path = public
as $$
  select case
    when c.keep_downgraded_history then greatest(
      now() - (select max(retention) from public.plans),
      now() - make_interval(days => coalesce(os.retention_days, 30))
    )
    else public.activity_visible_from(p_org)
  end
  from public.organization_settings os
  cross join public.billing_config c
  where os.organization_id = p_org;
$$;

-- -----------------------------------------------------------------------------
-- Access level. Lapsed means the paid plan ended and the company is on Free,
-- so basic recording continues. Grace comes from billing_config, not each row.
-- -----------------------------------------------------------------------------
create or replace function public.subscription_level(s public.subscriptions)
returns text
language sql
stable
as $$
  select case
    when s.organization_id is null then 'read_only'
    when s.status = 'suspended' then 'read_only'
    when s.status = 'lapsed' then 'full'
    when s.status = 'cancelled' and s.current_period_end is not null and s.current_period_end > now() then 'full'
    when s.status in ('active', 'past_due') and (
      s.current_period_end is null
      or s.current_period_end + make_interval(days => (select grace_days from public.billing_config)) > now()
    ) then 'full'
    else 'read_only'
  end;
$$;

-- Pauses people past the seat cap. The owner stays, then the people seen most recently.
-- Returns how many were paused. Never deletes a row.
create function public.enforce_seat_cap(p_org uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  cap integer;
  paused integer;
begin
  select p.seat_cap into cap
  from public.subscriptions s
  join public.plans p on p.key = s.plan
  where s.organization_id = p_org;
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
    where e.id = r.id and r.n > cap
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

-- Switches the plan. Free clears the period. A lower paid plan stays past_due until they pay it.
create function public.apply_plan_change(p_org uuid, p_plan text, p_reason text)
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
  perform public.enforce_seat_cap(p_org);
  select count(*)::integer into active_people
  from public.employees where organization_id = p_org and is_active;
  update public.subscriptions
  set seats = greatest(active_people, 1)
  where organization_id = p_org;
  insert into public.audit_log (organization_id, action, target_type, target_id, details)
  values (p_org, 'plan_changed', 'organization', p_org::text,
          jsonb_build_object('plan', p_plan, 'reason', p_reason));
end;
$$;

-- Moves one company forward when a period or a grace window has ended.
create function public.ensure_billing_state(p_org uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.subscriptions%rowtype;
  grace integer;
begin
  select * into s from public.subscriptions where organization_id = p_org for update;
  if not found then
    return;
  end if;
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

create function public.run_billing_cycle()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  org uuid;
begin
  for org in select organization_id from public.subscriptions loop
    perform public.ensure_billing_state(org);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- Quotes. The owner previews with p_commit false, then commits.
-- A committed charge is stored as a checkout intent. Yoco is called afterwards.
-- -----------------------------------------------------------------------------
create function public.quote_plan_change(p_plan text, p_commit boolean default false)
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
  kind text;
  per_new integer;
  per_old integer;
  cycle_seconds numeric;
  left_seconds numeric;
  raw integer;
  net integer;
  vat integer;
  intent uuid;
  ends_on timestamptz;
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
  ends_on := s.current_period_end;

  if target.rank < current.rank then
    if s.current_period_end is null or s.current_period_end <= now() then
      if p_commit then
        perform public.apply_plan_change(org, target.key, case when target.key = 'free' then 'cancelled' else 'scheduled' end);
      end if;
      return jsonb_build_object(
        'kind', 'downgrade', 'gross_cents', 0, 'seats', people, 'plan', target.key,
        'message', case when p_commit
          then format('The account is on %s.', target.name)
          else format('This moves the account to %s now. Nothing is deleted.', target.name) end);
    end if;
    if not p_commit then
      return jsonb_build_object(
        'kind', 'downgrade', 'gross_cents', 0, 'seats', people, 'plan', target.key,
        'message', format('You keep %s until %s. Then the account moves to %s. Nothing is deleted.',
          current.name, coalesce(to_char(ends_on, 'YYYY-MM-DD'), 'the end of this period'), target.name));
    end if;
    update public.subscriptions
    set pending_plan = target.key,
        cancel_at_period_end = (target.key = 'free')
    where organization_id = org;
    insert into public.audit_log (organization_id, action, target_type, target_id, details)
    values (org, 'plan_change_scheduled', 'organization', org::text,
            jsonb_build_object('plan', target.key, 'on', ends_on));
    return jsonb_build_object(
      'kind', 'downgrade', 'gross_cents', 0, 'seats', people, 'plan', target.key,
      'message', format('The change to %s is scheduled.', target.name));
  end if;

  if target.rank = current.rank and s.status = 'active'
     and (s.current_period_end is null or s.current_period_end > now()) then
    return jsonb_build_object(
      'kind', 'current', 'gross_cents', 0, 'seats', people, 'plan', target.key,
      'message', 'You are already on this plan.');
  end if;

  per_new := public.gross_cents(target.net_price_cents);
  per_old := public.gross_cents(current.net_price_cents);
  if target.rank > current.rank and current.net_price_cents > 0
     and s.current_period_end is not null and s.current_period_end > now()
     and s.status = 'active' then
    kind := 'upgrade';
    cycle_seconds := extract(epoch from (s.current_period_end - coalesce(s.current_period_start, s.current_period_end - interval '1 month')));
    left_seconds := extract(epoch from (s.current_period_end - now()));
    if cycle_seconds <= 0 then
      raw := per_new * people;
    else
      raw := round((left_seconds / cycle_seconds) * (per_new - per_old) * people)::integer;
    end if;
  else
    kind := case when current.net_price_cents = 0 then 'new' else 'renewal' end;
    raw := per_new * people;
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
    if p_commit and target.rank > current.rank then
      update public.subscriptions
      set plan = target.key, status = 'active', pending_plan = null, cancel_at_period_end = false, seats = people
      where organization_id = org;
    end if;
    return jsonb_build_object('kind', kind, 'gross_cents', 0, 'net_cents', 0, 'vat_cents', 0,
      'seats', people, 'plan', target.key, 'message', 'No payment is due.');
  end if;

  if not p_commit then
    return jsonb_build_object(
      'kind', kind, 'gross_cents', raw, 'net_cents', net, 'vat_cents', vat,
      'seats', people, 'plan', target.key,
      'message', case when kind = 'upgrade'
        then 'This charges the price difference for the days left in the month.'
        else 'This charges one month for every active person.' end);
  end if;

  update public.checkout_intents set status = 'expired'
  where organization_id = org and status = 'pending';
  insert into public.checkout_intents (
    organization_id, plan_key, seats, kind, net_cents, vat_cents, gross_cents)
  values (org, target.key, people, kind, net, vat, raw)
  returning id into intent;
  return jsonb_build_object(
    'kind', kind, 'gross_cents', raw, 'net_cents', net, 'vat_cents', vat,
    'seats', people, 'plan', target.key, 'intent_id', intent,
    'message', 'Continue to payment.');
end;
$$;

create function public.cancel_pending_plan_change()
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
    raise exception 'Only the organisation owner can change the plan' using errcode = '42501';
  end if;
  update public.subscriptions
  set pending_plan = null, cancel_at_period_end = false
  where organization_id = org;
end;
$$;

-- Applies a verified Yoco payment once. The webhook is the only caller.
create function public.apply_checkout_payment(
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
    intent.organization_id, 'yoco', p_reference, p_amount, 'ZAR', intent.seats, 1,
    coalesce(p_raw, '{}'::jsonb), intent.plan_key, intent.kind);
  update public.checkout_intents set status = 'paid', paid_at = now() where id = intent.id;
  update public.subscriptions
  set plan = intent.plan_key,
      status = 'active',
      seats = intent.seats,
      pending_plan = null,
      cancel_at_period_end = false,
      cancelled_at = null,
      current_period_start = case when intent.kind = 'upgrade' and current_period_end > now()
        then current_period_start else now() end,
      current_period_end = case when intent.kind = 'upgrade' and current_period_end > now()
        then current_period_end else now() + interval '1 month' end
  where organization_id = intent.organization_id;
  select * into cfg from public.billing_config;
  select name into org_name from public.organizations where id = intent.organization_id;
  select name into plan_name from public.plans where key = intent.plan_key;
  description := case intent.kind
    when 'upgrade' then format('%s, price difference for the rest of this month, %s people', plan_name, intent.seats)
    else format('%s, one month, %s people', plan_name, intent.seats)
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
          jsonb_build_object('reference', p_reference, 'amount_cents', p_amount, 'plan', intent.plan_key, 'kind', intent.kind));
  return true;
end;
$$;

create function public.get_my_invoices()
returns table (
  number text, issued_at timestamptz, organization_name text, plan_name text, description text,
  seats integer, net_cents integer, vat_cents integer, gross_cents integer,
  vat_rate numeric, vat_enabled boolean, business_name text, business_vat_number text, business_address text)
language plpgsql
stable
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
    raise exception 'Only the organisation owner can view invoices' using errcode = '42501';
  end if;
  return query
  select i.number, i.issued_at, i.organization_name, i.plan_name, i.description,
         i.seats, i.net_cents, i.vat_cents, i.gross_cents, i.vat_rate, i.vat_enabled,
         i.business_name, i.business_vat_number, i.business_address
  from public.invoices i
  where i.organization_id = org
  order by i.issued_at desc
  limit 50;
end;
$$;

-- Renewal emails. Service role only. Reuses a pending renewal intent when one exists.
create function public.list_renewal_work()
returns table (
  intent_id uuid, organization_id uuid, gross_cents integer, period_end timestamptz,
  owner_email text, owner_name text, plan_name text, yoco_checkout_id text)
language plpgsql
security definer
set search_path = public
as $$
declare
  s record;
  people integer;
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
  for s in
    select sub.organization_id, sub.current_period_end, sub.plan, p.name, p.net_price_cents
    from public.subscriptions sub
    join public.plans p on p.key = sub.plan
    where sub.status = 'past_due' and p.net_price_cents > 0 and sub.current_period_end is not null
      and not exists (
        select 1 from public.billing_notices n
        where n.organization_id = sub.organization_id and n.kind = 'renewal' and n.period_end = sub.current_period_end)
  loop
    intent := null;
    checkout := null;
    owner_email := null;
    owner_name := null;
    select count(*)::integer into people from public.employees e
    where e.organization_id = s.organization_id and e.is_active;
    if people < 1 then people := 1; end if;
    gross := public.gross_cents(s.net_price_cents) * people;
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
    where c.organization_id = s.organization_id and c.status = 'pending' and c.kind = 'renewal'
    order by c.created_at desc
    limit 1;
    if intent is null then
      insert into public.checkout_intents (
        organization_id, plan_key, seats, kind, net_cents, vat_cents, gross_cents)
      values (s.organization_id, s.plan, people, 'renewal', net, vat, gross)
      returning id into intent;
      checkout := null;
    end if;
    intent_id := intent;
    organization_id := s.organization_id;
    gross_cents := gross;
    period_end := s.current_period_end;
    plan_name := s.name;
    yoco_checkout_id := checkout;
    select e.email, e.name into owner_email, owner_name
    from public.employees e
    where e.organization_id = s.organization_id and e.role = 'owner' and e.is_active
    order by e.created_at
    limit 1;
    return next;
  end loop;
end;
$$;

create function public.attach_yoco_checkout(p_intent uuid, p_checkout_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  update public.checkout_intents
  set yoco_checkout_id = p_checkout_id
  where id = p_intent and status = 'pending';
end;
$$;

create function public.mark_billing_notice(p_org uuid, p_period timestamptz)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  insert into public.billing_notices (organization_id, kind, period_end)
  values (p_org, 'renewal', p_period)
  on conflict do nothing;
end;
$$;

-- -----------------------------------------------------------------------------
-- Service status now applies a due plan change before it answers,
-- so a lapsed company is already on Free when the desktop app asks.
-- -----------------------------------------------------------------------------
drop function public.get_my_service_status();
create function public.get_my_service_status()
returns table (
  level text, status text, plan text, current_period_end timestamptz,
  grace_until timestamptz, seats integer, seats_used integer, require_mfa boolean,
  seat_cap integer, cancel_at_period_end boolean, pending_plan text)
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
         (select p.seat_cap from public.plans p where p.key = public.effective_plan(s)),
         s.cancel_at_period_end,
         s.pending_plan
  from public.subscriptions s
  where s.organization_id = org;
end;
$$;

-- -----------------------------------------------------------------------------
-- Delete only what the purge window allows. File names also follow the shorter
-- file_retention_days already shown to employees in the monitoring notice.
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
  summary_cutoff timestamptz;
  n_segments integer;
  n_events integer;
  n_sessions integer;
  n_summaries integer;
  n_offline integer;
  n_places integer;
  n_advice integer;
  n_notes integer;
  n_files integer;
begin
  for s in select organization_id, retention_days, summary_retention_days, file_retention_days from public.organization_settings loop
    cutoff := public.activity_purge_before(s.organization_id);
    summary_cutoff := greatest(cutoff, now() - make_interval(days => s.summary_retention_days));
    delete from public.activity_segments where organization_id = s.organization_id and ended_at < cutoff;
    get diagnostics n_segments = row_count;
    delete from public.agent_events where organization_id = s.organization_id and occurred_at < cutoff;
    get diagnostics n_events = row_count;
    delete from public.agent_sessions
      where organization_id = s.organization_id and coalesce(ended_at, started_at) < cutoff;
    get diagnostics n_sessions = row_count;
    delete from public.offline_entries where organization_id = s.organization_id and ended_at < cutoff;
    get diagnostics n_offline = row_count;
    delete from public.file_events
      where organization_id = s.organization_id
        and occurred_at < greatest(cutoff, now() - make_interval(days => s.file_retention_days));
    get diagnostics n_files = row_count;
    delete from public.work_location_days
      where organization_id = s.organization_id and day < cutoff::date;
    get diagnostics n_places = row_count;
    delete from public.daily_summaries
      where organization_id = s.organization_id and day < summary_cutoff::date;
    get diagnostics n_summaries = row_count;
    delete from public.advisor_questions
      where organization_id = s.organization_id and created_at < summary_cutoff;
    get diagnostics n_advice = row_count;
    delete from public.coaching_notes
      where organization_id = s.organization_id and created_at < summary_cutoff;
    get diagnostics n_notes = row_count;
    n_advice := n_advice + n_notes;

    if n_segments + n_events + n_sessions + n_summaries + n_offline + n_places + n_advice + n_files > 0 then
      insert into public.audit_log (organization_id, action, target_type, details)
      values (s.organization_id, 'retention_purge', 'organization',
              jsonb_build_object('segments', n_segments, 'events', n_events,
                                 'sessions', n_sessions, 'summaries', n_summaries,
                                 'offline_entries', n_offline, 'work_location_days', n_places,
                                 'file_events', n_files, 'advice', n_advice,
                                 'purge_before', cutoff));
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
  started timestamptz := clock_timestamp();
  stale integer;
  files_purged integer := 0;
begin
  perform public.run_billing_cycle();

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
    and u.day < greatest(
      public.activity_purge_before(s.organization_id),
      now() - make_interval(days => s.summary_retention_days))::date;

  delete from public.maintenance_runs where ran_at < now() - interval '90 days';
  insert into public.maintenance_runs (duration_ms, details)
  values ((extract(epoch from clock_timestamp() - started) * 1000)::integer,
          jsonb_build_object('stale_sessions_closed', stale, 'file_events_purged', files_purged, 'billing_cycle', true));
end;
$$;

-- Reports refuse a range that starts before the plan window.
create or replace function public.require_analytics(p_feature text, p_from date, p_to date)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  org_id uuid := public.my_organization_id();
  visible date;
begin
  if org_id is null or not public.is_manager_of(org_id) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if not public.org_has_feature(org_id, p_feature) then
    raise exception 'Upgrade to unlock this report' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'Invalid period';
  end if;
  if p_to - p_from > 400 then
    raise exception 'Choose a period of at most 400 days';
  end if;
  visible := public.activity_visible_from(org_id)::date;
  if visible is not null and p_from < visible then
    raise exception 'Your plan does not include activity before %. Upgrade to unlock older history.', visible
      using errcode = '42501';
  end if;
  return org_id;
end;
$$;

-- Working hours need both keys, so either one can be moved to another plan on its own.
create or replace function public.save_work_schedule(
  p_team uuid, p_employee uuid, p_work_days integer[], p_work_start time, p_work_end time)
returns public.monitoring_policies
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid := public.my_organization_id();
  days smallint[];
  result public.monitoring_policies;
begin
  if org_id is null or not public.is_manager_of(org_id) then
    raise exception 'Not allowed';
  end if;
  if (p_team is null) = (p_employee is null) then
    raise exception 'Choose either a team or a person';
  end if;
  if p_team is not null and not public.can_manage_team(p_team) then
    raise exception 'Not allowed';
  end if;
  if p_employee is not null and not (public.can_manage_employee(p_employee)
       and exists (select 1 from public.employees where id = p_employee and organization_id = org_id)) then
    raise exception 'Not allowed';
  end if;
  if not public.org_has_feature(org_id, 'schedule_adherence')
     or not public.org_has_feature(org_id, 'time_tracking') then
    raise exception 'Team and individual working hours are not included in your plan';
  end if;
  if p_work_days is null or cardinality(p_work_days) = 0
     or exists (select 1 from unnest(p_work_days) d where d not between 1 and 7) then
    raise exception 'Choose at least one working day';
  end if;
  if p_work_start is null or p_work_end is null or p_work_start = p_work_end then
    raise exception 'Working hours must start and end at different times';
  end if;
  days := array(select distinct d::smallint from unnest(p_work_days) d order by 1);

  delete from public.work_schedules
  where organization_id = org_id
    and (team_id = p_team or employee_id = p_employee);
  insert into public.work_schedules (organization_id, team_id, employee_id, work_days, work_start, work_end, updated_by)
  values (org_id, p_team, p_employee, days, p_work_start, p_work_end, public.my_employee_id());

  perform public.write_audit(org_id, 'work_schedule_saved', case when p_team is null then 'employee' else 'team' end,
    coalesce(p_team, p_employee)::text,
    jsonb_build_object('work_days', days, 'work_start', p_work_start, 'work_end', p_work_end));
  perform public.republish_if_work_hours(org_id);

  select * into result from public.monitoring_policies
  where organization_id = org_id order by version desc limit 1;
  return result;
end;
$$;

-- -----------------------------------------------------------------------------
-- Who can read activity, and who can see other people live.
-- -----------------------------------------------------------------------------
drop policy if exists activity_segments_select on public.activity_segments;
create policy activity_segments_select on public.activity_segments for select to authenticated
  using (public.can_view_employee(employee_id)
         and started_at >= public.activity_visible_from(organization_id));

drop policy if exists agent_events_select on public.agent_events;
create policy agent_events_select on public.agent_events for select to authenticated
  using (public.can_view_employee(employee_id)
         and occurred_at >= public.activity_visible_from(organization_id));

drop policy if exists daily_summaries_select on public.daily_summaries;
create policy daily_summaries_select on public.daily_summaries for select to authenticated
  using (public.can_view_employee(employee_id)
         and day >= public.activity_visible_from(organization_id)::date);

drop policy if exists agent_status_select on public.agent_status;
create policy agent_status_select on public.agent_status for select to authenticated
  using (
    employee_id = public.my_employee_id()
    or (
      public.can_view_employee(employee_id)
      and public.org_has_feature(organization_id, 'real_time_visibility')
    )
  );

alter table public.checkout_intents enable row level security;
alter table public.invoices enable row level security;
alter table public.billing_notices enable row level security;
revoke all on public.checkout_intents, public.invoices, public.billing_notices from public, anon, authenticated;
revoke all on sequence public.invoice_number_seq from public, anon, authenticated;

revoke execute on function
  public.activity_visible_from(uuid),
  public.activity_purge_before(uuid),
  public.enforce_seat_cap(uuid),
  public.apply_plan_change(uuid, text, text),
  public.ensure_billing_state(uuid),
  public.run_billing_cycle(),
  public.quote_plan_change(text, boolean),
  public.cancel_pending_plan_change(),
  public.apply_checkout_payment(uuid, text, integer, text, jsonb),
  public.get_my_invoices(),
  public.list_renewal_work(),
  public.attach_yoco_checkout(uuid, text),
  public.mark_billing_notice(uuid, timestamptz),
  public.get_my_service_status()
from public, anon;

grant execute on function
  public.activity_visible_from(uuid),
  public.quote_plan_change(text, boolean),
  public.cancel_pending_plan_change(),
  public.get_my_invoices(),
  public.get_my_service_status()
to authenticated;

grant execute on function
  public.apply_checkout_payment(uuid, text, integer, text, jsonb),
  public.list_renewal_work(),
  public.attach_yoco_checkout(uuid, text),
  public.mark_billing_notice(uuid, timestamptz),
  public.run_billing_cycle()
to service_role;

create or replace function public.save_team(p_team uuid, p_name text)
returns public.teams
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid := public.my_organization_id();
  old_name text;
  result public.teams;
begin
  if org_id is null or public.my_role() <> 'owner' or not public.mfa_ok(org_id) then
    raise exception 'Only the owner can manage teams';
  end if;
  if not public.org_has_feature(org_id, 'teams') then
    raise exception 'Teams are not included in your plan. Upgrade to unlock.';
  end if;
  if p_team is null then
    insert into public.teams (organization_id, name) values (org_id, btrim(p_name)) returning * into result;
  else
    select name into old_name from public.teams where id = p_team and organization_id = org_id;
    update public.teams set name = btrim(p_name) where id = p_team and organization_id = org_id returning * into result;
    if result.id is null then
      raise exception 'Unknown team';
    end if;
    if old_name is distinct from result.name and exists (select 1 from public.work_schedules where team_id = p_team) then
      perform public.republish_if_work_hours(org_id);
    end if;
  end if;
  perform public.write_audit(org_id, 'team_saved', 'team', result.id::text, jsonb_build_object('name', result.name));
  return result;
end;
$$;

notify pgrst, 'reload schema';
