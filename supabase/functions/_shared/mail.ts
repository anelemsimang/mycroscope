// Transactional mail through Brevo's SMTP API (POST /v3/smtp/email).
// This is one message per recipient. Marketing campaigns (lists and scheduled blasts) are a different API.
// Secret: BREVO_API_KEY. Sender defaults to Mycroscope <info@mycroscope.co.za>.
// EMAIL_FROM overrides it, as either "Name <email>" or a bare address.

import { env } from './http.ts';

const BREVO_SMTP_URL = 'https://api.brevo.com/v3/smtp/email';
const DEFAULT_SENDER = { name: 'Mycroscope', email: 'info@mycroscope.co.za' };
const AT_ONCE = 5;

export interface OutboundMail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export function sender(): { name: string; email: string } {
  const raw = env('EMAIL_FROM');
  if (!raw) return DEFAULT_SENDER;
  const named = raw.match(/^(.*?)\s*<([^>]+)>$/);
  if (named) {
    const email = named[2].trim();
    return { name: named[1].trim() || DEFAULT_SENDER.name, email: email || DEFAULT_SENDER.email };
  }
  if (raw.includes('@')) return { name: DEFAULT_SENDER.name, email: raw };
  return DEFAULT_SENDER;
}

export function brevoKey(): string | undefined {
  return env('BREVO_API_KEY');
}

async function sendOne(mail: OutboundMail, apiKey: string, from: { name: string; email: string }): Promise<boolean> {
  const res = await fetch(BREVO_SMTP_URL, {
    method: 'POST',
    headers: { 'api-key': apiKey, accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      sender: from,
      to: [{ email: mail.to }],
      subject: mail.subject,
      textContent: mail.text,
      ...(mail.html ? { htmlContent: mail.html } : {}),
    }),
  });
  if (res.ok) return true;
  console.error('Brevo send failed', res.status, await res.text().catch(() => ''));
  return false;
}

/** Sends each message on its own. A failure is counted and does not stop the rest. */
export async function sendEmails(emails: OutboundMail[]): Promise<{ sent: number; failed: number }> {
  const apiKey = brevoKey();
  if (!apiKey || emails.length === 0) return { sent: 0, failed: 0 };
  const from = sender();
  const queue = emails.slice();
  let sent = 0;
  let failed = 0;
  const workers = Array.from({ length: Math.min(AT_ONCE, queue.length) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      if (await sendOne(next, apiKey, from)) sent += 1;
      else failed += 1;
    }
  });
  await Promise.all(workers);
  return { sent, failed };
}
