import { router } from 'expo-router';
import { useState } from 'react';
import { Text } from 'react-native';

import {
  Button, Card, ErrorBanner, Field, Loading, Screen, Segmented, ToggleRow, colors, styles,
} from '@/components/ui';
import { api, errorMessage, type ComplianceSettings } from '@/lib/api';
import { confirmAction, notify } from '@/lib/dialog';
import { formatDateTime } from '@/lib/format';
import { useProfile } from '@/lib/session';
import { useAsync } from '@/lib/useAsync';

type Draft = Omit<ComplianceSettings, 'updated_at'>;

const IDLE_MINUTES = [1, 2, 3, 5, 10, 15, 30, 60];
const LIMITS = { retention_days: [7, 1825], summary_retention_days: [30, 3650] } as const;

export default function Monitoring() {
  const profile = useProfile();
  const { data, error, loading, refresh } = useAsync(async () => {
    const [settings, policies] = await Promise.all([api.complianceSettings(profile.organizationId), api.policies()]);
    return { settings, current: policies[0] ?? null };
  }, [profile.organizationId]);

  if (loading && !data) return <Loading />;
  if (!data) return <Screen><ErrorBanner message={error ?? 'Could not load settings.'} onRetry={refresh} /></Screen>;
  return <MonitoringForm key={data.settings.updated_at} initial={data.settings} current={data.current} onSaved={refresh} />;
}

function MonitoringForm({ initial, current, onSaved }: {
  initial: ComplianceSettings; current: { version: number; notice_text: string; published_at: string } | null;
  onSaved: () => void;
}) {
  const profile = useProfile();
  const [draft, setDraft] = useState<Draft>(() => {
    const { updated_at: _, ...rest } = initial;
    return rest;
  });
  const [retention, setRetention] = useState(String(initial.retention_days));
  const [summaryRetention, setSummaryRetention] = useState(String(initial.summary_retention_days));
  const [showNotice, setShowNotice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const idleOptions = [...new Set([...IDLE_MINUTES, initial.idle_threshold_seconds / 60])]
    .sort((a, b) => a - b)
    .map((m) => ({ value: String(m), label: Number.isInteger(m) ? `${m} min` : `${Math.round(m * 60)} s` }));

  function parseDays(text: string, key: keyof typeof LIMITS, label: string): number | string {
    const n = Number(text.trim());
    const [min, max] = LIMITS[key];
    if (!Number.isInteger(n) || n < min || n > max) return `${label} must be a whole number of days from ${min} to ${max}.`;
    return n;
  }

  async function save() {
    setError(null);
    const detail = parseDays(retention, 'retention_days', 'Detailed activity retention');
    if (typeof detail === 'string') return setError(detail);
    const summary = parseDays(summaryRetention, 'summary_retention_days', 'Daily totals retention');
    if (typeof summary === 'string') return setError(summary);
    if ((draft.notice_custom_text ?? '').length > 4000) return setError('The message to employees is limited to 4000 characters.');
    const next: Draft = { ...draft, retention_days: detail, summary_retention_days: summary };

    const changed = (Object.keys(next) as (keyof Draft)[])
      .filter((k) => (next[k] ?? '') !== (initial[k] ?? ''));
    if (changed.length === 0) return notify('No changes to save');

    const warnings = ['Employees will see the updated monitoring notice in the desktop app within about 5 minutes and must acknowledge it.'];
    if (detail < initial.retention_days) {
      warnings.push(`Detailed activity older than ${detail} days will be permanently deleted at the next nightly clean-up.`);
    }
    if (summary < initial.summary_retention_days) {
      warnings.push(`Daily totals older than ${summary} days will be permanently deleted at the next nightly clean-up.`);
    }
    if (!(await confirmAction('Save and publish?', warnings.join('\n\n'), 'Save and publish'))) return;

    setBusy(true);
    try {
      const policy = await api.saveComplianceSettings(next);
      notify('Saved', policy && policy.version !== current?.version
        ? `Monitoring notice version ${policy.version} published.`
        : 'Settings saved. The monitoring notice is unchanged.');
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Card title="Monitoring & privacy">
        <Text style={styles.hint}>
          These settings decide what the desktop app records for everyone in {profile.organizationName}. The monitoring
          notice employees acknowledge is generated from them, so every change publishes a new notice version.
        </Text>
        {current ? (
          <Text style={styles.hint}>Current notice: version {current.version}, published {formatDateTime(current.published_at, profile.timezone)}.</Text>
        ) : null}
      </Card>

      {error ? <ErrorBanner message={error} /> : null}

      <Card title="What is recorded">
        <ToggleRow label="Applications" value={draft.track_apps} onChange={(v) => set('track_apps', v)}
          hint="Name of the program in use, e.g. Microsoft Excel." />
        <ToggleRow label="Window titles" value={draft.track_window_titles} onChange={(v) => set('track_window_titles', v)}
          hint="Can contain document names, email subjects or chat names." />
        <ToggleRow label="Websites" value={draft.track_web_domains}
          onChange={(v) => setDraft((d) => ({ ...d, track_web_domains: v, track_full_urls: v ? d.track_full_urls : false }))}
          hint="Domain names such as example.com." />
        <ToggleRow label="Full web addresses" value={draft.track_full_urls} disabled={!draft.track_web_domains}
          onChange={(v) => set('track_full_urls', v)}
          hint={draft.track_web_domains ? 'Full page addresses, which can include search terms.' : 'Turn on Websites first.'} />
        <Text style={styles.hint}>Keystrokes, screenshots, webcam, microphone and file contents are never recorded.</Text>
      </Card>

      <Card title="Idle and pause">
        <Text style={styles.label}>Count as idle after no keyboard or mouse input for</Text>
        <Segmented options={idleOptions} value={String(draft.idle_threshold_seconds / 60)}
          onChange={(v) => set('idle_threshold_seconds', Math.round(Number(v) * 60))} />
        <ToggleRow label="Employees may pause monitoring" value={draft.allow_pause} onChange={(v) => set('allow_pause', v)}
          hint="Pauses are recorded and visible to managers." />
      </Card>

      <Card title="Retention">
        <Field label="Keep detailed activity for (days)" value={retention} onChangeText={setRetention}
          keyboardType="number-pad" hint="7 to 1825. Apps, websites and timelines older than this are deleted nightly." />
        <Field label="Keep daily totals for (days)" value={summaryRetention} onChangeText={setSummaryRetention}
          keyboardType="number-pad" hint="30 to 3650. Daily active/idle totals older than this are deleted nightly." />
      </Card>

      <Card title="Information Officer">
        <Text style={styles.hint}>Named in the notice as the contact for POPIA access, correction and objection requests.</Text>
        <Field label="Name" value={draft.information_officer_name ?? ''}
          onChangeText={(v) => set('information_officer_name', v)} autoCapitalize="words" />
        <Field label="Email" value={draft.information_officer_email ?? ''}
          onChangeText={(v) => set('information_officer_email', v)} autoCapitalize="none" keyboardType="email-address" />
      </Card>

      <Card title="Message to employees">
        <Field label="Shown at the top of the notice (optional)" value={draft.notice_custom_text ?? ''}
          onChangeText={(v) => set('notice_custom_text', v)} multiline
          style={{ minHeight: 90, textAlignVertical: 'top' }}
          hint={`${(draft.notice_custom_text ?? '').length}/4000`} />
      </Card>

      <Button title="Save and publish" onPress={save} loading={busy} />

      {current ? (
        <Card title={`Current notice (version ${current.version})`}
          right={<Text style={{ color: colors.primary, fontWeight: '600' }} onPress={() => setShowNotice((s) => !s)}>
            {showNotice ? 'Hide' : 'Show'}
          </Text>}>
          {showNotice ? <Text style={styles.rowText} selectable>{current.notice_text}</Text> : null}
          <Button title="Notice history" variant="ghost" small onPress={() => router.push('/notice-history')} />
        </Card>
      ) : null}
    </Screen>
  );
}
