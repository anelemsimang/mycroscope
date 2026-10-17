import { Text } from 'react-native';

import { Card, Empty, LinkRow, styles } from '@/components/ui';
import type { DayGroup } from '@/lib/dayBreakdown';
import { formatDuration } from '@/lib/format';

/** A single day's apps and websites, one card per project, including work with no project. */
export function ProjectDayGroups({ groups, onApp, onWebsite }: {
  groups: DayGroup[];
  onApp: (group: DayGroup, app: string) => void;
  onWebsite: (group: DayGroup, domain: string) => void;
}) {
  if (groups.length === 0) return <Empty text="No activity recorded for this day." />;
  return (
    <>
      <Text style={styles.hint}>Grouped by the project selected while the work was recorded.</Text>
      {groups.map((group) => (
        <Card key={group.key} title={group.name} right={<Text style={styles.rowText}>{formatDuration(group.active)}</Text>}>
          {group.apps.map((app) => (
            <LinkRow key={app.label} title={app.label} subtitle={`${formatDuration(app.idle)} idle`}
              right={formatDuration(app.active)} onPress={() => onApp(group, app.label)} />
          ))}
          {group.websites.length > 0 ? <Text style={[styles.hint, { marginTop: 6 }]}>Websites</Text> : null}
          {group.websites.map((site) => (
            <LinkRow key={site.label} title={site.label} subtitle={site.title}
              right={formatDuration(site.active)} onPress={() => onWebsite(group, site.label)} />
          ))}
        </Card>
      ))}
    </>
  );
}
