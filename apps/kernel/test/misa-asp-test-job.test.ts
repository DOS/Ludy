// SPDX-License-Identifier: AGPL-3.0-only
// The test of a MISA ASP connection, the worker's half (#4111, S2 of #4103), against a fake ASP and a fake runtime. ASP has no company-information call, so the test is a token and then one row of the
// organization-unit catalogue (data_type 6, take 1); the access code is opened only for ASP's own provider id; a product the deployment holds no ClientID for is left alone; every state is the
// AMIS test's (works, wrong_credentials, unreachable) and nothing but a state and ids is recorded or logged.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAmisClient, type AmisRequest, type AmisResponse, type AmisTransport } from '@ludy/misa-amis';
import type { CredentialBroker, Runtime } from '@ludy/kernel-runtime';
import { runMisaAmisTest } from '../src/misa-amis-test-job.ts';

const CLIENT_ID = 'planted-asp-client-id-0123456789';
const ACCESS_CODE = 'planted-asp-access-code-abcdef';
const COMPANY = 'ludy-0123456789abcdef0123456789abcdef';
const ORG = '11111111-1111-4111-8111-111111111111';
const CONNECTION = '22222222-2222-4222-8222-222222222222';
const CHANNEL = '33333333-3333-4333-8333-333333333333';

const ok = (data: unknown): AmisResponse => ({ status: 200, body: JSON.stringify({ Success: true, ErrorMessage: '', Data: data }) });
const fail = (code: string): AmisResponse => ({ status: 200, body: JSON.stringify({ Success: false, ErrorCode: code, ErrorMessage: `planted ASP text ${ACCESS_CODE}` }) });

function fakeAsp(behave: (path: string) => AmisResponse | undefined = () => undefined) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const transport: AmisTransport = async (request: AmisRequest) => {
    const path = new URL(request.url).pathname.replace(/^\/apis/, '');
    const body = JSON.parse(request.body) as Record<string, unknown>;
    calls.push({ path, body });
    const forced = behave(path);
    if (forced) return forced;
    if (path === '/asp/v1/token') return body.access_code === ACCESS_CODE && body.org_company_code === COMPANY ? ok({ access_token: 'token-1', expired_time: '2027-01-19T20:00:00' }) : fail('InvalidAccessToken');
    if (request.headers['X-MISA-AccessToken'] !== 'token-1') return fail('InvalidToken');
    if (path === '/asp/v1/get_dictionary') return ok([{ organization_unit_id: 'b1', organization_unit_name: 'Trụ sở' }]);
    return fail('InvalidParam');
  };
  return { transport, calls };
}

function harness(options: { target?: unknown; provider?: string } = {}) {
  const executed: Array<{ name: string; input: unknown }> = [];
  const opened: unknown[] = [];
  const target = options.target ?? { action: 'test', id: CONNECTION, product: 'asp', channelConnectionId: CHANNEL, orgCompanyCode: COMPANY };
  const runtime = {
    query: async (name: string) => {
      if (name === 'finance.misa_amis_connection.test_target') return target;
      if (name === 'kernel.channel.credential') return { provider: options.provider ?? 'accounting_misa_asp', externalAccountId: 'entity', keyId: 'k1', envelope: Buffer.from('sealed').toString('base64') };
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
  return { runtime, broker, executed, opened };
}
const recorded = (h: ReturnType<typeof harness>) => h.executed.filter((e) => e.name === 'finance.misa_amis_connection.record_test').map((e) => e.input);
const aspClient = (transport: AmisTransport) => createAmisClient({ clientId: CLIENT_ID, product: 'asp', transport });

afterEach(() => vi.restoreAllMocks());

describe('the MISA ASP connection test job (#4111)', () => {
  it('asks for a token, then for one row of the organization-unit catalogue, never for the company information, and records "works"', async () => {
    const h = harness();
    const asp = fakeAsp();
    // The AMIS client is not even given: an ASP connection never reaches it.
    expect(await runMisaAmisTest({ runtime: h.runtime, broker: h.broker, client: null, aspClient: aspClient(asp.transport) }, { orgId: ORG, connectionId: CONNECTION })).toEqual({ state: 'works' });
    expect(asp.calls.map((c) => c.path)).toEqual(['/asp/v1/token', '/asp/v1/get_dictionary']);
    expect(asp.calls[0]?.body).toEqual({ access_code: ACCESS_CODE, org_company_code: COMPANY });
    expect(asp.calls[1]?.body).toMatchObject({ data_type: 6, skip: 0, take: 1 });
    expect(h.opened).toEqual([{ sealed: { keyId: 'k1', envelope: Buffer.from('sealed') }, binding: { orgId: ORG, provider: 'accounting_misa_asp', externalAccountId: 'entity' } }]);
    expect(recorded(h)).toEqual([{ id: CONNECTION, state: 'works' }]);
  });

  it('sends the access code again on every test, so a code revoked in ASP cannot read "works" from a token kept earlier', async () => {
    const asp = fakeAsp();
    const client = aspClient(asp.transport);
    for (let i = 0; i < 2; i += 1) {
      const h = harness();
      expect(await runMisaAmisTest({ runtime: h.runtime, broker: h.broker, client: null, aspClient: client }, { orgId: ORG, connectionId: CONNECTION })).toEqual({ state: 'works' });
    }
    expect(asp.calls.filter((c) => c.path === '/asp/v1/token')).toHaveLength(2);
  });

  it('records "wrong_credentials" for a refused code and "unreachable" for the deployment\'s own unknown app, and keeps no ASP text', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const refused = harness();
    expect(await runMisaAmisTest({ runtime: refused.runtime, broker: refused.broker, client: null, aspClient: aspClient(fakeAsp((p) => (p === '/asp/v1/token' ? fail('InvalidAccessToken') : undefined)).transport) }, { orgId: ORG, connectionId: CONNECTION })).toEqual({ state: 'wrong_credentials' });
    expect(recorded(refused)).toEqual([{ id: CONNECTION, state: 'wrong_credentials' }]);
    const unknownApp = harness();
    expect(await runMisaAmisTest({ runtime: unknownApp.runtime, broker: unknownApp.broker, client: null, aspClient: aspClient(fakeAsp((p) => (p === '/asp/v1/token' ? fail('InvalidAPPID') : undefined)).transport) }, { orgId: ORG, connectionId: CONNECTION })).toEqual({ state: 'unreachable' });
    const lines = JSON.stringify([warn.mock.calls, refused.executed, unknownApp.executed]);
    expect(lines).not.toContain(ACCESS_CODE);
    expect(lines).not.toContain('planted ASP text');
    expect(lines).not.toContain(CLIENT_ID);
  });

  it('opens only the code sealed for ASP: an AMIS credential on an ASP connection is not opened, ASP is not asked, and the state is "wrong_credentials"', async () => {
    const h = harness({ provider: 'accounting_misa_amis' });
    const asp = fakeAsp();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await runMisaAmisTest({ runtime: h.runtime, broker: h.broker, client: null, aspClient: aspClient(asp.transport) }, { orgId: ORG, connectionId: CONNECTION })).toEqual({ state: 'wrong_credentials' });
    expect(h.opened).toEqual([]);
    expect(asp.calls).toEqual([]);
  });

  it('and the other way round: an ASP credential on an AMIS connection is not opened either', async () => {
    const h = harness({ provider: 'accounting_misa_asp', target: { action: 'test', id: CONNECTION, product: 'amis', channelConnectionId: CHANNEL, orgCompanyCode: COMPANY } });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const amis = fakeAsp();
    expect(await runMisaAmisTest({ runtime: h.runtime, broker: h.broker, client: createAmisClient({ clientId: CLIENT_ID, transport: amis.transport }), aspClient: null }, { orgId: ORG, connectionId: CONNECTION })).toEqual({ state: 'wrong_credentials' });
    expect(h.opened).toEqual([]);
    expect(amis.calls).toEqual([]);
  });

  it('leaves a connection alone when the deployment holds no ClientID for its product: nothing is asked and nothing is recorded', async () => {
    const h = harness();
    expect(await runMisaAmisTest({ runtime: h.runtime, broker: h.broker, client: createAmisClient({ clientId: CLIENT_ID, transport: fakeAsp().transport }), aspClient: null }, { orgId: ORG, connectionId: CONNECTION })).toEqual({ state: 'skipped', reason: 'product_off' });
    expect(h.opened).toEqual([]);
    expect(recorded(h)).toEqual([]);
  });
});
