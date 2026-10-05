import { Stack, router } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { Button, colors } from '@/components/ui';
import { useSession } from '@/lib/session';

function BackToList() {
  return (
    <Pressable hitSlop={8} style={{ paddingRight: 12 }} accessibilityRole="button" accessibilityLabel="Back to employees"
      onPress={() => router.replace('/')}>
      <Text style={{ color: colors.primary, fontWeight: '600', fontSize: 15 }}>‹ Employees</Text>
    </Pressable>
  );
}

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
        <Stack.Screen name="employee/[id]" options={({ navigation }) => ({
          title: 'Activity', ...(navigation.canGoBack() ? {} : { headerLeft: () => <BackToList /> }),
        })} />
        <Stack.Screen name="manage/[id]" options={({ navigation }) => ({
          title: 'Manage employee', ...(navigation.canGoBack() ? {} : { headerLeft: () => <BackToList /> }),
        })} />
        <Stack.Screen name="add-employee" options={{ title: 'Add employee', presentation: 'modal' }} />
      </Stack.Protected>
      <Stack.Protected guard={!isManager}>
        <Stack.Screen name="me" options={{ title: 'My activity' }} />
      </Stack.Protected>
      <Stack.Screen name="account" options={{ title: 'Account' }} />
    </Stack>
  );
}
