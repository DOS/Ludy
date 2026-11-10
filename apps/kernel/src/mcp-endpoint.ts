// SPDX-License-Identifier: AGPL-3.0-only
// The MCP endpoint and the authorization server's routes on the HTTP edge (ADR-0051 decision 2, ADR-0032, issue #2975).
//
//   POST /mcp                                    the stateless MCP endpoint (mcp-protocol.ts); GET and DELETE answer 405
//   /.well-known/oauth-protected-resource/mcp    RFC 9728: the resource, the issuer, the one scope
//   /.well-known/oauth-authorization-server      RFC 8414, and /.well-known/openid-configuration: the provider's own metadata
//   /oauth/*                                     the provider: authorize, token, register, revoke, jwks (public by protocol)
//   GET  /oauth/interaction/:uid/details         what the consent page shows (the signed-in user's own request)
//   POST /oauth/interaction/:uid/consent         the person's answer: approve for one org (a grant) or deny
//
// A request to /mcp is refused before anything else unless its Origin is allowed, then unless its bearer token verifies (signature, issuer,
// audience, expiry), then unless the grant behind it is in good standing in the database, then unless the grant is inside its rate and concurrency
// budget. Only then does a query run, and the runtime checks the grant once more in that query's own transaction. The answer is released only after its
// audit row is written; a failure to write it fails the call.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import { sql } from 'kysely';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { MCP_SCOPE_IDS } from '@crove/kernel-contract';
import { DomainError, toDomainError, type Runtime, type UserActor } from '@crove/kernel-runtime';
import { myOrgs } from '@crove/kernel';
import type { AuthUser } from './auth.ts';
import { actorOf } from './auth.ts';
import type { Config } from './config.ts';
import { logEvent } from './log.ts';
import { handleMcp, RPC_INTERNAL, type McpHeaders, type ToolDescriptor } from './mcp-protocol.ts';
import { ACCESS_TOKEN_SECONDS, MCP_SCOPE, type OauthServer } from './oauth-server.ts';
import { RateLimiter } from './rate-limit.ts';

const MAX_MCP_BODY_BYTES = 64 * 1024;
const MAX_CONSENT_BODY_BYTES = 2 * 1024;

export interface McpDeps {
  config: Config;
  runtime: Runtime;
  oauth: OauthServer;
  authenticate: (authorization: string | undefined) => Promise<AuthUser>;
  // The per-address bucket of a request (the edge's own, with its trusted proxy hops).
  clientKey: (c: Context) => string;
  serverVersion: string;
  now?: () => number;
}

interface NodeBindings {
  incoming: IncomingMessage;
  outgoing: ServerResponse;
}

const wellKnownResource = (config: Pick<Config, 'PUBLIC_URL'>): string => `${config.PUBLIC_URL.replace(/\/+$/, '')}/.well-known/oauth-protected-resource/mcp`;

function bearerOf(c: Context): string | null {
  const header = c.req.header('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

const noStore = (c: Context) => c.header('cache-control', 'no-store');

const tooManyRequests = (c: Context, retryAfterSeconds: number) => {
  c.header('retry-after', String(retryAfterSeconds));
  return c.json({ error: 'too_many_requests', error_description: 'Too many requests, try again later' }, 429);
};

// The authorization server's own routes: authorize, token, register, revoke, jwks and the two metadata documents, answered by the provider on the Node
// request and response (its body parser reads the stream itself, so nothing may read the body first). Mounted BEFORE the edge's global middleware:
// the provider has written its answer by the time a handler returns, and a middleware that then touched the response would write it twice. The consent
// page's own calls (/oauth/interaction/...) are not the provider's: they go on to the routes of mountMcp, and the page itself to the SPA.
export function mountOauthProvider(app: Hono<any>, deps: Pick<McpDeps, 'oauth' | 'clientKey' | 'now'> & { registerPerMinute: number; registerGlobalPerMinute: number }): void {
  const callback = deps.oauth.provider.callback();
  const addressLimiter = new RateLimiter({ perMinute: 300, ...(deps.now ? { now: deps.now } : {}) });
  const registerLimiter = new RateLimiter({ perMinute: deps.registerPerMinute, ...(deps.now ? { now: deps.now } : {}) });
  const registerGlobalLimiter = new RateLimiter({ perMinute: deps.registerGlobalPerMinute, ...(deps.now ? { now: deps.now } : {}) });
  const delegate = async (c: Context, rewriteTo?: string) => {
    const { incoming, outgoing } = c.env as unknown as NodeBindings;
    if (rewriteTo) incoming.url = rewriteTo;
    await callback(incoming, outgoing);
    return RESPONSE_ALREADY_SENT;
  };
  app.get('/.well-known/oauth-authorization-server', (c) => delegate(c, '/.well-known/openid-configuration'));
  app.get('/.well-known/openid-configuration', (c) => delegate(c));
  app.all('/oauth/*', async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (path.startsWith('/oauth/interaction/')) return next();
    const bucket = deps.clientKey(c);
    const decision = addressLimiter.take(bucket);
    if (!decision.allowed) return tooManyRequests(c, decision.retryAfterSeconds);
    if (path === '/oauth/register') {
      const mine = registerLimiter.take(bucket);
      if (!mine.allowed) return tooManyRequests(c, mine.retryAfterSeconds);
      const all = registerGlobalLimiter.take('all');
      if (!all.allowed) return tooManyRequests(c, all.retryAfterSeconds);
    }
    return delegate(c);
  });
}

export function mountMcp(app: Hono<any>, deps: McpDeps): void {
  const { config, runtime, oauth } = deps;
  const allowedOrigins = (config.MCP_ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim()).filter((o) => o.length > 0);
  const resourceMetadata = wellKnownResource(config);
  const grantLimiter = new RateLimiter({ perMinute: config.MCP_GRANT_PER_MINUTE, ...(deps.now ? { now: deps.now } : {}) });
  // Refusals audited per grant are bounded too, so a flood of 429s does not become a flood of audit rows.
  const mcpAddressLimiter = new RateLimiter({ perMinute: 300, ...(deps.now ? { now: deps.now } : {}) });
  const refusalAuditLimiter = new RateLimiter({ perMinute: 6, ...(deps.now ? { now: deps.now } : {}) });
  const inFlight = new Map<string, number>();

  const tooMany = tooManyRequests;

  app.get('/.well-known/oauth-protected-resource/mcp', (c) => {
    c.header('cache-control', 'public, max-age=3600');
    return c.json({
      resource: oauth.resource,
      authorization_servers: [oauth.issuer],
      scopes_supported: [MCP_SCOPE],
      bearer_methods_supported: ['header'],
      resource_name: 'Ludy',
    });
  });

  // --- the consent page's two calls: made by the SPA, with the signed-in user's own bearer and the interaction cookie the provider set ---
  const details = async (c: Context) => {
    noStore(c);
    try {
      const user = await signedIn(c);
      const { incoming, outgoing } = c.env as unknown as NodeBindings;
      const interaction = await oauth.provider.interactionDetails(incoming, outgoing).catch(() => null);
      if (!interaction || interaction.uid !== c.req.param('uid')) throw new DomainError('NOT_FOUND', 404, 'Yêu cầu kết nối không còn hiệu lực, hãy bắt đầu lại từ ứng dụng cần kết nối');
      const clientId = String(interaction.params.client_id ?? '');
      const client = await oauth.provider.Client.find(clientId);
      if (!client) throw new DomainError('NOT_FOUND', 404, 'Không tìm thấy ứng dụng cần kết nối');
      const redirect = new URL(String(interaction.params.redirect_uri ?? ''));
      const orgs = (await runtime.forUser(actorOf(user), (db) => myOrgs(db, user.userId))).filter((o) => o.role === 'owner' || o.role === 'admin');
      return c.json({
        client: {
          // What the client declared about itself: shown as self-declared. The redirect host is the one fact the person can check.
          id: client.clientId,
          name: typeof client.clientName === 'string' && client.clientName.trim() !== '' ? client.clientName : client.clientId,
          logoUri: typeof client.logoUri === 'string' && client.logoUri.startsWith('https://') ? client.logoUri : null,
          redirectHost: redirect.host,
          selfDeclared: true,
        },
        scopes: [MCP_SCOPE],
        expiresInDays: 89,
        orgs: orgs.map((o) => ({ orgId: o.orgId, slug: o.slug, name: o.name, role: o.role })),
      });
    } catch (error) {
      return problem(c, error);
    }
  };
  app.get('/oauth/interaction/:uid/details', details);

  const zConsent = z.strictObject({ decision: z.enum(['approve', 'deny']), orgId: z.uuid().optional() });
  app.post('/oauth/interaction/:uid/consent', bodyLimit({ maxSize: MAX_CONSENT_BODY_BYTES }), async (c) => {
    noStore(c);
    try {
      const user = await signedIn(c);
      const parsed = zConsent.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) throw new DomainError('INVALID', 422, 'Yêu cầu không hợp lệ');
      const { incoming, outgoing } = c.env as unknown as NodeBindings;
      const interaction = await oauth.provider.interactionDetails(incoming, outgoing).catch(() => null);
      if (!interaction || interaction.uid !== c.req.param('uid')) throw new DomainError('NOT_FOUND', 404, 'Yêu cầu kết nối không còn hiệu lực, hãy bắt đầu lại từ ứng dụng cần kết nối');
      if (parsed.data.decision === 'deny') {
        const redirectTo = await oauth.provider.interactionResult(incoming, outgoing, { error: 'access_denied', error_description: 'The user denied the request' });
        return c.json({ redirectTo });
      }
      if (!parsed.data.orgId) throw new DomainError('INVALID', 422, 'Hãy chọn tổ chức');
      // Only an owner or admin of the org may consent for it; the definer checks again, in the org's own transaction.
      const orgs = await runtime.forUser(actorOf(user), (db) => myOrgs(db, user.userId));
      const org = orgs.find((o) => o.orgId === parsed.data.orgId);
      if (!org || (org.role !== 'owner' && org.role !== 'admin')) throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu hoặc quản trị viên mới cấp được quyền kết nối');
      const clientId = String(interaction.params.client_id ?? '');
      const client = await oauth.provider.Client.find(clientId);
      if (!client) throw new DomainError('NOT_FOUND', 404, 'Không tìm thấy ứng dụng cần kết nối');
      // The authorization grant first (the provider's own record), then ours: if ours fails the provider's is destroyed, so nothing is left half made.
      const grant = new oauth.provider.Grant({ accountId: user.userId, clientId });
      grant.addResourceScope(oauth.resource, MCP_SCOPE);
      const oauthGrantId = await grant.save();
      try {
        await runtime.execute(
          'kernel.mcp.grant.approve',
          {
            clientId,
            clientName: typeof client.clientName === 'string' && client.clientName.trim() !== '' ? client.clientName.trim().slice(0, 120) : clientId.slice(0, 120),
            clientHost: new URL(String(interaction.params.redirect_uri ?? '')).host,
            scopes: [...MCP_SCOPE_IDS],
            oauthGrantId,
          },
          { actor: actorOf(user), orgId: parsed.data.orgId },
        );
      } catch (error) {
        await grant.destroy().catch(() => undefined);
        throw error;
      }
      const redirectTo = await oauth.provider.interactionResult(incoming, outgoing, { login: { accountId: user.userId, remember: false }, consent: { grantId: oauthGrantId } });
      return c.json({ redirectTo });
    } catch (error) {
      return problem(c, error);
    }
  });

  async function signedIn(c: Context): Promise<AuthUser> {
    const user = await deps.authenticate(c.req.header('authorization'));
    // An extension token never consents for anything.
    if (user.extension) throw new DomainError('FORBIDDEN', 403, 'Mã của tiện ích Ludy không được dùng cho việc này', { rule: 'extension_scope' });
    return user;
  }

  // --- the MCP endpoint ---
  const challenge = (c: Context, error: 'invalid_request' | 'invalid_token' | null) => {
    const parts = [`resource_metadata="${resourceMetadata}"`, `scope="${MCP_SCOPE}"`];
    if (error) parts.push(`error="${error}"`);
    c.header('www-authenticate', `Bearer ${parts.join(', ')}`);
    return c.json({ error: error ?? 'unauthorized', error_description: 'A valid access token is required' }, 401);
  };

  app.on(['GET', 'DELETE'], '/mcp', (c) => {
    c.header('allow', 'POST');
    return c.json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed: this endpoint answers POST only' } }, 405);
  });

  app.post('/mcp', bodyLimit({ maxSize: MAX_MCP_BODY_BYTES, onError: (c) => c.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request body too large' } }, 413) }), async (c) => {
    noStore(c);
    // The specification's own rule against DNS rebinding: an Origin that is present and not allowed is a 403.
    const origin = c.req.header('origin');
    if (origin !== undefined && !allowedOrigins.includes(origin)) {
      return c.json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Origin not allowed' } }, 403);
    }
    const address = mcpAddressLimiter.take(deps.clientKey(c));
    if (!address.allowed) return tooMany(c, address.retryAfterSeconds);
    const token = bearerOf(c);
    if (token === null) return challenge(c, null);
    const claims = await oauth.verifyAccessToken(token);
    if (!claims) return challenge(c, 'invalid_token');
    // The grant's standing, in the database, before anything is spent on the request: revoked, expired, stopped, the person no longer an owner or admin.
    let grant: { orgId: string; userId: string; scopes: string[]; clientName: string } | null = null;
    try {
      const { rows } = await runtime.orgless((db) =>
        sql<{ org_id: string; user_id: string; scopes: string[]; client_name: string }>`
          SELECT org_id, user_id, scopes, client_name FROM crove_kernel.mcp_grant_verify(${claims.grantId}::uuid, ${claims.clientId}::text)`.execute(db),
      );
      const row = rows[0];
      if (row && row.org_id === claims.orgId && row.user_id === claims.userId && claims.scopes.every((s) => row.scopes.includes(s))) {
        grant = { orgId: row.org_id, userId: row.user_id, scopes: claims.scopes, clientName: row.client_name };
      }
    } catch (error) {
      return problem(c, error);
    }
    if (!grant) return challenge(c, 'invalid_token');

    const writeCallAudit = (tool: string, requestId: string, outcome: 'ok' | 'refused' | 'rate_limited' | 'failed') =>
      runtime.orgless((db) =>
        sql`SELECT crove_kernel.mcp_call_audit(${grant.orgId}::uuid, ${claims.grantId}::uuid, ${tool}::text, ${requestId}::text, ${outcome}::text)`.execute(db),
      );
    const requestId = randomUUID();
    // The grant's own budget and concurrency, checked before any query runs.
    const rate = grantLimiter.take(claims.grantId);
    const running = inFlight.get(claims.grantId) ?? 0;
    if (!rate.allowed || running >= config.MCP_GRANT_CONCURRENCY) {
      if (refusalAuditLimiter.take(claims.grantId).allowed) await writeCallAudit('-', requestId, 'rate_limited').catch(() => undefined);
      return tooMany(c, rate.allowed ? 1 : rate.retryAfterSeconds);
    }
    inFlight.set(claims.grantId, running + 1);
    try {
      const headers: McpHeaders = { protocolVersion: c.req.header('mcp-protocol-version') ?? null, method: c.req.header('mcp-method') ?? null, name: c.req.header('mcp-name') ?? null };
      const body = await c.req.json().catch(() => undefined);
      if (body === undefined) return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
      const actor: UserActor = {
        type: 'user',
        userId: grant.userId,
        aal: 'aal1',
        mcp: { grantId: claims.grantId, clientId: claims.clientId, clientName: grant.clientName, scopes: grant.scopes },
      };
      const tools = toolsFor(runtime, actor, grant.orgId);
      const reply = await handleMcp({
        body,
        headers,
        tools,
        serverVersion: deps.serverVersion,
        callTool: async (tool) => {
          let value: Record<string, unknown>;
          try {
            value = await tool.read();
          } catch (error) {
            await writeCallAudit(tool.name, requestId, error instanceof DomainError ? 'refused' : 'failed').catch(() => undefined);
            throw error;
          }
          // The answer leaves only after its audit row is written.
          await writeCallAudit(tool.name, requestId, 'ok');
          return value;
        },
        describeError: (error) => {
          if (error instanceof DomainError && error.status === 401) return { code: RPC_INTERNAL, message: 'The grant is no longer valid' };
          if (error instanceof DomainError && error.status < 500) return { code: RPC_INTERNAL, message: error.status === 403 ? 'Not allowed for this connection' : 'The request could not be completed' };
          logEvent('error', 'mcp tool failed', { grantId: claims.grantId, requestId, error: toDomainError(error).code });
          return { code: RPC_INTERNAL, message: 'Internal error' };
        },
      });
      if (reply.kind === 'accepted') return c.body(null, 202);
      return c.json(reply.body as object, reply.status as 200 | 400 | 404);
    } catch (error) {
      logEvent('error', 'mcp request failed', { grantId: claims.grantId, requestId, error: toDomainError(error).code });
      return c.json({ jsonrpc: '2.0', id: null, error: { code: RPC_INTERNAL, message: 'Internal error' } }, 500);
    } finally {
      const left = (inFlight.get(claims.grantId) ?? 1) - 1;
      if (left <= 0) inFlight.delete(claims.grantId);
      else inFlight.set(claims.grantId, left);
    }
  });

  function problem(c: Context, error: unknown) {
    const domain = toDomainError(error);
    return c.json({ code: domain.code, message: domain.message }, domain.status as 400 | 401 | 403 | 404 | 422 | 429 | 500 | 503);
  }
  void ACCESS_TOKEN_SECONDS;
}

// The tools of this step: one, `ludy_about`, over the kernel query kernel.mcp.about. A tool is a descriptor over one query; the endpoint never
// builds SQL and runs nothing that is not on this list.
function toolsFor(runtime: Runtime, actor: UserActor, orgId: string): ToolDescriptor[] {
  return [
    {
      name: 'ludy_about',
      title: 'About this connection',
      description: 'Tells which Ludy organization this connection is for, the name this client gave itself, and what the connection may do (read only). It reads no business data. Call it to check the connection works.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: {
        type: 'object',
        properties: { orgName: { type: 'string' }, clientName: { type: 'string' }, scopes: { type: 'array', items: { type: 'string' } } },
        required: ['orgName', 'clientName', 'scopes'],
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      read: async () => (await runtime.query<Record<string, unknown>>('kernel.mcp.about', {}, { actor, orgId })),
    },
  ];
}
