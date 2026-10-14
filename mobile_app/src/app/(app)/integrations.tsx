import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Button, Card, Empty, ErrorBanner, Field, Loading, Pill, Screen, Segmented, colors, styles } from '@/components/ui';
import {
  api, errorMessage, type ApiKey, type ChannelKind, type NotificationChannel, type Severity,
} from '@/lib/api';
import { confirmAction, notify } from '@/lib/dialog';
import { formatDateTime } from '@/lib/format';
import { manageableTeams } from '@/lib/scope';
import { useProfile } from '@/lib/session';
import { apiBaseUrl } from '@/lib/supabase';
import { useAsync } from '@/lib/useAsync';

const KINDS: { value: ChannelKind; label: string }[] = [
  { value: 'slack', label: 'Slack' }, { value: 'teams', label: 'Microsoft Teams' }, { value: 'webhook', label: 'Webhook' },
];
const KIND_LABEL: Record<ChannelKind, string> = { slack: 'Slack', teams: 'Teams', webhook: 'Webhook' };
const URL_HINT: Record<ChannelKind, string> = {
  slack: 'In Slack: Apps › Incoming Webhooks › Add to a channel. Starts with https://hooks.slack.com/',
  teams: 'In Teams: the channel › Workflows › "Post to a channel when a webhook request is received". Copy the address it gives you.',
  webhook: 'Any public https address. Each message is signed so your system can check it came from Mycroscope.',
};
const SEVERITY_OPTIONS: { value: Severity; label: string }[] = [
  { value: 'low', label: 'Everything' }, { value: 'medium', label: 'Medium and high' }, { value: 'high', label: 'High only' },
];

/** A secret shown once, straight after it was created. */
interface Revealed { title: string; value: string; hint: string }

export default function Integrations() {
  const profile = useProfile();
  const { data, error, loading, refresh, reload } = useAsync(async () => {
    const [features, { teams, managers }] = await Promise.all([api.features(), api.teams()]);
    const orgWide = manageableTeams(teams, managers, profile).orgWide;
    const [channels, keys] = orgWide
      ? await Promise.all([api.channels(), api.apiKeys()])
      : [[] as NotificationChannel[], [] as ApiKey[]];
    return { channels, keys, orgWide, channelsAllowed: features.includes('channels'), apiAllowed: features.includes('api') };
  }, [profile.employeeId]);
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [adding, setAdding] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  if (loading && !data) return <Loading />;
  if (!data) return <Screen><ErrorBanner message={error ?? 'Could not load integrations.'} onRetry={refresh} /></Screen>;
  if (!data.orgWide) {
    return (
      <Screen>
        <Card title="Slack, Teams & API">
          <Text style={styles.hint}>Only the owner and managers who are not limited to teams can manage integrations.</Text>
        </Card>
      </Screen>
    );
  }

  async function run(action: () => Promise<unknown>) {
    setActionError(null);
    try {
      await action();
      reload();
    } catch (e) {
      setActionError(errorMessage(e));
    }
  }

  async function test(c: NotificationChannel) {
    setActionError(null);
    setTesting(c.id);
    try {
      await api.testChannel(c.id);
      notify('Test sent', `Check ${c.name} for the message.`);
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setTesting(null);
      reload();
    }
  }

  async function removeChannel(c: NotificationChannel) {
    if (!(await confirmAction(`Remove "${c.name}"?`, 'Alerts will no longer be sent there.', 'Remove'))) return;
    run(() => api.deleteChannel(c.id));
  }

  async function revokeKey(k: ApiKey) {
    if (!(await confirmAction(`Revoke "${k.name}"?`, 'Anything using this key stops working straight away.', 'Revoke'))) return;
    run(() => api.revokeApiKey(k.id));
  }

  return (
    <Screen>
      {actionError ? <ErrorBanner message={actionError} /> : null}
      {revealed ? (
        <Card title={revealed.title}>
          <Text style={styles.hint}>{revealed.hint}</Text>
          <Text selectable style={{ fontSize: 15, fontWeight: '700', marginVertical: 10, color: '#1e3a8a', fontFamily: 'monospace' }}>
            {revealed.value}
          </Text>
          <Text style={[styles.hint, { color: colors.danger }]}>
            This is shown only once. Tap and hold to copy it now; Mycroscope cannot show it again.
          </Text>
          <Button small variant="secondary" title="I have copied it" onPress={() => setRevealed(null)} />
        </Card>
      ) : null}

      <Card title="Slack, Teams and webhooks"
        right={data.channelsAllowed && !adding ? (
          <Text style={{ color: colors.primary, fontWeight: '600' }} onPress={() => setAdding(true)}>Add</Text>
        ) : undefined}>
        <Text style={styles.hint}>
          New alerts are posted once an hour, together with the alert emails. Messages contain the employee's name, the kind of alert and
          counts, never file names or window titles. Saved addresses cannot be viewed again, only replaced.
        </Text>
        {!data.channelsAllowed ? (
          <Text style={[styles.hint, { color: colors.danger }]}>Slack and Teams alerts are not included in your plan. Contact Mycroscope to upgrade.</Text>
        ) : null}
        {adding ? (
          <ChannelEditor onCancel={() => setAdding(false)} onAdded={(secret) => {
            setAdding(false);
            if (secret) {
              setRevealed({
                title: 'Webhook signing secret', value: secret,
                hint: 'Each request carries an X-Mycroscope-Signature header: t=<unix time>,v1=<HMAC-SHA256 of "t.body" with this secret, in hex>. Reject requests whose signature does not match or whose time is more than 5 minutes old.',
              });
            }
            reload();
          }} />
        ) : null}
        {data.channels.length === 0 && !adding ? <Empty text="No channels yet." /> : null}
        {data.channels.map((c) => (
          <View key={c.id} style={{ paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#f3f4f6', gap: 4 }}>
            <View style={[styles.row, { justifyContent: 'space-between', gap: 8 }]}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.rowText, { fontWeight: '600', opacity: c.enabled ? 1 : 0.5 }]}>{c.name}</Text>
                <Text style={styles.hint}>{c.url_hint} · {SEVERITY_OPTIONS.find((s) => s.value === c.min_severity)?.label}</Text>
              </View>
              <Pill text={c.enabled ? KIND_LABEL[c.kind] : 'Off'} color={c.enabled ? colors.primary : colors.muted} />
            </View>
            {c.last_error ? (
              <Text style={[styles.hint, { color: colors.danger }]}>
                Last attempt failed{c.last_error_at ? ` (${formatDateTime(c.last_error_at, profile.timezone)})` : ''}: {c.last_error}
              </Text>
            ) : c.last_sent_at ? (
              <Text style={styles.hint}>Last delivered {formatDateTime(c.last_sent_at, profile.timezone)}</Text>
            ) : null}
            <View style={[styles.row, { gap: 16, flexWrap: 'wrap' }]}>
              <Pressable hitSlop={8} disabled={testing === c.id} onPress={() => test(c)}>
                <Text style={{ color: colors.primary, fontWeight: '600' }}>{testing === c.id ? 'Sending…' : 'Send test'}</Text>
              </Pressable>
              <Pressable hitSlop={8} onPress={() => run(() => api.updateChannel(c.id, c.name, c.min_severity, !c.enabled))}>
                <Text style={{ color: colors.primary, fontWeight: '600' }}>{c.enabled ? 'Pause' : 'Resume'}</Text>
              </Pressable>
              {SEVERITY_OPTIONS.filter((s) => s.value !== c.min_severity).map((s) => (
                <Pressable key={s.value} hitSlop={8} onPress={() => run(() => api.updateChannel(c.id, c.name, s.value, c.enabled))}>
                  <Text style={{ color: colors.muted }}>{s.label}</Text>
                </Pressable>
              ))}
              <Pressable hitSlop={8} onPress={() => removeChannel(c)}>
                <Text style={{ color: colors.danger, fontWeight: '600' }}>Remove</Text>
              </Pressable>
            </View>
          </View>
        ))}
      </Card>

      <Card title="Read-only API">
        <Text style={styles.hint}>
          Lets your own systems (Power BI, payroll, HR) read employees, daily totals, app and website usage, and alerts.
          Keys can only read, never change anything, and cannot see file names or window titles.
        </Text>
        {!data.apiAllowed ? (
          <Text style={[styles.hint, { color: colors.danger }]}>The API is not included in your plan. Contact Mycroscope to upgrade.</Text>
        ) : (
          <>
            <Text style={styles.label}>Address</Text>
            <Text selectable style={[styles.rowText, { fontFamily: 'monospace' }]}>{apiBaseUrl}</Text>
            <Text selectable style={styles.hint}>
              GET /employees · /daily-totals?from=YYYY-MM-DD&to=YYYY-MM-DD · /usage?from=…&to=… (at most 93 days) ·
              /alerts?since=ISO time. Send the key in an X-Api-Key header.
            </Text>
            <NewKey onCreated={(key) => {
              setRevealed({ title: 'New API key', value: key, hint: 'Store it in your system\'s secret settings, not in a spreadsheet or email.' });
              reload();
            }} />
          </>
        )}
        {data.keys.length === 0 ? <Empty text="No API keys yet." /> : null}
        {data.keys.map((k) => (
          <View key={k.id} style={[styles.row, { justifyContent: 'space-between', paddingVertical: 8, gap: 8,
            borderBottomWidth: 1, borderBottomColor: '#f3f4f6' }]}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.rowText, { fontWeight: '600', opacity: k.revoked_at ? 0.5 : 1 }]}>{k.name}</Text>
              <Text style={styles.hint}>
                {k.key_prefix}… · created {formatDateTime(k.created_at, profile.timezone)}{k.created_by_name ? ` by ${k.created_by_name}` : ''}
                {k.revoked_at ? ` · revoked ${formatDateTime(k.revoked_at, profile.timezone)}`
                  : k.last_used_at ? ` · last used ${formatDateTime(k.last_used_at, profile.timezone)}` : ' · never used'}
              </Text>
            </View>
            {k.revoked_at ? null : (
              <Pressable hitSlop={8} onPress={() => revokeKey(k)}>
                <Text style={{ color: colors.danger, fontWeight: '600' }}>Revoke</Text>
              </Pressable>
            )}
          </View>
        ))}
      </Card>
    </Screen>
  );
}

function ChannelEditor({ onAdded, onCancel }: { onAdded: (secret: string | null) => void; onCancel: () => void }) {
  const [kind, setKind] = useState<ChannelKind>('slack');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [severity, setSeverity] = useState<Severity>('medium');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    if (!name.trim()) return setError('Give the channel a name, e.g. "#security".');
    if (!/^https:\/\//i.test(url.trim())) return setError('Paste the full address, starting with https://');
    setBusy(true);
    try {
      const created = await api.addChannel(kind, name.trim(), url.trim(), severity);
      onAdded(created?.signing_secret ?? null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: 8, paddingVertical: 8 }}>
      {error ? <ErrorBanner message={error} /> : null}
      <Segmented options={KINDS} value={kind} onChange={setKind} />
      <Field label="Name" value={name} onChangeText={setName} maxLength={100} placeholder="#security" />
      <Field label="Webhook address" value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false}
        secureTextEntry hint={URL_HINT[kind]} />
      <Text style={styles.label}>Send</Text>
      <Segmented options={SEVERITY_OPTIONS} value={severity} onChange={setSeverity} />
      <View style={[styles.row, { gap: 8 }]}>
        <Button small title="Save channel" onPress={save} loading={busy} />
        <Button small variant="ghost" title="Cancel" onPress={onCancel} />
      </View>
      <Text style={styles.hint}>After saving, use "Send test" to check it arrives.</Text>
    </View>
  );
}

function NewKey({ onCreated }: { onCreated: (key: string) => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setError(null);
    if (!name.trim()) return setError('Name the key after what will use it, e.g. "Power BI".');
    setBusy(true);
    try {
      const created = await api.createApiKey(name.trim());
      setName('');
      onCreated(created.api_key);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: 8, paddingVertical: 8 }}>
      {error ? <ErrorBanner message={error} /> : null}
      <Field label="New key for" value={name} onChangeText={setName} maxLength={100} placeholder="Power BI" />
      <Button small variant="secondary" title="Create API key" onPress={create} loading={busy} />
    </View>
  );
}
