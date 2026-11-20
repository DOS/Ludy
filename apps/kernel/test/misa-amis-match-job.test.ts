// SPDX-License-Identifier: AGPL-3.0-only
// The check of a MISA AMIS or MISA ASP connection's vouchers against the firm's catalogue, the worker's half (#4112, S3a, and #4152 of #4103), against a fake MISA and a fake runtime: which pages it reads, what it records (codes and ids
// only), every way a check ends, and that nothing of the catalogue (a name, an address, a tax code of an entry), the access code or the ClientID is recorded or logged.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAmisClient, type AmisRequest, type AmisResponse, type AmisTransport } from '@crove/misa-amis';
import { DomainError, type CredentialBroker, type Runtime } from '@crove/kernel-runtime';
import { zMisaAmisMatchRecordCheck } from '@crove/kernel-contract';
import { runMisaAmisMatch } from '../src/misa-amis-match-job.ts';

const CLIENT_ID = 'planted-client-id-0123456789';
const ACCESS_CODE = 'planted-access-code-abcdef';
const COMPANY = 'ludy-0123456789abcdef0123456789abcdef';
const ORG = '11111111-1111-4111-8111-111111111111';
const CONNECTION = '22222222-2222-4222-8222-222222222222';
const CHANNEL = '33333333-3333-4333-8333-333333333333';
const ENTITY = '44444444-4444-4444-8444-444444444444';
const ENTRY1 = '0194a1c2-8f3e-7b10-9d4a-1e2f3a4b5c6d';
const PLANTED_NAME = 'TEN-DOI-TUONG-RIENG-CUA-AMIS';
const PLANTED_ADDRESS = 'DIA-CHI-RIENG-CUA-AMIS';

const ok = (data: unknown): AmisResponse => ({ status: 200, body: JSON.stringify({ Success: true, ErrorMessage: '', Data: data }) });
const fail = (code: string): AmisResponse => ({ status: 200, body: JSON.stringify({ Success: false, ErrorCode: code, ErrorMessage: `planted AMIS text ${ACCESS_CODE}` }) });

// A catalogue of 3 parties and 2 items, served page by page as get_dictionary does (skip and take), with names and addresses that must never be recorded.
const PARTIES = [
  { account_object_id: ENTRY1, account_object_code: 'NCC_ABC', account_object_name: PLANTED_NAME, address: PLANTED_ADDRESS, company_tax_code: '0101234564', inactive: false },
  { account_object_code: 'KH_DUP1', account_object_name: PLANTED_NAME, company_tax_code: '0312345678' },
  { account_object_code: 'KH_DUP2', account_object_name: PLANTED_NAME, company_tax_code: '0312345678' },
];
const ITEMS = [{ inventory_item_id: ENTRY1, inventory_item_code: 'DV_CHUNG', inventory_item_name: PLANTED_NAME }, { inventory_item_code: 'HH_CU', inactive: true }];

function fakeAmis(options: { parties?: unknown[]; items?: unknown[]; prefix?: string; behave?: (path: string, body: Record<string, unknown>) => AmisResponse | undefined } = {}) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const prefix = options.prefix ?? '/amiskt/v1';
  const parties = options.parties ?? PARTIES;
  const items = options.items ?? ITEMS;
  const transport: AmisTransport = async (request: AmisRequest) => {
    const path = new URL(request.url).pathname.replace(/^\/apis/, '');
    const body = JSON.parse(request.body) as Record<string, unknown>;
    calls.push({ path, body });
    const forced = options.behave?.(path, body);
    if (forced) return forced;
    if (request.headers.ClientID !== CLIENT_ID) return fail('InvalidAPPID');
    if (path === `${prefix}/token`) return body.access_code === ACCESS_CODE ? ok({ access_token: 'token-1', expired_time: '2027-01-19T20:00:00' }) : fail('InvalidAccessToken');
    if (request.headers['X-MISA-AccessToken'] !== 'token-1') return fail('InvalidToken');
    if (path === `${prefix}/get_dictionary`) {
      const rows = body.data_type === 1 ? parties : body.data_type === 2 ? items : [];
      return ok(rows.slice(Number(body.skip), Number(body.skip) + Number(body.take)));
    }
    return fail('InvalidParam');
  };
  return { transport, calls };
}

const purchase = (taxCode: string | null) => ({
  sourceId: '55555555-5555-4555-8555-555555555555',
  entryId: '66666666-6666-4666-8666-666666666666',
  entryDate: '2026-10-05',
  description: 'Mua dịch vụ',
  invoice: { series: 'C26TAA', number: '123', date: '2026-10-05' },
  vendor: { name: 'Nhà cung cấp', taxCode, address: null },
  vatAmount: '100000',
  lines: [{ lineNo: 1, description: 'Phí', unit: null, quantity: null, unitPrice: null, amount: '1000000', vatRate: '10%', debitAccount: '6422' }],
});

const REQUESTED = '2026-10-31T09:00:00.000Z';
const ASK = { kind: 'purchase_services', from: '2026-10-01', to: '2026-10-31', legalEntityId: ENTITY, serviceItemCode: 'DV_CHUNG' };

interface Harness {
  runtime: Runtime;
  broker: CredentialBroker;
  queries: Array<{ name: string; input: unknown }>;
  executed: Array<{ name: string; input: unknown }>;
  opened: unknown[];
}
function harness(options: { target?: unknown; vouchers?: unknown[]; credential?: () => unknown; product?: 'amis' | 'asp' } = {}): Harness {
  const queries: Harness['queries'] = [];
  const executed: Harness['executed'] = [];
  const opened: unknown[] = [];
  const target = options.target ?? { action: 'check', id: CONNECTION, product: options.product ?? 'amis', channelConnectionId: CHANNEL, orgCompanyCode: COMPANY, legalEntityId: ENTITY, ask: ASK, requestedAt: REQUESTED };
  const runtime = {
    query: async (name: string, input: unknown) => {
      queries.push({ name, input });
      if (name === 'finance.misa_amis_match.check_target') return target;
      if (name === 'kernel.channel.credential') return options.credential ? options.credential() : { provider: options.product === 'asp' ? 'accounting_misa_asp' : 'accounting_misa_amis', externalAccountId: 'entity', keyId: 'k1', envelope: Buffer.from('sealed').toString('base64') };
      if (name === 'finance.vouchers.purchases') return options.vouchers ?? [purchase('0101234564'), purchase('0312345678'), purchase('0999999999')];
      throw new Error(`unexpected query ${name}`);
    },
    execute: async (name: string, input: unknown) => {
      executed.push({ name, input });
      return {};
    },
  } as unknown as Runtime;
  const broker = {
    open: (sealed: unknown, binding: unknown) => {
      opened.push({ sealed, binding });
      return ACCESS_CODE;
    },
  } as unknown as CredentialBroker;
  return { runtime, broker, queries, executed, opened };
}

const recorded = (h: Harness) => h.executed.filter((e) => e.name === 'finance.misa_amis_match.record_check').map((e) => e.input);
const run = (h: Harness, amis: ReturnType<typeof fakeAmis>) => runMisaAmisMatch({ runtime: h.runtime, broker: h.broker, client: createAmisClient({ clientId: CLIENT_ID, transport: amis.transport }) }, { orgId: ORG, connectionId: CONNECTION });

afterEach(() => vi.restoreAllMocks());

describe('the MISA AMIS match check job', () => {
  it('leaves a connection alone that is gone, no longer active or has no check waiting: nothing is asked, nothing is recorded', async () => {
    for (const reason of ['not_found', 'not_active', 'not_requested']) {
      const h = harness({ target: { action: 'none', reason } });
      const amis = fakeAmis();
      expect(await run(h, amis)).toEqual({ state: 'skipped', reason });
      expect(amis.calls).toEqual([]);
      expect(h.executed).toEqual([]);
      expect(h.opened).toEqual([]);
    }
  });

  it('reads the parties and items the batch needs, matches them in memory and records only codes and ids', async () => {
    const h = harness();
    const amis = fakeAmis();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await run(h, amis)).toEqual({ state: 'done', results: 4 });
    // One token, one page of parties, one page of items; the access code and the connection's own company code go out.
    expect(amis.calls.map((c) => c.path)).toEqual(['/amiskt/v1/token', '/amiskt/v1/get_dictionary', '/amiskt/v1/get_dictionary']);
    expect(amis.calls[0]?.body).toEqual({ access_code: ACCESS_CODE, org_company_code: COMPANY });
    expect(amis.calls[1]?.body).toMatchObject({ data_type: 1, skip: 0, take: 1000 });
    expect(amis.calls[2]?.body).toMatchObject({ data_type: 2, skip: 0, take: 1000 });
    expect(h.opened).toEqual([{ sealed: { keyId: 'k1', envelope: Buffer.from('sealed') }, binding: { orgId: ORG, provider: 'accounting_misa_amis', externalAccountId: 'entity' } }]);
    expect(recorded(h)).toEqual([
      {
        connectionId: CONNECTION,
        requestedAt: REQUESTED,
        state: 'done',
        failure: null,
        results: [
          { kind: 'party', ref: '0101234564', state: 'matched', code: 'NCC_ABC', entryId: ENTRY1 },
          { kind: 'party', ref: '0312345678', state: 'ambiguous', code: null, entryId: null },
          { kind: 'party', ref: '0999999999', state: 'unknown', code: null, entryId: null },
          { kind: 'item', ref: 'DV_CHUNG', state: 'matched', code: 'DV_CHUNG', entryId: ENTRY1 },
        ],
      },
    ]);
    // The batch was found by the vouchers' own query, as the preview and the push find it.
    expect(h.queries.find((q) => q.name === 'finance.vouchers.purchases')?.input).toMatchObject({ from: '2026-10-01', to: '2026-10-31', legalEntityId: ENTITY });
    // Nothing of the catalogue's names or addresses reaches a record or a log line.
    const everything = JSON.stringify([h.executed, log.mock.calls]);
    expect(everything).not.toContain(PLANTED_NAME);
    expect(everything).not.toContain(PLANTED_ADDRESS);
    expect(everything).not.toContain(ACCESS_CODE);
    expect(everything).not.toContain(CLIENT_ID);
  });

  it('asks only for the catalogue a batch needs: no tax code and no item code, no call at all', async () => {
    const h = harness({ vouchers: [purchase(null)], target: { action: 'check', id: CONNECTION, product: 'amis', channelConnectionId: CHANNEL, orgCompanyCode: COMPANY, legalEntityId: ENTITY, ask: { ...ASK, serviceItemCode: undefined }, requestedAt: REQUESTED } });
    const amis = fakeAmis();
    expect(await run(h, amis)).toEqual({ state: 'done', results: 0 });
    expect(amis.calls).toEqual([]);
    expect(recorded(h)).toEqual([{ connectionId: CONNECTION, requestedAt: REQUESTED, state: 'done', failure: null, results: [] }]);
    // Only items: a batch with no party tax code reads the item catalogue and not the parties.
    const items = harness({ vouchers: [purchase(null)] });
    const itemsAmis = fakeAmis();
    expect(await run(items, itemsAmis)).toEqual({ state: 'done', results: 1 });
    expect(itemsAmis.calls.filter((c) => c.path === '/amiskt/v1/get_dictionary').map((c) => c.body.data_type)).toEqual([2]);
  });

  it('reads a catalogue of more than a page page by page, and finds an entry on a later page', async () => {
    const many = Array.from({ length: 2500 }, (_, i) => ({ account_object_code: `KH${i}`, company_tax_code: `09${String(i).padStart(8, '0')}` }));
    many[2300] = { account_object_code: 'NCC_ABC', company_tax_code: '0101234564' };
    const h = harness({ vouchers: [purchase('0101234564')], target: { action: 'check', id: CONNECTION, product: 'amis', channelConnectionId: CHANNEL, orgCompanyCode: COMPANY, legalEntityId: ENTITY, ask: { ...ASK, serviceItemCode: undefined }, requestedAt: REQUESTED } });
    const amis = fakeAmis({ parties: many });
    expect(await run(h, amis)).toEqual({ state: 'done', results: 1 });
    expect(amis.calls.filter((c) => c.path === '/amiskt/v1/get_dictionary').map((c) => c.body.skip)).toEqual([0, 1000, 2000]);
    expect(recorded(h)[0]).toMatchObject({ results: [{ ref: '0101234564', state: 'matched', code: 'NCC_ABC' }] });
  });

  it('fails as catalogue_too_large, recording nothing found, when the catalogue is longer than 20 pages: a party past the cut must not read as unknown', async () => {
    const endless = Array.from({ length: 20_000 }, (_, i) => ({ account_object_code: `KH${i}`, company_tax_code: `09${String(i).padStart(8, '0')}` }));
    const h = harness({ vouchers: [purchase('0999999999')], target: { action: 'check', id: CONNECTION, product: 'amis', channelConnectionId: CHANNEL, orgCompanyCode: COMPANY, legalEntityId: ENTITY, ask: { ...ASK, serviceItemCode: undefined }, requestedAt: REQUESTED } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const amis = fakeAmis({ parties: endless });
    expect(await run(h, amis)).toEqual({ state: 'failed', failure: 'catalogue_too_large' });
    expect(recorded(h)).toEqual([{ connectionId: CONNECTION, requestedAt: REQUESTED, state: 'failed', failure: 'catalogue_too_large', results: [] }]);
    expect(amis.calls.filter((c) => c.path === '/amiskt/v1/get_dictionary')).toHaveLength(20);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('KH1');
  });

  it('records why a check could not be made, as a fixed reason: a refused code, an AMIS that does not answer or answers in no known shape, the deployment\'s own unknown ClientID', async () => {
    const cases: Array<[string, (path: string) => AmisResponse | undefined, string]> = [
      ['a refused access code', (path) => (path.endsWith('/token') ? fail('InvalidAccessToken') : undefined), 'credentials'],
      ['no accounting data connected', (path) => (path.endsWith('/token') ? fail('DBAmisNotConnectDBAC') : undefined), 'credentials'],
      ['the deployment\'s own ClientID unknown to MISA', (path) => (path.endsWith('/token') ? fail('InvalidAPPID') : undefined), 'unreachable'],
      ['a 503', () => ({ status: 503, body: 'planted gateway text' }), 'unreachable'],
      ['an answer in no known shape', (path) => (path.endsWith('/get_dictionary') ? { status: 200, body: 'not json' } : undefined), 'invalid_response'],
    ];
    for (const [label, behave, failure] of cases) {
      const h = harness();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const amis = fakeAmis({ behave: (path) => behave(path) });
      expect(await run(h, amis), label).toEqual({ state: 'failed', failure });
      expect(recorded(h), label).toEqual([{ connectionId: CONNECTION, requestedAt: REQUESTED, state: 'failed', failure, results: [] }]);
      const logged = JSON.stringify(warn.mock.calls);
      for (const secret of [ACCESS_CODE, CLIENT_ID, 'planted']) expect(logged, label).not.toContain(secret);
      warn.mockRestore();
    }
  });

  it('never opens a credential sealed for another provider, and records the check as refused credentials', async () => {
    const h = harness({ credential: () => ({ provider: 'einvoice_other', externalAccountId: 'x', keyId: 'k1', envelope: Buffer.from('sealed').toString('base64') }) });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const amis = fakeAmis();
    expect(await run(h, amis)).toEqual({ state: 'failed', failure: 'credentials' });
    expect(h.opened).toEqual([]);
    expect(amis.calls).toEqual([]);
  });

  it('records refused credentials, and marks the channel expired, when the member who connected it has left', async () => {
    const h = harness({
      credential: () => {
        throw new DomainError('CHANNEL_OWNER_LEFT', 409, 'x');
      },
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await run(h, fakeAmis())).toEqual({ state: 'failed', failure: 'credentials' });
    expect(h.executed.map((e) => e.name)).toEqual(['kernel.channel.mark_expired', 'finance.misa_amis_match.record_check']);
  });

  it('accepts a SQL Server style GUID (not an RFC UUID) as an entry id and refuses a record without the request time', () => {
    const base = { connectionId: CONNECTION, state: 'done', failure: null, results: [{ kind: 'party', ref: '0101234564', state: 'matched', code: 'NCC_A', entryId: '6F9619FF-8B86-D011-B42D-00C04FC964FF' }] };
    expect(zMisaAmisMatchRecordCheck.safeParse({ ...base, requestedAt: REQUESTED }).success).toBe(true);
    expect(zMisaAmisMatchRecordCheck.safeParse(base).success).toBe(false);
  });
});

describe('the MISA ASP match check (#4152)', () => {
  const asp = (amis: ReturnType<typeof fakeAmis>) => createAmisClient({ clientId: CLIENT_ID, product: 'asp', transport: amis.transport });
  const runAsp = (h: Harness, amis: ReturnType<typeof fakeAmis>, extra: { client?: ReturnType<typeof createAmisClient> | null; aspClient?: ReturnType<typeof createAmisClient> | null } = {}) =>
    runMisaAmisMatch({ runtime: h.runtime, broker: h.broker, client: extra.client === undefined ? null : extra.client, aspClient: extra.aspClient === undefined ? asp(amis) : extra.aspClient }, { orgId: ORG, connectionId: CONNECTION });

  it('reads ASP\'s own catalogue paths with the ASP client, opens a code sealed for ASP, and records the same results as for AMIS', async () => {
    const h = harness({ product: 'asp' });
    const aspMisa = fakeAmis({ prefix: '/asp/v1' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await runAsp(h, aspMisa)).toEqual({ state: 'done', results: 4 });
    expect(aspMisa.calls.map((c) => c.path)).toEqual(['/asp/v1/token', '/asp/v1/get_dictionary', '/asp/v1/get_dictionary']);
    expect(aspMisa.calls[1]?.body).toMatchObject({ data_type: 1, skip: 0, take: 1000 });
    expect(aspMisa.calls[2]?.body).toMatchObject({ data_type: 2, skip: 0, take: 1000 });
    expect(h.opened).toEqual([{ sealed: { keyId: 'k1', envelope: Buffer.from('sealed') }, binding: { orgId: ORG, provider: 'accounting_misa_asp', externalAccountId: 'entity' } }]);
    expect(recorded(h)).toEqual([
      {
        connectionId: CONNECTION,
        requestedAt: REQUESTED,
        state: 'done',
        failure: null,
        results: [
          { kind: 'party', ref: '0101234564', state: 'matched', code: 'NCC_ABC', entryId: ENTRY1 },
          { kind: 'party', ref: '0312345678', state: 'ambiguous', code: null, entryId: null },
          { kind: 'party', ref: '0999999999', state: 'unknown', code: null, entryId: null },
          { kind: 'item', ref: 'DV_CHUNG', state: 'matched', code: 'DV_CHUNG', entryId: ENTRY1 },
        ],
      },
    ]);
    const everything = JSON.stringify([h.executed, log.mock.calls]);
    for (const secret of [PLANTED_NAME, PLANTED_ADDRESS, ACCESS_CODE, CLIENT_ID]) expect(everything).not.toContain(secret);
  });

  it('does not touch the AMIS client for an ASP connection, and the other way round', async () => {
    const amisFake = fakeAmis();
    const aspFake = fakeAmis({ prefix: '/asp/v1' });
    const bothClients = { client: createAmisClient({ clientId: CLIENT_ID, transport: amisFake.transport }), aspClient: asp(aspFake) };
    expect(await runAsp(harness({ product: 'asp' }), aspFake, bothClients)).toMatchObject({ state: 'done' });
    expect(amisFake.calls).toEqual([]);
    const aspFake2 = fakeAmis({ prefix: '/asp/v1' });
    const amisFake2 = fakeAmis();
    expect(await runAsp(harness({ product: 'amis' }), amisFake2, { client: createAmisClient({ clientId: CLIENT_ID, transport: amisFake2.transport }), aspClient: asp(aspFake2) })).toMatchObject({ state: 'done' });
    expect(aspFake2.calls).toEqual([]);
  });

  it('leaves a connection alone whose product the deployment holds no client for: nothing is opened or asked, nothing is recorded (the check stays requested)', async () => {
    for (const product of ['asp', 'amis'] as const) {
      const h = harness({ product });
      const amis = fakeAmis({ prefix: product === 'asp' ? '/asp/v1' : '/amiskt/v1' });
      const clients = product === 'asp' ? { client: createAmisClient({ clientId: CLIENT_ID, transport: amis.transport }), aspClient: null } : { client: null, aspClient: asp(amis) };
      expect(await runAsp(h, amis, clients), product).toEqual({ state: 'skipped', reason: 'product_off' });
      expect(amis.calls, product).toEqual([]);
      expect(h.opened, product).toEqual([]);
      expect(h.executed, product).toEqual([]);
    }
  });

  it('never opens a code sealed for the other MISA product: an ASP connection with an AMIS-sealed code, and an AMIS connection with an ASP-sealed one, record refused credentials', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const aspH = harness({ product: 'asp', credential: () => ({ provider: 'accounting_misa_amis', externalAccountId: 'x', keyId: 'k1', envelope: Buffer.from('sealed').toString('base64') }) });
    const aspMisa = fakeAmis({ prefix: '/asp/v1' });
    expect(await runAsp(aspH, aspMisa)).toEqual({ state: 'failed', failure: 'credentials' });
    expect(aspH.opened).toEqual([]);
    expect(aspMisa.calls).toEqual([]);
    const amisH = harness({ product: 'amis', credential: () => ({ provider: 'accounting_misa_asp', externalAccountId: 'x', keyId: 'k1', envelope: Buffer.from('sealed').toString('base64') }) });
    const amisMisa = fakeAmis();
    expect(await runAsp(amisH, amisMisa, { client: createAmisClient({ clientId: CLIENT_ID, transport: amisMisa.transport }), aspClient: null })).toEqual({ state: 'failed', failure: 'credentials' });
    expect(amisH.opened).toEqual([]);
    expect(amisMisa.calls).toEqual([]);
  });

  it('records why an ASP check could not be made as a fixed reason, with no text of ASP\'s in a record or a log line', async () => {
    const cases: Array<[string, (path: string) => AmisResponse | undefined, string]> = [
      ['a refused access code', (path) => (path.endsWith('/token') ? fail('InvalidAccessToken') : undefined), 'credentials'],
      ['a 503', () => ({ status: 503, body: 'planted gateway text' }), 'unreachable'],
      ['an answer in no known shape', (path) => (path.endsWith('/get_dictionary') ? { status: 200, body: 'not json' } : undefined), 'invalid_response'],
    ];
    for (const [label, behave, failure] of cases) {
      const h = harness({ product: 'asp' });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const aspMisa = fakeAmis({ prefix: '/asp/v1', behave: (path) => behave(path) });
      expect(await runAsp(h, aspMisa), label).toEqual({ state: 'failed', failure });
      expect(recorded(h), label).toEqual([{ connectionId: CONNECTION, requestedAt: REQUESTED, state: 'failed', failure, results: [] }]);
      for (const secret of [ACCESS_CODE, CLIENT_ID, 'planted']) expect(JSON.stringify(warn.mock.calls), label).not.toContain(secret);
      warn.mockRestore();
    }
  });
});
