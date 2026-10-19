-- The receipt needs the payment reference and who was billed. The invoice row already
-- stores the reference; the owner is read from the organisation at download time.
drop function if exists public.get_my_invoices();

create function public.get_my_invoices()
returns table (
  number text,
  issued_at timestamptz,
  organization_name text,
  plan_name text,
  description text,
  seats integer,
  net_cents integer,
  vat_cents integer,
  gross_cents integer,
  vat_rate numeric,
  vat_enabled boolean,
  business_name text,
  business_vat_number text,
  business_address text,
  payment_reference text,
  customer_name text,
  customer_email text
)
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
         i.business_name, i.business_vat_number, i.business_address, i.payment_reference,
         owner.name, owner.email
  from public.invoices i
  left join lateral (
    select e.name, e.email
    from public.employees e
    where e.organization_id = i.organization_id and e.role = 'owner' and e.is_active
    order by e.created_at
    limit 1
  ) owner on true
  where i.organization_id = org
  order by i.issued_at desc
  limit 50;
end;
$$;

revoke all on function public.get_my_invoices() from public, anon;
grant execute on function public.get_my_invoices() to authenticated;

notify pgrst, 'reload schema';
