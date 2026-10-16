import { Card, Screen } from '@/components/ui';
import { TermsText } from '@/components/LegalText';

export default function TermsOfService() {
  return (
    <Screen>
      <Card title="Terms of service">
        <TermsText />
      </Card>
    </Screen>
  );
}