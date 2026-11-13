// SPDX-License-Identifier: AGPL-3.0-only
// The sweep and the delivery job of the wake-up webhook against a real database (ADR-0051 decision 4, issue #3024): what is stored, what is handed to the queue and when, how a
// signal fires (when its key first appears, and again only after it went away), how a schedule moves on, how a lost hand-over is made good and a stuck delivery ends, how a
// delivery's outcome is recorded, and how seven days of failing pause the wake-up. A local server stands in for the receiver.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { DEAL_WITHOUT_INVOICE_READ, createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { CredentialVault, Runtime, parseVaultKey, type UserActor } from '@crove/kernel-runtime';
import { makeWakeSecret } from '../src/mcp-wake-setup.ts';
import { WAKE_RETRY_LIMIT, runWakeDelivery } from '../src/mcp-wake.ts';
import { runWakeSweep, runtimeEvaluator, type SignalEvaluator } from '../src/mcp-wake-sweep.ts';
import { WAKE_RULES } from '../src/mcp-wake-body.ts';
import { crmQueries } from '@crove/mod-crm';
import { financeQueries } from '@crove/mod-finance';
import type { WakeItem } from '../src/mcp-wake-body.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('the wake-up sweep and delivery (#3024, step b)', () => {
  const dbName = `crove_test_mcp_wake_sweep_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let runtime: Runtime;
  let worker: Runtime;
  let signalWorker: Runtime;
  let workerDb: Db;
  let orgId = '';
  let ownerId = '';
  const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
  const servers: http.Server[] = [];
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

  async function receiver(status: number) {
    const seen: Array<{ headers: http.IncomingHttpHeaders; body: string }> = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        res.writeHead(status).end();
      });
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    return { port: (server.address() as AddressInfo).port, seen };
  }
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((done) => s.close(() => done()))));
  });

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
  const wakeRow = (grantId: string) =>
    admin((c) => c.query(`SELECT enabled, paused_reason, consecutive_failures, failing_since, last_status, last_delivery_at, next_due_at, signals_checked_at FROM crove_kernel.agent_grant_wake WHERE grant_id = $1`, [grantId]).then((r) => r.rows[0]));

  const item = (n: number): WakeItem => {
    const id = `0197a1c2-7b3e-7c11-9a55-${String(n).padStart(12, '0')}`;
    return { rule: DEAL_WITHOUT_INVOICE_READ, key: `deal_without_invoice:${id}`, severity: 'warn', deal_id: id, days: 7 };
  };
  // A sweep with the signals the test says are there now, and every hand-over collected.
  const sweeper = (signals: () => WakeItem[], sent: Array<{ orgId: string; id: string }>, options: { complete?: () => string[]; runtime?: Runtime } = {}) => {
    const evaluate: SignalEvaluator = async () => ({ items: signals(), complete: options.complete ? options.complete() : ['deal_without_invoice'] });
    return () => runWakeSweep({ runtime: options.runtime ?? worker, workerDb, send: async (job) => void sent.push(job), evaluate });
  };
  const stampPast = (grantId: string, column: string, interval: string) => admin((c) => c.query(`UPDATE crove_kernel.agent_grant_wake SET ${column} = now() - interval '${interval}' WHERE grant_id = $1`, [grantId]));

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
    worker = new Runtime(workerDb, { manifests: TEST_MANIFESTS, mcpEntry: 'worker' }).register(defs);
    // The worker's runtime for the real evaluator case: the same entry, with the lines' reads the rules ask.
    signalWorker = new Runtime(workerDb, { manifests: TEST_MANIFESTS, mcpEntry: 'worker' }).register({ commands: kernelCommands, queries: [...kernelQueries({ inboundDomain: null }), ...crmQueries, ...financeQueries] });
    ownerId = await upsertIdentity(createDb(appPool), { issuer: 'mcp-wake-sweep', subject: 'owner', email: 'owner@mcp-wake-sweep.test', name: null });
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

  it('fires a signal when its key first appears, not again while it stays, and again after it went away and came back', async () => {
    const { grantId } = await wakeUp();
    const sent: Array<{ orgId: string; id: string }> = [];
    let present = [item(1), item(2)];
    const sweep = sweeper(() => present, sent);
    expect((await sweep()).signals).toBe(1);
    let rows = await deliveries(grantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'signal.fired', status: 'queued' });
    expect(rows[0]?.body.data.items?.map((i) => i.key)).toEqual([item(1).key, item(2).key]);
    expect(sent).toEqual([{ orgId, id: rows[0]?.id }]);
    // Five minutes have not passed: the signals are not looked at again, and nothing is sent twice.
    expect((await sweep()).signals).toBe(0);
    expect(await deliveries(grantId)).toHaveLength(1);
    // Five minutes on and the same two are still there: no new event. A third appears: one event with the third alone.
    await stampPast(grantId, 'signals_checked_at', '6 minutes');
    present = [item(1), item(2)];
    expect((await sweep()).signals).toBe(0);
    await stampPast(grantId, 'signals_checked_at', '6 minutes');
    present = [item(1), item(2), item(3)];
    expect((await sweep()).signals).toBe(1);
    rows = await deliveries(grantId);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.body.data.items?.map((i) => i.key)).toEqual([item(3).key]);
    // The second goes away, and comes back: it fires again, alone.
    await stampPast(grantId, 'signals_checked_at', '6 minutes');
    present = [item(1), item(3)];
    await sweep();
    await stampPast(grantId, 'signals_checked_at', '6 minutes');
    present = [item(1), item(2), item(3)];
    expect((await sweep()).signals).toBe(1);
    rows = await deliveries(grantId);
    expect(rows).toHaveLength(3);
    expect(rows[2]?.body.data.items?.map((i) => i.key)).toEqual([item(2).key]);
    expect(sent).toHaveLength(3);
  });

  it('sends more than twenty new signals as events of at most twenty items', async () => {
    const { grantId } = await wakeUp();
    const sent: Array<{ orgId: string; id: string }> = [];
    const all = Array.from({ length: 45 }, (_, i) => item(100 + i));
    const done = await sweeper(() => all, sent)();
    expect(done.signals).toBe(3);
    const rows = await deliveries(grantId);
    expect(rows.map((r) => r.body.data.items?.length)).toEqual([20, 20, 5]);
    expect(new Set(rows.flatMap((r) => r.body.data.items?.map((i) => i.key))).size).toBe(45);
  });

  it('sends nothing for a rule the grant may not read: the runtime refuses a query that does not declare `mcp`, so the real evaluator is quiet', async () => {
    const { grantId } = await wakeUp();
    const sent: Array<{ orgId: string; id: string }> = [];
    const done = await runWakeSweep({ runtime: worker, workerDb, send: async (job) => void sent.push(job) });
    expect(done).toMatchObject({ signals: 0, failures: 0 });
    expect(await deliveries(grantId)).toEqual([]);
    expect((await wakeRow(grantId)).signals_checked_at).not.toBeNull();
  });

  it('sends the day a schedule fell due, once, and moves it to its next time', async () => {
    const { grantId } = await wakeUp({ schedule: 'daily', minute: 480 });
    const sent: Array<{ orgId: string; id: string }> = [];
    const sweep = sweeper(() => [], sent);
    await sweep();
    expect(await deliveries(grantId)).toEqual([]);
    // Two days late: one event for the day it was due, and the next time is counted from now.
    await admin((c) => c.query(`UPDATE crove_kernel.agent_grant_wake SET next_due_at = now() - interval '2 days' WHERE grant_id = $1`, [grantId]));
    const due = await admin((c) => c.query(`SELECT to_char(next_due_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') AS d FROM crove_kernel.agent_grant_wake WHERE grant_id = $1`, [grantId]).then((r) => r.rows[0].d as string));
    expect((await sweep()).schedules).toBe(1);
    const rows = await deliveries(grantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'schedule.due', body: { data: { date: due } } });
    expect((await wakeRow(grantId)).next_due_at.getTime()).toBeGreaterThan(Date.now());
    expect((await sweep()).schedules).toBe(0);
    expect(await deliveries(grantId)).toHaveLength(1);
  });

  it('hands a delivery the queue never got over again after three minutes, and fails one still waiting after eight hours', async () => {
    const { grantId } = await wakeUp();
    const sent: Array<{ orgId: string; id: string }> = [];
    // The hand-over failed: the delivery is stored and the queue was not given it.
    const lost = await runWakeSweep({ runtime: worker, workerDb, send: async () => Promise.reject(new Error('queue down')), evaluate: async () => ({ items: [item(7)], complete: ['deal_without_invoice'] }) });
    expect(lost).toMatchObject({ signals: 1 });
    const [stored] = await deliveries(grantId);
    expect(stored?.status).toBe('queued');
    const sweep = sweeper(() => [], sent);
    expect((await sweep()).handedOver).toBe(0);
    await admin((c) => c.query(`UPDATE crove_kernel.agent_wake_delivery SET queued_at = now() - interval '4 minutes' WHERE id = $1`, [stored?.id]));
    expect((await sweep()).handedOver).toBe(1);
    expect(sent).toEqual([{ orgId, id: stored?.id }]);
    // Handed over now: not again for three minutes.
    expect((await sweep()).handedOver).toBe(0);
    // One that has waited eight hours (the queue's retries are over) is failed, and counts against the wake-up.
    await admin((c) => c.query(`UPDATE crove_kernel.agent_wake_delivery SET created_at = now() - interval '9 hours' WHERE id = $1`, [stored?.id]));
    expect((await sweep()).expired).toBe(1);
    expect((await deliveries(grantId))[0]).toMatchObject({ status: 'failed' });
    // Expiry is the worker's absence, not the receiver's fault: nothing counts against the wake-up.
    expect(await wakeRow(grantId)).toMatchObject({ consecutive_failures: 0, failing_since: null, enabled: true });
  });

  it('delivers through the job against the real tables: posts the stored event signed with the grant\'s secret, records it, and leaves no secret or signature in any table', async () => {
    const { grantId, secret } = await wakeUp();
    const r = await receiver(200);
    // The column only holds an https name (a CHECK), and the local receiver is plain http: this throwaway database drops that one CHECK so the job can reach it.
    await admin(async (c) => {
      const name = (await c.query(`SELECT conname FROM pg_catalog.pg_constraint WHERE conrelid = 'crove_kernel.agent_grant_wake'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%https%'`)).rows[0]?.conname as string;
      await c.query(`ALTER TABLE crove_kernel.agent_grant_wake DROP CONSTRAINT "${name}"`);
      await c.query(`UPDATE crove_kernel.agent_grant_wake SET url = $2, consecutive_failures = 3, failing_since = now() - interval '2 days' WHERE grant_id = $1`, [grantId, `http://wake.example.test:${r.port}/hook`]);
    });
    const sent: Array<{ orgId: string; id: string }> = [];
    await sweeper(() => [item(9)], sent)();
    const [stored] = await deliveries(grantId);
    const egress = { httpsOnly: false, anyPort: true, resolve: async () => [{ address: '127.0.0.1', family: 4 }], allowed: (a: string) => a === '127.0.0.1' };
    const result = await runWakeDelivery({ runtime: worker, broker: vault, egress, now: () => 1_700_000_000_000 }, { orgId, id: stored?.id as string }, { retryCount: 0, retryLimit: WAKE_RETRY_LIMIT });
    expect(result).toBe('sent');
    expect(r.seen).toHaveLength(1);
    const got = r.seen[0] as { headers: http.IncomingHttpHeaders; body: string };
    expect(got.headers['ludy-event-id']).toBe(stored?.id);
    expect(JSON.parse(got.body)).toMatchObject({ id: stored?.id, type: 'signal.fired', org: orgId, grant: grantId });
    expect(got.headers['ludy-signature']).toBe(`v1=${createHmac('sha256', secret).update(`1700000000.${got.body}`).digest('hex')}`);
    expect((await deliveries(grantId))[0]).toMatchObject({ status: 'sent', attempts: 1, last_code: 200 });
    expect(await wakeRow(grantId)).toMatchObject({ consecutive_failures: 0, failing_since: null, last_status: 'sent' });
    // Neither the clear secret nor the signature is in any table, and the audit rows of the steps carry ids and codes only.
    await admin(async (c) => {
      const tables = (await c.query(`SELECT format('%I.%I', schemaname, tablename) AS t FROM pg_catalog.pg_tables WHERE schemaname LIKE 'crove\\_%'`)).rows.map((x: { t: string }) => x.t);
      for (const table of tables) {
        for (const needle of [secret, got.headers['ludy-signature'] as string]) {
          const n = (await c.query(`SELECT count(*)::int AS n FROM ${table} x WHERE x::text LIKE '%' || $1 || '%'`, [needle])).rows[0].n as number;
          expect(n, table).toBe(0);
        }
      }
      const audit = await c.query(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command LIKE 'kernel.mcp.wake.%' AND detail::text LIKE '%' || $2 || '%'`, [orgId, stored?.id]);
      for (const row of audit.rows) expect(JSON.stringify(row.detail)).not.toMatch(/Nguy|hook|wake\.example/);
    });
  });

  it('records a failing receiver as a retry that the queue tries again, then as the final failure, and counts both against the wake-up', async () => {
    const { grantId } = await wakeUp();
    const r = await receiver(503);
    await admin(async (c) => {
      const name = (await c.query(`SELECT conname FROM pg_catalog.pg_constraint WHERE conrelid = 'crove_kernel.agent_grant_wake'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%https%'`)).rows[0]?.conname as string | undefined;
      if (name) await c.query(`ALTER TABLE crove_kernel.agent_grant_wake DROP CONSTRAINT "${name}"`);
      await c.query(`UPDATE crove_kernel.agent_grant_wake SET url = $2 WHERE grant_id = $1`, [grantId, `http://wake.example.test:${r.port}/hook`]);
    });
    const sent: Array<{ orgId: string; id: string }> = [];
    await sweeper(() => [item(10)], sent)();
    const [stored] = await deliveries(grantId);
    const egress = { httpsOnly: false, anyPort: true, resolve: async () => [{ address: '127.0.0.1', family: 4 }], allowed: (a: string) => a === '127.0.0.1' };
    await expect(runWakeDelivery({ runtime: worker, broker: vault, egress }, { orgId, id: stored?.id as string }, { retryCount: 0, retryLimit: WAKE_RETRY_LIMIT })).rejects.toThrow();
    expect((await deliveries(grantId))[0]).toMatchObject({ status: 'queued', attempts: 1, last_code: 503 });
    expect(await wakeRow(grantId)).toMatchObject({ consecutive_failures: 1, last_status: 'failed', enabled: true });
    expect(await runWakeDelivery({ runtime: worker, broker: vault, egress }, { orgId, id: stored?.id as string }, { retryCount: WAKE_RETRY_LIMIT, retryLimit: WAKE_RETRY_LIMIT })).toBe('failed');
    expect((await deliveries(grantId))[0]).toMatchObject({ status: 'failed', attempts: 2, last_code: 503 });
    expect((await wakeRow(grantId)).consecutive_failures).toBe(2);
    // A settled delivery is not sent again by a second job.
    expect(await runWakeDelivery({ runtime: worker, broker: vault, egress }, { orgId, id: stored?.id as string }, { retryCount: 1, retryLimit: WAKE_RETRY_LIMIT })).toBe('skipped');
    expect(r.seen).toHaveLength(2);
  });

  it('records a sent delivery, clears the failure counters, and drops one whose grant was revoked', async () => {
    const { grantId } = await wakeUp();
    const sent: Array<{ orgId: string; id: string }> = [];
    await sweeper(() => [item(11)], sent)();
    const [stored] = await deliveries(grantId);
    const ctx = { actor: { type: 'system' as const, component: 'test' }, orgId };
    await admin((c) => c.query(`UPDATE crove_kernel.agent_grant_wake SET consecutive_failures = 3, failing_since = now() - interval '2 days' WHERE grant_id = $1`, [grantId]));
    expect(await worker.execute('kernel.mcp.wake.record', { id: stored?.id, outcome: 'sent', code: 200 }, ctx)).toMatchObject({ recorded: true });
    expect((await deliveries(grantId))[0]).toMatchObject({ status: 'sent', attempts: 1, last_code: 200 });
    expect(await wakeRow(grantId)).toMatchObject({ consecutive_failures: 0, failing_since: null, last_status: 'sent' });
    // Settled once: a second record changes nothing.
    expect(await worker.execute('kernel.mcp.wake.record', { id: stored?.id, outcome: 'failed' }, ctx)).toMatchObject({ recorded: false });
    expect((await deliveries(grantId))[0]).toMatchObject({ status: 'sent' });
    // A new one for a grant that is revoked before it is sent is dropped by the job and counts as nothing against the wake-up.
    await stampPast(grantId, 'signals_checked_at', '6 minutes');
    await sweeper(() => [item(11), item(12)], sent)();
    const rows = await deliveries(grantId);
    expect(rows).toHaveLength(2);
    await admin((c) => c.query(`UPDATE crove_kernel.agent_grant SET revoked_at = now() WHERE id = $1`, [grantId]));
    const result = await runWakeDelivery({ runtime: worker, broker: vault }, { orgId, id: rows[1]?.id as string }, { retryCount: 0, retryLimit: WAKE_RETRY_LIMIT });
    expect(result).toBe('dropped');
    expect((await deliveries(grantId))[1]).toMatchObject({ status: 'dropped', attempts: 0 });
    // And the sweep leaves a revoked grant alone.
    await stampPast(grantId, 'signals_checked_at', '6 minutes');
    expect((await sweeper(() => [item(13)], sent)()).signals).toBe(0);
  });

  it('pauses a wake-up after seven days of failing, with the reason, and a fresh set switches it on again', async () => {
    const { grantId } = await wakeUp();
    const sent: Array<{ orgId: string; id: string }> = [];
    await sweeper(() => [item(21)], sent)();
    const [stored] = await deliveries(grantId);
    const ctx = { actor: { type: 'system' as const, component: 'test' }, orgId };
    await admin((c) => c.query(`UPDATE crove_kernel.agent_grant_wake SET failing_since = now() - interval '8 days', consecutive_failures = 50 WHERE grant_id = $1`, [grantId]));
    await worker.execute('kernel.mcp.wake.record', { id: stored?.id, outcome: 'retry', code: 503 }, ctx);
    expect(await wakeRow(grantId)).toMatchObject({ enabled: false, paused_reason: 'failing', consecutive_failures: 51, last_status: 'failed' });
    // A paused wake-up is not looked at, and its deliveries are not made.
    await stampPast(grantId, 'signals_checked_at', '6 minutes');
    expect((await sweeper(() => [item(22)], sent)()).signals).toBe(0);
    const [view] = await runtime.query<Array<{ enabled: boolean; pausedReason: string | null }>>('kernel.mcp.wake.get', { grantId }, { actor: owner(), orgId });
    expect(view).toMatchObject({ enabled: false, pausedReason: 'failing' });
    const made = makeWakeSecret(vault, orgId, grantId);
    await runtime.execute('kernel.mcp.wake.set', { grantId, url: 'https://hooks.example.com/ludy', credential: made.credential, enabled: true }, { actor: owner(), orgId });
    expect(await wakeRow(grantId)).toMatchObject({ enabled: true, paused_reason: null, consecutive_failures: 0, failing_since: null });
  });

  it('does not forget a signal when its rule did not answer in full, so it does not fire again when the rule is back', async () => {
    const { grantId } = await wakeUp();
    const sent: Array<{ orgId: string; id: string }> = [];
    let present = [item(31), item(32)];
    let complete = ['deal_without_invoice'];
    const sweep = sweeper(() => present, sent, { complete: () => complete });
    await sweep();
    expect(await deliveries(grantId)).toHaveLength(1);
    // The rule fails once: no items, and it is not in `complete`. Its keys stay seen.
    await stampPast(grantId, 'signals_checked_at', '6 minutes');
    present = [];
    complete = [];
    await sweep();
    // It answers again with the same two: nothing new fires.
    await stampPast(grantId, 'signals_checked_at', '6 minutes');
    present = [item(31), item(32)];
    complete = ['deal_without_invoice'];
    await sweep();
    expect(await deliveries(grantId)).toHaveLength(1);
    // Answering in full with one gone forgets it, and it fires again when it returns.
    await stampPast(grantId, 'signals_checked_at', '6 minutes');
    present = [item(31)];
    await sweep();
    await stampPast(grantId, 'signals_checked_at', '6 minutes');
    present = [item(31), item(32)];
    await sweep();
    expect(await deliveries(grantId)).toHaveLength(2);
  });

  it('loses nothing when storing an event fails: the signal fires on the next look, and the schedule is still due', async () => {
    const { grantId } = await wakeUp({ schedule: 'daily', minute: 480 });
    await admin((c) => c.query(`UPDATE crove_kernel.agent_grant_wake SET next_due_at = now() - interval '1 hour' WHERE grant_id = $1`, [grantId]));
    const sent: Array<{ orgId: string; id: string }> = [];
    let broken = true;
    const flaky = {
      execute: (name: string, input: unknown, ctx: unknown) => (broken && name === 'kernel.mcp.wake.enqueue' ? Promise.reject(new Error('database hiccup')) : (worker.execute as (...a: unknown[]) => Promise<unknown>)(name, input, ctx)),
      query: (...a: unknown[]) => (worker.query as (...b: unknown[]) => Promise<unknown>)(...a),
    } as unknown as Runtime;
    const sweep = sweeper(() => [item(41)], sent, { runtime: flaky });
    const first = await sweep();
    expect(first.failures).toBe(1);
    expect(await deliveries(grantId)).toEqual([]);
    expect((await wakeRow(grantId)).next_due_at.getTime()).toBeLessThan(Date.now());
    broken = false;
    await stampPast(grantId, 'signals_checked_at', '6 minutes');
    const second = await sweep();
    expect(second).toMatchObject({ failures: 0, schedules: 1, signals: 1 });
    const rows = await deliveries(grantId);
    expect(rows.map((r) => r.type).sort()).toEqual(['schedule.due', 'signal.fired']);
    expect((await wakeRow(grantId)).next_due_at.getTime()).toBeGreaterThan(Date.now());
    // A second pass finds neither due again.
    await stampPast(grantId, 'signals_checked_at', '6 minutes');
    expect(await sweep()).toMatchObject({ schedules: 0, signals: 0 });
  });

  it('asks the three rules as the grant, through the worker entry, writes no refusal against the owner, and stamps the check (the real evaluator)', async () => {
    const { grantId } = await wakeUp();
    const before = await admin((c) => c.query(`SELECT count(*)::int AS n FROM crove_kernel.security_event`).then((r) => r.rows[0].n as number));
    const queried: string[] = [];
    const spy = {
      execute: (...a: unknown[]) => (signalWorker.execute as (...b: unknown[]) => Promise<unknown>)(...a),
      query: (name: string, ...rest: unknown[]) => {
        queried.push(name);
        return (signalWorker.query as (...b: unknown[]) => Promise<unknown>)(name, ...rest);
      },
    } as unknown as Runtime;
    await stampPast(grantId, 'signals_checked_at', '6 minutes');
    const done = await runWakeSweep({ runtime: spy, workerDb, send: async () => undefined });
    expect(done.failures).toBe(0);
    expect(queried.filter((q) => q.startsWith('kernel.signals.')).sort()).toEqual([...WAKE_RULES].sort());
    expect(await admin((c) => c.query(`SELECT count(*)::int AS n FROM crove_kernel.security_event`).then((r) => r.rows[0].n as number))).toBe(before);
    expect((await wakeRow(grantId)).signals_checked_at).not.toBeNull();
  });

  it('never enters a member-bound grant: the sweep asks no rule for it and the worker entry refuses it', async () => {
    await admin((c) => c.query(`UPDATE crove_kernel.tenant SET mcp_member_grants = true WHERE org_id = $1`, [orgId]));
    const grantId = randomUUID();
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by, kind, member_id)
         VALUES ($1, $2, $3, $5, 'Test client', 'client.example.com', ARRAY['ludy.read'], $4, now(), now() + interval '30 days', $3, 'member', $3)`,
        [orgId, grantId, ownerId, `oauth-${grantId}`, `client-${grantId}`],
      ),
    );
    const made = makeWakeSecret(vault, orgId, grantId);
    await runtime.execute('kernel.mcp.wake.set', { grantId, url: 'https://hooks.example.com/ludy', credential: made.credential }, { actor: owner(), orgId });
    const queried: string[] = [];
    const spy = {
      execute: (...a: unknown[]) => (signalWorker.execute as (...b: unknown[]) => Promise<unknown>)(...a),
      query: (name: string, ...rest: unknown[]) => {
        queried.push(name);
        return (signalWorker.query as (...b: unknown[]) => Promise<unknown>)(name, ...rest);
      },
    } as unknown as Runtime;
    await stampPast(grantId, 'signals_checked_at', '6 minutes');
    await runWakeSweep({ runtime: spy, workerDb, send: async () => undefined });
    expect(queried.filter((q) => q.startsWith('kernel.signals.'))).toEqual([]);
    // Asked for directly, the worker's entry refuses a member-bound grant (no rule answers in full).
    expect((await runtimeEvaluator(signalWorker, WAKE_RULES)({ orgId, grantId, userId: ownerId })).complete).toEqual([]);
  });

  it('refuses a body that does not fit, in the command and in the database, and any actor but the system on every delivery step', async () => {
    const { grantId } = await wakeUp();
    const ctx = { actor: { type: 'system' as const, component: 'test' }, orgId };
    const id = randomUUID();
    const good = { id, type: 'ping', created_at: '2026-11-12T03:00:00.000Z', org: orgId, grant: grantId, data: {} };
    for (const body of [{ ...good, note: 'Nguyễn Văn A' }, { ...good, data: { text: 'x' } }, { ...good, org: randomUUID() }, { ...good, id: randomUUID() }, { ...good, type: 'schedule.due' }]) {
      await expect(worker.execute('kernel.mcp.wake.enqueue', { id, grantId, type: 'ping', body }, ctx), JSON.stringify(body)).rejects.toMatchObject({ status: 422 });
    }
    expect(await worker.execute('kernel.mcp.wake.enqueue', { id, grantId, type: 'ping', body: good }, ctx)).toEqual({ id, stored: true });
    // A replay of the id stores nothing.
    expect(await worker.execute('kernel.mcp.wake.enqueue', { id, grantId, type: 'ping', body: good }, ctx)).toEqual({ id, stored: false });
    // The database refuses a row written around the command.
    await expect(
      admin((c) => c.query(`INSERT INTO crove_kernel.agent_wake_delivery (org_id, id, grant_id, type, body) VALUES ($1, $2, $3, 'ping', $4::jsonb)`, [orgId, randomUUID(), grantId, JSON.stringify({ ...good, id: randomUUID(), note: 'x' })])),
    ).rejects.toThrow(/check/i);
    // A user, however privileged, runs none of the delivery steps.
    for (const [name, input] of [
      ['kernel.mcp.wake.enqueue', { id: randomUUID(), grantId, type: 'ping', body: good }],
      ['kernel.mcp.wake.queued', { id }],
      ['kernel.mcp.wake.record', { id, outcome: 'sent' }],
      ['kernel.mcp.wake.signals_check', { grantId, keys: [], complete: [] }],
    ] as const) {
      await expect(runtime.execute(name, input, { actor: owner(), orgId }), name).rejects.toMatchObject({ status: 403 });
    }
  });

  // Step S5 (#2967, #2969): the worker's runtime enters a company grant's sealed context through its own entry, and only for a wake registration that is on.
  it('runs the rules as a company grant through the worker entry, and enters nothing for a grant without a live wake-up', async () => {
    const { grantId } = await wakeUp();
    const answer = await runtimeEvaluator(signalWorker, WAKE_RULES)({ orgId, grantId, userId: ownerId });
    // A rule that answered in full is `complete`: the entry worked, the sealed read ran (nothing is flagged in an empty org).
    expect(answer.complete).toEqual(expect.arrayContaining(['deal_without_invoice', 'receivable_with_open_deal']));
    expect(answer.items).toEqual([]);
    // The grant's wake-up switched off: the worker entry refuses, so no rule answers in full and nothing is claimed.
    await admin((c) => c.query(`UPDATE crove_kernel.agent_grant_wake SET enabled = false WHERE grant_id = $1`, [grantId]));
    expect((await runtimeEvaluator(signalWorker, WAKE_RULES)({ orgId, grantId, userId: ownerId })).complete).toEqual([]);
    // A grant that never set a wake-up is no better.
    const bare = randomUUID();
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by)
         VALUES ($1, $2, $3, $5, 'Test client', 'client.example.com', ARRAY['ludy.read'], $4, now(), now() + interval '30 days', $3)`,
        [orgId, bare, ownerId, `oauth-${bare}`, `client-${bare}`],
      ),
    );
    expect((await runtimeEvaluator(signalWorker, WAKE_RULES)({ orgId, grantId: bare, userId: ownerId })).complete).toEqual([]);
  });

  it('keeps the API runtime out of the worker entry and the worker out of the API entry', async () => {
    const { grantId } = await wakeUp();
    const actor = { type: 'user' as const, userId: ownerId, aal: 'aal1' as const, mcp: { grantId, clientId: 'c', clientName: 'C', scopes: ['ludy.read'] } };
    // A runtime that took the API entry on the worker's login (no mcpEntry) is refused by the database, not by a check in the code.
    const wrong = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
    await expect(wrong.query(DEAL_WITHOUT_INVOICE_READ, {}, { actor, orgId })).rejects.toBeDefined();
    // And the other way round: the API's login holds no way into the worker entry.
    const asApp = new Runtime(createDb(pools[0] as pg.Pool), { manifests: TEST_MANIFESTS, mcpEntry: 'worker' }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
    await expect(asApp.query(DEAL_WITHOUT_INVOICE_READ, {}, { actor, orgId })).rejects.toBeDefined();
  });
});
