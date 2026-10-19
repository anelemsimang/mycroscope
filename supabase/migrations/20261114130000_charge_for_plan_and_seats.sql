-- Seats added without a payment do not reduce the price of a plan purchase.
-- After that purchase is paid, those seats become paid seats.

create or replace function public.quote_plan_change(
  p_plan text, p_commit boolean default false, p_seats integer default null, p_when text default 'now')
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
  choice text := coalesce(nullif(p_when, ''), 'now');
  quantity integer;
  per_new integer;
  per_old integer;
  cycle_seconds numeric;
  left_seconds numeric;
  credit integer := 0;
  raw integer := 0;
  later_raw integer := 0;
  net integer;
  vat integer;
  later_net integer := 0;
  later_vat integer := 0;
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
    if s.prepaid_plan is not null then
      raise exception 'A paid upgrade is already waiting for the end of this term';
    end if;
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
    if choice not in ('now', 'end', 'schedule') then
      raise exception 'Choose when the new plan starts';
    end if;
    if s.prepaid_plan is not null then
      if p_plan = s.prepaid_plan and choice in ('end', 'schedule') then
        return jsonb_build_object(
          'kind', 'upgrade', 'when', 'schedule', 'gross_cents', 0, 'net_cents', 0, 'vat_cents', 0,
          'seats', quantity, 'min_seats', min_seats, 'plan', target.key, 'ends_on', ends_on,
          'message', format('%s is already paid and starts on %s. You stay on %s until then.',
            target.name, coalesce(to_char(ends_on, 'YYYY-MM-DD'), 'the end of this term'), current.name));
      end if;
      raise exception 'A paid upgrade is already waiting for the end of this term';
    end if;
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
        and not ss.granted
    loop
      cycle_seconds := extract(epoch from (seat.period_end - seat.period_start));
      left_seconds := extract(epoch from (seat.period_end - now()));
      if cycle_seconds > 0 and left_seconds > 0 then
        if left_seconds > cycle_seconds then
          left_seconds := cycle_seconds;
        end if;
        credit := credit + round((left_seconds / cycle_seconds) * per_old)::integer;
      end if;
    end loop;
    later_raw := per_new * quantity;
    raw := later_raw - credit;
    if raw < 0 then
      raw := 0;
    end if;
    if choice = 'end' then
      kind := 'upgrade_later';
      raw := later_raw;
      credit := 0;
    end if;
  else
    raw := per_new * quantity;
  end if;

  if kind = 'upgrade' and choice = 'schedule' then
    if s.prepaid_plan is not null then
      raise exception 'This upgrade is already paid and starts at the end of the term';
    end if;
    if p_commit then
      update public.subscriptions
      set pending_plan = target.key, cancel_at_period_end = false
      where organization_id = org;
      insert into public.audit_log (organization_id, action, target_type, target_id, details)
      values (org, 'plan_change_scheduled', 'organization', org::text,
              jsonb_build_object('plan', target.key, 'on', ends_on, 'when', 'end'));
    end if;
    return jsonb_build_object(
      'kind', 'upgrade', 'when', 'schedule', 'gross_cents', 0, 'net_cents', 0, 'vat_cents', 0,
      'credit_cents', credit, 'seats', quantity, 'min_seats', min_seats, 'plan', target.key,
      'ends_on', ends_on,
      'message', format('You keep %s until %s. %s starts on that date after you pay one year of %s for the seats still in force. If that payment is not made, the change does not start.',
        current.name, coalesce(to_char(ends_on, 'YYYY-MM-DD'), 'the end of this term'), target.name, target.name));
  end if;

  if raw > 0 and raw < cfg.min_charge_cents then
    raw := cfg.min_charge_cents;
  end if;
  if cfg.vat_enabled and cfg.vat_rate > 0 and raw > 0 then
    net := round(raw / (1 + cfg.vat_rate))::integer;
    vat := raw - net;
  else
    net := raw;
    vat := 0;
  end if;
  if kind = 'upgrade' and later_raw > 0 then
    if later_raw < cfg.min_charge_cents then
      later_raw := cfg.min_charge_cents;
    end if;
    if cfg.vat_enabled and cfg.vat_rate > 0 then
      later_net := round(later_raw / (1 + cfg.vat_rate))::integer;
      later_vat := later_raw - later_net;
    else
      later_net := later_raw;
    end if;
  end if;

  if raw = 0 and kind = 'upgrade' and p_commit and choice = 'now' then
    update public.subscription_seats
    set period_start = now(), period_end = now() + interval '1 year', cancel_at_period_end = false
    where organization_id = org and ended_at is null and period_end > now();
    update public.subscriptions
    set plan = target.key, status = 'active', pending_plan = null, prepaid_plan = null,
        cancel_at_period_end = false, cancelled_at = null,
        current_period_start = now(), current_period_end = now() + interval '1 year'
    where organization_id = org;
    perform public.sync_purchased_seats(org);
    return jsonb_build_object(
      'kind', 'upgrade', 'when', 'now', 'gross_cents', 0, 'net_cents', 0, 'vat_cents', 0,
      'credit_cents', credit, 'seats', quantity, 'min_seats', min_seats, 'plan', target.key,
      'message', format('%s has started. No payment is due. Every seat ends one year from today.', target.name));
  end if;

  if raw = 0 then
    return jsonb_build_object('kind', kind, 'gross_cents', 0, 'net_cents', 0, 'vat_cents', 0,
      'seats', quantity, 'min_seats', min_seats, 'plan', target.key, 'message', 'No payment is due.');
  end if;

  if not p_commit then
    return jsonb_build_object(
      'kind', kind, 'when', case when kind = 'upgrade_later' then 'end' else 'now' end,
      'gross_cents', raw, 'net_cents', net, 'vat_cents', vat,
      'credit_cents', credit, 'later_gross_cents', later_raw, 'later_net_cents', later_net, 'later_vat_cents', later_vat,
      'seats', quantity, 'min_seats', min_seats, 'plan', target.key, 'ends_on', ends_on,
      'message', case kind
        when 'upgrade' then format('This charges one year of %s for %s seats, minus the unused part of %s on each seat, with VAT. Every seat then ends one year from today.', target.name, quantity, current.name)
        when 'upgrade_later' then format('This pays one year of %s for %s seats, with VAT. %s starts on %s. Until then you stay on %s. If this is not paid, the change does not start.', target.name, quantity, target.name, coalesce(to_char(ends_on, 'YYYY-MM-DD'), 'the end of this term'), current.name)
        when 'seats' then 'This charges one year for each new seat, with VAT. Each new seat has its own end date.'
        else 'This charges one year for the seats you choose, with VAT. They share one end date.' end);
  end if;

  if kind = 'upgrade_later' and s.prepaid_plan is not null then
    raise exception 'This upgrade is already paid and starts at the end of the term';
  end if;

  update public.checkout_intents set status = 'expired'
  where organization_id = org and status = 'pending';
  insert into public.checkout_intents (
    organization_id, plan_key, seats, kind, net_cents, vat_cents, gross_cents)
  values (org, target.key, quantity, kind, net, vat, raw)
  returning id into intent;
  return jsonb_build_object(
    'kind', kind, 'when', case when kind = 'upgrade_later' then 'end' else 'now' end,
    'gross_cents', raw, 'net_cents', net, 'vat_cents', vat,
    'credit_cents', credit, 'seats', quantity, 'min_seats', min_seats, 'plan', target.key,
    'ends_on', ends_on, 'intent_id', intent, 'message', 'Continue to payment.');
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
  ends_on timestamptz;
  starts_later boolean := false;
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

  if intent.kind = 'upgrade' then
    update public.subscription_seats
    set period_start = now(), period_end = now() + interval '1 year', cancel_at_period_end = false, granted = false
    where organization_id = intent.organization_id and ended_at is null and period_end > now();
    update public.subscriptions
    set plan = intent.plan_key, status = 'active', pending_plan = null, prepaid_plan = null,
        cancel_at_period_end = false, cancelled_at = null,
        current_period_start = now(), current_period_end = now() + interval '1 year'
    where organization_id = intent.organization_id;
  elsif intent.kind = 'upgrade_later' then
    select current_period_end into ends_on from public.subscriptions where organization_id = intent.organization_id;
    if ends_on is not null and ends_on > now() then
      starts_later := true;
      update public.subscriptions
      set pending_plan = intent.plan_key, prepaid_plan = intent.plan_key, cancel_at_period_end = false
      where organization_id = intent.organization_id;
    else
      insert into public.subscription_seats (organization_id, period_start, period_end)
      select intent.organization_id, now(), now() + interval '1 year'
      from generate_series(1, intent.seats);
      update public.subscriptions
      set plan = intent.plan_key, status = 'active', pending_plan = null, prepaid_plan = null,
          cancel_at_period_end = false, cancelled_at = null,
          current_period_start = now(), current_period_end = now() + interval '1 year'
      where organization_id = intent.organization_id;
    end if;
  else
    if intent.kind in ('new', 'renewal', 'seats') then
      insert into public.subscription_seats (organization_id, period_start, period_end)
      select intent.organization_id, now(), now() + interval '1 year'
      from generate_series(1, intent.seats);
    end if;
    update public.subscriptions
    set plan = intent.plan_key,
        status = 'active',
        pending_plan = case when intent.kind = 'seats' then pending_plan else null end,
        cancel_at_period_end = false,
        cancelled_at = null,
        current_period_start = case
          when intent.kind in ('new', 'renewal') then now()
          else current_period_start
        end
    where organization_id = intent.organization_id;
  end if;

  perform public.sync_purchased_seats(intent.organization_id);
  select * into cfg from public.billing_config;
  select name into org_name from public.organizations where id = intent.organization_id;
  select name into plan_name from public.plans where key = intent.plan_key;
  description := case intent.kind
    when 'upgrade' then format('%s, one year for %s seats, with the unused current plan taken off, with VAT', plan_name, intent.seats)
    when 'upgrade_later' then format('%s, one year for %s seats, %s, with VAT', plan_name, intent.seats,
      case when starts_later then 'starting at the end of the current term' else 'starting today because the current term has ended' end)
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

notify pgrst, 'reload schema';
