import { router, type Href } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { Card, colors, styles } from '@/components/ui';
import { api, type TeamRow } from '@/lib/api';
import { useProfile, useSession } from '@/lib/session';
import { useAsync } from '@/lib/useAsync';

interface Step { done: boolean; title: string; detail: string; href: Href }

/** Getting-started checklist for owners; hidden once everything is done. */
export function OnboardingChecklist({ team }: { team: TeamRow[] | null }) {
  const profile = useProfile();
  const { aal, service } = useSession();
  const settings = useAsync(async () => {
    const [s, policies] = await Promise.all([api.complianceSettings(profile.organizationId), api.policies()]);
    return { officer: !!s.information_officer_email, reviewed: policies.length > 1 };
  }, [profile.organizationId]);
  if (profile.role !== 'owner' || !team || !settings.data) return null;

  const others = team.filter((r) => r.employee_id !== profile.employeeId);
  const steps: Step[] = [
    { done: settings.data.officer, title: 'Name your Information Officer',
      detail: 'Required by POPIA and shown in the monitoring notice.', href: '/monitoring' },
    { done: settings.data.reviewed, title: 'Decide what is monitored and when',
      detail: 'Apps, websites, working hours and integrity checks.', href: '/monitoring' },
    { done: others.length > 0, title: 'Register your first employee', detail: 'You get an activation code to give them.', href: '/register' },
    { done: others.some((r) => r.activated), title: 'Install the desktop app on their PC',
      detail: 'They activate it with the code and acknowledge the notice.', href: '/register' },
    { done: aal.next === 'aal2', title: 'Turn on two-factor login', detail: 'Protects your account and your employees\' data.', href: '/settings' },
    { done: service?.status === 'active', title: 'Choose a subscription', detail: 'Keep recording after the free trial.', href: '/billing' },
  ];
  const remaining = steps.filter((s) => !s.done).length;
  if (remaining === 0) return null;

  return (
    <Card title={`Getting started (${steps.length - remaining}/${steps.length})`}>
      {steps.map((s) => (
        <Pressable key={s.title} onPress={() => router.push(s.href)} disabled={s.done}
          style={({ pressed }) => [{ flexDirection: 'row', gap: 10, paddingVertical: 6 }, pressed && { opacity: 0.6 }]}>
          <Text style={{ fontSize: 16, color: s.done ? colors.success : colors.muted }}>{s.done ? '✓' : '○'}</Text>
          <View style={{ flex: 1 }}>
            <Text style={[styles.rowText, s.done && { color: colors.muted, textDecorationLine: 'line-through' }]}>{s.title}</Text>
            {!s.done ? <Text style={styles.hint}>{s.detail}</Text> : null}
          </View>
          {!s.done ? <Text style={styles.chevron}>›</Text> : null}
        </Pressable>
      ))}
    </Card>
  );
}
