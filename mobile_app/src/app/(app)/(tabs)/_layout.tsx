import { Tabs } from 'expo-router';
import { Text, type ColorValue } from 'react-native';

import { colors } from '@/components/ui';

function Icon({ glyph, color }: { glyph: string; color: ColorValue }) {
  return <Text style={{ fontSize: 18, color }}>{glyph}</Text>;
}

export default function TabsLayout() {
  return (
    <Tabs screenOptions={{ tabBarActiveTintColor: colors.primary, headerTintColor: colors.primary }}>
      <Tabs.Screen name="index" options={{ title: 'Team', tabBarIcon: ({ color }) => <Icon glyph="●" color={color} /> }} />
      <Tabs.Screen name="reports" options={{ title: 'Reports', tabBarIcon: ({ color }) => <Icon glyph="▤" color={color} /> }} />
      <Tabs.Screen name="employees" options={{ title: 'Employees', tabBarIcon: ({ color }) => <Icon glyph="☰" color={color} /> }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings', tabBarIcon: ({ color }) => <Icon glyph="⚙" color={color} /> }} />
    </Tabs>
  );
}
