-- Queues for the control panel: money, renewals, privacy requests, unfinished checkouts, and agent trouble.

create or replace function public.op_operator_desk()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  month_start timestamptz := date_trunc('month', now() at time zone 'Africa/Johannesburg') at time zone 'Africa/Johannesburg';
  current_version text;
begin
  perform public.require_platform_admin();
  select st.agent_version into current_version
  from public.agent_status st
  where st.agent_version is not null
    and st.last_seen_at > now() - interval '7 days'
  order by st.last_seen_at desc
  limit 1;

  return jsonb_build_object(
    'collected_cents', coalesce((
      select sum(p.amount_cents)::integer from public.payments p where p.paid_at >= month_start
    ), 0),
    'due_cents', coalesce((
      select sum(public.gross_cents(pl.net_price_cents) * 12)::integer
      from public.subscription_seats ss
      join public.subscriptions s on s.organization_id = ss.organization_id
      join public.plans pl on pl.key = s.plan
      where ss.ended_at is null
        and ss.cancel_at_period_end = false
        and ss.period_end > now()
        and ss.period_end <= now() + interval '14 days'
        and pl.net_price_cents > 0
        and not public.operator_grant_active(ss.organization_id)
    ), 0),
    'renewals', coalesce((
      select jsonb_agg(jsonb_build_object(
        'organization_id', due_row.organization_id,
        'name', due_row.name,
        'seats', due_row.seats,
        'ends_on', due_row.ends_on,
        'covered', due_row.covered
      ) order by due_row.ends_on, due_row.name)
      from (
        select o.id as organization_id, o.name, count(*)::integer as seats, ss.period_end as ends_on,
               public.operator_grant_active(o.id) as covered
        from public.subscription_seats ss
        join public.organizations o on o.id = ss.organization_id
        where ss.ended_at is null
          and ss.period_end > now()
          and ss.period_end <= now() + interval '14 days'
        group by o.id, o.name, ss.period_end
      ) due_row
    ), '[]'::jsonb),
    'requests', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id,
        'organization_id', r.organization_id,
        'name', o.name,
        'kind', r.kind,
        'status', r.status,
        'created_at', r.created_at,
        'message', left(r.message, 280)
      ) order by r.created_at)
      from public.data_requests r
      join public.organizations o on o.id = r.organization_id
      where r.status in ('open', 'in_progress')
    ), '[]'::jsonb),
    'checkouts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'organization_id', c.organization_id,
        'name', o.name,
        'plan_key', c.plan_key,
        'kind', c.kind,
        'gross_cents', c.gross_cents,
        'seats', c.seats,
        'created_at', c.created_at
      ) order by c.created_at desc)
      from (
        select * from public.checkout_intents
        where status = 'pending' and created_at < now() - interval '1 hour'
        order by created_at desc
        limit 30
      ) c
      join public.organizations o on o.id = c.organization_id
    ), '[]'::jsonb),
    'agents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'organization_id', agent_row.organization_id,
        'name', agent_row.name,
        'detail', agent_row.detail
      ) order by agent_row.name, agent_row.detail)
      from (
        select o.id as organization_id, o.name,
               format('%s agents on %s. The newest check-in is %s.', count(*)::integer, st.agent_version, current_version) as detail
        from public.agent_status st
        join public.organizations o on o.id = st.organization_id
        where current_version is not null
          and st.agent_version is not null
          and st.agent_version <> current_version
          and st.last_seen_at > now() - interval '7 days'
        group by o.id, o.name, st.agent_version
        union all
        select o.id, o.name,
               format('%s %s in the last 7 days.', count(*)::integer,
                 case ev.event_type when 'data_rejected' then 'recordings rejected' else 'clock problems' end)
        from public.agent_events ev
        join public.organizations o on o.id = ev.organization_id
        where ev.occurred_at > now() - interval '7 days'
          and ev.event_type in ('data_rejected', 'clock_skew')
        group by o.id, o.name, ev.event_type
      ) agent_row
    ), '[]'::jsonb)
  );
end;
$$;

revoke execute on function public.op_operator_desk() from public, anon;
grant execute on function public.op_operator_desk() to authenticated;

notify pgrst, 'reload schema';
