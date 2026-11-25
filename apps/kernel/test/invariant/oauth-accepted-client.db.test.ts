// SPDX-License-Identifier: AGPL-3.0-only
// Invariant suite (Decision 7): the one OAuth client a deployment accepts, in the session check modes that read the
// database (issue #4704, ADR-0028 amendment 2026-11-24; the claim side is in oauth-accepted-client.test.ts). With
// AUTH_OAUTH_CLIENT_ID set:
// - jwt (Ludy Cloud, a remote Supabase Auth): the accepted client's token passes, every other client's and an amr-only
//   token stay refused with 401 OAUTH_CLIENT_TOKEN_REFUSED, before any database work.
// - db (self-host, the bundled Supabase Auth's tables): the same, and a session Supabase Auth bound to the accepted
//   client passes the session check while a session bound to any other client is still refused, whatever claims its
//   token carries (a hook may drop them). The MFA rule still applies to the accepted client's session.
// - unset: the accepted client's token and session are refused as before.
// Through the HTTP API on a real PostgreSQL 17, with Supabase Auth's tables mirrored with the columns the check reads.
// Keep this file self-contained: import package code under test, never helpers from outside test/invariant/. Set
// CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@ludy/db';
import { applyAuthGrants, migrate } from '@ludy/db/migrate';
import { kernelCommands, kernelQueries } from '@ludy/kernel';
import { Runtime, type BlobStore } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { createAuthenticator } from '../../src/auth.ts';
import { loadConfig } from '../../src/config.ts';
import { createHttpApp } from '../../src/http.ts';
import { createSessionStatusSource } from '../../src/sessions.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { createDbClient, createDbPool, resolveDbIdentifiers, setActiveRolePasswords, type DbIdentifiers } from './fixtures/db-identifiers.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-accepted-client-db-01';
const ISSUER = 'crove-auth';

const suite = ADMIN ? describe : describe.skip;

type Shape = 'ours' | 'other' | 'ours-amr-only' | 'browser-claims';
type App = 'db' | 'jwt' | 'db-unset';

suite('the accepted OAuth client on PostgreSQL (issue #4704, jwt and db session checks)', () => {
  const dbName = `crove_test_oauth_accepted_client_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const OURS = randomUUID();
  const OTHER = randomUUID();
  let adminUrl = '';
  let dbIds: DbIdentifiers | undefined;
  let pool: pg.Pool;
  let db: Db;
  const apps = new Map<App, ReturnType<typeof createHttpApp>>();

  interface Person {
    subject: string;
    email: string;
    session: string;
    // Sessions Supabase Auth's OAuth server bound to our client and to another one.
    oursSession: string;
    otherSession: string;
  }

  async function sql(text: string, params: unknown[] = []) {
    const client = createDbClient({ connectionString: adminUrl }, dbIds);
    await client.connect();
    try {
      return await client.query(text, params);
    } finally {
      await client.end();
    }
  }

  // ours: the accepted client's token as the OAuth server issues it. other: another client's. ours-amr-only: the
  // accepted client's session after an MFA verification, which reissues the token without client_id. browser-claims: no
  // client claim at all (a Custom Access Token hook dropped them), so only the session names the client.
  async function tokenFor(p: Pick<Person, 'subject' | 'email'>, shape: Shape, sessionId: string, aal: 'aal1' | 'aal2' = 'aal1') {
    const now = Math.floor(Date.now() / 1000);
    const oauthAmr = [{ method: 'oauth_provider/authorization_code', timestamp: now - 30 }];
    const claims: Record<string, unknown> = {
      role: 'authenticated',
      email: p.email,
      phone: '',
      session_id: sessionId,
      aal,
      amr: shape === 'browser-claims' ? [{ method: 'password', timestamp: now - 60 }] : aal === 'aal2' ? [{ method: 'totp', timestamp: now - 10 }, ...oauthAmr] : oauthAmr,
      is_anonymous: false,
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: {},
    };
    if (shape === 'ours') claims.client_id = OURS;
    if (shape === 'other') claims.client_id = OTHER;
    if (shape !== 'browser-claims') claims.scope = 'openid email profile';
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(p.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt(now - 5)
      .setExpirationTime(now + 900)
      .sign(new TextEncoder().encode(SECRET));
  }

  async function rpc(which: App, path: string, token: string, input?: unknown, org: string | null = null) {
    const app = apps.get(which) as ReturnType<typeof createHttpApp>;
    const response = await app.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(org ? { 'x-ludy-org': org } : {}) },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json().catch(() => null)) as ({ json?: Record<string, unknown> } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as Record<string, any> | null };
  }

  // What Supabase Auth keeps for a person (db mode reads it): the user, a plain browser session, and a session the
  // OAuth server bound to each client the person approved.
  async function authRows(p: Person) {
    await sql('INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now())', [p.subject, p.email]);
    await sql('INSERT INTO auth.sessions (id, user_id) VALUES ($1, $2)', [p.session, p.subject]);
    for (const [id, client] of [[p.oursSession, OURS], [p.otherSession, OTHER]] as const) {
      await sql(`INSERT INTO auth.sessions (id, user_id, oauth_client_id, scopes) VALUES ($1, $2, $3, 'openid email profile')`, [id, p.subject, client]);
    }
  }

  function person(tag: string): Person {
    const subject = randomUUID();
    return { subject, email: `${tag}-${subject.slice(0, 8)}@accepted.test`, session: randomUUID(), oursSession: randomUUID(), otherSession: randomUUID() };
  }

  const accountRows = (subject: string) => sql('SELECT 1 FROM crove_kernel.user_account WHERE subject = $1', [subject]).then((r) => r.rowCount);
  const sessionRows = (sessionId: string) =>
    sql('SELECT status FROM crove_kernel.auth_session WHERE session_id = $1', [sessionId]).then((r) => r.rows as Array<{ status: string }>);
  const refused = { status: 401, body: { code: 'OAUTH_CLIENT_TOKEN_REFUSED' } };

  beforeAll(async () => {
    const base = new URL(ADMIN as string);
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    dbIds = await resolveDbIdentifiers(adminUrl);
    await setActiveRolePasswords(adminUrl, { crove_app: 'test-app-pw' }, dbIds);
    await sql('CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION supabase_auth_admin');
    const client = createDbClient({ connectionString: adminUrl }, dbIds);
    await client.connect();
    try {
      await client.query('SET ROLE supabase_auth_admin');
      await client.query(`
        CREATE TABLE auth.users (
          id uuid PRIMARY KEY, email text, encrypted_password text, email_confirmed_at timestamptz, banned_until timestamptz,
          deleted_at timestamptz, is_anonymous boolean NOT NULL DEFAULT false);
        CREATE TABLE auth.sessions (
          id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
          created_at timestamptz NOT NULL DEFAULT now(), not_after timestamptz, aal text, oauth_client_id uuid, scopes text);
        CREATE TYPE auth.factor_type AS ENUM ('totp', 'webauthn', 'phone', 'recovery_code');
        CREATE TYPE auth.factor_status AS ENUM ('unverified', 'verified');
        CREATE TABLE auth.mfa_factors (
          id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE, friendly_name text,
          factor_type auth.factor_type NOT NULL, status auth.factor_status NOT NULL, created_at timestamptz NOT NULL,
          updated_at timestamptz NOT NULL, secret text, phone text, last_challenged_at timestamptz UNIQUE,
          web_authn_credential jsonb, web_authn_aaguid uuid, last_webauthn_challenge_data jsonb);
        ALTER TABLE auth.users ENABLE ROW LEVEL SECURITY;
        ALTER TABLE auth.sessions ENABLE ROW LEVEL SECURITY;
        ALTER TABLE auth.mfa_factors ENABLE ROW LEVEL SECURITY;`);
    } finally {
      await client.end();
    }
    await applyAuthGrants({ adminUrl, timeoutMs: 5000, pollMs: 100 });
    const appUrl = new URL(adminUrl);
    appUrl.username = dbIds ? dbIds.roleName('crove_app') : 'crove_app';
    appUrl.password = 'test-app-pw';
    pool = createDbPool({ connectionString: appUrl.toString(), max: 6 }, dbIds);
    db = createDb(pool);
    const common = { DATABASE_URL: appUrl.toString(), AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' };
    const configs: Record<App, ReturnType<typeof loadConfig>> = {
      db: loadConfig({ ...common, AUTH_SESSION_CHECK: 'db', AUTH_OAUTH_CLIENT_ID: OURS }),
      // Crove Cloud: a remote Supabase Auth. Its GET /user is asked only for R3, which no request here reaches.
      jwt: loadConfig({ ...common, AUTH_SESSION_CHECK: 'jwt', AUTH_OAUTH_CLIENT_ID: OURS, PUBLIC_URL: 'https://books.example.com', PUBLIC_AUTH_URL: 'http://127.0.0.1:9/auth/v1' }),
      'db-unset': loadConfig({ ...common, AUTH_SESSION_CHECK: 'db' }),
    };
    for (const which of ['db', 'jwt', 'db-unset'] as const) {
      const config = configs[which];
      const runtime = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource(config.AUTH_SESSION_CHECK, config.AUTH_OAUTH_CLIENT_ID ?? null), stepUp: 'required' }).register({
        commands: [...kernelCommands, ...financeCommands],
        queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
      });
      apps.set(which, createHttpApp({ config, runtime, store: {} as BlobStore, authenticate: createAuthenticator(config, db), pool, aiEnabled: false }));
    }
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  describe('jwt', () => {
    it("signs the accepted client's person in, and refuses every other kind of OAuth token without creating an account", async () => {
      const p = person('jwt');
      const orgName = `Accepted jwt ${randomUUID().slice(0, 6)}`;
      const ours = await tokenFor(p, 'ours', p.oursSession);
      expect((await rpc('jwt', 'me/get', ours)).status).toBe(200);
      const created = await rpc('jwt', 'org/create', ours, { name: orgName, idempotencyKey: randomUUID() });
      expect(created.status).toBe(200);
      expect((await rpc('jwt', 'inbox/list', ours, {}, String(created.body?.slug))).status).toBe(200);

      const fresh = person('jwt-fresh');
      for (const shape of ['other', 'ours-amr-only'] as const) {
        expect(await rpc('jwt', 'me/get', await tokenFor(fresh, shape, fresh.oursSession)), shape).toMatchObject(refused);
        expect(await rpc('jwt', 'org/create', await tokenFor(fresh, shape, fresh.oursSession), { name: `No ${shape}`, idempotencyKey: randomUUID() }), shape).toMatchObject(refused);
      }
      expect(await accountRows(fresh.subject)).toBe(0);
      expect(await sessionRows(fresh.oursSession)).toEqual([]);
    });
  });

  describe('db', () => {
    it("signs the accepted client's person in on a session bound to that client", async () => {
      const p = person('db-ours');
      await authRows(p);
      const ours = await tokenFor(p, 'ours', p.oursSession);
      expect((await rpc('db', 'me/get', ours)).status).toBe(200);
      const created = await rpc('db', 'org/create', ours, { name: `Accepted db ${randomUUID().slice(0, 6)}`, idempotencyKey: randomUUID() });
      expect(created.status).toBe(200);
      expect((await rpc('db', 'inbox/list', ours, {}, String(created.body?.slug))).status).toBe(200);
      expect(await sessionRows(p.oursSession)).toEqual([{ status: 'active' }]);
      // A token with no client claim at all (a hook dropped them) on the same session passes too: the session is ours.
      expect((await rpc('db', 'me/get', await tokenFor(p, 'browser-claims', p.oursSession))).status).toBe(200);
    });

    it("refuses a session bound to another client, whatever claims its token carries, and records nothing", async () => {
      const p = person('db-other');
      await authRows(p);
      // The person has a browser session that works, so the account exists.
      expect((await rpc('db', 'me/get', await tokenFor(p, 'browser-claims', p.session))).status).toBe(200);
      for (const shape of ['browser-claims', 'other', 'ours'] as const) {
        const token = await tokenFor(p, shape, p.otherSession);
        expect(await rpc('db', 'me/get', token), shape).toMatchObject(refused);
        expect(await rpc('db', 'org/create', token, { name: `No ${shape}`, idempotencyKey: randomUUID() }), shape).toMatchObject(refused);
      }
      expect(await sessionRows(p.otherSession)).toEqual([]);
    });

    it('refuses a first sign-in on a session bound to another client: no user account is created', async () => {
      const p = person('db-fresh');
      await authRows(p);
      expect(await rpc('db', 'me/get', await tokenFor(p, 'browser-claims', p.otherSession))).toMatchObject(refused);
      expect(await rpc('db', 'me/get', await tokenFor(p, 'ours', p.otherSession))).toMatchObject(refused);
      expect(await accountRows(p.subject)).toBe(0);
    });

    it("refuses the accepted client's own session when its token lost the client claim (amr only)", async () => {
      const p = person('db-amr');
      await authRows(p);
      expect(await rpc('db', 'me/get', await tokenFor(p, 'ours-amr-only', p.oursSession))).toMatchObject(refused);
      expect(await accountRows(p.subject)).toBe(0);
    });

    it("still applies the MFA rule to the accepted client's session", async () => {
      const p = person('db-mfa');
      await authRows(p);
      expect((await rpc('db', 'me/get', await tokenFor(p, 'ours', p.oursSession))).status).toBe(200);
      const created = await rpc('db', 'org/create', await tokenFor(p, 'ours', p.oursSession), { name: `MFA db ${randomUUID().slice(0, 6)}`, idempotencyKey: randomUUID() });
      expect(created.status).toBe(200);
      const slug = String(created.body?.slug);
      await sql(
        `INSERT INTO auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
         VALUES ($1, $2, 'phone', 'totp', 'verified', now(), now(), 'not-a-real-secret')`,
        [randomUUID(), p.subject],
      );
      expect(await rpc('db', 'inbox/list', await tokenFor(p, 'ours', p.oursSession, 'aal1'), {}, slug)).toMatchObject({ status: 401, body: { code: 'MFA_REQUIRED' } });
    });

    it('reads the binding on every request: a session rebound to another client is refused on the next request', async () => {
      const p = person('db-rebound');
      await authRows(p);
      const token = await tokenFor(p, 'ours', p.oursSession);
      expect((await rpc('db', 'me/get', token)).status).toBe(200);
      await sql('UPDATE auth.sessions SET oauth_client_id = $2 WHERE id = $1', [p.oursSession, OTHER]);
      expect(await rpc('db', 'me/get', token)).toMatchObject(refused);
      await sql('UPDATE auth.sessions SET oauth_client_id = $2 WHERE id = $1', [p.oursSession, OURS]);
      expect((await rpc('db', 'me/get', token)).status).toBe(200);
    });
  });

  describe('db with AUTH_OAUTH_CLIENT_ID unset', () => {
    it("refuses the accepted client's token and session, as before", async () => {
      const p = person('db-unset');
      await authRows(p);
      expect(await rpc('db-unset', 'me/get', await tokenFor(p, 'ours', p.oursSession))).toMatchObject(refused);
      expect(await rpc('db-unset', 'me/get', await tokenFor(p, 'browser-claims', p.oursSession))).toMatchObject(refused);
      expect(await accountRows(p.subject)).toBe(0);
    });
  });
});
