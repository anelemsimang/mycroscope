-- A paid plan is priced per person per month, and collected once for the whole year.
-- Tier 2 at R100 is charged as R100 x 12 for each active person, plus VAT.

create or replace function public.quote_plan_change(p_plan text, p_commit boolean default false)
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
          current.name, coalesce(to_char(ends_on, 'YYYY-MM-DD'), 'the end of this year'), target.name));
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

  per_new := public.gross_cents(target.net_price_cents) * 12;
  per_old := public.gross_cents(current.net_price_cents) * 12;
  if target.rank > current.rank and current.net_price_cents > 0
     and s.current_period_end is not null and s.current_period_end > now()
     and s.status = 'active' then
    kind := 'upgrade';
    cycle_seconds := extract(epoch from (s.current_period_end - coalesce(s.current_period_start, s.current_period_end - interval '1 year')));
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
        then 'This charges the price difference for the days left in the year.'
        else 'This charges 12 months now, for every active person.' end);
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
        then current_period_end else now() + interval '1 year' end
  where organization_id = intent.organization_id;
  select * into cfg from public.billing_config;
  select name into org_name from public.organizations where id = intent.organization_id;
  select name into plan_name from public.plans where key = intent.plan_key;
  description := case intent.kind
    when 'upgrade' then format('%s, price difference for the rest of this year, %s people', plan_name, intent.seats)
    else format('%s, one year, %s people', plan_name, intent.seats)
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
          jsonb_build_object('reference', p_reference, 'amount_cents', p_amount, 'plan', intent.plan_key, 'kind', intent.kind, 'months', 12));
  return true;
end;
$$;

create or replace function public.list_renewal_work()
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
    gross := public.gross_cents(s.net_price_cents) * 12 * people;
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

notify pgrst, 'reload schema';
