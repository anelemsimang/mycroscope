import { useMemo, useState } from 'react';
import { Text, View } from 'react-native';

import { Card, Empty, colors, stateColor, stateLabel, styles } from '@/components/ui';
import type { TimelineRow } from '@/lib/api';
import { formatDuration, formatTime } from '@/lib/format';

interface Block {
  key: string;
  state: TimelineRow['state'];
  start: string;
  end: string;
  seconds: number;
  label: string;
  detail: string | null;
}

/** Merges consecutive segments with the same state and app/site into readable blocks. */
function toBlocks(rows: TimelineRow[]): Block[] {
  const blocks: Block[] = [];
  for (const r of rows) {
    const label = r.state === 'active' ? (r.app_name ?? 'Unknown app') : stateLabel[r.state];
    const detail = r.state === 'active' ? (r.domain ?? r.window_title) : null;
    const last = blocks[blocks.length - 1];
    if (last && last.state === r.state && last.label === label && last.end === r.started_at &&
        (r.state !== 'active' || last.detail === detail)) {
      last.end = r.ended_at;
      last.seconds += r.duration_seconds;
    } else {
      blocks.push({ key: r.id, state: r.state, start: r.started_at, end: r.ended_at, seconds: r.duration_seconds, label, detail });
    }
  }
  return blocks;
}

export function Timeline({ rows, timezone, title = 'Timeline' }: { rows: TimelineRow[]; timezone: string; title?: string }) {
  const [showAll, setShowAll] = useState(false);
  const blocks = useMemo(() => toBlocks(rows), [rows]);
  const shown = showAll ? blocks : blocks.slice(-25);
  return (
    <Card title={`${title} (${blocks.length})`} right={blocks.length > 25 ? (
      <Text style={{ color: colors.primary, fontWeight: '600' }} onPress={() => setShowAll(!showAll)}>
        {showAll ? 'Latest only' : 'Show all'}
      </Text>
    ) : undefined}>
      {blocks.length === 0 ? <Empty text="Nothing recorded." /> : null}
      {!showAll && blocks.length > 25 ? <Text style={styles.hint}>Showing the latest 25.</Text> : null}
      {shown.map((b) => (
        <View key={b.key} style={[styles.row, { alignItems: 'flex-start', paddingVertical: 4 }]}>
          <View style={[styles.dot, { backgroundColor: stateColor[b.state], marginTop: 6 }]} />
          <View style={{ flex: 1 }}>
            <Text style={styles.rowText} numberOfLines={1}>{b.label}</Text>
            {b.detail ? <Text style={styles.hint} numberOfLines={1}>{b.detail}</Text> : null}
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={styles.hint}>{formatTime(b.start, timezone)}–{formatTime(b.end, timezone)}</Text>
            <Text style={styles.hint}>{formatDuration(b.seconds)}</Text>
          </View>
        </View>
      ))}
    </Card>
  );
}
