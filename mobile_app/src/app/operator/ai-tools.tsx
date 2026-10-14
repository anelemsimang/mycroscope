import { useState } from 'react';
import { Text, View } from 'react-native';

import { Button, Card, Empty, ErrorBanner, Field, Loading, Screen, ToggleRow, styles } from '@/components/ui';
import { errorMessage, operatorApi, type OperatorAiTool } from '@/lib/api';
import { confirmAction, notify } from '@/lib/dialog';
import { useAsync } from '@/lib/useAsync';

const split = (value: string) => value.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);

export default function OperatorAiTools() {
  const { data, error, loading, refreshing, refresh } = useAsync(() => operatorApi.aiTools(), []);
  const [editing, setEditing] = useState<OperatorAiTool | null>(null);
  const [name, setName] = useState('');
  const [domains, setDomains] = useState('');
  const [apps, setApps] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function edit(tool: OperatorAiTool | null) {
    setEditing(tool);
    setName(tool?.name ?? '');
    setDomains(tool?.domains.join(', ') ?? '');
    setApps(tool?.app_names.join(', ') ?? '');
    setEnabled(tool?.enabled ?? true);
    setErr(null);
  }

  async function save() {
    setErr(null);
    if (!name.trim()) return setErr('Give the tool a name.');
    if (split(domains).length === 0 && split(apps).length === 0) return setErr('Add a website or an app name.');
    setBusy(true);
    try {
      await operatorApi.saveAiTool(editing?.id ?? null, name.trim(), split(domains), split(apps), enabled);
      edit(null);
      notify('AI tool saved', 'Companies on Business and up can mark it approved or not approved.');
      refresh();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(tool: OperatorAiTool) {
    if (!(await confirmAction(`Remove ${tool.name}?`, 'Companies lose this tool from their reports and approvals.', 'Remove'))) return;
    try {
      await operatorApi.deleteAiTool(tool.id);
      if (editing?.id === tool.id) edit(null);
      refresh();
    } catch (e) {
      notify('Could not remove', errorMessage(e));
    }
  }

  if (loading && !data) return <Loading />;
  return (
    <Screen refreshing={refreshing} onRefresh={refresh}>
      {error ? <ErrorBanner message={error} onRetry={refresh} /> : null}
      <Card title={editing ? `Edit ${editing.name}` : 'Add an AI tool'}>
        <Text style={styles.hint}>
          This list is shared by every company. Match a website (claude.ai also matches a.claude.ai) or the exact app
          name Windows reports. Companies decide whether each tool is approved.
        </Text>
        <Field label="Name" value={name} onChangeText={setName} maxLength={60} />
        <Field label="Websites" value={domains} onChangeText={setDomains} placeholder="claude.ai, chatgpt.com" autoCapitalize="none" />
        <Field label="App names" value={apps} onChangeText={setApps} placeholder="ChatGPT" autoCapitalize="none" />
        <ToggleRow label="Shown to companies" value={enabled} onChange={setEnabled} />
        {err ? <ErrorBanner message={err} /> : null}
        <Button title={editing ? 'Save changes' : 'Add tool'} onPress={save} loading={busy} />
        {editing ? <Button title="Cancel edit" variant="ghost" onPress={() => edit(null)} /> : null}
      </Card>
      <Card title={`Tools (${data?.length ?? 0})`}>
        {(data ?? []).length === 0 ? <Empty text="No tools yet." /> : null}
        {(data ?? []).map((tool) => (
          <View key={tool.id} style={{ paddingVertical: 8, gap: 2 }}>
            <Text style={styles.rowText}>{tool.name}{tool.enabled ? '' : ' · hidden'}</Text>
            <Text style={styles.hint}>{[...tool.domains, ...tool.app_names].join(', ')}</Text>
            <View style={{ flexDirection: 'row', gap: 16 }}>
              <Text style={{ color: '#1d4ed8', fontWeight: '600' }} onPress={() => edit(tool)}>Edit</Text>
              <Text style={{ color: '#b91c1c', fontWeight: '600' }} onPress={() => remove(tool)}>Remove</Text>
            </View>
          </View>
        ))}
      </Card>
    </Screen>
  );
}
