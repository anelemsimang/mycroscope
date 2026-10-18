// Emails a support-form submission to info@mycroscope.co.za through Brevo.
// Netlify stores the submission either way. Set BREVO_API_KEY on the Netlify site.

const line = (value, max = 500) => String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);

export default async (request) => {
  const body = await request.json().catch(() => null);
  const payload = body?.payload;
  if (!payload || payload.form_name !== 'support') return new Response('ok');
  const fields = payload.data ?? {};
  if (line(fields['bot-field'])) return new Response('ok');

  const key = process.env.BREVO_API_KEY?.trim();
  if (!key) {
    console.error('BREVO_API_KEY is not set; the support question was stored but not emailed');
    return new Response('ok');
  }

  const name = line(fields.name, 120);
  const email = line(fields.email, 200);
  const text = [
    `Name: ${name}`,
    `Email: ${email}`,
    `Organisation: ${line(fields.organisation, 160)}`,
    `Topic: ${line(fields.topic, 80)}`,
    '',
    String(fields.message ?? '').replace(/\r/g, '').slice(0, 4000),
  ].join('\n');
  const replyTo = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? { email, name: name || email } : undefined;

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': key, accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      sender: { name: 'Mycroscope', email: 'info@mycroscope.co.za' },
      to: [{ email: 'info@mycroscope.co.za', name: 'Mycroscope' }],
      ...(replyTo ? { replyTo } : {}),
      subject: `Support question: ${line(fields.topic, 80) || 'Mycroscope'}`,
      textContent: text,
    }),
  });
  if (!res.ok) console.error('Brevo support mail failed', res.status, await res.text().catch(() => ''));
  return new Response('ok');
};
