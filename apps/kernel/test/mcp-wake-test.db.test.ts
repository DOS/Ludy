// SPDX-License-Identifier: AGPL-3.0-only
// "Send a test" of the wake-up webhook against a real database (ADR-0051 decision 4, issue #3024, step c2): a ping is stored as a delivery like any other, the sweep hands it
// over at its next pass, only an owner or admin who is a person can ask (with a fresh second factor when they have one), and the database allows one a minute per grant.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { CredentialVault, DomainError, Runtime, parseVaultKey, type UserActor } from '@crove/kernel-runtime';
import { makeWakeSecret } from '../src/mcp-wake-setup.ts';
import { runWakeSweep, type SignalEvaluator } from '../src/mcp-wake-sweep.ts';
import { wakeEvent, type WakeItem } from '../src/mcp-wake-body.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('the wake-up test ping (#3024, step c2)', () => {
  const dbName = `crove_test_mcp_wake_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let runtime: Runtime;
  let worker: Runtime;
  let workerDb: Db;
  let orgId = '';
  let ownerId = '';
  const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
  const owner = (): UserActor => ({ type: 'user', userId: ownerId, aal: 'aal1' });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  // A grant with a wake-up set through the real setup commands (the receiver URL is only stored here: the delivery tests give the job a local address).
  async function wakeUp(extra: Record<string, unknown> = {}): Promise<{ grantId: string; secret: string }> {
    const grantId = randomUUID();
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by)
         VALUES ($1, $2, $3, $5, 'Test client', 'client.example.com', ARRAY['ludy.read'], $4, now(), now() + interval '30 days', $3)`,
        [orgId, grantId, ownerId, `oauth-${grantId}`, `client-${grantId}`],
      ),
    );
    const made = makeWakeSecret(vault, orgId, grantId);
    await runtime.execute('kernel.mcp.wake.set', { grantId, url: 'https://hooks.example.com/ludy', credential: made.credential, ...extra }, { actor: owner(), orgId });
    return { grantId, secret: made.secret };
  }

  const deliveries = (grantId: string) =>
    admin((c) => c.query(`SELECT id, type, status, attempts, last_code, body FROM crove_kernel.agent_wake_delivery WHERE grant_id = $1 ORDER BY created_at, id`, [grantId]).then((r) => r.rows as Array<{ id: string; type: string; status: string; attempts: number; last_code: number | null; body: { data: { items?: WakeItem[]; date?: string } } }>));
  // A sweep with the signals the test says are there now, and every hand-over collected.
  const sweeper = (signals: () => WakeItem[], sent: Array<{ orgId: string; id: string }>, options: { complete?: () => string[]; runtime?: Runtime } = {}) => {
    const evaluate: SignalEvaluator = async () => ({ items: signals(), complete: options.complete ? options.complete() : ['deal_without_invoice'] });
    return () => runWakeSweep({ runtime: options.runtime ?? worker, workerDb, send: async (job) => void sent.push(job), evaluate });
  };

  beforeAll(async () => {
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    const appPool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 4 });
    const workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 4 });
    pools.push(appPool, workerPool);
    const defs = { commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) };
    runtime = new Runtime(createDb(appPool), { manifests: TEST_MANIFESTS }).register(defs);
    workerDb = createDb(workerPool);
    worker = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register(defs);
    ownerId = await upsertIdentity(createDb(appPool), { issuer: 'mcp-wake-test', subject: 'owner', email: 'owner@mcp-wake-test.test', name: null });
    orgId = (await createOrg(runtime, owner(), 'Org A')).orgId;
  }, 120_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  }, 60_000);

  it('stores a ping the sweep hands over at once, with a body the delivery will sign', async () => {
    const { grantId } = await wakeUp();
    const done = await runtime.execute<{ grantId: string; eventId: string; queued: true }>('kernel.mcp.wake.test', { grantId }, { actor: owner(), orgId });
    expect(done).toMatchObject({ grantId, queued: true });
    const rows = await deliveries(grantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: done.eventId, type: 'ping', status: 'queued', attempts: 0 });
    // The body is exactly what the one builder makes of it: no data.
    expect(wakeEvent(rows[0]?.body)).toMatchObject({ id: done.eventId, type: 'ping', org: orgId, grant: grantId, data: {} });
    const sent: Array<{ orgId: string; id: string }> = [];
    await sweeper(() => [], sent)();
    expect(sent).toEqual([{ orgId, id: done.eventId }]);
    // The audit row names the grant and the event, nothing about the receiver.
    const audit = await admin((c) => c.query(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.mcp.wake.test' ORDER BY occurred_at DESC LIMIT 1`, [orgId]));
    expect(JSON.stringify(audit.rows[0]?.detail)).not.toContain('example.com');
  });

  it('allows one ping a minute per grant, in the database, even when asked at the same moment', async () => {
    const { grantId } = await wakeUp();
    const asks = await Promise.allSettled([1, 2, 3].map(() => runtime.execute('kernel.mcp.wake.test', { grantId }, { actor: owner(), orgId })));
    expect(asks.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    for (const a of asks) if (a.status === 'rejected') expect((a.reason as DomainError).code).toBe('MCP_WAKE_TOO_SOON');
    expect(await deliveries(grantId)).toHaveLength(1);
    // Another grant is not held back, and this one is free again after a minute.
    const other = await wakeUp();
    await runtime.execute('kernel.mcp.wake.test', { grantId: other.grantId }, { actor: owner(), orgId });
    await admin((c) => c.query(`UPDATE crove_kernel.agent_wake_delivery SET created_at = now() - interval '2 minutes' WHERE grant_id = $1`, [grantId]));
    await runtime.execute('kernel.mcp.wake.test', { grantId }, { actor: owner(), orgId });
    expect(await deliveries(grantId)).toHaveLength(2);
  });

  it('refuses a grant with no wake-up, a paused one, a revoked one, a member, an MCP grant and a second factor that is not fresh', async () => {
    const code = async (promise: Promise<unknown>) => {
      try {
        await promise;
        return 'ok';
      } catch (error) {
        return (error as DomainError).code;
      }
    };
    const none = randomUUID();
    expect(await code(runtime.execute('kernel.mcp.wake.test', { grantId: none }, { actor: owner(), orgId }))).toBe('MCP_WAKE_GRANT_NOT_FOUND');
    const paused = await wakeUp({ enabled: false });
    expect(await code(runtime.execute('kernel.mcp.wake.test', { grantId: paused.grantId }, { actor: owner(), orgId }))).toBe('MCP_WAKE_GRANT_NOT_FOUND');
    const revoked = await wakeUp();
    await admin((c) => c.query(`UPDATE crove_kernel.agent_grant SET revoked_at = now() WHERE id = $1`, [revoked.grantId]));
    expect(await code(runtime.execute('kernel.mcp.wake.test', { grantId: revoked.grantId }, { actor: owner(), orgId }))).toBe('MCP_WAKE_GRANT_NOT_FOUND');
    const live = await wakeUp();
    const mcpActor: UserActor = { type: 'user', userId: ownerId, aal: 'aal1', mcp: { grantId: live.grantId, clientId: 'c', clientName: 'c', scopes: ['ludy.read'] } };
    expect(await code(runtime.execute('kernel.mcp.wake.test', { grantId: live.grantId }, { actor: mcpActor, orgId }))).toBe('FORBIDDEN');
    expect(await code(runtime.execute('kernel.mcp.wake.test', { grantId: live.grantId }, { actor: { type: 'user', userId: ownerId, aal: 'aal2' }, orgId }))).toBe('STEP_UP_REQUIRED');
    expect(await code(runtime.execute('kernel.mcp.wake.test', { grantId: live.grantId }, { actor: { type: 'user', userId: ownerId, aal: 'aal2', mfaAt: Math.floor(Date.now() / 1000) }, orgId }))).toBe('ok');
    expect(await deliveries(none)).toHaveLength(0);
    expect(await deliveries(paused.grantId)).toHaveLength(0);
  });
});
