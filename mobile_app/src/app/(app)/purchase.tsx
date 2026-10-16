import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Linking, Platform, Text } from 'react-native';

import { Button, Card, ErrorBanner, InfoGrid, Loading, Screen, colors, styles } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { webAppUrl } from '@/lib/authLink';
import { formatMoney } from '@/lib/format';
import { useProfile } from '@/lib/session';
import { useAsync } from '@/lib/useAsync';

function appBase(): string | undefined {
  if (Platform.OS === 'web' && typeof window !== 'undefined') return window.location.origin;
  return webAppUrl();
}

export default function Purchase() {
  const raw = useLocalSearchParams<{ plan?: string }>().plan;
  const planKey = Array.isArray(raw) ? raw[0] : raw ?? '';
  const profile = useProfile();
  const isOwner = profile.role === 'owner';
  const { data, error, loading, refresh } = useAsync(async () => {
    if (!planKey || !isOwner) return null;
    const [catalogue, quote] = await Promise.all([api.planCatalogue(), api.quotePlan(planKey)]);
    return { plan: catalogue.find((item) => item.key === planKey) ?? null, quote };
  }, [planKey, isOwner]);
  const [busy, setBusy] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);

  if (!planKey) {
    return (
      <Screen>
        <Card title="Choose a plan">
          <Text style={styles.hint}>Open Subscription & billing and choose a plan to review.</Text>
          <Button title="View plans" onPress={() => router.replace('/billing')} />
        </Card>
      </Screen>
    );
  }
  if (!isOwner) {
    return (
      <Screen>
        <Card title="Owner only">
          <Text style={styles.hint}>Only the organisation owner can pay.</Text>
          <Button title="Back to plans" variant="secondary" onPress={() => router.replace('/billing')} />
        </Card>
      </Screen>
    );
  }
  if (loading && !data) return <Loading />;
  if (error || !data?.plan || !data.quote) {
    return <Screen><ErrorBanner message={error ?? 'That plan is not available.'} onRetry={refresh} /></Screen>;
  }

  const { plan, quote } = data;
  const payable = quote.gross_cents > 0 && quote.kind !== 'downgrade';
  const already = quote.kind === 'current' && quote.gross_cents === 0;
  const items = [
    { label: 'Plan', value: plan.name },
    { label: 'People', value: String(quote.seats) },
    {
      label: 'Monthly price',
      value: plan.net_price_cents === 0 ? 'No charge' : `${formatMoney(plan.net_price_cents)} per person, before VAT`,
    },
  ];
  if (payable) {
    items.push(
      { label: 'Before VAT', value: formatMoney(quote.net_cents ?? 0) },
      { label: 'VAT', value: formatMoney(quote.vat_cents ?? 0) },
      { label: 'Due now', value: formatMoney(quote.gross_cents) },
    );
  }

  async function pay() {
    setPayError(null);
    setBusy(true);
    try {
      if (!payable) {
        await api.commitPlanChange(plan.key);
        router.replace('/billing');
        return;
      }
      const base = appBase();
      if (!base) {
        setPayError('Open Mycroscope in a browser to pay.');
        return;
      }
      const q = encodeURIComponent(plan.key);
      const checkout = await api.startCheckout(plan.key, {
        success: `${base}/purchase-received?plan=${q}`,
        cancel: `${base}/purchase-cancelled?plan=${q}`,
        failure: `${base}/purchase-failed?plan=${q}`,
      });
      if (!checkout.redirect_url) {
        setPayError(checkout.message ?? 'No payment is due.');
        return;
      }
      await Linking.openURL(checkout.redirect_url);
    } catch (e) {
      setPayError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const action = quote.kind === 'downgrade' ? 'Schedule this change' : 'Confirm plan';

  return (
    <Screen>
      {payError ? <ErrorBanner message={payError} /> : null}
      <Card title="Order">
        <InfoGrid items={items} />
        {quote.message ? <Text style={styles.hint}>{quote.message}</Text> : null}
        {payable ? (
          <Text style={styles.hint}>
            You pay on a secure page. Coming back to Mycroscope is not proof of payment.
            The plan updates when the payment is confirmed. Paying agrees to the{' '}
            <Text style={{ color: colors.primary, fontWeight: '600' }} onPress={() => router.push('/terms')}>terms of service</Text>.
          </Text>
        ) : null}
        <Text style={{ fontSize: 28, fontWeight: '700', color: colors.primary }}>
          {payable ? formatMoney(quote.gross_cents) : formatMoney(0)}
        </Text>
        {already ? null : <Button title={payable ? 'Buy plan' : action} onPress={pay} loading={busy} />}
        <Button title="Back to plans" variant="ghost" onPress={() => router.replace('/billing')} />
      </Card>
    </Screen>
  );
}
