/** Written reports filled from figures Mycroscope already stores. No outside service is called. */

export type ReportTemplate = 'week' | 'workload' | 'software' | 'capacity' | 'trend';

export const REPORT_TITLES: Record<ReportTemplate, string> = {
  week: 'Week in review',
  workload: 'Workload',
  software: 'Where time went',
  capacity: 'Capacity',
  trend: 'How the period changed',
};

export interface WorkloadFigure {
  name: string;
  days: number;
  productiveHours: number;
  utilisation: number | null;
  status: string;
}

export interface SoftwareFigure { name: string; users: number; hours: number }
export interface CapacityFigure { team: string; people: number; avgHours: number | null; gapHours: number | null }
export interface TrendPoint { productiveHours: number; awayHours: number }

export interface ReportFigures {
  scope: string;
  from: string;
  to: string;
  personDays: number;
  productiveHours: number;
  awayHours: number;
  trend: TrendPoint[];
  workload: WorkloadFigure[];
  software: SoftwareFigure[];
  capacity: CapacityFigure[];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dayLabel(ymd: string): string {
  const [year, month, day] = ymd.split('-').map(Number);
  if (!year || !month || !day) return ymd;
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

function hours(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${text} ${rounded === 1 ? 'hour' : 'hours'}`;
}

function people(count: number): string {
  return `${count} ${count === 1 ? 'person' : 'people'}`;
}

function joinNames(names: string[], limit = 4): string {
  const shown = names.slice(0, limit);
  const rest = names.length - shown.length;
  const body = shown.length <= 1
    ? shown.join('')
    : shown.length === 2
      ? `${shown[0]} and ${shown[1]}`
      : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
  return rest > 0 ? `${body}, and ${rest} ${rest === 1 ? 'other' : 'others'}` : body;
}

function period(figures: ReportFigures): string {
  return `${figures.scope}, from ${dayLabel(figures.from)} to ${dayLabel(figures.to)}`;
}

/** A finding the report can lead with. Higher weight wins. */
interface Finding {
  weight: number;
  lead: string;
  support: string;
  /** Still include this after a stronger conclusion, so the report keeps the number. */
  keep?: boolean;
}

const MATERIAL = 45;
const STEADY = 'Nothing in this report is far above or far below the range that would change the conclusion.';
const EMPTY = 'There is not enough recorded activity in this period to write this report.';

function worked(rows: WorkloadFigure[]): WorkloadFigure[] {
  return rows.filter((row) => row.days > 0);
}

function personDetail(row: WorkloadFigure): string {
  const perDay = row.productiveHours / row.days;
  const goal = row.utilisation === null ? '' : `, ${Math.round(row.utilisation)}% of the goal`;
  return `${row.name} (${hours(perDay)} a day over ${row.days} ${row.days === 1 ? 'day' : 'days'}${goal})`;
}

function namedGroup(phrase: string, rows: WorkloadFigure[]): string {
  const verb = rows.length === 1 ? phrase.replace('were', 'was') : phrase;
  return `${people(rows.length)} ${verb}: ${joinNames(rows.map(personDetail))}.`;
}

function workloadFindings(rows: WorkloadFigure[]): Finding[] {
  const active = worked(rows);
  if (active.length === 0) return [];
  const grouped = (status: string) => active.filter((row) => row.status === status);
  const over = grouped('over');
  const under = grouped('under');
  const healthy = grouped('healthy');
  const noGoal = grouped('no_goal').concat(grouped('no_data'));
  const found: Finding[] = [];
  if (over.length > 0) {
    const severe = over.some((row) => (row.utilisation ?? 0) >= 130);
    const majority = over.length * 2 >= active.length && active.length >= 2;
    const detail = namedGroup('were over their goal', over);
    const lead = severe
      ? `The main point is that workload is well above the goal. ${detail}`
      : majority
        ? `The main point is that most people were over their goal. ${detail}`
        : `The main point is workload. ${detail}`;
    found.push({ weight: severe || majority ? 100 : 85, lead, support: detail });
  }
  if (under.length > 0) {
    const majority = under.length * 2 >= active.length && active.length >= 2;
    const detail = namedGroup('were under their goal', under);
    found.push({
      weight: majority ? 80 : 50,
      lead: majority
        ? `The main point is that most people were under their goal. ${detail}`
        : `The main point is spare capacity. ${detail}`,
      support: detail,
    });
  }
  if (healthy.length > 0 && over.length === 0 && under.length === 0) {
    const detail = healthy.length <= 4
      ? `Everyone with a goal was in the healthy range: ${joinNames(healthy.map(personDetail))}.`
      : `All ${healthy.length} people with a goal were in the healthy range.`;
    found.push({ weight: 16, lead: detail, support: detail });
  } else if (healthy.length > 0) {
    const verb = healthy.length === 1 ? 'was' : 'were';
    const detail = healthy.length <= 4
      ? `${people(healthy.length)} ${verb} in the healthy range: ${joinNames(healthy.map(personDetail))}.`
      : `${people(healthy.length)} ${verb} in the healthy range.`;
    found.push({ weight: 20, lead: detail, support: detail, keep: true });
  }
  if (noGoal.length > 0) {
    const detail = `${people(noGoal.length)} had no goal to compare with, so utilisation cannot be judged for them.`;
    const alone = over.length === 0 && under.length === 0;
    found.push({
      weight: alone ? 46 : 25,
      lead: `The main point is that goals are missing. ${detail}`,
      support: detail,
      keep: !alone,
    });
  }
  return found;
}

function softwareList(rows: SoftwareFigure[]): string {
  const parts = rows.map((row) => `${row.name} (${hours(row.hours)}, ${people(row.users)})`);
  const verb = rows.length === 1 ? 'was' : 'were';
  const noun = rows.length === 1 ? 'app or site' : 'apps and sites';
  return `The ${noun} open the longest ${verb} ${joinNames(parts, 5)}. That is time they were open.`;
}

function softwareFindings(rows: SoftwareFigure[], required: boolean): Finding[] {
  const top = rows.filter((row) => row.hours > 0).slice(0, 5);
  if (top.length === 0) return [];
  const total = top.reduce((sum, row) => sum + row.hours, 0);
  const first = top[0];
  const list = softwareList(top);
  const concentrated = total > 0 && first.hours >= total * 0.5 && first.hours >= 5;
  if (concentrated) {
    return [{
      weight: 58,
      lead: `The main point is where time went. ${first.name} was open for ${hours(first.hours)}, more than half of the time in the apps listed. ${list}`,
      support: `${first.name} accounted for more than half of the time in the apps listed. ${list}`,
    }];
  }
  if (!required) return [];
  return [{ weight: 20, lead: list, support: list, keep: true }];
}

function capacitySentence(row: CapacityFigure): string {
  const average = row.avgHours === null ? '' : ` They averaged ${hours(row.avgHours)} of productive time on the days they worked.`;
  const gap = row.gapHours === null || row.gapHours === 0
    ? ''
    : row.gapHours > 0
      ? ` That is ${hours(row.gapHours)} under the goal.`
      : ` That is ${hours(Math.abs(row.gapHours))} over the goal.`;
  return `${row.team} had ${people(row.people)} with activity.${average}${gap}`;
}

function capacityFindings(rows: CapacityFigure[], required: boolean): Finding[] {
  const teams = rows.filter((row) => row.people > 0).slice(0, 8)
    .sort((a, b) => Math.abs(b.gapHours ?? 0) - Math.abs(a.gapHours ?? 0));
  return teams.flatMap((row, index) => {
    const gap = Math.abs(row.gapHours ?? 0);
    const weight = gap >= 2 ? 72 - index : gap >= 1 ? 48 - index : 0;
    if (weight < MATERIAL && !required) return [];
    const sentence = capacitySentence(row);
    const material = weight >= MATERIAL;
    return [{
      weight: material ? weight : 20,
      lead: material ? `The main point is capacity. ${sentence}` : `Capacity is close to the goal. ${sentence}`,
      support: sentence,
      keep: required || material,
    }];
  });
}

function trendFindings(figures: ReportFigures): Finding[] {
  const points = figures.trend.filter((point) => point.productiveHours > 0 || point.awayHours > 0);
  if (points.length < 4) return [];
  const mid = Math.floor(points.length / 2);
  const average = (slice: TrendPoint[]) => slice.reduce((sum, point) => sum + point.productiveHours, 0) / slice.length;
  const early = average(points.slice(0, mid));
  const later = average(points.slice(mid));
  const compared = `${hours(later)} a day after ${hours(early)} a day earlier`;
  if (early < 0.5 && later >= 1) {
    const support = `Productive time was much higher toward the end, ${hours(later)} a day after little or none earlier.`;
    return [{ weight: 70, lead: `The main point is the change through the period. ${support}`, support }];
  }
  if (later > early * 1.25) {
    const support = `Productive time was much higher toward the end, ${compared}.`;
    return [{ weight: 78, lead: `The main point is the change through the period. ${support}`, support }];
  }
  if (early > later * 1.25) {
    const support = `Productive time was much lower toward the end, ${compared}.`;
    return [{ weight: 82, lead: `The main point is the change through the period. ${support}`, support }];
  }
  if (later > early * 1.15) {
    const support = `Productive time was higher toward the end, ${compared}.`;
    return [{ weight: 60, lead: `The main point is the change through the period. ${support}`, support }];
  }
  if (early > later * 1.15) {
    const support = `Productive time was lower toward the end, ${compared}.`;
    return [{ weight: 64, lead: `The main point is the change through the period. ${support}`, support }];
  }
  const support = `Productive time stayed about level, around ${hours((early + later) / 2)} a day.`;
  return [{ weight: 12, lead: support, support, keep: true }];
}

function totalsFinding(figures: ReportFigures, existing: Finding[]): Finding | null {
  if (figures.personDays <= 0 && figures.productiveHours <= 0 && figures.awayHours <= 0) return null;
  const awayAlready = existing.some((item) => item.weight >= MATERIAL && item.lead.includes('away from the computer'));
  const parts: string[] = [];
  if (figures.personDays > 0 || figures.productiveHours > 0) {
    parts.push(`Productive computer time came to ${hours(figures.productiveHours)} across ${figures.personDays} person-${figures.personDays === 1 ? 'day' : 'days'}.`);
  }
  const awayShare = figures.productiveHours + figures.awayHours > 0
    ? figures.awayHours / (figures.productiveHours + figures.awayHours)
    : 0;
  const awayMatters = !awayAlready && figures.awayHours >= 2 && awayShare >= 0.25;
  if (awayMatters) {
    const support = `A further ${hours(figures.awayHours)} away from the computer was counted as productive, about ${Math.round(awayShare * 100)}% of productive time.`;
    existing.push({
      weight: 55,
      lead: `The main point is time away from the computer. ${support}`,
      support,
    });
  } else if (figures.awayHours > 0 && !awayAlready) {
    parts.push(`A further ${hours(figures.awayHours)} away from the computer was counted as productive.`);
  }
  if (parts.length === 0) return null;
  const text = parts.join(' ');
  return { weight: 10, lead: text, support: text, keep: true };
}

function findingsFor(template: ReportTemplate, figures: ReportFigures): Finding[] {
  const found: Finding[] = [];
  if (template === 'week' || template === 'trend') found.push(...trendFindings(figures));
  if (template === 'week' || template === 'workload') found.push(...workloadFindings(figures.workload));
  if (template === 'week' || template === 'software') found.push(...softwareFindings(figures.software, template === 'software'));
  if (template === 'week' || template === 'capacity') found.push(...capacityFindings(figures.capacity, template === 'capacity'));
  const totals = totalsFinding(figures, found);
  if (totals) found.push(totals);
  return found.filter((item) => item.lead.trim() !== '');
}

/** Writes one report. The strongest threshold decides the opening; every number comes from the figures. */
export function writeReport(template: ReportTemplate, figures: ReportFigures): string {
  const heading = `${REPORT_TITLES[template]}. ${period(figures)}.`;
  const ranked = findingsFor(template, figures).sort((a, b) => b.weight - a.weight);
  if (ranked.length === 0) return `${heading}\n\n${EMPTY}`;
  const lead = ranked[0];
  const material = lead.weight >= MATERIAL;
  const rest = ranked.slice(1).filter((item) => item.weight >= MATERIAL || item.keep);
  const opening = material ? lead.lead : `${STEADY} ${lead.support}`;
  return `${heading}\n\n${[opening, ...rest.map((item) => item.support)].join('\n\n')}`;
}

export interface PersonLabel { name: string; pseudo: string }

const DROP = new Set([
  'employee_id', 'team_id', 'asked_by', 'annual_salary', 'annual_cost', 'monthly_cost',
]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function scrubQuestion(question: string, people: PersonLabel[]): string {
  const ordered = [...people].filter((person) => person.name.trim()).sort((a, b) => b.name.length - a.name.length);
  let text = question;
  for (const person of ordered) text = text.replace(new RegExp(escapeRegExp(person.name), 'gi'), person.pseudo);
  return text;
}

export function restoreNames(text: string, people: PersonLabel[]): string {
  const ordered = [...people].sort((a, b) => (Number(b.pseudo.replace(/\D/g, '')) || 0) - (Number(a.pseudo.replace(/\D/g, '')) || 0));
  let out = text;
  for (const person of ordered) out = out.replace(new RegExp(`\\b${escapeRegExp(person.pseudo)}\\b`, 'g'), person.name);
  return out;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

export function pseudonymize(value: unknown, people: PersonLabel[]): unknown {
  const byName = new Map(people.map((person) => [person.name.toLowerCase(), person.pseudo]));
  const walk = (current: unknown, depth: number): unknown => {
    if (depth > 6) return null;
    if (Array.isArray(current)) return current.slice(0, 40).map((item) => walk(item, depth + 1));
    if (!current || typeof current !== 'object') return current;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(current as Record<string, unknown>)) {
      if (DROP.has(key)) continue;
      if ((key === 'name' || key === 'employee_name') && typeof item === 'string' && byName.has(item.toLowerCase())) {
        out.person = byName.get(item.toLowerCase());
        continue;
      }
      if (key.endsWith('_seconds')) {
        const amount = asNumber(item);
        if (amount !== null) {
          out[key.replace(/_seconds$/, '_hours')] = Math.round(amount / 360) / 10;
          continue;
        }
      }
      out[key] = walk(item, depth + 1);
    }
    return out;
  };
  return walk(value, 0);
}
