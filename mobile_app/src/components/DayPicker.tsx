import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, styles } from '@/components/ui';
import { addMonths, formatDay, formatMonth, monthCells, monthStart, type Ymd } from '@/lib/format';

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const CELL = 32;

/** Opens a calendar and returns one day. Days after `today` cannot be selected. */
export function ChooseDay({ day, today, onChange }: { day: Ymd | null; today: Ymd; onChange: (day: Ymd) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable onPress={() => setOpen(true)} accessibilityRole="button"
        style={[styles.segment, day ? styles.segmentActive : null, { alignSelf: 'flex-start' }]}>
        <Text style={[styles.segmentText, day ? { color: '#fff' } : null]}>
          {day ? formatDay(day, { weekday: true }) : 'Choose a day'}
        </Text>
      </Pressable>
      <DayPicker visible={open} value={day} today={today} onClose={() => setOpen(false)}
        onSelect={(picked) => { onChange(picked); setOpen(false); }} />
    </>
  );
}

export function DayPicker({ visible, value, today, onClose, onSelect }: {
  visible: boolean; value: Ymd | null; today: Ymd; onClose: () => void; onSelect: (day: Ymd) => void;
}) {
  const [month, setMonth] = useState(monthStart(value ?? today));
  const cells = monthCells(month);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}
      onShow={() => setMonth(monthStart(value ?? today))}>
      <View style={local.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close calendar" />
        <View style={local.sheet}>
          <View style={local.nav}>
            <Pressable onPress={() => setMonth(addMonths(month, -1))} accessibilityLabel="Previous month"
              style={local.navButton} hitSlop={6}>
              <Text style={local.navText}>‹</Text>
            </Pressable>
            <Text style={local.month}>{formatMonth(month)}</Text>
            <Pressable onPress={() => setMonth(addMonths(month, 1))} accessibilityLabel="Next month"
              style={local.navButton} hitSlop={6} disabled={month >= monthStart(today)}>
              <Text style={[local.navText, month >= monthStart(today) && { color: colors.border }]}>›</Text>
            </Pressable>
          </View>
          <View style={local.grid}>
            {WEEKDAYS.map((name) => (
              <Text key={name} style={local.weekday}>{name}</Text>
            ))}
            {cells.map((cell, index) => {
              if (!cell) return <View key={`blank-${index}`} style={local.cell} />;
              const future = cell > today;
              const selected = cell === value;
              const isToday = cell === today;
              return (
                <Pressable key={cell} disabled={future} onPress={() => onSelect(cell)}
                  accessibilityRole="button" accessibilityLabel={formatDay(cell, { weekday: true })}
                  style={local.cell}>
                  <View style={[local.dot, selected && local.selected, isToday && !selected && local.today]}>
                    <Text style={[local.day, future && local.future, selected && local.selectedText, isToday && !selected && local.todayText]}>
                      {Number(cell.slice(8))}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const local = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(15, 23, 42, 0.35)' },
  sheet: {
    width: CELL * 7 + 28, backgroundColor: colors.card, borderRadius: 16, padding: 14,
    borderWidth: 1, borderColor: colors.border, gap: 8,
    shadowColor: '#0f172a', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.12, shadowRadius: 16, elevation: 6,
  },
  nav: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  navButton: {
    width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background,
  },
  navText: { fontSize: 16, lineHeight: 18, color: colors.primary, fontWeight: '600' },
  month: { fontSize: 13, fontWeight: '600', color: colors.text, letterSpacing: 0.2 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', width: CELL * 7 },
  weekday: { width: CELL, textAlign: 'center', fontSize: 9, fontWeight: '600', color: colors.muted, letterSpacing: 0.3, paddingBottom: 2 },
  cell: { width: CELL, height: CELL, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  selected: { backgroundColor: colors.primary },
  today: { backgroundColor: colors.primaryLight },
  day: { fontSize: 12, color: colors.text, fontWeight: '500' },
  future: { color: '#d1d5db' },
  selectedText: { color: '#fff', fontWeight: '600' },
  todayText: { color: colors.primary, fontWeight: '700' },
});
