import { Stack } from 'expo-router';
import { Text, View } from 'react-native';

import { Button, colors } from '@/components/ui';
import { useSession } from '@/lib/session';

export default function AppLayout() {
  const { profile, isManager, reloadProfile, signOut } = useSession();

  if (!profile) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', padding: 24, gap: 12 }}>
        <Text style={{ fontSize: 16 }}>Can't load your account. Check your internet connection.</Text>
        <Button title="Try again" onPress={reloadProfile} />
        <Button title="Sign out" variant="ghost" onPress={signOut} />
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerTintColor: colors.primary, contentStyle: { backgroundColor: colors.background } }}>
      <Stack.Protected guard={isManager}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="employee/[id]" options={{ title: 'Activity' }} />
        <Stack.Screen name="manage/[id]" options={{ title: 'Manage employee' }} />
        <Stack.Screen name="add-employee" options={{ title: 'Add employee', presentation: 'modal' }} />
      </Stack.Protected>
      <Stack.Protected guard={!isManager}>
        <Stack.Screen name="me" options={{ title: 'My activity' }} />
      </Stack.Protected>
      <Stack.Screen name="account" options={{ title: 'Account' }} />
    </Stack>
  );
}
