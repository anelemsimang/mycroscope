// Email links (sign-up confirmation, password reset) land on the web app's /auth/* pages.
// The URL is captured as soon as this module loads, before the router can rewrite it,
// and the tokens are then removed from the address bar and browser history.
import { createClient, type EmailOtpType, type SupabaseClient } from '@supabase/supabase-js';
import { Platform } from 'react-native';

const initialHref = Platform.OS === 'web' && typeof window !== 'undefined' ? window.location.href : '';

export interface AuthLink {
  accessToken?: string;
  refreshToken?: string;
  tokenHash?: string;
  type?: string;
  error?: string;
}

/** Reads Supabase's implicit-flow hash (#access_token=…) or a token_hash query (?token_hash=…&type=…). */
export function parseAuthLink(href: string): AuthLink {
  if (!href) return {};
  const url = new URL(href);
  const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
  const query = url.searchParams;
  const get = (k: string) => hash.get(k) ?? query.get(k) ?? undefined;
  const error = get('error_description') ?? get('error');
  return {
    accessToken: get('access_token'),
    refreshToken: get('refresh_token'),
    tokenHash: get('token_hash'),
    type: get('type'),
    error: error ? error.replace(/\+/g, ' ') : undefined,
  };
}

let initialLink: AuthLink | null = null;

/** The email link that opened the app (empty if it wasn't opened from one). */
export function initialAuthLink(): AuthLink {
  initialLink ??= parseAuthLink(initialHref);
  return initialLink;
}

/**
 * Removes link tokens from the address bar and history. Deferred because the router's own start-up
 * effect runs after the page's and rewrites the URL from the original address.
 */
export function scrubAddressBar(): void {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return;
  setTimeout(() => {
    if (/(access_token|refresh_token|token_hash|error_description)=/.test(window.location.hash + window.location.search)) {
      window.history.replaceState(window.history.state, '', window.location.pathname);
    }
  }, 0);
}

/** Which /auth page should handle the link, for links that arrive at another address (e.g. the Site URL). */
export function authLinkRoute(link: AuthLink): '/auth/reset-password' | '/auth/confirm' | null {
  if (link.type === 'recovery') return '/auth/reset-password';
  if (link.type === 'signup' || link.type === 'email' || (link.error && !link.type)) return '/auth/confirm';
  return null;
}

/**
 * A client that never stores its session, so finishing a reset doesn't sign this browser in
 * (most resets come from desktop-app users).
 */
export function linkClient(): SupabaseClient {
  return createClient(process.env.EXPO_PUBLIC_SUPABASE_URL ?? '', process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'mycroscope-email-link' },
  });
}

/** Turns the link into a session on `client`; returns an error message instead when it can't. */
export async function sessionFromLink(client: SupabaseClient, link: AuthLink, otpType: EmailOtpType): Promise<string | null> {
  if (link.error) return link.error;
  const rejected = (e: { message: string } | null) => {
    if (!e) return null;
    return /fetch|network/i.test(e.message)
      ? "Can't reach the server. Check your internet connection and open the link again."
      : 'This link is invalid or has expired.';
  };
  if (link.tokenHash) {
    const { error } = await client.auth.verifyOtp({ token_hash: link.tokenHash, type: otpType });
    return rejected(error);
  }
  if (link.accessToken && link.refreshToken) {
    const { error } = await client.auth.setSession({ access_token: link.accessToken, refresh_token: link.refreshToken });
    return rejected(error);
  }
  return 'This link is incomplete. Open the most recent link from your email, or request a new one.';
}

/** Base address of the web app, used as the destination of email links. */
export function webAppUrl(): string | undefined {
  const configured = (process.env.EXPO_PUBLIC_WEB_URL ?? '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  return Platform.OS === 'web' && typeof window !== 'undefined' ? window.location.origin : undefined;
}
