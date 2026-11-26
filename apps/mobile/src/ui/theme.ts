// SPDX-License-Identifier: AGPL-3.0-only
import { StyleSheet, useColorScheme } from 'react-native';

const light = {
  background: '#ffffff',
  surface: '#f8fafc',
  text: '#111827',
  muted: '#4b5563',
  primary: '#1d4ed8',
  primaryText: '#ffffff',
  border: '#9ca3af',
  danger: '#b91c1c',
  dangerText: '#ffffff',
  warning: '#92400e',
  warningBg: '#fef3c7',
  success: '#166534',
  badgeBg: '#e0e7ff',
  badgeText: '#1e3a8a',
};

const dark = {
  background: '#0b0f19',
  surface: '#111827',
  text: '#f3f4f6',
  muted: '#9ca3af',
  primary: '#60a5fa',
  primaryText: '#0b0f19',
  border: '#6b7280',
  danger: '#fca5a5',
  dangerText: '#0b0f19',
  warning: '#fcd34d',
  warningBg: '#451a03',
  success: '#86efac',
  badgeBg: '#1e3a8a',
  badgeText: '#dbeafe',
};

export type Palette = typeof light;

export function usePalette(): Palette {
  return useColorScheme() === 'dark' ? dark : light;
}

// Touch targets are at least 48 points high (44 is the floor of both platforms' guidelines).
export const styles = StyleSheet.create({
  screen: { flex: 1, padding: 24, justifyContent: 'center', gap: 16 },
  scrollContainer: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 32, gap: 12 },
  title: { fontSize: 24, fontWeight: '700' },
  sectionTitle: { fontSize: 17, fontWeight: '700', marginTop: 4 },
  cardTitle: { fontSize: 17, fontWeight: '600', lineHeight: 22 },
  body: { fontSize: 16, lineHeight: 22 },
  meta: { fontSize: 14, lineHeight: 20 },
  amount: { fontSize: 18, fontWeight: '700', lineHeight: 24 },
  button: { minHeight: 48, borderRadius: 10, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center' },
  secondaryButton: {
    minHeight: 48,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { fontSize: 16, fontWeight: '600' },
  input: { minHeight: 48, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  link: { minHeight: 48, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center' },
  card: { borderWidth: 1, borderRadius: 12, padding: 16, gap: 8 },
  banner: { borderWidth: 1, borderRadius: 10, padding: 12, gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' },
  actionsRow: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  badge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4, alignSelf: 'flex-start' },
  badgeText: { fontSize: 13, fontWeight: '600' },
  checkboxRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6 },
  checkboxBox: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  divider: { height: 1, marginVertical: 4 },
});
