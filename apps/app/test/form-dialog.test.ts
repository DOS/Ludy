// SPDX-License-Identifier: AGPL-3.0-only
// The shared small form dialog (#3608): the same habits as the side panel, read from the source because the dialog portals to the body, which the
// server does not render (as form-panel.test.tsx does).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';

const source = readFileSync(new URL('../src/components/form-dialog.tsx', import.meta.url), 'utf8');

describe('FormDialog', () => {
  it('is the shared Dialog, not a second pattern', () => {
    expect(source).toContain("from '@ludy/ui/components/dialog'");
    expect(source).toContain('<DialogContent closeLabel={root(\'common.close\')}>');
  });
  it('gives focus back to the button that opened it, and closes on Escape or the close button', () => {
    expect(source).toContain('document.activeElement');
    expect(source).toContain('opener.focus()');
    expect(source).toContain('if (!open) requestClose()');
  });
  it('does not drop typed input on a stray click, and asks before Escape or Cancel does', () => {
    expect(source).toContain('disablePointerDismissal');
    expect(source).toContain('if (dirty) setAsking(true)');
    expect(source).toContain('data-testid="dialog-discard"');
    expect(source).toContain('<Button type="button" autoFocus onClick={keepEditing}>');
  });
  it('saves with Cmd or Ctrl plus Enter, and locks the fields while the request is on its way', () => {
    expect(source).toContain('isSaveShortcut(');
    expect(source).toContain('if (!busy && !asking && !submitDisabled) event.currentTarget.requestSubmit()');
    expect(source).toContain('<fieldset disabled={busy}');
  });
  it('does not save with the shortcut while the save button is off', () => {
    expect(source).toContain('!submitDisabled');
    expect(source).toContain('export function useLive()');
  });
  it('lets a prompt with a form of its own sit under the form, inside the dialog', () => {
    expect(source).toContain('{outside}');
  });
  it('uses words that exist in both languages', () => {
    for (const locale of ['vi', 'en'] as const) {
      const common = catalog(locale).common;
      for (const key of ['cancel', 'close', 'discard', 'discardAsk', 'keepEditing'] as const) expect(common[key].length).toBeGreaterThan(0);
    }
  });
});
