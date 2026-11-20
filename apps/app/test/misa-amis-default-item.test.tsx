// SPDX-License-Identifier: AGPL-3.0-only
// The default item of a MISA connection under the preview's item code field (#4124, S3b of #4103), rendered on the server: what is kept (or that nothing is), the buttons only for an owner or admin and only
// when they would change something, the code shown as text, and the same wording in Vietnamese and English.
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

const { MisaAmisDefaultItem, defaultItemOffer } = await import('../src/components/misa-amis-default-item.tsx');

const ID = '0192f0a1-2b3c-7d4e-8f50-6172839a4b5d';
const wrap = (node: React.ReactNode, locale: 'vi' | 'en' = 'en') =>
  renderToStaticMarkup(
    <QueryClientProvider client={cache.current}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
const item = (over: Partial<Parameters<typeof MisaAmisDefaultItem>[0]> = {}, locale: 'vi' | 'en' = 'en') =>
  wrap(<MisaAmisDefaultItem connectionId={ID} role="service" typed="" saved={null} canManage {...over} />, locale);

describe('the default item of a connection (#4124)', () => {
  // The buttons stay on the screen and are disabled when they would change nothing, so focus is not lost when a click has done its work.
  const enabled = (html: string, testid: string) => {
    const tag = html.match(new RegExp(`<button[^>]*data-testid="${testid}"[^>]*>`))?.[0];
    return tag === undefined ? null : !tag.includes(' disabled=""');
  };

  it('says when nothing is kept and offers to keep only what has been typed', () => {
    const empty = item();
    expect(empty).toContain('No default code');
    expect(enabled(empty, 'misa-amis-default-service-save')).toBe(false);
    expect(enabled(empty, 'misa-amis-default-service-clear')).toBe(false);
    const typed = item({ typed: ' DV_CHUNG ' });
    expect(enabled(typed, 'misa-amis-default-service-save')).toBe(true);
    expect(typed).toContain('Keep as default');
    // The state text is a status region, announced when it changes.
    expect(typed).toMatch(/<span role="status"[^>]*data-testid="misa-amis-default-service-state"/);
  });

  it('shows the kept code as text and offers to clear it, and to replace it only when the field holds another code', () => {
    const kept = item({ saved: 'DV_CHUNG', typed: 'DV_CHUNG' });
    expect(kept).toContain('Default code: DV_CHUNG');
    expect(enabled(kept, 'misa-amis-default-service-clear')).toBe(true);
    expect(enabled(kept, 'misa-amis-default-service-save')).toBe(false);
    expect(enabled(item({ saved: 'DV_CHUNG', typed: 'DV_KHAC' }), 'misa-amis-default-service-save')).toBe(true);
    const markup = item({ saved: '<img src=x onerror=alert(1)>' });
    expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(markup).not.toContain('<img');
  });

  it('shows what is kept to everyone and the buttons to an owner or admin alone, for either role of line', () => {
    const member = item({ canManage: false, saved: 'BH_CHUNG', typed: 'KHAC', role: 'sales' });
    expect(member).toContain('Default code: BH_CHUNG');
    expect(member).toContain('data-testid="misa-amis-default-sales-state"');
    expect(member).not.toContain('<button');
  });

  it('rules: what the buttons offer for the code in the field', () => {
    expect(defaultItemOffer('', null)).toEqual({ canSave: false, canClear: false });
    expect(defaultItemOffer('   ', null)).toEqual({ canSave: false, canClear: false });
    expect(defaultItemOffer('A', null)).toEqual({ canSave: true, canClear: false });
    expect(defaultItemOffer(' A ', 'A')).toEqual({ canSave: false, canClear: true });
    expect(defaultItemOffer('B', 'A')).toEqual({ canSave: true, canClear: true });
    expect(defaultItemOffer('', 'A')).toEqual({ canSave: false, canClear: true });
  });

  it('speaks Vietnamese and has the same keys in both languages', () => {
    expect(item({ saved: 'DV_CHUNG' }, 'vi')).toContain('Mã mặc định: DV_CHUNG');
    const keys = (o: object, p = ''): string[] => Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' && v !== null ? keys(v, `${p}${k}.`) : [`${p}${k}`]));
    expect(keys(viMessages.misaAmisPreview).sort()).toEqual(keys(en.misaAmisPreview).sort());
  });
});
