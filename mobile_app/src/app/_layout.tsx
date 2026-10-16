import { authLinkRoute, initialAuthLink } from '@/lib/authLink';
import { Stack, router, usePathname, type Href } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Platform, Text, View } from 'react-native';

import { headerOptions } from '@/components/ui';
import { clearStoredCheckout, readStoredCheckout, safeCheckoutPath } from '@/lib/checkoutPath';
import { SessionProvider, useSession } from '@/lib/session';
import { isConfigured } from '@/lib/supabase';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  useEffect(() => {
    if (!isConfigured) SplashScreen.hide();
  }, []);

  if (!isConfigured) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', padding: 24, gap: 8 }}>
        <Text style={{ fontSize: 18, fontWeight: '700' }}>Mycroscope is not configured</Text>
        <Text>Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY in mobile_app/.env, then restart Expo.</Text>
      </View>
    );
  }
  return (
    <SessionProvider>
      <RootNavigator />
    </SessionProvider>
  );
}

function RootNavigator() {
  const { session, isLoading, operator, needsMfaChallenge, isManager } = useSession();
  const signedIn = !!session && !needsMfaChallenge;
  const pathname = usePathname();
  useEffect(() => {
    if (!isLoading) SplashScreen.hide();
  }, [isLoading]);
  useEffect(() => {
    if (isLoading) return;
    const target = authLinkRoute(initialAuthLink());
    if (target && !pathname.startsWith('/auth/')) router.replace(target);
    // Only for the address the app was opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading]);
  useEffect(() => {
    const legal = pathname === '/terms' || pathname === '/privacy';
    if (!isLoading && signedIn && operator && !legal && !pathname.startsWith('/operator') && !pathname.startsWith('/auth/')) {
      router.replace('/operator');
    }
    const atDoor = pathname === '/' || pathname === '/sign-in' || pathname === '/sign-up' || pathname === '/forgot-password';
    const checkout = Platform.OS === 'web' && typeof window !== 'undefined'
      ? safeCheckoutPath(new URLSearchParams(window.location.search).get('next')) ?? readStoredCheckout()
      : null;
    if (!isLoading && signedIn && !operator && checkout && (atDoor || pathname === '/mfa')) {
      clearStoredCheckout();
      window.location.replace(checkout);
      return;
    }
    if (!isLoading && signedIn && !operator && atDoor) {
      router.replace((isManager ? '/overview' : '/me') as Href);
    }
  }, [isLoading, signedIn, operator, isManager, pathname]);
  if (isLoading) return null;

  return (
    <>
    <StatusBar style={session ? 'light' : 'dark'} />
    <Stack screenOptions={headerOptions}>
      <Stack.Protected guard={!!session && needsMfaChallenge}>
        <Stack.Screen name="mfa" options={{ title: 'Two-factor login', headerBackVisible: false }} />
      </Stack.Protected>
      <Stack.Protected guard={signedIn && !operator}>
        <Stack.Screen name="(app)" options={{ headerShown: false }} />
      </Stack.Protected>
      <Stack.Protected guard={signedIn && operator}>
        <Stack.Screen name="operator" options={{ headerShown: false }} />
      </Stack.Protected>
      <Stack.Protected guard={!session}>
        <Stack.Screen name="sign-in" options={{ headerShown: false }} />
        <Stack.Screen name="sign-up" options={{ title: 'Organisation Registration' }} />
        <Stack.Screen name="forgot-password" options={{ title: 'Reset password' }} />
      </Stack.Protected>
      <Stack.Screen name="terms" options={{ title: 'Terms of service' }} />
      <Stack.Screen name="privacy" options={{ title: 'Privacy policy' }} />
      <Stack.Screen name="auth/confirm" options={{ title: 'Confirm email', headerBackVisible: false }} />
      <Stack.Screen name="auth/reset-password" options={{ title: 'Choose a new password', headerBackVisible: false }} />
    </Stack>
    </>
  );
}
