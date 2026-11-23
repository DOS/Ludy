// The command palette (#439) with what the org's search found (#673), rendered on the server: found entries appear
// under their own groups after the screens, and the status line says while the search runs or when it failed, in
// place of "nothing matches".
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it } from 'vitest';
import { CommandPalette, type PaletteEntry } from '../src/components/command-palette.tsx';
import { en as enMessages } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';

const t = viMessages.palette;
const none = () => {};
const entries: PaletteEntry[] = [{ id: 'go:journal', group: 'go', label: 'Sổ nhật ký', run: none }];
const found: PaletteEntry[] = [
  { id: 'entry:1', group: 'entries', label: 'Tiền điện tháng 9', detail: '15/09/2026, 1.980.000 ₫', run: none },
  { id: 'party:1', group: 'parties', label: 'Công ty Điện lực Hà Nội', detail: 'MST 0101234564', run: none },
];

const render = (props: Partial<Parameters<typeof CommandPalette>[0]>, locale: 'vi' | 'en' = 'vi') =>
  renderToStaticMarkup(
    <IntlProvider locale={locale} messages={catalog(locale)}>
      <CommandPalette entries={entries} open={false} onOpenChange={none} {...props} />
    </IntlProvider>,
  );

describe('CommandPalette with search results', () => {
  it('lists found entries in their groups, parties before entries, after the screens', () => {
    const html = render({ found });
    const order = [t.groups.go, 'Sổ nhật ký', t.groups.parties, 'Công ty Điện lực Hà Nội', 'MST 0101234564', t.groups.entries, 'Tiền điện tháng 9'].map((s) =>
      html.indexOf(s),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(html).not.toContain(t.searching);
  });

  it('says the search is running, and does not claim nothing matches meanwhile', () => {
    const html = render({ entries: [], search: 'searching' });
    expect(html).toContain(t.searching);
    expect(html).not.toContain(t.empty);
  });

  it('says the search failed', () => {
    const html = render({ entries: [], search: 'failed' });
    expect(html).toContain(t.searchFailed);
    expect(html).not.toContain(t.empty);
    expect(render({ entries: [] })).toContain(t.empty);
  });

  it('renders Recent before Go to and quick-action badges with accessible listbox/option semantics in VI and EN', () => {
    const richEntries: PaletteEntry[] = [
      { id: 'recent:/ledger', group: 'recent', label: 'Sổ sách', run: none },
      { id: 'go:journal', group: 'go', label: 'Sổ nhật ký', run: none },
      { id: 'action:new-task', group: 'actions', label: t.newTask, badge: 'Alt+Q', run: none },
      {
        id: 'action:switch-theme',
        group: 'actions',
        label: t.switchThemeAction,
        badge: 'Sáng',
        run: none,
        children: [{ id: 'theme:dark', group: 'actions', label: 'Tối', run: none }],
      },
    ];
    const viHtml = render({ entries: richEntries }, 'vi');
    const viOrder = [t.groups.recent, 'Sổ sách', t.groups.go, 'Sổ nhật ký', t.groups.actions, t.newTask, 'Alt+Q', t.switchThemeAction, 'Sáng'].map(
      (s) => viHtml.indexOf(s),
    );
    expect(viOrder.every((i) => i >= 0)).toBe(true);
    expect(viOrder).toEqual([...viOrder].sort((a, b) => a - b));
    expect(viHtml).toContain('role="combobox"');
    expect(viHtml).toContain('role="listbox"');
    expect(viHtml).toContain(`role="group" aria-label="${t.groups.recent}"`);
    expect(viHtml).toContain('role="option" aria-selected="true"');
    expect(viHtml).toContain('max-md:min-h-11');
    expect(viHtml).toContain('aria-activedescendant="');
    expect(viHtml).toContain('›');

    const enEntries: PaletteEntry[] = [
      { id: 'recent:/ledger', group: 'recent', label: 'Ledger', run: none },
      { id: 'action:new-task', group: 'actions', label: enMessages.palette.newTask, badge: 'Alt+Q', run: none },
    ];
    const enHtml = render({ entries: enEntries }, 'en');
    expect(enHtml).toContain(`role="group" aria-label="${enMessages.palette.groups.recent}"`);
    expect(enHtml).toContain(enMessages.palette.newTask);
  });
});
