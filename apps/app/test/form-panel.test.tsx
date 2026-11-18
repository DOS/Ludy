// SPDX-License-Identifier: AGPL-3.0-only
// The shared form panel (#3606): Cmd or Ctrl plus Enter saves, but not in the middle of an IME composition; the panel asks before it
// drops typed input; and a panel without a form (a result) never asks. The panel's portal renders nothing on the server, so its frame is
// read from the source, as packages/ui/test/sheet.test.ts does.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isSaveShortcut } from '../src/components/form-panel.tsx';
import { catalog } from '../src/i18n/runtime.ts';

const source = readFileSync(new URL('../src/components/form-panel.tsx', import.meta.url), 'utf8');
const press = (more: Partial<Parameters<typeof isSaveShortcut>[0]> = {}) => ({ key: 'Enter', metaKey: false, ctrlKey: false, isComposing: false, ...more });

describe('isSaveShortcut', () => {
  it('is Cmd+Enter or Ctrl+Enter', () => {
    expect(isSaveShortcut(press({ metaKey: true }))).toBe(true);
    expect(isSaveShortcut(press({ ctrlKey: true }))).toBe(true);
  });
  it('is not a plain Enter, another key, or a composition', () => {
    expect(isSaveShortcut(press())).toBe(false);
    expect(isSaveShortcut(press({ key: 's', ctrlKey: true }))).toBe(false);
    expect(isSaveShortcut(press({ ctrlKey: true, isComposing: true }))).toBe(false);
  });
});

describe('FormPanel closing', () => {
  it('asks before Escape, the close button or the backdrop drops typed input, and only for a form', () => {
    expect(source).toContain('if (dirty && onSubmit) setAsking(true)');
    expect(source).toContain('requestClose()');
    expect(source).toContain('data-testid="panel-discard"');
  });
  it('hands the cancel button the same close, so Cancel asks like Escape', () => {
    expect(source).toContain("typeof footer === 'function' ? footer(requestClose) : footer");
  });
  it('leaves Cmd+Enter to a field that already took the key', () => {
    expect(source).toContain('event.defaultPrevented ||');
  });
  it('gives focus back to the element that opened it when it goes away', () => {
    expect(source).toContain('document.activeElement');
    expect(source).toContain('opener.focus()');
  });
  it('locks the fields while a save is on its way and does not save or discard then', () => {
    expect(source).toContain('<fieldset disabled={busy}');
    expect(source).toContain('if (!busy && !asking) event.currentTarget.requestSubmit()');
    expect(source).toContain('variant="destructive" disabled={busy}');
  });
  it('can be told what to give focus back to', () => {
    expect(source).toContain('opener: openerProp');
  });
  it('puts focus on "keep editing" and back on the first field afterwards', () => {
    expect(source).toMatch(/<Button type="button" autoFocus onClick=\{keepEditing\}>/);
    expect(source).toContain("querySelector<HTMLElement>('input:not([type=hidden]), textarea, select')?.focus()");
  });
  it('says so in both languages', () => {
    for (const locale of ['vi', 'en'] as const) {
      const common = catalog(locale).common;
      expect(common.discardAsk.length).toBeGreaterThan(10);
      expect(common.discard.length).toBeGreaterThan(0);
      expect(common.keepEditing.length).toBeGreaterThan(0);
    }
    expect(catalog('vi').common.keepEditing).toBe('Tiếp tục nhập');
  });
});
