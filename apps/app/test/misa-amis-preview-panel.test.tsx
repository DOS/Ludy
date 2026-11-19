// SPDX-License-Identifier: AGPL-3.0-only
// What would be sent to MISA AMIS on the screen (#3901), rendered on the server: the panel offers the seven voucher kinds and a button and makes no call until the button is pressed; the result lists each voucher by
// Ludy's number with its AMIS type, lines and total, names a blocker by its code (never a name or an invoice), says plainly that nothing is matched with AMIS yet and that nothing was sent, and shows the choices Ludy made.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MisaAmisBlockerNotes, MisaAmisPreview } from '@crove/kernel-contract';

const cache = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient, calls: [] as string[] }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  cache.current = new QC();
  const client = new Proxy({}, { get: () => new Proxy({}, { get: (_t, prop: string) => () => cache.calls.push(prop) }) });
  return { client, errorMessage: (e: unknown) => String(e), orpc: {}, queryClient: cache.current };
});

const { MisaAmisPreviewPanel, MisaAmisPreviewResult } = await import('../src/components/misa-amis-preview-panel.tsx');
const { I18nProvider } = await import('../src/i18n/provider.tsx');
const { setActiveLocale } = await import('../src/i18n/runtime.ts');

const wrap = (node: React.ReactNode, locale: 'vi' | 'en') => {
  setActiveLocale(locale);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache.current}>
      <I18nProvider>{node}</I18nProvider>
    </QueryClientProvider>,
  );
};

const ID = '0192f0a1-2b3c-7d4e-8f50-6172839a4b5d';
const result: MisaAmisPreview = {
  kind: 'cash_payment',
  vouchers: 2,
  ready: 1,
  blocked: 1,
  checkedAgainstAmis: false,
  purchasePurpose: '1',
  more: false,
  digest: 'c'.repeat(64),
  items: [
    { sourceId: ID, voucherNo: 'CRPC202600012', amisType: 4, reftype: 1020, reasonTypeId: 24, parts: 1, lines: 2, total: '1685000.5', blockers: [], blockersMore: 0 },
    { sourceId: '0192f0a1-2b3c-7d4e-8f50-6172839a4b5e', voucherNo: 'CRPC202600013', amisType: 4, reftype: 1020, reasonTypeId: 23, parts: 3, lines: 1200, total: '0', blockers: [{ code: 'item_code_unknown', lineNo: 4 }, { code: 'no_lines', lineNo: null }], blockersMore: 7 },
  ],
};

describe('what would be sent to MISA AMIS on the screen (#3901)', () => {
  beforeEach(() => {
    cache.calls.length = 0;
  });

  it('offers the seven kinds and a button, and calls nothing until the button is pressed', () => {
    const html = wrap(<MisaAmisPreviewPanel legalEntityId={ID} />, 'en');
    expect(html).toContain('data-testid="misa-amis-preview"');
    expect(html).toContain('See what would be sent to MISA AMIS');
    for (const kind of ['Purchases of services', 'Purchases of goods into stock', 'Sales', 'Cash receipts', 'Cash payments', 'Bank credits', 'Bank debits']) expect(html).toContain(kind);
    expect(html).toContain('data-testid="misa-amis-preview-run"');
    expect(html).not.toContain('misa-amis-preview-result');
    expect(cache.calls).toEqual([]);
  });

  it('ties every field to a visible label', () => {
    const html = wrap(<MisaAmisPreviewPanel legalEntityId={ID} />, 'en');
    for (const id of html.match(/<label[^>]*for="([^"]+)"/g) ?? []) expect(html).toContain(`id="${/for="([^"]+)"/.exec(id)?.[1]}"`);
    expect(html).toContain('From');
    expect(html).toContain('To');
  });

  it('lists each voucher with its number, type, lines and total; names blockers by code; says nothing is matched or sent', () => {
    const html = wrap(<MisaAmisPreviewResult result={result} />, 'en');
    expect(html).toContain('2 vouchers: 1 can be sent, 1 have something to fix.');
    expect(html).toContain('CRPC202600012');
    expect(html).toContain('AMIS voucher type 4');
    expect(html).toContain('2 lines');
    expect(html).toContain('AMIS reftype 1020, reason 24');
    expect(html).toContain('sent in 3 parts (over 500 lines)');
    expect(html).toContain('AMIS item code missing');
    expect(html).toContain('No lines');
    expect(html).toContain('#4');
    expect(html).toContain('and 7 more');
    expect(html).toContain('Not matched with AMIS yet');
    expect(html).toContain('Nothing has been sent to MISA.');
    expect(html).toContain('are Ludy’s own and are not confirmed with MISA yet');
    expect(html).not.toContain('are confirmed with MISA');
    // A blocked voucher shows no total.
    expect(html.match(/data-testid="misa-amis-preview-blocker"/g)).toHaveLength(2);
  });

  it('says so when the period is empty or holds more than one view shows', () => {
    expect(wrap(<MisaAmisPreviewResult result={{ ...result, vouchers: 0, ready: 0, blocked: 0, items: [] }} />, 'en')).toContain('There is nothing in this period for this kind.');
    expect(wrap(<MisaAmisPreviewResult result={{ ...result, vouchers: 0, ready: 0, blocked: 0, items: [], more: true }} />, 'en')).toContain('Choose a shorter period');
    expect(wrap(<MisaAmisPreviewResult result={{ ...result, more: true }} />, 'en')).toContain('misa-amis-preview-more');
  });

  it('is in Vietnamese with full diacritics', () => {
    const html = wrap(<MisaAmisPreviewResult result={result} />, 'vi');
    expect(html).toContain('2 chứng từ: 1 gửi được, 1 còn điểm cần sửa.');
    expect(html).toContain('Thiếu mã hàng AMIS');
    expect(html).toContain('Chưa đối chiếu với AMIS');
    expect(html).toContain('Chưa gửi gì sang MISA.');
  });
});

describe("the accounting coworker's notes on the blockers (#3904, S5 of #3854)", () => {
  const NOTES: MisaAmisBlockerNotes = {
    ai: 'used',
    notes: [
      { code: 'item_code_unknown', text: 'The line has no AMIS item code: type the AMIS item code in the preview.' },
      { code: 'vat_rate_unmapped', text: 'The VAT rate is not one AMIS takes: fix it in Ludy.' },
    ],
  };
  const withoutNotes = (html: string) => html.replace(/<div class="mb-2 rounded-md border border-border p-2" data-testid="misa-amis-preview-notes">.*?<\/ul><\/div>/s, '');

  it('shows a note beside each kind that is on the list, and none for a kind that is not (vat_rate_unmapped is not on this list)', () => {
    const html = wrap(<MisaAmisPreviewResult result={result} notes={NOTES} />, 'en');
    expect(html).toContain('data-testid="misa-amis-preview-notes"');
    expect(html.match(/data-testid="misa-amis-preview-note"/g)).toHaveLength(1);
    expect(html).toContain('type the AMIS item code in the preview');
    expect(html).not.toContain('fix it in Ludy');
    expect(html).toContain("&#x27;s notes on each kind of problem");
  });

  it('never changes the list: with the notes taken out the markup is the markup with no notes at all', () => {
    const plain = wrap(<MisaAmisPreviewResult result={result} />, 'en');
    const noted = wrap(<MisaAmisPreviewResult result={result} notes={NOTES} />, 'en');
    expect(withoutNotes(noted)).toBe(plain);
    expect(wrap(<MisaAmisPreviewResult result={result} notes={{ ai: 'off', notes: [] }} />, 'en')).toBe(plain);
    expect(wrap(<MisaAmisPreviewResult result={result} notes={{ ai: 'none', notes: [] }} />, 'en')).toBe(plain);
  });

  it('says why there are no notes when the coworker is busy, out of budget or could not word them, and keeps the list', () => {
    for (const ai of ['busy', 'budget', 'failed'] as const) {
      const html = wrap(<MisaAmisPreviewResult result={result} notes={{ ai, notes: [] }} />, 'en');
      expect(html).toContain('data-testid="misa-amis-preview-notes-ai-state"');
      expect(html).not.toContain('data-testid="misa-amis-preview-notes"');
      expect(html.match(/data-testid="misa-amis-preview-blocker"/g)).toHaveLength(2);
    }
  });

  it('shows no note for a kind whose rows are all under "and N more" (only the rows on screen count)', () => {
    const quiet = { ...result.items[0] as MisaAmisPreview['items'][number], blockers: [] };
    const hidden = { ...(result.items[1] as MisaAmisPreview['items'][number]), sourceId: '0192f0a1-2b3c-7d4e-8f50-6172839a4b99' };
    const many: MisaAmisPreview = { ...result, items: [...Array.from({ length: 20 }, (_v, i) => ({ ...quiet, sourceId: `0192f0a1-2b3c-7d4e-8f50-6172839a4b${String(i).padStart(2, '0')}` })), hidden] };
    const html = wrap(<MisaAmisPreviewResult result={many} notes={NOTES} />, 'en');
    expect(html).not.toContain('data-testid="misa-amis-preview-notes"');
  });

  it('is in Vietnamese too', () => {
    const html = wrap(<MisaAmisPreviewResult result={result} notes={{ ai: 'used', notes: [{ code: 'item_code_unknown', text: 'Dòng chưa có mã hàng AMIS: hãy nhập mã hàng AMIS trong phần xem trước.' }] }} />, 'vi');
    expect(html).toContain('Ghi chú của');
    expect(html).toContain('hãy nhập mã hàng AMIS trong phần xem trước');
    expect(wrap(<MisaAmisPreviewResult result={result} notes={{ ai: 'busy', notes: [] }} />, 'vi')).toContain('danh sách bên dưới đứng một mình');
  });
});
