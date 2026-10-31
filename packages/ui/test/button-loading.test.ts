// SPDX-License-Identifier: AGPL-3.0-only
// A working button keeps its label and width, shows a spinner and says it is busy (DESIGN.md 4.1, #2116). The package
// runs its tests without a DOM, so the markup is read: the label stays in the flow (invisible, not removed or hidden,
// so it is the same width and still the button's name), and the spinner is drawn over it out of the flow.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Button } from '../src/components/button.tsx';

const html = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(Button, props, 'Save'));

// The element opening tag that carries a given attribute marker, as the attributes between its angle brackets.
const tag = (markup: string, marker: string) => [...markup.matchAll(/<[a-z]+ [^>]*>/g)].find((m) => m[0].includes(marker))?.[0] ?? '';

// The accessible name: the text of what a screen reader reaches, so nothing inside an aria-hidden element.
const nameOf = (markup: string) =>
  markup
    .replace(/<svg[^>]*aria-hidden="true"[^>]*>.*?<\/svg>/g, '')
    .replace(/<[^>]+>/g, '')
    .trim();

describe('Button loading', () => {
  it('says it is busy and is disabled while loading, and neither when it is not', () => {
    const busy = tag(html({ loading: true }), 'data-slot="button"');
    expect(busy).toContain('aria-busy="true"');
    expect(busy).toContain('data-loading=""');
    expect(busy).toContain(' disabled=""');

    const idle = tag(html({ loading: false }), 'data-slot="button"');
    expect(idle).not.toContain('aria-busy');
    expect(idle).not.toContain('data-loading');
    expect(idle).not.toContain(' disabled=""');
    expect(tag(html({}), 'data-slot="button"')).not.toContain('aria-busy');
  });

  it('keeps a disabled button disabled once it stops loading', () => {
    expect(tag(html({ loading: false, disabled: true }), 'data-slot="button"')).toContain(' disabled=""');
    expect(tag(html({ loading: true, disabled: true }), 'data-slot="button"')).toContain(' disabled=""');
  });

  it('hides the spinner from assistive tech and leaves the name as the label', () => {
    const markup = html({ loading: true });
    const spinner = tag(markup, 'data-slot="button-spinner"');
    expect(spinner).toContain('aria-hidden="true"');
    expect(markup).not.toContain('role="status"');
    expect(markup).not.toContain('aria-label');
    expect(nameOf(markup)).toBe('Save');
    expect(html({ loading: false })).not.toContain('button-spinner');
  });

  it('keeps the label in the flow, so the width is the same, and puts the spinner out of it', () => {
    const markup = html({ loading: true });
    const label = tag(markup, 'data-slot="button-label"');
    // Invisible by opacity only: not `hidden`, `invisible`, `sr-only` or absolute, which would drop its width or its name.
    expect(label).toContain('opacity-0');
    for (const out of ['hidden', 'invisible', 'sr-only', 'absolute', 'display:none']) expect(label).not.toContain(out);
    // The label lays out its children as the button does, so an icon beside the words keeps its gap.
    expect(label).toContain('gap-[inherit]');
    expect(tag(markup, 'data-slot="button-spinner"')).toContain('absolute');
    expect(tag(markup, 'data-slot="button"')).toContain('relative');

    // The button's own box does not change: the same padding, height and gap with and without loading.
    for (const size of ['default', 'xs', 'sm', 'lg', 'icon'] as const) {
      const sizing = (loading: boolean) => (/class="([^"]*)"/.exec(tag(html({ size, loading }), 'data-slot="button"'))?.[1] ?? '').split(' ').filter((c) => c !== 'relative');
      expect(sizing(true)).toEqual(sizing(false));
    }
  });

  it('draws the spinner at the size of the button, not at a size of its own', () => {
    for (const size of ['default', 'xs', 'sm', 'lg'] as const) {
      const spinner = tag(html({ loading: true, size }), 'data-slot="button-spinner"');
      expect(spinner).not.toMatch(/size-/);
    }
  });
});
