import { useState, type PropsWithChildren, type ReactNode } from 'react';
import {
  ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Switch, Text, TextInput, View,
  type TextInputProps, type ViewStyle,
} from 'react-native';

import type { ActivityState } from '@/lib/api';

export const colors = {
  primary: '#1e3a8a',
  primaryLight: '#dbeafe',
  background: '#f8fafc',
  card: '#ffffff',
  text: '#1f2937',
  muted: '#6b7280',
  border: '#e5e7eb',
  danger: '#dc2626',
  success: '#059669',
  warning: '#d97706',
  away: '#9ca3af',
};

/** Navy header bar with white text, used by every stack. */
export const headerOptions = {
  headerStyle: { backgroundColor: colors.primary },
  headerTintColor: '#ffffff',
  headerTitleStyle: { fontWeight: 'bold' as const },
  contentStyle: { backgroundColor: colors.background },
};

export const stateColor: Record<ActivityState, string> = {
  active: colors.success,
  idle: colors.warning,
  away: colors.away,
  paused: '#7c3aed',
  logged_out: colors.away,
};

export const stateLabel: Record<ActivityState, string> = {
  active: 'Active',
  idle: 'Idle',
  away: 'Away',
  paused: 'Paused',
  logged_out: 'Signed out',
};

export function Screen({ children, refreshing, onRefresh, padded = true }: PropsWithChildren<{
  refreshing?: boolean; onRefresh?: () => void; padded?: boolean;
}>) {
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={[
        { width: '100%', maxWidth: 820, alignSelf: 'center' },
        padded ? { padding: 12, paddingBottom: 40, gap: 12 } : null,
      ]}
      keyboardShouldPersistTaps="handled"
      refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} /> : undefined}>
      {children}
    </ScrollView>
  );
}

export function Card({ children, style, title, right }: PropsWithChildren<{ style?: ViewStyle; title?: string; right?: ReactNode }>) {
  return (
    <View style={[styles.card, style]}>
      {(title || right) && (
        <View style={styles.cardHeader}>
          {title ? <Text style={styles.cardTitle}>{title}</Text> : <View />}
          {right}
        </View>
      )}
      {children}
    </View>
  );
}

export function Button({ title, onPress, variant = 'primary', disabled, loading, small }: {
  title: string; onPress: () => void; variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  disabled?: boolean; loading?: boolean; small?: boolean;
}) {
  const bg = { primary: colors.primary, secondary: colors.primaryLight, danger: colors.danger, ghost: 'transparent' }[variant];
  const fg = variant === 'secondary' || variant === 'ghost' ? colors.primary : '#fff';
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.button, small && styles.buttonSmall, { backgroundColor: bg, opacity: disabled ? 0.5 : pressed ? 0.8 : 1 },
      ]}>
      {loading ? <ActivityIndicator color={fg} /> : <Text style={[styles.buttonText, { color: fg }]}>{title}</Text>}
    </Pressable>
  );
}

export function Field({ label, hint, secureTextEntry, ...props }: TextInputProps & { label: string; hint?: string }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <View style={{ gap: 4 }}>
      <Text style={styles.label}>{label}</Text>
      <View>
        <TextInput placeholderTextColor={colors.muted} {...props}
          style={[styles.input, secureTextEntry ? { paddingRight: 64 } : null]}
          secureTextEntry={secureTextEntry && !revealed}
          autoCapitalize={secureTextEntry ? 'none' : props.autoCapitalize}
          autoCorrect={secureTextEntry ? false : props.autoCorrect} />
        {secureTextEntry ? (
          <Pressable onPress={() => setRevealed((r) => !r)} hitSlop={8} style={styles.reveal}
            accessibilityRole="button" accessibilityLabel={revealed ? `Hide ${label}` : `Show ${label}`}>
            <Text style={styles.revealText}>{revealed ? 'Hide' : 'Show'}</Text>
          </Pressable>
        ) : null}
      </View>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

export function ToggleRow({ label, value, onChange, disabled, hint }: {
  label: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean; hint?: string;
}) {
  return (
    <View style={styles.toggleRow}>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowText}>{label}</Text>
        {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      </View>
      <Switch value={value} onValueChange={onChange} disabled={disabled} />
    </View>
  );
}

export function Segmented<T extends string>({ options, value, onChange }: {
  options: { value: T; label: string }[]; value: T; onChange: (v: T) => void;
}) {
  return (
    <View style={styles.segmented}>
      {options.map((o) => (
        <Pressable key={o.value} onPress={() => onChange(o.value)}
          style={[styles.segment, o.value === value && styles.segmentActive]}>
          <Text style={[styles.segmentText, o.value === value && { color: '#fff' }]}>{o.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function StateBadge({ state, online = true }: { state: ActivityState | null; online?: boolean }) {
  const s: ActivityState = !online || !state ? 'logged_out' : state;
  return (
    <View style={[styles.badge, { backgroundColor: `${stateColor[s]}22` }]}>
      <View style={[styles.dot, { backgroundColor: stateColor[s] }]} />
      <Text style={[styles.badgeText, { color: stateColor[s] }]}>{online ? stateLabel[s] : 'Offline'}</Text>
    </View>
  );
}

export function Pill({ text, color = colors.muted }: { text: string; color?: string }) {
  return (
    <View style={[styles.badge, { backgroundColor: `${color}1f` }]}>
      <Text style={[styles.badgeText, { color }]}>{text}</Text>
    </View>
  );
}

export function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={{ flex: 1, alignItems: 'center' }}>
      <Text style={[styles.statValue, color ? { color } : null]}>{value}</Text>
      <Text style={styles.hint}>{label}</Text>
    </View>
  );
}

/** Horizontal bar proportional to value/max. */
export function BarRow({ label, value, max, right, sub, color = colors.primary }: {
  label: string; value: number; max: number; right: string; sub?: string; color?: string;
}) {
  const pct = max > 0 ? Math.max(2, (value / max) * 100) : 0;
  return (
    <View style={{ gap: 4, paddingVertical: 6 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
        <Text style={[styles.rowText, { flex: 1 }]} numberOfLines={1}>{label}</Text>
        <Text style={styles.rowText}>{right}</Text>
      </View>
      {sub ? <Text style={styles.hint} numberOfLines={1}>{sub}</Text> : null}
      <View style={styles.barTrack}>
        <View style={[styles.barFill, { width: `${pct}%`, backgroundColor: color }]} />
      </View>
    </View>
  );
}

/** Stacked bar of active/idle/away/paused seconds. */
export function StackedBar({ parts, height = 10 }: { parts: { value: number; color: string }[]; height?: number }) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  return (
    <View style={[styles.barTrack, { height, flexDirection: 'row' }]}>
      {total > 0 && parts.map((p, i) => (
        <View key={i} style={{ width: `${(p.value / total) * 100}%`, backgroundColor: p.color }} />
      ))}
    </View>
  );
}

export function Loading() {
  return <View style={{ padding: 40 }}><ActivityIndicator size="large" color={colors.primary} /></View>;
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <View style={styles.error}>
      <Text style={{ color: colors.danger, flex: 1 }}>{message}</Text>
      {onRetry ? <Text style={{ color: colors.primary, fontWeight: '600' }} onPress={onRetry}>Retry</Text> : null}
    </View>
  );
}

export function Empty({ text }: { text: string }) {
  return <Text style={[styles.hint, { textAlign: 'center', paddingVertical: 16 }]}>{text}</Text>;
}

export function SectionTitle({ children }: PropsWithChildren) {
  return <Text style={styles.sectionTitle}>{children}</Text>;
}

/** Row of white stat boxes (the dashboard's "number over label" cards). */
export function StatGrid({ items }: { items: { label: string; value: string; color?: string }[] }) {
  return (
    <View style={styles.statGrid}>
      {items.map((s) => (
        <View key={s.label} style={styles.statBox}>
          <Text style={[styles.statNumber, s.color ? { color: s.color } : null]} numberOfLines={1}>{s.value}</Text>
          <Text style={styles.statLabel}>{s.label}</Text>
        </View>
      ))}
    </View>
  );
}

export function InnerTabs<T extends string>({ tabs, value, onChange }: {
  tabs: { value: T; label: string }[]; value: T; onChange: (v: T) => void;
}) {
  return (
    <View style={styles.tabBar}>
      {tabs.map((t) => (
        <Pressable key={t.value} onPress={() => onChange(t.value)} accessibilityRole="tab"
          accessibilityState={{ selected: t.value === value }}
          style={[styles.tab, t.value === value && styles.tabActive]}>
          <Text style={[styles.tabText, t.value === value && styles.tabTextActive]} numberOfLines={1}>{t.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function InfoGrid({ items }: { items: { label: string; value: string }[] }) {
  return (
    <View style={styles.infoGrid}>
      {items.map((i) => (
        <View key={i.label} style={styles.infoItem}>
          <Text style={styles.infoLabel}>{i.label}</Text>
          <Text style={styles.infoValue} selectable>{i.value}</Text>
        </View>
      ))}
    </View>
  );
}

/** Tappable list row with a chevron, used to drill into details. */
export function LinkRow({ title, subtitle, right, onPress }: {
  title: string; subtitle?: string | null; right?: string; onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.linkRow, pressed && { opacity: 0.6 }]}>
      <View style={{ flex: 1 }}>
        <Text style={[styles.rowText, { fontWeight: '600' }]} numberOfLines={1}>{title}</Text>
        {subtitle ? <Text style={styles.hint} numberOfLines={1}>{subtitle}</Text> : null}
      </View>
      {right ? <Text style={styles.rowText}>{right}</Text> : null}
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

/** Compact navy action button used in the dashboard's Quick Actions row. */
export function ActionButton({ title, onPress }: { title: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button"
      style={({ pressed }) => [styles.actionButton, pressed && { opacity: 0.8 }]}>
      <Text style={styles.actionButtonText} numberOfLines={2}>{title}</Text>
    </Pressable>
  );
}

export const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card, borderRadius: 8, padding: 12, gap: 6,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 2, elevation: 1,
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  cardTitle: { fontSize: 14, fontWeight: '600', color: colors.text },
  sectionTitle: { fontSize: 14, fontWeight: '600', color: colors.text, marginTop: 4 },
  statGrid: { flexDirection: 'row', gap: 8 },
  statBox: {
    flex: 1, backgroundColor: colors.card, borderRadius: 8, padding: 12, alignItems: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 2, elevation: 1,
  },
  statNumber: { fontSize: 18, fontWeight: '700', color: colors.primary, marginBottom: 2 },
  statLabel: { fontSize: 11, color: colors.muted, textAlign: 'center' },
  tabBar: { flexDirection: 'row', backgroundColor: colors.card, borderRadius: 8, padding: 4, gap: 4 },
  tab: { flex: 1, paddingVertical: 9, borderRadius: 6, alignItems: 'center' },
  tabActive: { backgroundColor: colors.primary },
  tabText: { fontSize: 13, fontWeight: '600', color: colors.muted },
  tabTextActive: { color: '#fff' },
  infoGrid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 10 },
  infoItem: { width: '50%', paddingRight: 8 },
  infoLabel: { fontSize: 11, color: colors.muted, marginBottom: 2 },
  infoValue: { fontSize: 14, fontWeight: '600', color: colors.text },
  linkRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: '#f3f4f6',
  },
  chevron: { fontSize: 20, color: colors.muted, marginLeft: 2 },
  actionButton: {
    flex: 1, backgroundColor: colors.primary, paddingVertical: 12, paddingHorizontal: 8, borderRadius: 6,
    alignItems: 'center', justifyContent: 'center', minHeight: 44,
  },
  actionButtonText: { color: '#fff', fontSize: 13, fontWeight: '600', textAlign: 'center' },
  button: { borderRadius: 8, paddingVertical: 13, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  buttonSmall: { paddingVertical: 8, paddingHorizontal: 12 },
  buttonText: { fontSize: 15, fontWeight: '600' },
  label: { fontSize: 13, fontWeight: '600', color: colors.text },
  hint: { fontSize: 12, color: colors.muted },
  input: {
    borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 11,
    fontSize: 15, color: colors.text, backgroundColor: '#fff',
  },
  reveal: { position: 'absolute', right: 0, top: 0, bottom: 0, justifyContent: 'center', paddingHorizontal: 14 },
  revealText: { fontSize: 13, fontWeight: '600', color: colors.primary },
  rowText: { fontSize: 14, color: colors.text },
  title: { fontSize: 22, fontWeight: '800', color: colors.primary },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6 },
  segmented: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  segment: { paddingVertical: 7, paddingHorizontal: 12, borderRadius: 16, backgroundColor: colors.primaryLight },
  segmentActive: { backgroundColor: colors.primary },
  segmentText: { color: colors.primary, fontWeight: '600', fontSize: 13 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, alignSelf: 'flex-start' },
  badgeText: { fontSize: 12, fontWeight: '600' },
  dot: { width: 8, height: 8, borderRadius: 4 },
  statValue: { fontSize: 18, fontWeight: '700', color: colors.text },
  barTrack: { height: 8, borderRadius: 4, backgroundColor: colors.border, overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: 4 },
  error: { flexDirection: 'row', gap: 8, padding: 12, borderRadius: 10, backgroundColor: '#fee2e2' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: 4 },
});
