import { activityChart } from './charts.ts';
import { formatDay, formatDuration, percent } from './format.ts';
import type { PdfReport } from './pdf.ts';

export interface ReportDay {
  day: string;
  active: number;
  idle: number;
  paused: number;
  away: number;
  offline: number;
  productiveOffline: number;
}

export interface ReportPerson {
  name: string;
  days: ReportDay[];
}

export interface ActivityReportInput {
  organization: string;
  timezone: string;
  scopeName: string;
  periodLabel: string;
  from: string;
  to: string;
  /** Null when the report includes every project. */
  projectLabel: string | null;
  generatedBy: string;
  people: ReportPerson[];
  apps: { name: string; active: number; idle: number }[];
  websites: { name: string; active: number }[];
  categories: { category: string; active: number }[];
  projects: { name: string; active: number }[];
  /**
   * Omitted fields are included, so a caller that does not know the plan still
   * gets the full report. The screens pass the organisation's grants.
   */
  access?: {
    /** Website and application usage. Work Activity Tracking and above. */
    software?: boolean;
    /** Written coaching. Productivity Optimization. */
    coaching?: boolean;
  };
}

const GREEN = '#059669';
const RED = '#dc2626';
const NAVY = '#1e3a8a';
const AMBER = '#d97706';
const GREY = '#9ca3af';

const CATEGORY_LABEL: Record<string, string> = {
  productive: 'Productive', neutral: 'Neutral', unproductive: 'Unproductive', uncategorised: 'Not categorised',
};
const CATEGORY_COLOR: Record<string, string> = {
  productive: GREEN, neutral: NAVY, unproductive: RED, uncategorised: GREY,
};

function sum(people: ReportPerson[], key: keyof ReportDay): number {
  return people.reduce((total, person) => total + person.days.reduce((inner, day) => inner + Number(day[key] ?? 0), 0), 0);
}

function hours(seconds: number): number {
  return Math.round((seconds / 3600) * 10) / 10;
}

function topChart(title: string, rows: { label: string; seconds: number; color?: string }[]) {
  const shown = rows.filter((row) => row.seconds > 0).sort((a, b) => b.seconds - a.seconds).slice(0, 8);
  if (shown.length === 0) return null;
  return {
    title,
    unit: 'h',
    points: shown.map((row) => ({
      label: row.label.length > 12 ? `${row.label.slice(0, 11)}.` : row.label,
      value: hours(row.seconds),
      color: row.color ?? NAVY,
    })),
  };
}

function shareOf(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

function allows(input: ActivityReportInput, key: 'software' | 'coaching'): boolean {
  return input.access?.[key] !== false;
}

/** Findings a manager can act on, written from the figures in this filter. */
export function activityRecommendations(input: ActivityReportInput): string[] {
  const active = sum(input.people, 'active');
  const idle = sum(input.people, 'idle');
  const paused = sum(input.people, 'paused');
  const notes: string[] = [];
  if (active === 0) {
    notes.push('There is not enough recorded activity in this filter to recommend a change. Widen the period, or confirm the desktop app was running.');
    return notes;
  }
  const idleShare = shareOf(idle, active + idle);
  const idlest = [...input.apps].sort((a, b) => b.idle - a.idle)[0];
  if (idleShare >= 0.4) {
    const where = allows(input, 'software') && idlest && idlest.idle > 0
      ? ` ${idlest.name} has the most idle time (${formatDuration(idlest.idle)}).` : '';
    notes.push(`Idle time is ${percent(idle, active + idle)} of active plus idle.${where} Check whether that time is waiting on something else, or an application left open.`);
  } else if (idleShare < 0.15 && active >= 3 * 3600) {
    notes.push(`Idle time is only ${percent(idle, active + idle)} of active plus idle. Keep the stretches of focused work that produced this, and compare the next period with this one.`);
  }
  const categorised = allows(input, 'software') ? input.categories.reduce((total, row) => total + row.active, 0) : 0;
  const unproductive = input.categories.find((row) => row.category === 'unproductive')?.active ?? 0;
  const uncategorised = input.categories.find((row) => row.category === 'uncategorised')?.active ?? 0;
  if (categorised > 0 && shareOf(unproductive, categorised) >= 0.25) {
    notes.push(`Unproductive applications and websites are ${percent(unproductive, categorised)} of active time. Review that list with the person and agree what should drop in the next period.`);
  }
  if (categorised > 0 && shareOf(uncategorised, categorised) >= 0.8) {
    notes.push('Almost all of this time is still uncategorised. Mark the main applications and websites as productive or unproductive so the next report can judge the work.');
  }
  const busiest = allows(input, 'software') ? [...input.apps].sort((a, b) => b.active - a.active)[0] : undefined;
  if (busiest && shareOf(busiest.active, active) >= 0.5) {
    notes.push(`${busiest.name} is ${percent(busiest.active, active)} of active time. Confirm that this matches the work expected in this filter, and that the rest of the job still has time around it.`);
  }
  if (shareOf(paused, active + paused) >= 0.25) {
    notes.push(`Paused time is ${percent(paused, active + paused)} of active plus paused. Confirm those pauses were intentional breaks from tracking.`);
  }
  if (input.projectLabel) {
    notes.push(`This report is limited to ${input.projectLabel}. Time away is left out, because meetings, calls and breaks are not stored against a project. Open All projects when that time should be included.`);
  }
  const quiet = input.people.length === 1
    ? input.people[0].days.filter((day) => day.active === 0).map((day) => formatDay(day.day, { weekday: true }))
    : [];
  if (quiet.length > 0 && quiet.length <= 4) {
    notes.push(`No active time was recorded on ${quiet.join(', ')}. Check whether that was leave, a day off, or a day the desktop app did not run.`);
  }
  if (input.people.length > 1) {
    const ranked = input.people
      .map((person) => ({ name: person.name, active: person.days.reduce((total, day) => total + day.active, 0) }))
      .filter((person) => person.active > 0)
      .sort((a, b) => b.active - a.active);
    if (ranked.length >= 2 && ranked[0].active >= ranked[ranked.length - 1].active * 2) {
      notes.push(`${ranked[0].name} recorded ${formatDuration(ranked[0].active)} active and ${ranked[ranked.length - 1].name} recorded ${formatDuration(ranked[ranked.length - 1].active)}. Use that gap to start a workload conversation. The figures alone do not show why.`);
    }
  }
  if (notes.length === 0) {
    notes.push('Nothing in this filter is far enough from the rest of the period to single out. Keep the same filter next period and compare active time, idle time and the top applications.');
  }
  return notes;
}

/** Manager PDF for the filters currently selected: period, day, person, team, project or no project. */
export function buildActivityReport(input: ActivityReportInput): PdfReport {
  const active = sum(input.people, 'active');
  const idle = sum(input.people, 'idle');
  const paused = sum(input.people, 'paused');
  const away = sum(input.people, 'away');
  const offline = sum(input.people, 'offline');
  const productiveOffline = sum(input.people, 'productiveOffline');
  const single = input.people.length === 1 ? input.people[0] : undefined;
  const scope = input.projectLabel ? `${input.scopeName} · ${input.projectLabel}` : input.scopeName;
  const when = input.from === input.to
    ? formatDay(input.from, { weekday: true })
    : `${formatDay(input.from)} – ${formatDay(input.to)}`;
  const activity = single
    ? single.days.map((day) => ({ label: formatDay(day.day).replace(/ \d{4}$/, ''), activeSeconds: day.active }))
    : input.people.map((person) => ({
      label: person.name,
      activeSeconds: person.days.reduce((total, day) => total + day.active, 0),
    }));
  const software = allows(input, 'software');
  const charts = [
    activityChart(activity, !single),
    software ? topChart('Applications', input.apps.map((app) => ({ label: app.name, seconds: app.active }))) : null,
    software ? topChart('Websites', input.websites.map((site) => ({ label: site.name, seconds: site.active, color: AMBER }))) : null,
    software ? topChart('Productivity', input.categories.map((row) => ({
      label: CATEGORY_LABEL[row.category] ?? row.category,
      seconds: row.active,
      color: CATEGORY_COLOR[row.category] ?? NAVY,
    }))) : null,
    input.projectLabel ? null : topChart('Projects', input.projects.map((project) => ({ label: project.name, seconds: project.active, color: '#7c3aed' }))),
  ].filter((chart): chart is NonNullable<typeof chart> => chart !== null);

  const appLines = software ? [...input.apps].sort((a, b) => b.active - a.active).slice(0, 8)
    .filter((app) => app.active > 0)
    .map((app) => `${app.name}: ${formatDuration(app.active)} active, ${formatDuration(app.idle)} idle`) : [];
  const siteLines = software ? [...input.websites].sort((a, b) => b.active - a.active).slice(0, 8)
    .filter((site) => site.active > 0)
    .map((site) => `${site.name}: ${formatDuration(site.active)}`) : [];
  const projectLines = [...input.projects].sort((a, b) => b.active - a.active)
    .filter((project) => project.active > 0)
    .map((project) => `${project.name}: ${formatDuration(project.active)} (${percent(project.active, active)})`);

  const table = single
    ? {
      headers: ['Day', 'Active', 'Idle', 'Paused', 'Away', 'Time away'],
      rows: single.days.map((day) => [
        formatDay(day.day, { weekday: true }),
        formatDuration(day.active), formatDuration(day.idle), formatDuration(day.paused),
        formatDuration(day.away), formatDuration(day.offline),
      ]),
      numericFrom: 1,
    }
    : {
      headers: ['Employee', 'Active', 'Idle', 'Paused', 'Days active', 'Active share'],
      rows: input.people.map((person) => {
        const personActive = person.days.reduce((total, day) => total + day.active, 0);
        const personIdle = person.days.reduce((total, day) => total + day.idle, 0);
        const personPaused = person.days.reduce((total, day) => total + day.paused, 0);
        const daysWorked = person.days.filter((day) => day.active > 0).length;
        return [
          person.name, formatDuration(personActive), formatDuration(personIdle), formatDuration(personPaused),
          String(daysWorked), percent(personActive, personActive + personIdle),
        ];
      }),
      numericFrom: 1,
    };

  return {
    kicker: input.organization,
    title: 'Activity report',
    subtitle: `${scope} · ${input.periodLabel} · ${when} · times in ${input.timezone}`,
    intro: `Total: ${formatDuration(active)} active, ${formatDuration(idle)} idle, ${formatDuration(paused)} paused, and ${formatDuration(away)} away. Time away answers add up to ${formatDuration(offline)}, of which ${formatDuration(productiveOffline)} is counted as productive.`,
    charts,
    sections: [
      {
        heading: 'Where the time went',
        paragraphs: [
          !software ? '' : appLines.length > 0 ? `Applications: ${appLines.join('; ')}.` : 'No applications were recorded for this filter.',
          !software ? '' : siteLines.length > 0 ? `Websites: ${siteLines.join('; ')}.` : 'No websites were recorded for this filter.',
          projectLines.length > 0 && !input.projectLabel ? `Projects: ${projectLines.join('; ')}.` : '',
        ].filter(Boolean),
      },
      ...(allows(input, 'coaching') ? [{
        heading: 'What to improve',
        paragraphs: activityRecommendations(input),
      }] : []),
    ].filter((section) => section.paragraphs.length > 0),
    table,
    notes: [
      'Active means keyboard or mouse input within the idle threshold. Idle is the computer running without that input.',
      'Time away is what people said an idle or away stretch was. A named project or No project leaves it out, because it is not stored on a project.',
    ],
    notice: `Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC by ${input.generatedBy}. Contains personal information. Handle it under POPIA.`,
  };
}
