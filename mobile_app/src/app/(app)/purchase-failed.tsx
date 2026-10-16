import { router, useLocalSearchParams } from 'expo-router';
import { Text } from 'react-native';

import { Button, Card, Screen, styles } from '@/components/ui';

export default function PurchaseFailed() {
  const raw = useLocalSearchParams<{ plan?: string }>().plan;
  const plan = Array.isArray(raw) ? raw[0] : raw;

  return (
    <Screen>
      <Card title="Payment did not go through">
        <Text style={styles.hint}>
          The payment did not go through. Nothing was charged, and the plan is unchanged.
          You can try again from the order.
        </Text>
        {plan ? (
          <Button title="Try again" onPress={() => router.replace({ pathname: '/purchase', params: { plan } })} />
        ) : null}
        <Button title="View plans" variant="secondary" onPress={() => router.replace('/billing')} />
      </Card>
    </Screen>
  );
}
