import { Stack, router } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { Button, headerOptions } from '@/components/ui';
import { useSession } from '@/lib/session';

/** Shown in place of the back arrow when there is no history (e.g. after a browser refresh). */
function HomeButton() {
  return (
    <Pressable hitSlop={8} style={{ paddingRight: 12 }} accessibilityRole="button" accessibilityLabel="Dashboard"
      onPress={() => router.replace('/')}>
      <Text style={{ color: '#fff', fontWeight: '600', fontSize: 15 }}>‹ Dashboard</Text>
    </Pressable>
  );
}

const withHome = (title: string) => ({ navigation }: { navigation: { canGoBack: () => boolean } }) => ({
  title, ...(navigation.canGoBack() ? {} : { headerLeft: () => <HomeButton /> }),
});

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
    <Stack screenOptions={headerOptions}>
      <Stack.Protected guard={isManager}>
        <Stack.Screen name="index" options={{ title: 'Mycroscope Dashboard' }} />
        <Stack.Screen name="reports" options={withHome('Professional Report')} />
        <Stack.Screen name="register" options={withHome('Register Employee')} />
        <Stack.Screen name="employee/[id]" options={withHome('Employee Details')} />
        <Stack.Screen name="manage/[id]" options={withHome('Manage Employee')} />
        <Stack.Screen name="delete-activity" options={withHome('Delete Activity')} />
      </Stack.Protected>
      <Stack.Protected guard={!isManager}>
        <Stack.Screen name="me" options={{ title: 'My Activity' }} />
      </Stack.Protected>
      <Stack.Screen name="app-usage" options={withHome('App Details')} />
      <Stack.Screen name="website" options={withHome('Website Details')} />
      <Stack.Screen name="day" options={withHome('Daily Details')} />
      <Stack.Screen name="settings" options={withHome('Settings')} />
    </Stack>
  );
}
