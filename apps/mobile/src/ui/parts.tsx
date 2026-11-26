// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { styles, usePalette } from './theme.ts';

export function Screen(props: { children: ReactNode }) {
  const palette = usePalette();
  return <View style={[styles.screen, { backgroundColor: palette.background }]}>{props.children}</View>;
}

export function Title(props: { children: string }) {
  const palette = usePalette();
  return (
    <Text accessibilityRole="header" style={[styles.title, { color: palette.text }]}>
      {props.children}
    </Text>
  );
}

export function Body(props: { children: string; tone?: 'normal' | 'muted' | 'danger' }) {
  const palette = usePalette();
  const color = props.tone === 'danger' ? palette.danger : props.tone === 'muted' ? palette.muted : palette.text;
  return <Text style={[styles.body, { color }]}>{props.children}</Text>;
}

export function PrimaryButton(props: { label: string; onPress: () => void; busy?: boolean }) {
  const palette = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: props.busy === true, busy: props.busy === true }}
      disabled={props.busy === true}
      onPress={props.onPress}
      style={[styles.button, { backgroundColor: palette.primary, opacity: props.busy ? 0.6 : 1 }]}
    >
      {props.busy ? <ActivityIndicator color={palette.primaryText} /> : <Text style={[styles.buttonText, { color: palette.primaryText }]}>{props.label}</Text>}
    </Pressable>
  );
}

export function LinkButton(props: { label: string; onPress: () => void }) {
  const palette = usePalette();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={props.label} onPress={props.onPress} style={styles.link}>
      <Text style={[styles.buttonText, { color: palette.primary }]}>{props.label}</Text>
    </Pressable>
  );
}
