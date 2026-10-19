-- Adding privileged seats listed the granted column but did not supply a value.

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
  select org, now(), grant_until, true
  from generate_series(1, p_seats);
  perform public.sync_purchased_seats(org);
  insert into public.audit_log (organization_id, actor_auth_id, action, target_type, target_id, details)
  values (org, auth.uid(), 'seats_added', 'organization', org::text,
          jsonb_build_object('seats', p_seats, 'until', grant_until));
end;
$$;

notify pgrst, 'reload schema';
