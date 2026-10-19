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
      if (body.confirmed) {
        say('Yoco confirmed the payment. The plan is updated.');
        await offerReceipt(supabase, data.session.user);
      } else if (body.pending) say('Yoco has not confirmed the payment yet. Check billing in a minute.');
      else say('The payment is not confirmed. Nothing has been changed. You can try again from pricing.');
    } catch {
      say('The payment could not be checked. Open billing in a minute.');
    }
  }
}

async function offerReceipt(supabase, user) {
  const button = document.querySelector('#receipt');
  const note = document.querySelector('#receipt-note');
  if (!button) return;
  try {
    const { data, error } = await supabase.rpc('get_my_invoices');
    const invoice = Array.isArray(data) ? data[0] : null;
    if (error || !invoice) return;
    const { buildReceiptPdf } = await import('./receipt.js');
    button.hidden = false;
    if (note) note.hidden = false;
    button.addEventListener('click', async () => {
      button.disabled = true;
      const previous = button.textContent;
      button.textContent = 'Preparing the receipt…';
      try {
        const bytes = await buildReceiptPdf({
          ...invoice,
          customer_name: invoice.customer_name || user?.user_metadata?.full_name || '',
          customer_email: invoice.customer_email || user?.email || '',
        });
        const file = new Blob([new Uint8Array(bytes)], { type: 'application/pdf' });
        const url = URL.createObjectURL(file);
        const link = document.createElement('a');
        link.href = url;
        link.download = `Mycroscope-${invoice.number}.pdf`;
        link.click();
        URL.revokeObjectURL(url);
      } finally {
        button.disabled = false;
        button.textContent = previous;
      }
    });
  } catch {
    if (note) {
      note.hidden = false;
      note.textContent = 'The receipt is on the billing page.';
    }
  }
}
