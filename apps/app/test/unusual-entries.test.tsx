// SPDX-License-Identifier: AGPL-3.0-only
// The unusual entries card of the Kế toán Tổng quan (#5182): the pure parts (which sentence a hit reads as, the account as text, who may mark a hit, where a note belongs) and the list of hits in Vietnamese and in
// English: every figure is on the screen, the coworker's note appears only when it came back and is labelled as a possibility, with AI off the list is the same with no gap, a viewer is offered no mark, and the
// controls keep a 44 px target on a phone.
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { FinanceUnusualEntries, UnusualEntryHit } from '@ludy/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';
import { accountText, canReviewEntries, detailKind, noteFor } from '../src/lib/unusual-entries.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    Link: ({ children, to, params, hash, className }: { children?: ReactNode; to: string; params?: Record<string, string>; hash?: string; className?: string }) =>
      createElement('a', { href: to.replace(/\$(\w+)/g, (_match, name: string) => params?.[name] ?? '') + (hash ? `#${hash}` : ''), className }, children),
  };
});
vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') {
          return (options?: { input?: unknown }) => ({ queryKey: options?.input === undefined ? path : [...path, options.input], queryFn: () => Promise.reject(new Error('not fetched')) });
        }
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), queryClient: client.current, errorMessage: (e: unknown) => String(e), isStepUpRequired: () => false, client: {} };
});

const { UnusualEntriesList } = await import('../src/routes/unusual-entries-card.tsx');

const base: UnusualEntryHit = {
  rule: 'amount_outlier',
  entryId: 'e-out',
  entryDate: '2026-07-04',
  sourceKind: 'invoice',
  description: 'Tiền điện tháng 6',
  amount: '48000000',
  partyId: 'p-1',
  partyName: 'Công ty Sao Mai',
  accountCode: '642',
  accountName: 'Chi phí quản lý',
  groupAmount: '48000000',
  usual: '9000000',
  historyCount: 7,
  ratio: '5.3',
  direction: 'high',
  basis: null,
  day: null,
  control: null,
  invoiceNumber: null,
  otherEntryId: null,
  otherEntryDate: null,
};
const none = { groupAmount: null, usual: null, historyCount: null, ratio: null, direction: null } as const;
const HITS: UnusualEntryHit[] = [
  { ...base, ...none, rule: 'duplicate_invoice', entryId: 'e-dup', accountCode: null, accountName: null, invoiceNumber: '0001234', otherEntryId: 'e-0', otherEntryDate: '2026-05-02' },
  { ...base, ...none, rule: 'control_manual', entryId: 'e-ctl', sourceKind: 'manual', partyId: null, partyName: null, accountCode: '331', accountName: 'Phải trả người bán', control: 'payable', description: null },
  base,
  { ...base, ...none, rule: 'new_account', entryId: 'e-new', basis: 'party' },
  { ...base, ...none, rule: 'new_account', entryId: 'e-newk', basis: 'kind', partyId: null, partyName: null },
  { ...base, ...none, rule: 'off_day', entryId: 'e-off', sourceKind: 'cash_bank', partyId: null, partyName: null, accountCode: null, accountName: null, day: 'holiday' },
  { ...base, ...none, rule: 'off_day', entryId: 'e-wk', sourceKind: 'manual', partyId: null, partyName: null, accountCode: null, accountName: null, day: 'weekend' },
];
const DATA: FinanceUnusualEntries = {
  month: '2026-07',
  legalEntityId: 'le-1',
  regime: 'tt133',
  chartVersion: '2026.1',
  thresholds: { amountFactor: 3, amountMinDiff: '5000000', madFactor: 5, historyMonths: 6, minHistory: 6, offDayMinAmount: '5000000' },
  historyFrom: '2026-01-01',
  empty: false,
  hits: HITS,
  moreHits: 0,
  reviewed: 0,
  reviewedHits: [],
};

const render = (locale: 'vi' | 'en', data: FinanceUnusualEntries, notes: ReadonlyArray<{ key: string; text: string }> = [], canMark = true) =>
  renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} messages={catalog(locale)} timeZone="Asia/Ho_Chi_Minh">
        <UnusualEntriesList data={data} notes={notes} slug="acme" canMark={canMark} />
      </IntlProvider>
    </QueryClientProvider>,
  );

describe('which sentence a hit reads as', () => {
  it('is one per rule, and for a new account or a day off the basis or the kind of day', () => {
    expect(detailKind({ rule: 'duplicate_invoice', basis: null, day: null })).toBe('duplicate');
    expect(detailKind({ rule: 'control_manual', basis: null, day: null })).toBe('control');
    expect(detailKind({ rule: 'amount_outlier', basis: null, day: null })).toBe('amount');
    expect(detailKind({ rule: 'new_account', basis: 'party', day: null })).toBe('newParty');
    expect(detailKind({ rule: 'new_account', basis: 'kind', day: null })).toBe('newKind');
    expect(detailKind({ rule: 'new_account', basis: null, day: null })).toBe('newParty');
    expect(detailKind({ rule: 'off_day', basis: null, day: 'holiday' })).toBe('holiday');
    expect(detailKind({ rule: 'off_day', basis: null, day: 'weekend' })).toBe('weekend');
  });

  it('writes the account as its code and, when the chart has one, its name', () => {
    expect(accountText({ accountCode: '642', accountName: 'Chi phí quản lý' })).toBe('642 Chi phí quản lý');
    expect(accountText({ accountCode: '6421', accountName: null })).toBe('6421');
    expect(accountText({ accountCode: null, accountName: null })).toBe('');
  });
});

describe('who may mark a hit and where a note belongs', () => {
  it('offers the mark to owners, admins and members, never to a viewer', () => {
    for (const role of ['owner', 'admin', 'member']) expect(canReviewEntries(role), role).toBe(true);
    for (const role of ['viewer', '', null, undefined]) expect(canReviewEntries(role), String(role)).toBe(false);
  });

  it('finds a note by the rule and the entry of its hit', () => {
    const notes = [{ key: 'amount_outlier:e-out', text: 'Có thể một khoản mua lớn.' }];
    expect(noteFor(notes, { rule: 'amount_outlier', entryId: 'e-out' })).toBe('Có thể một khoản mua lớn.');
    expect(noteFor(notes, { rule: 'new_account', entryId: 'e-out' })).toBeUndefined();
    expect(noteFor([], { rule: 'amount_outlier', entryId: 'e-out' })).toBeUndefined();
  });
});

describe('the list of hits', () => {
  it('shows every hit with its rule, its kind of voucher, its names and its figures, and the books it follows (vi)', () => {
    const html = render('vi', DATA);
    for (const text of [
      'Giống một hóa đơn đã ghi sổ trước đó',
      'Bút toán tay chạm vào tài khoản công nợ hoặc thuế',
      'Số tiền xa mức thường thấy',
      'Tài khoản chưa từng dùng',
      'Nhập vào ngày nghỉ',
      'Thông tư 133',
      'Chứng từ ngày',
      'Tiền điện tháng 6',
      'Đối tác Công ty Sao Mai',
      'Hóa đơn',
      'Bút toán tay',
      'Phiếu thu chi hoặc giao dịch ngân hàng',
      'một tài khoản phải trả nhà cung cấp',
      '642 Chi phí quản lý',
      'số hóa đơn 0001234',
      'một ngày lễ trong lịch chung',
      'một ngày cuối tuần',
      'Nhà cung cấp này chưa được ghi vào',
      'Loại chứng từ này chưa được ghi vào',
      'mặc định',
    ]) {
      expect(html, text).toContain(text);
    }
    // The figures: the entry total, the group amount, the usual and the ratio.
    expect(html).toMatch(/48[.,]000[.,]000/);
    expect(html).toMatch(/9[.,]000[.,]000/);
    expect(html).toMatch(/5[.,]3 lần/);
    for (const hit of HITS) expect(html).toContain(`data-testid="unusual-hit-${hit.rule}-${hit.entryId}"`);
  });

  it('is in English too', () => {
    const html = render('en', DATA);
    for (const text of ['Looks like a repeat of an invoice already booked', 'Amount far from the usual', 'Account not used before', 'Keyed on a day off', 'Circular 133', 'Open voucher', 'Mark as reviewed']) {
      expect(html, text).toContain(text);
    }
    expect(html).toContain('5.3 times the usual');
    expect(html).toContain('a public holiday of the shared calendar');
  });

  it('opens the voucher at its date and entry, and offers the mark with a label that names the entry', () => {
    const html = render('vi', DATA);
    expect(html).toContain('href="/o/acme/journal#entry-e-out"');
    expect(html).toContain('Mở chứng từ');
    expect(html).toContain('aria-label="Mở chứng từ ngày');
    expect(html).toContain('Đánh dấu đã xem');
    expect(html).toContain('aria-label="Đánh dấu đã xem, bút toán ngày');
  });

  it('offers a viewer the voucher but no mark', () => {
    const html = render('vi', DATA, [], false);
    expect(html).toContain('Mở chứng từ');
    expect(html).not.toContain('Đánh dấu');
  });

  it('shows the coworker\'s note only when it came back, labelled as a possibility (vi and en)', () => {
    const noted = render('vi', DATA, [{ key: 'amount_outlier:e-out', text: 'Có thể một khoản mua lớn hơn mức thường.' }]);
    expect(noted).toContain('data-testid="unusual-note-amount_outlier-e-out"');
    expect(noted).toContain('Có thể một khoản mua lớn hơn mức thường.');
    expect(noted).toContain('gợi ý một khả năng');
    expect(noted).toContain('chưa phải kết luận');
    // The name of the coworker comes from the catalog, never typed in the copy.
    expect(noted).not.toContain('{finance}');
    const en = render('en', DATA, [{ key: 'off_day:e-off', text: 'Could be an entry keyed outside the usual working days.' }]);
    expect(en).toContain('data-testid="unusual-note-off_day-e-off"');
    expect(en).toContain('suggests a possibility');
    expect(en).toContain('not a finding');
    expect(en).not.toContain('{finance}');
    expect(en).not.toContain('unusual-note-amount_outlier');
  });

  it('is the same list with no note, no gap and no notice when the AI is off', () => {
    const off = render('vi', DATA, []);
    expect(off).not.toContain('unusual-note-');
    expect(off).not.toContain('gợi ý');
    for (const hit of HITS) expect(off).toContain(`unusual-hit-${hit.rule}-${hit.entryId}`);
  });

  it('gives every control of the card a 44 px target on a phone', () => {
    const html = render('vi', DATA);
    expect(html).toContain('min-h-11');
  });

  it('says so when there are no entries, when nothing looked unusual, when more hits exist and when some were already reviewed', () => {
    expect(render('vi', { ...DATA, empty: true, hits: [] })).toContain('Tháng này chưa có bút toán nào');
    expect(render('en', { ...DATA, empty: true, hits: [] })).toContain('There are no entries in this month');
    expect(render('vi', { ...DATA, hits: [] })).toContain('Tháng này không có bút toán nào trông bất thường');
    expect(render('en', { ...DATA, hits: [] })).toContain('No entry looked unusual this month');
    expect(render('vi', { ...DATA, moreHits: 4 })).toContain('4 bút toán khác');
    expect(render('en', { ...DATA, moreHits: 1 })).toContain('1 more entry');
    expect(render('vi', { ...DATA, reviewed: 3 })).toContain('3 mục');
    expect(render('en', { ...DATA, reviewed: 1 })).toContain('1 hit is already marked as reviewed');
    expect(render('en', { ...DATA, regime: 'tt99' })).toContain('Circular 99');
    // The reviewed hits are listed with who marked them and when, or only when if the member has no display name.
    const done = [
      { hit: { ...base, entryId: 'e-done' }, reviewedByName: 'Nguyễn Thu Hà', reviewedAt: '2026-08-03' },
      { hit: { ...base, entryId: 'e-done2', rule: 'off_day' as const }, reviewedByName: null, reviewedAt: '2026-08-04' },
    ];
    const listed = render('vi', { ...DATA, reviewed: 2, reviewedHits: done });
    expect(listed).toContain('data-testid="unusual-reviewed-amount_outlier-e-done"');
    expect(listed).toContain('Đã xem bởi Nguyễn Thu Hà');
    expect(listed).toContain('Đã xem ngày');
    expect(render('en', { ...DATA, reviewed: 1, reviewedHits: [done[0] as (typeof done)[0]] })).toContain('Reviewed by Nguyễn Thu Hà');
    expect(render('vi', DATA)).not.toContain('unusual-reviewed');
    // The calendar's limits are said in words, with AI on or off.
    expect(render('en', DATA)).toContain('Days the government moves are not in it');
  });
});
