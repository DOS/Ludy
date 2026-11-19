// SPDX-License-Identifier: AGPL-3.0-only
// The adapter for MISA ASP (#4103, S1): the same client with `product: 'asp'` goes to `/asp/v1` for the four calls ASP's document has (token, get_dictionary, save, delete), refuses the three it does not have
// (company information, catalogue writes, polling of results) and the three catalogues it does not list, before it asks for a token or sends anything, and keeps every rule of the AMIS client (one renewal of
// an expired token, 500 lines, one kind per save, no secret in an error). The server is a fake that serves only what ASP's document lists.
import { describe, expect, it } from 'vitest';
import { AMIS_DICTIONARIES, AMIS_MAX_VOUCHER_LINES, AMIS_VOUCHER_TYPES, AmisError, amisNumber, createAmisClient, type AmisConnection, type AmisVoucher } from '../src/index.ts';
import { createFakeMisa } from './fake-misa.ts';

const CLIENT = 'CLIENT-ID-SENTINEL-4f6a';
const CODE = 'ACCESS-CODE-SENTINEL-77c1';
const ORG = 'ludy-asp-test';
const conn: AmisConnection = { accessCode: CODE, orgCompanyCode: ORG };
const REF1 = '0194a1c2-8f3e-7b10-9d4a-1e2f3a4b5c6d';
const REF2 = '0194a1c2-8f3e-7b10-9d4a-1e2f3a4b5c6e';

const voucher = (orgRefId: string, lines = 1, type: number = AMIS_VOUCHER_TYPES.purchaseServices): AmisVoucher => ({
  voucher_type: type,
  org_refid: orgRefId,
  org_refno: 'CK00017',
  detail: Array.from({ length: lines }, (_, i) => ({ sort_order: i + 1, description: `Dòng ${i + 1}`, amount: amisNumber('1000.5'), quantity: amisNumber('1') })),
  total_amount: amisNumber('1000.5'),
});

function setup(product: 'amis' | 'asp' = 'asp', dictionary?: Record<number, Record<string, unknown>[]>) {
  const fake = createFakeMisa({ clientId: CLIENT, accessCodes: { [CODE]: ORG }, product, ...(dictionary ? { dictionary } : {}) });
  let clock = 1_000_000;
  const client = createAmisClient({ clientId: CLIENT, transport: fake.transport, product, now: () => clock });
  return { fake, client, advance: (ms: number) => void (clock += ms) };
}
const kindOf = async (promise: Promise<unknown>): Promise<AmisError> => {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(AmisError);
  const dump = `${String(error)} ${(error as Error).stack ?? ''} ${JSON.stringify(error)}`;
  for (const secret of [CLIENT, CODE, 'token-']) expect(dump).not.toContain(secret);
  return error as AmisError;
};

describe('an ASP client', () => {
  it('goes to /asp/v1 for the token, a catalogue page, a save and a delete, with the ClientID and token headers of the AMIS client and nothing under /amiskt', async () => {
    const { fake, client } = setup('asp', { 1: [{ account_object_code: 'KH001', account_object_name: 'Công ty ABC', company_tax_code: '0101234564', inactive: false }] });
    const rows = await client.dictionary(conn, { dataType: AMIS_DICTIONARIES.accountObject, skip: 0, take: 100 });
    expect(rows).toHaveLength(1);
    await client.save(conn, [voucher(REF1)]);
    await client.remove(conn, [{ voucher_type: AMIS_VOUCHER_TYPES.purchaseServices, org_refid: REF1 }]);
    expect(fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /asp/v1/token', 'POST /asp/v1/get_dictionary', 'POST /asp/v1/save', 'DELETE /asp/v1/delete']);
    const [token, dictionary, save] = fake.calls;
    expect(JSON.parse(token?.body ?? '')).toEqual({ access_code: CODE, org_company_code: ORG });
    expect(token?.headers.ClientID).toBe(CLIENT);
    expect(dictionary?.headers['X-MISA-AccessToken']).toMatch(/^token-/);
    expect(JSON.parse(dictionary?.body ?? '')).toMatchObject({ data_type: 1, skip: 0, take: 100 });
    expect(Object.keys(JSON.parse(save?.body ?? '')).sort()).toEqual(['org_company_code', 'voucher']);
    expect(fake.requests.has(REF1)).toBe(false);
  });

  it('reads all six catalogues ASP lists', async () => {
    const { fake, client } = setup('asp');
    for (const type of [AMIS_DICTIONARIES.accountObject, AMIS_DICTIONARIES.inventoryItem, AMIS_DICTIONARIES.stock, AMIS_DICTIONARIES.unit, AMIS_DICTIONARIES.account, AMIS_DICTIONARIES.organizationUnit]) {
      expect(await client.dictionary(conn, { dataType: type, skip: 0, take: 10 })).toEqual([]);
    }
    expect(fake.calls.filter((c) => c.path === '/asp/v1/get_dictionary')).toHaveLength(6);
  });

  it('refuses the company information, the catalogue writes, the polling and the three AMIS-only catalogues as `unsupported`, before a token is asked for or anything is sent', async () => {
    const { fake, client } = setup('asp');
    expect((await kindOf(client.companyInfo(conn))).kind).toBe('unsupported');
    expect((await kindOf(client.saveDictionary(conn, AMIS_DICTIONARIES.accountObject, [{ account_object_code: 'KH001' }]))).kind).toBe('unsupported');
    expect((await kindOf(client.callbackResults(conn, { from: '2026-11-01', to: '2026-11-02', skip: 0, take: 10 }))).kind).toBe('unsupported');
    for (const type of [AMIS_DICTIONARIES.bank, AMIS_DICTIONARIES.expenseItem, AMIS_DICTIONARIES.inventoryCategory]) {
      expect((await kindOf(client.dictionary(conn, { dataType: type, skip: 0, take: 10 }))).kind).toBe('unsupported');
    }
    expect(fake.calls).toEqual([]);
  });

  it('renews an expired token once, as the AMIS client does, and gives up as `credentials` when the renewed token is refused too', async () => {
    const { fake, client } = setup('asp');
    await client.save(conn, [voucher(REF1)]);
    fake.expireTokens();
    await client.save(conn, [voucher(REF1)]);
    expect(fake.calls.filter((c) => c.path === '/asp/v1/token')).toHaveLength(2);
    const other = setup('asp');
    other.fake.failNext('InvalidAccessToken');
    expect((await kindOf(other.client.save(conn, [voucher(REF1)]))).kind).toBe('credentials');
  });

  it('keeps the rules of the AMIS client: 500 lines and no more, one kind per save, an id that is a UUID', async () => {
    const { fake, client } = setup('asp');
    await client.save(conn, [voucher(REF1, AMIS_MAX_VOUCHER_LINES)]);
    expect((await kindOf(client.save(conn, [voucher(REF1, AMIS_MAX_VOUCHER_LINES + 1)]))).reason).toBe('too_many_lines');
    expect((await kindOf(client.save(conn, [voucher(REF1), voucher(REF2, 1, AMIS_VOUCHER_TYPES.sales)]))).reason).toBe('mixed_voucher_types');
    expect((await kindOf(client.save(conn, [voucher('not-a-uuid')]))).reason).toBe('bad_org_refid');
    expect(fake.calls.filter((c) => c.path === '/asp/v1/save')).toHaveLength(1);
  });

  it('takes a path that is not found for what it is: an ASP client against an AMIS server (and the other way) gets `invalid_response`, not a success', async () => {
    const fake = createFakeMisa({ clientId: CLIENT, accessCodes: { [CODE]: ORG }, product: 'amis' });
    const client = createAmisClient({ clientId: CLIENT, transport: fake.transport, product: 'asp' });
    expect((await kindOf(client.save(conn, [voucher(REF1)]))).kind).toBe('invalid_response');
    const aspFake = createFakeMisa({ clientId: CLIENT, accessCodes: { [CODE]: ORG }, product: 'asp' });
    const amisClient = createAmisClient({ clientId: CLIENT, transport: aspFake.transport });
    expect((await kindOf(amisClient.save(conn, [voucher(REF1)]))).kind).toBe('invalid_response');
  });
});

describe('an AMIS client', () => {
  it('is the same with and without `product: "amis"`: /amiskt/v1 for every call, company information and the polling included', async () => {
    for (const given of [undefined, 'amis' as const]) {
      const fake = createFakeMisa({ clientId: CLIENT, accessCodes: { [CODE]: ORG } });
      const client = createAmisClient({ clientId: CLIENT, transport: fake.transport, ...(given ? { product: given } : {}) });
      await client.companyInfo(conn);
      await client.dictionary(conn, { dataType: AMIS_DICTIONARIES.bank, skip: 0, take: 10 });
      await client.callbackResults(conn, { from: '2026-11-01', to: '2026-11-02', skip: 0, take: 10 });
      expect(fake.calls.map((c) => c.path)).toEqual(['/amiskt/v1/token', '/amiskt/v1/get_company_info', '/amiskt/v1/get_dictionary', '/amiskt/v1/get_call_back_detail_error']);
    }
  });
});
