// SPDX-License-Identifier: AGPL-3.0-only
// The closed columns of the deal board offer "Xem tất cả" (docs/plan/crm.md section 6: "Won and Lost show the last 30 days, with a
// link to the list for all"), rendered on the server with the board's answer seeded: Thắng and Thua each have the control with
// the stage in its accessible name, the open columns have none, and a board with no handler offers none.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { Board, PipelineStage } from '@crove/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';
import { I18nProvider } from '../src/i18n/provider.tsx';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ slug: 'acme' }),
  Link: ({ children, ...rest }: { children?: unknown }) => <a {...(rest as object)}>{children as never}</a>,
}));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return (options?: { input?: unknown }) => ({ queryKey: options?.input === undefined ? path : [...path, options.input], queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'queryKey' || prop === 'key') return (options?: { input?: unknown }) => (options?.input === undefined ? path : [...path, options.input]);
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), client: node([]), queryClient: client.current, errorMessage: (e: unknown) => String(e), apiFetch: () => Promise.reject(new Error('not fetched')) };
});

const { DealBoard } = await import('../src/components/deal-board.tsx');

const stage = (id: string, name: string, kind: PipelineStage['kind'], position: number): PipelineStage => ({ id, name, kind, position });
const board: Board = {
  columns: [
    { stage: stage('new', 'Mới', 'open', 1), count: 0, total: '0', truncated: false, cards: [] },
    { stage: stage('won', 'Thắng', 'won', 2), count: 0, total: '0', truncated: false, cards: [] },
    { stage: stage('lost', 'Thua', 'lost', 3), count: 0, total: '0', truncated: false, cards: [] },
  ],
};

function render(onShowAll: ((kind: 'won' | 'lost') => void) | undefined, locale: 'vi' | 'en' = 'vi'): string {
  client.current.setQueryData(['crm', 'deals', 'board', {}], board);
  return renderToStaticMarkup(
    <I18nProvider>
      <QueryClientProvider client={client.current}>
        <IntlProvider locale={locale} messages={catalog(locale)}>
          <DealBoard members={[]} canEdit onShowAll={onShowAll} />
        </IntlProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

const column = (html: string, name: string) => html.slice(html.indexOf(`aria-label="${name}"`) - 400, html.indexOf(`aria-label="${name}"`));

describe('the closed columns of the deal board', () => {
  it('offer "Xem tất cả" in Thắng and Thua, each named by its stage, and none in an open column', () => {
    const html = render(() => undefined);
    expect(html.match(/>Xem tất cả</g)).toHaveLength(2);
    expect(html).toContain('aria-label="Xem trong danh sách tất cả cơ hội ở giai đoạn Thắng"');
    expect(html).toContain('aria-label="Xem trong danh sách tất cả cơ hội ở giai đoạn Thua"');
    expect(column(html, 'Mới')).not.toContain('Xem tất cả');
    // The control sits beside the caption of the last days, and is a button a keyboard reaches.
    expect(html).toMatch(/Các cơ hội đóng trong 30 ngày qua<\/span><button type="button"/);
  });

  it('says the same in English', () => {
    const html = render(() => undefined, 'en');
    expect(html.match(/>Show all</g)).toHaveLength(2);
    expect(html).toContain('aria-label="Show all deals of the stage Thắng in the list"');
  });

  it('offers nothing where the page gives no way to open the list', () => {
    const html = render(undefined);
    expect(html).not.toContain('Xem tất cả');
    expect(html).toContain('Các cơ hội đóng trong 30 ngày qua');
  });
});
