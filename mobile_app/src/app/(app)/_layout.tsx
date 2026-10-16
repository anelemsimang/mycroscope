import { Stack, router, type Href } from 'expo-router';
import { Platform, Pressable, Text, View, useWindowDimensions } from 'react-native';

import { MfaSetup } from '@/components/MfaSetup';
import { Button, Card, Screen, headerOptions, styles } from '@/components/ui';
import { useSession } from '@/lib/session';

/** Width from which the header offers a direct "All employees" button (desktop browsers, tablets). */
const WIDE = 768;

function goToDashboard(manager: boolean) {
  router.replace((manager ? '/overview' : '/me') as Href);
}

function HeaderLink({ label, side, onPress, accessibilityLabel }: {
  label: string; side: 'left' | 'right'; onPress: () => void; accessibilityLabel: string;
}) {
  return (
    <Pressable hitSlop={8} onPress={onPress} accessibilityRole="button" accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [
        side === 'left' ? { paddingRight: 12 } : { paddingHorizontal: 12, paddingVertical: 6, marginRight: 8,
          borderWidth: 1, borderColor: 'rgba(255,255,255,0.6)', borderRadius: 6 },
        pressed && { opacity: 0.7 },
      ]}>
      <Text style={{ color: '#fff', fontWeight: '600', fontSize: 14 }}>{label}</Text>
    </Pressable>
  );
}

export default function AppLayout() {
  const { profile, isManager, reloadProfile, signOut, service, aal } = useSession();
  const { width } = useWindowDimensions();
  const wide = Platform.OS === 'web' || width >= WIDE;

  if (!profile) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', padding: 24, gap: 12 }}>
        <Text style={{ fontSize: 16 }}>Can't load your account. Check your internet connection.</Text>
        <Button title="Try again" onPress={reloadProfile} />
        <Button title="Sign out" variant="ghost" onPress={signOut} />
      </View>
    );
  }

  if (isManager && service?.require_mfa && aal.current !== 'aal2') {
    return (
      <Screen>
        <Card title="Two-factor login required">
          <Text style={styles.hint}>
            {profile.organizationName} requires managers to sign in with a second factor before they can see employee data.
          </Text>
          <MfaSetup required />
        </Card>
        <Button title="Sign out" variant="ghost" onPress={signOut} />
      </Screen>
    );
  }

  const inner = (title: string) => ({ navigation }: { navigation: { canGoBack: () => boolean } }) => ({
    title,
    headerBackVisible: false,
    headerLeft: () => (
      <HeaderLink side="left" label="‹ Back" accessibilityLabel="Back"
        onPress={() => (navigation.canGoBack() ? router.back() : goToDashboard(isManager))} />
    ),
    ...(isManager && wide ? {
      headerRight: () => (
        <HeaderLink side="right" label="☰ All employees" accessibilityLabel="Back to all employees" onPress={() => goToDashboard(true)} />
      ),
    } : {}),
  });

  return (
    <Stack screenOptions={headerOptions}>
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Protected guard={isManager}>
        <Stack.Screen name="overview" options={{ title: 'Mycroscope Dashboard' }} />
        <Stack.Screen name="reports" options={inner('Professional Report')} />
        <Stack.Screen name="register" options={inner('Register Employee')} />
        <Stack.Screen name="employee/[id]" options={inner('Employee Details')} />
        <Stack.Screen name="manage/[id]" options={inner('Manage Employee')} />
        <Stack.Screen name="delete-activity" options={inner('Delete Activity')} />
        <Stack.Screen name="monitoring" options={inner('Monitoring & Privacy')} />
        <Stack.Screen name="acknowledgements" options={inner('Notice Acknowledgements')} />
        <Stack.Screen name="notice-history" options={inner('Notice History')} />
        <Stack.Screen name="audit-log" options={inner('Audit Log')} />
        <Stack.Screen name="alerts" options={inner('Alerts')} />
        <Stack.Screen name="alert-rules" options={inner('Alert Rules')} />
        <Stack.Screen name="integrations" options={inner('Slack, Teams & API')} />
        <Stack.Screen name="categories" options={inner('Productivity Categories')} />
        <Stack.Screen name="teams" options={inner('Teams')} />
        <Stack.Screen name="work-hours" options={inner('Working Hours')} />
        <Stack.Screen name="goals" options={inner('Productivity Goals')} />
        <Stack.Screen name="insights" options={inner('Insights')} />
        <Stack.Screen name="billing" options={inner('Subscription & Billing')} />
        <Stack.Screen name="purchase" options={inner('Get plan')} />
        <Stack.Screen name="purchase-received" options={inner('Payment sent')} />
        <Stack.Screen name="purchase-cancelled" options={inner('Payment cancelled')} />
        <Stack.Screen name="purchase-failed" options={inner('Payment failed')} />
        <Stack.Screen name="install-key" options={inner('Agent Install Key')} />
        <Stack.Screen name="support-access" options={inner('Support Access')} />
      </Stack.Protected>
      <Stack.Protected guard={!isManager}>
        <Stack.Screen name="me" options={{ title: 'My Activity' }} />
      </Stack.Protected>
      <Stack.Screen name="requests" options={inner('Privacy Requests')} />
      <Stack.Screen name="app-usage" options={inner('App Details')} />
      <Stack.Screen name="website" options={inner('Website Details')} />
      <Stack.Screen name="day" options={inner('Daily Details')} />
      <Stack.Screen name="settings" options={inner('Settings')} />
    </Stack>
  );
}
