// SPDX-License-Identifier: AGPL-3.0-only
// What a person can act on at the Sàn screen (#2516 slice F), rendered on the server with the answer of marketplace.worklist seeded in the cache: nothing is shown when nothing waits; while the account map
// is not confirmed the gate line is shown and the three actions are disabled; once it is, each action is a button (the payout one beside a choice of bank lines by date, amount and reference, never a
// free-text id); a settlement with no matching bank line says so and its button stays disabled; and reading the screen asks the server for nothing but the read.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarketplaceWorklist } from '@ludy/kernel-contract';

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

const { MarketplaceActions } = await import('../src/components/marketplace-actions.tsx');
const { I18nProvider } = await import('../src/i18n/provider.tsx');
const { setActiveLocale } = await import('../src/i18n/runtime.ts');

const entity = '00000000-0000-4000-8000-0000000000e1';
const settlementId = '00000000-0000-4000-8000-0000000000a1';
const lineA = '00000000-0000-4000-8000-0000000000b1';
const lineB = '00000000-0000-4000-8000-0000000000b2';
const documentId = '00000000-0000-4000-8000-0000000000c1';

const EMPTY: MarketplaceWorklist = { postingConfirmed: true, salesPostingConfirmed: true, settlements: [], payouts: [], invoices: [], halfReversed: [], accruals: [], accrualReversals: [] };
const FULL = (over: Partial<MarketplaceWorklist> = {}): MarketplaceWorklist => ({
  postingConfirmed: true,
  salesPostingConfirmed: true,
  halfReversed: [],
  accruals: [],
  accrualReversals: [],
  settlements: [{ id: settlementId, legalEntityId: entity, platform: 'shopee', platformName: 'Shopee', periodFrom: '2026-10-01', periodTo: '2026-10-15', months: ['2026-10'], net: '335000', waitingLines: 0, waitingVatMonths: [], proposalId: null }],
  payouts: [
    {
      settlementId,
      legalEntityId: entity,
      platform: 'shopee',
      platformName: 'Shopee',
      periodFrom: '2026-10-01',
      periodTo: '2026-10-15',
      received: '304000',
      proposalId: null,
      candidates: [
        { id: lineA, date: '2026-10-20', amount: '304000', reference: 'FT2610200001' },
        { id: lineB, date: '2026-10-22', amount: '304000', reference: null },
      ],
      adjustable: [],
    },
  ],
  invoices: [{ documentId, legalEntityId: entity, platform: 'shopee', platformName: 'Shopee', invoice: '1C26TPF00000007', date: '2026-10-25', clearable: '28000', proposalId: null }],
  ...over,
});

function render(answer: MarketplaceWorklist | null, locale: 'vi' | 'en' = 'en'): string {
  setActiveLocale(locale);
  if (answer) cache.current.setQueryData(['marketplace', 'worklist'], answer);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache.current}>
      <I18nProvider>
        <MarketplaceActions legalEntityId={undefined} ready />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

// Whether the first element with this test id carries the disabled attribute (not a class that merely styles one).
const disabled = (html: string, testId: string): boolean => /\sdisabled=""/.test(html.match(new RegExp(`<[a-z]+ [^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? '');

describe('the Sàn screen actions (#2516 slice F)', () => {
  beforeEach(() => {
    cache.current.clear();
    cache.calls.length = 0;
  });

  it('shows nothing before the answer is in, and nothing when nothing waits', () => {
    expect(render(null)).toBe('');
    expect(render(EMPTY)).toBe('');
    expect(cache.calls).toEqual([]);
  });

  it('while the account map is not confirmed shows the gate line and the three actions disabled', () => {
    const html = render(FULL({ postingConfirmed: false, salesPostingConfirmed: false }));
    expect(html).toContain('data-testid="marketplace-gate"');
    expect(html).toContain('Waiting for the accountant to confirm the marketplace account map (#2520)');
    for (const id of ['marketplace-post', 'marketplace-record', 'marketplace-clear']) expect(disabled(html, id)).toBe(true);
    expect(cache.calls).toEqual([]);
  });

  it('with only the sales path confirmed (the shipped maps) the settlement post is enabled while the payout and clearing actions stay locked (#4303 S3b)', () => {
    const html = render(FULL({ postingConfirmed: false, salesPostingConfirmed: true }));
    expect(disabled(html, 'marketplace-post')).toBe(false);
    for (const id of ['marketplace-record', 'marketplace-clear']) expect(disabled(html, id)).toBe(true);
    // The payout and clearing rows are still locked, so the line says why.
    expect(html).toContain('data-testid="marketplace-gate"');
    // Only settlements in view: nothing is locked, so no gate line.
    const settlementsOnly = render({ ...EMPTY, postingConfirmed: false, settlements: FULL().settlements });
    expect(disabled(settlementsOnly, 'marketplace-post')).toBe(false);
    expect(settlementsOnly).not.toContain('data-testid="marketplace-gate"');
  });

  it('once the map is confirmed shows no gate line and the three actions enabled', () => {
    const html = render(FULL());
    expect(html).not.toContain('marketplace-gate');
    for (const id of ['marketplace-post', 'marketplace-record', 'marketplace-clear']) expect(disabled(html, id)).toBe(false);
    expect(html).toContain('Post');
    expect(html).toContain('Record the money');
    expect(html).toContain('Clear the fees');
    // Nothing was asked of the server by reading the screen: the buttons only ask when pressed.
    expect(cache.calls).toEqual([]);
  });

  it('lists the settlement with its period and net, and the invoice with what it can clear', () => {
    const html = render(FULL());
    expect(html).toContain('Shopee');
    expect(html).toContain('2026-10-01 - 2026-10-15');
    expect(html).toContain('1C26TPF00000007');
    expect(html).toContain('2026-10-25');
    expect(html.match(/data-testid="marketplace-action-settlement"/g)).toHaveLength(1);
    expect(html.match(/data-testid="marketplace-action-invoice"/g)).toHaveLength(1);
  });

  it('lists the lines a person must classify before a payout can be asked for (#4303 S4): none classified, the request stays disabled; an offered kind per source, never free text but the cost of lost goods', () => {
    const base = FULL();
    const payout = base.payouts[0]!;
    const html = render({
      ...base,
      payouts: [{ ...payout, adjustable: [{ lineId: lineA, source: 'other', amount: '6000' }, { lineId: lineB, source: 'withheld', amount: '2000' }] }],
    });
    expect(html).toContain('data-testid="marketplace-payout-adjustments"');
    expect(html.match(/data-testid="marketplace-adjustment"/g)).toHaveLength(2);
    expect(html).toContain('The platform paid');
    expect(html).toContain('The platform withheld tax');
    expect(html).toContain('Incentive from the platform (other income)');
    expect(html).toContain('Compensation for goods lost or damaged');
    expect(html).toContain('Withheld by mistake (a company is not withheld)');
    // Nothing is chosen yet: the request is disabled, and no cost field shows before a compensation is picked.
    expect(disabled(html, 'marketplace-record')).toBe(true);
    expect(html).not.toContain('marketplace-adjustment-cost');
    // The reason the request waits is said in words, the platform-voucher doubt is marked, and the controls are 44 px high on a phone.
    expect(html).toContain('data-testid="marketplace-adjustment-pending"');
    expect(html).toContain('Choose a kind for every line');
    expect(html).toContain('Uncertain (#2520)');
    expect(html.match(/max-md:min-h-11/g)!.length).toBeGreaterThanOrEqual(3);
    // A payout with nothing to classify has no such row and its request stays enabled.
    const plain = render(FULL());
    expect(plain).not.toContain('marketplace-payout-adjustments');
    expect(disabled(plain, 'marketplace-record')).toBe(false);
    // Vietnamese too.
    expect(render({ ...base, payouts: [{ ...payout, adjustable: [{ lineId: lineA, source: 'other', amount: '6000' }] }] }, 'vi')).toContain('Bồi thường hàng bị mất hoặc hỏng');
  });

  it('shows the months of delivery of a settlement in one row, and a settlement that waits for a delivery day with no button', () => {
    const base = FULL();
    const one = base.settlements[0]!;
    const html = render({
      ...base,
      settlements: [
        { ...one, months: ['2026-09', '2026-10'], net: '335000' },
        { ...one, id: '00000000-0000-4000-8000-0000000000a9', months: [], net: '0', waitingLines: 3 },
      ],
    });
    expect(html.match(/data-testid="marketplace-action-settlement"/g)).toHaveLength(2);
    expect(html).toContain('2026-09, 2026-10');
    expect(html).toContain('3 lines have no delivery day yet');
    // One button (for the settlement with months), and the waiting row has the note instead.
    expect(html.match(/data-testid="marketplace-post"/g)).toHaveLength(1);
    expect(html).toContain('marketplace-post-waiting');
    expect(html).toContain('Waiting for the delivery day');
  });

  it('shows a settlement whose sales lack a VAT rate for their delivery day as waiting, with a link to the setting and no button', () => {
    const base = FULL();
    const one = base.settlements[0]!;
    const waiting = { ...base, settlements: [{ ...one, months: ['2026-09', '2026-10'], waitingVatMonths: ['2026-10'] }] };
    const html = render(waiting);
    expect(html).toContain('data-testid="marketplace-post-waiting-vat"');
    expect(html).toContain('Waiting for the VAT rate of 2026-10.');
    // Without a role read yet (a member, or the read pending) the link is not offered: the person is told whom to ask.
    expect(html).not.toContain('/settings/accounting');
    expect(html).toContain('marketplace-vat-ask');
    expect(html).toContain('Ask an owner or admin to enter it.');
    expect(html).toContain('2026-09, 2026-10');
    expect(html).not.toContain('data-testid="marketplace-post"');
    expect(render(waiting, 'vi')).toContain('Chờ thuế suất GTGT của 2026-10.');
    // An owner or admin gets the link, as a 44 px target.
    cache.current.setQueryData(['org', 'get'], { role: 'admin' });
    const owner = render(waiting);
    expect(owner).toContain('/settings/accounting');
    expect(owner).toContain('min-h-11');
    expect(owner).not.toContain('marketplace-vat-ask');
    cache.current.setQueryData(['org', 'get'], { role: 'member' });
    expect(render(waiting)).toContain('marketplace-vat-ask');
    cache.current.removeQueries({ queryKey: ['org', 'get'] });
    // The same settlement with every day covered has its button again.
    expect(render({ ...base, settlements: [{ ...one, months: ['2026-09', '2026-10'] }] })).toContain('data-testid="marketplace-post"');
  });

  it('lists a half-reversed settlement with how many months still stand, in both languages, with no button', () => {
    const half = [{ settlementId, legalEntityId: entity, platform: 'shopee', platformName: 'Shopee', periodFrom: '2026-10-01', periodTo: '2026-10-15', standingMonths: 2, reversedMonths: 1 }];
    const en = render({ ...EMPTY, halfReversed: half }, 'en');
    expect(en).toContain('data-testid="marketplace-actions-half-reversed"');
    expect(en).toContain('Half reversed: 2 months still stand (1 reversed)');
    expect(en).not.toContain('data-testid="marketplace-post"');
    expect(render({ ...EMPTY, halfReversed: half }, 'vi')).toContain('Đảo dở: còn 2 tháng chưa đảo (đã đảo 1)');
    // The half-reversed settlement alone is enough to show the section (nothing else waits), and with nothing at all the component stays empty.
    expect(render(EMPTY, 'en')).toBe('');
  });

  it('lists the month-end accrual of the fees without an invoice and the reversal of a standing one, locked until the map is confirmed', () => {
    const accrual = { legalEntityId: entity, platform: 'shopee', platformName: 'Shopee', month: '2026-10', date: '2026-10-31', amount: '120000', expenseAccount: '6421', accruedAccount: '335', description: 'Trích trước phí sàn tháng 10/2026, ước tính (Shopee) [fee-accrual:shopee:2026-10]', proposalId: null };
    const reversal = { legalEntityId: entity, platform: 'shopee', platformName: 'Shopee', month: '2026-10', entryId: settlementId, amount: '120000', reverseOn: '2026-11-01', proposalId: null };
    const open = render({ ...EMPTY, accruals: [accrual], accrualReversals: [reversal] }, 'en');
    expect(open).toContain('data-testid="marketplace-actions-accruals"');
    expect(open).toContain('data-testid="marketplace-actions-accrual-reversals"');
    expect(open).toContain('10/2026');
    expect(open).toContain('2026-11-01');
    expect(open).toContain('data-testid="marketplace-accrue"');
    expect(open).toContain('data-testid="marketplace-reverse-accrual"');
    // While the account map is not confirmed the two buttons are disabled, like the others.
    const locked = render({ ...EMPTY, postingConfirmed: false, accruals: [accrual], accrualReversals: [reversal] }, 'en');
    expect(locked).toMatch(/<button[^>]*disabled[^>]*data-testid="marketplace-accrue"|<button[^>]*data-testid="marketplace-accrue"[^>]*disabled/);
    // A pending proposal replaces the button with its link; in Vietnamese the section has its title.
    expect(render({ ...EMPTY, accruals: [{ ...accrual, proposalId: documentId }] }, 'en')).toContain('data-testid="marketplace-accrue-pending"');
    expect(render({ ...EMPTY, accruals: [accrual] }, 'vi')).toContain('Trích trước phí sàn chưa có hóa đơn');
  });

  it('offers the bank lines by date, amount and reference, never a free-text id', () => {
    const html = render(FULL());
    expect(html).toContain('data-testid="marketplace-line-select"');
    expect(html).toContain('2026-10-20');
    expect(html).toContain('FT2610200001');
    expect(html).toContain('2026-10-22');
    expect(html.match(/<option/g)).toHaveLength(2);
    expect(html).not.toContain('<input');
  });

  it('says there is no matching bank line yet, and keeps the payout button disabled', () => {
    const html = render(FULL({ payouts: [{ ...FULL().payouts[0]!, candidates: [] }] }));
    expect(html).toContain('data-testid="marketplace-no-candidates"');
    expect(html).toContain('No matching bank line yet');
    expect(disabled(html, 'marketplace-record')).toBe(true);
    expect(html).not.toContain('<select');
  });

  it('shows only the lists that have something in them', () => {
    const html = render(FULL({ payouts: [], invoices: [] }));
    expect(html).toContain('marketplace-actions-settlements');
    expect(html).not.toContain('marketplace-actions-payouts');
    expect(html).not.toContain('marketplace-actions-invoices');
  });

  it('links to the proposal already waiting in the Inbox instead of offering a second request', () => {
    const waiting = '00000000-0000-4000-8000-0000000000d1';
    const base = FULL();
    const html = render({ ...base, settlements: [{ ...base.settlements[0]!, proposalId: waiting }], payouts: [{ ...base.payouts[0]!, proposalId: waiting }], invoices: [{ ...base.invoices[0]!, proposalId: waiting }] });
    for (const id of ['marketplace-post', 'marketplace-record', 'marketplace-clear']) {
      expect(html).toContain(`data-testid="${id}-pending"`);
      expect(html).not.toContain(`data-testid="${id}"`);
    }
    expect(html).toContain('Waiting for approval.');
    expect(html).toContain(`href="/o/acme/inbox/${waiting}"`);
    // The payout row offers no choice of bank line while its proposal waits.
    expect(html).not.toContain('marketplace-line-select');
  });

  it('reads in Vietnamese', () => {
    const html = render(FULL({ postingConfirmed: false, salesPostingConfirmed: false }), 'vi');
    expect(html).toContain('Chờ kế toán xác nhận bảng tài khoản sàn (#2520)');
    expect(html).toContain('Ghi sổ');
    expect(html).toContain('Ghi nhận tiền về');
    expect(html).toContain('Cấn trừ phí');
    expect(html).toContain('Kỳ đối soát chờ ghi sổ');
  });
});
