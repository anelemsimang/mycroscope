import { router } from 'expo-router';
import { useState } from 'react';
import { Text } from 'react-native';

import { Button, Card, Empty, ErrorBanner, Field, LinkRow, Loading, Screen, Segmented, styles } from '@/components/ui';
import { errorMessage, inCaseStudy, operatorApi } from '@/lib/api';
import { confirmAction, notify } from '@/lib/dialog';
import { formatDate } from '@/lib/format';
import { CASE_STUDY_MONTHS } from '@/lib/operator';
import { useAsync } from '@/lib/useAsync';

export default function CaseStudies() {
  const { data, error, loading, refreshing, refresh } = useAsync(async () => {
    const [invites, orgs] = await Promise.all([operatorApi.caseStudyInvites(), operatorApi.organizations()]);
    return { invites, running: orgs.filter((o) => inCaseStudy(o)) };
  }, []);
  const [email, setEmail] = useState('');
  const [months, setMonths] = useState<(typeof CASE_STUDY_MONTHS)[number]>('12');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function invite() {
    setErr(null);
    if (!email.includes('@')) return setErr('Enter the email address the company owner will register with.');
    if (!note.trim()) return setErr('Add a note, e.g. the agreement or contact person.');
    setBusy(true);
    try {
      await operatorApi.inviteCaseStudy(email.trim(), Number(months), note.trim());
      setEmail('');
      setNote('');
      notify('Case study invite saved',
        `When ${email.trim()} registers their organisation, it gets ${months} months free, then the normal 14-day trial.`);
      refresh();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function cancel(addr: string) {
    if (!(await confirmAction(`Cancel the invite for ${addr}?`, 'They will get the normal 14-day trial if they sign up.', 'Cancel invite'))) return;
    try {
      await operatorApi.cancelCaseStudyInvite(addr);
      refresh();
    } catch (e) {
      notify('Could not cancel', errorMessage(e));
    }
  }

  if (loading && !data) return <Loading />;
  return (
    <Screen refreshing={refreshing} onRefresh={refresh}>
      {error ? <ErrorBanner message={error} onRetry={refresh} /> : null}
      <Card title="Invite a company">
        <Text style={styles.hint}>
          For companies that have not signed up yet. When the owner registers with this email, the case study starts
          automatically. For companies already using Mycroscope, open them from the customer list instead.
        </Text>
        <Field label="Owner's email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" />
        <Text style={styles.label}>Free period</Text>
        <Segmented options={CASE_STUDY_MONTHS.map((m) => ({ value: m, label: `${m} months` }))} value={months} onChange={setMonths} />
        <Field label="Note (required)" value={note} onChangeText={setNote} placeholder="e.g. 2027 case study, signed 4 Oct" multiline />
        {err ? <ErrorBanner message={err} /> : null}
        <Button title="Save invite" onPress={invite} loading={busy} />
      </Card>

      <Card title={`Waiting to sign up (${data?.invites.length ?? 0})`}>
        {(data?.invites ?? []).length === 0 ? <Empty text="No open invites." /> : null}
        {(data?.invites ?? []).map((i) => (
          <LinkRow key={i.email} title={i.email} subtitle={`${i.months} months · ${i.note} · invited ${formatDate(i.created_at)} · tap to cancel`}
            onPress={() => cancel(i.email)} />
        ))}
      </Card>

      <Card title={`Running (${data?.running.length ?? 0})`}>
        {(data?.running ?? []).length === 0 ? <Empty text="No case studies running." /> : null}
        {(data?.running ?? []).map((o) => (
          <LinkRow key={o.organization_id} title={o.name}
            subtitle={`Free until ${formatDate(o.case_study_until)}, then trial until ${formatDate(o.trial_ends_at)} · ${o.active_employees} people`}
            onPress={() => router.push({ pathname: '/operator/org/[id]', params: { id: o.organization_id } })} />
        ))}
      </Card>
    </Screen>
  );
}
