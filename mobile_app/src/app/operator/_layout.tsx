import { Stack } from 'expo-router';
import { Text } from 'react-native';

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

  return (
    <Stack screenOptions={headerOptions}>
      <Stack.Screen name="index" options={{ title: 'Operator Console' }} />
      <Stack.Screen name="org/[id]" options={{ title: 'Customer' }} />
      <Stack.Screen name="audit" options={{ title: 'Operator Audit Log' }} />
    </Stack>
  );
}
