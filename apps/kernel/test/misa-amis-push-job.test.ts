// SPDX-License-Identifier: AGPL-3.0-only
// The push of vouchers to MISA AMIS, the worker's half (#3902, S3b of #3854), against a fake AMIS and a scripted runtime: what is sent (the exact body, one kind, at most a batch, the real branch), what is
// recorded for each way a send ends, that a voucher that changed since the person approved it is never sent, that a lost answer is never sent again, that results are read by polling, and that nothing but
// ids, codes and states is recorded or logged (not the access code, not the integrator's ClientID, not a party's name). The database side (the table's states, idempotency, the ledger) is the DB tests'.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AmisError, createAmisClient, type AmisRequest, type AmisResponse, type AmisTransport } from '@crove/misa-amis';
import { DomainError, type CredentialBroker, type Runtime } from '@crove/kernel-runtime';
import { amisContextOf, amisPartRows, loadAmisEntries, NO_MATCH_RESULTS, PUSH_IN_FLIGHT_SECONDS, type CashVoucher, type MisaAmisMatchResults, type MisaAmisPushBegin } from '@crove/mod-finance';
import { CATALOGUE_REREAD_MS, PUSH_PRESS_RECHECK_SECONDS, PUSH_RECHECK_SECONDS, PUSH_UNREACHABLE_ROUNDS, PUSH_WAIT_ROUNDS, pushFollowUp, pushGiveUp, pushPressKeyTail, runMisaAmisPush, type MisaAmisPushOutcome } from '../src/misa-amis-push-job.ts';

const CLIENT_ID = 'planted-client-id-0123456789';
const ACCESS_CODE = 'planted-access-code-abcdef';
const COMPANY = 'ludy-0123456789abcdef0123456789abcdef';
const ORG = '11111111-1111-4111-8111-111111111111';
const CONNECTION = '22222222-2222-4222-8222-222222222222';
const CHANNEL = '33333333-3333-4333-8333-333333333333';
const ENTITY = '44444444-4444-4444-8444-444444444444';
const BRANCH = 'b8868580-c5d7-49c2-993d-15824b3083f6';
const SOURCE = '0192f0a1-2b3c-7d4e-8f50-6172839a4b5d';
const PARTY_NAME = 'Công ty TNHH Planted Party';
// The catalogue's entry for the party the checks below matched.
const PARTY_ENTRY = { account_object_code: 'NCC_ABC', account_object_id: '0194a1c2-8f3e-7b10-9d4a-1e2f3a4b5c6d', company_tax_code: '0101234564', account_object_name: 'planted catalogue name', inactive: false };

const ok = (data: unknown): AmisResponse => ({ status: 200, body: JSON.stringify({ Success: true, ErrorMessage: '', Data: data }) });
const fail = (code: string, message = `planted AMIS text ${ACCESS_CODE}`): AmisResponse => ({ status: 200, body: JSON.stringify({ Success: false, ErrorCode: code, ErrorMessage: message }) });

const cash = (overrides: Partial<CashVoucher> = {}): CashVoucher => ({
  sourceId: SOURCE,
  type: 'cash_payment',
  code: 'PC00012',
  numberPeriod: '2026',
  date: '2026-10-07',
  cashAccount: '1111',
  party: { name: PARTY_NAME, taxCode: '0101234564', address: '1 Láng Hạ, Hà Nội' },
  personName: 'Nguyễn Văn An',
  description: 'Trả tiền hóa đơn tháng 9',
  lines: [
    { lineNo: 1, account: '331', amount: '1650000', memo: 'HĐ C26TAA/123' },
    { lineNo: 2, account: '6422', amount: '35000.5', memo: null },
  ],
  ...overrides,
});
const PARAMS = { kind: 'cash_payment' as const, from: '2026-10-01', to: '2026-10-31', purchasePurpose: '1' as const };

// What AMIS does with a call, as far as the push depends on it: a token for the right code and company, the dictionary, a queued save, the results.
function fakeAmis(options: { branches?: Array<Record<string, unknown>>; parties?: Array<Record<string, unknown>>; items?: Array<Record<string, unknown>>; results?: unknown[]; behave?: (path: string, body: Record<string, unknown>) => AmisResponse | Promise<AmisResponse> | undefined } = {}) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const transport: AmisTransport = async (request: AmisRequest) => {
    const path = new URL(request.url).pathname.replace(/^\/apis/, '');
    const body = JSON.parse(request.body) as Record<string, unknown>;
    calls.push({ path, body });
    const forced = await options.behave?.(path, body);
    if (forced) return forced;
    if (request.headers.ClientID !== CLIENT_ID) return fail('InvalidAPPID');
    if (path === '/amiskt/v1/token') return body.access_code === ACCESS_CODE && body.org_company_code === COMPANY ? ok({ access_token: 'token-1', expired_time: '2027-01-19T20:00:00' }) : fail('InvalidAccessToken');
    if (request.headers['X-MISA-AccessToken'] !== 'token-1') return fail('InvalidToken');
    if (path === '/amiskt/v1/get_dictionary') return ok(body.data_type === 1 ? (options.parties ?? []) : body.data_type === 2 ? (options.items ?? []) : (options.branches ?? [{ organization_unit_id: BRANCH, name: 'Trụ sở' }]));
    if (path === '/amiskt/v1/save') return ok(null);
    if (path === '/amiskt/v1/get_call_back_detail_error') return ok(JSON.stringify(options.results ?? []));
    return fail('InvalidParam');
  };
  return { transport, calls };
}

interface Row {
  orgRefid: string;
  digest: string;
  sourceId: string;
  part: number;
  attempts: number;
}

// The rows the push would have queued for these vouchers, so the digests are the ones the person approved.
async function approved(vouchers: CashVoucher[]): Promise<Row[]> {
  const ask = { ...PARAMS, legalEntityId: ENTITY };
  const { entries } = await loadAmisEntries(async () => vouchers as never, ask, amisContextOf(ask), 501);
  return amisPartRows(entries).map((p) => ({ orgRefid: p.orgRefid, digest: p.digest, sourceId: p.sourceId, part: p.part, attempts: 1 }));
}

interface Harness {
  runtime: Runtime;
  broker: CredentialBroker;
  queries: Array<{ name: string; input: unknown }>;
  executed: Array<{ name: string; input: unknown }>;
  begins: Array<Record<string, unknown>>;
  opened: unknown[];
}
// `script` answers push_begin in order; a begin past the script's end answers "nothing, not waiting".
function harness(options: { script?: MisaAmisPushBegin[]; vouchers?: CashVoucher[] | (() => CashVoucher[]); target?: unknown; credential?: () => unknown; matches?: MisaAmisMatchResults } = {}): Harness {
  const queries: Harness['queries'] = [];
  const executed: Harness['executed'] = [];
  const begins: Harness['begins'] = [];
  const opened: unknown[] = [];
  const script = [...(options.script ?? [])];
  const target = options.target ?? { action: 'push', id: CONNECTION, product: 'amis', channelConnectionId: CHANNEL, orgCompanyCode: COMPANY, legalEntityId: ENTITY };
  const runtime = {
    query: async (name: string, input: unknown) => {
      queries.push({ name, input });
      if (name === 'finance.misa_amis.push_target') return target;
      if (name === 'kernel.channel.credential') return options.credential ? options.credential() : { provider: (target as { product?: string }).product === 'asp' ? 'accounting_misa_asp' : 'accounting_misa_amis', externalAccountId: 'entity', keyId: 'k1', envelope: Buffer.from('sealed').toString('base64') };
      if (name === 'finance.vouchers.cash') return typeof options.vouchers === 'function' ? options.vouchers() : (options.vouchers ?? [cash()]);
      if (name === 'finance.misa_amis_match.results') return options.matches ?? NO_MATCH_RESULTS;
      throw new Error(`unexpected query ${name}`);
    },
    execute: async (name: string, input: unknown) => {
      executed.push({ name, input });
      if (name === 'finance.misa_amis.push_begin') {
        begins.push(input as Record<string, unknown>);
        return script.shift() ?? { action: 'none', reason: 'nothing', waiting: false };
      }
      if (name === 'finance.misa_amis.push_record') return { applied: (input as { rows: unknown[] }).rows.length, ignored: 0 };
      return {};
    },
  } as unknown as Runtime;
  const broker = {
    open: (sealed: unknown, binding: unknown) => {
      opened.push({ sealed, binding });
      return ACCESS_CODE;
    },
  } as unknown as CredentialBroker;
  return { runtime, broker, queries, executed, begins, opened };
}

type RecordedInput = { connectionId: string; rows: Array<{ orgRefid: string; attempts: number; from: string; to: string; reason: string | null }>; call: { key: string; end: Record<string, unknown> } | null };
// The attempt every row carries is checked in its own test; the others compare what moved.
const recordsWithAttempts = (h: Harness) => h.executed.filter((e) => e.name === 'finance.misa_amis.push_record').map((e) => e.input as RecordedInput);
const records = (h: Harness) => recordsWithAttempts(h).map((r) => ({ ...r, rows: r.rows.map(({ attempts: _attempts, ...move }) => move) }));
const send = (rows: Row[]): MisaAmisPushBegin => ({ action: 'send', callKey: 'misa_amis:save:test', voucherType: 4, sourceType: 'cash_voucher', params: PARAMS, rows });
const run = (h: Harness, amis: ReturnType<typeof fakeAmis>, now = () => new Date('2026-11-19T03:00:00Z')) =>
  runMisaAmisPush({ runtime: h.runtime, broker: h.broker, client: createAmisClient({ clientId: CLIENT_ID, transport: amis.transport }), now }, { orgId: ORG, connectionId: CONNECTION });

afterEach(() => vi.restoreAllMocks());

describe('the MISA AMIS push job: sending', () => {
  it('reads the branch, rebuilds the voucher from its source with it, sends it, and records "sent" under the ledger call', async () => {
    const rows = await approved([cash()]);
    const h = harness({ script: [{ action: 'need_branch' }, send(rows)] });
    const amis = fakeAmis();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const out = await run(h, amis);
    expect(out).toMatchObject({ state: 'done', batches: 1, sent: 1, failed: 0, waiting: false });
    expect(amis.calls.map((c) => c.path)).toEqual(['/amiskt/v1/token', '/amiskt/v1/get_dictionary', '/amiskt/v1/save']);
    expect(amis.calls[1]?.body).toMatchObject({ data_type: 6 });
    const saved = amis.calls[2]?.body as { org_company_code: string; voucher: Array<Record<string, unknown>> };
    expect(saved.org_company_code).toBe(COMPANY);
    expect(saved.voucher).toHaveLength(1);
    expect(saved.voucher[0]).toMatchObject({ org_refid: SOURCE, voucher_type: 4, branch_id: BRANCH });
    expect(h.begins).toEqual([
      { connectionId: CONNECTION, branchKnown: false, checked: false },
      { connectionId: CONNECTION, branchKnown: true, checked: false },
      { connectionId: CONNECTION, branchKnown: true, checked: false },
    ]);
    expect(records(h)).toEqual([{ connectionId: CONNECTION, rows: [{ orgRefid: SOURCE, from: 'sending', to: 'sent', reason: null }], call: { key: 'misa_amis:save:test', end: { state: 'succeeded' } } }]);
    // The access code is opened for the binding it was sealed under, and only here.
    expect(h.opened).toEqual([{ sealed: { keyId: 'k1', envelope: Buffer.from('sealed') }, binding: { orgId: ORG, provider: 'accounting_misa_amis', externalAccountId: 'entity' } }]);
    // The source is read as the system, for this entity and the batch's own period and choices.
    expect(h.queries.find((q) => q.name === 'finance.vouchers.cash')?.input).toMatchObject({ from: '2026-10-01', to: '2026-10-31', legalEntityId: ENTITY, type: 'cash_payment' });
  });

  it('never sends a voucher that changed since the person approved it: it is `failed` with STALE, and AMIS is not called to save', async () => {
    const rows = await approved([cash()]);
    // The amount of a line changed after the preview.
    const changed = cash({ lines: [{ lineNo: 1, account: '331', amount: '1650001', memo: 'HĐ C26TAA/123' }, { lineNo: 2, account: '6422', amount: '35000.5', memo: null }] });
    const h = harness({ script: [{ action: 'need_branch' }, send(rows)], vouchers: [changed] });
    const amis = fakeAmis();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const out = await run(h, amis);
    expect(out).toMatchObject({ state: 'done', sent: 0, failed: 1 });
    expect(amis.calls.some((c) => c.path === '/amiskt/v1/save')).toBe(false);
    expect(records(h)).toEqual([
      { connectionId: CONNECTION, rows: [{ orgRefid: SOURCE, from: 'sending', to: 'failed', reason: 'STALE' }], call: { key: 'misa_amis:save:test', end: { state: 'failed', kind: 'bad_request', code: 'STALE' } } },
    ]);
  });

  it('writes the voucher with the party code the last check matched, asking for the entity of the target; a check made since the person approved changes the part, so it is STALE and never sent', async () => {
    const rows = await approved([cash()]);
    // The person approved the part with no check done; a check has since matched the party: the part now carries a code the person never saw.
    const checked: MisaAmisMatchResults = {
      connectionId: CONNECTION,
      status: { state: 'done', failure: null, requestedAt: '2026-11-19T11:00:00.000Z', checkedAt: '2026-11-19T11:01:00.000Z' },
      partyCodes: new Map([['0101234564', 'NCC_ABC']]),
      partyAmbiguous: new Set(),
      itemCodes: new Set(),
    };
    const h = harness({ script: [{ action: 'need_branch' }, send(rows)], matches: checked });
    const amis = fakeAmis();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await run(h, amis)).toMatchObject({ state: 'done', sent: 0, failed: 1 });
    expect(h.queries.find((q) => q.name === 'finance.misa_amis_match.results')?.input).toMatchObject({ legalEntityId: ENTITY });
    expect(amis.calls.some((c) => c.path === '/amiskt/v1/save')).toBe(false);
    expect(records(h)[0]?.rows).toEqual([{ orgRefid: SOURCE, from: 'sending', to: 'failed', reason: 'STALE' }]);
  });

  it('sends the part as approved when the check it was approved under is the one still stored, with the matched code written', async () => {
    const checked: MisaAmisMatchResults = {
      connectionId: CONNECTION,
      status: { state: 'done', failure: null, requestedAt: '2026-11-19T11:00:00.000Z', checkedAt: '2026-11-19T11:01:00.000Z' },
      partyCodes: new Map([['0101234564', 'NCC_ABC']]),
      partyAmbiguous: new Set(),
      itemCodes: new Set(),
    };
    // The approved digest is of the part written with the same matches.
    const ask = { ...PARAMS, legalEntityId: ENTITY };
    const { entries } = await loadAmisEntries(async () => [cash()] as never, ask, amisContextOf(ask, undefined, checked), 501);
    const rows = amisPartRows(entries).map((p) => ({ orgRefid: p.orgRefid, digest: p.digest, sourceId: p.sourceId, part: p.part, attempts: 1 }));
    const h = harness({ script: [{ action: 'need_branch' }, send(rows)], matches: checked });
    // The catalogue still holds the entry the check matched, so the re-read before the send agrees with the stored match.
    const amis = fakeAmis({ parties: [PARTY_ENTRY] });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await run(h, amis)).toMatchObject({ state: 'done', sent: 1, failed: 0 });
    const saved = amis.calls.find((c) => c.path === '/amiskt/v1/save');
    expect(JSON.stringify(saved?.body)).toContain('NCC_ABC');
  });

  // Sent only fresh (#4124): the entries the stored matches rely on are read from the catalogue again right before a batch goes out.
  const checkedAs = (partyCodes: Map<string, string> | null): MisaAmisMatchResults => ({
    connectionId: CONNECTION,
    status: { state: 'done', failure: null, requestedAt: '2026-11-19T02:40:00.000Z', checkedAt: '2026-11-19T02:41:00.000Z' },
    partyCodes,
    partyAmbiguous: new Set(),
    itemCodes: new Set(),
  });
  const approvedUnder = async (vouchers: CashVoucher[], matches: MisaAmisMatchResults): Promise<Row[]> => {
    const ask = { ...PARAMS, legalEntityId: ENTITY };
    const { entries } = await loadAmisEntries(async () => vouchers as never, ask, amisContextOf(ask, undefined, matches), 501);
    return amisPartRows(entries).map((p) => ({ orgRefid: p.orgRefid, digest: p.digest, sourceId: p.sourceId, part: p.part, attempts: 1 }));
  };
  const dictionaryReads = (amis: ReturnType<typeof fakeAmis>) => amis.calls.filter((c) => c.path === '/amiskt/v1/get_dictionary').map((c) => c.body.data_type);

  it('reads the party entries again before sending, and sends when the catalogue still says what the check stored', async () => {
    const matches = checkedAs(new Map([['0101234564', 'NCC_ABC']]));
    const rows = await approvedUnder([cash()], matches);
    const h = harness({ script: [{ action: 'need_branch' }, send(rows)], matches });
    const amis = fakeAmis({ parties: [PARTY_ENTRY] });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await run(h, amis)).toMatchObject({ state: 'done', sent: 1, failed: 0 });
    // The branch (6), then the party catalogue (1), and no item read: nothing item-shaped was matched.
    expect(dictionaryReads(amis)).toEqual([6, 1]);
    expect(amis.calls.filter((c) => c.path === '/amiskt/v1/save')).toHaveLength(1);
  });

  it.each([
    ['gone from the catalogue', []],
    ['now inactive', [{ ...PARTY_ENTRY, inactive: true }]],
    ['now with another tax code', [{ ...PARTY_ENTRY, company_tax_code: '0309999990' }]],
    ['now under another code', [{ ...PARTY_ENTRY, account_object_code: 'NCC_KHAC' }]],
    ['now one of two entries with that tax code', [PARTY_ENTRY, { ...PARTY_ENTRY, account_object_code: 'NCC_TRUNG', account_object_id: '0194a1c2-8f3e-7b10-9d4a-1e2f3a4b5c6f' }]],
  ])('refuses the batch with MATCH_STALE and sends nothing when the matched entry is %s', async (_name, parties) => {
    const matches = checkedAs(new Map([['0101234564', 'NCC_ABC']]));
    const rows = await approvedUnder([cash()], matches);
    const h = harness({ script: [{ action: 'need_branch' }, send(rows)], matches });
    const amis = fakeAmis({ parties });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await run(h, amis)).toMatchObject({ state: 'done', sent: 0, failed: 1 });
    expect(amis.calls.some((c) => c.path === '/amiskt/v1/save')).toBe(false);
    expect(records(h)).toEqual([
      { connectionId: CONNECTION, rows: [{ orgRefid: SOURCE, from: 'sending', to: 'failed', reason: 'MATCH_STALE' }], call: { key: 'misa_amis:save:test', end: { state: 'failed', kind: 'bad_request', code: 'MATCH_STALE' } } },
    ]);
  });

  it('reads nothing from the catalogue when no check matched what the batch relies on', async () => {
    const rows = await approved([cash()]);
    const h = harness({ script: [{ action: 'need_branch' }, send(rows)] });
    const amis = fakeAmis();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await run(h, amis)).toMatchObject({ state: 'done', sent: 1 });
    expect(dictionaryReads(amis)).toEqual([6]);
  });

  it('reuses a read for the next batch for five minutes and reads again after that', async () => {
    const other = '0192f0a1-2b3c-7d4e-8f50-6172839a4b5e';
    const matches = checkedAs(new Map([['0101234564', 'NCC_ABC']]));
    const all = await approvedUnder([cash(), cash({ sourceId: other, code: 'PC00013' })], matches);
    const first = all.filter((r) => r.sourceId === SOURCE);
    const second = all.filter((r) => r.sourceId === other);
    const vouchers = [cash(), cash({ sourceId: other, code: 'PC00013' })];
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const quick = fakeAmis({ parties: [PARTY_ENTRY] });
    await run(harness({ script: [{ action: 'need_branch' }, send(first), send(second)], matches, vouchers }), quick);
    expect(dictionaryReads(quick)).toEqual([6, 1]);

    let at = Date.parse('2026-11-19T03:00:00Z');
    const slow = fakeAmis({ parties: [PARTY_ENTRY] });
    // Every look at the clock moves it past the window, so the second batch finds the first read too old.
    const clock = () => new Date((at += CATALOGUE_REREAD_MS + 1));
    await run(harness({ script: [{ action: 'need_branch' }, send(first), send(second)], matches, vouchers }), slow, clock);
    expect(dictionaryReads(slow)).toEqual([6, 1, 1]);
  });

  it('puts the batch back in the queue, sending nothing, when the catalogue cannot be reached or refuses the access code while it is read', async () => {
    const matches = checkedAs(new Map([['0101234564', 'NCC_ABC']]));
    const rows = await approvedUnder([cash()], matches);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const [response, outcome, reason, code] of [
      [{ status: 503, body: '' }, { state: 'unreachable', waiting: true }, 'BUILD_FAILED', 'BUILD_FAILED'],
      [fail('InvalidAccessToken'), { state: 'credentials', waiting: false }, 'CREDENTIALS', 'CREDENTIALS'],
    ] as const) {
      const h = harness({ script: [{ action: 'need_branch' }, send(rows)], matches });
      const amis = fakeAmis({ behave: (path, body) => (path.endsWith('/get_dictionary') && body.data_type === 1 ? response : undefined) });
      expect(await run(h, amis), reason).toEqual(outcome);
      expect(amis.calls.some((c) => c.path === '/amiskt/v1/save')).toBe(false);
      expect(records(h)[0]?.rows).toEqual([{ orgRefid: SOURCE, from: 'sending', to: 'queued', reason }]);
      expect(records(h)[0]?.call?.end).toMatchObject({ state: 'failed', code });
    }
  });

  it('fails the batch with MATCH_UNREAD, never sending a guess, when the catalogue is too large to read whole or answers no page, and goes on to the next batch', async () => {
    const matches = checkedAs(new Map([['0101234564', 'NCC_ABC']]));
    const rows = await approvedUnder([cash()], matches);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const full = Array.from({ length: 1000 }, (_v, i) => ({ account_object_code: `K${i}`, company_tax_code: '0309999990' }));
    for (const behave of [
      (path: string, body: Record<string, unknown>) => (path.endsWith('/get_dictionary') && body.data_type === 1 ? ok(full) : undefined),
      (path: string, body: Record<string, unknown>) => (path.endsWith('/get_dictionary') && body.data_type === 1 ? { status: 200, body: 'not json' } : undefined),
    ]) {
      const h = harness({ script: [{ action: 'need_branch' }, send(rows)], matches });
      const amis = fakeAmis({ behave });
      expect(await run(h, amis)).toMatchObject({ state: 'done', sent: 0, failed: 1 });
      expect(amis.calls.some((c) => c.path === '/amiskt/v1/save')).toBe(false);
      expect(records(h)[0]?.rows).toEqual([{ orgRefid: SOURCE, from: 'sending', to: 'failed', reason: 'MATCH_UNREAD' }]);
    }
  });

  it('does not read a catalogue that failed once again for the next batch of the run, and fails that batch at once', async () => {
    const other = '0192f0a1-2b3c-7d4e-8f50-6172839a4b5e';
    const matches = checkedAs(new Map([['0101234564', 'NCC_ABC']]));
    const all = await approvedUnder([cash(), cash({ sourceId: other, code: 'PC00013' })], matches);
    const vouchers = [cash(), cash({ sourceId: other, code: 'PC00013' })];
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const full = Array.from({ length: 1000 }, (_v, i) => ({ account_object_code: `K${i}`, company_tax_code: '0309999990' }));
    const amis = fakeAmis({ behave: (path, body) => (path.endsWith('/get_dictionary') && body.data_type === 1 ? ok(full) : undefined) });
    const h = harness({ script: [{ action: 'need_branch' }, send(all.filter((r) => r.sourceId === SOURCE)), send(all.filter((r) => r.sourceId === other))], matches, vouchers });
    expect(await run(h, amis)).toMatchObject({ state: 'done', sent: 0, failed: 2 });
    // 20 pages of 1000 for the first batch, none for the second.
    expect(dictionaryReads(amis).filter((t) => t === 1)).toHaveLength(20);
    expect(records(h).map((r) => r.rows.map((x) => [x.orgRefid, x.reason]))).toEqual([[[SOURCE, 'MATCH_UNREAD']], [[other, 'MATCH_UNREAD']]]);
  });

  it('treats a token MISA refuses while the catalogue is read like a refused access code', async () => {
    const matches = checkedAs(new Map([['0101234564', 'NCC_ABC']]));
    const rows = await approvedUnder([cash()], matches);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = harness({ script: [{ action: 'need_branch' }, send(rows)], matches });
    const amis = fakeAmis({ behave: (path, body) => (path.endsWith('/get_dictionary') && body.data_type === 1 ? fail('InvalidToken') : undefined) });
    expect(await run(h, amis)).toEqual({ state: 'credentials', waiting: false });
    expect(records(h)[0]?.rows).toEqual([{ orgRefid: SOURCE, from: 'sending', to: 'queued', reason: 'CREDENTIALS' }]);
  });

  it('in one batch says STALE for the part that changed since the person approved it and MATCH_STALE for the others when a match no longer holds', async () => {
    const other = '0192f0a1-2b3c-7d4e-8f50-6172839a4b5e';
    const matches = checkedAs(new Map([['0101234564', 'NCC_ABC']]));
    const all = await approvedUnder([cash(), cash({ sourceId: other, code: 'PC00013' })], matches);
    const changed = cash({ lines: [{ lineNo: 1, account: '331', amount: '999', memo: null }] });
    const h = harness({ script: [{ action: 'need_branch' }, send(all)], matches, vouchers: [changed, cash({ sourceId: other, code: 'PC00013' })] });
    const amis = fakeAmis({ parties: [] });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await run(h, amis)).toMatchObject({ state: 'done', sent: 0, failed: 2 });
    expect(amis.calls.some((c) => c.path === '/amiskt/v1/save')).toBe(false);
    const reasons = Object.fromEntries((records(h)[0]?.rows ?? []).map((r) => [r.orgRefid, r.reason]));
    expect(reasons).toEqual({ [SOURCE]: 'STALE', [other]: 'MATCH_STALE' });
  });

  it('every batch is rebuilt from the source: a voucher changed between two batches of one run is STALE in the second, one that is unchanged is still sent', async () => {
    const other = '0192f0a1-2b3c-7d4e-8f50-6172839a4b5e';
    const a = cash();
    const b = cash({ sourceId: other, code: 'PC00013' });
    const rowsA = await approved([a]);
    const rowsB = await approved([a, b]).then((all) => all.filter((r) => r.sourceId === other));
    const changedB = cash({ sourceId: other, code: 'PC00013', lines: [{ lineNo: 1, account: '331', amount: '999', memo: null }] });
    let reads = 0;
    // The first read (batch 1) sees A and B as approved; the second (batch 2) sees B changed.
    const h = harness({ script: [{ action: 'need_branch' }, send(rowsA), send(rowsB)], vouchers: () => (reads++ === 0 ? [a, b] : [a, changedB]) });
    const amis = fakeAmis();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const out = await run(h, amis);
    expect(reads).toBe(2);
    expect(out).toMatchObject({ state: 'done', sent: 1, failed: 1 });
    const saves = amis.calls.filter((c) => c.path === '/amiskt/v1/save');
    expect(saves).toHaveLength(1);
    expect(records(h).map((r) => r.rows.map((x) => [x.orgRefid, x.to]))).toEqual([[[SOURCE, 'sent']], [[other, 'failed']]]);
  });

  it('a voucher gone from its period (or blocked now) is STALE too, and one that is still good in the same batch is still sent', async () => {
    const other = '0192f0a1-2b3c-7d4e-8f50-6172839a4b5e';
    const rows = await approved([cash(), cash({ sourceId: other, code: 'PC00013' })]);
    const h = harness({ script: [{ action: 'need_branch' }, send(rows)], vouchers: [cash()] });
    const amis = fakeAmis();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await run(h, amis);
    const saved = amis.calls.find((c) => c.path === '/amiskt/v1/save')?.body as { voucher: Array<{ org_refid: string }> };
    expect(saved.voucher.map((v) => v.org_refid)).toEqual([SOURCE]);
    expect(records(h)[0]?.rows).toEqual([
      { orgRefid: other, from: 'sending', to: 'failed', reason: 'STALE' },
      { orgRefid: SOURCE, from: 'sending', to: 'sent', reason: null },
    ]);
  });

  it('fails the batch with BRANCH_UNKNOWN, never a guess, when AMIS has no single branch', async () => {
    for (const branches of [[], [{ organization_unit_id: BRANCH }, { organization_unit_id: '0192f0a1-2b3c-7d4e-8f50-6172839a4b5e' }], [{ name: 'no id here' }]]) {
      const rows = await approved([cash()]);
      const h = harness({ script: [{ action: 'need_branch' }, send(rows)] });
      const amis = fakeAmis({ branches });
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      expect(await run(h, amis)).toMatchObject({ state: 'done', sent: 0, failed: 1 });
      expect(amis.calls.some((c) => c.path === '/amiskt/v1/save')).toBe(false);
      expect(records(h)[0]?.rows).toEqual([{ orgRefid: SOURCE, from: 'sending', to: 'failed', reason: 'BRANCH_UNKNOWN' }]);
    }
  });

  it('sends a split voucher\'s parts in one batch, each part under its own id', async () => {
    const lines = Array.from({ length: 501 }, (_, i) => ({ lineNo: i + 1, account: '6422', amount: '1000', memo: null }));
    const rows = await approved([cash({ code: 'PC1234567', lines })]);
    expect(rows).toHaveLength(2);
    const h = harness({ script: [{ action: 'need_branch' }, send(rows)], vouchers: [cash({ code: 'PC1234567', lines })] });
    const amis = fakeAmis();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await run(h, amis)).toMatchObject({ sent: 2, failed: 0 });
    const saved = amis.calls.find((c) => c.path === '/amiskt/v1/save')?.body as { voucher: Array<{ org_refid: string; org_refno: string; detail: unknown[] }> };
    expect(saved.voucher.map((v) => v.detail.length)).toEqual([500, 1]);
    expect(saved.voucher.map((v) => v.org_refid)).toEqual(rows.map((r) => r.orgRefid));
    expect(saved.voucher.map((v) => v.org_refno.length).every((n) => n <= 20)).toBe(true);
  });
});

describe('the MISA AMIS push job: how a send ends', () => {
  const setup = async (behave: (path: string, body: Record<string, unknown>) => AmisResponse | Promise<AmisResponse> | undefined) => {
    const rows = await approved([cash()]);
    const h = harness({ script: [{ action: 'need_branch' }, send(rows)] });
    const amis = fakeAmis({ behave });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    return { h, amis, warn };
  };

  it('a lost answer leaves the rows `ambiguous` and the call ambiguous, and nothing is sent again in this run', async () => {
    for (const lost of [new AmisError('timeout'), new AmisError('lost_answer')]) {
      const { h, amis } = await setup((path) => {
        if (path === '/amiskt/v1/save') throw lost;
        return undefined;
      });
      expect(await run(h, amis)).toMatchObject({ state: 'done', sent: 0 });
      expect(amis.calls.filter((c) => c.path === '/amiskt/v1/save')).toHaveLength(1);
      expect(records(h)[0]?.rows).toEqual([{ orgRefid: SOURCE, from: 'sending', to: 'ambiguous', reason: 'LOST_ANSWER' }]);
      expect(records(h)[0]?.call?.end).toMatchObject({ state: 'ambiguous' });
    }
  });

  it('an unreachable AMIS (nothing was sent) puts the rows back in the queue and asks to be tried again, and the call is closed as never made', async () => {
    const { h, amis } = await setup((path) => {
      if (path === '/amiskt/v1/save') throw new AmisError('unreachable');
      return undefined;
    });
    expect(await run(h, amis)).toEqual({ state: 'unreachable', waiting: true });
    expect(records(h)).toEqual([
      { connectionId: CONNECTION, rows: [{ orgRefid: SOURCE, from: 'sending', to: 'queued', reason: 'UNREACHABLE' }], call: { key: 'misa_amis:save:test', end: { state: 'failed', kind: 'transient', code: 'UNREACHABLE' } } },
    ]);
  });

  it('a batch that cannot be built (a failed read of the source) goes back to the queue, nothing is sent, and the run asks to be tried again', async () => {
    const rows = await approved([cash()]);
    const h = harness({ script: [{ action: 'need_branch' }, send(rows)] });
    const amis = fakeAmis();
    const failingRuntime = { ...h.runtime, query: async (name: string, input: unknown) => {
      if (name === 'finance.vouchers.cash') throw new Error('database down');
      return (h.runtime.query as (n: string, i: unknown) => Promise<unknown>)(name, input);
    } } as unknown as Runtime;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await runMisaAmisPush({ runtime: failingRuntime, broker: h.broker, client: createAmisClient({ clientId: CLIENT_ID, transport: amis.transport }) }, { orgId: ORG, connectionId: CONNECTION })).toEqual({ state: 'unreachable', waiting: true });
    expect(amis.calls.some((c) => c.path === '/amiskt/v1/save')).toBe(false);
    expect(records(h)[0]?.rows).toEqual([{ orgRefid: SOURCE, from: 'sending', to: 'queued', reason: 'BUILD_FAILED' }]);
  });

  it('reads the source again for every batch of a long queue, never reusing what an earlier batch read', async () => {
    const rows = await approved([cash()]);
    const h = harness({ script: [{ action: 'need_branch' }, send(rows), send(rows)] });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await run(h, fakeAmis());
    expect(h.queries.filter((q) => q.name === 'finance.vouchers.cash')).toHaveLength(2);
  });

  it('a 5xx (it may have been processed) is ambiguous too, never a refusal', async () => {
    const { h, amis } = await setup((path) => (path === '/amiskt/v1/save' ? { status: 503, body: 'planted gateway text' } : undefined));
    await run(h, amis);
    expect(records(h)[0]?.rows[0]).toMatchObject({ to: 'ambiguous' });
  });

  it('a refused connection puts the rows back in the queue with CREDENTIALS and sends nothing more', async () => {
    const { h, amis } = await setup((path) => (path === '/amiskt/v1/save' ? fail('InvalidAccessToken') : undefined));
    expect(await run(h, amis)).toEqual({ state: 'credentials', waiting: false });
    expect(records(h)).toEqual([
      { connectionId: CONNECTION, rows: [{ orgRefid: SOURCE, from: 'sending', to: 'queued', reason: 'CREDENTIALS' }], call: { key: 'misa_amis:save:test', end: { state: 'failed', kind: 'permission', code: 'CREDENTIALS' } } },
    ]);
  });

  it('a request MISA understood and refused is `refused` with the text of its code, never MISA\'s own words', async () => {
    const { h, amis } = await setup((path) => (path === '/amiskt/v1/save' ? fail('InvalidParam', `planted ${ACCESS_CODE} ${PARTY_NAME}`) : undefined));
    await run(h, amis);
    expect(records(h)[0]?.rows).toEqual([{ orgRefid: SOURCE, from: 'sending', to: 'refused', reason: 'AMIS từ chối vì dữ liệu gửi lên không hợp lệ' }]);
    expect(records(h)[0]?.call?.end).toEqual({ state: 'failed', kind: 'bad_request', code: 'InvalidParam' });
  });

  it('a batch the client refuses before sending (more lines than MISA takes) is `failed` with a code, and the call is not ambiguous', async () => {
    const rows = await approved([cash()]);
    const h = harness({ script: [{ action: 'need_branch' }, send(rows)] });
    const amis = fakeAmis();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = createAmisClient({ clientId: CLIENT_ID, transport: amis.transport });
    const failing = { ...client, save: async () => { throw new AmisError('invalid_request', { reason: 'bad_amount' }); } };
    await runMisaAmisPush({ runtime: h.runtime, broker: h.broker, client: failing }, { orgId: ORG, connectionId: CONNECTION });
    expect(records(h)[0]?.rows).toEqual([{ orgRefid: SOURCE, from: 'sending', to: 'failed', reason: 'INVALID:bad_amount' }]);
    expect(records(h)[0]?.call?.end).toEqual({ state: 'failed', kind: 'bad_request', code: 'bad_amount' });
  });

  it('records and logs only ids, codes and states: not the access code, the ClientID, a party\'s name or MISA\'s text', async () => {
    const { h, amis, warn } = await setup((path) => (path === '/amiskt/v1/save' ? fail('InvalidParam', `planted ${ACCESS_CODE} ${PARTY_NAME}`) : undefined));
    const log = vi.spyOn(console, 'log');
    await run(h, amis);
    const everything = JSON.stringify([h.executed, warn.mock.calls, log.mock.calls]);
    for (const secret of [ACCESS_CODE, CLIENT_ID, PARTY_NAME, 'planted AMIS text', 'planted gateway']) expect(everything, secret).not.toContain(secret);
  });
});

describe('the MISA AMIS push job: asking MISA for results', () => {
  const check = (rows: Array<{ orgRefid: string; state: 'sent' | 'ambiguous'; attempts?: number }>): MisaAmisPushBegin => ({ action: 'check', rows: rows.map((r) => ({ ...r, attempts: r.attempts ?? 1 })), from: '2026-11-18' });
  const result = (orgRefId: string, success: boolean, message = '') => ({ org_refid: orgRefId, voucher_type: 4, success, error_code: success ? null : 'InvalidParam', error_message: message, session_id: 's1' });

  it('reads the results of the days since the first row was sent and moves the rows MISA answered: accepted, or refused with MISA\'s text (capped)', async () => {
    const other = '0192f0a1-2b3c-7d4e-8f50-6172839a4b5e';
    const third = '0192f0a1-2b3c-7d4e-8f50-6172839a4b5f';
    const h = harness({ script: [check([{ orgRefid: SOURCE, state: 'sent' }, { orgRefid: other, state: 'ambiguous' }, { orgRefid: third, state: 'sent' }])] });
    const amis = fakeAmis({ results: [result(SOURCE, true), result(other, false, 'Số chứng từ đã tồn tại '.repeat(40))] });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const out = await run(h, amis);
    expect(out).toMatchObject({ state: 'done', accepted: 1, refused: 1 });
    const call = amis.calls.find((c) => c.path === '/amiskt/v1/get_call_back_detail_error');
    // A day before the first row was sent (MISA's time zone is not documented) to tomorrow.
    expect(call?.body).toMatchObject({ from_date: '2026-11-17', to_date: '2026-11-20', skip: '0', take: '1000' });
    const rows = records(h)[0]?.rows ?? [];
    expect(rows.map((r) => [r.orgRefid, r.from, r.to])).toEqual([
      [SOURCE, 'sent', 'accepted'],
      [other, 'ambiguous', 'refused'],
    ]);
    // The row MISA did not mention is left as it is: nothing is told about it, and it is never sent again.
    expect(rows.some((r) => r.orgRefid === third)).toBe(false);
    expect(rows[1]?.reason?.length).toBeGreaterThan(0);
    expect(records(h)[0]?.call).toBeNull();
    // Checked once, then the run goes on to send (the begin that follows says checked).
    expect(h.begins[1]).toEqual({ connectionId: CONNECTION, branchKnown: false, checked: true });
  });

  it('carries the attempt each row was begun under into what it records, for a checked row and a sent one', async () => {
    const rows = (await approved([cash()])).map((r) => ({ ...r, attempts: 3 }));
    const h = harness({ script: [check([{ orgRefid: SOURCE, state: 'sent', attempts: 2 }]), { action: 'need_branch' }, send(rows)] });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await run(h, fakeAmis({ results: [result(SOURCE, true)] }));
    const recorded = recordsWithAttempts(h);
    expect(recorded[0]?.rows.map((r) => [r.to, r.attempts])).toEqual([['accepted', 2]]);
    expect(recorded[1]?.rows.map((r) => [r.to, r.attempts])).toEqual([['sent', 3]]);
  });

  it('records nothing when MISA has no answer yet, and reports that rows are waiting', async () => {
    const h = harness({ script: [check([{ orgRefid: SOURCE, state: 'sent' }]), { action: 'none', reason: 'nothing', waiting: true }] });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const out = await run(h, fakeAmis({ results: [] }));
    expect(out).toMatchObject({ state: 'done', accepted: 0, refused: 0, waiting: true });
    expect(records(h)).toEqual([]);
  });

  it('an AMIS that cannot be asked leaves the rows as they are, and the queued batches still go out', async () => {
    const rows = await approved([cash()]);
    const h = harness({ script: [check([{ orgRefid: '0192f0a1-2b3c-7d4e-8f50-6172839a4b5e', state: 'ambiguous' }]), { action: 'need_branch' }, send(rows)] });
    const amis = fakeAmis({ behave: (path) => (path === '/amiskt/v1/get_call_back_detail_error' ? { status: 503, body: 'down' } : undefined) });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await run(h, amis)).toMatchObject({ state: 'done', sent: 1 });
    expect(records(h).map((r) => r.rows.map((x) => x.to))).toEqual([['sent']]);
  });
});

describe('the MISA AMIS push job: when it does nothing', () => {
  it('leaves a connection that is gone or no longer active alone: nothing is opened, asked or begun', async () => {
    for (const reason of ['not_found', 'not_active'] as const) {
      const h = harness({ target: { action: 'none', reason } });
      const amis = fakeAmis();
      expect(await run(h, amis)).toEqual({ state: 'skipped', reason });
      expect(h.opened).toEqual([]);
      expect(amis.calls).toEqual([]);
      expect(h.executed).toEqual([]);
    }
  });

  it('opens only a credential sealed for this connector, and begins nothing when another provider\'s is found', async () => {
    const h = harness({ credential: () => ({ provider: 'marketplace_sandbox', externalAccountId: 'entity', keyId: 'k1', envelope: Buffer.from('sealed').toString('base64') }) });
    const amis = fakeAmis();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await run(h, amis)).toEqual({ state: 'credentials', waiting: false });
    expect(h.opened).toEqual([]);
    expect(amis.calls).toEqual([]);
    expect(h.executed).toEqual([]);
    expect(warn.mock.calls).toEqual([['[misa-amis] push 22222222: credential of another provider, not opened']]);
  });

  it('a connector\'s member who left expires the connection and nothing is begun', async () => {
    const h = harness({
      credential: () => {
        throw new DomainError('CHANNEL_OWNER_LEFT', 409, 'left');
      },
    });
    const amis = fakeAmis();
    expect(await run(h, amis)).toEqual({ state: 'credentials', waiting: false });
    expect(h.executed).toEqual([{ name: 'kernel.channel.mark_expired', input: { connectionId: CHANNEL, reason: 'owner_left' } }]);
    expect(amis.calls).toEqual([]);
  });

  it('an unreachable AMIS when the branch is read leaves the queued rows queued (nothing was begun past the look) and asks to be tried again', async () => {
    const rows = await approved([cash()]);
    const h = harness({ script: [{ action: 'need_branch' }, send(rows)] });
    const amis = fakeAmis({ behave: (path) => (path === '/amiskt/v1/get_dictionary' ? { status: 503, body: 'down' } : undefined) });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await run(h, amis)).toEqual({ state: 'unreachable', waiting: true });
    expect(records(h)).toEqual([]);
  });

  it('a refused connection when the branch is read ends the run with the rows still queued', async () => {
    const rows = await approved([cash()]);
    const h = harness({ script: [{ action: 'need_branch' }, send(rows)] });
    const amis = fakeAmis({ behave: (path) => (path === '/amiskt/v1/get_dictionary' ? fail('InvalidAccessToken') : undefined) });
    expect(await run(h, amis)).toEqual({ state: 'credentials', waiting: false });
    expect(records(h)).toEqual([]);
  });
});

describe('the MISA AMIS push job: when it comes back', () => {
  const job = { orgId: ORG, connectionId: CONNECTION };
  const done = (waiting: boolean): MisaAmisPushOutcome => ({ state: 'done', batches: 0, sent: 0, failed: 0, accepted: 0, refused: 0, waiting });

  it('queues the next round under a key of its own round, never the key of the run that is active, so the exclusive queue does not drop it', () => {
    const keys = new Set<string>([CONNECTION]);
    let current: typeof job & { round?: number } = job;
    for (let i = 0; i < 5; i++) {
      const next = pushFollowUp(current, done(true));
      expect(next).not.toBeNull();
      expect(keys.has(next?.keyTail as string)).toBe(false);
      keys.add(next?.keyTail as string);
      expect(next?.startAfterSeconds).toBe(PUSH_RECHECK_SECONDS);
      current = next?.data as typeof current;
      expect(current.round).toBe(i + 1);
    }
    expect([...keys].every((k) => k.startsWith(CONNECTION))).toBe(true);
  });

  it('while rows wait for MISA it keeps coming back for a day, and then stops', () => {
    expect(pushFollowUp({ ...job, round: PUSH_WAIT_ROUNDS - 1 }, done(true))).not.toBeNull();
    expect(pushFollowUp({ ...job, round: PUSH_WAIT_ROUNDS }, done(true))).toBeNull();
  });

  it('a run that came from a press asks once more a minute later even when nothing waits (a safety net: a press has a job of its own now); later rounds with nothing waiting stop', () => {
    const once = pushFollowUp(job, done(false));
    expect(once).toMatchObject({ startAfterSeconds: PUSH_PRESS_RECHECK_SECONDS, data: { round: 1 } });
    expect(pushFollowUp({ ...job, round: 1 }, done(false))).toBeNull();
  });

  it('an unreachable AMIS is tried a few more times in a row, a refused connection or a skipped connection is not', () => {
    const unreachable: MisaAmisPushOutcome = { state: 'unreachable', waiting: true };
    expect(pushFollowUp(job, unreachable)).toMatchObject({ data: { round: 1, unreachable: 1 } });
    expect(pushFollowUp({ ...job, unreachable: PUSH_UNREACHABLE_ROUNDS - 1 }, unreachable)).toMatchObject({ data: { unreachable: PUSH_UNREACHABLE_ROUNDS } });
    expect(pushFollowUp({ ...job, unreachable: PUSH_UNREACHABLE_ROUNDS }, unreachable)).toBeNull();
    expect(pushFollowUp(job, { state: 'credentials', waiting: false })).toBeNull();
    expect(pushFollowUp(job, { state: 'skipped', reason: 'not_found' })).toBeNull();
  });

  it('the unreachable count is of runs in a row: late in a long waiting chain an unreachable answer is not the end, a run that reached AMIS starts the count again, and the day of rounds still ends the chain (#4041)', () => {
    const unreachable: MisaAmisPushOutcome = { state: 'unreachable', waiting: true };
    // A chain far into its day (round 300, as many rounds as ten unreachable ones would never reach) goes on after its first unreachable answer.
    expect(pushFollowUp({ ...job, round: 300 }, unreachable)).toMatchObject({ startAfterSeconds: PUSH_RECHECK_SECONDS, data: { round: 301, unreachable: 1 } });
    // Nine unreachable runs and then one that reached AMIS: the next follow-up carries no count, so ten more unreachable runs are allowed.
    const reached = pushFollowUp({ ...job, round: 9, unreachable: 9 }, done(true));
    expect(reached?.data).toEqual({ orgId: ORG, connectionId: CONNECTION, round: 10 });
    expect(pushFollowUp(reached?.data as typeof job, unreachable)).toMatchObject({ data: { unreachable: 1 } });
    // The whole chain is still bounded by its day of rounds, unreachable or not.
    expect(pushFollowUp({ ...job, round: PUSH_WAIT_ROUNDS }, unreachable)).toBeNull();
  });

  it('a press has a job of its own: its key tail names the press, differs from every follow-up tail and from another press, and is the same for the same event delivered twice (#4041)', () => {
    const a = pushPressKeyTail(CONNECTION, 'event-a');
    expect(a).toBe(pushPressKeyTail(CONNECTION, 'event-a'));
    expect(a).not.toBe(pushPressKeyTail(CONNECTION, 'event-b'));
    expect(a.startsWith(CONNECTION)).toBe(true);
    const tails = new Set<string>([a]);
    let current: typeof job & { round?: number } = job;
    for (let i = 0; i < 20; i++) {
      const next = pushFollowUp(current, done(true));
      expect(tails.has(next?.keyTail as string)).toBe(false);
      tails.add(next?.keyTail as string);
      current = next?.data as typeof current;
    }
    // The first job of a connection used to be keyed by the bare connection id: no press tail is that.
    expect(a).not.toBe(CONNECTION);
  });
});

describe('the MISA AMIS push job: when a chain gives up it says so, and a row on its way is not flipped (#4041)', () => {
  const job = { orgId: ORG, connectionId: CONNECTION };
  const done = (waiting: boolean): MisaAmisPushOutcome => ({ state: 'done', batches: 0, sent: 0, failed: 0, accepted: 0, refused: 0, waiting });
  const outcomes: Array<[string, MisaAmisPushOutcome]> = [
    ['waiting', done(true)],
    ['nothing waits', done(false)],
    ['unreachable', { state: 'unreachable', waiting: true }],
    ['credentials', { state: 'credentials', waiting: false }],
    ['skipped', { state: 'skipped', reason: 'not_active' }],
  ];

  it('says nothing while the chain goes on, and never for a chain with nothing waiting', () => {
    for (const [, outcome] of outcomes) {
      if (pushFollowUp(job, outcome) !== null) expect(pushGiveUp(job, outcome)).toBeNull();
    }
    expect(pushGiveUp({ ...job, round: 3 }, done(false))).toBeNull();
    expect(pushGiveUp(job, done(false))).toBeNull();
  });

  it('says why the chain stopped for each way it stops with rows that may still wait', () => {
    expect(pushGiveUp({ ...job, round: PUSH_WAIT_ROUNDS }, done(true))).toContain('rows still wait for MISA');
    expect(pushGiveUp({ ...job, unreachable: PUSH_UNREACHABLE_ROUNDS }, { state: 'unreachable', waiting: true })).toContain('AMIS unreachable');
    expect(pushGiveUp(job, { state: 'credentials', waiting: false })).toContain('access code not usable');
    expect(pushGiveUp(job, { state: 'skipped', reason: 'not_active' })).toContain('connection left alone (not_active)');
  });

  it('names ids and codes only: a short connection id and a short org id, no access code and no name', () => {
    const lines = [
      pushGiveUp({ ...job, round: PUSH_WAIT_ROUNDS }, done(true)),
      pushGiveUp({ ...job, unreachable: PUSH_UNREACHABLE_ROUNDS }, { state: 'unreachable', waiting: true }),
      pushGiveUp(job, { state: 'credentials', waiting: false }),
      pushGiveUp(job, { state: 'skipped', reason: 'not_found' }),
    ] as string[];
    for (const line of lines) {
      expect(line.startsWith(`[misa-amis] push ${CONNECTION.slice(0, 8)} (org ${ORG.slice(0, 8)}): chain stopped at round `)).toBe(true);
      expect(line).not.toContain(CONNECTION);
      expect(line).not.toContain(ORG);
      expect(line).not.toContain(ACCESS_CODE);
      expect(line).not.toContain(PARTY_NAME);
    }
  });

  it('keeps a `sending` row for longer than a call can take: the begin step does not flip a row whose save or token renewal is still inside the transport deadline', () => {
    const transport = readFileSync(fileURLToPath(new URL('../src/misa-amis-transport.ts', import.meta.url)), 'utf8');
    const deadlineSeconds = Number(/const TIMEOUT_MS = (\d[\d_]*);/.exec(transport)?.[1]?.replaceAll('_', '')) / 1000;
    // A reformat of the constant in the transport that this pattern cannot read fails here: update the pattern, not the window.
    expect(deadlineSeconds, 'the transport\'s `const TIMEOUT_MS = ...;` could not be read').toBeGreaterThan(0);
    // At worst four requests (a token request, a save refused for its token, a second token request and a second save: the one renewal of an expired token), each at the deadline, then the rebuild of the batch
    // and the record, given two minutes.
    expect(PUSH_IN_FLIGHT_SECONDS).toBeGreaterThanOrEqual(4 * deadlineSeconds + 120);
  });
});

// MISA ASP (#4113, S4 of #4103): the same steps with ASP's client on ASP's paths; the job opens only a code sealed for the connection's product, leaves a product it has no client for alone, and never asks MISA for results
// of an ASP row (its results come by the callback or from a person).
describe('the MISA AMIS push job: a MISA ASP connection', () => {
  const aspTarget = { action: 'push', id: CONNECTION, product: 'asp', channelConnectionId: CHANNEL, orgCompanyCode: COMPANY, legalEntityId: ENTITY };
  // The ASP client over a fake that answers on ASP's paths with the same envelope.
  function fakeAsp() {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const transport: AmisTransport = async (request: AmisRequest) => {
      const path = new URL(request.url).pathname.replace(/^\/apis/, '');
      const body = JSON.parse(request.body) as Record<string, unknown>;
      calls.push({ path, body });
      if (request.headers.ClientID !== CLIENT_ID) return fail('InvalidAPPID');
      if (path === '/asp/v1/token') return body.access_code === ACCESS_CODE && body.org_company_code === COMPANY ? ok({ access_token: 'token-1', expired_time: '2027-01-19T20:00:00' }) : fail('InvalidAccessToken');
      if (request.headers['X-MISA-AccessToken'] !== 'token-1') return fail('InvalidToken');
      if (path === '/asp/v1/get_dictionary') return ok([{ organization_unit_id: BRANCH, name: 'Trụ sở' }]);
      if (path === '/asp/v1/save') return ok(null);
      return fail('InvalidParam');
    };
    return { transport, calls, client: createAmisClient({ clientId: CLIENT_ID, product: 'asp', transport }) };
  }
  const runAsp = (h: Harness, deps: { client?: ReturnType<typeof createAmisClient> | null; aspClient?: ReturnType<typeof createAmisClient> | null }) =>
    runMisaAmisPush({ runtime: h.runtime, broker: h.broker, client: deps.client ?? null, aspClient: deps.aspClient ?? null, now: () => new Date('2026-11-19T03:00:00Z') }, { orgId: ORG, connectionId: CONNECTION });

  it('sends through the ASP client on ASP\'s paths, opens the code sealed for ASP, and records "sent"', async () => {
    const rows = await approved([cash()]);
    const h = harness({ script: [{ action: 'need_branch' }, send(rows)], target: aspTarget });
    const asp = fakeAsp();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    // The AMIS client is not even handed over: the product decides.
    const out = await runAsp(h, { aspClient: asp.client });
    expect(out).toMatchObject({ state: 'done', batches: 1, sent: 1, failed: 0, waiting: false });
    expect(asp.calls.map((c) => c.path)).toEqual(['/asp/v1/token', '/asp/v1/get_dictionary', '/asp/v1/save']);
    expect(h.opened).toEqual([{ sealed: { keyId: 'k1', envelope: Buffer.from('sealed') }, binding: { orgId: ORG, provider: 'accounting_misa_asp', externalAccountId: 'entity' } }]);
    expect(records(h)).toEqual([{ connectionId: CONNECTION, rows: [{ orgRefid: SOURCE, from: 'sending', to: 'sent', reason: null }], call: { key: 'misa_amis:save:test', end: { state: 'succeeded' } } }]);
  });

  it('leaves a connection alone when the deployment has no client for its product, and opens nothing and calls no one', async () => {
    const h = harness({ target: aspTarget });
    const amis = fakeAmis();
    // Only the AMIS client is on: an ASP connection is never pushed with it.
    const out = await runAsp(h, { client: createAmisClient({ clientId: CLIENT_ID, transport: amis.transport }) });
    expect(out).toEqual({ state: 'skipped', reason: 'product_off' });
    expect(amis.calls).toEqual([]);
    expect(h.opened).toEqual([]);
    expect(h.begins).toEqual([]);
  });

  it('opens no access code sealed for another provider: the AMIS code of an ASP connection is not read, and nothing is called', async () => {
    const h = harness({ target: aspTarget, credential: () => ({ provider: 'accounting_misa_amis', externalAccountId: 'entity', keyId: 'k1', envelope: Buffer.from('sealed').toString('base64') }) });
    const asp = fakeAsp();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await runAsp(h, { aspClient: asp.client })).toEqual({ state: 'credentials', waiting: false });
    expect(h.opened).toEqual([]);
    expect(asp.calls).toEqual([]);
  });

  it('never asks MISA for results of an ASP row: the job has no polling step, and the follow-up is not queued for a row that waits for the callback', async () => {
    const h = harness({ target: aspTarget, script: [{ action: 'none', reason: 'nothing', waiting: false }] });
    const asp = fakeAsp();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const out = await runAsp(h, { aspClient: asp.client });
    expect(out).toMatchObject({ state: 'done', waiting: false });
    expect(asp.calls).toEqual([]);
    // Past the press's own one more look (round 1 has nothing left), the chain ends.
    expect(pushFollowUp({ orgId: ORG, connectionId: CONNECTION, round: 1 }, out)).toBeNull();
  });
});
