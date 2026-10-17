// Pure date/duration helpers. Calendar days are always days in the organisation's
// timezone (YYYY-MM-DD strings), which is how the server reports them.

export type Ymd = string;

export function todayIn(timeZone: string, now: Date = new Date()): Ymd {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function addDays(day: Ymd, n: number): Ymd {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 0 = Monday ... 6 = Sunday */
export function weekdayIndex(day: Ymd): number {
  return (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7;
}

function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - utcMs;
}

/** The UTC instant at which `day` starts (00:00) in `timeZone`, as an ISO string. */
export function dayStartUtc(day: Ymd, timeZone: string): string {
  const naive = Date.parse(`${day}T00:00:00Z`);
  let utc = naive - zoneOffsetMs(naive, timeZone);
  utc = naive - zoneOffsetMs(utc, timeZone);
  return new Date(utc).toISOString();
}

export function daysBetween(from: Ymd, to: Ymd): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

/** The first day of the month containing `day`. */
export function monthStart(day: Ymd): Ymd {
  return `${day.slice(0, 7)}-01`;
}

/** Move by whole months and land on the first of that month. */
export function addMonths(day: Ymd, n: number): Ymd {
  const [y, m] = monthStart(day).split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

/** Monday-first month grid. Nulls are the blank cells before the 1st. */
export function monthCells(firstOfMonth: Ymd): (Ymd | null)[] {
  const first = monthStart(firstOfMonth);
  const blanks = weekdayIndex(first);
  const [y, m] = first.split('-').map(Number);
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells: (Ymd | null)[] = Array(blanks).fill(null);
  for (let day = 1; day <= count; day++) cells.push(`${first.slice(0, 7)}-${String(day).padStart(2, '0')}`);
  return cells;
}

export function formatMonth(day: Ymd): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(
    new Date(`${monthStart(day)}T12:00:00Z`),
  );
}

export type PeriodKey = 'today' | 'yesterday' | 'this_week' | 'last_week' | 'this_month' | 'last_month';

export const PERIOD_LABELS: Record<PeriodKey, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  this_week: 'This week',
  last_week: 'Last week',
  this_month: 'This month',
  last_month: 'Last month',
};

export function periodRange(key: PeriodKey, today: Ymd): { from: Ymd; to: Ymd } {
  switch (key) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday': {
      const y = addDays(today, -1);
      return { from: y, to: y };
    }
    case 'this_week': {
      const from = addDays(today, -weekdayIndex(today));
      return { from, to: today };
    }
    case 'last_week': {
      const thisMonday = addDays(today, -weekdayIndex(today));
      return { from: addDays(thisMonday, -7), to: addDays(thisMonday, -1) };
    }
    case 'this_month':
      return { from: `${today.slice(0, 8)}01`, to: today };
    case 'last_month': {
      const firstThis = `${today.slice(0, 8)}01`;
      const lastPrev = addDays(firstThis, -1);
      return { from: `${lastPrev.slice(0, 8)}01`, to: lastPrev };
    }
  }
}

export function formatDuration(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h === 0 && m === 0) return s > 0 ? '<1m' : '0m';
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

const OFFLINE_PARTS = [
  ['meeting_seconds', 'in meetings'],
  ['call_seconds', 'on calls'],
  ['break_seconds', 'on breaks'],
  ['other_seconds', 'other'],
] as const;

export type OfflineSeconds = Partial<Record<(typeof OFFLINE_PARTS)[number][0], number>>;

/** Total of the four answers, which still also sit inside idle or away time. */
export function offlineSeconds(row: OfflineSeconds): number {
  return OFFLINE_PARTS.reduce((sum, [key]) => sum + (Number(row[key]) || 0), 0);
}

/** "45m in meetings, 15m on breaks", or "" when there is nothing to explain. */
export function offlineSummary(row: OfflineSeconds): string {
  return OFFLINE_PARTS
    .filter(([key]) => (Number(row[key]) || 0) > 0)
    .map(([key, label]) => `${formatDuration(row[key])} ${label}`)
    .join(', ');
}

export function formatTime(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return '–';
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(
    new Date(iso),
  );
}

export function formatDateTime(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return '–';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso));
}

export function formatDate(iso: string | null | undefined, timeZone = 'Africa/Johannesburg'): string {
  if (!iso) return '–';
  return new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
}

/** Money in the smallest unit (cents) as e.g. "R 1 234.00". */
export function formatMoney(cents: number, currency = 'ZAR'): string {
  return new Intl.NumberFormat('en-ZA', { style: 'currency', currency }).format(cents / 100);
}

export function formatDay(day: Ymd, opts: { weekday?: boolean } = {}): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric', ...(opts.weekday ? { weekday: 'short' } : {}),
  }).format(new Date(`${day}T12:00:00Z`));
}

export function formatRelative(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return 'never';
  const secs = Math.round((now.getTime() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
  if (secs < 86_400) return `${Math.floor(secs / 3600)} h ago`;
  return `${Math.floor(secs / 86_400)} d ago`;
}

export function percent(part: number, whole: number): string {
  if (!whole) return '–';
  return `${Math.round((part / whole) * 100)}%`;
}

export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheets running formulas
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}

export function htmlEscape(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
