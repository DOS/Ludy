// SPDX-License-Identifier: AGPL-3.0-only
// The note on a pending marketplace settlement or payout in the Inbox card (#4389), rendered on the server with the answer of marketplace.proposalNote seeded in the cache: nothing for a proposal that is no
// marketplace one (a null answer), the note and the Uncertain (#2520) points in Vietnamese and English, the AI wording marked as such only when the model wrote it, no button, and no call other than the read.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarketplaceProposalNote as Note } from '@ludy/kernel-contract';

const cache = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient, calls: [] as string[] }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  cache.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  const client = new Proxy({}, { get: () => new Proxy({}, { get: (_t, prop: string) => () => cache.calls.push(prop) }) });
  return { orpc: node([]), client, queryClient: cache.current, errorMessage: (e: unknown) => String(e) };
});
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    useParams: () => ({ slug: 'acme' }),
    Link: ({ children, to, params }: { children?: ReactNode; to: string; params?: Record<string, string> }) =>
      createElement('a', { href: to.replace(/\$(\w+)/g, (_match, name: string) => params?.[name] ?? '') }, children),
  };
});


const { MarketplaceProposalNote } = await import('../src/components/marketplace-proposal-note.tsx');
const { I18nProvider } = await import('../src/i18n/provider.tsx');
const { setActiveLocale } = await import('../src/i18n/runtime.ts');

const PROPOSAL = '00000000-0000-4000-8000-0000000000d1';
const NOTE = (over: Partial<Note> = {}): Note => ({
  ai: 'used',
  kind: 'payout',
  figures: 'Sàn đã trả: 304.000 đồng; phí sàn giữ lại (331): 28.000 đồng. Bút toán ghi tiền nhận về và bù trừ khoản phải thu từ sàn.',
  note: 'Sàn giữ lại phí và thuế trước khi chuyển tiền; xem các con số và dòng bút toán bên cạnh.',
  uncertain: [
    { key: 'receivable', text: 'Khoản phải thu từ sàn ghi vào 131.' },
    { key: 'fee_netting', text: 'Phí sàn bù trừ khi nhận tiền.' },
  ],
  ...over,
});

function render(answer: Note | null, locale: 'vi' | 'en' = 'vi'): string {
  setActiveLocale(locale);
  cache.current.setQueryData(['marketplace', 'proposalNote'], answer);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache.current}>
      <I18nProvider>
        <MarketplaceProposalNote proposalId={PROPOSAL} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('the note on a marketplace proposal in the Inbox card (#4389)', () => {
  beforeEach(() => {
    cache.current.clear();
    cache.calls.length = 0;
  });

  it('shows nothing for a proposal that is no marketplace settlement or payout (the answer is null)', () => {
    expect(render(null)).toBe('');
  });

  it('shows the note, the Uncertain points chosen by code and the AI wording mark, in Vietnamese and in English', () => {
    const vi = render(NOTE());
    for (const text of ['data-testid="marketplace-proposal-note"', 'Ly ghi chú về bút toán này', 'Sàn đã trả: 304.000 đồng', 'Sàn giữ lại phí và thuế trước khi chuyển tiền', 'viết bằng lời, không kèm con số', 'Điểm còn chưa chắc', 'Khoản phải thu từ sàn ghi vào 131.', 'Phí sàn bù trừ khi nhận tiền.', 'không phải do AI']) expect(vi).toContain(text);
    const en = render(NOTE({ figures: 'The platform paid: 304,000 dong.', note: 'The platform kept fees and tax before paying out.', uncertain: [{ key: 'receivable', text: 'Receivable on 131.' }] }), 'en');
    for (const text of ['note on this entry', 'The platform paid: 304,000 dong.', 'The platform kept fees and tax before paying out.', 'wrote this in words, with no figures', 'Points not yet settled', 'Receivable on 131.', 'not by AI']) expect(en).toContain(text);
  });

  it('shows the figures text and the Uncertain list, with no model words and no AI mark, when the model did not write the note', () => {
    for (const ai of ['off', 'busy', 'budget', 'failed'] as const) {
      const html = render(NOTE({ ai, note: '' }));
      expect(html, ai).toContain('Sàn đã trả: 304.000 đồng');
      expect(html, ai).not.toContain('marketplace-proposal-note-text');
      expect(html, ai).not.toContain('viết bằng lời');
      expect(html, ai).toContain('Khoản phải thu từ sàn ghi vào 131.');
    }
  });

  it('offers no button or link, shows no empty text block, and asks the server for nothing but the read', () => {
    const html = render(NOTE({ ai: 'off', figures: '', note: '', uncertain: [] }));
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('marketplace-proposal-figures');
    expect(html).not.toContain('marketplace-proposal-note-text');
    expect(html).not.toContain('marketplace-proposal-uncertain');
    expect(cache.calls).toEqual([]);
  });
});
