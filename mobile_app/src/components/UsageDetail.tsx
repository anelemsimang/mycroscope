import { Stack, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Card, Empty, ErrorBanner, Loading, Screen, SectionTitle, StatGrid, colors, stateColor, styles } from '@/components/ui';
import { SEGMENT_LIMIT, api, type SegmentRow } from '@/lib/api';
import { addDays, dayStartUtc, formatDay, formatDuration, formatTime, todayIn } from '@/lib/format';
import { useProfile } from '@/lib/session';
import { useAsync } from '@/lib/useAsync';

interface Item { key: string; label: string; sub: string | null; active: number; idle: number; last: string }
interface Session { start: string; end: string; active: number; idle: number }

/** Seconds of [start, end) that fall inside [from, to). */
function clipped(r: SegmentRow, fromMs: number, toMs: number): number {
  return Math.max(0, (Math.min(Date.parse(r.ended_at), toMs) - Math.max(Date.parse(r.started_at), fromMs)) / 1000);
}

function summarise(rows: SegmentRow[], fromMs: number, toMs: number, keyOf: (r: SegmentRow) => [string, string, string | null]) {
  const items = new Map<string, Item>();
  const sessions: Session[] = [];
  let active = 0;
  let idle = 0;
  // rows are newest first; walk oldest first so sessions merge forwards.
  for (const r of [...rows].reverse()) {
    const secs = clipped(r, fromMs, toMs);
    if (r.state === 'active') active += secs; else idle += secs;
    const [key, label, sub] = keyOf(r);
    const item = items.get(key) ?? { key, label, sub, active: 0, idle: 0, last: r.ended_at };
    if (r.state === 'active') item.active += secs; else item.idle += secs;
    if (r.ended_at > item.last) item.last = r.ended_at;
    items.set(key, item);
    const prev = sessions[sessions.length - 1];
    if (prev && Date.parse(r.started_at) - Date.parse(prev.end) <= 60_000) {
      prev.end = r.ended_at > prev.end ? r.ended_at : prev.end;
      if (r.state === 'active') prev.active += secs; else prev.idle += secs;
    } else {
      sessions.push({ start: r.started_at, end: r.ended_at, active: r.state === 'active' ? secs : 0, idle: r.state === 'idle' ? secs : 0 });
    }
  }
  return {
    active, idle,
    items: [...items.values()].sort((a, b) => b.active - a.active),
    sessions: sessions.reverse(),
  };
}

export function UsageDetail({ kind }: { kind: 'app' | 'website' }) {
  const profile = useProfile();
  const tz = profile.timezone;
  const p = useLocalSearchParams<{
    id: string; app?: string; domain?: string; from?: string; to?: string; label?: string; name?: string; project?: string;
  }>();
  const today = todayIn(tz);
  const from = p.from ?? today;
  const to = p.to ?? today;
  const subject = (kind === 'app' ? p.app : p.domain) ?? '';
  const fromIso = dayStartUtc(from, tz);
  const toIso = dayStartUtc(addDays(to, 1), tz);

  const { data, error, loading, refreshing, refresh } = useAsync(
    () => api.segments(p.id, fromIso, toIso,
      { ...(kind === 'app' ? { app: subject } : { domain: subject }), project: p.project || null }),
    [p.id, fromIso, toIso, subject, kind, p.project]);

  const summary = useMemo(() => data ? summarise(data, Date.parse(fromIso), Date.parse(toIso), (r) => kind === 'app'
    ? [r.window_title ?? '', r.window_title ?? 'Window title not recorded', null]
    : [r.url ?? r.window_title ?? '', r.window_title ?? r.url ?? 'Page not recorded', r.window_title ? r.url : null],
  ) : null, [data, fromIso, toIso, kind]);

  const periodText = `${p.label ? `${p.label} · ` : ''}${from === to ? formatDay(from) : `${formatDay(from)} – ${formatDay(to)}`}`;
  const multiDay = from !== to;

  return (
    <Screen refreshing={refreshing} onRefresh={refresh}>
      <Stack.Screen options={{ title: subject || (kind === 'app' ? 'App Details' : 'Website Details') }} />
      <Card>
        <Text style={local.subject} numberOfLines={2}>{subject}</Text>
        <Text style={styles.hint}>{p.name ? `${p.name} · ` : ''}{periodText}</Text>
      </Card>
      {error ? <ErrorBanner message={error} onRetry={refresh} /> : null}
      {loading && !data ? <Loading /> : null}
      {summary ? (
        <>
          <StatGrid items={[
            { label: 'Active', value: formatDuration(summary.active), color: stateColor.active },
            { label: 'Idle', value: formatDuration(summary.idle), color: stateColor.idle },
            { label: kind === 'app' ? 'Windows' : 'Pages', value: String(summary.items.length) },
            { label: 'Sessions', value: String(summary.sessions.length) },
          ]} />
          {data && data.length >= SEGMENT_LIMIT ? (
            <Text style={[styles.hint, { color: colors.warning }]}>
              Very busy period: based on the most recent {SEGMENT_LIMIT} records. Choose a shorter period for exact figures.
            </Text>
          ) : null}

          <SectionTitle>{kind === 'app' ? 'Windows' : 'Pages visited'}</SectionTitle>
          <Card>
            {summary.items.length === 0 ? <Empty text="Nothing recorded for this period." /> : null}
            {summary.items.slice(0, 100).map((i) => (
              <View key={i.key} style={local.row}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowText} numberOfLines={2}>{i.label}</Text>
                  {i.sub ? <Text style={styles.hint} numberOfLines={1}>{i.sub}</Text> : null}
                  <Text style={styles.hint}>
                    {formatDuration(i.idle)} idle · last {multiDay ? `${formatDay(todayIn(tz, new Date(i.last)))} ` : ''}{formatTime(i.last, tz)}
                  </Text>
                </View>
                <Text style={[styles.rowText, { fontWeight: '600' }]}>{formatDuration(i.active)}</Text>
              </View>
            ))}
            {summary.items.length > 100 ? <Text style={styles.hint}>Showing the top 100.</Text> : null}
          </Card>

          <SectionTitle>Recent sessions</SectionTitle>
          <Card>
            {summary.sessions.length === 0 ? <Empty text="No sessions." /> : null}
            {summary.sessions.slice(0, 30).map((s) => (
              <View key={s.start} style={local.row}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowText}>
                    {multiDay ? `${formatDay(todayIn(tz, new Date(s.start)), { weekday: true })} · ` : ''}
                    {formatTime(s.start, tz)}–{formatTime(s.end, tz)}
                  </Text>
                  <Text style={styles.hint}>{formatDuration(s.idle)} idle</Text>
                </View>
                <Text style={[styles.rowText, { fontWeight: '600' }]}>{formatDuration(s.active)}</Text>
              </View>
            ))}
          </Card>
          <Text style={[styles.hint, { textAlign: 'center' }]}>Times shown in {tz}.</Text>
        </>
      ) : null}
    </Screen>
  );
}

const local = StyleSheet.create({
  subject: { fontSize: 17, fontWeight: 'bold', color: colors.primary },
  row: { flexDirection: 'row', gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#f3f4f6', alignItems: 'center' },
});
