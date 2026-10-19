-- An operator can erase an organisation from the control panel at any status.
-- The organisation name still has to be typed exactly. Cascades remove its data.

create or replace function public.op_delete_organization(p_org uuid, p_confirm_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  org public.organizations;
  sub public.subscriptions;
  account_ids uuid[];
begin
  perform public.require_platform_admin();
  select * into org from public.organizations where id = p_org;
  select * into sub from public.subscriptions where organization_id = p_org;
  if org.id is null then
    raise exception 'Organisation not found';
  end if;
  if p_confirm_name is distinct from org.name then
    raise exception 'Type the organisation name exactly to confirm';
  end if;
  select array_agg(e.auth_user_id) into account_ids
  from public.employees e where e.organization_id = p_org and e.auth_user_id is not null;

  perform public.write_operator_audit('organization_deleted', p_org,
    jsonb_build_object('name', org.name, 'status', sub.status, 'plan', sub.plan,
                       'accounts', coalesce(cardinality(account_ids), 0)));
  delete from public.organizations where id = p_org;

  begin
    delete from auth.users where id = any (coalesce(account_ids, '{}'));
  exception when insufficient_privilege then
    raise notice 'Organisation deleted; remove its % sign-in account(s) under Authentication -> Users', cardinality(account_ids);
  end;
end;
$$;

notify pgrst, 'reload schema';
