import { Linking, Platform } from 'react-native';

import { webAppUrl } from '@/lib/authLink';
import { safeCheckoutPath } from '@/lib/checkoutPath';

const SITE = 'https://mycroscope.netlify.app';

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

export function openWebsiteCheckout(plan?: string, seats?: number): void {
  const count = seats && Number.isInteger(seats) && seats > 0 && seats <= 10000 ? seats : undefined;
  const path = !plan
    ? '/checkout'
    : count
      ? `/checkout?plan=${plan}&seats=${count}`
      : `/checkout?plan=${plan}`;
  const safe = safeCheckoutPath(path);
  openWebsite(safe ?? '/pricing');
}
