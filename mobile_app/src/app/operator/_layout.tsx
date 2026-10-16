import { Stack, router } from 'expo-router';
import { Pressable, Text } from 'react-native';

import { MfaSetup } from '@/components/MfaSetup';
import { Button, Card, Screen, headerOptions, styles } from '@/components/ui';
import { useSession } from '@/lib/session';

/** Console for platform operators (the SaaS provider). Always requires two-factor login. */
export default function OperatorLayout() {
  const { aal, signOut } = useSession();

  if (aal.current !== 'aal2') {
    return (
      <Screen>
        <Card title="Mycroscope operator console">
          <Text style={styles.hint}>
            Operator accounts must use two-factor login. Set it up now; you will need the code every time you sign in.
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
      <Pressable hitSlop={8} accessibilityRole="button" accessibilityLabel="Back"
        onPress={() => (navigation.canGoBack() ? router.back() : router.replace('/operator'))}
        style={({ pressed }) => [{ paddingRight: 12 }, pressed && { opacity: 0.7 }]}>
        <Text style={{ color: '#fff', fontWeight: '600', fontSize: 14 }}>‹ Back</Text>
      </Pressable>
    ),
  });

  return (
    <Stack screenOptions={headerOptions}>
      <Stack.Screen name="index" options={{ title: 'Control' }} />
      <Stack.Screen name="org/[id]" options={inner('Customer')} />
      <Stack.Screen name="audit" options={inner('Operator Audit Log')} />
      <Stack.Screen name="ai-tools" options={inner('AI Tools')} />
    </Stack>
  );
}
