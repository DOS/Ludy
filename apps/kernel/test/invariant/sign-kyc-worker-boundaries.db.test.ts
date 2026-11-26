// SPDX-License-Identifier: AGPL-3.0-only
// Self-contained KYC worker authorization, recovery cursor, and re-enable race invariants (#4510, #4682, #5024):
//   - sign.kyc.touch_pending refuses non-system callers (403).
//   - ludy_sign.kyc_check_pending_recovery_idx exists and ludy_sign.kyc_work_recovery_candidates(...) enforces
//     worker-only role boundary (42501 / SIGN_RECOVERY_WORKER_ONLY), cursor/cutoff validation (22023),
//     pagination cursor ordering, and exclusion of disabled-sign / offboarding tenants.
//   - ludy_sign.kyc_has_pending_sign_enable(uuid) enforces worker-only role boundary (42501 / SIGN_RECOVERY_WORKER_ONLY)
//     across both pool privilege refusal and explicit GRANT + SET SESSION AUTHORIZATION 'ludy_app'.
//   - Re-enable vs periodic timeout race: while kernel.org.apps_changed (module='sign', enabled='true') sits undrained
//     in outbox_pending, periodic sweepSignPendingKycWork leaves overdue pending checks untouched ({ requeued: 0, timedOut: 0 });
//     draining outbox_claim(100) + apps_changed renewal sweep (bumpUpdatedAtOnRequeue: true) renews and requeues them;
//     once outbox_pending is empty again, overdue pending checks time out to needs_review.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@ludy/db';
import { migrate } from '@ludy/db/migrate';
import { buildKernelCommands, createOrg, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { Runtime, contentGeneration, fileKey, putFile, sha256Hex, type BlobStore } from '@ludy/kernel-runtime';
import { signCommands, signQueries } from '@ludy/mod-sign';
import { createAuthenticator } from '../../src/auth.ts';
import { AVAILABLE_MODULES, loadConfig } from '../../src/config.ts';
import { createHttpApp } from '../../src/http.ts';
import { createSessionStatusSource } from '../../src/sessions.ts';
import { SIGN_ACTOR, sweepSignPendingKycWork } from '../../src/sign-worker.ts';
import {
  createDbClient,
  createDbPool,
  resolveDbIdentifiers,
  setActiveRolePasswords,
  type DbIdentifiers,
} from './fixtures/db-identifiers.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const JWT_TEST_KEY = 'sign-kyc-worker-boundaries-inv-jwt-key-012345';
const ISSUER = 'ludy-auth';

const pdfFixture = (tag: string): Uint8Array =>
  Uint8Array.from(
    Buffer.from(`%PDF-1.4\n% sign-kyc-wb-${tag}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n`, 'utf8'),
  );

class MemoryStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();

  async put(key: string, bytes: Uint8Array) {
    this.blobs.set(key, bytes);
    return contentGeneration(sha256Hex(bytes));
  }

  async get(key: string) {
    const found = this.blobs.get(key);
    if (!found) throw new Error(`missing blob: ${key}`);
    return found;
  }

  async delete(key: string) {
    this.blobs.delete(key);
  }
}

const suite = ADMIN ? describe : describe.skip;

suite('eSign KYC worker authorization, recovery cursor, and re-enable race invariants (#4510, #5024)', () => {
  const dbName = `ludy_test_sign_kyc_wb_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let dbIds: DbIdentifiers | undefined;
  let pool: pg.Pool | undefined;
  let workerPool: pg.Pool | undefined;
  let db!: Db;
  let workerDb!: Db;
  let runtime!: Runtime;
  let workerRuntime!: Runtime;
  let app!: ReturnType<typeof createHttpApp>;
  const store = new MemoryStore();

  const owner = {
    subject: randomUUID(),
    email: 'owner-kyc-wb@example.com',
    session: randomUUID(),
    userId: '',
  };

  let org = { slug: '', orgId: '' };

  const asUser = (userId: string, sessionId: string) => ({
    type: 'user' as const,
    userId,
    sessionId,
    aal: 'aal1' as const,
  });

  const asMfa = (userId: string, sessionId: string) => ({
    type: 'user' as const,
    userId,
    sessionId,
    aal: 'aal2' as const,
    mfaAt: Math.floor(Date.now() / 1000),
  });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = createDbClient({ connectionString: adminUrl }, dbIds);
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function drainOutbox(): Promise<
    Array<{ type: string; payload: { module?: string; enabled?: boolean } }>
  > {
    const claimed: Array<{ type: string; payload: { module?: string; enabled?: boolean } }> = [];
    for (;;) {
      const res = await workerPool!.query<{
        type: string;
        payload: { module?: string; enabled?: boolean };
      }>(`SELECT type, payload FROM ludy_kernel.outbox_claim(100)`);
      if (res.rows.length === 0) break;
      claimed.push(...res.rows);
    }
    return claimed;
  }

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN as string });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();

    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();

    await migrate({ adminUrl, dir: MIGRATIONS });
    dbIds = await resolveDbIdentifiers(adminUrl);
    await setActiveRolePasswords(adminUrl, { ludy_app: 'kyc-wb-app-pw', ludy_worker: 'kyc-wb-worker-pw' }, dbIds);

    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = dbIds ? dbIds.roleName(username) : username;
      url.password = password;
      return url.toString();
    };
    const appUrl = login('ludy_app', 'kyc-wb-app-pw');
    const workerUrl = login('ludy_worker', 'kyc-wb-worker-pw');

    pool = createDbPool({ connectionString: appUrl, max: 6 }, dbIds);
    db = createDb(pool);
    workerPool = createDbPool({ connectionString: workerUrl, max: 4 }, dbIds);
    workerDb = createDb(workerPool);

    const kernelCmds = buildKernelCommands({ shippedModules: AVAILABLE_MODULES });
    const sharedQueries = [...kernelQueries({ inboundDomain: null }), ...signQueries];
    runtime = new Runtime(db, {
      manifests: TEST_MANIFESTS,
      sessions: createSessionStatusSource('off'),
      stepUp: 'required',
    }).register({
      commands: [...kernelCmds, ...signCommands],
      queries: sharedQueries,
    });
    runtime.validate();

    workerRuntime = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCmds, ...signCommands],
      queries: sharedQueries,
    });
    workerRuntime.validate();

    const config = loadConfig({
      DATABASE_URL: appUrl,
      AUTH_JWT_SECRET: JWT_TEST_KEY,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    const authenticate = createAuthenticator(config, db);
    app = createHttpApp({
      config,
      runtime,
      store,
      authenticate,
      pool,
      aiEnabled: false,
      billing: { entitlements: async () => ['full'] },
    });

    owner.userId = await upsertIdentity(db, {
      issuer: ISSUER,
      subject: owner.subject,
      email: owner.email,
      name: 'Owner KYC Boundary',
    });
    org = await createOrg(runtime, asUser(owner.userId, owner.session), 'KYC Worker Boundary Org');
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('enforces touch_pending auth, recovery cursor/role boundaries, kyc_has_pending_sign_enable worker-only check, and re-enable vs periodic timeout race (#4510, #5024)', async () => {
    const sourceBytes = pdfFixture('source-doc');
    const sourceSha = sha256Hex(sourceBytes);
    const sourceKey = fileKey(org.orgId, sourceSha);
    const sourceGen = await putFile(store, sourceKey, sourceBytes, 'application/pdf', sourceSha);
    const { fileId: sourceFileId } = await runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      {
        filename: 'source-doc.pdf',
        contentType: 'application/pdf',
        sizeBytes: sourceBytes.byteLength,
        sha256: sourceSha,
        storageKey: sourceKey,
        generation: sourceGen,
        source: 'sign_document',
      },
      { actor: asUser(owner.userId, owner.session), orgId: org.orgId, idempotencyKey: randomUUID() },
    );

    const env = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      {
        title: 'KYC Worker Boundary Contract',
        routingMode: 'parallel',
        sourceFileId,
      },
      { actor: asUser(owner.userId, owner.session), orgId: org.orgId },
    );
    await workerRuntime.execute(
      'sign.envelope.inspect_complete',
      {
        envelopeId: env.envelopeId,
        outcome: 'passed',
        pageCount: 1,
        pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0 }],
        detectedTags: [],
      },
      { actor: SIGN_ACTOR, orgId: org.orgId },
    );
    const signer = await runtime.execute<{ signerId: string }>(
      'sign.signer.add',
      {
        envelopeId: env.envelopeId,
        signerRole: 'signer',
        roleLabel: 'Ben ky',
        name: 'Signer KYC Boundary',
        email: 'signer-kyc-wb@example.com',
        deliveryMode: 'link',
        requireEmailOtp: false,
      },
      { actor: asUser(owner.userId, owner.session), orgId: org.orgId },
    );
    const fieldSet = await runtime.execute<{ fieldIds: string[] }>(
      'sign.field.set',
      {
        envelopeId: env.envelopeId,
        fields: [
          {
            signerId: signer.signerId,
            fieldType: 'signature',
            pageNumber: 1,
            xNorm: 0.1,
            yNorm: 0.75,
            wNorm: 0.25,
            hNorm: 0.08,
            required: true,
          },
          {
            signerId: signer.signerId,
            fieldType: 'attachment',
            pageNumber: 1,
            xNorm: 0.1,
            yNorm: 0.35,
            wNorm: 0.28,
            hNorm: 0.07,
            label: 'CCCD Boundary',
            required: true,
          },
        ],
      },
      { actor: asUser(owner.userId, owner.session), orgId: org.orgId },
    );
    const fieldId = fieldSet.fieldIds[1]!;
    const sent = await runtime.execute<{ links: Array<{ token: string }> }>(
      'sign.envelope.send',
      { envelopeId: env.envelopeId },
      { actor: asUser(owner.userId, owner.session), orgId: org.orgId },
    );
    const token = sent.links[0]!.token;

    const uploadRes = await app.request('/api/sign/attachment', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token,
        fieldId,
        filename: 'kyc-boundary.pdf',
        contentBase64: Buffer.from(pdfFixture('kyc-attachment')).toString('base64'),
      }),
    });
    expect(uploadRes.status).toBe(200);

    await runtime.execute(
      'sign.kyc.run_deterministic',
      { envelopeId: env.envelopeId, fieldId },
      { actor: asUser(owner.userId, owner.session), orgId: org.orgId },
    );

    const kycRow = await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      const updated = await c.query<{ id: string; updated_at: string }>(
        `UPDATE ludy_sign.kyc_check
            SET status = 'pending',
                updated_at = now() - interval '5 minutes'
          WHERE org_id = $1 AND field_id = $2
          RETURNING id, updated_at::text AS updated_at`,
        [org.orgId, fieldId],
      );
      await c.query('COMMIT');
      return updated.rows[0]!;
    });

    // 1. Non-system users cannot invoke sign.kyc.touch_pending.
    await expect(
      runtime.execute(
        'sign.kyc.touch_pending',
        { ids: [kycRow.id] },
        { actor: asUser(owner.userId, owner.session), orgId: org.orgId },
      ),
    ).rejects.toMatchObject({ status: 403 });

    // 2. Verify kyc_check_pending_recovery_idx, worker-only role check, cursor/cutoff validation,
    //    and exclusion of disabled-sign and non-active tenants (#4510, B1).
    const recoveryIdx = await admin((c) =>
      c.query<{ indexdef: string }>(
        `SELECT indexdef
           FROM pg_indexes
          WHERE schemaname = 'ludy_sign'
            AND tablename = 'kyc_check'
            AND indexname = 'kyc_check_pending_recovery_idx'`,
      ),
    );
    expect(recoveryIdx.rows[0]?.indexdef).toContain("status = 'pending'::text");

    await expect(
      pool!.query(`SELECT * FROM ludy_sign.kyc_work_recovery_candidates($1::timestamptz, 10, $2::uuid)`, [
        new Date(),
        org.orgId,
      ]),
    ).rejects.toMatchObject({ code: '42501' });

    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query(
        `GRANT EXECUTE ON FUNCTION ludy_sign.kyc_work_recovery_candidates(timestamptz, integer, uuid, timestamptz, uuid, uuid) TO ludy_app`,
      );
      await c.query(`SET SESSION AUTHORIZATION 'ludy_app'`);
      try {
        await expect(
          c.query(`SELECT * FROM ludy_sign.kyc_work_recovery_candidates($1::timestamptz, 10, $2::uuid)`, [
            new Date(),
            org.orgId,
          ]),
        ).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('SIGN_RECOVERY_WORKER_ONLY') });
      } finally {
        await c.query('ROLLBACK');
        await c.query('RESET SESSION AUTHORIZATION');
      }
    });

    await expect(
      workerPool!.query(
        `SELECT * FROM ludy_sign.kyc_work_recovery_candidates($1::timestamptz, 10, $2::uuid, $1::timestamptz, NULL, NULL)`,
        [new Date(), org.orgId],
      ),
    ).rejects.toMatchObject({ code: '22023', message: expect.stringContaining('SIGN_RECOVERY_INVALID_CURSOR') });

    await expect(
      workerPool!.query(`SELECT * FROM ludy_sign.kyc_work_recovery_candidates(NULL, 10, $1::uuid)`, [org.orgId]),
    ).rejects.toMatchObject({ code: '22023', message: expect.stringContaining('SIGN_CUTOFF_REQUIRED') });

    await runtime.execute(
      'kernel.org.set_app',
      { module: 'sign', enabled: false },
      { actor: asMfa(owner.userId, owner.session), orgId: org.orgId },
    );
    try {
      const disabledCandidates = await workerPool!.query<{ field_id: string }>(
        `SELECT field_id FROM ludy_sign.kyc_work_recovery_candidates($1::timestamptz, 10, $2::uuid)`,
        [new Date(), org.orgId],
      );
      expect(disabledCandidates.rows).toEqual([]);
    } finally {
      await runtime.execute(
        'kernel.org.set_app',
        { module: 'sign', enabled: true },
        { actor: asMfa(owner.userId, owner.session), orgId: org.orgId },
      );
    }

    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(`UPDATE ludy_kernel.tenant SET status = 'offboarding' WHERE org_id = $1`, [org.orgId]);
      await c.query('COMMIT');
    });
    try {
      const offboardingCandidates = await workerPool!.query<{ field_id: string }>(
        `SELECT field_id FROM ludy_sign.kyc_work_recovery_candidates($1::timestamptz, 10, $2::uuid)`,
        [new Date(), org.orgId],
      );
      expect(offboardingCandidates.rows).toEqual([]);
    } finally {
      await admin(async (c) => {
        await c.query('BEGIN');
        await c.query('SET LOCAL session_replication_role = replica');
        await c.query(`UPDATE ludy_kernel.tenant SET status = 'active' WHERE org_id = $1`, [org.orgId]);
        await c.query('COMMIT');
      });
    }

    const activeCandidates = await workerPool!.query<{ field_id: string; updated_at: string }>(
      `SELECT field_id, updated_at::text AS updated_at FROM ludy_sign.kyc_work_recovery_candidates($1::timestamptz, 10, $2::uuid)`,
      [new Date(), org.orgId],
    );
    expect(activeCandidates.rows.map((r) => r.field_id)).toEqual([fieldId]);

    const afterSelfCursor = await workerPool!.query<{ field_id: string }>(
      `SELECT field_id FROM ludy_sign.kyc_work_recovery_candidates($1::timestamptz, 10, $2::uuid, $3::timestamptz, $2::uuid, $4::uuid)`,
      [new Date(), org.orgId, activeCandidates.rows[0]!.updated_at, kycRow.id],
    );
    expect(afterSelfCursor.rows).toEqual([]);

    // 3. ludy_sign.kyc_has_pending_sign_enable(uuid) enforces worker-only 42501 for non-worker roles (#5024).
    await expect(
      pool!.query(`SELECT ludy_sign.kyc_has_pending_sign_enable($1::uuid) AS pending`, [org.orgId]),
    ).rejects.toMatchObject({ code: '42501' });

    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query(`GRANT EXECUTE ON FUNCTION ludy_sign.kyc_has_pending_sign_enable(uuid) TO ludy_app`);
      await c.query(`SET SESSION AUTHORIZATION 'ludy_app'`);
      try {
        await expect(
          c.query(`SELECT ludy_sign.kyc_has_pending_sign_enable($1::uuid) AS pending`, [org.orgId]),
        ).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('SIGN_RECOVERY_WORKER_ONLY') });
      } finally {
        await c.query('ROLLBACK');
        await c.query('RESET SESSION AUTHORIZATION');
      }
    });

    const nullOrgCheck = await workerPool!.query<{ pending: boolean }>(
      `SELECT ludy_sign.kyc_has_pending_sign_enable(NULL::uuid) AS pending`,
    );
    expect(nullOrgCheck.rows[0]?.pending).toBe(false);

    // 4. Re-enable vs periodic timeout race (#5024 item 5):
    //    Disable sign, drain earlier outbox events, backdate pending check beyond 30m timeout,
    //    then re-enable sign leaving kernel.org.apps_changed undrained in outbox_pending.
    await runtime.execute(
      'kernel.org.set_app',
      { module: 'sign', enabled: false },
      { actor: asMfa(owner.userId, owner.session), orgId: org.orgId },
    );
    await drainOutbox();

    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(
        `UPDATE ludy_sign.kyc_check
            SET status = 'pending',
                updated_at = now() - interval '45 minutes'
          WHERE org_id = $1 AND id = $2`,
        [org.orgId, kycRow.id],
      );
      await c.query('COMMIT');
    });

    await runtime.execute(
      'kernel.org.set_app',
      { module: 'sign', enabled: true },
      { actor: asMfa(owner.userId, owner.session), orgId: org.orgId },
    );

    const hasPendingEnable = await workerPool!.query<{ pending: boolean }>(
      `SELECT ludy_sign.kyc_has_pending_sign_enable($1::uuid) AS pending`,
      [org.orgId],
    );
    expect(hasPendingEnable.rows[0]?.pending).toBe(true);

    // Periodic sweep without bumpUpdatedAtOnRequeue spares the check while apps_changed is pending in outbox_pending.
    const periodicEnqueued: string[] = [];
    const periodicWhileEnablePending = await sweepSignPendingKycWork({
      workerDb,
      runtime: workerRuntime,
      orgId: org.orgId,
      olderThan: new Date(Date.now() - 60_000),
      timeoutBefore: new Date(Date.now() - 30 * 60_000),
      enqueueKycInspect: async (_oId, _eId, fId) => {
        periodicEnqueued.push(fId);
      },
    });
    expect(periodicWhileEnablePending).toEqual({ requeued: 0, timedOut: 0 });
    expect(periodicEnqueued).toEqual([]);

    const rowAfterPeriodicSkip = await admin((c) =>
      c.query<{ status: string }>(`SELECT status FROM ludy_sign.kyc_check WHERE org_id = $1 AND id = $2`, [
        org.orgId,
        kycRow.id,
      ]),
    );
    expect(rowAfterPeriodicSkip.rows[0]?.status).toBe('pending');

    // Draining outbox_claim(100) + running the apps_changed renewal sweep (bumpUpdatedAtOnRequeue: true) renews & requeues.
    const claimed = await drainOutbox();
    expect(
      claimed.some(
        (ev) =>
          ev.type === 'kernel.org.apps_changed' &&
          ev.payload.module === 'sign' &&
          ev.payload.enabled === true,
      ),
    ).toBe(true);

    const hasPendingAfterDrain = await workerPool!.query<{ pending: boolean }>(
      `SELECT ludy_sign.kyc_has_pending_sign_enable($1::uuid) AS pending`,
      [org.orgId],
    );
    expect(hasPendingAfterDrain.rows[0]?.pending).toBe(false);

    const appsChangedEnqueued: string[] = [];
    const beforeRenewMs = Date.now();
    const appsChangedSweepRes = await sweepSignPendingKycWork({
      workerDb,
      runtime: workerRuntime,
      orgId: org.orgId,
      olderThan: new Date(),
      timeoutBefore: new Date(0),
      bumpUpdatedAtOnRequeue: true,
      enqueueKycInspect: async (_oId, _eId, fId) => {
        appsChangedEnqueued.push(fId);
      },
    });
    expect(appsChangedSweepRes).toEqual({ requeued: 1, timedOut: 0 });
    expect(appsChangedEnqueued).toEqual([fieldId]);

    const renewedRow = await admin((c) =>
      c.query<{ status: string; updated_at: Date }>(
        `SELECT status, updated_at FROM ludy_sign.kyc_check WHERE org_id = $1 AND id = $2`,
        [org.orgId, kycRow.id],
      ),
    );
    expect(renewedRow.rows[0]?.status).toBe('pending');
    expect(new Date(renewedRow.rows[0]!.updated_at).getTime()).toBeGreaterThanOrEqual(beforeRenewMs - 5_000);

    // Re-backdate with empty outbox -> periodic sweep times out { requeued: 0, timedOut: 1 } -> needs_review.
    await drainOutbox();
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(
        `UPDATE ludy_sign.kyc_check
            SET status = 'pending',
                updated_at = now() - interval '45 minutes'
          WHERE org_id = $1 AND id = $2`,
        [org.orgId, kycRow.id],
      );
      await c.query('COMMIT');
    });

    const periodicTimeoutRes = await sweepSignPendingKycWork({
      workerDb,
      runtime: workerRuntime,
      orgId: org.orgId,
      olderThan: new Date(Date.now() - 60_000),
      timeoutBefore: new Date(Date.now() - 30 * 60_000),
      enqueueKycInspect: async () => {},
    });
    expect(periodicTimeoutRes).toEqual({ requeued: 0, timedOut: 1 });

    const timedOutRow = await admin((c) =>
      c.query<{ status: string; findings_json: { inspectState?: string } }>(
        `SELECT status, findings_json FROM ludy_sign.kyc_check WHERE org_id = $1 AND id = $2`,
        [org.orgId, kycRow.id],
      ),
    );
    expect(timedOutRow.rows[0]?.status).toBe('needs_review');
    expect(timedOutRow.rows[0]?.findings_json?.inspectState).toBe('failed');

    // 5. Bound kyc_has_pending_sign_enable age to 15 minutes (#5024): an undrained apps_changed event older than
    //    15 minutes (20 minutes) must return false and let periodic sweepSignPendingKycWork time out overdue checks.
    await runtime.execute(
      'kernel.org.set_app',
      { module: 'sign', enabled: false },
      { actor: asMfa(owner.userId, owner.session), orgId: org.orgId },
    );
    await drainOutbox();

    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(
        `UPDATE ludy_sign.kyc_check
            SET status = 'pending',
                updated_at = now() - interval '45 minutes'
          WHERE org_id = $1 AND id = $2`,
        [org.orgId, kycRow.id],
      );
      await c.query('COMMIT');
    });

    await runtime.execute(
      'kernel.org.set_app',
      { module: 'sign', enabled: true },
      { actor: asMfa(owner.userId, owner.session), orgId: org.orgId },
    );

    const freshEnableBeforeBackdate = await workerPool!.query<{ pending: boolean }>(
      `SELECT ludy_sign.kyc_has_pending_sign_enable($1::uuid) AS pending`,
      [org.orgId],
    );
    expect(freshEnableBeforeBackdate.rows[0]?.pending).toBe(true);

    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      const aged = await c.query(
        `UPDATE ludy_kernel.outbox_event e
            SET created_at = pg_catalog.now() - interval '20 minutes'
           FROM ludy_kernel.outbox_pending p
          WHERE p.org_id = $1
            AND e.org_id = p.org_id
            AND e.id = p.event_id
            AND e.type = 'kernel.org.apps_changed'
            AND e.payload ->> 'module' = 'sign'
            AND e.payload ->> 'enabled' = 'true'`,
        [org.orgId],
      );
      expect(aged.rowCount ?? 0).toBeGreaterThanOrEqual(1);
      await c.query('COMMIT');
    });

    const stalePendingEnable = await workerPool!.query<{ pending: boolean }>(
      `SELECT ludy_sign.kyc_has_pending_sign_enable($1::uuid) AS pending`,
      [org.orgId],
    );
    expect(stalePendingEnable.rows[0]?.pending).toBe(false);

    const staleEnablePeriodicTimeout = await sweepSignPendingKycWork({
      workerDb,
      runtime: workerRuntime,
      orgId: org.orgId,
      olderThan: new Date(Date.now() - 60_000),
      timeoutBefore: new Date(Date.now() - 30 * 60_000),
      bumpUpdatedAtOnRequeue: false,
      enqueueKycInspect: async () => {},
    });
    expect(staleEnablePeriodicTimeout).toEqual({ requeued: 0, timedOut: 1 });

    const timedOutAfterStaleEnable = await admin((c) =>
      c.query<{ status: string; findings_json: { inspectState?: string } }>(
        `SELECT status, findings_json FROM ludy_sign.kyc_check WHERE org_id = $1 AND id = $2`,
        [org.orgId, kycRow.id],
      ),
    );
    expect(timedOutAfterStaleEnable.rows[0]?.status).toBe('needs_review');
    expect(timedOutAfterStaleEnable.rows[0]?.findings_json?.inspectState).toBe('failed');
  }, 60_000);
});
