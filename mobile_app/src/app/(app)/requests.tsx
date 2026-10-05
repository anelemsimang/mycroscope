import { useState } from 'react';
import { Text, View } from 'react-native';

import { Button, Card, Empty, ErrorBanner, Field, Loading, Pill, Screen, Segmented, colors, styles } from '@/components/ui';
import { api, errorMessage, type DataRequest, type DataRequestKind, type DataRequestStatus } from '@/lib/api';
import { notify } from '@/lib/dialog';
import { formatDateTime } from '@/lib/format';
import { useProfile, useSession } from '@/lib/session';
import { useAsync } from '@/lib/useAsync';

const KIND_LABEL: Record<DataRequestKind, string> = {
  access: 'Copy of my data', correction: 'Correct my data', objection: 'Object to monitoring', deletion: 'Delete my data', other: 'Other',
};
const STATUS_LABEL: Record<DataRequestStatus, string> = {
  open: 'Open', in_progress: 'In progress', completed: 'Completed', rejected: 'Declined',
};
const STATUS_COLOR: Record<DataRequestStatus, string> = {
  open: colors.warning, in_progress: colors.primary, completed: colors.success, rejected: colors.danger,
};

export default function Requests() {
  const profile = useProfile();
  const { isManager } = useSession();
  const { data, error, loading, refresh, reload } = useAsync(async () => {
    const [requests, people] = await Promise.all([api.dataRequests(), isManager ? api.employees() : Promise.resolve([])]);
    return { requests, names: new Map(people.map((p) => [p.id, p.name])) };
  }, [isManager]);

  if (loading && !data) return <Loading />;
  const mine = (data?.requests ?? []).filter((r) => r.employee_id === profile.employeeId);
  const toHandle = (data?.requests ?? []).filter((r) => r.employee_id !== profile.employeeId);

  return (
    <Screen>
      {error ? <ErrorBanner message={error} onRetry={refresh} /> : null}
      {isManager ? (
        <Card title={`Requests from employees (${toHandle.filter((r) => r.status === 'open' || r.status === 'in_progress').length} open)`}>
          <Text style={styles.hint}>
            POPIA gives employees the right to access and correct their personal information and to object to processing.
            Respond within a reasonable time (30 days is the usual benchmark). Responses are recorded in the audit log.
          </Text>
          {toHandle.length === 0 ? <Empty text="No requests." /> : null}
          {toHandle.map((r) => <HandleRequest key={r.id} request={r} who={data?.names.get(r.employee_id) ?? 'Employee'} onDone={reload} />)}
        </Card>
      ) : null}
      {profile.role !== 'owner' ? <NewRequest onDone={reload} /> : null}
      {profile.role !== 'owner' ? (
        <Card title="My requests">
          {mine.length === 0 ? <Empty text="You have not sent any requests." /> : mine.map((r) => (
            <View key={r.id} style={{ gap: 4, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#f3f4f6' }}>
              <View style={[styles.row, { justifyContent: 'space-between' }]}>
                <Text style={[styles.rowText, { fontWeight: '600' }]}>{KIND_LABEL[r.kind]}</Text>
                <Pill text={STATUS_LABEL[r.status]} color={STATUS_COLOR[r.status]} />
              </View>
              <Text style={styles.hint}>{formatDateTime(r.created_at, profile.timezone)}</Text>
              <Text style={styles.rowText}>{r.message}</Text>
              {r.response ? <Text style={[styles.rowText, { color: colors.primary }]}>Response: {r.response}</Text> : null}
            </View>
          ))}
        </Card>
      ) : null}
    </Screen>
  );
}

function NewRequest({ onDone }: { onDone: () => void }) {
  const [kind, setKind] = useState<DataRequestKind>('access');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    if (!message.trim()) return setError('Describe what you are asking for.');
    setBusy(true);
    try {
      await api.submitDataRequest(kind, message.trim());
      setMessage('');
      notify('Request sent', 'Your organisation has been notified and will respond here.');
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="New privacy request">
      <Text style={styles.hint}>
        Ask your organisation for a copy of what Mycroscope recorded about you, to correct it, or object to the monitoring.
      </Text>
      {error ? <ErrorBanner message={error} /> : null}
      <Segmented options={(Object.keys(KIND_LABEL) as DataRequestKind[]).map((k) => ({ value: k, label: KIND_LABEL[k] }))}
        value={kind} onChange={setKind} />
      <Field label="Details" value={message} onChangeText={setMessage} multiline maxLength={4000}
        style={{ minHeight: 80, textAlignVertical: 'top' }} />
      <Button title="Send request" onPress={submit} loading={busy} />
    </Card>
  );
}

function HandleRequest({ request, who, onDone }: { request: DataRequest; who: string; onDone: () => void }) {
  const profile = useProfile();
  const [status, setStatus] = useState<Exclude<DataRequestStatus, 'open'>>('completed');
  const [response, setResponse] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = request.status === 'open' || request.status === 'in_progress';

  async function respond() {
    setError(null);
    setBusy(true);
    try {
      await api.respondDataRequest(request.id, status, response.trim());
      setResponse('');
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: 6, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#f3f4f6' }}>
      <View style={[styles.row, { justifyContent: 'space-between' }]}>
        <Text style={[styles.rowText, { fontWeight: '600', flex: 1 }]}>{who} · {KIND_LABEL[request.kind]}</Text>
        <Pill text={STATUS_LABEL[request.status]} color={STATUS_COLOR[request.status]} />
      </View>
      <Text style={styles.hint}>{formatDateTime(request.created_at, profile.timezone)}</Text>
      <Text style={styles.rowText}>{request.message}</Text>
      {request.response ? <Text style={[styles.rowText, { color: colors.primary }]}>Response: {request.response}</Text> : null}
      {open ? (
        <>
          {error ? <ErrorBanner message={error} /> : null}
          <Segmented options={[
            { value: 'in_progress', label: 'Working on it' }, { value: 'completed', label: 'Completed' }, { value: 'rejected', label: 'Decline' },
          ]} value={status} onChange={setStatus} />
          <Field label={status === 'in_progress' ? 'Note to the employee (optional)' : 'Response to the employee'}
            value={response} onChangeText={setResponse} multiline maxLength={4000} style={{ minHeight: 60, textAlignVertical: 'top' }} />
          <Button small title="Send response" onPress={respond} loading={busy} />
        </>
      ) : null}
    </View>
  );
}
