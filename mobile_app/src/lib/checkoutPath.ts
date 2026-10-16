const PLANS = new Set(['free', 'work_activity', 'workforce', 'productivity']);
const HOSTS = new Set(['https://mycroscope.co.za', 'https://mycroscope.netlify.app']);

/** A same-site checkout address, or null. Rejects any other destination. */
export function safeCheckoutPath(value: string | null | undefined): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value, 'https://mycroscope.co.za');
  } catch {
    return null;
  }
  if (!HOSTS.has(url.origin)) return null;
  if (url.pathname !== '/checkout') return null;
  if (url.username || url.password || url.hash) return null;
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => key !== 'plan' && key !== 'seats')) return null;
  const plan = url.searchParams.get('plan');
  if (plan && !PLANS.has(plan)) return null;
  const seatsRaw = url.searchParams.get('seats');
  let seats = '';
  if (seatsRaw !== null) {
    if (!plan || !/^[1-9]\d{0,4}$/.test(seatsRaw)) return null;
    const count = Number(seatsRaw);
    if (count > 10000) return null;
    seats = String(count);
  }
  const params = new URLSearchParams();
  if (plan) params.set('plan', plan);
  if (seats) params.set('seats', seats);
  const query = params.toString();
  return query ? `/checkout?${query}` : '/checkout';
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
