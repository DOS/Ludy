// SPDX-License-Identifier: AGPL-3.0-only
// SegmentedControl primitive (DESIGN.md 3.3, 4.6, 7): radiogroup semantics with arrow-key roving focus,
// semantic surface tokens, 6px/4.8px radii, and 44x44px hit targets under the phone breakpoint.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SegmentedControl, SegmentedControlItem } from '../src/components/segmented-control.tsx';

function renderControl(value = 'light', options: { disabled?: boolean; size?: 'sm' | 'default' } = {}) {
  return renderToStaticMarkup(
    createElement(
      SegmentedControl,
      {
        value,
        onValueChange: () => undefined,
        'aria-label': 'Theme',
        ...(options.disabled !== undefined ? { disabled: options.disabled } : {}),
        ...(options.size !== undefined ? { size: options.size } : {}),
      },
      createElement(SegmentedControlItem, { value: 'light', 'aria-label': 'Light', title: 'Light' }, 'L'),
      createElement(SegmentedControlItem, { value: 'dark', 'aria-label': 'Dark', title: 'Dark' }, 'D'),
      createElement(SegmentedControlItem, { value: 'system', 'aria-label': 'System', title: 'System' }, 'S'),
    ),
  );
}

describe('SegmentedControl', () => {
  it('renders role="radiogroup", role="radio", aria-checked, and roving tabIndex', () => {
    const html = renderControl('dark');
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Theme"');
    expect(html).toContain('data-slot="segmented-control"');
    expect(html).toMatch(/<button[^>]*role="radio"[^>]*aria-checked="false"[^>]*tabindex="-1"[^>]*data-value="light"/i);
    expect(html).toMatch(/<button[^>]*role="radio"[^>]*aria-checked="true"[^>]*tabindex="0"[^>]*data-value="dark"/i);
    expect(html).toMatch(/<button[^>]*role="radio"[^>]*aria-checked="false"[^>]*tabindex="-1"[^>]*data-value="system"/i);
  });

  it('uses semantic tokens, 6px/4.8px radii, and >= 44px mobile touch targets', () => {
    const html = renderControl('light', { size: 'sm' });
    expect(html).toContain('bg-muted');
    expect(html).toContain('bg-background');
    expect(html).toContain('text-foreground');
    expect(html).toContain('shadow-xs');
    expect(html).toContain('rounded-lg');
    expect(html).toContain('rounded-md');
    expect(html).toContain('max-md:min-h-11');
    expect(html).toContain('max-md:min-w-11');
    expect(html).toContain('focus-visible:ring-ring/50');
  });

  it('propagates disabled state to the group and items', () => {
    const html = renderControl('light', { disabled: true });
    expect(html).toContain('aria-disabled="true"');
    expect(html.match(/disabled=""/g)?.length).toBe(3);
  });

  it('throws when SegmentedControlItem is rendered outside SegmentedControl', () => {
    expect(() => renderToStaticMarkup(createElement(SegmentedControlItem, { value: 'a' }, 'A'))).toThrow(
      'SegmentedControlItem must be used inside SegmentedControl',
    );
  });
});
