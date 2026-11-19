// SPDX-License-Identifier: AGPL-3.0-only
// The push to MISA AMIS on the screen (#3902, S3b-2b), rendered on the server: the offer to send under a preview that has nothing blocked (only an owner or admin, only where the push is on, only after a test that
// worked, and never for a batch that is partial, empty or blocked), the second click that says a send cannot be taken back, the list of what was sent with MISA's own reason shown as text, and the buttons that settle
// a row MISA never answered for (a sent row after 24 hours, an ambiguous one after 3 days, owner or admin only). Plus the pure rules behind them.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MisaAmisPreview, MisaAmisPushRow } from '@ludy/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';
import { canSettle, confirmedAnything, openRows, previewSendable, pushOffer, PUSH_AMBIGUOUS_WAIT_MS, PUSH_RESULT_WINDOW_MS } from '../src/lib/misa-amis-push.ts';

const cache = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

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
  return { client: node([]), orpc: node([]), queryClient: cache.current, errorMessage: (e: unknown) => String(e) };
});

const { MisaAmisPushConfirm, MisaAmisPushList } = await import('../src/components/misa-amis-push-panel.tsx');

const ID = '0192f0a1-2b3c-7d4e-8f50-6172839a4b5d';
const NOW = Date.parse('2026-11-19T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const result = (over: Partial<MisaAmisPreview> = {}): MisaAmisPreview => ({ kind: 'cash_payment', vouchers: 2, ready: 2, blocked: 0, checkedAgainstAmis: false, purchasePurpose: '1', more: false, digest: 'c'.repeat(64), items: [], ...over });
const ask = { kind: 'cash_payment', legalEntityId: ID, purchasePurpose: '1' } as const;
const row = (over: Partial<MisaAmisPushRow> = {}): MisaAmisPushRow => ({
  id: ID,
  orgRefid: ID,
  sourceType: 'cash_voucher',
  sourceId: ID,
  voucherType: 4,
  part: 1,
  orgRefno: 'CRPC202600012',
  state: 'queued',
  reason: null,
  attempts: 1,
  requestedAt: ago(1000),
  sentAt: null,
  answeredAt: null,
  changedAt: ago(1000),
  ...over,
});

const wrap = (node: React.ReactNode, locale: 'vi' | 'en' = 'en') =>
  renderToStaticMarkup(
    <QueryClientProvider client={cache.current}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );

const list = (rows: MisaAmisPushRow[], canManage: boolean, locale: 'vi' | 'en' = 'en') => {
  cache.current.setQueryData(['misaAmis', 'pushes', 'list'], rows);
  return wrap(<MisaAmisPushList connectionId={ID} canManage={canManage} />, locale);
};

describe('the offer to send a previewed batch (#3902)', () => {
  beforeEach(() => cache.current.clear());

  it('shows the button, the note that the data is re-checked, and sends nothing until it is pressed', () => {
    const html = wrap(<MisaAmisPushConfirm result={result()} ask={ask} connectionId={ID} offer="ready" />);
    expect(html).toContain('data-testid="misa-amis-push-confirm"');
    expect(html).toContain('Send these 2 vouchers to MISA AMIS');
    expect(html).toContain('Only owners and admins can send');
    // The second click is not drawn yet.
    expect(html).not.toContain('misa-amis-push-yes');
    expect(html).not.toContain('cannot take back');
  });

  it.each<[string, MisaAmisPreview]>([
    ['a batch with something blocked', result({ blocked: 1, ready: 1 })],
    ['a partial list (more than a preview shows)', result({ more: true })],
    ['an empty batch', result({ vouchers: 0, ready: 0 })],
  ])('draws nothing for %s', (_n, r) => {
    expect(wrap(<MisaAmisPushConfirm result={r} ask={ask} connectionId={ID} offer="ready" />)).toBe('');
  });

  it('draws nothing where the push is off or for a member, and says why when the connection was not tested', () => {
    expect(wrap(<MisaAmisPushConfirm result={result()} ask={ask} connectionId={ID} offer="hidden" />)).toBe('');
    const html = wrap(<MisaAmisPushConfirm result={result()} ask={ask} connectionId={ID} offer="needs_test" />);
    expect(html).toContain('data-testid="misa-amis-push-needs-test"');
    expect(html).toContain('Test the connection successfully');
    expect(html).not.toContain('misa-amis-push-start');
  });

  it('has the same keys in Vietnamese and English', () => {
    const keys = (o: object, p = ''): string[] => Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' && v !== null ? keys(v, `${p}${k}.`) : [`${p}${k}`]));
    expect(keys(viMessages.misaAmisPush).sort()).toEqual(keys(en.misaAmisPush).sort());
  });

  it('rules: who is offered the send', () => {
    expect(pushOffer({ canManage: true, pushOffered: true, testState: 'works' })).toBe('ready');
    expect(pushOffer({ canManage: true, pushOffered: true, testState: null })).toBe('needs_test');
    expect(pushOffer({ canManage: true, pushOffered: true, testState: 'wrong_credentials' })).toBe('needs_test');
    expect(pushOffer({ canManage: false, pushOffered: true, testState: 'works' })).toBe('hidden');
    expect(pushOffer({ canManage: true, pushOffered: false, testState: 'works' })).toBe('hidden');
    expect(pushOffer({ canManage: true, pushOffered: undefined, testState: 'works' })).toBe('hidden');
    expect(previewSendable({ vouchers: 1, blocked: 0, more: false })).toBe(true);
    expect(previewSendable({ vouchers: 1, blocked: 1, more: false })).toBe(false);
    expect(confirmedAnything({ queued: 0, requeued: 0, already: 3, revised: 0 })).toBe(false);
    expect(confirmedAnything({ queued: 0, requeued: 1, already: 0, revised: 0 })).toBe(true);
  });
});

describe('what was sent to MISA AMIS (#3902)', () => {
  beforeEach(() => cache.current.clear());

  it('says so when nothing was sent', () => {
    expect(list([], true)).toContain('No voucher has been sent through this connection yet.');
  });

  it('lists each request by its number with the state MISA gave it, and counts the ones still open', () => {
    const html = list([row({ state: 'accepted' }), row({ id: 'b', orgRefno: 'CRPC202600013', state: 'queued' }), row({ id: 'c', orgRefno: 'CRPC202600014', part: 2, state: 'failed', reason: 'NOT_IN_AMIS', attempts: 2 })], true);
    expect(html.match(/data-testid="misa-amis-push-row"/g)).toHaveLength(3);
    expect(html).toContain('CRPC202600012');
    expect(html).toContain('Accepted by MISA');
    expect(html).toContain('Waiting to send');
    expect(html).toContain('part 2');
    expect(html).toContain('attempt 2');
    expect(html).toContain('1 waiting');
  });

  it("shows MISA's own reason for a refusal as text, never as markup", () => {
    const html = list([row({ state: 'refused', reason: '<img src=x onerror=alert(1)> Sai mã đối tượng' })], false);
    expect(html).toContain('MISA&#x27;s reason:');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; Sai mã đối tượng');
    expect(html).not.toContain('<img');
  });

  it('offers to settle a sent row only after 24 hours and an ambiguous one only after 3 days, to an owner or admin only', () => {
    const settle = (html: string) => html.match(/data-testid="misa-amis-push-settle"/g)?.length ?? 0;
    // The list reads the clock itself, so rows are made relative to the real now.
    const real = Date.now();
    const rel = (ms: number) => new Date(real - ms).toISOString();
    const rows = [
      row({ id: 's', state: 'sent', changedAt: rel(PUSH_RESULT_WINDOW_MS + 60_000) }),
      row({ id: 's2', state: 'sent', changedAt: rel(PUSH_RESULT_WINDOW_MS - 60 * 60_000) }),
      row({ id: 'a', state: 'ambiguous', changedAt: rel(PUSH_AMBIGUOUS_WAIT_MS + 60_000) }),
      row({ id: 'a2', state: 'ambiguous', changedAt: rel(PUSH_RESULT_WINDOW_MS + 60_000) }),
      row({ id: 'q', state: 'queued', changedAt: rel(PUSH_AMBIGUOUS_WAIT_MS * 2) }),
    ];
    const owner = list(rows, true);
    expect(settle(owner)).toBe(2);
    expect(owner).toContain('It is in AMIS');
    expect(owner).toContain('It is not in AMIS');
    expect(settle(list(rows, false))).toBe(0);
  });

  it('rules: the age of a row is read from its last change', () => {
    expect(canSettle({ state: 'sent', changedAt: ago(PUSH_RESULT_WINDOW_MS + 1000) }, NOW)).toBe(true);
    expect(canSettle({ state: 'sent', changedAt: ago(PUSH_RESULT_WINDOW_MS - 1000) }, NOW)).toBe(false);
    expect(canSettle({ state: 'ambiguous', changedAt: ago(PUSH_AMBIGUOUS_WAIT_MS + 1000) }, NOW)).toBe(true);
    expect(canSettle({ state: 'ambiguous', changedAt: ago(PUSH_AMBIGUOUS_WAIT_MS - 1000) }, NOW)).toBe(false);
    for (const state of ['queued', 'sending', 'accepted', 'refused', 'failed'] as const) expect(canSettle({ state, changedAt: ago(PUSH_AMBIGUOUS_WAIT_MS * 5) }, NOW)).toBe(false);
    expect(openRows([{ state: 'queued' }, { state: 'sent' }, { state: 'ambiguous' }, { state: 'accepted' }, { state: 'refused' }, { state: 'failed' }])).toBe(3);
  });

  it('is written in Vietnamese too', () => {
    const html = list([row({ state: 'accepted' })], true, 'vi');
    expect(html).toContain('MISA đã nhận');
    expect(html).toContain('Chứng từ đã gửi sang MISA AMIS');
  });
});
