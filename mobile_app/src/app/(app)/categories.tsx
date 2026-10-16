import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { CATEGORY_LABEL } from '@/components/CategoryTotals';
import { Button, Card, Empty, ErrorBanner, Field, Loading, Screen, Segmented, colors, styles } from '@/components/ui';
import { api, errorMessage, type Category, type CategoryRule } from '@/lib/api';
import { confirmAction } from '@/lib/dialog';
import { manageableTeams } from '@/lib/scope';
import { useProfile } from '@/lib/session';
import { useAsync } from '@/lib/useAsync';

const CATEGORIES: Category[] = ['productive', 'neutral', 'unproductive'];
const COMPANY = 'company';

export default function Categories() {
  const profile = useProfile();
  const { data, error, loading, refresh } = useAsync(async () => {
    const [rules, { teams, managers }, features] = await Promise.all([api.categoryRules(), api.teams(), api.features()]);
    return { rules, teams, scope: manageableTeams(teams, managers, profile), teamRules: features.includes('teams') };
  }, [profile.employeeId]);
  const [scope, setScope] = useState<string>(COMPANY);
  const [kind, setKind] = useState<'app' | 'domain'>('domain');
  const [pattern, setPattern] = useState('');
  const [category, setCategory] = useState<Category>('productive');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const team = scope === COMPANY ? null : scope;
  const teamName = (id: string | null) => data?.teams.find((t) => t.id === id)?.name ?? 'Unknown team';
  const canEdit = (rule: CategoryRule) => rule.team_id === null || !!data?.scope.teams.some((t) => t.id === rule.team_id);

  async function add() {
    setFormError(null);
    if (!pattern.trim()) return setFormError(kind === 'app' ? 'Enter the application name.' : 'Enter the website.');
    setBusy(true);
    try {
      await api.setCategory(kind, pattern, category, team);
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

  const scopes = data && data.teamRules && data.scope.teams.length > 0
    ? [{ value: COMPANY, label: 'Whole company' }, ...data.scope.teams.map((t) => ({ value: t.id, label: t.name }))]
    : null;
  const shown = (data?.rules ?? []).filter((r) => r.team_id === team);

  return (
    <Screen>
      <Card title="Productivity categories">
        <Text style={styles.hint}>
          Mark applications and websites as productive, neutral or unproductive. Employee pages and reports then show how
          active time splits across the categories. A website rule also covers its subdomains (youtube.com covers
          m.youtube.com) and takes priority over the browser's application rule.
        </Text>
        {data?.teamRules ? (
          <Text style={styles.hint}>
            A rule for a team applies to the people in that team and takes priority over the company rule for the same
            app or website. For example, YouTube can be unproductive for the company but productive for Marketing.
          </Text>
        ) : null}
      </Card>
      {scopes ? (
        <Card title="Rules for">
          <Segmented options={scopes} value={scope} onChange={setScope} />
        </Card>
      ) : null}
      <Card title={team ? `Add or change a rule for ${teamName(team)}` : 'Add or change a rule'}>
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
        const rules = shown.filter((r) => r.category === c);
        return (
          <Card key={c} title={`${CATEGORY_LABEL[c]} (${rules.length})`}>
            {rules.length === 0 ? <Empty text="No rules." /> : rules.map((r) => (
              <View key={r.id} style={[styles.row, { justifyContent: 'space-between', paddingVertical: 6 }]}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowText}>{r.pattern}</Text>
                  <Text style={styles.hint}>{r.kind === 'app' ? 'Application' : 'Website'}</Text>
                </View>
                {canEdit(r) ? (
                  <Pressable onPress={() => remove(r)} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Remove ${r.pattern}`}>
                    <Text style={{ color: colors.danger, fontWeight: '600' }}>Remove</Text>
                  </Pressable>
                ) : null}
              </View>
            ))}
          </Card>
        );
      }) : null}
    </Screen>
  );
}
