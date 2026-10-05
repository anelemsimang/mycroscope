import { router } from 'expo-router';
import { Text } from 'react-native';

import { BarRow, Card, StackedBar, colors, styles } from '@/components/ui';
import type { Category, CategoryTotal } from '@/lib/api';
import { formatDuration, percent } from '@/lib/format';

type Key = Category | 'uncategorised';

export const CATEGORY_LABEL: Record<Key, string> = {
  productive: 'Productive', neutral: 'Neutral', unproductive: 'Unproductive', uncategorised: 'Not categorised',
};
export const CATEGORY_COLOR: Record<Key, string> = {
  productive: colors.success, neutral: colors.primary, unproductive: colors.danger, uncategorised: colors.away,
};
const ORDER: Key[] = ['productive', 'neutral', 'unproductive', 'uncategorised'];

/** Active time split by productivity category. */
export function CategoryTotalsCard({ totals, canEdit }: { totals: CategoryTotal[]; canEdit: boolean }) {
  const by = new Map(totals.map((t) => [t.category, t.active_seconds]));
  const total = totals.reduce((a, t) => a + t.active_seconds, 0);
  if (total === 0) return null;
  const onlyUncategorised = (by.get('uncategorised') ?? 0) === total;
  return (
    <Card title="Productivity" right={canEdit ? (
      <Text style={{ color: colors.primary, fontWeight: '600' }} onPress={() => router.push('/categories')}>Edit categories</Text>
    ) : undefined}>
      {onlyUncategorised ? (
        <Text style={styles.hint}>
          {canEdit ? 'No apps or websites have been categorised yet. Tap Edit categories to mark them as productive or unproductive.'
            : 'Your organisation has not categorised apps or websites yet.'}
        </Text>
      ) : (
        <>
          <StackedBar height={12} parts={ORDER.map((k) => ({ value: by.get(k) ?? 0, color: CATEGORY_COLOR[k] }))} />
          {ORDER.filter((k) => (by.get(k) ?? 0) > 0).map((k) => (
            <BarRow key={k} label={CATEGORY_LABEL[k]} value={by.get(k) ?? 0} max={total} color={CATEGORY_COLOR[k]}
              right={`${formatDuration(by.get(k) ?? 0)} · ${percent(by.get(k) ?? 0, total)}`} />
          ))}
        </>
      )}
    </Card>
  );
}
