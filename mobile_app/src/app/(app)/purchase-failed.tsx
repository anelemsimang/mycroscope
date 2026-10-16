import { useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { Text } from 'react-native';

import { Button, Card, Screen, styles } from '@/components/ui';
import { openWebsite } from '@/lib/websiteCheckout';

function planParam(value: string | string[] | undefined): string {
  const plan = Array.isArray(value) ? value[0] : value;
  return plan ? `?plan=${encodeURIComponent(plan)}` : '';
}

export default function PurchaseFailed() {
  const query = planParam(useLocalSearchParams<{ plan?: string }>().plan);
  useEffect(() => { openWebsite(`/checkout-failed${query}`); }, [query]);

  return (
    <Screen>
      <Card title="Payment is on the website">
        <Text style={styles.hint}>Opening the payment result on the website.</Text>
        <Button title="Continue on the website" onPress={() => openWebsite(`/checkout-failed${query}`)} />
      </Card>
    </Screen>
  );
}
