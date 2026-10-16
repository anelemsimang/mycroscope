const PLANS = new Set(['free', 'work_activity', 'workforce', 'productivity']);

/** A same-site checkout address, or null. Rejects any other destination. */
export function safeCheckoutPath(value: string | null | undefined): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value, 'https://mycroscope.netlify.app');
  } catch {
    return null;
  }
  if (url.origin !== 'https://mycroscope.netlify.app') return null;
  if (url.pathname !== '/checkout') return null;
  if (url.username || url.password || url.hash) return null;
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => key !== 'plan')) return null;
  const plan = url.searchParams.get('plan');
  if (plan && !PLANS.has(plan)) return null;
  return plan ? `/checkout?plan=${plan}` : '/checkout';
}

export const CHECKOUT_NEXT_KEY = 'mycroscope-checkout-next';

export function readStoredCheckout(now = Date.now()): string | null {
  if (typeof sessionStorage === 'undefined') return null;
  const raw = sessionStorage.getItem(CHECKOUT_NEXT_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { path?: string; at?: number };
    if (!parsed.at || now - parsed.at > 30 * 60 * 1000) {
      sessionStorage.removeItem(CHECKOUT_NEXT_KEY);
      return null;
    }
    const path = safeCheckoutPath(parsed.path);
    if (!path) sessionStorage.removeItem(CHECKOUT_NEXT_KEY);
    return path;
  } catch {
    sessionStorage.removeItem(CHECKOUT_NEXT_KEY);
    return null;
  }
}

export function clearStoredCheckout(): void {
  if (typeof sessionStorage === 'undefined') return;
  sessionStorage.removeItem(CHECKOUT_NEXT_KEY);
}
