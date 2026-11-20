// SPDX-License-Identifier: AGPL-3.0-only
// The units a person can give a MISA ASP name (#4125), rendered on the server: each row says what the check found, has a labelled field and two buttons that are on only when they would change something,
// the unit text is shown as text, and both languages have the same words.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';

const cache = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  cache.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { client: node([]), orpc: node([]), queryClient: cache.current, errorMessage: (e: unknown) => String(e) };
});

const { UnitRow, unitNameOffer } = await import('../src/components/misa-amis-unit-names.tsx');

const wrap = (node: React.ReactNode, locale: 'vi' | 'en' = 'en') =>
  renderToStaticMarkup(
    <QueryClientProvider client={cache.current}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
const row = (over: Partial<Parameters<typeof UnitRow>[0]['row']> = {}, locale: 'vi' | 'en' = 'en') => wrap(<UnitRow row={{ unit: 'chiếc', state: 'unknown', alias: null, ...over }} busy={false} onKeep={() => undefined} />, locale);

const enabled = (html: string, testid: string) => {
  const tag = html.match(new RegExp(`<button[^>]*data-testid="${testid}"[^>]*>`))?.[0];
  return tag === undefined ? null : !tag.includes(' disabled=""');
};

describe('the units that need a MISA ASP name (#4125)', () => {
  it('says what the check found for the unit, with a labelled field and buttons that are off while they would change nothing', () => {
    const unknown = row();
    expect(unknown).toContain('The unit &quot;chiếc&quot; is not in the MISA ASP unit list');
    expect(unknown).toMatch(/<label[^>]*class="sr-only"[^>]*>The MISA ASP name of the unit chiếc<\/label>/);
    expect(enabled(unknown, 'misa-amis-unit-save')).toBe(false);
    expect(enabled(unknown, 'misa-amis-unit-clear')).toBe(false);
    expect(row({ state: 'ambiguous' })).toContain('more than once');
    const matched = row({ state: 'matched', alias: 'Cái' });
    expect(matched).toContain('is matched through the name typed here');
    expect(matched).toContain('value="Cái"');
    expect(enabled(matched, 'misa-amis-unit-clear')).toBe(true);
  });

  it('shows the unit as text, never as markup', () => {
    const html = row({ unit: '<img src=x onerror=alert(1)>' });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('rules: what the buttons offer for the name in the field', () => {
    expect(unitNameOffer('', null)).toEqual({ canSave: false, canClear: false });
    expect(unitNameOffer('  ', null)).toEqual({ canSave: false, canClear: false });
    expect(unitNameOffer('Cái', null)).toEqual({ canSave: true, canClear: false });
    expect(unitNameOffer(' Cái ', 'Cái')).toEqual({ canSave: false, canClear: true });
    expect(unitNameOffer('Hộp', 'Cái')).toEqual({ canSave: true, canClear: true });
  });

  it('speaks Vietnamese and has the same keys in both languages', () => {
    expect(row({}, 'vi')).toContain('chưa có trong danh sách đơn vị tính của MISA ASP');
    const keys = (o: object, p = ''): string[] => Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' && v !== null ? keys(v, `${p}${k}.`) : [`${p}${k}`]));
    expect(keys(viMessages.misaAmisUnits).sort()).toEqual(keys(en.misaAmisUnits).sort());
  });
});
