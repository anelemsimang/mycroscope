import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { CATEGORY_LABEL } from '@/components/CategoryTotals';
import { Button, Card, Empty, ErrorBanner, Field, Loading, Screen, Segmented, colors, styles } from '@/components/ui';
import { api, errorMessage, type Category, type CategoryRule } from '@/lib/api';
import { confirmAction } from '@/lib/dialog';
import { useAsync } from '@/lib/useAsync';

const CATEGORIES: Category[] = ['productive', 'neutral', 'unproductive'];

export default function Categories() {
  const { data, error, loading, refresh } = useAsync(() => api.categoryRules(), []);
  const [kind, setKind] = useState<'app' | 'domain'>('domain');
  const [pattern, setPattern] = useState('');
  const [category, setCategory] = useState<Category>('productive');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function add() {
    setFormError(null);
    if (!pattern.trim()) return setFormError(kind === 'app' ? 'Enter the application name.' : 'Enter the website.');
    setBusy(true);
    try {
      await api.setCategory(kind, pattern, category);
      setPattern('');
      refresh();
    } catch (e) {
      setFormError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(rule: CategoryRule) {
    if (!(await confirmAction('Remove rule?', `${rule.pattern} will no longer be categorised.`, 'Remove'))) return;
    try {
      await api.deleteCategory(rule.id);
      refresh();
    } catch (e) {
      setFormError(errorMessage(e));
    }
  }

  return (
    <Screen>
      <Card title="Productivity categories">
        <Text style={styles.hint}>
          Mark applications and websites as productive, neutral or unproductive. Employee pages and reports then show how
          active time splits across the categories. A website rule also covers its subdomains (youtube.com covers
          m.youtube.com) and takes priority over the browser's application rule.
        </Text>
      </Card>
      <Card title="Add or change a rule">
        {formError ? <ErrorBanner message={formError} /> : null}
        <Segmented options={[{ value: 'domain', label: 'Website' }, { value: 'app', label: 'Application' }]} value={kind} onChange={setKind} />
        <Field label={kind === 'app' ? 'Application name (as shown in reports)' : 'Website'} value={pattern} onChangeText={setPattern}
          placeholder={kind === 'app' ? 'Microsoft Excel' : 'youtube.com'} autoCapitalize="none" autoCorrect={false} />
        <Segmented options={CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))} value={category} onChange={setCategory} />
        <Button title="Save rule" onPress={add} loading={busy} />
      </Card>
      {error ? <ErrorBanner message={error} onRetry={refresh} /> : null}
      {loading && !data ? <Loading /> : null}
      {data ? CATEGORIES.map((c) => {
        const rules = data.filter((r) => r.category === c);
        return (
          <Card key={c} title={`${CATEGORY_LABEL[c]} (${rules.length})`}>
            {rules.length === 0 ? <Empty text="No rules." /> : rules.map((r) => (
              <View key={r.id} style={[styles.row, { justifyContent: 'space-between', paddingVertical: 6 }]}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowText}>{r.pattern}</Text>
                  <Text style={styles.hint}>{r.kind === 'app' ? 'Application' : 'Website'}</Text>
                </View>
                <Pressable onPress={() => remove(r)} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Remove ${r.pattern}`}>
                  <Text style={{ color: colors.danger, fontWeight: '600' }}>Remove</Text>
                </Pressable>
              </View>
            ))}
          </Card>
        );
      }) : null}
    </Screen>
  );
}
