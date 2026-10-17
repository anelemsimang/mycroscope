import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import {
  Button, Card, Empty, ErrorBanner, Field, Loading, Screen, Segmented, ToggleRow, colors, styles,
} from '@/components/ui';
import { api, errorMessage, type ComplianceSettings, type OfficeNetwork, type OfflineReason } from '@/lib/api';
import { confirmAction, notify } from '@/lib/dialog';
import { formatDateTime } from '@/lib/format';
import { manageableTeams } from '@/lib/scope';
import { useProfile, useSession } from '@/lib/session';
import { useAsync } from '@/lib/useAsync';

type Draft = Omit<ComplianceSettings, 'updated_at'>;

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const hhmm = (t: string) => (t ?? '').slice(0, 5);
const IDLE_MINUTES = [1, 2, 3, 5, 10, 15, 30, 60];
const LIMITS = { retention_days: [7, 1825], summary_retention_days: [30, 3650], file_retention_days: [7, 365] } as const;
const OFFLINE_REASONS: { id: OfflineReason; label: string; hint: string }[] = [
  { id: 'meeting', label: 'Meetings', hint: 'Added to productive time.' },
  { id: 'call', label: 'Calls', hint: 'Added to productive time, the same way as meetings.' },
  { id: 'break', label: 'Breaks', hint: 'Shown on its own. Left out of productive time unless you turn this on.' },
  { id: 'other', label: 'Other', hint: 'Anything else the employee types a note for. Left out of productive time unless you turn this on.' },
];

export default function Monitoring() {
  const profile = useProfile();
  const { data, error, loading, refresh } = useAsync(async () => {
    const [settings, policies, features, { teams, managers }] = await Promise.all([
      api.complianceSettings(profile.organizationId), api.policies(), api.features(), api.teams(),
    ]);
    return {
      settings, current: policies[0] ?? null,
      fileActivity: features.includes('file_activity'),
      workLocation: features.includes('work_location_insights'),
      aiTools: features.includes('ai_tools'),
      advisor: features.includes('coaching'),
      orgWide: manageableTeams(teams, managers, profile).orgWide,
    };
  }, [profile.organizationId]);

  if (loading && !data) return <Loading />;
  if (!data) return <Screen><ErrorBanner message={error ?? 'Could not load settings.'} onRetry={refresh} /></Screen>;
  return <MonitoringForm key={data.settings.updated_at} initial={data.settings} current={data.current}
    fileActivityAllowed={data.fileActivity} workLocationAllowed={data.workLocation}
    aiToolsAllowed={data.aiTools} advisorAllowed={data.advisor} orgWide={data.orgWide} onSaved={refresh} />;
}

function MonitoringForm({ initial, current, fileActivityAllowed, workLocationAllowed, aiToolsAllowed, advisorAllowed, orgWide, onSaved }: {
  initial: ComplianceSettings; current: { version: number; notice_text: string; published_at: string } | null;
  fileActivityAllowed: boolean; workLocationAllowed: boolean; aiToolsAllowed: boolean; advisorAllowed: boolean;
  orgWide: boolean; onSaved: () => void;
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
  const [fileRetention, setFileRetention] = useState(String(initial.file_retention_days));
  const [offlineMinutes, setOfflineMinutes] = useState(String(initial.offline_prompt_minutes));
  const [officeDays, setOfficeDays] = useState(initial.office_days_per_week == null ? '' : String(initial.office_days_per_week));
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
    const files = parseDays(fileRetention, 'file_retention_days', 'File activity retention');
    if (typeof files === 'string') return setError(files);
    const askedAfter = Number(offlineMinutes.trim());
    if (!Number.isInteger(askedAfter) || askedAfter < 1 || askedAfter > 120) {
      return setError('Ask after a whole number of minutes from 1 to 120.');
    }
    const officeTarget = officeDays.trim() === '' ? null : Number(officeDays.trim());
    if (officeTarget !== null && (!Number.isInteger(officeTarget) || officeTarget < 1 || officeTarget > 7)) {
      return setError('Office days per week must be a whole number from 1 to 7, or empty when there is no target.');
    }
    if ((draft.notice_custom_text ?? '').length > 4000) return setError('The message to employees is limited to 4000 characters.');
    if (draft.tracking_schedule === 'work_hours') {
      if (draft.work_days.length === 0) return setError('Choose at least one working day.');
      if (!TIME.test(draft.work_start) || !TIME.test(draft.work_end)) return setError('Enter working hours as HH:MM, e.g. 08:00.');
      if (draft.work_start === draft.work_end) return setError('Working hours must start and end at different times.');
    }
    if (draft.require_mfa && !initial.require_mfa && aal.next !== 'aal2') {
      return setError('Set up two-factor login for your own account first (Settings), or you would lock yourself out of employee data.');
    }
    const next: Draft = {
      ...draft, retention_days: detail, summary_retention_days: summary, file_retention_days: files,
      offline_prompt_minutes: askedAfter,
      productive_offline_reasons: OFFLINE_REASONS.map((r) => r.id).filter((id) => draft.productive_offline_reasons.includes(id)),
      office_days_per_week: officeTarget,
    };

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
    if (files < initial.file_retention_days) {
      warnings.push(`File activity older than ${files} days will be permanently deleted at the next nightly clean-up.`);
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

      <Card title="Time away from the computer">
        <Text style={styles.hint}>
          When someone comes back after being idle or away, the desktop app can ask whether it was a meeting, a call, a
          break or something else. They can dismiss the question. Idle and away time is still recorded either way, and
          the answer is listed on their page for them and for managers.
        </Text>
        <ToggleRow label="Ask what they were doing" value={draft.ask_offline_reason}
          onChange={(v) => set('ask_offline_reason', v)}
          hint="This is in the monitoring notice. The desktop app asks only after the employee has acknowledged that notice. Included on every plan." />
        <Field label="Ask after (minutes)" value={offlineMinutes} onChangeText={setOfflineMinutes}
          keyboardType="number-pad" hint="1 to 120. The suggested wait is 10 minutes." />
        <Text style={styles.label}>Count as productive time</Text>
        {OFFLINE_REASONS.map((r) => (
          <ToggleRow key={r.id} label={r.label} value={draft.productive_offline_reasons.includes(r.id)}
            onChange={(on) => set('productive_offline_reasons', on
              ? [...draft.productive_offline_reasons, r.id]
              : draft.productive_offline_reasons.filter((x) => x !== r.id))}
            hint={r.hint} />
        ))}
      </Card>

      {workLocationAllowed ? (
      <Card title="Office and remote">
        <Text style={styles.hint}>
          The desktop app checks whether the PC is on a network you register here (the office's public internet address
          or its Wi-Fi name) and records each day as office, remote, or mixed. A home address and a home network name
          are not stored. The check starts only after the employee has acknowledged the notice.
        </Text>
        <ToggleRow label="Record office and remote days" value={draft.track_work_location}
          onChange={(v) => set('track_work_location', v)}
          hint="Reinstall the desktop app (version 2.5 or later) on each PC." />
        <Field label="Office days per week" value={officeDays} onChangeText={setOfficeDays}
          keyboardType="number-pad" hint="1 to 7, or leave empty when the company has no target. A team can set its own number under Teams. A day counts when someone was in an office for part of it." />
        <OfficeList orgWide={orgWide} allowed={workLocationAllowed} />
      </Card>
      ) : null}

      {aiToolsAllowed ? (
      <Card title="AI tools">
        <Text style={styles.hint}>
          Insights shows which AI tools people used. Mark each tool approved or not approved there. This switch tells
          managers when someone uses a tool marked as not approved, and adds that sentence to the employee notice.
        </Text>
        <ToggleRow label="Tell managers when someone uses an AI tool marked as not approved"
          value={draft.alert_unapproved_ai}
          onChange={(v) => set('alert_unapproved_ai', v)}
          hint="The list of tools is kept by Mycroscope." />
      </Card>
      ) : null}

      {advisorAllowed ? (
      <Card title="Written reports">
        <Text style={styles.hint}>
          Insights lets a manager write a report for a period: a week in review, workload, where time went, capacity,
          or how the period changed. The weekly note covers the previous full week. Reports are written inside
          Mycroscope from figures already stored. If a figure is unusually high or low, that is the conclusion the report
          leads with. The report names the people it describes. Pay figures are left out.
          Nothing is sent to another company. Employees are told in the notice while this is on.
        </Text>
        <ToggleRow label="Allow written reports" value={draft.advisor_enabled}
          onChange={(v) => set('advisor_enabled', v)}
          hint="Stays off until you switch it on." />
        <ToggleRow label="Email the weekly note to managers" value={draft.advisor_weekly_email}
          onChange={(v) => set('advisor_weekly_email', v)}
          hint="Managers who can see that team. Uses the same email setup as the weekly digest." />
      </Card>
      ) : null}

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

      {fileActivityAllowed ? (
      <Card title="File activity">
        <Text style={styles.hint}>
          Records when a USB drive, external disk or phone is connected, and the names and sizes of files copied onto
          removable drives, into cloud folders or onto network drives. File contents are never read. Managers see file
          names only on an employee's page, and every view is written to the audit log. Alerts, Slack/Teams messages and
          the API only show counts. Files copied onto a phone cannot be seen, only that a phone was connected.
        </Text>
        <ToggleRow label="USB drives, external disks and phones" value={draft.detect_removable_media}
          onChange={(v) => set('detect_removable_media', v)}
          hint="Connections, and files copied onto the drive. Large copies raise a high-severity alert." />
        <ToggleRow label="Cloud sync folders" value={draft.detect_cloud_sync}
          onChange={(v) => set('detect_cloud_sync', v)}
          hint="New files in OneDrive, Dropbox and Google Drive folders on the PC. Only large copies raise an alert." />
        <ToggleRow label="Network drives" value={draft.detect_network_drives}
          onChange={(v) => set('detect_network_drives', v)}
          hint="Files the employee copies to mapped network drives (not colleagues' files). Only large copies raise an alert." />
        <Field label="Keep file activity for (days)" value={fileRetention} onChangeText={setFileRetention}
          keyboardType="number-pad" hint="7 to 365. Names and sizes of copied files older than this are deleted nightly." />
      </Card>
      ) : null}

      <Card title="Account security">
        <ToggleRow label="Require two-factor login for managers" value={draft.require_mfa} disabled={!isOwner}
          onChange={(v) => set('require_mfa', v)}
          hint={isOwner ? 'Managers must enter a code from an authenticator app to see employee data. Recommended.'
            : 'Only the manager who created the organisation can change this.'} />
      </Card>

      <Card title="Retention">
        <Field label="Keep detailed activity for (days)" value={retention} onChangeText={setRetention}
          keyboardType="number-pad" hint="Apps, websites and timelines older than this are hidden. It cannot be longer than the plan. A paid plan is set to that full period." />
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

function OfficeList({ orgWide, allowed }: { orgWide: boolean; allowed: boolean }) {
  const { data, error, loading, refresh, reload } = useAsync(() => api.officeNetworks(), []);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [wifi, setWifi] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function add() {
    setFormError(null);
    if (!name.trim()) return setFormError('Give the office a name.');
    const cidrs = address.split(',').map((s) => s.trim()).filter(Boolean);
    const names = wifi.split(',').map((s) => s.trim()).filter(Boolean);
    if (cidrs.length === 0 && names.length === 0) return setFormError('Add the public IP address or the Wi-Fi name.');
    setBusy(true);
    try {
      await api.saveOfficeNetwork(name.trim(), cidrs, names);
      setName(''); setAddress(''); setWifi('');
      reload();
    } catch (e) {
      setFormError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(office: OfficeNetwork) {
    if (!await confirmAction(`Remove ${office.name}?`, 'Past days stay recorded. New checks will no longer match this office.', 'Remove')) return;
    setBusy(true);
    try {
      await api.deleteOfficeNetwork(office.id);
      reload();
    } catch (e) {
      setFormError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: 8, marginTop: 8 }}>
      <Text style={styles.label}>Registered offices</Text>
      {error ? <ErrorBanner message={error} onRetry={refresh} /> : null}
      {formError ? <ErrorBanner message={formError} /> : null}
      {loading && !data ? <Loading /> : null}
      {data && data.length === 0 ? <Empty text="No offices yet." /> : null}
      {data?.map((office) => (
        <View key={office.id} style={[styles.row, { justifyContent: 'space-between' }]}>
          <View style={{ flex: 1 }}>
            <Text style={styles.rowText}>{office.name}</Text>
            <Text style={styles.hint}>
              {[...office.cidrs, ...office.wifi_names].join(' · ') || 'No address'}
            </Text>
          </View>
          {orgWide ? <Text style={{ color: colors.danger, fontWeight: '600' }} onPress={() => remove(office)}>Remove</Text> : null}
        </View>
      ))}
      {orgWide && allowed ? (
        <>
          <Field label="Office name" value={name} onChangeText={setName} placeholder="Cape Town" />
          <Field label="Public IP address or range" value={address} onChangeText={setAddress}
            autoCapitalize="none" placeholder="41.0.0.1 or 41.0.0.0/24" hint="The address the internet sees, not a 192.168 or 10. address." />
          <Field label="Office Wi-Fi name (optional)" value={wifi} onChangeText={setWifi} autoCapitalize="none" />
          <Button small title="Add office" loading={busy} onPress={add} />
        </>
      ) : (
        <Text style={styles.hint}>Only a company-wide manager can add or remove offices.</Text>
      )}
    </View>
  );
}
