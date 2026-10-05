import { router } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { colors, styles } from '@/components/ui';
import type { ServiceStatus } from '@/lib/api';
import { formatDate } from '@/lib/format';

const DAY = 86_400_000;

/** One-line summary of the subscription, or null when there is nothing to say. */
export function serviceMessage(s: ServiceStatus | null, timezone: string, now = Date.now()): { text: string; tone: 'info' | 'warning' | 'danger' } | null {
  if (!s) return null;
  if (s.level === 'read_only') {
    const why = s.status === 'trialing' ? 'Your free trial has ended'
      : s.status === 'suspended' ? 'Your subscription is suspended'
      : s.status === 'cancelled' ? 'Your subscription is cancelled'
      : 'Your subscription has expired';
    return { text: `${why}. Data stays viewable, but nothing new is recorded and no employees can be added.`, tone: 'danger' };
  }
  if (s.status === 'trialing' && s.trial_ends_at) {
    const days = Math.max(0, Math.ceil((Date.parse(s.trial_ends_at) - now) / DAY));
    return { text: `Free trial: ${days} day${days === 1 ? '' : 's'} left (until ${formatDate(s.trial_ends_at, timezone)}).`, tone: days <= 3 ? 'warning' : 'info' };
  }
  if (s.current_period_end && Date.parse(s.current_period_end) < now) {
    return { text: `Payment overdue. Recording stops on ${formatDate(s.grace_until, timezone)} unless the subscription is renewed.`, tone: 'danger' };
  }
  if (s.current_period_end && Date.parse(s.current_period_end) - now < 7 * DAY) {
    return { text: `Your subscription renews on ${formatDate(s.current_period_end, timezone)}.`, tone: 'warning' };
  }
  if (s.seats_used >= s.seats) {
    return { text: `All ${s.seats} seats are in use. Add seats to register more employees.`, tone: 'warning' };
  }
  return null;
}

export function ServiceBanner({ service, timezone }: { service: ServiceStatus | null; timezone: string }) {
  const msg = serviceMessage(service, timezone);
  if (!msg) return null;
  const color = msg.tone === 'danger' ? colors.danger : msg.tone === 'warning' ? colors.warning : colors.primary;
  return (
    <Pressable onPress={() => router.push('/billing')} accessibilityRole="button"
      style={({ pressed }) => [{ backgroundColor: `${color}18`, borderRadius: 8, padding: 12, borderLeftWidth: 4, borderLeftColor: color },
        pressed && { opacity: 0.7 }]}>
      <View style={[styles.row, { justifyContent: 'space-between' }]}>
        <Text style={[styles.rowText, { flex: 1, color }]}>{msg.text}</Text>
        <Text style={{ color, fontWeight: '600' }}>Billing ›</Text>
      </View>
    </Pressable>
  );
}
