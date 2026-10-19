const status = document.querySelector('#payment-status');
const intent = new URLSearchParams(location.search).get('intent');
const cfg = window.MYCROSCOPE_BILLING;

function say(text) {
  if (status) status.textContent = text;
}

if (!intent || !cfg?.url || !cfg?.anonKey) {
  say('You have been sent back to Mycroscope. Open billing to see whether the plan has updated.');
} else {
  const { createClient } = await import('./supabase.js');
  const supabase = createClient(cfg.url, cfg.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) {
    say('Sign in, then open billing. The plan updates after Yoco confirms the payment.');
  } else {
    try {
      const response = await fetch(`${cfg.url.replace(/\/+$/, '')}/functions/v1/yoco-checkout`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: cfg.anonKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ confirm: true, intent }),
      });
      const body = await response.json().catch(() => ({}));
      if (body.confirmed) say('Yoco confirmed the payment. The plan is updated.');
      else if (body.pending) say('Yoco has not confirmed the payment yet. Check billing in a minute.');
      else say('The payment is not confirmed. Nothing has been changed. You can try again from pricing.');
    } catch {
      say('The payment could not be checked. Open billing in a minute.');
    }
  }
}
