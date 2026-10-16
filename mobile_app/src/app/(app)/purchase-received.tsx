import { router, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { Text } from 'react-native';

import { Button, Card, Screen, styles } from '@/components/ui';
import { useSession } from '@/lib/session';

export default function PurchaseReceived() {
  const { reloadService } = useSession();
  const raw = useLocalSearchParams<{ plan?: string }>().plan;
  const plan = Array.isArray(raw) ? raw[0] : raw;
  useEffect(() => { void reloadService(); }, []);

  return (
    <Screen>
      <Card title="Payment sent">
        <Text style={styles.hint}>
          You have been sent back to Mycroscope. This page does not mean the payment is confirmed.
          The plan updates after the payment succeeds. That usually takes a minute.
          Open billing again if the plan has not changed.
        </Text>
        <Button title="Check billing" onPress={() => router.replace('/billing')} />
        {plan ? (
          <Button
            title="Get this plan again"
            variant="secondary"
            onPress={() => router.replace({ pathname: '/purchase', params: { plan } })}
          />
        ) : null}
      </Card>
    </Screen>
  );
}
