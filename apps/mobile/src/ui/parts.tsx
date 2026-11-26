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

export function SectionHeading(props: { children: string }) {
  const palette = usePalette();
  return (
    <Text accessibilityRole="header" style={[styles.sectionTitle, { color: palette.text }]}>
      {props.children}
    </Text>
  );
}

export function Body(props: { children: string; tone?: 'normal' | 'muted' | 'danger' | 'warning' }) {
  const palette = usePalette();
  const color =
    props.tone === 'danger'
      ? palette.danger
      : props.tone === 'warning'
        ? palette.warning
        : props.tone === 'muted'
          ? palette.muted
          : palette.text;
  return <Text style={[styles.body, { color }]}>{props.children}</Text>;
}

export function PrimaryButton(props: {
  label: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
}) {
  const palette = usePalette();
  const inactive = props.busy === true || props.disabled === true;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityHint={props.accessibilityHint}
      accessibilityState={{ disabled: inactive, busy: props.busy === true }}
      disabled={inactive}
      onPress={props.onPress}
      style={[styles.button, { backgroundColor: palette.primary, opacity: inactive ? 0.55 : 1 }]}
    >
      {props.busy ? (
        <ActivityIndicator color={palette.primaryText} />
      ) : (
        <Text style={[styles.buttonText, { color: palette.primaryText }]}>{props.label}</Text>
      )}
    </Pressable>
  );
}

export function SecondaryButton(props: {
  label: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
}) {
  const palette = usePalette();
  const inactive = props.busy === true || props.disabled === true;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityHint={props.accessibilityHint}
      accessibilityState={{ disabled: inactive, busy: props.busy === true }}
      disabled={inactive}
      onPress={props.onPress}
      style={[
        styles.secondaryButton,
        { backgroundColor: palette.surface, borderColor: palette.border, opacity: inactive ? 0.55 : 1 },
      ]}
    >
      {props.busy ? (
        <ActivityIndicator color={palette.text} />
      ) : (
        <Text style={[styles.buttonText, { color: palette.text }]}>{props.label}</Text>
      )}
    </Pressable>
  );
}

export function DangerButton(props: {
  label: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
}) {
  const palette = usePalette();
  const inactive = props.busy === true || props.disabled === true;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityHint={props.accessibilityHint}
      accessibilityState={{ disabled: inactive, busy: props.busy === true }}
      disabled={inactive}
      onPress={props.onPress}
      style={[styles.button, { backgroundColor: palette.danger, opacity: inactive ? 0.55 : 1 }]}
    >
      {props.busy ? (
        <ActivityIndicator color={palette.dangerText} />
      ) : (
        <Text style={[styles.buttonText, { color: palette.dangerText }]}>{props.label}</Text>
      )}
    </Pressable>
  );
}

export function LinkButton(props: {
  label: string;
  onPress: () => void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  disabled?: boolean;
}) {
  const palette = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityHint={props.accessibilityHint}
      accessibilityState={{ disabled: props.disabled === true }}
      disabled={props.disabled === true}
      onPress={props.onPress}
      style={[styles.link, { opacity: props.disabled ? 0.55 : 1 }]}
    >
      <Text style={[styles.buttonText, { color: palette.primary }]}>{props.label}</Text>
    </Pressable>
  );
}

export function Badge(props: { label: string; tone?: 'info' | 'warn' | 'danger' | 'success' }) {
  const palette = usePalette();
  const bg =
    props.tone === 'danger'
      ? palette.danger
      : props.tone === 'warn'
        ? palette.warningBg
        : palette.badgeBg;
  const fg =
    props.tone === 'danger'
      ? palette.dangerText
      : props.tone === 'warn'
        ? palette.warning
        : props.tone === 'success'
          ? palette.success
          : palette.badgeText;
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <Text style={[styles.badgeText, { color: fg }]}>{props.label}</Text>
    </View>
  );
}

export function Banner(props: {
  tone: 'info' | 'warn' | 'danger';
  children: ReactNode;
}) {
  const palette = usePalette();
  const borderColor = props.tone === 'danger' ? palette.danger : props.tone === 'warn' ? palette.warning : palette.border;
  const backgroundColor = props.tone === 'warn' ? palette.warningBg : palette.surface;
  return (
    <View
      accessibilityRole="summary"
      accessibilityLiveRegion={props.tone === 'danger' ? 'assertive' : 'polite'}
      style={[styles.banner, { borderColor, backgroundColor }]}
    >
      {props.children}
    </View>
  );
}

export function CheckboxRow(props: {
  label: string;
  checked: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  const palette = usePalette();
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={props.label}
      accessibilityState={{ checked: props.checked, disabled: props.disabled === true }}
      disabled={props.disabled === true}
      onPress={props.onToggle}
      style={[styles.checkboxRow, { opacity: props.disabled ? 0.55 : 1 }]}
    >
      <View
        style={[
          styles.checkboxBox,
          {
            borderColor: props.checked ? palette.primary : palette.border,
            backgroundColor: props.checked ? palette.primary : palette.background,
          },
        ]}
      >
        {props.checked ? <Text style={{ color: palette.primaryText, fontWeight: '700' }}>✓</Text> : null}
      </View>
      <Text style={[styles.body, { color: palette.text, flex: 1 }]}>{props.label}</Text>
    </Pressable>
  );
}
