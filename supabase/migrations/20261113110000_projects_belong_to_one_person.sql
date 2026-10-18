-- A project belongs to one person. Two people can use the same name, and each
-- keeps their own time. Deleting one person's activity does not remove the other
-- person's project.

alter table public.projects
  add column employee_id uuid references public.employees (id) on delete cascade;

update public.projects p
set employee_id = coalesce(
  (select s.employee_id
   from public.activity_segments s
   where s.project_id = p.id
   group by s.employee_id
   order by count(*) desc, s.employee_id
   limit 1),
  p.created_by);

-- Anyone else who already has time on that shared project gets their own copy.
do $$
declare
  r record;
  new_id uuid;
begin
  for r in
    select s.project_id, s.employee_id
    from public.activity_segments s
    join public.projects p on p.id = s.project_id
    where p.employee_id is distinct from s.employee_id
    group by s.project_id, s.employee_id
  loop
    new_id := gen_random_uuid();
    insert into public.projects (id, organization_id, name, description, is_active, created_by, employee_id)
    select new_id, organization_id, name, description, is_active, r.employee_id, r.employee_id
    from public.projects where id = r.project_id;
    update public.activity_segments
    set project_id = new_id
    where project_id = r.project_id and employee_id = r.employee_id;
    update public.agent_status
    set project_id = new_id
    where project_id = r.project_id and employee_id = r.employee_id;
  end loop;
end $$;

delete from public.projects where employee_id is null;

alter table public.projects alter column employee_id set not null;

drop index if exists public.projects_org_name_key;
create unique index projects_employee_name_key on public.projects (employee_id, lower(name));
create index projects_employee_idx on public.projects (employee_id);

create or replace function public.projects_set_owner()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.employee_id is null then
    new.employee_id := new.created_by;
  end if;
  if new.employee_id is null then
    raise exception 'A project belongs to one person';
  end if;
  return new;
end;
$$;

drop trigger if exists projects_set_owner on public.projects;
create trigger projects_set_owner
  before insert on public.projects
  for each row execute function public.projects_set_owner();

drop policy if exists projects_select on public.projects;
drop policy if exists projects_insert on public.projects;
drop policy if exists projects_update on public.projects;

create policy projects_select on public.projects for select to authenticated
  using (public.can_view_employee(employee_id));

create policy projects_insert on public.projects for insert to authenticated
  with check (
    organization_id = public.my_organization_id()
    and created_by = public.my_employee_id()
    and coalesce(employee_id, created_by) = public.my_employee_id());

create policy projects_update on public.projects for update to authenticated
  using (employee_id = public.my_employee_id() or public.can_manage_employee(employee_id))
  with check (employee_id = public.my_employee_id() or public.can_manage_employee(employee_id));

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
    where p.employee_id = p_employee
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

notify pgrst, 'reload schema';
