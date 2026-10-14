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

function worked(rows: WorkloadFigure[]): WorkloadFigure[] {
  return rows.filter((row) => row.days > 0);
}

function workloadSentences(rows: WorkloadFigure[]): string[] {
  const active = worked(rows);
  if (active.length === 0) return [];
  const grouped = (status: string) => active.filter((row) => row.status === status);
  const sentence = (status: string, phrase: string) => {
    const group = grouped(status);
    if (group.length === 0) return '';
    const detail = group.map((row) => {
      const perDay = row.productiveHours / row.days;
      const goal = row.utilisation === null ? '' : `, ${Math.round(row.utilisation)}% of the goal`;
      return `${row.name} (${hours(perDay)} a day over ${row.days} ${row.days === 1 ? 'day' : 'days'}${goal})`;
    });
    const verb = group.length === 1 ? phrase.replace('were', 'was') : phrase;
    return `${people(group.length)} ${verb}: ${joinNames(detail)}.`;
  };
  const lines = [
    sentence('over', 'were over their goal'),
    sentence('healthy', 'were in the healthy range'),
    sentence('under', 'were under their goal'),
  ].filter(Boolean);
  const noGoal = grouped('no_goal').length + grouped('no_data').length;
  if (noGoal > 0) lines.push(`${people(noGoal)} had no goal to compare with.`);
  return lines;
}

function softwareSentence(rows: SoftwareFigure[]): string {
  const top = rows.filter((row) => row.hours > 0).slice(0, 5);
  if (top.length === 0) return '';
  const parts = top.map((row) => `${row.name} (${hours(row.hours)}, ${people(row.users)})`);
  const verb = top.length === 1 ? 'was' : 'were';
  const noun = top.length === 1 ? 'app or site' : 'apps and sites';
  return `The ${noun} open the longest ${verb} ${joinNames(parts, 5)}. That is time they were open.`;
}

function capacitySentences(rows: CapacityFigure[]): string[] {
  return rows.filter((row) => row.people > 0).slice(0, 8).map((row) => {
    const average = row.avgHours === null ? '' : ` They averaged ${hours(row.avgHours)} of productive time on the days they worked.`;
    const gap = row.gapHours === null || row.gapHours === 0
      ? ''
      : row.gapHours > 0
        ? ` That is ${hours(row.gapHours)} under the goal.`
        : ` That is ${hours(Math.abs(row.gapHours))} over the goal.`;
    return `${row.team} had ${people(row.people)} with activity.${average}${gap}`;
  });
}

function trendSentences(figures: ReportFigures): string[] {
  const lines: string[] = [];
  if (figures.personDays > 0 || figures.productiveHours > 0) {
    lines.push(`Productive computer time came to ${hours(figures.productiveHours)} across ${figures.personDays} person-${figures.personDays === 1 ? 'day' : 'days'}.`);
  }
  if (figures.awayHours > 0) {
    lines.push(`A further ${hours(figures.awayHours)} away from the computer was counted as productive.`);
  }
  const points = figures.trend.filter((point) => point.productiveHours > 0 || point.awayHours > 0);
  if (points.length >= 4) {
    const mid = Math.floor(points.length / 2);
    const average = (slice: TrendPoint[]) => slice.reduce((sum, point) => sum + point.productiveHours, 0) / slice.length;
    const early = average(points.slice(0, mid));
    const later = average(points.slice(mid));
    if (later > early * 1.15) {
      lines.push(`Productive time was higher toward the end of the period, ${hours(later)} a day after ${hours(early)} a day earlier.`);
    } else if (early > later * 1.15) {
      lines.push(`Productive time was lower toward the end of the period, ${hours(later)} a day after ${hours(early)} a day earlier.`);
    } else {
      lines.push(`Productive time stayed about level, around ${hours((early + later) / 2)} a day.`);
    }
  }
  return lines;
}

const EMPTY = 'There is not enough recorded activity in this period to write this report.';

/** Writes one report. Every figure in the text comes from the supplied numbers. */
export function writeReport(template: ReportTemplate, figures: ReportFigures): string {
  const heading = `${REPORT_TITLES[template]}. ${period(figures)}.`;
  const sections: string[] = [];
  if (template === 'week' || template === 'trend') sections.push(...trendSentences(figures));
  if (template === 'week' || template === 'workload') sections.push(...workloadSentences(figures.workload));
  if (template === 'week' || template === 'software') {
    const software = softwareSentence(figures.software);
    if (software) sections.push(software);
  }
  if (template === 'week' || template === 'capacity') sections.push(...capacitySentences(figures.capacity));
  if (sections.length === 0) return `${heading}\n\n${EMPTY}`;
  return `${heading}\n\n${sections.join(' ')}`;
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
