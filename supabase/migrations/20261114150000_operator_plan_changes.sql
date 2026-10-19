-- The control panel can see a downgrade or upgrade that is waiting, and the history of payments and plan changes.

drop function public.op_organizations();
create function public.op_organizations()
returns table (
  organization_id uuid, name text, created_at timestamptz, owner_name text, owner_email text,
  plan text, status text, level text, seats integer, active_employees integer,
  activated_employees integer, agents_online integer, last_activity_at timestamptz,
  current_period_end timestamptz, support_access_until timestamptz, granted boolean,
  pending_plan text, prepaid_plan text, cancel_at_period_end boolean,
  grant_until timestamptz, next_seat_end timestamptz, require_mfa boolean, open_requests integer)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.require_platform_admin();
  return query
  select o.id, o.name, o.created_at, ow.name, ow.email,
         s.plan, s.status, public.subscription_level(s), s.seats,
         (select count(*)::integer from public.employees e where e.organization_id = o.id and e.is_active),
         (select count(*)::integer from public.employees e where e.organization_id = o.id and e.is_active and e.auth_user_id is not null),
         (select count(*)::integer from public.agent_status st
          where st.organization_id = o.id and st.state <> 'logged_out' and st.last_seen_at > now() - interval '2 minutes'),
         (select max(st.last_seen_at) from public.agent_status st where st.organization_id = o.id),
         s.current_period_end,
         (select max(g.expires_at) from public.support_access_grants g
          where g.organization_id = o.id and g.revoked_at is null and g.expires_at > now()),
         public.operator_grant_active(o.id),
         s.pending_plan,
         s.prepaid_plan,
         coalesce(s.cancel_at_period_end, false),
         (select g.until from public.operator_grants g where g.organization_id = o.id and public.operator_grant_active(o.id)),
         (select min(ss.period_end) from public.subscription_seats ss
          where ss.organization_id = o.id and ss.ended_at is null and ss.period_end > now()),
         coalesce((select os.require_mfa from public.organization_settings os where os.organization_id = o.id), false),
         (select count(*)::integer from public.data_requests r
          where r.organization_id = o.id and r.status in ('open', 'in_progress'))
  from public.organizations o
  left join public.subscriptions s on s.organization_id = o.id
  left join lateral (select e.name, e.email from public.employees e
                     where e.organization_id = o.id and e.role = 'owner' order by e.created_at limit 1) ow on true
  order by o.created_at desc;
end;
$$;

revoke execute on function public.op_organizations() from public, anon;
grant execute on function public.op_organizations() to authenticated;

create or replace function public.op_account_history(p_org uuid)
returns table (occurred_at timestamptz, kind text, title text, detail text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.require_platform_admin();
  if not exists (select 1 from public.organizations o where o.id = p_org) then
    raise exception 'Organisation not found';
  end if;
  return query
  select events.occurred_at, events.kind, events.title, events.detail
  from (
    select p.paid_at as occurred_at,
           'payment'::text as kind,
           case coalesce(p.kind, '')
             when 'upgrade' then 'Upgrade paid'
             when 'upgrade_later' then 'Upgrade paid for the next term'
             when 'seats' then 'Seats paid'
             when 'renewal' then 'Renewal paid'
             when 'new' then 'Plan paid'
             else 'Payment received'
           end as title,
           trim(both ' ·' from concat_ws(' · ',
             nullif(p.plan_key, ''),
             p.seats::text || ' seats',
             'R' || trim(to_char(p.amount_cents / 100.0, 'FM999999990.00')),
             upper(p.currency))) as detail
    from public.payments p
    where p.organization_id = p_org
    union all
    select a.created_at as occurred_at,
           case a.action
             when 'plan_change_scheduled' then 'scheduled'
             when 'plan_changed' then 'changed'
             when 'seats_added' then 'seats'
             else 'operator'
           end as kind,
           case a.action
             when 'plan_change_scheduled' then 'Plan change scheduled'
             when 'plan_changed' then 'Plan changed'
             when 'seats_added' then 'Seats added without a payment'
             else 'Changed from the control panel'
           end as title,
           trim(both ' ·' from concat_ws(' · ',
             nullif(a.details ->> 'plan', ''),
             nullif(a.details ->> 'status', ''),
             case when a.details ? 'seats' then (a.details ->> 'seats') || ' seats' end,
             nullif(a.details ->> 'reason', ''),
             nullif(a.details ->> 'note', ''),
             case when a.details ? 'on' then 'on ' || left(a.details ->> 'on', 10) end,
             case when a.details ? 'until' then 'until ' || left(a.details ->> 'until', 10) end)) as detail
    from public.audit_log a
    where a.organization_id = p_org
      and a.action in ('plan_change_scheduled', 'plan_changed', 'seats_added', 'subscription_changed_by_provider')
  ) events
  order by events.occurred_at desc
  limit 80;
end;
$$;

revoke execute on function public.op_account_history(uuid) from public, anon;
grant execute on function public.op_account_history(uuid) to authenticated;

notify pgrst, 'reload schema';
