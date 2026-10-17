/** Unfiltered activity, including every project and time with none selected. */
export const ALL_PROJECTS = 'all';

/**
 * Activity recorded while no project was selected.
 * This is not a project id. The database stores that work with a null project.
 */
export const NO_PROJECT = 'none';

export interface NamedProject {
  id: string;
  name: string;
  is_active: boolean;
}

export function isProjectFilter(value: string | null | undefined): value is string {
  return !!value && value !== ALL_PROJECTS;
}

/** Arguments for the stats functions. An empty object means every project. */
export function projectQuery(project?: string | null): { p_project?: string; p_unassigned?: boolean } {
  if (!isProjectFilter(project)) return {};
  if (project === NO_PROJECT) return { p_unassigned: true };
  return { p_project: project };
}

/** All projects, then work with no project, then each named project. */
export function projectChoices(projects: NamedProject[]): { value: string; label: string }[] {
  return [
    { value: ALL_PROJECTS, label: 'All projects' },
    { value: NO_PROJECT, label: 'No project' },
    ...projects.map((p) => ({ value: p.id, label: p.is_active ? p.name : `${p.name} (archived)` })),
  ];
}

/**
 * A chosen calendar day lists only projects that have time that day.
 * All projects stays, so the day can still be seen as a whole.
 */
export function projectChoicesForDay(
  projects: NamedProject[],
  worked: { project_id: string | null }[],
): { value: string; label: string }[] {
  const ids = new Set(worked.map((row) => row.project_id ?? NO_PROJECT));
  return projectChoices(projects).filter((option) => option.value === ALL_PROJECTS || ids.has(option.value));
}

/** Label for titles and exports. Null is the unfiltered view. */
export function projectScopeName(value: string | null | undefined, projects?: NamedProject[]): string | null {
  if (!isProjectFilter(value)) return null;
  if (value === NO_PROJECT) return 'No project';
  return projects?.find((p) => p.id === value)?.name ?? null;
}

/** Short phrase appended to a date range. */
export function projectScopePhrase(value: string | null | undefined, projects?: NamedProject[]): string {
  if (value === NO_PROJECT) return 'no project';
  const name = projectScopeName(value, projects);
  return name ? `project ${name}` : '';
}
