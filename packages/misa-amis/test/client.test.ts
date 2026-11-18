// SPDX-License-Identifier: AGPL-3.0-only
// The MISA AMIS client against the fake server (#3854): the token is asked for once and renewed once, the request bodies carry exact numbers, a voucher MISA would refuse is refused before it is sent, the
// result of a save reaches the caller by callback and by polling, and no secret (the ClientID, an access code, a token) is in any error.
import { describe, expect, it } from 'vitest';
import { AMIS_DICTIONARIES, AMIS_MAX_VOUCHER_LINES, AMIS_VOUCHER_TYPES, AmisError, amisNumber, createAmisClient, readCallback, type AmisConnection, type AmisVoucher } from '../src/index.ts';
import { createFakeMisa } from './fake-misa.ts';

const CLIENT = 'CLIENT-ID-SENTINEL-4f6a';
const CODE = 'ACCESS-CODE-SENTINEL-77c1';
const ORG = 'ludy-test';
const conn: AmisConnection = { accessCode: CODE, orgCompanyCode: ORG };
const REF1 = '0194a1c2-8f3e-7b10-9d4a-1e2f3a4b5c6d';
const REF2 = '0194a1c2-8f3e-7b10-9d4a-1e2f3a4b5c6e';

const line = (n: number) => ({ sort_order: n, description: `Dòng ${n}`, amount: amisNumber('9007199254740993'), unit_price: amisNumber('12.3456'), quantity: amisNumber('1'), vat_rate: 8 });
const voucher = (orgRefId: string, lines = 1, type: number = AMIS_VOUCHER_TYPES.purchaseServices): AmisVoucher => ({ voucher_type: type, org_refid: orgRefId, org_refno: 'CK00017', detail: Array.from({ length: lines }, (_, i) => line(i + 1)), total_amount: amisNumber('9007199254740993') });

function setup(over: { dictionary?: Record<number, Record<string, unknown>[]> } = {}) {
  const fake = createFakeMisa({ clientId: CLIENT, accessCodes: { [CODE]: ORG }, ...over });
  let clock = 1_000_000;
  const client = createAmisClient({ clientId: CLIENT, transport: fake.transport, now: () => clock });
  return { fake, client, advance: (ms: number) => void (clock += ms) };
}
const tokenCalls = (fake: ReturnType<typeof setup>['fake']) => fake.calls.filter((c) => c.path === '/amiskt/v1/token').length;
const secretFree = (error: unknown) => {
  const dump = `${String(error)} ${(error as Error).stack ?? ''} ${JSON.stringify(error)} ${Object.values(error as object).join(' ')}`;
  for (const secret of [CLIENT, CODE, 'token-']) expect(dump).not.toContain(secret);
};
const fails = async (promise: Promise<unknown>): Promise<AmisError> => {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(AmisError);
  secretFree(error);
  return error as AmisError;
};

describe('the token', () => {
  it('is asked for once and kept for later calls, with the ClientID and the token in the headers and nothing else of ours', async () => {
    const { fake, client } = setup();
    await client.companyInfo(conn);
    await client.dictionary(conn, { dataType: AMIS_DICTIONARIES.account, skip: 0, take: 10 });
    await client.companyInfo(conn);
    expect(tokenCalls(fake)).toBe(1);
    const [first, second] = fake.calls;
    expect(first?.headers).toMatchObject({ ClientID: CLIENT });
    expect(first?.headers['X-MISA-AccessToken']).toBeUndefined();
    expect(JSON.parse(first?.body ?? '{}')).toEqual({ access_code: CODE, org_company_code: ORG });
    expect(second?.headers).toMatchObject({ ClientID: CLIENT, 'X-MISA-AccessToken': 'token-1' });
    expect(fake.calls.every((c) => c.method === 'POST')).toBe(true);
  });

  it('is asked for once when calls overlap, and again after its time', async () => {
    const { fake, client, advance } = setup();
    await Promise.all([client.companyInfo(conn), client.companyInfo(conn), client.companyInfo(conn)]);
    expect(tokenCalls(fake)).toBe(1);
    advance(31 * 60 * 1000);
    await client.companyInfo(conn);
    expect(tokenCalls(fake)).toBe(2);
  });

  it('is renewed once when MISA says it expired, and the call goes through', async () => {
    const { fake, client } = setup();
    await client.companyInfo(conn);
    fake.expireTokens();
    await expect(client.companyInfo(conn)).resolves.toMatchObject({ company_name: 'Công ty thử' });
    expect(tokenCalls(fake)).toBe(2);
  });

  it('gives up as `credentials` when the renewed token is refused too, and when the access code itself is refused', async () => {
    const { fake } = setup();
    // The access code itself is refused on the token call: nothing to renew or try again.
    const bad = createAmisClient({ clientId: CLIENT, transport: fake.transport });
    const wrong = await fails(bad.companyInfo({ accessCode: 'not-the-code', orgCompanyCode: ORG }));
    expect(wrong).toMatchObject({ kind: 'credentials', code: 'InvalidAccessToken' });
    expect(fake.calls).toHaveLength(1);
    // A token that stays refused after one renewal.
    const stubborn = setup();
    await stubborn.client.companyInfo(conn);
    const original = stubborn.fake.transport;
    let tokens = 0;
    const flaky = createAmisClient({
      clientId: CLIENT,
      transport: async (request) => {
        const response = await original(request);
        if (!request.url.endsWith('/token') && JSON.parse(response.body).Success) return { status: 200, body: JSON.stringify({ Success: false, ErrorCode: 'InvalidToken' }) };
        if (request.url.endsWith('/token')) tokens++;
        return response;
      },
    });
    expect(await fails(flaky.companyInfo(conn))).toMatchObject({ kind: 'credentials', code: 'InvalidToken' });
    expect(tokens).toBe(2);
  });

  it('is refused as `credentials` when the integrator\'s ClientID is not the one MISA issued', async () => {
    const { fake } = setup();
    const client = createAmisClient({ clientId: 'not-our-client', transport: fake.transport });
    expect(await fails(client.companyInfo(conn))).toMatchObject({ kind: 'credentials', code: 'InvalidAPPID' });
  });
});

describe('save', () => {
  it('writes amounts above 2^53 and with four decimals into the body exactly, as numbers, with only org_company_code and voucher', async () => {
    const { fake, client } = setup();
    await client.save(conn, [voucher(REF1)]);
    const call = fake.calls.find((c) => c.path === '/amiskt/v1/save');
    expect(call?.body).toContain('"amount":9007199254740993');
    expect(call?.body).toContain('"unit_price":12.3456');
    expect(call?.body).toContain('"total_amount":9007199254740993');
    expect(call?.body).toContain('"vat_rate":8');
    expect(call?.body).not.toContain('"9007199254740993"');
    expect(Object.keys(JSON.parse(call?.body ?? '{}'))).toEqual(['org_company_code', 'voucher']);
    expect(fake.requests.get(REF1)).toMatchObject({ voucherType: 17, orgCompanyCode: ORG });
  });

  it('takes 500 lines and refuses 501 before anything is sent, never cutting the voucher', async () => {
    const { fake, client } = setup();
    await client.save(conn, [voucher(REF1, AMIS_MAX_VOUCHER_LINES)]);
    const before = fake.calls.length;
    expect(await fails(client.save(conn, [voucher(REF2, AMIS_MAX_VOUCHER_LINES + 1)]))).toMatchObject({ kind: 'invalid_request', reason: 'too_many_lines' });
    expect(fake.calls).toHaveLength(before);
  });

  it('refuses, before anything is sent, an empty voucher, an unknown type, an id that is not a UUID, a mixed list and a batch that is too long', async () => {
    const { fake, client } = setup();
    const cases: Array<[AmisVoucher[], string]> = [
      [[voucher(REF1, 0)], 'no_lines'],
      [[voucher(REF1, 1, 2)], 'bad_voucher_type'],
      [[voucher('AB80B9D2')], 'bad_org_refid'],
      [[voucher(REF1, 1, 17), voucher(REF2, 1, 13)], 'mixed_voucher_types'],
      [Array.from({ length: 51 }, () => voucher(REF1)), 'too_many_vouchers'],
      [[], 'too_many_vouchers'],
    ];
    for (const [vouchers, reason] of cases) expect(await fails(client.save(conn, vouchers)), reason).toMatchObject({ kind: 'invalid_request', reason });
    // A JS number where an amount should be an exact decimal: refused.
    expect(await fails(client.save(conn, [{ ...voucher(REF1), total_amount: 12.5 }]))).toMatchObject({ kind: 'invalid_request', reason: 'bad_amount' });
    expect(fake.calls).toHaveLength(0);
  });

  it('answers IsCreatedVoucher through the results when a person already turned the request into a voucher', async () => {
    const { fake, client } = setup();
    await client.save(conn, [voucher(REF1)]);
    fake.createVoucher(REF1);
    await client.save(conn, [voucher(REF1)]);
    expect(fake.results.map((r) => [r.success, r.error_code])).toEqual([[true, null], [false, 'IsCreatedVoucher']]);
  });

  it('pushing the same org_refid again updates the same request (idempotent)', async () => {
    const { fake, client } = setup();
    await client.save(conn, [voucher(REF1)]);
    await client.save(conn, [voucher(REF1)]);
    expect(fake.requests.size).toBe(1);
  });
});

describe('the result of a push', () => {
  it('reaches the caller by callback (signed) and by polling, both in the same shape', async () => {
    const { fake, client } = setup();
    await client.save(conn, [voucher(REF1), voucher(REF2)]);
    const read = readCallback(fake.callbackBody(fake.results), CLIENT);
    expect(read).toMatchObject({ ok: true, callback: { results: [{ orgRefId: REF1, success: true }, { orgRefId: REF2, success: true }] } });
    const polled = await client.callbackResults(conn, { from: '2026-11-01', to: '2026-11-30', skip: 0, take: 100 });
    expect(polled.map((r) => [r.orgRefId, r.success, r.voucherType])).toEqual([[REF1, true, 17], [REF2, true, 17]]);
    expect(await client.callbackResults(conn, { from: '2026-11-01', to: '2026-11-30', skip: 1, take: 1 })).toHaveLength(1);
    // MISA's own numbers go as strings in the polling body, as the document's example shows.
    expect(JSON.parse(fake.calls.at(-1)?.body ?? '{}')).toEqual({ from_date: '2026-11-01', to_date: '2026-11-30', skip: '1', take: '1' });
  });

  it('refuses a callback signed with another key, or a replayed one with another app id', async () => {
    const { fake, client } = setup();
    await client.save(conn, [voucher(REF1)]);
    expect(readCallback(fake.callbackBody(fake.results, { appId: 'another' }), CLIENT)).toEqual({ ok: false, reason: 'app_id' });
    expect(readCallback(fake.callbackBody(fake.results), 'another-key')).toEqual({ ok: false, reason: 'signature' });
  });
});

describe('delete, catalogues and company', () => {
  it('removes a request not yet a voucher, and the result says VoucherNotFound for one that is not there', async () => {
    const { fake, client } = setup();
    await client.save(conn, [voucher(REF1)]);
    await client.remove(conn, [{ voucher_type: 17, org_refid: REF1 }, { voucher_type: 17, org_refid: REF2 }]);
    expect(fake.calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/amiskt/v1/delete' });
    expect(JSON.parse(fake.calls.at(-1)?.body ?? '{}')).toEqual({ org_company_code: ORG, voucher: [{ voucher_type: 17, org_refid: REF1 }, { voucher_type: 17, org_refid: REF2 }] });
    expect(fake.results.slice(1).map((r) => [r.success, r.error_code])).toEqual([[true, null], [false, 'VoucherNotFound']]);
    expect(fake.requests.has(REF1)).toBe(false);
    expect(await fails(client.remove(conn, [{ voucher_type: 17, org_refid: 'x' }]))).toMatchObject({ reason: 'bad_org_refid' });
  });

  it('reads a catalogue page by page, with the document\'s fields in the body, and refuses a page it cannot ask for', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ account_object_code: `NCC${i}`, account_object_name: `Nhà cung cấp ${i}` }));
    const { fake, client } = setup({ dictionary: { [AMIS_DICTIONARIES.accountObject]: rows } });
    expect(await client.dictionary(conn, { dataType: AMIS_DICTIONARIES.accountObject, skip: 2, take: 2 })).toEqual(rows.slice(2, 4));
    expect(JSON.parse(fake.calls.at(-1)?.body ?? '{}')).toEqual({ data_type: 1, skip: 2, take: 2, last_sync_time: null, branch_id: null });
    for (const [skip, take] of [[-1, 10], [0, 0], [0, 1001], [0.5, 10]] as const) expect(await fails(client.dictionary(conn, { dataType: 1, skip, take })), `${skip},${take}`).toMatchObject({ reason: 'bad_page' });
    await client.saveDictionary(conn, AMIS_DICTIONARIES.accountObject, [{ account_object_code: 'NCC9' }]);
    expect(fake.calls.at(-1)?.path).toBe('/amiskt/v1/save_dictionary');
  });

  it('tests a connection with the company information', async () => {
    const { client } = setup();
    expect(await client.companyInfo(conn, '0e0a14cf-9e4b-4af9-875b-c490f34a581b')).toEqual({ company_name: 'Công ty thử', branch_id: '0e0a14cf-9e4b-4af9-875b-c490f34a581b' });
  });
});

describe('the answer\'s status, the token under concurrency, and the transport\'s errors', () => {
  it('reads the status before the body: a 401 or 403 is a refused connection, and only a 2xx can be a success', async () => {
    const { fake, client } = setup();
    await client.companyInfo(conn);
    for (const status of [401, 403]) {
      fake.rawNext(status, '<html>denied</html>');
      expect(await fails(client.companyInfo(conn)), String(status)).toMatchObject({ kind: 'credentials' });
    }
    for (const status of [302, 400, 404, 199]) {
      fake.rawNext(status, JSON.stringify({ Success: true, Data: { x: 1 } }));
      expect(await fails(client.companyInfo(conn)), String(status)).toMatchObject({ kind: 'invalid_response' });
    }
  });

  it('does not pass on what a transport attached to its own error', async () => {
    const { fake, client } = setup();
    await client.companyInfo(conn);
    fake.throwNext(Object.assign(new AmisError('timeout'), { request: { headers: { ClientID: CLIENT } }, cause: new Error(CODE) }));
    const error = await fails(client.companyInfo(conn));
    expect(error).toMatchObject({ kind: 'timeout' });
    expect(Object.keys(error).sort()).toEqual(['code', 'kind', 'name', 'reason']);
    expect(error.cause).toBeUndefined();
  });

  it('keeps a token another call just renewed when a late call fails with the old one', async () => {
    const fake = createFakeMisa({ clientId: CLIENT, accessCodes: { [CODE]: ORG } });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => void (release = resolve));
    let withOld = 0;
    const client = createAmisClient({
      clientId: CLIENT,
      transport: async (request) => {
        const response = await fake.transport(request);
        // The third call made with token-1 (call B) has its answer held back until call A has finished with a renewed token.
        if (request.headers['X-MISA-AccessToken'] === 'token-1' && ++withOld === 3) await gate;
        return response;
      },
    });
    await client.companyInfo(conn);
    fake.expireTokens();
    const a = client.companyInfo(conn);
    const b = client.companyInfo(conn);
    await a;
    release();
    await b;
    // token-1, then token-2 for A; B's late ExpiredToken did not throw token-2 away, so there is no third.
    expect(tokenCalls(fake)).toBe(2);
  });

  it('refuses a bad catalogue row or an unknown voucher type to delete before it asks for a token', async () => {
    const { fake, client } = setup();
    expect(await fails(client.saveDictionary(conn, AMIS_DICTIONARIES.accountObject, [{ account_object_code: 12.5 }]))).toMatchObject({ kind: 'invalid_request', reason: 'bad_amount' });
    expect(await fails(client.saveDictionary(conn, AMIS_DICTIONARIES.accountObject, []))).toMatchObject({ reason: 'too_many_rows' });
    expect(await fails(client.remove(conn, [{ voucher_type: 2, org_refid: REF1 }]))).toMatchObject({ reason: 'bad_voucher_type' });
    expect(fake.calls).toHaveLength(0);
  });
});

describe('what goes wrong', () => {
  it('maps a MISA error code to its kind, keeps only a plain-word code, and never lets server text into the error', async () => {
    const { fake, client } = setup();
    await client.companyInfo(conn);
    for (const [code, kind] of [['InvalidParam', 'refused'], ['IsCreatedVoucher', 'refused'], ['AppIDDisconnect', 'credentials'], ['DBAmisNotConnectDBAC', 'credentials'], ['Exception', 'unavailable'], ['SomethingNew', 'refused']] as const) {
      fake.failNext(code);
      expect(await fails(client.companyInfo(conn)), code).toMatchObject({ kind, code });
    }
    fake.failNext('x\n<script>alert(1)</script>');
    const odd = await fails(client.companyInfo(conn));
    expect(odd).toMatchObject({ kind: 'refused', code: null });
    expect(odd.message).not.toContain('script');
  });

  it('is `unavailable` on a 5xx or a 429 and `invalid_response` on an answer that is not in the document\'s shape', async () => {
    const { fake, client } = setup();
    await client.companyInfo(conn);
    for (const status of [500, 502, 503, 429]) {
      fake.rawNext(status, '<html>boom</html>');
      expect(await fails(client.companyInfo(conn)), String(status)).toMatchObject({ kind: 'unavailable' });
    }
    for (const body of ['<html>', 'null', '[]', '"x"', '{}', '{"Success":"true"}']) {
      fake.rawNext(200, body);
      expect(await fails(client.companyInfo(conn)), body).toMatchObject({ kind: 'invalid_response' });
    }
  });

  it('is `invalid_response` when the token answer carries no token', async () => {
    const { fake, client } = setup();
    fake.rawNext(200, JSON.stringify({ Success: true, Data: { access_token: '' } }));
    expect(await fails(client.companyInfo(conn))).toMatchObject({ kind: 'invalid_response' });
    fake.rawNext(200, JSON.stringify({ Success: true, Data: null }));
    expect(await fails(client.companyInfo(conn))).toMatchObject({ kind: 'invalid_response' });
  });

  it('keeps the transport\'s own kinds, and takes any other rejection as `unreachable` without its message', async () => {
    const { fake, client } = setup();
    await client.companyInfo(conn);
    for (const kind of ['unreachable', 'timeout', 'lost_answer'] as const) {
      fake.throwNext(new AmisError(kind));
      expect(await fails(client.companyInfo(conn)), kind).toMatchObject({ kind });
    }
    fake.throwNext(new Error(`connect ECONNREFUSED with header ClientID: ${CLIENT} and ${CODE}`));
    const hidden = await fails(client.companyInfo(conn));
    expect(hidden).toMatchObject({ kind: 'unreachable' });
    fake.throwNext('plain string');
    expect(await fails(client.companyInfo(conn))).toMatchObject({ kind: 'unreachable' });
  });

  it('leaves no secret in an error on any failing path', async () => {
    const { fake, client } = setup();
    const errors: AmisError[] = [];
    fake.failNext('InvalidAPPID');
    errors.push(await fails(client.companyInfo(conn)));
    errors.push(await fails(createAmisClient({ clientId: CLIENT, transport: fake.transport }).companyInfo({ accessCode: CODE + 'x', orgCompanyCode: ORG })));
    errors.push(await fails(client.save(conn, [voucher('nope')])));
    for (const error of errors) {
      expect(error.message).toMatch(/^MISA AMIS error: [a-z_]+( \([A-Za-z0-9_]+\))?( \[[a-z_]+\])?$/);
    }
  });
});
