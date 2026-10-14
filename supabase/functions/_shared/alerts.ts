// Alert messages for Slack, Microsoft Teams and signed webhooks.
import { hmacHex } from './billing.ts';

export type Severity = 'low' | 'medium' | 'high';

export interface ChannelAlert {
  employee_id: string;
  employee_name: string;
  occurred_at: string;
  kind: string;
  severity: Severity;
  details: Record<string, unknown> | null;
}

export const ALERT_TITLES: Record<string, string> = {
  agent_gap: 'App stopped',
  not_reporting: 'Not reporting',
  vm_detected: 'Virtual machine',
  remote_session: 'Remote session',
  input_anomaly: 'Possible mouse jiggler',
  clock_skew: 'Clock wrong',
  after_hours_use: 'After-hours use',
  tracking_late: 'Started late',
  agent_uninstalled: 'App uninstalled',
  unattended_use: 'Used without signing in',
  policy_violation: 'Alert rule',
  device_connected: 'Device connected',
  files_copied: 'Files copied',
  test: 'Test',
};

const DESTINATIONS: Record<string, string> = {
  removable: 'a USB drive or external disk',
  phone: 'a phone',
  cloud: 'a cloud sync folder',
  network: 'a network drive',
};

const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0));
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function duration(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 1) return `${Math.max(1, Math.round(seconds))} s`;
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** One plain-language sentence. Never includes file names: those are only shown in the app, where views are audited. */
export function describeAlert(a: Pick<ChannelAlert, 'kind' | 'details'>): string {
  const d = a.details ?? {};
  switch (a.kind) {
    case 'agent_gap':
      return `The desktop app was not running for ${num(d.minutes)} minutes while the PC was in use.`;
    case 'not_reporting':
      return `No contact from the desktop app for ${num(d.minutes)} minutes during working hours.`;
    case 'vm_detected':
      return `The desktop app is running inside a virtual machine${d.vendor ? ` (${str(d.vendor)})` : ''}.`;
    case 'remote_session':
      return 'The PC was being used through a remote desktop session.';
    case 'input_anomaly':
      return `Keyboard or mouse input arrived every ${num(d.interval_seconds)} seconds for ${num(d.minutes)} minutes, like a mouse jiggler.`;
    case 'clock_skew':
      return `The PC's clock was ${Math.abs(num(d.offset_seconds))} seconds off.`;
    case 'after_hours_use':
      return 'The PC was in use outside working hours.';
    case 'tracking_late':
      return `Mycroscope started ${num(d.minutes)} minutes after the PC was in use during working hours.`;
    case 'agent_uninstalled':
      return `Mycroscope was uninstalled${d.hostname ? ` from "${str(d.hostname)}"` : ''}.`;
    case 'unattended_use':
      return `${d.hostname ? `"${str(d.hostname)}"` : 'A PC'} was used for ${num(d.minutes)} minutes without anyone signed in to Mycroscope.`;
    case 'policy_violation': {
      const matched = Array.isArray(d.matched) ? d.matched.map(str).filter(Boolean).join(', ') : '';
      return `${str(d.rule) || 'Alert rule'}: ${matched || 'matched'} for ${duration(num(d.seconds))}.`;
    }
    case 'device_connected':
      return d.destination === 'phone'
        ? `A phone${d.label ? ` ("${str(d.label)}")` : ''} was connected to the PC.`
        : `A USB drive or external disk${d.label ? ` ("${str(d.label)}")` : ''} was connected to the PC.`;
    case 'files_copied': {
      const files = num(d.files);
      const where = DESTINATIONS[str(d.destination)] ?? 'another location';
      return `${files} ${files === 1 ? 'file' : 'files'} (${formatBytes(num(d.bytes))}) copied to ${where}${d.label ? ` ("${str(d.label)}")` : ''}.`;
    }
    case 'test':
      return 'This is a test message. Mycroscope alerts will appear here.';
    default:
      return a.kind.replace(/_/g, ' ');
  }
}

function when(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

const MAX_LINES = 20;
const oneLine = (s: string, max = 200) => s.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
const slackEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function heading(org: string, count: number): string {
  return `Mycroscope: ${count} new ${count === 1 ? 'alert' : 'alerts'} at ${oneLine(org, 120)}`;
}

function lines(alerts: ChannelAlert[], timeZone: string): string[] {
  const sorted = [...alerts].sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
  const out = sorted.slice(0, MAX_LINES).map((a) =>
    `[${a.severity.toUpperCase()}] ${oneLine(a.employee_name, 80)} · ${ALERT_TITLES[a.kind] ?? a.kind} · ${when(a.occurred_at, timeZone)}: ${oneLine(describeAlert(a), 300)}`);
  if (sorted.length > MAX_LINES) out.push(`…and ${sorted.length - MAX_LINES} more in the app.`);
  return out;
}

export function slackMessage(org: string, alerts: ChannelAlert[], timeZone: string, appUrl: string): { text: string } {
  const body = lines(alerts, timeZone).map((l) => `• ${slackEscape(l)}`).join('\n');
  const link = appUrl ? `\n<${appUrl}/alerts|Open Mycroscope>` : '';
  return { text: `*${slackEscape(heading(org, alerts.length))}*\n${body}${link}` };
}

/** Teams workflow webhooks ("When a Teams webhook request is received") take an Adaptive Card. */
export function teamsMessage(org: string, alerts: ChannelAlert[], timeZone: string, appUrl: string): unknown {
  return {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        body: [
          { type: 'TextBlock', text: heading(org, alerts.length), weight: 'Bolder', size: 'Medium', wrap: true },
          ...lines(alerts, timeZone).map((l) => ({ type: 'TextBlock', text: l, wrap: true, spacing: 'Small' })),
        ],
        ...(appUrl ? { actions: [{ type: 'Action.OpenUrl', title: 'Open Mycroscope', url: `${appUrl}/alerts` }] } : {}),
      },
    }],
  };
}

export function webhookBody(org: string, alerts: ChannelAlert[], sentAt: string, test = false): string {
  return JSON.stringify({
    event: test ? 'test' : 'alerts',
    organization: org,
    sent_at: sentAt,
    alerts: alerts.map((a) => ({ ...a, title: ALERT_TITLES[a.kind] ?? a.kind, description: describeAlert(a) })),
  });
}

/**
 * Header X-Mycroscope-Signature: "t=<unix seconds>,v1=<hex HMAC-SHA256 of `${t}.${body}` with the signing secret>".
 * Receivers should recompute it and reject requests older than a few minutes.
 */
export async function signWebhook(secret: string, body: string, unixSeconds: number): Promise<string> {
  return `t=${unixSeconds},v1=${await hmacHex('SHA-256', secret, `${unixSeconds}.${body}`)}`;
}

export const TEST_ALERT: ChannelAlert = {
  employee_id: '00000000-0000-0000-0000-000000000000',
  employee_name: 'Test message',
  occurred_at: new Date(0).toISOString(),
  kind: 'test',
  severity: 'low',
  details: {},
};

export interface Channel {
  kind: 'slack' | 'teams' | 'webhook';
  url: string;
  signing_secret: string | null;
  organization_name: string;
  timezone: string;
}

/** Posts alerts to one channel. Returns null when delivered, otherwise a short error for the app to show. */
export async function deliver(channel: Channel, alerts: ChannelAlert[], appUrl: string, test = false): Promise<string | null> {
  const now = new Date();
  let body: string;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': 'Mycroscope-Alerts/1' };
  if (channel.kind === 'slack') {
    body = JSON.stringify(test
      ? { text: `Mycroscope test message for ${oneLine(channel.organization_name, 120)}. Alerts will appear in this channel.` }
      : slackMessage(channel.organization_name, alerts, channel.timezone, appUrl));
  } else if (channel.kind === 'teams') {
    body = JSON.stringify(test
      ? teamsMessage(channel.organization_name, [{ ...TEST_ALERT, occurred_at: now.toISOString() }], channel.timezone, appUrl)
      : teamsMessage(channel.organization_name, alerts, channel.timezone, appUrl));
  } else {
    body = webhookBody(channel.organization_name, test ? [] : alerts, now.toISOString(), test);
    if (!channel.signing_secret) return 'This webhook has no signing secret';
    headers['X-Mycroscope-Signature'] = await signWebhook(channel.signing_secret, body, Math.floor(now.getTime() / 1000));
  }
  try {
    const res = await fetch(channel.url, {
      method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(10_000),
    });
    await res.body?.cancel().catch(() => undefined);
    return res.ok ? null : `HTTP ${res.status}`;
  } catch (e) {
    return (e as Error).name === 'TimeoutError' ? 'No answer within 10 seconds' : 'Could not connect';
  }
}
