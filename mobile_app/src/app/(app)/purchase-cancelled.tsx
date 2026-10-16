import { router, useLocalSearchParams } from 'expo-router';
import { Text } from 'react-native';

import { Button, Card, Screen, styles } from '@/components/ui';

export default function PurchaseCancelled() {
  const raw = useLocalSearchParams<{ plan?: string }>().plan;
  const plan = Array.isArray(raw) ? raw[0] : raw;

  return (
    <Screen>
      <Card title="Payment cancelled">
        <Text style={styles.hint}>
          You left the payment page before paying. Nothing was charged, and the plan is unchanged.
        </Text>
        {plan ? (
          <Button title="Back to the order" onPress={() => router.replace({ pathname: '/purchase', params: { plan } })} />
        ) : null}
        <Button title="View plans" variant="secondary" onPress={() => router.replace('/billing')} />
      </Card>
    </Screen>
  );
}
