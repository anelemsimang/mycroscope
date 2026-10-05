// Email content for managers. Counts only: names and activity details stay behind the app's sign-in.

export interface DigestRow {
  recipient_email: string;
  recipient_name: string;
  role: 'owner' | 'manager';
  organization_name: string;
  week_start: string;
  week_end: string;
  people: number;
  activated: number;
  active_seconds: number;
  idle_seconds: number;
  person_days: number;
  integrity_alerts: number;
  high_alerts: number;
  open_requests: number;
}

export interface AlertRow {
  recipient_email: string;
  recipient_name: string;
  organization_name: string;
  alerts: number;
  high_alerts: number;
}

export interface Email {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Header-safe single line (no CR/LF), so a crafted organisation name cannot inject headers or wrap oddly. */
function oneLine(value: string, max = 120): string {
  return value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

export function hours(seconds: number): string {
  const h = Number(seconds) / 3600;
  return h >= 10 ? `${Math.round(h)} h` : `${h.toFixed(1)} h`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function firstName(name: string): string {
  return oneLine(name, 60).split(' ')[0] || 'there';
}

function layout(title: string, paragraphs: string[], bullets: string[], appUrl: string, footer: string): string {
  const link = appUrl
    ? `<p><a href="${escapeHtml(appUrl)}" style="background:#0f766e;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;display:inline-block">Open Mycroscope</a></p>`
    : '';
  return `<!doctype html><html><body style="font-family:Segoe UI,Arial,sans-serif;color:#111827;max-width:560px;margin:0 auto;padding:16px">
<h2 style="color:#0f766e;margin:0 0 12px">${escapeHtml(title)}</h2>
${paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n')}
${bullets.length ? `<ul>${bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>` : ''}
${link}
<p style="color:#6b7280;font-size:12px;margin-top:24px">${escapeHtml(footer)}</p>
</body></html>`;
}

const FOOTER = 'You receive this because you manage people in Mycroscope. Turn these emails off under Account → Email notifications.';

export function renderDigest(r: DigestRow, appUrl: string): Email {
  const org = oneLine(r.organization_name);
  const scope = r.role === 'owner' ? 'your organisation' : 'the people you manage';
  const perDay = r.person_days > 0 ? r.active_seconds / r.person_days : 0;
  const bullets = [
    `People: ${r.people} active, ${r.activated} with the desktop app activated`,
    `Active time: ${hours(r.active_seconds)}${r.person_days ? ` (about ${hours(perDay)} per person per working day)` : ''}`,
    `Idle time: ${hours(r.idle_seconds)}`,
    `Integrity alerts: ${r.integrity_alerts}${r.high_alerts ? ` (${r.high_alerts} high)` : ''}`,
  ];
  if (r.open_requests > 0) bullets.push(`Open privacy requests from employees: ${r.open_requests}. Please respond promptly.`);
  if (r.activated < r.people) bullets.push(`${plural(r.people - r.activated, 'person has', 'people have')} not activated the desktop app yet.`);
  const intro = `Hi ${firstName(r.recipient_name)}, here is last week (${r.week_start} to ${r.week_end}) for ${scope} at ${org}.`;
  const subject = oneLine(`Mycroscope weekly summary: ${org}`, 150);
  return {
    to: r.recipient_email,
    subject,
    text: [intro, '', ...bullets.map((b) => `- ${b}`), '', appUrl ? `Open Mycroscope: ${appUrl}` : '', '', FOOTER].join('\n'),
    html: layout('Weekly summary', [intro], bullets, appUrl, FOOTER),
  };
}

export function renderAlert(r: AlertRow, appUrl: string): Email {
  const org = oneLine(r.organization_name);
  const what = plural(r.alerts, 'new integrity alert');
  const high = r.high_alerts ? `, ${r.high_alerts} marked high` : '';
  const intro = `Hi ${firstName(r.recipient_name)}, Mycroscope recorded ${what}${high} at ${org}.`;
  const detail = 'Alerts include gaps in recording while the app should have been running, virtual machines, remote '
    + 'sessions and unusual input patterns. They are signals to look into, not proof of wrongdoing. Details are in the app under Alerts.';
  return {
    to: r.recipient_email,
    subject: oneLine(`Mycroscope: ${what} at ${org}`, 150),
    text: [intro, '', detail, '', appUrl ? `Review them: ${appUrl}/alerts` : '', '', FOOTER].join('\n'),
    html: layout('New integrity alerts', [intro, detail], [], appUrl ? `${appUrl}/alerts` : '', FOOTER),
  };
}
