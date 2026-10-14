import type { IntegrityAlert } from './api';

const n = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0));

export function formatBytes(bytes: number | null | undefined): string {
  const b = Number(bytes ?? 0);
  if (!Number.isFinite(b) || b < 1024) return `${Math.max(0, Math.round(b || 0))} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function minutesText(seconds: number) {
  const m = Math.max(1, Math.round(seconds / 60));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

export const DESTINATIONS: Record<string, string> = {
  removable: 'a USB drive or external disk',
  phone: 'a phone',
  cloud: 'a cloud sync folder',
  network: 'a network drive',
};

/** Plain-language description of an integrity alert. */
export function describeAlert(a: Pick<IntegrityAlert, 'kind' | 'details'>): string {
  const d = a.details ?? {};
  switch (a.kind) {
    case 'agent_gap':
      return `The desktop app was not running for ${n(d.minutes)} minutes while the PC was on and awake (it was closed or stopped without signing out).`;
    case 'not_reporting':
      return `No contact from the desktop app for ${n(d.minutes)} minutes during working hours (PC off, offline, or the app was removed).`;
    case 'vm_detected':
      return `The desktop app is running inside a virtual machine${d.vendor ? ` (${String(d.vendor)})` : ''}, so the recorded activity may not be the employee's real PC.`;
    case 'remote_session':
      return 'The PC was being used through a remote desktop session.';
    case 'input_anomaly':
      return `Keyboard/mouse input arrived every ${n(d.interval_seconds)} seconds like clockwork for ${n(d.minutes)} minutes with nothing else changing. This is typical of a "mouse jiggler" device or script.`;
    case 'clock_skew':
      return `The PC's clock was ${Math.abs(n(d.offset_seconds))} seconds off; server time was used instead.`;
    case 'after_hours_use':
      return 'The PC was in use outside working hours (nothing about what it was used for is recorded).';
    case 'tracking_late':
      return `Mycroscope only started ${n(d.minutes)} minutes after this PC was switched on and used during working hours. This can happen if the app was removed, the PC restarted and used, then the app reinstalled.`;
    case 'agent_uninstalled':
      return `Mycroscope was uninstalled from ${d.hostname ? `the PC "${String(d.hostname)}"` : 'this PC'}. On company-managed PCs employees cannot do this; on personal PCs they can, and it is recorded here.`;
    case 'unattended_use':
      return `${d.hostname ? `The PC "${String(d.hostname)}"` : 'A PC'} was used for ${n(d.minutes)} minutes without Mycroscope tracking: nobody was signed in, or the monitoring notice was not accepted. It is listed under the last person who signed in on it; nothing about what it was used for is recorded.`;
    case 'policy_violation': {
      const matched = Array.isArray(d.matched) ? d.matched.map(String).filter(Boolean).join(', ') : '';
      return `Alert rule "${String(d.rule ?? 'rule')}": ${matched || 'a match'} was in use for ${minutesText(n(d.seconds))}. This shows the ${d.rule_kind === 'app' ? 'program was used' : 'site was visited'}, not what was done there.`;
    }
    case 'device_connected':
      return d.destination === 'phone'
        ? `A phone${d.label ? ` ("${String(d.label)}")` : ''} was connected. Files copied onto a phone cannot be seen.`
        : `A USB drive or external disk${d.label ? ` ("${String(d.label)}")` : ''} was connected.`;
    case 'files_copied': {
      const files = n(d.files);
      const where = DESTINATIONS[String(d.destination)] ?? 'another location';
      return `${files} ${files === 1 ? 'file' : 'files'} (${formatBytes(n(d.bytes))}) copied to ${where}${d.label ? ` ("${String(d.label)}")` : ''}. File names are on the employee's page.`;
    }
    case 'unapproved_ai':
      return `Used ${String(d.tool ?? 'an AI tool')}, which this company has marked as not approved, for ${minutesText(n(d.seconds))}. This is time the app or site was open.`;
    default:
      return a.kind.replace(/_/g, ' ');
  }
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
  unapproved_ai: 'Unapproved AI tool',
};
