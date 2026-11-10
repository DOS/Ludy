// SPDX-License-Identifier: AGPL-3.0-only
// The MCP wire protocol of the endpoint as pure functions (ADR-0051, #2975): the three revisions it answers, the spec's errors, and what a tool call may be.
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { handleMcp, type HandleInput, type ToolDescriptor } from '../src/mcp-protocol.ts';

const tool: ToolDescriptor = {
  name: 'ludy_about',
  title: 'About',
  description: 'd',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: { type: 'object' },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  run: async () => ({ ok: true }),
};
const input = (over: Partial<HandleInput>): HandleInput => ({
  body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  headers: { protocolVersion: '2025-11-25', method: null, name: null },
  tools: [tool],
  serverVersion: 't',
  callTool: (t) => t.run(),
  describeError: () => ({ code: -32603, message: 'e' }),
  ...over,
});
const json = (reply: Awaited<ReturnType<typeof handleMcp>>) => {
  if (reply.kind !== 'json') throw new Error('expected json');
  return reply as { kind: 'json'; status: number; body: any };
};

describe('handleMcp', () => {
  it('answers initialize for the legacy revisions without a session, and the newest legacy one for an unknown version', async () => {
    for (const [asked, answered] of [['2025-06-18', '2025-06-18'], ['2025-11-25', '2025-11-25'], ['2024-11-05', '2025-11-25'], ['', '2025-11-25']] as const) {
      const reply = json(await handleMcp(input({ body: { jsonrpc: '2.0', id: 'a', method: 'initialize', params: { protocolVersion: asked } }, headers: { protocolVersion: null, method: null, name: null } })));
      expect(reply.status).toBe(200);
      expect(reply.body.result.protocolVersion).toBe(answered);
      expect(reply.body.result.capabilities).toEqual({ tools: { listChanged: false } });
    }
  });

  it('refuses a missing or unknown version header with the specified errors', async () => {
    expect(json(await handleMcp(input({ headers: { protocolVersion: null, method: null, name: null } }))).body.error.code).toBe(-32020);
    const unknown = json(await handleMcp(input({ headers: { protocolVersion: '1999-01-01', method: null, name: null } })));
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toMatchObject({ code: -32022, data: { supported: ['2026-07-28', '2025-11-25', '2025-06-18'], requested: '1999-01-01' } });
  });

  it('checks the modern headers against the body: version, method and tool name', async () => {
    const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' };
    const ok = json(await handleMcp(input({ body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta } }, headers: { protocolVersion: '2026-07-28', method: 'tools/list', name: null } })));
    expect(ok.body.result).toMatchObject({ resultType: 'complete', cacheScope: 'private' });
    const wrongMeta = json(await handleMcp(input({ body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2025-11-25' } } }, headers: { protocolVersion: '2026-07-28', method: 'tools/list', name: null } })));
    expect([wrongMeta.status, wrongMeta.body.error.code]).toEqual([400, -32020]);
    const wrongMethod = json(await handleMcp(input({ body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta } }, headers: { protocolVersion: '2026-07-28', method: 'ping', name: null } })));
    expect([wrongMethod.status, wrongMethod.body.error.code]).toEqual([400, -32020]);
    const wrongName = json(await handleMcp(input({ body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ludy_about', _meta: meta } }, headers: { protocolVersion: '2026-07-28', method: 'tools/call', name: 'other' } })));
    expect([wrongName.status, wrongName.body.error.code]).toEqual([400, -32020]);
    expect(json(await handleMcp(input({ body: { jsonrpc: '2.0', id: 1, method: 'resources/list', params: { _meta: meta } }, headers: { protocolVersion: '2026-07-28', method: 'resources/list', name: null } }))).status).toBe(404);
  });

  it('accepts notifications and client responses, refuses a batch and malformed messages', async () => {
    expect((await handleMcp(input({ body: { jsonrpc: '2.0', method: 'notifications/initialized' } }))).kind).toBe('accepted');
    expect((await handleMcp(input({ body: { jsonrpc: '2.0', id: 1, result: {} } }))).kind).toBe('accepted');
    expect(json(await handleMcp(input({ body: [{ jsonrpc: '2.0', id: 1, method: 'ping' }] }))).status).toBe(400);
    for (const bad of [null, 'x', 5, {}, { jsonrpc: '1.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 1 }]) expect(json(await handleMcp(input({ body: bad }))).status, JSON.stringify(bad)).toBe(400);
  });

  it('runs only a listed tool, without arguments, and turns a thrown error into a JSON-RPC error', async () => {
    const call = (params: unknown, over: Partial<HandleInput> = {}) => handleMcp(input({ body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params }, ...over }));
    expect(json(await call({ name: 'ludy_about' })).body.result).toMatchObject({ structuredContent: { ok: true }, isError: false });
    expect(json(await call({ name: 'ludy_about', arguments: {} })).body.result.isError).toBe(false);
    expect(json(await call({ name: 'nope' })).body.error.code).toBe(-32602);
    expect(json(await call({ name: 'ludy_about', arguments: { a: 1 } })).body.error.code).toBe(-32602);
    expect(json(await call({ name: 'ludy_about', arguments: [] })).body.error.code).toBe(-32602);
    const failing = json(await call({ name: 'ludy_about' }, { callTool: async () => { throw new Error('secret detail'); }, describeError: () => ({ code: -32603, message: 'Internal error' }) }));
    expect(failing.body.error).toEqual({ code: -32603, message: 'Internal error' });
    expect(JSON.stringify(failing.body)).not.toContain('secret detail');
  });
});

describe('the OAUTH_SERVER settings', () => {
  const base = { DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'unit-test-jwt-secret-0123456789abcdef', AUTH_ISSUER: 'crove-auth' };
  const jwk = JSON.stringify({ keys: [{ kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd', kid: 'k1' }] });
  const cookies = 'c'.repeat(40);

  it('is off by default and boots without keys', () => {
    expect(loadConfig({ ...base }).OAUTH_SERVER).toBe('off');
    expect(() => loadConfig({ ...base, OAUTH_SERVER: '', OAUTH_JWKS: '', OAUTH_COOKIE_KEYS: '' })).toThrow();
  });

  it('on, needs ES256 private keys with a kid, cookie secrets of 32 characters and the same origin for the app', () => {
    expect(loadConfig({ ...base, OAUTH_SERVER: 'on', OAUTH_JWKS: jwk, OAUTH_COOKIE_KEYS: cookies }).OAUTH_SERVER).toBe('on');
    expect(() => loadConfig({ ...base, OAUTH_SERVER: 'on', OAUTH_COOKIE_KEYS: cookies })).toThrow(/OAUTH_JWKS/);
    expect(() => loadConfig({ ...base, OAUTH_SERVER: 'on', OAUTH_JWKS: 'not json', OAUTH_COOKIE_KEYS: cookies })).toThrow(/valid JSON/);
    expect(() => loadConfig({ ...base, OAUTH_SERVER: 'on', OAUTH_JWKS: JSON.stringify({ keys: [{ kty: 'EC', crv: 'P-256', x: 'x', y: 'y', kid: 'k1' }] }), OAUTH_COOKIE_KEYS: cookies })).toThrow(/ES256 private keys/);
    expect(() => loadConfig({ ...base, OAUTH_SERVER: 'on', OAUTH_JWKS: JSON.stringify({ keys: [{ kty: 'RSA', n: 'n', e: 'e', d: 'd', kid: 'k1' }] }), OAUTH_COOKIE_KEYS: cookies })).toThrow(/ES256 private keys/);
    expect(() => loadConfig({ ...base, OAUTH_SERVER: 'on', OAUTH_JWKS: jwk })).toThrow(/OAUTH_COOKIE_KEYS/);
    expect(() => loadConfig({ ...base, OAUTH_SERVER: 'on', OAUTH_JWKS: jwk, OAUTH_COOKIE_KEYS: 'short' })).toThrow(/OAUTH_COOKIE_KEYS/);
    expect(() => loadConfig({ ...base, OAUTH_SERVER: 'on', OAUTH_JWKS: jwk, OAUTH_COOKIE_KEYS: cookies, PUBLIC_URL: 'http://localhost:8080', APP_URL: 'http://localhost:5173', CORS_ALLOWED_ORIGINS: 'http://localhost:5173' })).toThrow(/own origin/);
    expect(loadConfig({ ...base, OAUTH_SERVER: 'on', OAUTH_JWKS: jwk, OAUTH_COOKIE_KEYS: cookies, PUBLIC_URL: 'http://localhost:8080', APP_URL: 'http://localhost:8080' }).OAUTH_SERVER).toBe('on');
  });

  it('takes the allowed origins as origins only', () => {
    expect(loadConfig({ ...base, MCP_ALLOWED_ORIGINS: 'https://a.example.com, https://b.example.com:8443' }).MCP_ALLOWED_ORIGINS).toBe('https://a.example.com, https://b.example.com:8443');
    for (const bad of ['https://a.example.com/path', 'a.example.com', '*']) expect(() => loadConfig({ ...base, MCP_ALLOWED_ORIGINS: bad }), bad).toThrow(/origins only/);
  });
});
