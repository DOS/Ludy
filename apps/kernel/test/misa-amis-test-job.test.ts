// SPDX-License-Identifier: AGPL-3.0-only
// The test of a MISA AMIS connection, the worker's half (#3885, S2b of #3854), against a fake AMIS and a fake runtime: every way a test ends, the state that is recorded, and that nothing but ids and a
// state is recorded or logged (not the access code, not the integrator's ClientID, not AMIS's own text).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AmisError, createAmisClient, type AmisRequest, type AmisResponse, type AmisTransport } from '@crove/misa-amis';
import { DomainError, type CredentialBroker, type Runtime } from '@crove/kernel-runtime';
import { runMisaAmisTest } from '../src/misa-amis-test-job.ts';

const CLIENT_ID = 'planted-client-id-0123456789';
const ACCESS_CODE = 'planted-access-code-abcdef';
const COMPANY = 'ludy-0123456789abcdef0123456789abcdef';
const ORG = '11111111-1111-4111-8111-111111111111';
const CONNECTION = '22222222-2222-4222-8222-222222222222';
const CHANNEL = '33333333-3333-4333-8333-333333333333';

const ok = (data: unknown): AmisResponse => ({ status: 200, body: JSON.stringify({ Success: true, ErrorMessage: '', Data: data }) });
const fail = (code: string): AmisResponse => ({ status: 200, body: JSON.stringify({ Success: false, ErrorCode: code, ErrorMessage: `planted AMIS text ${ACCESS_CODE}` }) });

// What AMIS does with a call, as far as the test depends on it: a token for the right code and company, then the company's information.
function fakeAmis(behave: (request: AmisRequest, path: string) => AmisResponse | Promise<AmisResponse> | undefined = () => undefined) {
  const calls: Array<{ path: string; headers: Readonly<Record<string, string>>; body: Record<string, unknown> }> = [];
  const transport: AmisTransport = async (request) => {
    const path = new URL(request.url).pathname.replace(/^\/apis/, '');
    calls.push({ path, headers: request.headers, body: JSON.parse(request.body) as Record<string, unknown> });
    const forced = await behave(request, path);
    if (forced) return forced;
    if (request.headers.ClientID !== CLIENT_ID) return fail('InvalidAPPID');
    const body = JSON.parse(request.body) as Record<string, unknown>;
    if (path === '/amiskt/v1/token') return body.access_code === ACCESS_CODE && body.org_company_code === COMPANY ? ok({ access_token: 'token-1', expired_time: '2027-01-19T20:00:00' }) : fail('InvalidAccessToken');
    if (request.headers['X-MISA-AccessToken'] !== 'token-1') return fail('InvalidToken');
    if (path === '/amiskt/v1/get_company_info') return ok({ company_name: 'Công ty thử' });
    return fail('InvalidParam');
  };
  return { transport, calls };
}

interface Harness {
  runtime: Runtime;
  broker: CredentialBroker;
  queries: Array<{ name: string; input: unknown }>;
  executed: Array<{ name: string; input: unknown }>;
  opened: unknown[];
}
function harness(options: { target?: unknown; credential?: () => unknown } = {}): Harness {
  const queries: Harness['queries'] = [];
  const executed: Harness['executed'] = [];
  const opened: unknown[] = [];
  const target = options.target ?? { action: 'test', id: CONNECTION, channelConnectionId: CHANNEL, orgCompanyCode: COMPANY };
  const runtime = {
    query: async (name: string, input: unknown) => {
      queries.push({ name, input });
      if (name === 'finance.misa_amis_connection.test_target') return target;
      if (name === 'kernel.channel.credential') return options.credential ? options.credential() : { provider: 'accounting_misa_amis', externalAccountId: 'entity', keyId: 'k1', envelope: Buffer.from('sealed').toString('base64') };
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

const recorded = (h: Harness) => h.executed.filter((e) => e.name === 'finance.misa_amis_connection.record_test').map((e) => e.input);

afterEach(() => vi.restoreAllMocks());

describe('the MISA AMIS connection test job', () => {
  it('asks for a token with the access code and the connection\'s company code, then for the company information, and records "works"', async () => {
    const h = harness();
    const amis = fakeAmis();
    const client = createAmisClient({ clientId: CLIENT_ID, transport: amis.transport });
    expect(await runMisaAmisTest({ runtime: h.runtime, broker: h.broker, client }, { orgId: ORG, connectionId: CONNECTION })).toEqual({ state: 'works' });
    expect(amis.calls.map((c) => c.path)).toEqual(['/amiskt/v1/token', '/amiskt/v1/get_company_info']);
    expect(amis.calls[0]?.body).toEqual({ access_code: ACCESS_CODE, org_company_code: COMPANY });
    expect(amis.calls[0]?.headers.ClientID).toBe(CLIENT_ID);
    // The code is opened for the binding it was sealed under, and nothing else is recorded but the state.
    expect(h.opened).toEqual([{ sealed: { keyId: 'k1', envelope: Buffer.from('sealed') }, binding: { orgId: ORG, provider: 'accounting_misa_amis', externalAccountId: 'entity' } }]);
    expect(recorded(h)).toEqual([{ id: CONNECTION, state: 'works' }]);
  });

  it('asks AMIS for a new token on every test, so a code revoked in AMIS cannot read "works" from a token kept from an earlier test', async () => {
    const amis = fakeAmis();
    const client = createAmisClient({ clientId: CLIENT_ID, transport: amis.transport });
    const first = harness();
    expect(await runMisaAmisTest({ runtime: first.runtime, broker: first.broker, client }, { orgId: ORG, connectionId: CONNECTION })).toEqual({ state: 'works' });
    expect(amis.calls.filter((c) => c.path === '/amiskt/v1/token')).toHaveLength(1);
    // The same client, a second test, minutes later: the access code goes to AMIS again.
    const second = harness();
    expect(await runMisaAmisTest({ runtime: second.runtime, broker: second.broker, client }, { orgId: ORG, connectionId: CONNECTION })).toEqual({ state: 'works' });
    expect(amis.calls.filter((c) => c.path === '/amiskt/v1/token')).toHaveLength(2);
    // And when the code has been revoked meanwhile, the second test says so.
    const revoked = fakeAmis((_request, path) => (path === '/amiskt/v1/token' ? fail('InvalidAccessToken') : undefined));
    const third = harness();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await runMisaAmisTest({ runtime: third.runtime, broker: third.broker, client: createAmisClient({ clientId: CLIENT_ID, transport: revoked.transport }) }, { orgId: ORG, connectionId: CONNECTION })).toEqual({ state: 'wrong_credentials' });
  });

  it('opens only a credential sealed for this connector: another provider\'s is not opened, AMIS is not asked, and the state is "wrong_credentials"', async () => {
    const h = harness({ credential: () => ({ provider: 'marketplace_sandbox', externalAccountId: 'entity', keyId: 'k1', envelope: Buffer.from('sealed').toString('base64') }) });
    const amis = fakeAmis();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await runMisaAmisTest({ runtime: h.runtime, broker: h.broker, client: createAmisClient({ clientId: CLIENT_ID, transport: amis.transport }) }, { orgId: ORG, connectionId: CONNECTION })).toEqual({ state: 'wrong_credentials' });
    expect(h.opened).toEqual([]);
    expect(amis.calls).toEqual([]);
    expect(recorded(h)).toEqual([{ id: CONNECTION, state: 'wrong_credentials' }]);
    expect(warn.mock.calls).toEqual([['[misa-amis] 22222222: credential of another provider, not opened']]);
  });

  it('runs as the system and reads the target and the credential of this connection only', async () => {
    const h = harness();
    await runMisaAmisTest({ runtime: h.runtime, broker: h.broker, client: createAmisClient({ clientId: CLIENT_ID, transport: fakeAmis().transport }) }, { orgId: ORG, connectionId: CONNECTION });
    expect(h.queries).toEqual([
      { name: 'finance.misa_amis_connection.test_target', input: { id: CONNECTION } },
      { name: 'kernel.channel.credential', input: { connectionId: CHANNEL } },
    ]);
  });

  it('records "wrong_credentials" when AMIS refuses the access code, the app or the data connection, and never keeps AMIS\'s text', async () => {
    for (const code of ['InvalidAccessToken', 'AppIDDisconnect', 'DBAmisNotConnectDBAC']) {
      const h = harness();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const amis = fakeAmis((_request, path) => (path === '/amiskt/v1/token' ? fail(code) : undefined));
      const out = await runMisaAmisTest({ runtime: h.runtime, broker: h.broker, client: createAmisClient({ clientId: CLIENT_ID, transport: amis.transport }) }, { orgId: ORG, connectionId: CONNECTION });
      expect(out, code).toEqual({ state: 'wrong_credentials' });
      expect(recorded(h), code).toEqual([{ id: CONNECTION, state: 'wrong_credentials' }]);
      const everything = JSON.stringify([h.executed, warn.mock.calls]);
      for (const secret of [ACCESS_CODE, CLIENT_ID, 'planted AMIS text']) expect(everything, `${code} ${secret}`).not.toContain(secret);
    }
  });

  it('does not blame the customer\'s access code when AMIS does not know the deployment\'s own app: "unreachable", and the log says which code', async () => {
    const h = harness();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const amis = fakeAmis((_request, path) => (path === '/amiskt/v1/token' ? fail('InvalidAPPID') : undefined));
    const out = await runMisaAmisTest({ runtime: h.runtime, broker: h.broker, client: createAmisClient({ clientId: CLIENT_ID, transport: amis.transport }) }, { orgId: ORG, connectionId: CONNECTION });
    expect(out).toEqual({ state: 'unreachable' });
    expect(recorded(h)).toEqual([{ id: CONNECTION, state: 'unreachable' }]);
    expect(warn.mock.calls).toEqual([['[misa-amis] 22222222: unreachable (credentials, InvalidAPPID)']]);
  });

  it('records "wrong_credentials" for a gateway\'s 401 or 403', async () => {
    for (const status of [401, 403]) {
      const h = harness();
      const amis = fakeAmis(() => ({ status, body: 'planted gateway text' }));
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      expect(await runMisaAmisTest({ runtime: h.runtime, broker: h.broker, client: createAmisClient({ clientId: CLIENT_ID, transport: amis.transport }) }, { orgId: ORG, connectionId: CONNECTION })).toEqual({ state: 'wrong_credentials' });
    }
  });

  it('records "unreachable" when AMIS cannot be reached, is slow, answers with an error of its own or answers nonsense', async () => {
    const cases: Array<[string, () => AmisResponse | Promise<AmisResponse>]> = [
      ['unreachable', () => Promise.reject(new AmisError('unreachable'))],
      ['timeout', () => Promise.reject(new AmisError('timeout'))],
      ['lost_answer', () => Promise.reject(new AmisError('lost_answer'))],
      ['any other rejection', () => Promise.reject(new Error(`socket error with ClientID ${CLIENT_ID}`))],
      ['a 503', () => ({ status: 503, body: 'planted gateway text' })],
      ['a 429', () => ({ status: 429, body: '' })],
      ['not JSON', () => ({ status: 200, body: '<html>planted</html>' })],
      ['a refusal of the call itself', () => fail('InvalidParam')],
      ['an unknown error code', () => fail('SomethingNew')],
    ];
    for (const [name, answer] of cases) {
      const h = harness();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const amis = fakeAmis(() => answer());
      const out = await runMisaAmisTest({ runtime: h.runtime, broker: h.broker, client: createAmisClient({ clientId: CLIENT_ID, transport: amis.transport }) }, { orgId: ORG, connectionId: CONNECTION });
      expect(out, name).toEqual({ state: 'unreachable' });
      expect(recorded(h), name).toEqual([{ id: CONNECTION, state: 'unreachable' }]);
      const everything = JSON.stringify([h.executed, warn.mock.calls]);
      for (const secret of [ACCESS_CODE, CLIENT_ID, 'planted']) expect(everything, `${name} ${secret}`).not.toContain(secret);
      warn.mockRestore();
    }
  });

  it('logs the connection\'s short id, the state and the kind, and nothing else', async () => {
    const h = harness();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const amis = fakeAmis(() => ({ status: 503, body: '' }));
    await runMisaAmisTest({ runtime: h.runtime, broker: h.broker, client: createAmisClient({ clientId: CLIENT_ID, transport: amis.transport }) }, { orgId: ORG, connectionId: CONNECTION });
    expect(warn.mock.calls).toEqual([['[misa-amis] 22222222: unreachable (unavailable)']]);
  });

  it('leaves a connection that is gone or no longer active alone: nothing asked, nothing recorded', async () => {
    for (const reason of ['not_found', 'not_active']) {
      const h = harness({ target: { action: 'none', reason } });
      const amis = fakeAmis();
      const out = await runMisaAmisTest({ runtime: h.runtime, broker: h.broker, client: createAmisClient({ clientId: CLIENT_ID, transport: amis.transport }) }, { orgId: ORG, connectionId: CONNECTION });
      expect(out).toEqual({ state: 'skipped', reason });
      expect(amis.calls).toEqual([]);
      expect(h.executed).toEqual([]);
      expect(h.opened).toEqual([]);
    }
  });

  it('records "wrong_credentials" without asking AMIS when the member who connected it may no longer use it, and expires the connection when they left', async () => {
    for (const code of ['CHANNEL_OWNER_LEFT', 'CHANNEL_NOT_ACTIVE']) {
      const h = harness({
        credential: () => {
          throw new DomainError(code, 409, 'planted');
        },
      });
      const amis = fakeAmis();
      const out = await runMisaAmisTest({ runtime: h.runtime, broker: h.broker, client: createAmisClient({ clientId: CLIENT_ID, transport: amis.transport }) }, { orgId: ORG, connectionId: CONNECTION });
      expect(out, code).toEqual({ state: 'wrong_credentials' });
      expect(amis.calls, code).toEqual([]);
      expect(h.executed.map((e) => e.name), code).toEqual(code === 'CHANNEL_OWNER_LEFT' ? ['kernel.channel.mark_expired', 'finance.misa_amis_connection.record_test'] : ['finance.misa_amis_connection.record_test']);
    }
  });

  it('lets any other failure of reading the credential through (the job retries), and records nothing', async () => {
    const h = harness({
      credential: () => {
        throw new Error('database down');
      },
    });
    const amis = fakeAmis();
    await expect(runMisaAmisTest({ runtime: h.runtime, broker: h.broker, client: createAmisClient({ clientId: CLIENT_ID, transport: amis.transport }) }, { orgId: ORG, connectionId: CONNECTION })).rejects.toThrow('database down');
    expect(h.executed).toEqual([]);
    expect(amis.calls).toEqual([]);
  });
});
