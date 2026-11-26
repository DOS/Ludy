// SPDX-License-Identifier: AGPL-3.0-only
import { StyleSheet, useColorScheme } from 'react-native';

const light = { background: '#ffffff', text: '#111827', muted: '#4b5563', primary: '#1d4ed8', primaryText: '#ffffff', border: '#9ca3af', danger: '#b91c1c' };
const dark = { background: '#0b0f19', text: '#f3f4f6', muted: '#9ca3af', primary: '#60a5fa', primaryText: '#0b0f19', border: '#6b7280', danger: '#fca5a5' };

export type Palette = typeof light;

export function usePalette(): Palette {
  return useColorScheme() === 'dark' ? dark : light;
}

// Touch targets are at least 48 points high (44 is the floor of both platforms' guidelines).
export const styles = StyleSheet.create({
  screen: { flex: 1, padding: 24, justifyContent: 'center', gap: 16 },
  title: { fontSize: 26, fontWeight: '700' },
  body: { fontSize: 16, lineHeight: 22 },
  button: { minHeight: 48, borderRadius: 10, paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center' },
  buttonText: { fontSize: 16, fontWeight: '600' },
  input: { minHeight: 48, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, fontSize: 16 },
  link: { minHeight: 48, alignItems: 'center', justifyContent: 'center' },
});
