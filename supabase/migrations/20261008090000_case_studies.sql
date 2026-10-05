-- Mycroscope: case studies. Selected organisations use Mycroscope free for an agreed period (e.g. 12 months),
-- after which the normal 14-day trial runs before they need to subscribe. Run after 20261007090000_saas_platform.sql.
--
-- Operators either invite an email before the company signs up (applied automatically when that person registers
-- the organisation), or start a case study for an organisation that already exists.

alter table public.subscriptions add column case_study_until timestamptz;

create table public.case_study_invites (
  email text primary key check (email = lower(btrim(email)) and position('@' in email) > 1),
  months integer not null check (months between 1 and 24),
  note text not null check (length(btrim(note)) between 1 and 500),
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

-- Case study from today for p_months, then the standard 14-day trial.
create or replace function public.start_case_study(p_org uuid, p_months integer)
returns public.subscriptions
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.subscriptions;
begin
  update public.subscriptions
  set plan = 'trial',
      status = 'trialing',
      case_study_until = now() + make_interval(months => p_months),
      trial_ends_at = now() + make_interval(months => p_months) + interval '14 days',
      cancelled_at = null
  where organization_id = p_org
  returning * into result;
  return result;
end;
$$;

-- p_months 1..24 starts (or restarts) a case study today; 0 ends the running one now, starting the 14-day trial.
create or replace function public.op_set_case_study(p_org uuid, p_months integer, p_note text)
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

  if p_months = 0 then
    if before_row.case_study_until is null or before_row.case_study_until <= now() then
      raise exception 'No case study is running for this organisation';
    end if;
    update public.subscriptions
    set case_study_until = now(),
        trial_ends_at = case when status = 'trialing' then now() + interval '14 days' else trial_ends_at end
    where organization_id = p_org
    returning * into result;
  elsif p_months between 1 and 24 then
    if before_row.status in ('active', 'past_due') and before_row.plan <> 'trial' then
      raise exception 'This organisation is a paying customer. Change its subscription instead.';
    end if;
    result := public.start_case_study(p_org, p_months);
  else
    raise exception 'Months must be between 1 and 24 (or 0 to end the case study)';
  end if;

  perform public.write_operator_audit(case when p_months = 0 then 'case_study_ended' else 'case_study_started' end, p_org,
    jsonb_build_object('months', p_months, 'until', result.case_study_until, 'trial_ends_at', result.trial_ends_at,
                       'note', p_note));
  insert into public.audit_log (organization_id, actor_auth_id, action, target_type, target_id, details)
  values (p_org, auth.uid(), case when p_months = 0 then 'case_study_ended' else 'case_study_started' end,
          'organization', p_org::text,
          jsonb_build_object('case_study_until', result.case_study_until, 'trial_ends_at', result.trial_ends_at,
                             'note', p_note));
  return result;
end;
$$;

create or replace function public.op_invite_case_study(p_email text, p_months integer, p_note text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  addr text := lower(btrim(coalesce(p_email, '')));
begin
  perform public.require_platform_admin();
  if position('@' in addr) < 2 then
    raise exception 'Enter a valid email address';
  end if;
  if p_months is null or p_months not between 1 and 24 then
    raise exception 'Months must be between 1 and 24';
  end if;
  if coalesce(btrim(p_note), '') = '' then
    raise exception 'A note explaining the case study is required';
  end if;
  if exists (select 1 from public.employees where lower(email) = addr) then
    raise exception 'This email is already registered. Start the case study from the customer''s page instead.';
  end if;
  insert into public.case_study_invites (email, months, note, invited_by)
  values (addr, p_months, btrim(p_note), auth.uid())
  on conflict (email) do update
  set months = excluded.months, note = excluded.note, invited_by = excluded.invited_by, created_at = now();
  perform public.write_operator_audit('case_study_invited', null,
    jsonb_build_object('email', addr, 'months', p_months, 'note', btrim(p_note)));
end;
$$;

create or replace function public.op_case_study_invites()
returns setof public.case_study_invites
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.require_platform_admin();
  return query select * from public.case_study_invites order by created_at desc;
end;
$$;

create or replace function public.op_cancel_case_study_invite(p_email text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_platform_admin();
  delete from public.case_study_invites where email = lower(btrim(p_email));
  if not found then
    raise exception 'Invite not found';
  end if;
  perform public.write_operator_audit('case_study_invite_cancelled', null, jsonb_build_object('email', lower(btrim(p_email))));
end;
$$;

-- When an invited person registers their organisation, the case study starts immediately.
create or replace function public.apply_case_study_invite()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  inv public.case_study_invites;
  sub public.subscriptions;
begin
  if new.role <> 'owner' then
    return new;
  end if;
  delete from public.case_study_invites where email = lower(new.email) returning * into inv;
  if inv.email is null then
    return new;
  end if;
  sub := public.start_case_study(new.organization_id, inv.months);
  insert into public.operator_audit_log (operator_auth_id, action, organization_id, details)
  values (inv.invited_by, 'case_study_started', new.organization_id,
          jsonb_build_object('months', inv.months, 'until', sub.case_study_until, 'note', inv.note,
                             'email', inv.email, 'from_invite', true));
  insert into public.audit_log (organization_id, action, target_type, target_id, details)
  values (new.organization_id, 'case_study_started', 'organization', new.organization_id::text,
          jsonb_build_object('case_study_until', sub.case_study_until, 'trial_ends_at', sub.trial_ends_at));
  return new;
end;
$$;

create trigger employees_case_study_invite after insert on public.employees
  for each row execute function public.apply_case_study_invite();

-- Return types change, so these are recreated.
drop function public.get_my_service_status();
create function public.get_my_service_status()
returns table (level text, status text, plan text, trial_ends_at timestamptz, current_period_end timestamptz,
               grace_until timestamptz, seats integer, seats_used integer, require_mfa boolean,
               case_study_until timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select public.subscription_level(s), s.status, s.plan, s.trial_ends_at, s.current_period_end,
         case when s.status in ('active', 'past_due') and s.current_period_end is not null
              then s.current_period_end + make_interval(days => s.grace_days) end,
         s.seats,
         (select count(*)::integer from public.employees e where e.organization_id = s.organization_id and e.is_active),
         coalesce((select os.require_mfa from public.organization_settings os where os.organization_id = s.organization_id), false),
         s.case_study_until
  from public.subscriptions s
  where s.organization_id = public.my_organization_id();
$$;

drop function public.op_organizations();
create function public.op_organizations()
returns table (organization_id uuid, name text, created_at timestamptz, owner_name text, owner_email text,
               plan text, status text, level text, seats integer, active_employees integer,
               activated_employees integer, agents_online integer, last_activity_at timestamptz,
               trial_ends_at timestamptz, current_period_end timestamptz, support_access_until timestamptz,
               case_study_until timestamptz)
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
         s.trial_ends_at, s.current_period_end,
         (select max(g.expires_at) from public.support_access_grants g
          where g.organization_id = o.id and g.revoked_at is null and g.expires_at > now()),
         s.case_study_until
  from public.organizations o
  left join public.subscriptions s on s.organization_id = o.id
  left join lateral (select e.name, e.email from public.employees e
                     where e.organization_id = o.id and e.role = 'owner' order by e.created_at limit 1) ow on true
  order by o.created_at desc;
end;
$$;

alter table public.case_study_invites enable row level security;
revoke all on public.case_study_invites from anon, authenticated;

revoke execute on function
  public.start_case_study(uuid, integer),
  public.op_set_case_study(uuid, integer, text),
  public.op_invite_case_study(text, integer, text),
  public.op_case_study_invites(),
  public.op_cancel_case_study_invite(text),
  public.apply_case_study_invite(),
  public.get_my_service_status(),
  public.op_organizations()
from public, anon;
grant execute on function
  public.op_set_case_study(uuid, integer, text),
  public.op_invite_case_study(text, integer, text),
  public.op_case_study_invites(),
  public.op_cancel_case_study_invite(text),
  public.get_my_service_status(),
  public.op_organizations()
to authenticated;
revoke execute on function public.start_case_study(uuid, integer), public.apply_case_study_invite() from authenticated;

notify pgrst, 'reload schema';
