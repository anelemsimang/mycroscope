// Accepts the support form, emails it, then sends the visitor to the thank-you page.
// A direct POST to a static page is what Netlify shows as "Page not found".

const line = (value, max = 500) => String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);

function redirect(path) {
  return new Response(null, { status: 303, headers: { Location: path } });
}

export default async (request) => {
  if (request.method !== 'POST') return redirect('/support');
  const form = await request.formData().catch(() => null);
  if (!form || line(form.get('bot-field'), 200)) return redirect('/support-received');

  const name = line(form.get('name'), 120);
  const email = line(form.get('email'), 200);
  const organisation = line(form.get('organisation'), 160);
  const topic = line(form.get('topic'), 80);
  const message = String(form.get('message') ?? '').replace(/\r/g, '').slice(0, 4000);
  if (!name || !email || !topic || !message) return redirect('/support');

  const key = process.env.BREVO_API_KEY?.trim();
  if (!key) {
    console.error('BREVO_API_KEY is not set; the support question was not emailed');
    return redirect('/support-received');
  }

  const replyTo = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? { email, name } : undefined;
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': key, accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      sender: { name: 'Mycroscope', email: 'info@mycroscope.co.za' },
      to: [{ email: 'info@mycroscope.co.za', name: 'Mycroscope' }],
      ...(replyTo ? { replyTo } : {}),
      subject: `Support question: ${topic}`,
      textContent: [`Name: ${name}`, `Email: ${email}`, `Organisation: ${organisation}`, `Topic: ${topic}`, '', message].join('\n'),
    }),
  });
  if (!res.ok) console.error('Brevo support mail failed', res.status, await res.text().catch(() => ''));
  return redirect('/support-received');
};
