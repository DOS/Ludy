// SPDX-License-Identifier: AGPL-3.0-only
// The Sheet (DESIGN.md 4.5): a panel at the right edge, full screen on a phone, with a fixed header, a scrolling body and a fixed footer.
// The package runs its tests without a DOM and a portal renders nothing on the server, so the parts that render in place are read as
// markup and the panel's frame is read from its source: the classes that pin it to the right edge, make it full width up to sm, and keep the
// close button named by the caller.
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Sheet, SheetBody, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '../src/components/sheet.tsx';

const source = readFileSync(new URL('../src/components/sheet.tsx', import.meta.url), 'utf8');

describe('Sheet', () => {
  it('draws no panel and no backdrop while closed', () => {
    const closed = renderToStaticMarkup(createElement(Sheet, { open: false }, createElement(SheetContent, { closeLabel: 'Đóng' }, 'Panel')));
    expect(closed).not.toContain('Panel');
    expect(closed).not.toContain('sheet-overlay');
  });

  it('keeps the header and the footer in view and scrolls only the body', () => {
    expect(renderToStaticMarkup(createElement(SheetHeader, null, 'Head'))).toContain('data-slot="sheet-header"');
    expect(renderToStaticMarkup(createElement(SheetBody, null, 'Body'))).toMatch(/class="[^"]*flex-1[^"]*overflow-y-auto/);
    expect(renderToStaticMarkup(createElement(SheetFooter, null, 'Foot'))).toContain('data-slot="sheet-footer"');
    // The popup is a column of exactly the viewport height, so only the body can grow past it.
    expect(source).toMatch(/flex h-dvh w-full flex-col/);
  });

  it('is pinned to the right edge, full screen on a phone and a column from sm up', () => {
    expect(source).toContain('inset-y-0 right-0');
    expect(source).toContain('w-full');
    expect(source).toContain('sm:max-w-md');
  });

  it('is a Base UI dialog, so focus is trapped, Escape closes it and focus returns to the trigger', () => {
    expect(source).toContain('@base-ui/react/dialog');
    expect(source).toMatch(/DialogPrimitive\.Popup/);
    expect(source).toMatch(/DialogPrimitive\.Close/);
  });

  it('takes the name of the close button from the caller, in the screen language', () => {
    expect(source).toContain('closeLabel: string');
    expect(source).toContain('aria-label={closeLabel}');
  });

  it('gives the header room for the close button and names its title', () => {
    expect(renderToStaticMarkup(createElement(SheetHeader, null, 'Head'))).toContain('pr-14');
    expect(typeof SheetTitle).toBe('function');
  });
});
