import { router } from 'expo-router';
import { useEffect, useMemo, useRef } from 'react';
import { Pressable, Text, View } from 'react-native';

import {
  Card, Empty, ErrorBanner, Loading, Pill, Screen, StackedBar, StateBadge, Stat, colors, stateColor, styles,
} from '@/components/ui';
import { api, type TeamRow } from '@/lib/api';
import { formatDuration, formatRelative, todayIn } from '@/lib/format';
import { useProfile } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import { useAsync } from '@/lib/useAsync';

export default function Team() {
  const profile = useProfile();
  const { data, error, loading, refreshing, refresh, reload } = useAsync(
    () => api.teamOverview(todayIn(profile.timezone)), [profile.timezone]);

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
      .subscribe();
    const poll = setInterval(() => reloadRef.current(), 30_000);
    return () => {
      clearTimeout(timer);
      clearInterval(poll);
      supabase.removeChannel(channel);
    };
  }, [profile.organizationId]);

  const rows = useMemo(() => (data ?? []).filter((r) => r.is_active), [data]);
  const online = rows.filter((r) => r.is_online);
  const activeNow = online.filter((r) => r.current_state === 'active').length;
  const totalActive = rows.reduce((a, r) => a + r.active_seconds, 0);

  return (
    <Screen refreshing={refreshing} onRefresh={refresh}>
      <Text style={styles.title}>{profile.organizationName}</Text>
      {error ? <ErrorBanner message={error} onRetry={refresh} /> : null}
      <Card>
        <View style={{ flexDirection: 'row' }}>
          <Stat label="Online" value={`${online.length}/${rows.length}`} />
          <Stat label="Active now" value={String(activeNow)} color={colors.success} />
          <Stat label="Active today" value={formatDuration(totalActive)} />
        </View>
      </Card>
      {loading && !data ? <Loading /> : null}
      {data && rows.length === 0 ? <Empty text="No employees yet. Add one on the Employees tab." /> : null}
      {sortRows(rows).map((r) => <EmployeeRowCard key={r.employee_id} row={r} />)}
    </Screen>
  );
}

function sortRows(rows: TeamRow[]): TeamRow[] {
  const rank = (r: TeamRow) => (!r.is_online ? 3 : r.current_state === 'active' ? 0 : r.current_state === 'idle' ? 1 : 2);
  return [...rows].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

function EmployeeRowCard({ row }: { row: TeamRow }) {
  const activity = row.is_online && row.current_state === 'active'
    ? [row.current_app, row.current_domain].filter(Boolean).join(' · ')
    : row.is_online ? '' : `Last seen ${formatRelative(row.last_seen_at)}`;
  return (
    <Pressable onPress={() => router.push({ pathname: '/employee/[id]', params: { id: row.employee_id } })}>
      <Card>
        <View style={[styles.row, { justifyContent: 'space-between' }]}>
          <Text style={[styles.cardTitle, { flex: 1 }]} numberOfLines={1}>{row.name}</Text>
          <StateBadge state={row.current_state} online={row.is_online} />
        </View>
        {activity ? <Text style={styles.hint} numberOfLines={1}>{activity}</Text> : null}
        {row.current_project && row.is_online ? <Text style={styles.hint}>Project: {row.current_project}</Text> : null}
        <View style={[styles.row, { flexWrap: 'wrap', gap: 6 }]}>
          {!row.activated ? <Pill text="Not activated" color={colors.warning} /> : null}
          {row.activated && row.needs_acknowledgement ? <Pill text="Notice not acknowledged" color={colors.danger} /> : null}
        </View>
        <StackedBar parts={[
          { value: row.active_seconds, color: stateColor.active },
          { value: row.idle_seconds, color: stateColor.idle },
          { value: row.paused_seconds, color: stateColor.paused },
          { value: row.away_seconds, color: stateColor.away },
        ]} />
        <Text style={styles.hint}>
          Today: {formatDuration(row.active_seconds)} active · {formatDuration(row.idle_seconds)} idle
          {row.paused_seconds ? ` · ${formatDuration(row.paused_seconds)} paused` : ''}
        </Text>
      </Card>
    </Pressable>
  );
}
