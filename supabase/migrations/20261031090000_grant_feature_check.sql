-- Who is working right now is a paid feature. The check runs inside a row policy,
-- so signed-in users need a small function they are allowed to call.
-- org_has_feature itself stays private.

create function public.can_see_live_status(p_employee uuid, p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_employee = public.my_employee_id()
      or (
        public.can_view_employee(p_employee)
        and public.org_has_feature(p_org, 'real_time_visibility')
      );
$$;

drop policy if exists agent_status_select on public.agent_status;
create policy agent_status_select on public.agent_status for select to authenticated
  using (public.can_see_live_status(employee_id, organization_id));

revoke execute on function public.can_see_live_status(uuid, uuid) from public, anon;
grant execute on function public.can_see_live_status(uuid, uuid) to authenticated;

notify pgrst, 'reload schema';
