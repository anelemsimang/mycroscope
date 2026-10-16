import { useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { Text } from 'react-native';

import { Button, Card, Screen, styles } from '@/components/ui';
import { openWebsiteCheckout } from '@/lib/websiteCheckout';

function planParam(value: string | string[] | undefined): string | undefined {
  const plan = Array.isArray(value) ? value[0] : value;
  return plan || undefined;
}

/** Old in-app orders now open the website checkout. The app does not take a card payment. */
export default function Purchase() {
  const plan = planParam(useLocalSearchParams<{ plan?: string }>().plan);
  useEffect(() => { openWebsiteCheckout(plan); }, [plan]);

  return (
    <Screen>
      <Card title="Payment is on the website">
        <Text style={styles.hint}>
          Mycroscope opens the website checkout. The card form is on Yoco's secure page.
        </Text>
        <Button title="Continue on the website" onPress={() => openWebsiteCheckout(plan)} />
      </Card>
    </Screen>
  );
}
