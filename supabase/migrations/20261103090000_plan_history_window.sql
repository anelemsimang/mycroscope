-- A paid plan keeps the history included in that plan. A shorter setting still hides older activity.
-- Moving up from Free raises the kept days from 30 to the new plan's window.

create function public.plan_history_days(p_retention interval)
returns integer
language sql
stable
as $$
  select greatest(1, (current_date - (current_date - p_retention)::date));
$$;

create function public.raise_kept_history(p_org uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  days integer;
begin
  select public.plan_history_days(p.retention) into days
  from public.subscriptions s
  join public.plans p on p.key = public.effective_plan(s)
  where s.organization_id = p_org;
  if days is null then
    return;
  end if;
  update public.organization_settings
  set retention_days = days
  where organization_id = p_org
    and retention_days < days;
end;
$$;

create function public.align_history_to_plan()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.raise_kept_history(new.organization_id);
  return new;
end;
$$;

create trigger subscriptions_align_history
  after insert or update of plan on public.subscriptions
  for each row execute function public.align_history_to_plan();

update public.organization_settings os
set retention_days = public.plan_history_days(p.retention)
from public.subscriptions s
join public.plans p on p.key = public.effective_plan(s)
where s.organization_id = os.organization_id
  and os.retention_days < public.plan_history_days(p.retention);

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
    raise exception 'Activity before % is not kept. Choose a period that starts on or after that date.',
      to_char(visible, 'FMDD Mon YYYY')
      using errcode = '42501';
  end if;
  return org_id;
end;
$$;

revoke execute on function
  public.plan_history_days(interval),
  public.raise_kept_history(uuid),
  public.align_history_to_plan()
from public, anon, authenticated;

notify pgrst, 'reload schema';
