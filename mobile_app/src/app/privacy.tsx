import { Card, Screen } from '@/components/ui';
import { PrivacyText } from '@/components/LegalText';

export default function PrivacyPolicy() {
  return (
    <Screen>
      <Card title="Privacy policy">
        <PrivacyText />
      </Card>
    </Screen>
  );
}
