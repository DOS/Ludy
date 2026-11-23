// SPDX-License-Identifier: AGPL-3.0-only
// Regression tests for #4354: startWorker gates both the MINUTES_PUBLISHED_EVENT outbox relay and the QUEUES.notify
// minutes-wake branch on wakeBroker && wakeBroker.id !== 'none', while normal meeting notifications keep working.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import type { ExtractClient } from '@ludy/extract-contract';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { MINUTES_PUBLISHED_EVENT, MINUTES_WAKE_TYPE, SUMMARY_READY_KIND } from '@ludy/kernel-contract';
import { CredentialVault, Runtime, parseVaultKey, type BlobStore, type UserActor } from '@ludy/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import { noCredentialBroker } from '../src/credentials.ts';
import { jobKey } from '../src/job-keys.ts';
import { JOB_SCHEMA, QUEUES } from '../src/jobs-schema.ts';
import { makeWakeSecret } from '../src/mcp-wake-setup.ts';
import { startWorker, type WorkerDeps } from '../src/worker.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

async function until(check: () => Promise<boolean>, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

suite('minutes wake gating in startWorker (#4354)', () => {
  const dbName = `ludy_test_minutes_wake_worker_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let workerUrl = '';
  const pools: pg.Pool[] = [];
  let senderBoss: PgBoss | undefined;
  let workerDb: Db;
  let runtime: Runtime;
  let workerRuntime: Runtime;
  let orgId = '';
  let ownerId = '';
  let recorderId = '';
  let grantId = '';
  const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);

  const asUser = (userId: string): UserActor => ({ type: 'user', userId, aal: 'aal1' });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  const sqlAdmin = <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []) => admin((c) => c.query<R>(text, params));

  async function publishOrgMinutes(tag: string): Promise<{ meetingId: string; eventId: string }> {
    const meetingId = randomUUID();
    await sqlAdmin(
      `INSERT INTO ludy_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       VALUES ($1, $2, $3, 'vi', now(), now() + interval '30 minutes', 1800, $4, 'org', 'ready', 'told_at_start', $4, now(), '1.0', current_date + 30, current_date + 365)`,
      [orgId, meetingId, `Họp ${tag}`, recorderId],
    );
    await runtime.execute('meetings.summary.save', { meetingId, summary: `Tóm tắt ${tag}`, decisions: [] }, { actor: asUser(recorderId), orgId });
    await runtime.execute('meetings.result.publish', { meetingId, confirmed: true }, { actor: asUser(recorderId), orgId });
    const { rows } = await sqlAdmin<{ id: string }>(
      `SELECT id FROM ludy_kernel.outbox_event WHERE org_id = $1 AND type = $2 AND payload ->> 'meetingId' = $3 ORDER BY created_at DESC LIMIT 1`,
      [orgId, MINUTES_PUBLISHED_EVENT, meetingId],
    );
    expect(rows).toHaveLength(1);
    return { meetingId, eventId: rows[0]?.id as string };
  }

  async function emitSummaryReady(meetingId: string): Promise<string> {
    const runId = randomUUID();
    await runtime.execute('meetings.summary.ready', { meetingId, runId }, { actor: asUser(recorderId), orgId });
    return runId;
  }

  const pendingOutboxCount = async () =>
    (await sqlAdmin<{ n: number }>(`SELECT count(*)::int AS n FROM ludy_kernel.outbox_pending WHERE org_id = $1`, [orgId])).rows[0]?.n ?? 0;

  const summaryNoticeCount = async (runId: string) =>
    (
      await sqlAdmin<{ n: number }>(
        `SELECT count(*)::int AS n FROM ludy_kernel.notification WHERE org_id = $1 AND kind = $2 AND dedupe_key = $3`,
        [orgId, SUMMARY_READY_KIND, `summary:${runId}`],
      )
    ).rows[0]?.n ?? 0;

  const wakeDeliveries = () =>
    sqlAdmin<{ id: string; grant_id: string; type: string; attempts: number }>(
      `SELECT id, grant_id, type, attempts FROM ludy_kernel.agent_wake_delivery WHERE org_id = $1 AND type = $2 ORDER BY created_at, id`,
      [orgId, MINUTES_WAKE_TYPE],
    ).then((r) => r.rows);

  const mcpWakeJobs = () =>
    sqlAdmin<{ id: string; state: string; data: { orgId: string; id: string } }>(
      `SELECT id, state, data FROM ${JOB_SCHEMA}.job WHERE name = $1 AND data ->> 'orgId' = $2 ORDER BY created_on, id`,
      [QUEUES.mcpWake, orgId],
    ).then((r) => r.rows);

  const notifyJobsForEvent = (eventId: string) =>
    sqlAdmin<{ id: string; state: string }>(
      `SELECT id, state FROM ${JOB_SCHEMA}.job WHERE name = $1 AND data ->> 'orgId' = $2 AND data ->> 'eventId' = $3 ORDER BY created_on, id`,
      [QUEUES.notify, orgId, eventId],
    ).then((r) => r.rows);

  const jobState = async (jobId: string) =>
    (await sqlAdmin<{ state: string }>(`SELECT state FROM ${JOB_SCHEMA}.job WHERE id = $1`, [jobId])).rows[0]?.state ?? null;

  const runWithWorker = async (channels: WorkerDeps['channels'] | undefined, instance: string, body: () => Promise<void>) => {
    const stop = await startWorker({
      connectionString: workerUrl,
      workerDb,
      runtime: workerRuntime,
      store: { delete: async () => undefined } as unknown as BlobStore,
      extractor: null,
      extract: { concurrency: 1 } as ExtractClient,
      inboundDomain: null,
      instance,
      ...(channels ? { channels } : {}),
    });
    try {
      await body();
    } finally {
      await stop();
    }
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
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });
    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    const appPool = createPool({ connectionString: login('ludy_app', 'test-app-pw'), max: 4 });
    workerUrl = login('ludy_worker', 'test-worker-pw');
    const workerPool = createPool({ connectionString: workerUrl, max: 4 });
    pools.push(appPool, workerPool);

    const defs = { commands: [...kernelCommands, ...meetingsCommands], queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries] };
    runtime = new Runtime(createDb(appPool), { manifests: TEST_MANIFESTS }).register(defs);
    workerDb = createDb(workerPool);
    workerRuntime = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register(defs);

    const appDb = createDb(appPool);
    ownerId = await upsertIdentity(appDb, { issuer: 'minutes-wake-worker', subject: 'owner', email: 'owner@minutes-wake-worker.test', name: 'Owner' });
    recorderId = await upsertIdentity(appDb, { issuer: 'minutes-wake-worker', subject: 'recorder', email: 'recorder@minutes-wake-worker.test', name: 'Recorder' });
    orgId = (await createOrg(runtime, asUser(ownerId), 'Minutes Wake Worker')).orgId;
    await sqlAdmin(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgId, recorderId]);

    grantId = randomUUID();
    await sqlAdmin(
      `INSERT INTO ludy_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by, kind)
       VALUES ($1, $2, $3, $4, 'Test client', 'client.example.test', ARRAY['ludy.read'], $5, clock_timestamp(), now() + interval '30 days', $3, 'company')`,
      [orgId, grantId, ownerId, `client-${grantId}`, `oauth-${grantId}`],
    );
    const made = makeWakeSecret(vault, orgId, grantId);
    await runtime.execute('kernel.mcp.wake.set', { grantId, url: 'https://hooks.invalid/ludy', credential: made.credential }, { actor: asUser(ownerId), orgId });

    senderBoss = new PgBoss({ connectionString: workerUrl, schema: JOB_SCHEMA, migrate: false, createSchema: false, supervise: false, schedule: false });
    senderBoss.on('error', () => {});
    await senderBoss.start();
  }, 180_000);

  afterAll(async () => {
    await senderBoss?.stop({ graceful: false }).catch(() => {});
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  }, 60_000);

  it('skips minutes wake relay and QUEUES.notify wake handling when wakeBroker is unset, while normal meeting notifications still work', async () => {
    const { meetingId, eventId } = await publishOrgMinutes('unset');
    const runId = await emitSummaryReady(meetingId);
    const directJobId = await senderBoss?.send(
      QUEUES.notify,
      { orgId, eventId, type: MINUTES_PUBLISHED_EVENT },
      { singletonKey: jobKey(orgId, QUEUES.notify, `direct-unset:${eventId}`), retryLimit: 0 },
    );
    expect(directJobId).toBeTruthy();

    await runWithWorker(undefined, 'minutes-wake-unset', async () => {
      await until(async () => (await pendingOutboxCount()) === 0, 'outbox drained with unset wakeBroker');
      await until(async () => (await summaryNoticeCount(runId)) === 1, 'summary-ready notification created with unset wakeBroker');
      await until(async () => (await jobState(directJobId as string)) === 'completed', 'direct notify job completed with unset wakeBroker');
    });

    expect(await wakeDeliveries()).toEqual([]);
    expect(await mcpWakeJobs()).toEqual([]);
    expect((await notifyJobsForEvent(eventId)).map((j) => j.id)).toEqual([directJobId]);
  }, 45_000);

  it("skips minutes wake relay and QUEUES.notify wake handling when wakeBroker.id === 'none', while normal meeting notifications still work", async () => {
    const { meetingId, eventId } = await publishOrgMinutes('none');
    const runId = await emitSummaryReady(meetingId);
    const directJobId = await senderBoss?.send(
      QUEUES.notify,
      { orgId, eventId, type: MINUTES_PUBLISHED_EVENT },
      { singletonKey: jobKey(orgId, QUEUES.notify, `direct-none:${eventId}`), retryLimit: 0 },
    );
    expect(directJobId).toBeTruthy();

    await runWithWorker({ broker: noCredentialBroker, publishers: {} }, 'minutes-wake-none', async () => {
      await until(async () => (await pendingOutboxCount()) === 0, "outbox drained with wakeBroker.id === 'none'");
      await until(async () => (await summaryNoticeCount(runId)) === 1, "summary-ready notification created with wakeBroker.id === 'none'");
      await until(async () => (await jobState(directJobId as string)) === 'completed', "direct notify job completed with wakeBroker.id === 'none'");
    });

    expect(await wakeDeliveries()).toEqual([]);
    expect(await mcpWakeJobs()).toEqual([]);
    expect((await notifyJobsForEvent(eventId)).map((j) => j.id)).toEqual([directJobId]);
  }, 45_000);

  it('relays, stores, and enqueues minutes wake deliveries to QUEUES.mcpWake when wakeBroker is enabled, alongside normal meeting notifications', async () => {
    const { meetingId, eventId } = await publishOrgMinutes('enabled');
    const runId = await emitSummaryReady(meetingId);

    await runWithWorker({ broker: vault, publishers: {} }, 'minutes-wake-enabled', async () => {
      await until(async () => (await pendingOutboxCount()) === 0, 'outbox drained with enabled wakeBroker');
      await until(async () => (await summaryNoticeCount(runId)) === 1, 'summary-ready notification created with enabled wakeBroker');
      await until(async () => {
        const deliveries = await wakeDeliveries();
        return deliveries.length === 1 && (deliveries[0]?.attempts ?? 0) >= 1;
      }, 'minutes wake delivery stored and attempted by QUEUES.mcpWake');
    });

    const deliveries = await wakeDeliveries();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ grant_id: grantId, type: MINUTES_WAKE_TYPE });
    const wakeJobs = await mcpWakeJobs();
    expect(wakeJobs).toHaveLength(1);
    expect(wakeJobs[0]?.data).toEqual({ orgId, id: deliveries[0]?.id });
    const notifyJobs = await notifyJobsForEvent(eventId);
    expect(notifyJobs).toHaveLength(1);
    expect(notifyJobs[0]?.state).toBe('completed');
  }, 45_000);
});
