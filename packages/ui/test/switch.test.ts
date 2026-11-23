// SPDX-License-Identifier: AGPL-3.0-only
// Switch primitive (DESIGN.md 3.1, 3.3, 7): Base UI role="switch" with field-border contrast on the unchecked track,
// primary fill when checked, focus-visible ring on the track, and a 44px touch target under the phone breakpoint.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Switch } from '../src/components/switch.tsx';

const html = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(Switch, props));

describe('Switch', () => {
  it('renders role="switch", aria-checked, and accessible label', () => {
    const on = html({ checked: true, 'aria-label': 'Use Finance' });
    expect(on).toContain('role="switch"');
    expect(on).toContain('aria-checked="true"');
    expect(on).toContain('aria-label="Use Finance"');
    expect(on).toContain('data-checked=""');

    const off = html({ checked: false, 'aria-label': 'Use Finance' });
    expect(off).toContain('role="switch"');
    expect(off).toContain('aria-checked="false"');
    expect(off).toContain('data-unchecked=""');
  });

  it('marks disabled switches with aria-disabled and data-disabled', () => {
    const disabled = html({ checked: false, disabled: true, 'aria-label': 'Use HR' });
    expect(disabled).toContain('aria-disabled="true"');
    expect(disabled).toContain('data-disabled=""');
  });

  it('keeps a 44px hit target on mobile and WCAG 1.4.11 field-border on the track', () => {
    const markup = html({ checked: false, 'aria-label': 'Use eSign' });
    expect(markup).toContain('max-md:min-h-11');
    expect(markup).toContain('max-md:min-w-11');
    expect(markup).toContain('border-field-border');
    expect(markup).toContain('group-focus-visible/switch:ring-ring/50');
  });
});
