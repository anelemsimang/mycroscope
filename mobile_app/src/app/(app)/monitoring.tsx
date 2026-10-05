import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import {
  Button, Card, ErrorBanner, Field, Loading, Screen, Segmented, ToggleRow, colors, styles,
} from '@/components/ui';
import { api, errorMessage, type ComplianceSettings } from '@/lib/api';
import { confirmAction, notify } from '@/lib/dialog';
import { formatDateTime } from '@/lib/format';
import { useProfile, useSession } from '@/lib/session';
import { useAsync } from '@/lib/useAsync';

type Draft = Omit<ComplianceSettings, 'updated_at'>;

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const hhmm = (t: string) => (t ?? '').slice(0, 5);
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
  const { aal, reloadService } = useSession();
  const isOwner = profile.role === 'owner';
  const [draft, setDraft] = useState<Draft>(() => {
    const { updated_at: _, ...rest } = initial;
    return { ...rest, work_start: hhmm(rest.work_start), work_end: hhmm(rest.work_end) };
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
    if (draft.tracking_schedule === 'work_hours') {
      if (draft.work_days.length === 0) return setError('Choose at least one working day.');
      if (!TIME.test(draft.work_start) || !TIME.test(draft.work_end)) return setError('Enter working hours as HH:MM, e.g. 08:00.');
      if (draft.work_start === draft.work_end) return setError('Working hours must start and end at different times.');
    }
    if (draft.require_mfa && !initial.require_mfa && aal.next !== 'aal2') {
      return setError('Set up two-factor login for your own account first (Settings), or you would lock yourself out of employee data.');
    }
    const next: Draft = { ...draft, retention_days: detail, summary_retention_days: summary };

    const initialDraft: Draft = { ...initial, work_start: hhmm(initial.work_start), work_end: hhmm(initial.work_end) };
    const changed = (Object.keys(next) as (keyof Draft)[])
      .filter((k) => JSON.stringify(next[k] ?? '') !== JSON.stringify(initialDraft[k] ?? ''));
    if (changed.length === 0) return notify('No changes to save');

    const warnings: string[] = [];
    if (changed.some((k) => k !== 'require_mfa')) {
      warnings.push('Employees will see the updated monitoring notice in the desktop app within about 5 minutes and must acknowledge it.');
    }
    if (changed.includes('require_mfa')) {
      warnings.push(next.require_mfa
        ? 'Managers without two-factor login will not see employee data until they set it up.'
        : 'Managers will be able to see employee data with a password only.');
    }
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
      reloadService();
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

      <Card title="When monitoring happens">
        <Segmented options={[{ value: 'always', label: 'Whenever signed in' }, { value: 'work_hours', label: 'Working hours only' }]}
          value={draft.tracking_schedule} onChange={(v) => set('tracking_schedule', v)} />
        {draft.tracking_schedule === 'work_hours' ? (
          <>
            <Text style={styles.label}>Working days</Text>
            <View style={styles.segmented}>
              {DAYS.map((d, i) => {
                const iso = i + 1;
                const on = draft.work_days.includes(iso);
                return (
                  <Pressable key={d} accessibilityRole="checkbox" accessibilityState={{ checked: on }}
                    onPress={() => set('work_days', on ? draft.work_days.filter((x) => x !== iso) : [...draft.work_days, iso].sort())}
                    style={[styles.segment, on && styles.segmentActive]}>
                    <Text style={[styles.segmentText, on && { color: '#fff' }]}>{d}</Text>
                  </Pressable>
                );
              })}
            </View>
            <View style={[styles.row, { gap: 8 }]}>
              <View style={{ flex: 1 }}>
                <Field label="From" value={draft.work_start} onChangeText={(v) => set('work_start', v.trim())} placeholder="08:00" maxLength={5} />
              </View>
              <View style={{ flex: 1 }}>
                <Field label="To" value={draft.work_end} onChangeText={(v) => set('work_end', v.trim())} placeholder="17:00" maxLength={5} />
              </View>
            </View>
            <Text style={styles.hint}>
              In {profile.timezone}. An end before the start means a night shift (e.g. 22:00 to 06:00). Outside these hours the
              desktop app records nothing.
            </Text>
            <ToggleRow label="Note when the PC is used outside working hours" value={draft.flag_after_hours_use}
              onChange={(v) => set('flag_after_hours_use', v)}
              hint="Only that the PC was in use (at most once an hour), never what it was used for." />
          </>
        ) : (
          <Text style={styles.hint}>The desktop app records whenever the employee is signed in to it.</Text>
        )}
      </Card>

      <Card title="Integrity checks">
        <ToggleRow label="Detect attempts to avoid monitoring" value={draft.detect_tampering}
          onChange={(v) => set('detect_tampering', v)}
          hint="Flags when the app is stopped while the PC stays on, runs in a virtual machine or remote session, or input comes in a machine-regular rhythm (mouse jigglers). Results appear under Alerts; employees are told in the notice." />
      </Card>

      <Card title="Account security">
        <ToggleRow label="Require two-factor login for managers" value={draft.require_mfa} disabled={!isOwner}
          onChange={(v) => set('require_mfa', v)}
          hint={isOwner ? 'Owners and managers must enter a code from an authenticator app to see employee data. Recommended.'
            : 'Only the owner can change this.'} />
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
