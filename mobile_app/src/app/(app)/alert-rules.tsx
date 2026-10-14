import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Button, Card, Empty, ErrorBanner, Field, Loading, Pill, Screen, Segmented, ToggleRow, colors, styles } from '@/components/ui';
import { api, errorMessage, type AlertRule, type RulePack, type Severity } from '@/lib/api';
import { confirmAction, notify } from '@/lib/dialog';
import { manageableTeams } from '@/lib/scope';
import { useProfile } from '@/lib/session';
import { useAsync } from '@/lib/useAsync';

const SEVERITIES: { value: Severity; label: string }[] = [
  { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' },
];
const severityColor = { high: colors.danger, medium: colors.warning, low: colors.muted } as const;
const PACKS: { pack: RulePack; title: string; hint: string }[] = [
  { pack: 'file_sharing', title: 'File-sharing sites', hint: 'WeTransfer, Google Drive, Dropbox, Mega and similar (20 sites).' },
  { pack: 'personal_email', title: 'Personal email', hint: 'Gmail, Outlook.com, Yahoo Mail, Proton Mail and similar (10 sites).' },
  { pack: 'bluetooth', title: 'Bluetooth file transfer', hint: 'The Windows Bluetooth file transfer program (fsquirt).' },
];

type Draft = Omit<AlertRule, 'id' | 'pack'> & { id: string | null };
const EMPTY: Draft = { id: null, name: '', kind: 'domain', pattern: '', severity: 'medium', work_hours_only: false, enabled: true };

export default function AlertRules() {
  const profile = useProfile();
  const { data, error, loading, refresh, reload } = useAsync(async () => {
    const [rules, features, { teams, managers }] = await Promise.all([api.alertRules(), api.features(), api.teams()]);
    return { rules, allowed: features.includes('alert_rules'), canEdit: manageableTeams(teams, managers, profile).orgWide };
  }, [profile.employeeId]);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [busyPack, setBusyPack] = useState<RulePack | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  if (loading && !data) return <Loading />;
  if (!data) return <Screen><ErrorBanner message={error ?? 'Could not load alert rules.'} onRetry={refresh} /></Screen>;

  async function addPack(pack: RulePack, title: string) {
    setActionError(null);
    setBusyPack(pack);
    try {
      const added = await api.addAlertRulePack(pack);
      notify(added ? `${added} rule${added === 1 ? '' : 's'} added` : 'Nothing to add',
        added ? undefined : `All of "${title}" is already in your rules.`);
      reload();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusyPack(null);
    }
  }

  async function toggle(rule: AlertRule) {
    setActionError(null);
    try {
      await api.saveAlertRule({ ...rule, enabled: !rule.enabled });
      reload();
    } catch (e) {
      setActionError(errorMessage(e));
    }
  }

  async function remove(rule: AlertRule) {
    if (!(await confirmAction(`Delete the rule "${rule.name}"?`, 'Alerts it already raised are removed too.', 'Delete'))) return;
    setActionError(null);
    try {
      await api.deleteAlertRule(rule.id);
      reload();
    } catch (e) {
      setActionError(errorMessage(e));
    }
  }

  const editable = data.allowed && data.canEdit;

  return (
    <Screen>
      <Card title="Alert rules">
        <Text style={styles.hint}>
          Raise an alert when someone uses a website or program you name, for example file-sharing sites or personal
          email. Rules are checked against the activity the desktop app already records, so they need Websites and
          Applications switched on under Monitoring & privacy. An alert shows that a site was visited or a program used,
          not what was done there. Alerts appear under Alerts and in Slack/Teams if connected.
        </Text>
        {!data.allowed ? (
          <Text style={[styles.hint, { color: colors.danger }]}>Alert rules are not included in your plan. Contact Mycroscope to upgrade.</Text>
        ) : !data.canEdit ? (
          <Text style={styles.hint}>Only the owner and managers who are not limited to teams can change rules.</Text>
        ) : null}
      </Card>
      {actionError ? <ErrorBanner message={actionError} /> : null}

      {editable ? (
        <Card title="Suggested rules">
          {PACKS.map((p) => (
            <View key={p.pack} style={[styles.row, { justifyContent: 'space-between', paddingVertical: 6, gap: 8 }]}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.rowText, { fontWeight: '600' }]}>{p.title}</Text>
                <Text style={styles.hint}>{p.hint}</Text>
              </View>
              <Button small variant="secondary" title="Add" loading={busyPack === p.pack} onPress={() => addPack(p.pack, p.title)} />
            </View>
          ))}
        </Card>
      ) : null}

      <Card title={`${data.rules.length} rule${data.rules.length === 1 ? '' : 's'}`}
        right={editable && !editing ? (
          <Text style={{ color: colors.primary, fontWeight: '600' }} onPress={() => setEditing(EMPTY)}>Add rule</Text>
        ) : undefined}>
        {editing && editing.id === null ? (
          <RuleEditor initial={editing} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />
        ) : null}
        {data.rules.length === 0 && !editing ? <Empty text="No rules yet. Add the suggested rules above to get started." /> : null}
        {data.rules.map((r) => (
          <View key={r.id} style={{ paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#f3f4f6', gap: 4 }}>
            <View style={[styles.row, { justifyContent: 'space-between', gap: 8 }]}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.rowText, { fontWeight: '600', opacity: r.enabled ? 1 : 0.5 }]}>{r.name}</Text>
                <Text style={styles.hint}>
                  {r.kind === 'domain' ? 'Website' : 'Program'}: {r.pattern}
                  {r.work_hours_only ? ' · working hours only' : ''}{r.enabled ? '' : ' · off'}
                </Text>
              </View>
              <Pill text={r.severity} color={severityColor[r.severity]} />
            </View>
            {editable ? (
              <View style={[styles.row, { gap: 16 }]}>
                <Pressable hitSlop={8} onPress={() => setEditing(editing?.id === r.id ? null : { ...r })}>
                  <Text style={{ color: colors.primary, fontWeight: '600' }}>{editing?.id === r.id ? 'Close' : 'Change'}</Text>
                </Pressable>
                <Pressable hitSlop={8} onPress={() => toggle(r)}>
                  <Text style={{ color: colors.primary, fontWeight: '600' }}>{r.enabled ? 'Switch off' : 'Switch on'}</Text>
                </Pressable>
                <Pressable hitSlop={8} onPress={() => remove(r)}>
                  <Text style={{ color: colors.danger, fontWeight: '600' }}>Delete</Text>
                </Pressable>
              </View>
            ) : null}
            {editing?.id === r.id ? (
              <RuleEditor initial={editing} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />
            ) : null}
          </View>
        ))}
      </Card>
    </Screen>
  );
}

function RuleEditor({ initial, onSaved, onCancel }: { initial: Draft; onSaved: () => void; onCancel: () => void }) {
  const [draft, setDraft] = useState<Draft>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  async function save() {
    setError(null);
    if (!draft.name.trim()) return setError('Give the rule a name.');
    if (!draft.pattern.trim()) return setError(draft.kind === 'domain' ? 'Enter a website, e.g. wetransfer.com.' : 'Enter a program, e.g. fsquirt.exe.');
    setBusy(true);
    try {
      await api.saveAlertRule({ ...draft, name: draft.name.trim(), pattern: draft.pattern.trim() });
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: 8, paddingVertical: 8 }}>
      {error ? <ErrorBanner message={error} /> : null}
      <Field label="Name" value={draft.name} onChangeText={(v) => set('name', v)} maxLength={100} placeholder="e.g. WeTransfer" />
      <Segmented options={[{ value: 'domain', label: 'Website' }, { value: 'app', label: 'Program' }]}
        value={draft.kind} onChange={(v) => set('kind', v)} />
      <Field label={draft.kind === 'domain' ? 'Website' : 'Program'} value={draft.pattern} onChangeText={(v) => set('pattern', v)}
        autoCapitalize="none" autoCorrect={false} maxLength={200}
        placeholder={draft.kind === 'domain' ? 'wetransfer.com' : 'fsquirt.exe'}
        hint={draft.kind === 'domain'
          ? 'Also matches its subdomains (mail.example.com). Use * as a wildcard.'
          : 'The application name or program file, e.g. "Telegram" or telegram.exe. Use * as a wildcard.'} />
      <Text style={styles.label}>Severity</Text>
      <Segmented options={SEVERITIES} value={draft.severity} onChange={(v) => set('severity', v)} />
      <ToggleRow label="Only during working hours" value={draft.work_hours_only} onChange={(v) => set('work_hours_only', v)} />
      <View style={[styles.row, { gap: 8 }]}>
        <Button small title="Save rule" onPress={save} loading={busy} />
        <Button small variant="ghost" title="Cancel" onPress={onCancel} />
      </View>
    </View>
  );
}
