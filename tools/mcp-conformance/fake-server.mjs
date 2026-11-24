// SPDX-License-Identifier: AGPL-3.0-only
// A fake MCP server with an OAuth 2.1 authorization server, for the test of the conformance tool (issue #4592): it follows the rules the tool
// checks, and `flaws` break one each, so the test can show that the tool names the check that fails. Not a Ludy: it keeps no data and signs with
// a key made at start. Plain Node, no dependencies.
//
// Flaws: 'no-resource-metadata', 'wrong-resource', 'no-challenge-pointer', 'no-pkce', 'any-resource', 'wrong-audience', 'readonly-missing',
// 'read-destructive', 'proposal-readonly', 'proposal-executes', 'no-proposal-tool', 'foreign-issuer', 'foreign-endpoint', 'foreign-redirect'.
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createServer } from 'node:http';

export const FAKE_OWNER_TOKEN = 'fake-owner-token';

/** @param {{ flaws?: string[] }} [options] */
export async function startFakeServer(options = {}) {
  const flaws = new Set(options.flaws ?? []);
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'fake-key', alg: 'ES256', use: 'sig' };
  /** @type {Map<string, { redirectUri: string, state: string, challenge: string | null, resource: string | null, clientId: string, scope: string, code?: string }>} */
  const interactions = new Map();
  /** @type {Map<string, { challenge: string | null, resource: string | null, redirectUri: string, clientId: string, scope: string }>} */
  const codes = new Map();
  const tokens = new Set();
  /** @type {string[]} */
  const executed = [];
  let base = '';

  const json = (/** @type {import('node:http').ServerResponse} */ res, /** @type {number} */ status, /** @type {unknown} */ body, /** @type {Record<string, string>} */ headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const redirect = (/** @type {import('node:http').ServerResponse} */ res, /** @type {string} */ location, /** @type {Record<string, string>} */ headers = {}) => {
    res.writeHead(303, { location, ...headers });
    res.end();
  };

  const annotations = (/** @type {Record<string, unknown>} */ a) => a;
  const tools = () => {
    const list = [
      { name: 'ludy_about', title: 'About', description: 'The org.', inputSchema: { type: 'object', properties: {} }, ...(flaws.has('readonly-missing') ? {} : { annotations: annotations({ readOnlyHint: true, destructiveHint: flaws.has('read-destructive'), idempotentHint: true, openWorldHint: false }) }) },
      { name: 'ludy_conversation_note', title: 'Note', description: 'Adds a note (R1).', inputSchema: { type: 'object', properties: { conversationId: { type: 'string', format: 'uuid' } }, required: ['conversationId'] }, annotations: annotations({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }) },
    ];
    if (!flaws.has('no-proposal-tool')) {
      list.push({
        name: 'ludy_conversation_reply',
        title: 'Propose a reply',
        description: 'Proposes a reply to a customer.',
        inputSchema: { type: 'object', properties: { conversationId: { type: 'string', format: 'uuid' }, body: { type: 'string', minLength: 1 } }, required: ['conversationId', 'body'] },
        outputSchema: { type: 'object', properties: { proposalId: { type: 'string' }, status: { enum: ['pending'] } }, required: ['proposalId', 'status'] },
        annotations: annotations({ readOnlyHint: flaws.has('proposal-readonly'), destructiveHint: false, idempotentHint: false, openWorldHint: false }),
      });
    }
    return list;
  };

  const server = createServer((req, res) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', base || 'http://localhost');
      const body = Buffer.concat(chunks).toString('utf8');
      const path = url.pathname;
      const bearer = /^Bearer (.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
      const resource = `${base}/mcp`;

      if (path === '/.well-known/oauth-protected-resource/mcp') {
        if (flaws.has('no-resource-metadata')) return json(res, 404, { error: 'not_found' });
        return json(res, 200, { resource: flaws.has('wrong-resource') ? `${base}/elsewhere` : resource, authorization_servers: [flaws.has('foreign-issuer') ? 'http://127.0.0.1:1' : base], scopes_supported: ['ludy.read', 'ludy.engage.write'], bearer_methods_supported: ['header'], resource_name: 'Fake' });
      }
      if (path === '/.well-known/oauth-authorization-server') {
        return json(res, 200, {
          issuer: base,
          authorization_endpoint: `${base}/oauth/authorize`,
          token_endpoint: flaws.has('foreign-endpoint') ? 'http://127.0.0.1:1/oauth/token' : `${base}/oauth/token`,
          registration_endpoint: `${base}/oauth/register`,
          jwks_uri: `${base}/oauth/jwks`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
          scopes_supported: ['ludy.read', 'ludy.engage.write'],
        });
      }
      if (path === '/oauth/jwks') return json(res, 200, { keys: [jwk] });
      if (path === '/oauth/register' && req.method === 'POST') return json(res, 201, { client_id: `client-${randomUUID()}` });

      if (path === '/oauth/authorize') {
        const q = url.searchParams;
        const fail = (/** @type {string} */ error) => redirect(res, `${q.get('redirect_uri')}?error=${error}&state=${q.get('state') ?? ''}`);
        if (!q.get('code_challenge') && !flaws.has('no-pkce')) return fail('invalid_request');
        if (q.get('resource') !== resource && !flaws.has('any-resource')) return fail('invalid_target');
        const uid = randomUUID();
        interactions.set(uid, { redirectUri: q.get('redirect_uri') ?? '', state: q.get('state') ?? '', challenge: q.get('code_challenge'), resource: q.get('resource'), clientId: q.get('client_id') ?? '', scope: q.get('scope') ?? '' });
        if (flaws.has('foreign-redirect')) return redirect(res, 'http://127.0.0.1:1/elsewhere');
        return redirect(res, `/oauth/interaction/${uid}`, { 'set-cookie': `_interaction=${uid}; Path=/oauth/interaction/${uid}; HttpOnly` });
      }
      const interaction = /^\/oauth\/interaction\/([^/]+)\/(details|consent)$/.exec(path);
      if (interaction) {
        const found = interactions.get(interaction[1] ?? '');
        if (bearer !== FAKE_OWNER_TOKEN) return json(res, 401, { error: 'unauthorized' });
        if (!found || !String(req.headers.cookie ?? '').includes(`_interaction=${interaction[1]}`)) return json(res, 404, { error: 'interaction_gone' });
        if (interaction[2] === 'details') return json(res, 200, { orgs: [{ orgId: randomUUID(), slug: 'fake-org', name: 'Fake', role: 'owner', memberGrants: false }] });
        return json(res, 200, { redirectTo: `${base}/oauth/authorize/${interaction[1]}` });
      }
      const resume = /^\/oauth\/authorize\/([^/]+)$/.exec(path);
      if (resume) {
        const found = interactions.get(resume[1] ?? '');
        if (!found) return json(res, 404, { error: 'interaction_gone' });
        const code = randomUUID();
        codes.set(code, { challenge: found.challenge, resource: found.resource, redirectUri: found.redirectUri, clientId: found.clientId, scope: found.scope });
        return redirect(res, `${found.redirectUri}?code=${code}&state=${found.state}&iss=${encodeURIComponent(base)}`);
      }
      if (path === '/oauth/token' && req.method === 'POST') {
        const form = new URLSearchParams(body);
        const grant = codes.get(form.get('code') ?? '');
        if (!grant) return json(res, 400, { error: 'invalid_grant' });
        if (grant.challenge && createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== grant.challenge) return json(res, 400, { error: 'invalid_grant' });
        const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'at+jwt', kid: 'fake-key' })).toString('base64url');
        const payload = Buffer.from(JSON.stringify({ iss: base, aud: flaws.has('wrong-audience') ? `${base}/elsewhere` : resource, exp: Math.floor(Date.now() / 1000) + 600, client_id: grant.clientId, scope: grant.scope, sub: 'fake-user' })).toString('base64url');
        const signature = sign('sha256', Buffer.from(`${header}.${payload}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
        const access = `${header}.${payload}.${signature}`;
        tokens.add(access);
        return json(res, 200, { access_token: access, token_type: 'Bearer', expires_in: 600, refresh_token: randomUUID(), scope: grant.scope });
      }

      if (path === '/mcp' && req.method === 'POST') {
        if (!bearer || !tokens.has(bearer)) {
          const pointer = flaws.has('no-challenge-pointer') ? '' : `, resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`;
          return json(res, 401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer scope="ludy.read"${pointer}` });
        }
        const call = JSON.parse(body || '{}');
        if (call.method === 'initialize') return json(res, 200, { jsonrpc: '2.0', id: call.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
        if (call.method === 'tools/list') return json(res, 200, { jsonrpc: '2.0', id: call.id, result: { tools: tools() } });
        if (call.method === 'tools/call') {
          if (call.params?.name === 'ludy_conversation_reply') {
            if (flaws.has('proposal-executes')) {
              executed.push(call.params.name);
              return json(res, 200, { jsonrpc: '2.0', id: call.id, result: { content: [{ type: 'text', text: '{}' }], structuredContent: { sent: true, messageId: randomUUID() }, isError: false } });
            }
            const out = { proposalId: randomUUID(), status: 'pending' };
            return json(res, 200, { jsonrpc: '2.0', id: call.id, result: { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out, isError: false } });
          }
          return json(res, 200, { jsonrpc: '2.0', id: call.id, error: { code: -32602, message: 'Unknown tool' } });
        }
        return json(res, 200, { jsonrpc: '2.0', id: call.id ?? null, error: { code: -32601, message: 'Method not found' } });
      }
      return json(res, 404, { error: 'not_found' });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  base = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
  return { url: base, executed, close: () => new Promise((resolve) => server.close(() => resolve(undefined))) };
}
