// SPDX-License-Identifier: AGPL-3.0-only
// The closed columns of the deal board offer "Xem tất cả" (docs/plan/crm.md section 6: "Won and Lost show the last 30 days, with a
// link to the list for all"), rendered on the server with the board's answer seeded: Thắng and Thua each have the control with
// the stage in its accessible name, the open columns have none, and a board with no handler offers none.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { Board, Deal, PipelineStage } from '@crove/kernel-contract';
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
const card: Deal = {
  id: '00000000-0000-4000-8000-000000000001',
  partyId: '00000000-0000-4000-8000-000000000010',
  partyName: 'Công ty ABC',
  title: 'Gói kế toán năm',
  amount: '15000000.00',
  currency: 'VND',
  stageId: 'new',
  stageKind: 'open',
  expectedClose: null,
  ownerUserId: null,
  lostReason: null,
  closedAt: null,
  version: 1,
  canDelete: true,
  followUp: null,
  partyDuplicateOf: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};
const board: Board = {
  columns: [
    { stage: stage('new', 'Mới', 'open', 1), count: 1, total: '15000000.00', truncated: false, cards: [card] },
    { stage: stage('won', 'Thắng', 'won', 2), count: 0, total: '0', truncated: false, cards: [] },
    { stage: stage('lost', 'Thua', 'lost', 3), count: 0, total: '0', truncated: false, cards: [] },
  ],
};

const emptyBoard: Board = { columns: board.columns.map((c) => ({ ...c, count: 0, total: '0', cards: [] })) };

function render(onShowAll: ((kind: 'won' | 'lost') => void) | undefined, locale: 'vi' | 'en' = 'vi', shown: Board = board, canEdit = true, members: { userId: string; displayName: string | null; email: string }[] = []): string {
  client.current.setQueryData(['crm', 'deals', 'board', {}], shown);
  return renderToStaticMarkup(
    <I18nProvider>
      <QueryClientProvider client={client.current}>
        <IntlProvider locale={locale} messages={catalog(locale)}>
          <DealBoard members={members} canEdit={canEdit} onAdd={() => undefined} onOpen={() => undefined} onShowAll={onShowAll} />
        </IntlProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

// The markup of one column: from its own <section> to the next one.
const column = (html: string, name: string) => {
  const sections = html.split('<section').filter((part) => part.includes(`aria-label="${name}"`));
  expect(sections).toHaveLength(1);
  return sections[0] as string;
};

describe('the closed columns of the deal board', () => {
  it('offer "Xem tất cả" in Thắng and Thua, each named by its stage, and none in an open column', () => {
    const html = render(() => undefined);
    expect(html.match(/>Xem tất cả</g)).toHaveLength(2);
    // The accessible name starts with the visible words (a voice-control user says "Xem tất cả").
    expect(html).toContain('aria-label="Xem tất cả cơ hội ở giai đoạn Thắng trong danh sách"');
    expect(html).toContain('aria-label="Xem tất cả cơ hội ở giai đoạn Thua trong danh sách"');
    expect(column(html, 'Mới')).not.toContain('Xem tất cả');
    expect(column(html, 'Thắng')).toContain('>Xem tất cả<');
    expect(column(html, 'Thua')).toContain('>Xem tất cả<');
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

describe('the layout and the empty state of the deal board (#3647)', () => {
  it('fits the columns in the content width: a grid of at least 10rem, so the six default stages fit, not 18rem columns that push Thắng and Thua off-screen', () => {
    const html = render(undefined);
    expect(html).toContain('auto-cols-[minmax(10rem,1fr)]');
    expect(html).not.toContain('w-72');
  });

  it('stacks Thắng and Thua in one cell, so six stages take five columns and fit a 1280 px laptop', () => {
    const html = render(undefined);
    expect(html.match(/data-testid="deal-closed-cell"/g)).toHaveLength(1);
    const cell = html.split('data-testid="deal-closed-cell"')[1] as string;
    expect(cell).toContain('aria-label="Thắng"');
    expect(cell).toContain('aria-label="Thua"');
    // The open stage is a cell of its own, before the closed one.
    expect(html.indexOf('aria-label="Mới"')).toBeLessThan(html.indexOf('data-testid="deal-closed-cell"'));
    // Each closed stage keeps its own "Xem tất cả".
    expect(render(() => undefined).match(/>Xem tất cả</g)).toHaveLength(2);
  });

  it('names each column by its heading, under the screen title, and does not repeat the name on its list', () => {
    const html = render(undefined);
    expect(html).toContain('<h2 class="text-sm font-semibold text-foreground">Thắng</h2>');
    expect(html).not.toContain('<h3');
    expect(column(html, 'Mới')).not.toMatch(/<ul[^>]*aria-label/);
  });

  it('with no deal and no filter says so and offers the one action and the customer import, instead of empty columns', () => {
    const html = render(undefined, 'vi', emptyBoard);
    expect(html).toContain('Bảng chưa có cơ hội nào.');
    expect(html).toContain('>Thêm cơ hội<');
    expect(html).toContain('>Nhập khách hàng từ tệp<');
    expect(html).not.toContain('data-testid="deal-board"');
  });

  it('says the same in English', () => {
    const html = render(undefined, 'en', emptyBoard);
    expect(html).toContain('The board has no deals yet.');
    expect(html).toContain('>Add deal<');
    expect(html).toContain('>Import customers from a file<');
  });

  it('offers a viewer no action', () => {
    const html = render(undefined, 'vi', emptyBoard, false);
    expect(html).toContain('Bảng chưa có cơ hội nào.');
    expect(html).not.toContain('Thêm cơ hội');
    expect(html).not.toContain('Nhập khách hàng');
  });
});

describe('the card of the deal board (#3648)', () => {
  const withCard = (over: Partial<Deal>): Board => ({ columns: board.columns.map((c, i) => (i === 0 ? { ...c, cards: [{ ...card, ...over }] } : c)) });

  it('is one click target that opens the deal, and holds no Sửa, Báo giá or Lịch hẹn buttons', () => {
    const html = render(undefined);
    expect(html).toContain('data-testid="deal-card-open"');
    expect(html).toContain('role="button"');
    // Named by its content, which holds the customer and the amount too.
    expect(html).not.toContain('aria-label="Mở cơ hội');
    for (const word of ['>Sửa<', '>Báo giá<', '>Lịch hẹn<']) expect(html).not.toContain(word);
    // The stage menu stays.
    expect(html).toContain('aria-label="Giai đoạn của cơ hội Gói kế toán năm"');
  });

  it("shows the owner's name, or that there is none", () => {
    expect(render(undefined)).toContain('Chưa có người phụ trách');
    const owned = render(undefined, 'vi', withCard({ ownerUserId: 'u1' }), true, [{ userId: 'u1', displayName: 'Lan', email: 'lan@example.test' }]);
    expect(owned).toContain('Phụ trách: Lan');
    expect(render(undefined, 'en', withCard({ ownerUserId: 'u1' }), true, [{ userId: 'u1', displayName: null, email: 'lan@example.test' }])).toContain('Owner: lan@example.test');
  });

  it('shows the next step the server raised, in words, not only a badge', () => {
    const html = render(undefined, 'vi', withCard({ followUp: { id: '00000000-0000-4000-8000-0000000000f1', reason: 'past_close', sinceOn: '2026-11-10' } }));
    expect(html).toContain('data-testid="deal-card-next"');
    expect(html).toContain('Nhắc: đã quá ngày dự kiến chốt 10/11/2026');
    expect(render(undefined)).not.toContain('deal-card-next');
  });

  it('writes the expected close as dd/mm/yyyy, and says "Quá hạn" in words when it is past (#3649)', () => {
    const late = render(undefined, 'vi', withCard({ expectedClose: '2020-01-31' }));
    expect(late).toContain('Quá hạn, dự kiến chốt 31/01/2020');
    expect(late).not.toContain('2020-01-31');
    const later = render(undefined, 'vi', withCard({ expectedClose: '2999-01-31' }));
    expect(later).toContain('Dự kiến chốt 31/01/2999');
    expect(later).not.toContain('Quá hạn');
    expect(render(undefined, 'en', withCard({ expectedClose: '2020-01-31' }))).toContain('Overdue, expected to close 31/01/2020');
  });
});
