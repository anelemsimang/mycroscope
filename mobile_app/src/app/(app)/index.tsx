import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { OnboardingChecklist } from '@/components/Onboarding';
import { ServiceBanner } from '@/components/ServiceBanner';
import {
  ActionButton, Button, Card, Empty, ErrorBanner, Loading, Pill, Screen, StatGrid, colors, stateColor, stateLabel, styles,
} from '@/components/ui';
import { api, type TeamRow } from '@/lib/api';
import { confirmAction } from '@/lib/dialog';
import { formatDuration, formatRelative, formatTime, todayIn } from '@/lib/format';
import { useProfile, useSession } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import { useAsync } from '@/lib/useAsync';

const roleLabel = { owner: 'OWNER', manager: 'MANAGER', employee: 'EMPLOYEE' } as const;
const roleColor = { owner: colors.danger, manager: colors.warning, employee: colors.primary } as const;

export default function Dashboard() {
  const profile = useProfile();
  const { signOut, service } = useSession();
  const [live, setLive] = useState(false);
  const alerts = useAsync(() => api.integrityAlerts(new Date(Date.now() - 86_400_000).toISOString()), []);
  const highAlerts = (alerts.data ?? []).filter((a) => a.severity === 'high').length;
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const { data, error, loading, refreshing, refresh, reload } = useAsync(async () => {
    const rows = await api.teamOverview(todayIn(profile.timezone));
    setUpdatedAt(new Date().toISOString());
    return rows;
  }, [profile.timezone]);

  // Live updates: agent status changes push a refresh; polling covers missed events.
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const debounced = () => {
      clearTimeout(timer);
      timer = setTimeout(() => reloadRef.current(), 1500);
    };
    const channel = supabase
      .channel(`team-${profile.organizationId}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'agent_status', filter: `organization_id=eq.${profile.organizationId}` },
        debounced)
      .subscribe((status) => setLive(status === 'SUBSCRIBED'));
    const poll = setInterval(() => reloadRef.current(), 30_000);
    return () => {
      clearTimeout(timer);
      clearInterval(poll);
      supabase.removeChannel(channel);
    };
  }, [profile.organizationId]);

  const all = data ?? [];
  const team = useMemo(() => sortRows(all.filter((r) => r.is_active)), [all]);
  const deactivated = all.filter((r) => !r.is_active);
  const online = team.filter((r) => r.is_online).length;
  const totalActive = team.reduce((a, r) => a + r.active_seconds, 0);
  const totalIdle = team.reduce((a, r) => a + r.idle_seconds, 0);

  return (
    <Screen refreshing={refreshing} onRefresh={refresh} padded={false}>
      <View style={local.header}>
        <Text style={local.welcome}>Welcome, {profile.name}</Text>
        <Text style={styles.hint}>{profile.role === 'owner' ? 'Owner' : 'Manager'} Dashboard · {profile.organizationName}</Text>
        <View style={[styles.row, { gap: 6, marginTop: 4 }]}>
          <View style={[local.dot, { backgroundColor: live ? colors.success : colors.danger }]} />
          <Text style={styles.hint}>
            {live ? 'Live data' : 'Connecting…'}{updatedAt ? ` · updated ${formatTime(updatedAt, profile.timezone)}` : ''}
          </Text>
        </View>
      </View>

      <View style={local.body}>
        {error ? <ErrorBanner message={error} onRetry={refresh} /> : null}
        <ServiceBanner service={service} timezone={profile.timezone} />
        <OnboardingChecklist team={data} />
        {alerts.data && alerts.data.length > 0 ? (
          <Pressable onPress={() => router.push('/alerts')} accessibilityRole="button"
            style={({ pressed }) => [local.alerts, pressed && { opacity: 0.7 }]}>
            <Text style={{ color: colors.danger, fontWeight: '600', flex: 1 }}>
              {alerts.data.length} alert{alerts.data.length === 1 ? '' : 's'} in the last 24 hours
              {highAlerts > 0 ? ` (${highAlerts} high)` : ''}
            </Text>
            <Text style={{ color: colors.danger, fontWeight: '600' }}>Review ›</Text>
          </Pressable>
        ) : null}
        <StatGrid items={[
          { label: 'Online now', value: `${online}/${team.length}` },
          { label: 'Team active today', value: formatDuration(totalActive), color: colors.success },
          { label: 'Team idle today', value: formatDuration(totalIdle), color: colors.warning },
        ]} />

        <Card title="Quick Actions">
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <ActionButton title="Reports" onPress={() => router.push('/reports')} />
            <ActionButton title="Register Employee" onPress={() => router.push('/register')} />
            <ActionButton title="Alerts" onPress={() => router.push('/alerts')} />
            <ActionButton title="Settings" onPress={() => router.push('/settings')} />
          </View>
        </Card>

        <Card title={`Team Overview (${team.length})`}>
          {loading && !data ? <Loading /> : null}
          {data && team.length === 0 ? <Empty text="No employees yet. Tap Register Employee to add one." /> : null}
          {team.map((r) => <TeamRowItem key={r.employee_id} row={r} />)}
        </Card>

        {deactivated.length > 0 ? (
          <Card title={`Deactivated (${deactivated.length})`}>
            {deactivated.map((r) => <TeamRowItem key={r.employee_id} row={r} />)}
          </Card>
        ) : null}

        <Card>
          <Button title="Logout" variant="danger" onPress={async () => {
            if (await confirmAction('Confirm Logout', 'Are you sure you want to logout?', 'Logout')) signOut();
          }} />
        </Card>
      </View>
    </Screen>
  );
}

function sortRows(rows: TeamRow[]): TeamRow[] {
  const rank = (r: TeamRow) => (!r.is_online ? 3 : r.current_state === 'active' ? 0 : r.current_state === 'idle' ? 1 : 2);
  return [...rows].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

function statusOf(r: TeamRow): { label: string; color: string } {
  if (!r.activated) return { label: 'Not activated', color: colors.warning };
  if (!r.is_online || !r.current_state || r.current_state === 'logged_out') return { label: 'Offline', color: colors.danger };
  return { label: `Online · ${stateLabel[r.current_state]}`, color: stateColor[r.current_state] };
}

function TeamRowItem({ row }: { row: TeamRow }) {
  const status = statusOf(row);
  const doing = row.is_online && row.current_state === 'active'
    ? [row.current_app, row.current_domain].filter(Boolean).join(' · ')
    : row.is_online && row.current_state === 'paused' ? 'Tracking paused by employee'
    : row.activated && !row.is_online ? `Last seen ${formatRelative(row.last_seen_at)}` : '';
  const open = () => router.push({ pathname: row.activated ? '/employee/[id]' : '/manage/[id]', params: { id: row.employee_id } });
  return (
    <View style={[local.empRow, !row.is_active && { opacity: 0.6 }]}>
      <Pressable style={{ flex: 1, gap: 2 }} onPress={open}>
        <View style={[styles.row, { gap: 8 }]}>
          <Text style={local.empName} numberOfLines={1}>{row.name}</Text>
          <View style={[local.roleBadge, { backgroundColor: roleColor[row.role] }]}>
            <Text style={local.roleText}>{roleLabel[row.role]}</Text>
          </View>
        </View>
        {doing ? <Text style={styles.hint} numberOfLines={1}>{doing}</Text> : null}
        {row.is_online && row.current_project ? <Text style={styles.hint} numberOfLines={1}>Project: {row.current_project}</Text> : null}
        {row.activated ? (
          <Text style={styles.hint}>
            Today {formatDuration(row.active_seconds)} active · {formatDuration(row.idle_seconds)} idle
            {row.paused_seconds ? ` · ${formatDuration(row.paused_seconds)} paused` : ''}
          </Text>
        ) : <Text style={styles.hint}>{row.employee_code} · waiting for the desktop app to be activated</Text>}
        {row.activated && row.needs_acknowledgement ? <Pill text="Notice not acknowledged" color={colors.danger} /> : null}
      </Pressable>
      <View style={{ alignItems: 'flex-end', gap: 6 }}>
        <View style={[styles.row, { gap: 5 }]}>
          <View style={[local.dot, { backgroundColor: status.color }]} />
          <Text style={[local.statusText, { color: status.color }]}>{status.label}</Text>
        </View>
        <Pressable hitSlop={6} style={local.manage} accessibilityRole="button" accessibilityLabel={`Manage ${row.name}`}
          onPress={() => router.push({ pathname: '/manage/[id]', params: { id: row.employee_id } })}>
          <Text style={local.manageText}>Manage</Text>
        </Pressable>
      </View>
    </View>
  );
}

const local = StyleSheet.create({
  header: { backgroundColor: colors.card, padding: 12, borderBottomWidth: 1, borderBottomColor: colors.border, gap: 2 },
  welcome: { fontSize: 18, fontWeight: 'bold', color: colors.text },
  body: { padding: 12, gap: 12, paddingBottom: 40 },
  alerts: {
    flexDirection: 'row', gap: 8, padding: 12, borderRadius: 8, backgroundColor: '#fee2e2',
    borderLeftWidth: 4, borderLeftColor: colors.danger,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  empRow: {
    flexDirection: 'row', gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#f3f4f6',
    alignItems: 'flex-start',
  },
  empName: { fontSize: 15, fontWeight: '600', color: colors.text, flexShrink: 1 },
  roleBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  roleText: { fontSize: 10, fontWeight: '600', color: '#fff' },
  statusText: { fontSize: 12, fontWeight: '600' },
  manage: { borderWidth: 1, borderColor: colors.primary, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 4 },
  manageText: { color: colors.primary, fontSize: 12, fontWeight: '600' },
});
