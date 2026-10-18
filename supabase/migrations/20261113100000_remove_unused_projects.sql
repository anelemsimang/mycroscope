-- A project with no recorded time left is removed, including projects whose time
-- was deleted earlier. The previous delete only removed a project when that same
-- deletion still contained a segment pointing at it.

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

  with gone as (
    delete from public.projects p
    where p.organization_id = emp.organization_id
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

-- Names left behind by a deletion that already removed the time.
delete from public.projects p
where not exists (select 1 from public.activity_segments s where s.project_id = p.id);

notify pgrst, 'reload schema';
