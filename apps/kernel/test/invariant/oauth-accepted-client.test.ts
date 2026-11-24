// SPDX-License-Identifier: AGPL-3.0-only
// Invariant suite (Decision 7): the one OAuth client a deployment accepts (issue #4704, ADR-0028 amendment 2026-11-24). The
// kernel refuses every Supabase Auth access token issued to an OAuth client (issue #272). With AUTH_OAUTH_CLIENT_ID set, a
// token whose `client_id` is exactly that client's UUID is the deployment's own sign-in and passes; a token of any other
// client, a `client_id` that is not that string, and a token that shows the OAuth server's amr without naming the
// client stay refused. Unset, nothing changes: every client's token is refused. Both the token verifier and the
// self-host /auth/v1 proxy are checked here with no database; the session check's side is in
// oauth-accepted-client.db.test.ts. Keep this file self-contained: import the code under test, never helpers from
// outside test/invariant/.
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT } from 'jose';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BlobStore, Runtime } from '@ludy/kernel-runtime';
import { bearerIssuedToOAuthClient, createTokenVerifier } from '../../src/auth.ts';
import { loadConfig } from '../../src/config.ts';
import { createHttpApp } from '../../src/http.ts';

const SECRET = 'test-only-jwt-secret-for-accepted-client-0123';
const ISSUER = 'crove-auth';
const OURS = randomUUID();
const OTHER = randomUUID();
const now = Math.floor(Date.now() / 1000);
const OAUTH_AMR = [{ method: 'oauth_provider/authorization_code', timestamp: now }];
const BROWSER_AMR = [{ method: 'password', timestamp: now }];

const BASE_ENV = { DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, WEB_DIST: '/nonexistent' };

function claims(extra: Record<string, unknown>) {
  return {
    role: 'authenticated',
    email: 'person@accepted.test',
    session_id: randomUUID(),
    aal: 'aal1',
    amr: BROWSER_AMR,
    is_anonymous: false,
    user_metadata: {},
    ...extra,
  };
}

async function signed(extra: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims(extra))
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(randomUUID())
    .setIssuer(ISSUER)
    .setAudience('authenticated')
    .setIssuedAt(now - 5)
    .setExpirationTime(now + 900)
    .sign(new TextEncoder().encode(SECRET));
}

// What each shape of token is, for a deployment that accepts OURS: the answer of the verifier and of the proxy.
const SHAPES: Array<{ label: string; claims: Record<string, unknown>; accepted: boolean }> = [
  { label: 'a browser token', claims: {}, accepted: true },
  { label: "the accepted client's token as the OAuth server issues it", claims: { client_id: OURS, scope: 'openid email profile', amr: OAUTH_AMR }, accepted: true },
  { label: "the accepted client's id in upper case", claims: { client_id: OURS.toUpperCase(), amr: OAUTH_AMR }, accepted: true },
  { label: "the accepted client's id with a browser amr (a hook rewrote it)", claims: { client_id: OURS }, accepted: true },
  { label: "another client's token", claims: { client_id: OTHER, scope: 'openid email profile', amr: OAUTH_AMR }, accepted: false },
  { label: "another client's id with a browser amr", claims: { client_id: OTHER }, accepted: false },
  { label: 'the accepted id with something appended', claims: { client_id: `${OURS}x` }, accepted: false },
  { label: 'the accepted id with a space', claims: { client_id: ` ${OURS}` }, accepted: false },
  { label: 'an empty client_id', claims: { client_id: '' }, accepted: false },
  { label: 'a null client_id', claims: { client_id: null }, accepted: false },
  { label: 'a client_id that is a list holding the accepted id', claims: { client_id: [OURS] }, accepted: false },
  { label: 'a client_id that is an object', claims: { client_id: { id: OURS } }, accepted: false },
  { label: 'the OAuth amr without a client_id (an MFA verification on the OAuth session)', claims: { aal: 'aal2', amr: [{ method: 'totp', timestamp: now }, ...OAUTH_AMR] }, accepted: false },
  { label: 'the OAuth amr as a bare string without a client_id', claims: { amr: ['oauth_provider/authorization_code'] }, accepted: false },
];

describe('the accepted OAuth client: token verifier (issue #4704)', () => {
  const accepting = createTokenVerifier(loadConfig({ ...BASE_ENV, AUTH_OAUTH_CLIENT_ID: OURS }));
  const unset = createTokenVerifier(loadConfig(BASE_ENV));

  for (const shape of SHAPES) {
    it(`${shape.accepted ? 'accepts' : 'refuses'} ${shape.label} when AUTH_OAUTH_CLIENT_ID is set`, async () => {
      const token = await signed(shape.claims);
      if (shape.accepted) await expect(accepting(token)).resolves.toMatchObject({ email: 'person@accepted.test' });
      else await expect(accepting(token)).rejects.toMatchObject({ code: 'OAUTH_CLIENT_TOKEN_REFUSED', status: 401 });
    });
  }

  for (const shape of SHAPES.filter((s) => s.claims.client_id !== undefined || s.accepted === false)) {
    it(`refuses ${shape.label} when AUTH_OAUTH_CLIENT_ID is unset, as before`, async () => {
      await expect(unset(await signed(shape.claims))).rejects.toMatchObject({ code: 'OAUTH_CLIENT_TOKEN_REFUSED', status: 401 });
    });
  }

  it('still verifies the signature, issuer and audience first: a forged token with the accepted client_id is UNAUTHENTICATED', async () => {
    const forged = await new SignJWT(claims({ client_id: OURS, amr: OAUTH_AMR }))
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(randomUUID())
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setExpirationTime(now + 900)
      .sign(new TextEncoder().encode('another-secret-another-secret-another-secret'));
    await expect(accepting(forged)).rejects.toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
  });

  it('takes the client id as a UUID in any letter case, and nothing else', () => {
    expect(loadConfig({ ...BASE_ENV, AUTH_OAUTH_CLIENT_ID: ` ${OURS.toUpperCase()} ` }).AUTH_OAUTH_CLIENT_ID).toBe(OURS);
    for (const bad of ['not-a-uuid', `${OURS}0`, `${OURS},${OTHER}`, '*', 'ludy']) {
      expect(() => loadConfig({ ...BASE_ENV, AUTH_OAUTH_CLIENT_ID: bad }), bad).toThrow(/AUTH_OAUTH_CLIENT_ID/);
    }
    // Empty counts as unset (compose passes an unset line through empty): no client is accepted.
    expect(loadConfig({ ...BASE_ENV, AUTH_OAUTH_CLIENT_ID: ' ' }).AUTH_OAUTH_CLIENT_ID).toBeUndefined();
  });
});

describe('the accepted OAuth client: /auth/v1 proxy (issue #4704)', () => {
  let upstream: Server;
  let seen: { path: string; headers: IncomingHttpHeaders } | null = null;
  let accepting: ReturnType<typeof createHttpApp>;
  let unset: ReturnType<typeof createHttpApp>;

  // The routes Supabase Auth authenticates with the user's access token, and the token endpoint.
  const routes: Array<[string, string, string | undefined]> = [
    ['GET', '/user', undefined],
    ['PUT', '/user', '{"email":"attacker@example.com"}'],
    ['POST', '/logout?scope=global', undefined],
    ['GET', '/reauthenticate', undefined],
    ['POST', '/factors', '{"factor_type":"totp"}'],
    ['POST', '/token?grant_type=password', '{}'],
  ];
  // The compact form the proxy reads: it decodes the payload and never verifies it.
  const jws = (payload: unknown) => {
    const part = (text: string) => Buffer.from(text).toString('base64url');
    return `${part('{"alg":"HS256","typ":"JWT"}')}.${part(JSON.stringify(payload))}.${part('signature')}`;
  };

  function appFor(extra: Record<string, string>, port: number) {
    const config = loadConfig({ ...BASE_ENV, AUTH_UPSTREAM_URL: `http://127.0.0.1:${port}`, ...extra });
    return createHttpApp({
      config,
      runtime: { installed: () => true, modules: () => ['kernel'] } as unknown as Runtime,
      store: {} as BlobStore,
      authenticate: async () => {
        throw new Error('not used');
      },
      pool: {} as pg.Pool,
      aiEnabled: false,
      emailLimiter: { reserve: async () => ({ allowed: true, reservation: 'slot' }), release: async () => {} },
    });
  }

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      seen = { path: req.url ?? '', headers: req.headers };
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const { port } = upstream.address() as AddressInfo;
    accepting = appFor({ AUTH_OAUTH_CLIENT_ID: OURS }, port);
    unset = appFor({}, port);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  const send = (app: ReturnType<typeof createHttpApp>, method: string, path: string, authorization: string, body?: string) =>
    app.request(`/auth/v1${path}`, { method, headers: { authorization, 'content-type': 'application/json' }, body: body ?? null });
  const observed = () => seen;

  for (const shape of SHAPES) {
    it(`${shape.accepted ? 'forwards' : 'refuses'} ${shape.label} on every forwarded route when AUTH_OAUTH_CLIENT_ID is set`, async () => {
      const authorization = `Bearer ${jws(claims(shape.claims))}`;
      expect(bearerIssuedToOAuthClient(authorization, OURS)).toBe(!shape.accepted);
      for (const [method, path, body] of routes) {
        seen = null;
        const response = await send(accepting, method, path, authorization, body);
        if (shape.accepted) {
          expect(response.status, `${method} ${path}`).toBe(200);
          expect(observed()?.headers.authorization).toBe(authorization);
        } else {
          expect(response.status, `${method} ${path}`).toBe(401);
          expect(await response.json()).toEqual({ code: 401, error_code: 'OAUTH_CLIENT_TOKEN_REFUSED', msg: expect.any(String) });
          expect(observed(), `${method} ${path} reached upstream`).toBeNull();
        }
      }
    });
  }

  it('refuses the accepted client\'s token on every forwarded route when AUTH_OAUTH_CLIENT_ID is unset, as before', async () => {
    const authorization = `Bearer ${jws(claims({ client_id: OURS, scope: 'openid email profile', amr: OAUTH_AMR }))}`;
    expect(bearerIssuedToOAuthClient(authorization)).toBe(true);
    for (const [method, path, body] of routes) {
      seen = null;
      const response = await send(unset, method, path, authorization, body);
      expect(response.status, `${method} ${path}`).toBe(401);
      expect(observed()).toBeNull();
    }
  });
});
