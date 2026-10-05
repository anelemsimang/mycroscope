import { Share, Text, View } from 'react-native';

import { Button, Card, colors, styles } from '@/components/ui';
import type { ActivationResult } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

export function activationMessage(name: string, org: string, a: ActivationResult, timezone: string): string {
  return [
    `Hi ${name}, ${org} uses Mycroscope to record work activity on company computers.`,
    '',
    'To set up the Mycroscope desktop app on your work PC, open it and choose "Activate account":',
    `  Employee code: ${a.employee_code}`,
    `  Activation code: ${a.activation_code}`,
    `  (valid until ${formatDateTime(a.expires_at, timezone)})`,
    '',
    'Before anything is recorded, the app shows you a notice explaining exactly what is collected and your rights.',
  ].join('\n');
}

export function ActivationCard({ name, org, result, timezone }: {
  name: string; org: string; result: ActivationResult; timezone: string;
}) {
  return (
    <Card title="Activation details">
      <Text style={styles.hint}>Give these to {name}. The activation code works once and is not shown again.</Text>
      <View style={{ gap: 2, marginVertical: 6 }}>
        <Text style={styles.hint}>Employee code</Text>
        <Text selectable style={{ fontSize: 22, fontWeight: '700', color: colors.text }}>{result.employee_code}</Text>
        <Text style={[styles.hint, { marginTop: 6 }]}>Activation code</Text>
        <Text selectable style={{ fontSize: 22, fontWeight: '700', letterSpacing: 2, color: colors.primary }}>
          {result.activation_code}
        </Text>
        <Text style={styles.hint}>Expires {formatDateTime(result.expires_at, timezone)}</Text>
      </View>
      <Button title="Share instructions" onPress={() => Share.share({ message: activationMessage(name, org, result, timezone) })} />
    </Card>
  );
}
