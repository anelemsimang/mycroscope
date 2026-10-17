import { Linking, Platform } from 'react-native';

import { webAppUrl } from '@/lib/authLink';
import { safeCheckoutPath } from '@/lib/checkoutPath';

const SITE = 'https://mycroscope.co.za';

export function websiteUrl(path: string): string {
  const origin = (webAppUrl() ?? SITE).replace(/\/+$/, '');
  return `${origin}${path.startsWith('/') ? path : `/${path}`}`;
}

/** Leaves the app for a page on the public site. */
export function openWebsite(path: string): void {
  const url = websiteUrl(path);
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    window.location.assign(url);
    return;
  }
  void Linking.openURL(url);
}

export function openWebsiteCheckout(plan?: string, seats?: number, when?: 'now' | 'end'): void {
  const count = seats && Number.isInteger(seats) && seats > 0 && seats <= 10000 ? seats : undefined;
  const timing = when === 'end' ? 'end' : when === 'now' ? 'now' : undefined;
  const params = new URLSearchParams();
  if (plan) params.set('plan', plan);
  if (count) params.set('seats', String(count));
  if (timing) params.set('when', timing);
  const query = params.toString();
  const path = query ? `/checkout?${query}` : '/checkout';
  const safe = safeCheckoutPath(path);
  openWebsite(safe ?? '/pricing');
}
