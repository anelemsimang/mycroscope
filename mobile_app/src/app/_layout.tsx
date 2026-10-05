import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Text, View } from 'react-native';

import { colors } from '@/components/ui';
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
      <StatusBar style="dark" />
      <RootNavigator />
    </SessionProvider>
  );
}

function RootNavigator() {
  const { session, isLoading } = useSession();
  useEffect(() => {
    if (!isLoading) SplashScreen.hide();
  }, [isLoading]);
  if (isLoading) return null;

  return (
    <Stack screenOptions={{ headerTintColor: colors.primary, contentStyle: { backgroundColor: colors.background } }}>
      <Stack.Protected guard={!!session}>
        <Stack.Screen name="(app)" options={{ headerShown: false }} />
      </Stack.Protected>
      <Stack.Protected guard={!session}>
        <Stack.Screen name="sign-in" options={{ headerShown: false }} />
        <Stack.Screen name="sign-up" options={{ title: 'Create your organisation' }} />
        <Stack.Screen name="forgot-password" options={{ title: 'Reset password' }} />
      </Stack.Protected>
    </Stack>
  );
}
