// Pure copies of the plan rules in 20261029090000 and 20261030090000.
// The database is what the product enforces. These exist so the rules can be tested without it.
// If a grant changes in the catalogue migration, change it here too.

const RANK = ['free', 'work_activity', 'workforce', 'productivity'] as const;

/** The tier that introduces each feature. Higher tiers include everything below them. */
const INTRODUCED: Record<string, readonly string[]> = {
  free: [],
  work_activity: [
    'real_time_visibility', 'time_tracking', 'schedule_adherence', 'website_tracking', 'software_usage', 'channels',
  ],
  workforce: [
    'teams', 'work_location_insights', 'productivity_goals', 'workload_planning', 'file_activity', 'ai_tools',
  ],
  productivity: ['capacity_planning', 'financial_estimates', 'coaching', 'trends', 'api'],
};

export function featuresFor(plan: string): string[] {
  const index = RANK.indexOf(plan as (typeof RANK)[number]);
  if (index < 0) return [];
  return RANK.slice(0, index + 1).flatMap((key) => [...INTRODUCED[key]]);
}

export function planIncludes(plan: string, feature: string): boolean {
  return featuresFor(plan).includes(feature);
}

export interface SeatPerson {
  id: string;
  role: string;
  lastSeenAt: number | null;
  createdAt: number;
}

/** Keeps the owner, then the people seen most recently, up to the cap. Nobody is removed from the list. */
export function seatDecision(people: SeatPerson[], cap: number | null): { active: string[]; paused: string[] } {
  if (cap == null) return { active: people.map((p) => p.id), paused: [] };
  const ranked = [...people].sort((a, b) => {
    if ((a.role === 'owner') !== (b.role === 'owner')) return a.role === 'owner' ? -1 : 1;
    const aSeen = a.lastSeenAt ?? a.createdAt;
    const bSeen = b.lastSeenAt ?? b.createdAt;
    if (aSeen !== bSeen) return bSeen - aSeen;
    return b.createdAt - a.createdAt;
  });
  return {
    active: ranked.slice(0, Math.max(0, cap)).map((p) => p.id),
    paused: ranked.slice(Math.max(0, cap)).map((p) => p.id),
  };
}

/**
 * visibleFrom is the oldest moment still shown.
 * purgeBefore is the oldest moment still kept. When downgraded history is kept,
 * purgeBefore is earlier, so the stretch in between stays on disk but is hidden.
 */
export function historyWindow(input: {
  planCutoffMs: number;
  ownerCutoffMs: number;
  longestCutoffMs: number;
  keepDowngraded: boolean;
}): { visibleFrom: number; purgeBefore: number } {
  const visibleFrom = Math.max(input.planCutoffMs, input.ownerCutoffMs);
  const purgeBefore = input.keepDowngraded
    ? Math.max(input.longestCutoffMs, input.ownerCutoffMs)
    : visibleFrom;
  return { visibleFrom, purgeBefore };
}
