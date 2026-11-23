// SPDX-License-Identifier: AGPL-3.0-only
// Input and NativeSelect primitives (DESIGN.md 4.2, 7): compact desktop heights (h-8 / h-7) and >= 44px touch targets
// under the phone breakpoint (max-md:min-h-11) built into the primitives themselves.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Input } from '../src/components/input.tsx';
import { NativeSelect, NativeSelectOption } from '../src/components/native-select.tsx';

describe('Input and NativeSelect mobile touch parity', () => {
  it('enforces max-md:min-h-11 on Input while keeping desktop h-8', () => {
    const markup = renderToStaticMarkup(createElement(Input, { 'aria-label': 'Tax code' }));
    expect(markup).toContain('data-slot="input"');
    expect(markup).toContain('h-8');
    expect(markup).toContain('max-md:min-h-11');
  });

  it('enforces max-md:min-h-11 directly on the select element for both default and sm sizes', () => {
    for (const size of ['default', 'sm'] as const) {
      const markup = renderToStaticMarkup(
        createElement(
          NativeSelect,
          { size, 'aria-label': 'Status' },
          createElement(NativeSelectOption, { value: 'all' }, 'All'),
        ),
      );
      const selectTag = /<select [^>]*>/.exec(markup)?.[0] ?? '';
      expect(selectTag, size).toContain('h-8');
      expect(selectTag, size).toContain('max-md:min-h-11');
      expect(selectTag, size).toContain('data-[size=sm]:h-7');
    }
  });
});
