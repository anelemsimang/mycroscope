-- Deleting activity also removes project time in that period, drops projects that
-- no longer have any recorded time, and tells the desktop app to clear the same
-- period locally so the window does not keep or re-upload it.

create table public.activity_wipes (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  employee_id uuid not null references public.employees (id) on delete cascade,
  wiped_from timestamptz not null,
  wiped_to timestamptz not null,
  projects_removed text[] not null default '{}',
  created_at timestamptz not null default now()
);

create index activity_wipes_employee_idx on public.activity_wipes (employee_id, id);

alter table public.activity_wipes enable row level security;
revoke all on public.activity_wipes from anon, authenticated;

create or replace function public.delete_activity(
  p_employee uuid, p_from timestamptz, p_to timestamptz, p_reason text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  emp public.employees;
  tz text;
  used uuid[];
  removed integer;
  files integer;
  offline integer;
  places integer;
  events integer;
  removed_names text[];
  projects_removed integer;
begin
  select * into emp from public.employees where id = p_employee;
  if emp.id is null or not public.can_manage_employee(emp.id) then
    raise exception 'Not allowed';
  end if;
  if p_to <= p_from then
    raise exception 'Invalid time range';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'A reason is required';
  end if;
  select timezone into tz from public.organizations where id = emp.organization_id;

  select coalesce(array_agg(distinct s.project_id), '{}'::uuid[])
  into used
  from public.activity_segments s
  where s.employee_id = p_employee
    and s.started_at >= p_from and s.started_at < p_to
    and s.project_id is not null;

  delete from public.activity_segments
  where employee_id = p_employee and started_at >= p_from and started_at < p_to;
  get diagnostics removed = row_count;
  delete from public.file_events
  where employee_id = p_employee and occurred_at >= p_from and occurred_at < p_to;
  get diagnostics files = row_count;
  delete from public.offline_entries
  where employee_id = p_employee and started_at >= p_from and started_at < p_to;
  get diagnostics offline = row_count;
  delete from public.agent_events
  where employee_id = p_employee and occurred_at >= p_from and occurred_at < p_to;
  get diagnostics events = row_count;
  delete from public.work_location_days
  where employee_id = p_employee
    and day between (p_from at time zone tz)::date and (p_to at time zone tz)::date;
  get diagnostics places = row_count;

  delete from public.daily_summaries
  where employee_id = p_employee
    and day between (p_from at time zone tz)::date and (p_to at time zone tz)::date;
  delete from public.daily_usage
  where employee_id = p_employee
    and day between (p_from at time zone tz)::date and (p_to at time zone tz)::date;

  -- A project used in this period, with no time left for anyone, is removed so the
  -- desktop project list does not keep a name that has no history.
  with gone as (
    delete from public.projects p
    where p.organization_id = emp.organization_id
      and p.id = any (used)
      and not exists (select 1 from public.activity_segments s where s.project_id = p.id)
    returning p.name
  )
  select coalesce(array_agg(gone.name order by gone.name), '{}'::text[]), count(*)::integer
  into removed_names, projects_removed
  from gone;

  insert into public.activity_wipes (organization_id, employee_id, wiped_from, wiped_to, projects_removed)
  values (emp.organization_id, emp.id, p_from, p_to, removed_names);

  perform public.write_audit(emp.organization_id, 'activity_deleted', 'employee', emp.id::text,
    jsonb_build_object('from', p_from, 'to', p_to, 'segments', removed, 'file_events', files,
                       'offline_entries', offline, 'events', events, 'work_location_days', places,
                       'projects_removed', projects_removed, 'project_names', to_jsonb(removed_names),
                       'reason', p_reason));
  return removed;
end;
$$;

create or replace function public.get_my_activity_wipes(p_after bigint)
returns table (id bigint, wiped_from timestamptz, wiped_to timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select w.id, w.wiped_from, w.wiped_to
  from public.activity_wipes w
  where w.employee_id = public.my_employee_id()
    and w.id > coalesce(p_after, 0)
  order by w.id;
$$;

revoke execute on function public.get_my_activity_wipes(bigint) from public, anon;
grant execute on function public.get_my_activity_wipes(bigint) to authenticated;

notify pgrst, 'reload schema';
