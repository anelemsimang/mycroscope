export interface TimedSlice {
  label: string;
  active_seconds: number;
  idle_seconds: number;
  sample_title?: string | null;
}

/** Time recorded with no project: the day's total minus every named project. */
export function unassignedRemainder(total: TimedSlice[], used: TimedSlice[]): TimedSlice[] {
  const spent = new Map<string, { active: number; idle: number }>();
  for (const row of used) {
    const prev = spent.get(row.label) ?? { active: 0, idle: 0 };
    spent.set(row.label, { active: prev.active + row.active_seconds, idle: prev.idle + row.idle_seconds });
  }
  const left: TimedSlice[] = [];
  for (const row of total) {
    const prev = spent.get(row.label) ?? { active: 0, idle: 0 };
    const active = row.active_seconds - prev.active;
    const idle = row.idle_seconds - prev.idle;
    if (active <= 0 && idle <= 0) continue;
    left.push({
      label: row.label,
      active_seconds: active,
      idle_seconds: idle,
      sample_title: prev.active + prev.idle === 0 ? row.sample_title ?? null : null,
    });
  }
  return left;
}

export interface DayBreakdownRow {
  project_id: string | null;
  project_name: string;
  kind: 'app' | 'web';
  label: string;
  active_seconds: number;
  idle_seconds: number;
  sample_title: string | null;
}

export interface DayGroupItem {
  label: string;
  active: number;
  idle: number;
  title: string | null;
}

/** One project's apps and websites for a single day. */
export interface DayGroup {
  key: string;
  projectId: string | null;
  name: string;
  active: number;
  apps: DayGroupItem[];
  websites: DayGroupItem[];
}

/**
 * Group a day's app and website rows by project.
 * Active time is taken from apps only: website time is already inside the browser's app time.
 */
export function groupDayBreakdown(rows: DayBreakdownRow[]): DayGroup[] {
  const map = new Map<string, DayGroup>();
  for (const row of rows) {
    const key = row.project_id ?? 'none';
    let group = map.get(key);
    if (!group) {
      group = { key, projectId: row.project_id, name: row.project_name, active: 0, apps: [], websites: [] };
      map.set(key, group);
    }
    const item = { label: row.label, active: row.active_seconds, idle: row.idle_seconds, title: row.sample_title };
    if (row.kind === 'web') group.websites.push(item);
    else {
      group.apps.push(item);
      group.active += row.active_seconds;
    }
  }
  for (const group of map.values()) {
    group.apps.sort((a, b) => b.active - a.active || a.label.localeCompare(b.label));
    group.websites.sort((a, b) => b.active - a.active || a.label.localeCompare(b.label));
  }
  return [...map.values()].sort((a, b) => b.active - a.active || a.name.localeCompare(b.name));
}

export interface NamedDaySlice {
  project_id: string;
  project_name: string;
  apps: TimedSlice[];
  domains: TimedSlice[];
}

/** Combine per-project totals into the rows the day view groups. */
export function assembleDayBreakdown(input: {
  unassignedName: string | null;
  allApps: TimedSlice[];
  allDomains: TimedSlice[];
  named: NamedDaySlice[];
}): DayBreakdownRow[] {
  const rows: DayBreakdownRow[] = [];
  for (const project of input.named) {
    for (const app of project.apps) {
      rows.push({
        project_id: project.project_id, project_name: project.project_name, kind: 'app', label: app.label,
        active_seconds: app.active_seconds, idle_seconds: app.idle_seconds, sample_title: null,
      });
    }
    for (const site of project.domains) {
      rows.push({
        project_id: project.project_id, project_name: project.project_name, kind: 'web', label: site.label,
        active_seconds: site.active_seconds, idle_seconds: site.idle_seconds, sample_title: site.sample_title ?? null,
      });
    }
  }
  if (input.unassignedName) {
    const usedApps = input.named.flatMap((project) => project.apps);
    const usedDomains = input.named.flatMap((project) => project.domains);
    for (const app of unassignedRemainder(input.allApps, usedApps)) {
      rows.push({
        project_id: null, project_name: input.unassignedName, kind: 'app', label: app.label,
        active_seconds: app.active_seconds, idle_seconds: app.idle_seconds, sample_title: null,
      });
    }
    for (const site of unassignedRemainder(input.allDomains, usedDomains)) {
      rows.push({
        project_id: null, project_name: input.unassignedName, kind: 'web', label: site.label,
        active_seconds: site.active_seconds, idle_seconds: site.idle_seconds, sample_title: site.sample_title ?? null,
      });
    }
  }
  return rows;
}
