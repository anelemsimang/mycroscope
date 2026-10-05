import { authLinkRoute, initialAuthLink } from '@/lib/authLink';
import { Stack, router, usePathname } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Text, View } from 'react-native';

import { headerOptions } from '@/components/ui';
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
  const { session, isLoading } = useSession();
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
  if (isLoading) return null;

  return (
    <>
    <StatusBar style={session ? 'light' : 'dark'} />
    <Stack screenOptions={headerOptions}>
      <Stack.Protected guard={!!session}>
        <Stack.Screen name="(app)" options={{ headerShown: false }} />
      </Stack.Protected>
      <Stack.Protected guard={!session}>
        <Stack.Screen name="sign-in" options={{ headerShown: false }} />
        <Stack.Screen name="sign-up" options={{ title: 'Organisation Registration' }} />
        <Stack.Screen name="forgot-password" options={{ title: 'Reset password' }} />
      </Stack.Protected>
      <Stack.Screen name="auth/confirm" options={{ title: 'Confirm email', headerBackVisible: false }} />
      <Stack.Screen name="auth/reset-password" options={{ title: 'Choose a new password', headerBackVisible: false }} />
    </Stack>
    </>
  );
}
