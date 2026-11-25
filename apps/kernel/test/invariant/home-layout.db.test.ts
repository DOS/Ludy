// SPDX-License-Identifier: AGPL-3.0-only
// Invariant suite (Decision 7): security, CHECK validation, RLS, ownership column locks, non-user actor denial,
// and recipient-scoped SSE stream invalidation for ludy_kernel.member_home_layout (#4925).
// Keep this file self-contained: import package code under test, never helpers from outside test/invariant/.
// Set CROVE_TEST_ADMIN_URL (or LUDY_TEST_ADMIN_URL) to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@ludy/db';
import { migrate } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type { HomeLayoutSaveInput, HomeLayoutView } from '@ludy/kernel-contract';
import { LocalDiskStore, Runtime } from '@ludy/kernel-runtime';
import { createAuthenticator } from '../../src/auth.ts';
import { ConcurrencyLimiter } from '../../src/concurrency.ts';
import { loadConfig } from '../../src/config.ts';
import { createHttpApp, type StreamDeps } from '../../src/http.ts';
import { createSessionStatusSource } from '../../src/sessions.ts';
import { StreamHub, createDbTicketStore, createPgNotificationSource } from '../../src/stream.ts';
import { contextToken } from './fixtures/context-token.ts';
import {
  createDbClient,
  createDbPool,
  resolveDbIdentifiers,
  setActiveRolePasswords,
  type DbIdentifiers,
} from './fixtures/db-identifiers.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL ?? process.env.LUDY_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const SECRET = 'home-layout-invariant-secret-0123456789-abcdefghij';
const ISSUER = 'http://localhost:9999';

const suite = ADMIN ? describe : describe.skip;

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

suite('invariant: member_home_layout security, RLS, CHECK, and recipient stream (#4925)', () => {
  const dbName = `crove_test_home_layout_inv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let dbIds: DbIdentifiers | undefined;
  let appUrl = '';
  let workerUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let workerRt: Runtime;
  let hub: StreamHub;
  let httpApp: ReturnType<typeof createHttpApp>;
  const accounts = new Map<string, { subject: string; email: string; session: string }>();

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const, sessionId: randomUUID() });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const client = createDbClient({ connectionString: adminUrl }, dbIds);
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function asApp<T>(orgId: string, userId: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const client = createDbClient({ connectionString: appUrl }, dbIds);
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(userId, orgId)]);
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      await client.end();
    }
  }

  const person = (name: string) =>
    upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@home-inv.test`, name: null });

  async function setupOrg() {
    const owner = await person('owner');
    const { orgId, slug } = await createOrg(rt, asUser(owner), `Home Inv ${randomUUID().slice(0, 6)}`);
    const member = await person('member');
    const viewer = await person('viewer');
    await admin(async (c) => {
      await c.query(
        `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role)
         VALUES ($1, $2, 'member'), ($1, $3, 'viewer')`,
        [orgId, member, viewer],
      );
    });
    return { orgId, slug, owner, member, viewer };
  }

  const getLayout = (orgId: string, userId: string) =>
    rt.query<HomeLayoutView>('kernel.member.home_layout.get', {}, { actor: asUser(userId), orgId });

  const saveLayout = (orgId: string, userId: string, input: HomeLayoutSaveInput) =>
    rt.execute<HomeLayoutView>('kernel.member.home_layout.save', input, { actor: asUser(userId), orgId });

  async function jwtToken(name: string, email: string, subject: string, session: string) {
    return new SignJWT({ role: 'authenticated', email, session_id: session, is_anonymous: false, aal: 'aal1' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
  }

  async function setupHttpUser(label: string) {
    const tag = `${label}-${randomUUID().slice(0, 8)}`;
    const acc = { subject: randomUUID(), email: `${tag}@stream-home.test`, session: randomUUID() };
    accounts.set(label, acc);
    const token = await jwtToken(label, acc.email, acc.subject, acc.session);
    const res = await httpApp.request('/api/rpc/me/get', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { json?: { userId: string }; userId?: string };
    const userId = (body.json ?? body).userId as string;
    return { ...acc, token, userId };
  }

  async function openStream(token: string, orgSlug: string) {
    const issued = await httpApp.request('/api/stream/tickets', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-crove-org': orgSlug },
    });
    expect(issued.status).toBe(200);
    const { ticket } = (await issued.json()) as { ticket: string };
    const response = await httpApp.request(`/api/stream?ticket=${ticket}`, {
      headers: { 'x-forwarded-for': '198.51.100.2' },
    });
    expect(response.status).toBe(200);
    const events: SseEvent[] = [];
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let end: number;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const lines = block.split('\n');
            const event = lines.find((l) => l.startsWith('event: '))?.slice(7);
            const data = lines.find((l) => l.startsWith('data: '))?.slice(6);
            if (event && data) events.push({ event, data: JSON.parse(data) as Record<string, unknown> });
          }
        }
      } catch {
        // stream closed
      }
    })();
    const waitFor = async (predicate: (e: SseEvent[]) => boolean, ms: number) => {
      const until = Date.now() + ms;
      while (!predicate(events)) {
        if (Date.now() > until) throw new Error(`timed out waiting for SSE event; got ${JSON.stringify(events)}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    await waitFor((e) => e.some((x) => x.event === 'ready'), 5_000);
    return { events, waitFor, cancel: () => reader.cancel().catch(() => {}) };
  }

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();

    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    dbIds = await resolveDbIdentifiers(adminUrl);
    await setActiveRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' }, dbIds);

    const app = new URL(adminUrl);
    app.username = dbIds ? dbIds.roleName('crove_app') : 'crove_app';
    app.password = 'test-app-pw';
    appUrl = app.toString();

    const worker = new URL(adminUrl);
    worker.username = dbIds ? dbIds.roleName('crove_worker') : 'crove_worker';
    worker.password = 'test-worker-pw';
    workerUrl = worker.toString();

    pool = createDbPool({ connectionString: appUrl, max: 6 }, dbIds);
    workerPool = createDbPool({ connectionString: workerUrl, max: 2 }, dbIds);
    db = createDb(pool);

    const config = loadConfig({
      DATABASE_URL: appUrl,
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
      TRUSTED_PROXY_HOPS: '1',
    });
    const registry = {
      commands: [...kernelCommands],
      queries: [...kernelQueries({ inboundDomain: null })],
    };
    rt = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' }).register(registry);
    workerRt = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(registry);

    hub = new StreamHub(createPgNotificationSource({ connectionString: appUrl }));
    hub.start();
    const stream: StreamDeps = {
      hub,
      tickets: createDbTicketStore(pool),
      slots: new ConcurrencyLimiter({ total: 50, perKey: 10 }),
      recheckSeconds: 1,
    };
    httpApp = createHttpApp({
      config,
      runtime: rt,
      store: new LocalDiskStore(joinPath(tmpdir(), dbName)),
      authenticate: createAuthenticator(config, db),
      pool,
      aiEnabled: false,
      rateLimiter: null,
      stream,
    });
    const until = Date.now() + 10_000;
    while (!hub.ready) {
      if (Date.now() > until) throw new Error('stream listener did not start');
      await new Promise((r) => setTimeout(r, 25));
    }
  }, 120_000);

  afterAll(async () => {
    await hub?.stop();
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('rejects empty objects, malformed JSONB types, invalid IDs, duplicates, and >4096-byte payloads in member_home_layout_ok', async () => {
    const o = await setupOrg();

    const malformedPayloads = [
      '{}',
      '[]',
      '123',
      '"teamwork_my_work"',
      'true',
      JSON.stringify({ v: 2, blocks: [{ id: 'teamwork_my_work', visible: true }] }),
      JSON.stringify({ v: 1, extra: 'bad', blocks: [{ id: 'teamwork_my_work', visible: true }] }),
      JSON.stringify({ v: 1, blocks: 'bad' }),
      JSON.stringify({ v: 1, blocks: [] }),
      JSON.stringify({ v: 1, blocks: [1] }),
      JSON.stringify({ v: 1, blocks: [{}] }),
      JSON.stringify({ v: 1, blocks: [{ id: 'unknown_id', visible: true }] }),
      JSON.stringify({ v: 1, blocks: [{ id: 'teamwork_my_work', visible: 'yes' }] }),
      JSON.stringify({ v: 1, blocks: [{ id: 'teamwork_my_work', visible: true, extra: 1 }] }),
      JSON.stringify({
        v: 1,
        blocks: [
          { id: 'teamwork_my_work', visible: true },
          { id: 'teamwork_my_work', visible: false },
        ],
      }),
      JSON.stringify({
        v: 1,
        blocks: Array.from({ length: 13 }, (_, i) => ({ id: i % 2 === 0 ? 'teamwork_my_work' : 'hr_pending', visible: true })),
      }),
    ];

    for (const payload of malformedPayloads) {
      const fnCheck = await admin((c) => c.query<{ ok: boolean }>('SELECT crove_kernel.member_home_layout_ok($1::jsonb) AS ok', [payload]));
      expect(fnCheck.rows[0]?.ok, `member_home_layout_ok(${payload})`).toBe(false);

      await expect(
        asApp(o.orgId, o.owner, (c) =>
          c.query('INSERT INTO crove_kernel.member_home_layout (org_id, user_id, layout_json) VALUES ($1, $2, $3::jsonb)', [o.orgId, o.owner, payload]),
        ),
        `CHECK insert(${payload})`,
      ).rejects.toMatchObject({ code: '23514' });
    }

    // NULL explicitly returns false, never NULL.
    const nullCheck = await admin((c) => c.query<{ ok: boolean }>('SELECT crove_kernel.member_home_layout_ok(NULL::jsonb) AS ok'));
    expect(nullCheck.rows[0]?.ok).toBe(false);

    // > 4096-byte JSONB payload rejected.
    const huge = JSON.stringify({
      v: 1,
      blocks: Array.from({ length: 120 }, () => ({ id: 'teamwork_my_work', visible: true })),
    });
    const hugeCheck = await admin((c) => c.query<{ ok: boolean }>('SELECT crove_kernel.member_home_layout_ok($1::jsonb) AS ok', [huge]));
    expect(hugeCheck.rows[0]?.ok).toBe(false);
  });

  it('enforces cross-org isolation, own-member RLS, and ownership column update locks', async () => {
    const orgA = await setupOrg();
    const orgB = await setupOrg();

    await saveLayout(orgA.orgId, orgA.owner, { blocks: [{ id: 'teamwork_my_work', visible: false }] });
    await saveLayout(orgA.orgId, orgA.member, { blocks: [{ id: 'teamwork_my_work', visible: true }] });

    // API isolation across members and orgs.
    expect((await getLayout(orgA.orgId, orgA.viewer)).customized).toBe(false);
    expect(await getLayout(orgA.orgId, orgA.member)).toMatchObject({
      customized: true,
      blocks: [{ id: 'teamwork_my_work', visible: true }],
    });
    expect(await getLayout(orgA.orgId, orgA.owner)).toMatchObject({
      customized: true,
      blocks: [{ id: 'teamwork_my_work', visible: false }],
    });
    expect((await getLayout(orgB.orgId, orgB.owner)).customized).toBe(false);

    // Direct SQL RLS under app login user context:
    expect(
      await asApp(orgA.orgId, orgA.member, async (c) =>
        (await c.query<{ user_id: string }>('SELECT user_id FROM crove_kernel.member_home_layout')).rows.map((r) => r.user_id),
      ),
    ).toEqual([orgA.member]);

    expect(
      await asApp(orgB.orgId, orgB.owner, async (c) => (await c.query('SELECT 1 FROM crove_kernel.member_home_layout')).rowCount),
    ).toBe(0);

    await expect(
      asApp(orgA.orgId, orgA.viewer, (c) =>
        c.query(
          `INSERT INTO crove_kernel.member_home_layout (org_id, user_id, layout_json) VALUES ($1, $2, '{"v":1,"blocks":[{"id":"teamwork_my_work","visible":true}]}'::jsonb)`,
          [orgA.orgId, orgA.owner],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    expect(await asApp(orgA.orgId, orgA.viewer, async (c) => (await c.query('DELETE FROM crove_kernel.member_home_layout')).rowCount)).toBe(0);

    // Ownership columns cannot be updated by tenant role.
    await expect(
      asApp(orgA.orgId, orgA.member, (c) => c.query('UPDATE crove_kernel.member_home_layout SET user_id = $1', [orgA.viewer])),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asApp(orgA.orgId, orgA.member, (c) => c.query('UPDATE crove_kernel.member_home_layout SET org_id = $1', [orgB.orgId])),
    ).rejects.toThrow(/permission denied/);
  });

  it('refuses system, org-chart agent, and member_vy actors at runtime and in database RLS/triggers', async () => {
    const o = await setupOrg();
    await saveLayout(o.orgId, o.owner, { blocks: [{ id: 'teamwork_my_work', visible: false }] });

    const systemActor = { type: 'system' as const, component: 'kernel.test' };
    await expect(workerRt.query('kernel.member.home_layout.get', {}, { actor: systemActor, orgId: o.orgId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
    await expect(workerRt.execute('kernel.member.home_layout.save', { reset: true }, { actor: systemActor, orgId: o.orgId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });

    const posId = randomUUID();
    const orgAgentId = randomUUID();
    const orgRunId = randomUUID();
    const vyAgentId = randomUUID();
    const vyRunId = randomUUID();
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(
        `INSERT INTO crove_kernel.agent (org_id, id, template_key, display_name, created_by, kind)
         VALUES ($1, $2, 'finance.chief_accountant', 'Ly', $3, 'org_chart')`,
        [o.orgId, orgAgentId, o.owner],
      );
      await c.query(
        `INSERT INTO crove_kernel.position (org_id, id, title, module, role_key, holder_agent_id, status)
         VALUES ($1, $2, 'Finance', 'finance', 'finance.chief_accountant', $3, 'active')`,
        [o.orgId, posId, orgAgentId],
      );
      await c.query(
        `INSERT INTO crove_kernel.ai_run (org_id, id, agent_id, module, feature, status, tainted, started_at, expires_at)
         VALUES ($1, $2, $3, 'finance', 'finance.home', 'running', true, pg_catalog.now(), pg_catalog.now() + interval '4 hours')`,
        [o.orgId, orgRunId, orgAgentId],
      );
      await c.query(
        `INSERT INTO crove_kernel.agent (org_id, id, template_key, display_name, kind, member_user_id, created_by)
         VALUES ($1, $2, 'kernel.member_vy', 'Vy', 'member_vy', $3, $3)`,
        [o.orgId, vyAgentId, o.owner],
      );
      await c.query(
        `INSERT INTO crove_kernel.ai_run (org_id, id, agent_id, module, feature, status, tainted, started_at, expires_at)
         VALUES ($1, $2, $3, 'notes', 'notes.summary', 'running', true, pg_catalog.now(), pg_catalog.now() + interval '4 hours')`,
        [o.orgId, vyRunId, vyAgentId],
      );
      await c.query('COMMIT');
    });

    const orgAgentActor = { type: 'agent' as const, agentId: orgAgentId, positionId: posId, runId: orgRunId };
    const memberVyActor = { type: 'agent' as const, agentId: vyAgentId, positionId: null, runId: vyRunId, memberVy: true as const };

    await expect(workerRt.query('kernel.member.home_layout.get', {}, { actor: orgAgentActor, orgId: o.orgId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
    await expect(
      workerRt.execute('kernel.member.home_layout.save', { blocks: [{ id: 'teamwork_my_work', visible: true }] }, { actor: orgAgentActor, orgId: o.orgId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });

    await expect(workerRt.query('kernel.member.home_layout.get', {}, { actor: memberVyActor, orgId: o.orgId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
    await expect(
      workerRt.execute('kernel.member.home_layout.save', { blocks: [{ id: 'teamwork_my_work', visible: true }] }, { actor: memberVyActor, orgId: o.orgId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });

    // Direct SQL under member_vy sealed context reads 0 rows and refuses writes via agent_write_guard.
    const workerClient = createDbClient({ connectionString: workerUrl }, dbIds);
    await workerClient.connect();
    try {
      await workerClient.query('BEGIN');
      await workerClient.query('SELECT crove_kernel.enter_member_vy_context($1::uuid, $2::uuid, $3::uuid)', [o.orgId, vyAgentId, vyRunId]);
      const seen = await workerClient.query('SELECT 1 FROM crove_kernel.member_home_layout');
      expect(seen.rowCount).toBe(0);
      await workerClient.query('SAVEPOINT sp_insert');
      await expect(
        workerClient.query(
          `INSERT INTO crove_kernel.member_home_layout (org_id, user_id, layout_json) VALUES ($1, $2, '{"v":1,"blocks":[{"id":"teamwork_my_work","visible":true}]}'::jsonb)`,
          [o.orgId, o.owner],
        ),
      ).rejects.toMatchObject({ code: '42501', message: 'AGENT_FORBIDDEN' });
      await workerClient.query('ROLLBACK TO SAVEPOINT sp_insert');
      const updated = await workerClient.query('UPDATE crove_kernel.member_home_layout SET updated_at = pg_catalog.now()');
      expect(updated.rowCount).toBe(0);
      const deleted = await workerClient.query('DELETE FROM crove_kernel.member_home_layout');
      expect(deleted.rowCount).toBe(0);
    } finally {
      await workerClient.query('ROLLBACK').catch(() => {});
      await workerClient.end();
    }
  });

  it('delivers home_layout stream hints to another session of the same member on save and reset, never to another member', async () => {
    const alice = await setupHttpUser('alice');
    const bob = await setupHttpUser('bob');
    const created = await createOrg(rt, asUser(alice.userId), `Stream Home ${randomUUID().slice(0, 6)}`);
    await admin((c) =>
      c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [created.orgId, bob.userId]),
    );

    const listener = createDbClient({ connectionString: adminUrl }, dbIds);
    await listener.connect();
    const channelName = dbIds?.streamChannel ?? 'ludy_stream';
    const payloads: string[] = [];
    listener.on('notification', (m) => {
      if (m.channel === channelName && m.payload?.includes('home_layout')) payloads.push(m.payload);
    });
    await listener.query(`LISTEN ${channelName}`);

    const aliceSession2Token = await jwtToken('alice-device-2', alice.email, alice.subject, randomUUID());
    const aliceSession2 = await openStream(aliceSession2Token, created.slug);
    const bobStream = await openStream(bob.token, created.slug);
    try {
      const saveRes = await httpApp.request('/api/rpc/overview/homeLayout/save', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${alice.token}`,
          'content-type': 'application/json',
          'x-crove-org': created.slug,
        },
        body: JSON.stringify({ json: { blocks: [{ id: 'teamwork_my_work', visible: false }] } }),
      });
      expect(saveRes.status).toBe(200);

      await aliceSession2.waitFor(
        (e) => e.filter((x) => x.event === 'invalidate' && x.data.type === 'home_layout').length >= 1,
        5_000,
      );

      const resetRes = await httpApp.request('/api/rpc/overview/homeLayout/save', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${alice.token}`,
          'content-type': 'application/json',
          'x-crove-org': created.slug,
        },
        body: JSON.stringify({ json: { reset: true } }),
      });
      expect(resetRes.status).toBe(200);

      // Flush stream delivery with an org-wide file hint so any leaked hint for Bob would have arrived before it resolves.
      const sha = 'a'.repeat(64);
      const { fileId } = await rt.execute<{ fileId: string }>(
        'kernel.file.ingest',
        {
          filename: 'sync.pdf',
          contentType: 'application/pdf',
          sizeBytes: 12,
          sha256: sha,
          storageKey: `org/${created.orgId}/${sha}`,
          generation: `content:${sha}`,
          source: 'upload',
        },
        { actor: { type: 'user', userId: alice.userId, aal: 'aal1', sessionId: alice.session }, orgId: created.orgId },
      );

      await aliceSession2.waitFor(
        (e) =>
          e.filter((x) => x.event === 'invalidate' && x.data.type === 'home_layout').length >= 2 &&
          e.some((x) => x.event === 'invalidate' && x.data.type === 'file' && x.data.id === fileId),
        5_000,
      );
      await bobStream.waitFor(
        (e) => e.some((x) => x.event === 'invalidate' && x.data.type === 'file' && x.data.id === fileId),
        5_000,
      );
      await new Promise((r) => setTimeout(r, 200));

      const aliceHints = aliceSession2.events.filter((x) => x.event === 'invalidate' && x.data.type === 'home_layout');
      expect(aliceHints).toHaveLength(2);
      for (const h of aliceHints) {
        expect(Object.keys(h.data).sort()).toEqual(['id', 'type']);
      }
      expect(bobStream.events.some((x) => x.event === 'invalidate' && x.data.type === 'home_layout')).toBe(false);

      // Raw channel payload named @<alice.userId> for both INSERT and DELETE.
      expect(payloads).toHaveLength(2);
      for (const p of payloads) {
        expect(p).toMatch(new RegExp(`^${created.orgId} home_layout [0-9a-f-]+ @${alice.userId}$`));
      }
    } finally {
      await aliceSession2.cancel();
      await bobStream.cancel();
      await listener.end();
    }
  });
});
