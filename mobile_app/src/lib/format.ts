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
