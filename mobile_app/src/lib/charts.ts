import type { CapacityRow, Granularity, SoftwareUsage, TrendPoint, WorkloadRow } from './api';

/** One column chart. Colours are hex so the screen and the PDF draw the same bars. */
export interface ChartSeries {
  title: string;
  unit: string;
  points: { label: string; value: number; color?: string }[];
}

const GREEN = '#059669';
const RED = '#dc2626';
const AMBER = '#d97706';
const NAVY = '#1e3a8a';
const GREY = '#6b7280';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const WORKLOAD_COLOR: Record<string, string> = {
  over: RED, under: AMBER, healthy: GREEN, no_goal: GREY, no_data: GREY,
};

function axisLabel(start: string, granularity: Granularity, many: boolean): string {
  const day = Number(start.slice(8, 10));
  const month = MONTHS[Number(start.slice(5, 7)) - 1] ?? '';
  if (granularity === 'month') return `${month} ${start.slice(2, 4)}`;
  if (many && granularity === 'day') return String(day);
  return `${day} ${month}`;
}

function shortName(name: string): string {
  const first = name.trim().split(/\s+/)[0] || name;
  return first.length > 10 ? `${first.slice(0, 9)}.` : first;
}

function hours(seconds: number): number {
  return Math.round((seconds / 3600) * 10) / 10;
}

export function trendChart(points: TrendPoint[], granularity: Granularity): ChartSeries | null {
  const shown = points.filter((point) => point.person_days > 0);
  if (shown.length === 0) return null;
  return {
    title: 'Productive hours',
    unit: 'h',
    points: shown.map((point) => ({
      label: axisLabel(point.period_start, granularity, shown.length > 16),
      value: hours(point.productive_seconds + point.productive_offline_seconds),
      color: GREEN,
    })),
  };
}

export function workloadChart(rows: WorkloadRow[]): ChartSeries | null {
  const scored = rows
    .filter((row) => row.utilisation !== null && row.days_worked > 0)
    .sort((a, b) => (b.utilisation ?? 0) - (a.utilisation ?? 0))
    .slice(0, 12);
  if (scored.length === 0) return null;
  return {
    title: 'Share of the daily goal',
    unit: '%',
    points: scored.map((row) => ({
      label: shortName(row.name),
      value: Math.round(row.utilisation ?? 0),
      color: WORKLOAD_COLOR[row.status] ?? NAVY,
    })),
  };
}

export function softwareChart(rows: SoftwareUsage[]): ChartSeries | null {
  const top = [...rows].sort((a, b) => b.active_seconds - a.active_seconds).slice(0, 8)
    .filter((row) => row.active_seconds > 0);
  if (top.length === 0) return null;
  return {
    title: 'Where time went',
    unit: 'h',
    points: top.map((row) => ({
      label: shortName(row.name),
      value: hours(row.active_seconds),
      color: row.category === 'productive' ? GREEN : row.category === 'unproductive' ? RED : NAVY,
    })),
  };
}

export function capacityChart(rows: CapacityRow[]): ChartSeries | null {
  const scored = rows.filter((row) => row.goal_hours !== null && row.person_days > 0);
  if (scored.length === 0) return null;
  return {
    title: 'Productive hours a day, by team',
    unit: 'h',
    points: scored.map((row) => ({
      label: shortName(row.team_name ?? 'No team'),
      value: Math.round(row.avg_productive_hours * 10) / 10,
      color: row.fte_gap === null ? GREY : row.fte_gap < 0 ? RED : row.fte_gap > 0 ? AMBER : GREEN,
    })),
  };
}

export function writtenCharts(input: {
  trend: TrendPoint[];
  workload: WorkloadRow[];
  software: SoftwareUsage[];
  capacity: CapacityRow[];
  granularity: Granularity;
}): ChartSeries[] {
  return [
    trendChart(input.trend, input.granularity),
    workloadChart(input.workload),
    softwareChart(input.software),
    capacityChart(input.capacity),
  ].filter((chart): chart is ChartSeries => chart !== null);
}

export function activityChart(
  rows: { label: string; activeSeconds: number }[],
  ranked = false,
): ChartSeries | null {
  const active = rows.filter((row) => row.activeSeconds > 0);
  const shown = ranked
    ? [...active].sort((a, b) => b.activeSeconds - a.activeSeconds).slice(0, 12)
    : active.slice(0, 31);
  if (shown.length === 0) return null;
  return {
    title: ranked && active.length > shown.length ? 'Active hours, highest first' : 'Active hours',
    unit: 'h',
    points: shown.map((row) => ({
      label: row.label.length > 12 ? shortName(row.label) : row.label,
      value: hours(row.activeSeconds),
      color: GREEN,
    })),
  };
}
