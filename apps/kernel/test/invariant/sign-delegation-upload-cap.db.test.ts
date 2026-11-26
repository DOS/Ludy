// SPDX-License-Identifier: AGPL-3.0-only
// Self-contained security invariant extracted from sign-fields-attachments.db.test.ts (#4633, #5024):
//   - P9NE: enforces the 60/hour aggregate envelope+signer upload cap across sequential delegations
//     in both HTTP /api/sign/attachment and SQL definers (public_attachment_preflight / public_record_attachment),
//     while keeping other signers on the same envelope isolated with their own 60/hour quota.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@ludy/db';
import { migrate } from '@ludy/db/migrate';
import { buildKernelCommands, createOrg, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { Runtime, contentGeneration, fileKey, putFile, sha256Hex, type BlobStore } from '@ludy/kernel-runtime';
import type { MailProvider, OutboundMail } from '@ludy/mail';
import { signCommands, signQueries } from '@ludy/mod-sign';
import { createAuthenticator } from '../../src/auth.ts';
import { AVAILABLE_MODULES, loadConfig } from '../../src/config.ts';
import { createHttpApp } from '../../src/http.ts';
import { runMailJob } from '../../src/mail-queue.ts';
import { MAIL_TEMPLATES } from '../../src/mail-templates.ts';
import { RateLimiter } from '../../src/rate-limit.ts';
import { createSessionStatusSource } from '../../src/sessions.ts';
import { SIGN_ACTOR } from '../../src/sign-worker.ts';
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
const JWT_TEST_KEY = 'sign-delegation-upload-cap-inv-jwt-key-012345';
const ISSUER = 'ludy-auth';

const pdfFixture = (tag: string): Uint8Array =>
  Uint8Array.from(
    Buffer.from(`%PDF-1.4\n% sign-del-cap-${tag}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n`, 'utf8'),
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

suite('eSign 60/hour multi-delegation upload cap invariant (#4633, #5024)', () => {
  const dbName = `ludy_test_sign_del_cap_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
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
    email: 'owner-del-cap@example.com',
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

  async function withAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = createDbClient({ connectionString: adminUrl }, dbIds);
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function ingestSignPdf(orgId: string, userId: string, sessionId: string, tag: string): Promise<string> {
    const bytes = pdfFixture(tag);
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(orgId, sha256);
    const generation = await putFile(store, storageKey, bytes, 'application/pdf', sha256);
    const res = await runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      {
        filename: `${tag}.pdf`,
        contentType: 'application/pdf',
        sizeBytes: bytes.byteLength,
        sha256,
        storageKey,
        generation,
        source: 'sign_document',
      },
      { actor: asUser(userId, sessionId), orgId, idempotencyKey: randomUUID() },
    );
    return res.fileId;
  }

  async function postMultipartAttachment(
    targetApp: ReturnType<typeof createHttpApp>,
    params: { token: string; fieldId: string; bytes: Uint8Array; filename: string; mime: string },
  ) {
    const form = new FormData();
    form.set('token', params.token);
    form.set('fieldId', params.fieldId);
    form.set(
      'file',
      new File([Buffer.from(params.bytes)], params.filename, {
        type: params.mime,
      }),
    );
    return targetApp.request('/api/sign/attachment', { method: 'POST', body: form });
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
    await setActiveRolePasswords(adminUrl, { ludy_app: 'del-cap-app-pw', ludy_worker: 'del-cap-worker-pw' }, dbIds);

    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = dbIds ? dbIds.roleName(username) : username;
      url.password = password;
      return url.toString();
    };
    appUrl = login('ludy_app', 'del-cap-app-pw');
    const workerUrl = login('ludy_worker', 'del-cap-worker-pw');

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
      name: 'Owner Del Cap',
    });
    org = await createOrg(runtime, asUser(owner.userId, owner.session), 'Delegation Cap Org');
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

  it('enforces the 60/hour aggregate envelope upload cap across sequential delegations (#4633)', async () => {
    const aggFileId = await ingestSignPdf(org.orgId, owner.userId, owner.session, 'aggregate-delegation-cap');
    const aggEnv = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      {
        title: 'Aggregate Delegation Cap Envelope',
        routingMode: 'parallel',
        allowDelegation: true,
        sourceFileId: aggFileId,
      },
      { actor: asUser(owner.userId, owner.session), orgId: org.orgId },
    );
    await workerRuntime.execute(
      'sign.envelope.inspect_complete',
      {
        envelopeId: aggEnv.envelopeId,
        outcome: 'passed',
        pageCount: 1,
        pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0 }],
        detectedTags: [],
      },
      { actor: SIGN_ACTOR, orgId: org.orgId },
    );
    const aggSigner = await runtime.execute<{ signerId: string }>(
      'sign.signer.add',
      {
        envelopeId: aggEnv.envelopeId,
        signerRole: 'signer',
        roleLabel: 'Ben ky Aggregate',
        name: 'Initial Agg Signer',
        email: 'agg-signer-0@example.com',
        deliveryMode: 'link',
        requireEmailOtp: false,
      },
      { actor: asUser(owner.userId, owner.session), orgId: org.orgId },
    );
    const aggSignerB = await runtime.execute<{ signerId: string }>(
      'sign.signer.add',
      {
        envelopeId: aggEnv.envelopeId,
        signerRole: 'signer',
        roleLabel: 'Ben ky Aggregate B',
        name: 'Second Agg Signer',
        email: 'agg-signer-b@example.com',
        deliveryMode: 'link',
        requireEmailOtp: false,
      },
      { actor: asUser(owner.userId, owner.session), orgId: org.orgId },
    );
    const aggFields = await runtime.execute<{ fieldIds: string[] }>(
      'sign.field.set',
      {
        envelopeId: aggEnv.envelopeId,
        fields: [
          {
            signerId: aggSigner.signerId,
            fieldType: 'signature',
            pageNumber: 1,
            xNorm: 0.1,
            yNorm: 0.7,
            wNorm: 0.25,
            hNorm: 0.1,
            required: true,
          },
          {
            signerId: aggSigner.signerId,
            fieldType: 'attachment',
            pageNumber: 1,
            xNorm: 0.5,
            yNorm: 0.7,
            wNorm: 0.25,
            hNorm: 0.08,
            label: 'Tai lieu dinh kem A',
            required: true,
          },
          {
            signerId: aggSignerB.signerId,
            fieldType: 'signature',
            pageNumber: 1,
            xNorm: 0.1,
            yNorm: 0.5,
            wNorm: 0.25,
            hNorm: 0.1,
            required: true,
          },
          {
            signerId: aggSignerB.signerId,
            fieldType: 'attachment',
            pageNumber: 1,
            xNorm: 0.5,
            yNorm: 0.5,
            wNorm: 0.25,
            hNorm: 0.08,
            label: 'Tai lieu dinh kem B',
            required: true,
          },
        ],
      },
      { actor: asUser(owner.userId, owner.session), orgId: org.orgId },
    );
    const aggSent = await runtime.execute<{ links: Array<{ signerId: string; token: string }> }>(
      'sign.envelope.send',
      { envelopeId: aggEnv.envelopeId },
      { actor: asUser(owner.userId, owner.session), orgId: org.orgId },
    );
    let currentToken = aggSent.links.find((l) => l.signerId === aggSigner.signerId)!.token;
    const signerBToken = aggSent.links.find((l) => l.signerId === aggSignerB.signerId)!.token;

    const aggConfig = loadConfig({
      DATABASE_URL: appUrl,
      AUTH_JWT_SECRET: JWT_TEST_KEY,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    const aggLimitApp = createHttpApp({
      config: aggConfig,
      runtime,
      store,
      authenticate: createAuthenticator(aggConfig, db),
      pool: pool!,
      aiEnabled: false,
      billing: { entitlements: async () => ['full'] },
      signLimits: {
        attachment: new RateLimiter({ perMinute: 200 }),
        tokenAttachment: new RateLimiter({ perMinute: 200 }),
      },
    });

    async function delegateAndCaptureToken(round: number, targetSignerId: string, activeToken: string): Promise<string> {
      const delRes = await app.request('/api/sign/delegate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token: activeToken,
          delegateName: `Delegate Round ${round}`,
          delegateEmail: `agg-delegate-${round}@example.com`,
          reason: `Sequential delegation round ${round}`,
        }),
      });
      expect(delRes.status).toBe(200);

      const inviteMailId = await withAdmin(async (c) => {
        const r = await c.query<{ id: string }>(
          `SELECT id FROM ludy_kernel.mail_message
           WHERE org_id = $1 AND source_id = $2 AND template_key = 'sign.invite' AND status = 'queued'
           ORDER BY created_at DESC, id DESC LIMIT 1`,
          [org.orgId, targetSignerId],
        );
        return r.rows[0]!.id;
      });
      const captured: OutboundMail[] = [];
      const captureMailer: MailProvider = {
        name: 'test_smtp',
        enabled: true,
        sendRetrySafety: 'idempotent',
        async send(mail) {
          captured.push(mail);
          return { status: 'accepted', providerMessageId: randomUUID() };
        },
        parseWebhook: () => [],
      };
      await runMailJob(
        {
          runtime: workerRuntime,
          mailer: captureMailer,
          templates: MAIL_TEMPLATES,
          publicUrl: 'http://localhost:8080',
          bounceDomain: null,
          store,
        },
        { orgId: org.orgId, messageId: inviteMailId },
      );
      expect(captured).toHaveLength(1);
      const tokenMatch = /\/-\/sign#([A-Za-z0-9_-]{43})/.exec(captured[0]!.html + '\n' + captured[0]!.text);
      expect(tokenMatch?.[1]).toBeTruthy();
      return tokenMatch![1]!;
    }

    // Signer A reaches 60 uploads total across 2 permitted delegations (20 original + 20 delegate 1 + 20 delegate 2),
    // hitting the 20/h per-recipient cap after each batch.
    for (let round = 0; round < 3; round += 1) {
      for (let i = 0; i < 20; i += 1) {
        const up = await postMultipartAttachment(aggLimitApp, {
          token: currentToken,
          fieldId: aggFields.fieldIds[1]!,
          bytes: pdfFixture(`agg-r${round}-u${i}`),
          filename: `agg-r${round}-u${i}.pdf`,
          mime: 'application/pdf',
        });
        expect(up.status).toBe(200);
      }
      const perRecipientBlocked = await postMultipartAttachment(aggLimitApp, {
        token: currentToken,
        fieldId: aggFields.fieldIds[1]!,
        bytes: pdfFixture(`agg-r${round}-overflow`),
        filename: `agg-r${round}-overflow.pdf`,
        mime: 'application/pdf',
      });
      expect(perRecipientBlocked.status).toBe(429);
      await expect(perRecipientBlocked.json()).resolves.toMatchObject({ code: 'SIGN_ATTACHMENT_RATE_LIMITED' });

      if (round < 2) {
        currentToken = await delegateAndCaptureToken(round + 1, aggSigner.signerId, currentToken);
      }
    }

    const thirdDelRes = await app.request('/api/sign/delegate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: currentToken,
        delegateName: 'Third Delegate',
        delegateEmail: 'agg-delegate-third@example.com',
        reason: 'Exceed max 2 delegations',
      }),
    });
    expect(thirdDelRes.status).toBe(409);

    // Signer B on the same envelope keeps its independent 60/h signer quota even after delegating.
    const delegateBToken = await delegateAndCaptureToken(3, aggSignerB.signerId, signerBToken);
    const signerBOk = await postMultipartAttachment(aggLimitApp, {
      token: delegateBToken,
      fieldId: aggFields.fieldIds[3]!,
      bytes: pdfFixture('agg-signer-b-ok'),
      filename: 'agg-signer-b-ok.pdf',
      mime: 'application/pdf',
    });
    expect(signerBOk.status).toBe(200);

    // Advance signer_delegated seq past all 60 uploads on Signer A so v_recent_uploads (seq > v_last_delegated_seq) = 0,
    // verifying the 60/h aggregate SQL ceiling independently blocks upload #61 in both preflight and record.
    await withAdmin(async (c) => {
      const countRes = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n
         FROM ludy_sign.signing_event
         WHERE org_id = $1 AND envelope_id = $2 AND signer_id = $3 AND event_type = 'attachment_uploaded'`,
        [org.orgId, aggEnv.envelopeId, aggSigner.signerId],
      );
      expect(Number(countRes.rows[0]?.n ?? 0)).toBe(60);

      await c.query(
        `SELECT ludy_sign.public_append_event(
           $1::uuid,
           $2::uuid,
           $3::uuid,
           'signer_delegated',
           'signer',
           'Delegate Round 2',
           (SELECT source_sha256 FROM ludy_sign.envelope WHERE org_id = $1 AND id = $2),
           '{"delegationCount": 3, "reasonProvided": true}'::jsonb,
           NULL,
           'N3AggregateCapTest/1.0',
           clock_timestamp()
         )`,
        [org.orgId, aggEnv.envelopeId, aggSigner.signerId],
      );
    });

    const aggHttpBlocked = await postMultipartAttachment(aggLimitApp, {
      token: currentToken,
      fieldId: aggFields.fieldIds[1]!,
      bytes: pdfFixture('agg-blocked-61-http'),
      filename: 'agg-blocked-61-http.pdf',
      mime: 'application/pdf',
    });
    expect(aggHttpBlocked.status).toBe(429);
    await expect(aggHttpBlocked.json()).resolves.toMatchObject({ code: 'SIGN_ATTACHMENT_RATE_LIMITED' });

    const currentTokenSha = sha256Hex(Buffer.from(currentToken, 'utf8'));
    const sqlChecks = await withAdmin(async (c) => {
      const preflight = await c.query<{ res: { status: string; code?: string; httpStatus?: number } }>(
        `SELECT ludy_sign.public_attachment_preflight($1, $2::uuid) AS res`,
        [currentTokenSha, aggFields.fieldIds[1]!],
      );
      const recordBytes = pdfFixture('agg-blocked-61-sql');
      const recordSha = sha256Hex(recordBytes);
      const recorded = await c.query<{ res: { status: string; code?: string; httpStatus?: number } }>(
        `SELECT ludy_sign.public_record_attachment(
           $1, $2::uuid, 'agg-blocked-61-sql.pdf', 'application/pdf', $3, $4, $5, $6, NULL, 'N3AggregateCapTest/1.0'
         ) AS res`,
        [currentTokenSha, aggFields.fieldIds[1]!, recordBytes.byteLength, recordSha, fileKey(org.orgId, recordSha), `content:${recordSha}`],
      );
      return { preflight: preflight.rows[0]?.res, recorded: recorded.rows[0]?.res };
    });
    expect(sqlChecks.preflight).toMatchObject({ status: 'error', code: 'SIGN_ATTACHMENT_RATE_LIMITED', httpStatus: 429 });
    expect(sqlChecks.recorded).toMatchObject({ status: 'error', code: 'SIGN_ATTACHMENT_RATE_LIMITED', httpStatus: 429 });
  }, 90_000);
});
