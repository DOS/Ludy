// SPDX-License-Identifier: AGPL-3.0-only
// PostgreSQL 17 end-to-end integration tests for eSign Slice 6d (#4723):
//   1. Admin deposit_profile CRUD, role guard, PNG/file source checks, and payment audit redaction
//   2. Hard confidentiality block (hr_contract & meeting_minutes) in command, RLS, and DB triggers
//   3. Send-time immutable snapshot freeze & post-send/post-freeze immutability even if org profile changes/clears
//   4. Non-blocking post-sign /api/sign/submit, /api/sign/view reopen, /api/sign/deposit-qr, /api/sign/deposit-notice, MODULE_OFF 404
//   5. Ludy Accounting match bridge (finance.bank.sign_deposit_match + bank/signDepositExplain, whole-token CK-* matching, zero auto-posting)
//   6. ludy_kernel.org_purge cleanup of envelope_deposit and deposit_profile
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import type { ExtractClient } from '@ludy/extract-contract';
import { buildKernelCommands, kernelQueries } from '@ludy/kernel';
import { normalizeStatementAmount, SIGN_DEPOSIT_PROOF_MAX_BYTES, type BankSignDepositMatch } from '@ludy/kernel-contract';
import { Runtime, fileKey, sha256Hex, type BlobStore } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import { pngCrc32, signCommands, signQueries } from '@ludy/mod-sign';
import { createAuthenticator } from '../src/auth.ts';
import { AVAILABLE_MODULES, loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { orgPurgeCommand, runOrgPurge } from '../src/org-purge.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { runSignPdfInspectJob } from '../src/sign-worker.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const JWT_SIGNING_KEY = 'test-only-jwt-key-for-sign-deposit-4723-0123456789abcdef';
const ISSUER = 'crove-auth';

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const TINY_PNG_BYTES = Uint8Array.from(Buffer.from(TINY_PNG_BASE64, 'base64'));
const PROOF_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const PROOF_PNG_BYTES = Uint8Array.from(Buffer.from(PROOF_PNG_BASE64, 'base64'));

function buildNoIdatPng(): Uint8Array<ArrayBuffer> {
  const magic = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const out = Buffer.alloc(12 + data.byteLength);
    out.writeUInt32BE(data.byteLength, 0);
    out.write(type, 4, 4, 'latin1');
    Buffer.from(data).copy(out, 8);
    out.writeUInt32BE(pngCrc32(out, 4, 8 + data.byteLength), 8 + data.byteLength);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const merged = Buffer.concat([magic, chunk('IHDR', ihdr), chunk('IEND', new Uint8Array(0))]);
  const out = new Uint8Array(new ArrayBuffer(merged.byteLength));
  out.set(merged);
  return out;
}
const NO_IDAT_PNG_BYTES = buildNoIdatPng();

class MemoryStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();

  async put(key: string, bytes: Uint8Array) {
    this.blobs.set(key, bytes);
    return `content:${sha256Hex(bytes)}`;
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

interface Account {
  subject: string;
  email: string;
  session: string;
  userId: string;
}

const pdfFixture = (tag: string) =>
  Uint8Array.from(
    Buffer.from(`%PDF-1.4\n% sign-dep-${tag}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n`, 'utf8'),
  );

const mockExtract: ExtractClient = {
  async extract(kind) {
    if (kind === 'pdf_inspect') {
      return {
        ok: true,
        kind: 'pdf_inspect',
        pageCount: 1,
        pages: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0 }],
      } as never;
    }
    throw new Error(`Unexpected extract kind: ${kind}`);
  },
};

const suite = ADMIN ? describe : describe.skip;

suite('eSign Slice 6d post-sign VietQR deposit & accounting bridge (#4723)', () => {
  const dbName = `ludy_test_sign_dep_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let workerPool: pg.Pool;
  let workerDb: Db;
  let runtime: Runtime;
  let workerRuntime: Runtime;
  let app: ReturnType<typeof createHttpApp>;
  const store = new MemoryStore();

  const owner: Account = { subject: randomUUID(), email: 'owner-dep@example.com', session: randomUUID(), userId: '' };
  const member: Account = { subject: randomUUID(), email: 'member-dep@example.com', session: randomUUID(), userId: '' };
  const viewer: Account = { subject: randomUUID(), email: 'viewer-dep@example.com', session: randomUUID(), userId: '' };

  let org = { slug: '', orgId: '' };
  let purgeOrg = { slug: '', orgId: '' };

  const asUser = (who: Account) => ({
    type: 'user' as const,
    userId: who.userId,
    sessionId: who.session,
    aal: 'aal1' as const,
  });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function tokenFor(who: Account, options: { mfa?: boolean } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const mfa = options.mfa ? { aal: 'aal2', amr: [{ method: 'totp', timestamp: now }] } : {};
    return new SignJWT({
      role: 'authenticated',
      email: who.email,
      session_id: who.session,
      aal: 'aal1',
      is_anonymous: false,
      ...mfa,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(who.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(JWT_SIGNING_KEY));
  }

  async function rpc(path: string, who: Account, input: unknown, slug: string | null = org.slug) {
    const response = await app.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await tokenFor(who)}`,
        'content-type': 'application/json',
        ...(slug ? { 'x-ludy-org': slug } : {}),
      },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json().catch(() => null)) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as Record<string, unknown> };
  }

  async function uploadSignPdfFor(who: Account, tag: string, slug = org.slug): Promise<string> {
    const form = new FormData();
    form.append('file', new File([Buffer.from(pdfFixture(tag))], `${tag}.pdf`, { type: 'application/pdf' }));
    form.append('purpose', 'sign_document');
    const res = await app.request('/api/files', {
      method: 'POST',
      headers: { authorization: `Bearer ${await tokenFor(who)}`, 'x-ludy-org': slug },
      body: form,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: Array<{ fileId: string }> };
    return body.files[0]!.fileId;
  }

  async function createInspectedDraft(
    who: Account,
    opts: { title: string; sourceKind?: 'standalone' | 'hr_contract' | 'meeting_minutes'; sourceId?: string | null; targetOrg?: { slug: string; orgId: string } },
  ): Promise<string> {
    const targetOrg = opts.targetOrg ?? org;
    const fileId = await uploadSignPdfFor(who, opts.title.replace(/\s+/g, '-').toLowerCase(), targetOrg.slug);
    const sourceKind = opts.sourceKind ?? 'standalone';
    const created = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      {
        title: opts.title,
        routingMode: 'parallel',
        sourceFileId: fileId,
        sourceKind,
        ...(opts.sourceId ? { sourceId: opts.sourceId } : sourceKind !== 'standalone' ? { sourceId: randomUUID() } : {}),
      },
      { actor: asUser(who), orgId: targetOrg.orgId },
    );
    await runSignPdfInspectJob(
      { workerDb, runtime: workerRuntime, store, extract: mockExtract },
      { orgId: targetOrg.orgId, envelopeId: created.envelopeId },
    );
    return created.envelopeId;
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
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });

    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    appUrl = login('ludy_app', 'test-app-pw');
    workerUrl = login('ludy_worker', 'test-worker-pw');
    pool = createPool({ connectionString: appUrl, max: 6 });
    db = createDb(pool);
    workerPool = createPool({ connectionString: workerUrl, max: 4 });
    workerDb = createDb(workerPool);

    const kernelCmds = buildKernelCommands({ shippedModules: AVAILABLE_MODULES });
    const sharedCommands = [...kernelCmds, ...signCommands, ...financeCommands, ...meetingsCommands];
    const sharedQueries = [...kernelQueries({ inboundDomain: null }), ...signQueries, ...financeQueries, ...meetingsQueries];
    runtime = new Runtime(db, {
      manifests: TEST_MANIFESTS,
      sessions: createSessionStatusSource('off'),
      stepUp: 'required',
    }).register({
      commands: sharedCommands,
      queries: sharedQueries,
    });

    workerRuntime = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register({
      commands: [...sharedCommands, orgPurgeCommand({ store })],
      queries: sharedQueries,
    });

    const config = loadConfig({
      DATABASE_URL: appUrl,
      AUTH_JWT_SECRET: JWT_SIGNING_KEY,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    const authenticate = createAuthenticator(config, db);
    app = createHttpApp({ config, runtime, store, authenticate, pool, aiEnabled: false });

    for (const who of [owner, member, viewer]) {
      const me = await rpc('me/get', who, undefined, null);
      expect(me.status).toBe(200);
      who.userId = String(me.body.userId);
    }

    const created = await rpc('org/create', owner, { name: 'Sign Deposit Org', idempotencyKey: randomUUID() }, null);
    expect(created.status).toBe(200);
    org = { slug: String(created.body.slug), orgId: String(created.body.orgId) };

    for (const [acct, role] of [
      [member, 'member'],
      [viewer, 'viewer'],
    ] as const) {
      const invite = await app.request('/api/rpc/org/invite', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await tokenFor(owner, { mfa: true })}`,
          'content-type': 'application/json',
          'x-ludy-org': org.slug,
        },
        body: JSON.stringify({ json: { email: acct.email, role } }),
      });
      expect(invite.status).toBe(200);
      const invBody = ((await invite.json()) as { json: { acceptPath: string } }).json;
      expect((await rpc('invites/accept', acct, { token: invBody.acceptPath.split('#')[1] }, null)).status).toBe(200);
    }

    const createdPurge = await rpc('org/create', owner, { name: 'Purge Deposit Org', idempotencyKey: randomUUID() }, null);
    expect(createdPurge.status).toBe(200);
    purgeOrg = { slug: String(createdPurge.body.slug), orgId: String(createdPurge.body.orgId) };
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

  it('enforces admin-only deposit profile CRUD, PNG validation, file source isolation, and payment audit redaction', async () => {
    // Member cannot upsert deposit profile
    const memberTry = await rpc('sign/depositProfile/upsert', member, {
      bankCode: 'vcb',
      accountNumber: '0123456789',
      accountHolder: 'CONG TY TEST',
    });
    expect(memberTry.status).toBe(403);
    expect(memberTry.body.code).toBe('FORBIDDEN');

    // Invalid PNG rejected
    const badPng = await rpc('sign/depositProfile/upsert', owner, {
      bankCode: 'vcb',
      accountNumber: '0123456789',
      accountHolder: 'CONG TY TEST',
      vietqrPngBase64: Buffer.from('not-a-png').toString('base64'),
    });
    expect(badPng.status).toBe(422);
    expect(badPng.body.code).toBe('SIGN_INVALID_SIGNATURE_PNG');

    // Owner upserts valid default profile with custom bank display name & inline PNG
    const upsertRes = await rpc('sign/depositProfile/upsert', owner, {
      bankCode: 'vcb',
      bankName: 'Ngan hang Ngoai thuong Vietcombank - CN HCM',
      accountNumber: '0123456789',
      accountHolder: 'CONG TY TNHH TEST DEPOSIT',
      financeBankAccount: '1121',
      vietqrPngBase64: TINY_PNG_BASE64,
    });
    expect(upsertRes.status, JSON.stringify(upsertRes.body)).toBe(200);
    expect(upsertRes.body.bankCode).toBe('VCB');
    expect(upsertRes.body.bankName).toBe('Ngan hang Ngoai thuong Vietcombank - CN HCM');
    expect(upsertRes.body.hasQrPng).toBe(true);
    expect(typeof upsertRes.body.vietqrFileId).toBe('string');
    const qrFileId = String(upsertRes.body.vietqrFileId);

    // VietQR file uses isolated 'sign_deposit_qr' source (never OCR-extracted or Finance Inbox)
    await admin(async (c) => {
      const fileRows = await c.query<{ source: string }>(
        `SELECT source FROM ludy_kernel.file WHERE org_id = $1 AND id = $2`,
        [org.orgId, qrFileId],
      );
      expect(fileRows.rows[0]?.source).toBe('sign_deposit_qr');
      const extRows = await c.query<{ id: string }>(
        `SELECT id FROM ludy_kernel.extraction WHERE org_id = $1 AND file_id = $2`,
        [org.orgId, qrFileId],
      );
      expect(extRows.rows).toHaveLength(0);
    });

    // Member can read profile read-only and download QR file; viewer gets 404 on QR file
    const memberGet = await rpc('sign/depositProfile/get', member, {});
    expect(memberGet.status).toBe(200);
    expect(memberGet.body.canEdit).toBe(false);
    expect((memberGet.body.profile as Record<string, unknown>).accountNumber).toBe('0123456789');

    const memberQrDownload = await app.request(`/api/files/${qrFileId}`, {
      headers: { authorization: `Bearer ${await tokenFor(member)}`, 'x-ludy-org': org.slug },
    });
    expect(memberQrDownload.status).toBe(200);

    const viewerQrDownload = await app.request(`/api/files/${qrFileId}`, {
      headers: { authorization: `Bearer ${await tokenFor(viewer)}`, 'x-ludy-org': org.slug },
    });
    expect(viewerQrDownload.status).toBe(404);

    // Owner cannot link another member's private unattached sign_document PNG via vietqrFileId (opaque 404)
    const privateBytes = Buffer.concat([TINY_PNG_BYTES, Buffer.from('priv')]);
    const privateSha = sha256Hex(privateBytes);
    const privateKey = fileKey(org.orgId, privateSha);
    const privateGen = await store.put(privateKey, privateBytes);
    const privateFile = await runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      {
        filename: 'private-member-doc.png',
        contentType: 'image/png',
        sizeBytes: privateBytes.byteLength,
        sha256: privateSha,
        storageKey: privateKey,
        generation: privateGen,
        source: 'sign_document',
      },
      { actor: asUser(member), orgId: org.orgId },
    );
    const linkPrivateTry = await rpc('sign/depositProfile/upsert', owner, {
      bankCode: 'vcb',
      accountNumber: '0123456789',
      accountHolder: 'CONG TY TNHH TEST DEPOSIT',
      vietqrFileId: privateFile.fileId,
    });
    expect(linkPrivateTry.status).toBe(404);
    expect(linkPrivateTry.body.code).toBe('SIGN_DEPOSIT_QR_FILE_INVALID');

    // Audit event redacts payment account_number, account_holder, and bank_code
    await admin(async (c) => {
      const { rows } = await c.query<{ detail: Record<string, unknown> }>(
        `SELECT detail FROM ludy_kernel.audit_event
         WHERE org_id = $1 AND command = 'sign.deposit_profile.upsert'
         ORDER BY occurred_at DESC LIMIT 1`,
        [org.orgId],
      );
      expect(rows).toHaveLength(1);
      const serialized = JSON.stringify(rows[0]!.detail);
      expect(serialized).not.toContain('0123456789');
      expect(serialized).not.toContain('CONG TY TNHH TEST DEPOSIT');
      expect(serialized).not.toContain('"bank_code":"VCB"');
    });

    // Member cannot clear deposit profile
    const memberClear = await rpc('sign/depositProfile/clear', member, {});
    expect(memberClear.status).toBe(403);
    expect(memberClear.body.code).toBe('FORBIDDEN');
  });

  it('hard-blocks hr_contract and meeting_minutes deposits at command, RLS, and SQL trigger layers', async () => {
    const profileCheck = await rpc('sign/depositProfile/get', owner, {});
    expect(profileCheck.status).toBe(200);
    if (!(profileCheck.body.profile as { vietqrFileId?: string | null } | null)?.vietqrFileId) {
      const seededProfile = await rpc('sign/depositProfile/upsert', owner, {
        bankCode: 'vcb',
        accountNumber: '0123456789',
        accountHolder: 'CONG TY TNHH TEST DEPOSIT',
        vietqrPngBase64: TINY_PNG_BASE64,
      });
      expect(seededProfile.status, JSON.stringify(seededProfile.body)).toBe(200);
    }
    const hrEnvId = await createInspectedDraft(owner, { title: 'HR Contract Confidential', sourceKind: 'hr_contract' });
    const mtgCreated = await runtime.execute<{ meetingId: string }>(
      'meetings.meeting.create',
      { title: 'Confidential Board Deposit Session', visibility: 'org', consentMethod: 'told_at_start' },
      { actor: asUser(owner), orgId: org.orgId },
    );
    await runtime.execute(
      'meetings.summary.save',
      {
        meetingId: mtgCreated.meetingId,
        summary: 'Approved confidentiality boundary.',
        decisions: ['Approved'],
      },
      { actor: asUser(owner), orgId: org.orgId },
    );
    await runtime.execute(
      'meetings.result.publish',
      { meetingId: mtgCreated.meetingId, confirmed: true },
      { actor: asUser(owner), orgId: org.orgId },
    );
    await admin((c) => c.query('UPDATE ludy_kernel.tenant SET meeting_minutes_esign = true WHERE org_id = $1::uuid', [org.orgId]));
    const mmEnvId = await createInspectedDraft(owner, {
      title: 'Meeting Minutes Confidential',
      sourceKind: 'meeting_minutes',
      sourceId: mtgCreated.meetingId,
    });

    for (const envId of [hrEnvId, mmEnvId]) {
      const cmdTry = await rpc('sign/deposit/set', owner, {
        envelopeId: envId,
        amount: '5000000',
        memoToken: 'CK-HRBLOCK1',
      });
      expect(cmdTry.status, `${envId}: ${JSON.stringify(cmdTry.body)}`).toBe(403);
      expect(cmdTry.body.code).toBe('SIGN_CONFIDENTIAL_DEPOSIT_FORBIDDEN');

      // Direct admin SQL trigger blocks confidential envelope_deposit inserts too
      await admin(async (c) => {
        await expect(
          c.query(
            `INSERT INTO ludy_sign.envelope_deposit (org_id, id, envelope_id, amount, currency, memo_token, created_by)
             VALUES ($1, $2, $3, 5000000, 'VND', 'CK-SQLBLK1', $4)`,
            [org.orgId, randomUUID(), envId, owner.userId],
          ),
        ).rejects.toThrow(/SIGN_CONFIDENTIAL_DEPOSIT_FORBIDDEN/);
      });
    }

    // Tenant SQL triggers block spoofed storage keys and confidential files on deposit_profile
    const hrFileRow = await admin(async (c) => {
      const { rows } = await c.query<{
        id: string;
        storage_key: string;
        generation: string;
        sha256: string;
      }>(
        `SELECT f.id, f.storage_key, f.generation, f.sha256
         FROM ludy_sign.envelope e
         JOIN ludy_kernel.file f ON f.org_id = e.org_id AND f.id = e.source_file_id
         WHERE e.org_id = $1 AND e.id = $2`,
        [org.orgId, hrEnvId],
      );
      return rows[0]!;
    });
    const qrRow = await admin(async (c) => {
      const { rows } = await c.query<{ id: string; storage_key: string; generation: string; sha256: string }>(
        `SELECT f.id, f.storage_key, f.generation, f.sha256
         FROM ludy_sign.deposit_profile dp
         JOIN ludy_kernel.file f ON f.org_id = dp.org_id AND f.id = dp.vietqr_file_id
         WHERE dp.org_id = $1 LIMIT 1`,
        [org.orgId],
      );
      return rows[0]!;
    });
    const spoofClient = await pool.connect();
    try {
      await spoofClient.query('BEGIN');
      await spoofClient.query('SELECT ludy_kernel.enter_context($1::uuid, $2::uuid)', [owner.userId, org.orgId]);
      await expect(
        spoofClient.query(
          `UPDATE ludy_sign.deposit_profile
           SET vietqr_file_id = $1, vietqr_storage_key = 'org/other/evil.png', vietqr_generation = $2, vietqr_sha256 = $3
           WHERE org_id = $4`,
          [qrRow.id, qrRow.generation, qrRow.sha256, org.orgId],
        ),
      ).rejects.toThrow(/SIGN_DEPOSIT_QR_FILE_INVALID/);
      await spoofClient.query('ROLLBACK');

      await spoofClient.query('BEGIN');
      await spoofClient.query('SELECT ludy_kernel.enter_context($1::uuid, $2::uuid)', [owner.userId, org.orgId]);
      await expect(
        spoofClient.query(
          `UPDATE ludy_sign.deposit_profile
           SET vietqr_file_id = $1, vietqr_storage_key = $2, vietqr_generation = $3, vietqr_sha256 = $4
           WHERE org_id = $5`,
          [hrFileRow.id, hrFileRow.storage_key, hrFileRow.generation, hrFileRow.sha256, org.orgId],
        ),
      ).rejects.toThrow(/SIGN_DEPOSIT_QR_FILE_INVALID|SIGN_INVALID_SIGNATURE_PNG|SIGN_CONFIDENTIAL_DEPOSIT_FORBIDDEN/);
      await spoofClient.query('ROLLBACK');
    } finally {
      spoofClient.release();
    }
  });

  it('freezes immutable snapshot on send, supports public QR/notice/reopen & MODULE_OFF 404, and bridges Ludy Accounting without auto-posting', async () => {
    // Ensure org has clean profile for send freeze
    const up3 = await rpc('sign/depositProfile/upsert', owner, {
      bankCode: 'vcb',
      accountNumber: '0999888777',
      accountHolder: 'CONG TY FROZEN TEST',
      financeBankAccount: '1121',
      vietqrPngBase64: TINY_PNG_BASE64,
    });
    expect(up3.status, JSON.stringify(up3.body)).toBe(200);

    const draftEnvId = await createInspectedDraft(member, { title: 'Hop dong thiet ke website' });
    const noDepositEnvId = await createInspectedDraft(member, { title: 'Hop dong khong coc' });

    // Fractional VND deposit amounts are rejected at command layer and SQL CHECK constraint (BLOCK-4)
    const fractionalRes = await rpc('sign/deposit/set', member, {
      envelopeId: draftEnvId,
      amount: '1000.5',
      memoToken: 'CK-FRACT1',
    });
    expect(fractionalRes.status).toBe(422);
    expect(fractionalRes.body.code).toBe('SIGN_DEPOSIT_INVALID_AMOUNT');

    const setRes = await rpc('sign/deposit/set', member, {
      envelopeId: draftEnvId,
      amount: '5000000',
      dueDays: 3,
      memoToken: 'CK-DEPOSIT1',
      note: 'Chuyen coc 50% theo hop dong',
    });
    expect(setRes.status, JSON.stringify(setRes.body)).toBe(200);
    expect(setRes.body.amount).toBe('5000000');
    expect(setRes.body.memoToken).toBe('CK-DEPOSIT1');

    await admin(async (c) => {
      await c.query('BEGIN');
      await expect(
        c.query(
          `UPDATE ludy_sign.envelope_deposit SET amount = 1000.5000 WHERE org_id = $1 AND envelope_id = $2`,
          [org.orgId, draftEnvId],
        ),
      ).rejects.toThrow(/envelope_deposit_vnd_integer_ck/);
      await c.query('ROLLBACK');
    });

    // Member SQL callers cannot pre-freeze snapshot_* or inject signer_proof_file_id on draft envelope_deposit (BLOCK-2)
    const draftSpoofClient = await pool.connect();
    try {
      const profileQr = await admin(async (c) => {
        const { rows } = await c.query<{ vietqr_file_id: string; vietqr_generation: string; vietqr_sha256: string }>(
          `SELECT vietqr_file_id, vietqr_generation, vietqr_sha256 FROM ludy_sign.deposit_profile WHERE org_id = $1 LIMIT 1`,
          [org.orgId],
        );
        return rows[0]!;
      });
      await draftSpoofClient.query('BEGIN');
      await draftSpoofClient.query('SELECT ludy_kernel.enter_context($1::uuid, $2::uuid)', [member.userId, org.orgId]);
      await expect(
        draftSpoofClient.query(
          `UPDATE ludy_sign.envelope_deposit
           SET snapshot_frozen_at = now(),
               snapshot_bank_code = 'VCB',
               snapshot_bank_name = 'Vietcombank',
               snapshot_account_number = '0999888777',
               snapshot_account_holder = 'SPOOF',
               snapshot_vietqr_file_id = $1,
               snapshot_vietqr_storage_key = 'other-org/files/spoof',
               snapshot_vietqr_generation = $2,
               snapshot_vietqr_sha256 = $3
           WHERE org_id = $4 AND envelope_id = $5`,
          [profileQr.vietqr_file_id, profileQr.vietqr_generation, profileQr.vietqr_sha256, org.orgId, draftEnvId],
        ),
      ).rejects.toThrow(/SIGN_DEPOSIT_SYSTEM_ONLY/);
      await draftSpoofClient.query('ROLLBACK');

      await draftSpoofClient.query('BEGIN');
      await draftSpoofClient.query('SELECT ludy_kernel.enter_context($1::uuid, $2::uuid)', [member.userId, org.orgId]);
      await expect(
        draftSpoofClient.query(
          `UPDATE ludy_sign.envelope_deposit
           SET signer_proof_file_id = $1, signer_proof_filename = 'spoof.png', signer_proof_sha256 = $2
           WHERE org_id = $3 AND envelope_id = $4`,
          [profileQr.vietqr_file_id, profileQr.vietqr_sha256, org.orgId, draftEnvId],
        ),
      ).rejects.toThrow(/SIGN_DEPOSIT_SYSTEM_ONLY/);
      await draftSpoofClient.query('ROLLBACK');
    } finally {
      draftSpoofClient.release();
    }

    // Add approvers & send both envelopes
    await runtime.execute(
      'sign.signer.add',
      { envelopeId: draftEnvId, signerRole: 'approver', name: 'Nguyen Van A', deliveryMode: 'link', requireEmailOtp: false },
      { actor: asUser(member), orgId: org.orgId },
    );
    await runtime.execute(
      'sign.signer.add',
      { envelopeId: noDepositEnvId, signerRole: 'approver', name: 'Nguyen Van B', deliveryMode: 'link', requireEmailOtp: false },
      { actor: asUser(member), orgId: org.orgId },
    );

    const sentWithDep = await runtime.execute<{ links: Array<{ token: string }> }>(
      'sign.envelope.send',
      { envelopeId: draftEnvId },
      { actor: asUser(member), orgId: org.orgId },
    );
    const detailRightAfterSend = await rpc('sign/envelope/get', member, { envelopeId: draftEnvId });
    expect(detailRightAfterSend.status).toBe(200);
    const snapshotFrozenAt = (detailRightAfterSend.body.deposit as { snapshotFrozenAt: string | null }).snapshotFrozenAt;
    expect(typeof snapshotFrozenAt === 'string' && snapshotFrozenAt.length > 0 && !Number.isNaN(Date.parse(snapshotFrozenAt))).toBe(true);
    const sentNoDep = await runtime.execute<{ links: Array<{ token: string }> }>(
      'sign.envelope.send',
      { envelopeId: noDepositEnvId },
      { actor: asUser(member), orgId: org.orgId },
    );
    const depToken = sentWithDep.links[0]!.token;
    const noDepToken = sentNoDep.links[0]!.token;

    // Prepare a draft envelope with a deposit before clearing the org profile so BLOCKER-1 SQL tests
    // have an active deposit_profile when checking draft pre-freeze and non-system EMVCo payload rejection
    const draftPreFreezeEnvId = await createInspectedDraft(owner, { title: 'Draft Pre-Freeze Guard Env' });
    const setPreFreeze = await rpc('sign/deposit/set', owner, {
      envelopeId: draftPreFreezeEnvId,
      amount: '1500000',
      memoToken: 'CK-PREFRZ1',
    });
    expect(setPreFreeze.status, JSON.stringify(setPreFreeze.body)).toBe(200);

    const preClearClient = await pool.connect();
    try {
      await preClearClient.query('BEGIN');
      await preClearClient.query('SELECT ludy_kernel.enter_context($1::uuid, $2::uuid)', [member.userId, org.orgId]);
      await expect(
        preClearClient.query(
          `SELECT ludy_sign.freeze_envelope_deposit_snapshot($1::uuid, $2::uuid, NULL, $3::uuid, now())`,
          [org.orgId, draftPreFreezeEnvId, member.userId],
        ),
      ).rejects.toThrow(/SIGN_DEPOSIT_FROZEN/);
      await preClearClient.query('ROLLBACK');

      await admin(async (c) => {
        await c.query(
          `UPDATE ludy_sign.envelope SET status = 'sent', sent_at = now() WHERE org_id = $1 AND id = $2`,
          [org.orgId, draftPreFreezeEnvId],
        );
      });
      await preClearClient.query('BEGIN');
      await preClearClient.query('SELECT ludy_kernel.enter_context($1::uuid, $2::uuid)', [member.userId, org.orgId]);
      const forgedEmvco =
        '00020101021238540010A00000072701240006970436011001234567890208QRIBFTTA53037045802VN62130809CK-PREFRZ16304ABCD';
      const emvcoRes = await preClearClient.query<{ freeze_envelope_deposit_snapshot: { frozen?: boolean; error?: string } }>(
        `SELECT ludy_sign.freeze_envelope_deposit_snapshot($1::uuid, $2::uuid, $3, $4::uuid, now()) AS freeze_envelope_deposit_snapshot`,
        [org.orgId, draftPreFreezeEnvId, forgedEmvco, member.userId],
      );
      expect(emvcoRes.rows[0]?.freeze_envelope_deposit_snapshot).toEqual({
        frozen: false,
        error: 'SIGN_DEPOSIT_EMVCO_INVALID',
      });
      const afterEmvco = await preClearClient.query<{ snapshot_emvco_payload: string | null }>(
        `SELECT snapshot_emvco_payload FROM ludy_sign.envelope_deposit WHERE org_id = $1 AND envelope_id = $2`,
        [org.orgId, draftPreFreezeEnvId],
      );
      expect(afterEmvco.rows[0]?.snapshot_emvco_payload).toBeNull();
      await preClearClient.query('ROLLBACK');
    } finally {
      preClearClient.release();
      await admin(async (c) => {
        await c.query(`DELETE FROM ludy_sign.envelope_deposit WHERE org_id = $1 AND envelope_id = $2`, [
          org.orgId,
          draftPreFreezeEnvId,
        ]);
      });
    }

    // Verify snapshot frozen cleanly; clearing org profile must NOT mutate sent envelope snapshot!
    const clearProfile = await rpc('sign/depositProfile/clear', owner, {});
    expect(clearProfile.status).toBe(200);
    expect(clearProfile.body.cleared).toBe(true);

    const detailAfterClear = await rpc('sign/envelope/get', member, { envelopeId: draftEnvId });
    expect(detailAfterClear.status).toBe(200);
    const frozen = detailAfterClear.body.deposit as Record<string, unknown>;
    expect(frozen.snapshotFrozenAt).toBe(snapshotFrozenAt);
    expect(frozen.snapshotAccountNumber).toBe('0999888777');
    expect(frozen.snapshotAccountHolder).toBe('CONG TY FROZEN TEST');
    expect(frozen.snapshotFinanceBankAccount).toBe('1121');
    expect(typeof frozen.snapshotVietqrFileId).toBe('string');

    // Post-send edits rejected at command and SQL trigger layers
    const postSendEdit = await rpc('sign/deposit/set', member, {
      envelopeId: draftEnvId,
      amount: '9999999',
    });
    expect(postSendEdit.status).toBe(409);
    expect(postSendEdit.body.code).toBe('SIGN_ENVELOPE_NOT_DRAFT');

    const guardClient = await pool.connect();
    try {
      await guardClient.query('BEGIN');
      await guardClient.query('SELECT ludy_kernel.enter_context($1::uuid, $2::uuid)', [member.userId, org.orgId]);
      await expect(
        guardClient.query(
          `UPDATE ludy_sign.envelope_deposit SET amount = 9999999 WHERE org_id = $1 AND envelope_id = $2`,
          [org.orgId, draftEnvId],
        ),
      ).rejects.toThrow(/SIGN_DEPOSIT_FROZEN/);
      await guardClient.query('ROLLBACK');

      // Direct freeze definer call on sent already-frozen envelope must fail (BLOCK-1 / BLOCK-2)
      await guardClient.query('BEGIN');
      await guardClient.query('SELECT ludy_kernel.enter_context($1::uuid, $2::uuid)', [member.userId, org.orgId]);
      await expect(
        guardClient.query(
          `SELECT ludy_sign.freeze_envelope_deposit_snapshot($1::uuid, $2::uuid, NULL, $3::uuid, now())`,
          [org.orgId, draftEnvId, member.userId],
        ),
      ).rejects.toThrow(/SIGN_DEPOSIT_FROZEN/);
      await guardClient.query('ROLLBACK');

      // ludy_tenant cannot bypass envelope_deposit_guard by setting ludy.sign_deposit_notice GUC (BLOCK-1)
      const spoofFileId = await uploadSignPdfFor(member, 'spoof-notice-bypass');
      await guardClient.query('BEGIN');
      await guardClient.query('SELECT ludy_kernel.enter_context($1::uuid, $2::uuid)', [member.userId, org.orgId]);
      await guardClient.query(`SELECT pg_catalog.set_config('ludy.sign_deposit_notice', $1, true)`, [draftEnvId]);
      await expect(
        guardClient.query(
          `UPDATE ludy_sign.envelope_deposit
           SET signer_proof_file_id = $1,
               signer_proof_filename = 'bypass.png',
               signer_proof_sha256 = $2
           WHERE org_id = $3 AND envelope_id = $4`,
          [spoofFileId, 'a'.repeat(64), org.orgId, draftEnvId],
        ),
      ).rejects.toThrow(/SIGN_DEPOSIT_SYSTEM_ONLY/);
      await guardClient.query('ROLLBACK');

      // ludy_tenant cannot bypass envelope_deposit_guard by setting ludy.sign_meeting_cleanup GUC (BLOCK-1)
      await guardClient.query('BEGIN');
      await guardClient.query('SELECT ludy_kernel.enter_context($1::uuid, $2::uuid)', [member.userId, org.orgId]);
      await guardClient.query(`SELECT pg_catalog.set_config('ludy.sign_meeting_cleanup', $1, true)`, [org.orgId]);
      await expect(
        guardClient.query(
          `DELETE FROM ludy_sign.envelope_deposit WHERE org_id = $1 AND envelope_id = $2`,
          [org.orgId, draftEnvId],
        ),
      ).rejects.toThrow(/SIGN_DEPOSIT_FROZEN/);
      await guardClient.query('ROLLBACK');
    } finally {
      guardClient.release();
    }

    // Signer submits both envelopes -> completes immediately without requiring any transfer first
    const submitNoDep = await app.request('/api/sign/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: noDepToken, consentAccepted: true, fields: [] }),
    });
    expect(submitNoDep.status).toBe(200);
    const reopenNoDep = await app.request('/api/sign/view', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: noDepToken }),
    });
    expect(reopenNoDep.status).toBe(404);

    const submitDep = await app.request('/api/sign/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: depToken, consentAccepted: true, fields: [] }),
    });
    expect(submitDep.status).toBe(200);
    const submitDepBody = (await submitDep.json()) as { completed: boolean; deposit: Record<string, unknown> | null };
    expect(submitDepBody.completed).toBe(true);
    expect(submitDepBody.deposit?.memoToken).toBe('CK-DEPOSIT1');
    expect(submitDepBody.deposit?.accountNumber).toBe('0999888777');

    // Consumed token refresh returns already_completed + deposit cleanly
    const reopenDep = await app.request('/api/sign/view', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: depToken }),
    });
    expect(reopenDep.status).toBe(200);
    const reopenBody = (await reopenDep.json()) as { state: string; deposit?: { memoToken: string } };
    expect(reopenBody.state).toBe('already_completed');
    expect(reopenBody.deposit?.memoToken).toBe('CK-DEPOSIT1');

    // POST /api/sign/deposit-qr returns frozen PNG with strict headers (and opaque 404 on invalid token before slot lock)
    const badQrRes = await app.request('/api/sign/deposit-qr', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: noDepToken }),
    });
    expect(badQrRes.status).toBe(404);

    const qrRes = await app.request('/api/sign/deposit-qr', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: depToken }),
    });
    expect(qrRes.status).toBe(200);
    expect(qrRes.headers.get('content-type')).toBe('image/png');
    expect(qrRes.headers.get('cache-control')).toBe('no-store');
    expect(qrRes.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await qrRes.arrayBuffer())).toEqual(TINY_PNG_BYTES);

    // Preflight returns opaque 404 for no-deposit tokens before 413/415 or storing blobs (P3-2)
    const blobsBeforeBadNotice = store.blobs.size;
    const noDepPdfForm = new FormData();
    noDepPdfForm.set('token', noDepToken);
    noDepPdfForm.set('file', new File([Buffer.from(pdfFixture('no-dep-proof'))], 'receipt.pdf', { type: 'application/pdf' }));
    const noDepPdfRes = await app.request('/api/sign/deposit-notice', { method: 'POST', body: noDepPdfForm });
    expect(noDepPdfRes.status).toBe(404);

    const noDepBigForm = new FormData();
    noDepBigForm.set('token', noDepToken);
    noDepBigForm.set('file', new File([new Uint8Array(SIGN_DEPOSIT_PROOF_MAX_BYTES + 1)], 'huge.png', { type: 'image/png' }));
    const noDepBigRes = await app.request('/api/sign/deposit-notice', { method: 'POST', body: noDepBigForm });
    expect(noDepBigRes.status).toBe(404);
    expect(store.blobs.size).toBe(blobsBeforeBadNotice);

    // Reject non-image (PDF) and oversized (> 2 MiB) receipt upload on /api/sign/deposit-notice
    const badForm = new FormData();
    badForm.set('token', depToken);
    badForm.set('file', new File([Buffer.from(pdfFixture('bad-proof'))], 'receipt.pdf', { type: 'application/pdf' }));
    const pdfProofRes = await app.request('/api/sign/deposit-notice', { method: 'POST', body: badForm });
    expect(pdfProofRes.status).toBe(415);

    const bigForm = new FormData();
    bigForm.set('token', depToken);
    bigForm.set('file', new File([new Uint8Array(SIGN_DEPOSIT_PROOF_MAX_BYTES + 1)], 'huge.png', { type: 'image/png' }));
    const bigProofRes = await app.request('/api/sign/deposit-notice', { method: 'POST', body: bigForm });
    expect(bigProofRes.status).toBe(413);
    expect(store.blobs.size).toBe(blobsBeforeBadNotice);

    // Non-File multipart field and non-string JSON contentBase64 map to 415 UNSUPPORTED_TYPE (404 for unknown token)
    const textFieldForm = new FormData();
    textFieldForm.set('token', depToken);
    textFieldForm.set('file', 'not-a-file-blob');
    const textFieldRes = await app.request('/api/sign/deposit-notice', { method: 'POST', body: textFieldForm });
    expect(textFieldRes.status).toBe(415);
    expect((await textFieldRes.json() as { code?: string }).code).toBe('UNSUPPORTED_TYPE');

    const badJsonB64Res = await app.request('/api/sign/deposit-notice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: depToken, contentBase64: 12345 }),
    });
    expect(badJsonB64Res.status).toBe(415);
    expect((await badJsonB64Res.json() as { code?: string }).code).toBe('UNSUPPORTED_TYPE');

    const invalidTokenForm = new FormData();
    invalidTokenForm.set('token', noDepToken);
    invalidTokenForm.set('file', 'not-a-file-blob');
    const invalidTokenTextRes = await app.request('/api/sign/deposit-notice', { method: 'POST', body: invalidTokenForm });
    expect(invalidTokenTextRes.status).toBe(404);

    const invalidTokenJsonRes = await app.request('/api/sign/deposit-notice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: noDepToken, contentBase64: 12345 }),
    });
    expect(invalidTokenJsonRes.status).toBe(404);

    // Reject structurally invalid PNG (IHDR + IEND without IDAT chunk) with 415 UNSUPPORTED_TYPE and zero blobs stored
    const noIdatForm = new FormData();
    noIdatForm.set('token', depToken);
    noIdatForm.set('file', new File([NO_IDAT_PNG_BYTES], 'no-idat.png', { type: 'image/png' }));
    const noIdatRes = await app.request('/api/sign/deposit-notice', { method: 'POST', body: noIdatForm });
    expect(noIdatRes.status).toBe(415);
    expect(((await noIdatRes.json()) as { code?: string }).code).toBe('UNSUPPORTED_TYPE');
    expect(store.blobs.size).toBe(blobsBeforeBadNotice);

    // Reusing an upload-sourced hash under sign_attachment fails cleanly with 409 FILE_SOURCE_CONFLICT
    const conflictForm = new FormData();
    conflictForm.set('token', depToken);
    conflictForm.set('file', new File([TINY_PNG_BYTES], 'duplicate-upload.png', { type: 'image/png' }));
    const conflictNoticeRes = await app.request('/api/sign/deposit-notice', { method: 'POST', body: conflictForm });
    expect(conflictNoticeRes.status).toBe(409);

    // Valid PNG proof + note persists non-blocking notice without changing envelope status
    const okForm = new FormData();
    okForm.set('token', depToken);
    okForm.set('note', 'Da chuyen khoan luc 14h20');
    okForm.set('file', new File([PROOF_PNG_BYTES], 'bien-lai.png', { type: 'image/png' }));
    const okNoticeRes = await app.request('/api/sign/deposit-notice', { method: 'POST', body: okForm });
    expect(okNoticeRes.status).toBe(200);
    const noticeBody = (await okNoticeRes.json()) as { deposit: { signerNoticeAt: string | null; signerNoticeNote: string | null; signerProofFilename: string | null; signerProofSha256: string | null } };
    expect(typeof noticeBody.deposit.signerNoticeAt === 'string' && noticeBody.deposit.signerNoticeAt.length > 0 && !Number.isNaN(Date.parse(noticeBody.deposit.signerNoticeAt))).toBe(true);
    expect(noticeBody.deposit.signerNoticeNote).toBe('Da chuyen khoan luc 14h20');
    expect(noticeBody.deposit.signerProofFilename).toBe('bien-lai.png');

    // Record-once immutability: a second submission on the same token returns original notice unchanged with zero new blobs written
    const blobsAfterFirstNotice = store.blobs.size;
    const secondForm = new FormData();
    secondForm.set('token', depToken);
    secondForm.set('note', 'Thu ghi de lan 2');
    secondForm.set('file', new File([TINY_PNG_BYTES], 'second-attempt.png', { type: 'image/png' }));
    const secondNoticeRes = await app.request('/api/sign/deposit-notice', { method: 'POST', body: secondForm });
    expect(secondNoticeRes.status).toBe(200);
    const secondNoticeBody = (await secondNoticeRes.json()) as { deposit: typeof noticeBody.deposit };
    expect(secondNoticeBody.deposit).toEqual(noticeBody.deposit);
    expect(store.blobs.size).toBe(blobsAfterFirstNotice);

    // Authorized workspace member can download the receipt image via /api/files/:id
    const detailAfterNotice = await rpc('sign/envelope/get', member, { envelopeId: draftEnvId });
    const proofFileId = (detailAfterNotice.body.deposit as { signerProofFileId: string | null }).signerProofFileId;
    expect(typeof proofFileId).toBe('string');
    const fileDownloadRes = await app.request(`/api/files/${proofFileId}`, {
      headers: { authorization: `Bearer ${await tokenFor(member)}`, 'x-ludy-org': org.slug },
    });
    expect(fileDownloadRes.status).toBe(200);

    // Import bank statement lines and test Ludy Accounting match bridge (exact Decimal + case-insensitive whole token)
    await runtime.execute(
      'finance.bank.import',
      {
        bankAccount: '1121',
        filename: 'sao-ke-thang-11.csv',
        rows: [
          {
            rowNo: 1,
            date: '24/11/2026',
            description: 'CTY KHACH HANG ck-deposit1 dat coc',
            moneyIn: normalizeStatementAmount('5000000'),
            moneyOut: '',
            balance: normalizeStatementAmount('5000000'),
            reference: 'FT20261124001',
          },
          {
            rowNo: 2,
            date: '24/11/2026',
            description: 'Chuyen khoan XCK-DEPOSIT1Y khong dung ranh gioi tu',
            moneyIn: normalizeStatementAmount('5000000'),
            moneyOut: '',
            balance: normalizeStatementAmount('10000000'),
            reference: 'FT20261124002',
          },
          {
            rowNo: 3,
            date: '24/11/2026',
            description: 'Chi thanh toan CK-DEPOSIT1',
            moneyIn: '',
            moneyOut: normalizeStatementAmount('5000000'),
            balance: normalizeStatementAmount('5000000'),
            reference: 'FT20261124003',
          },
        ],
      },
      { actor: asUser(member), orgId: org.orgId },
    );

    const bankLines = await admin(async (c) => {
      const { rows } = await c.query<{ id: string; bank_ref: string | null }>(
        `SELECT id, bank_ref FROM ludy_finance.bank_line WHERE org_id = $1 ORDER BY position ASC`,
        [org.orgId],
      );
      return rows;
    });
    expect(bankLines).toHaveLength(3);
    const [inMemoLine, inAmountOnlyLine, outLine] = bankLines;

    const matchMemo = await rpc('bank/signDepositMatch', member, { bankLineId: inMemoLine!.id });
    expect(matchMemo.status).toBe(200);
    const candsMemo = (matchMemo.body as unknown as BankSignDepositMatch).candidates;
    expect(candsMemo).toHaveLength(1);
    expect(candsMemo[0]).toMatchObject({
      envelopeId: draftEnvId,
      memoToken: 'CK-DEPOSIT1',
      amount: '5000000',
      reason: 'amount_memo',
      voucherType: 'bank_credit',
      suggestedCreditAccount: '131',
    });
    expect(candsMemo[0]!.signerNoticeAt).toBe(noticeBody.deposit.signerNoticeAt);

    // Word-boundary guard: substring inside an alphanumeric sequence must not match even when exact amount matches
    const matchAmtOnly = await rpc('bank/signDepositMatch', member, { bankLineId: inAmountOnlyLine!.id });
    expect(matchAmtOnly.status).toBe(200);
    expect((matchAmtOnly.body as unknown as BankSignDepositMatch).candidates).toEqual([]);

    // Outflow line produces zero candidates
    const matchOut = await rpc('bank/signDepositMatch', member, { bankLineId: outLine!.id });
    expect(matchOut.status).toBe(200);
    expect((matchOut.body as unknown as BankSignDepositMatch).candidates).toEqual([]);

    // Explain with AI off returns clean state without crashing
    const explainOff = await rpc('bank/signDepositExplain', member, {
      bankLineId: inMemoLine!.id,
      envelopeId: draftEnvId,
      lang: 'vi',
    });
    expect(explainOff.status).toBe(200);
    expect(explainOff.body).toEqual({ ai: 'off', text: null });

    // Confirm ZERO auto-posted vouchers exist in journal_voucher
    await admin(async (c) => {
      const { rows } = await c.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ludy_finance.journal_voucher WHERE org_id = $1`,
        [org.orgId],
      );
      expect(rows[0]!.count).toBe('0');
    });

    // Disabling 'sign' module via kernel.org.set_app gives opaque 404 on public deposit routes & graceful empty candidates in Accounting
    await runtime.execute(
      'kernel.org.set_app',
      { module: 'sign', enabled: false },
      { actor: asUser(owner), orgId: org.orgId },
    );
    try {
      const qrOff = await app.request('/api/sign/deposit-qr', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: depToken }),
      });
      expect(qrOff.status).toBe(404);

      const noticeOff = await app.request('/api/sign/deposit-notice', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: depToken, note: 'module off' }),
      });
      expect(noticeOff.status).toBe(404);

      const matchWhenSignOff = await rpc('bank/signDepositMatch', member, { bankLineId: inMemoLine!.id });
      expect(matchWhenSignOff.status).toBe(200);
      expect((matchWhenSignOff.body as unknown as BankSignDepositMatch).candidates).toEqual([]);
    } finally {
      await runtime.execute(
        'kernel.org.set_app',
        { module: 'sign', enabled: true },
        { actor: asUser(owner), orgId: org.orgId },
      );
    }

    // B1 OTP gate check: unverified OTP signer on an already-noticed deposit gets otpRequired=true without alreadyNoticed/deposit,
    // and /api/sign/deposit-notice rejects with 403 SIGN_OTP_REQUIRED before revealing noticed state or storing blobs.
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(
        `UPDATE ludy_sign.signer
         SET require_email_otp = true,
             email = COALESCE(email, 'signer-a@example.com')
         WHERE org_id = $1 AND envelope_id = $2`,
        [org.orgId, draftEnvId],
      );
      await c.query('COMMIT');
    });
    const depTokenHash = sha256Hex(depToken);
    const otpPreflight = await admin(async (c) => {
      const { rows } = await c.query<{ result: Record<string, unknown> }>(
        `SELECT ludy_sign.public_deposit_notice_preflight($1) AS result`,
        [depTokenHash],
      );
      return rows[0]!.result;
    });
    expect(otpPreflight).toEqual({
      status: 'ok',
      orgId: org.orgId,
      otpRequired: true,
    });
    expect('alreadyNoticed' in otpPreflight).toBe(false);
    expect('deposit' in otpPreflight).toBe(false);

    const otpNoticeRes = await app.request('/api/sign/deposit-notice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: depToken, note: 'otp unverified probe' }),
    });
    expect(otpNoticeRes.status).toBe(403);
    expect(((await otpNoticeRes.json()) as { code?: string }).code).toBe('SIGN_OTP_REQUIRED');
  });

  it('normalizes subaccount codes (1121.VCB), clears QR on bank change, preserves/demotes non-default profiles, and enforces integer VND numeric scale', async () => {
    const p1 = await rpc('sign/depositProfile/upsert', owner, {
      bankCode: 'vcb',
      accountNumber: '0123456789',
      accountHolder: 'CONG TY DEFAULT',
      financeBankAccount: ' 1121.vcb ',
      vietqrPngBase64: TINY_PNG_BASE64,
    });
    expect(p1.status, JSON.stringify(p1.body)).toBe(200);
    const p1Id = String(p1.body.id);
    const p1QrId = String(p1.body.vietqrFileId);
    expect(p1.body.financeBankAccount).toBe('1121.VCB');
    expect(p1.body.isDefault).toBe(true);
    expect(typeof p1.body.vietqrFileId).toBe('string');

    // Holder-only edit preserves existing QR image
    const p1HolderEdit = await rpc('sign/depositProfile/upsert', owner, {
      id: p1Id,
      bankCode: 'vcb',
      accountNumber: '0123456789',
      accountHolder: 'CONG TY DEFAULT UPDATED',
    });
    expect(p1HolderEdit.status, JSON.stringify(p1HolderEdit.body)).toBe(200);
    expect(p1HolderEdit.body.vietqrFileId).toBe(p1QrId);

    // Bank or account change without new QR clears stale QR image
    const p1AccountChange = await rpc('sign/depositProfile/upsert', owner, {
      id: p1Id,
      bankCode: 'vcb',
      accountNumber: '0999111222',
      accountHolder: 'CONG TY DEFAULT UPDATED',
    });
    expect(p1AccountChange.status, JSON.stringify(p1AccountChange.body)).toBe(200);
    expect(p1AccountChange.body.hasQrPng).toBe(false);
    expect(p1AccountChange.body.vietqrFileId).toBeNull();

    // Create a second non-default profile with QR PNG + Finance subaccount
    const p2Id = randomUUID();
    const p2Inserted = await runtime.execute<{ id: string; isDefault: boolean; financeBankAccount: string | null }>(
      'sign.deposit_profile.upsert',
      {
        bankCode: 'acb',
        accountNumber: '8888777766',
        accountHolder: 'CONG TY PHU',
        financeBankAccount: '1121.ACB',
        isDefault: false,
      },
      { actor: asUser(owner), orgId: org.orgId },
    );
    expect(p2Inserted.isDefault).toBe(false);
    expect(p2Inserted.financeBankAccount).toBe('1121.ACB');
    void p2Id;

    // Editing a non-default profile without passing isDefault preserves is_default = false
    const p2Edited = await runtime.execute<{ id: string; isDefault: boolean }>(
      'sign.deposit_profile.upsert',
      {
        id: p2Inserted.id,
        bankCode: 'acb',
        accountNumber: '8888777766',
        accountHolder: 'CONG TY PHU V2',
      },
      { actor: asUser(owner), orgId: org.orgId },
    );
    expect(p2Edited.isDefault).toBe(false);

    // Attach non-default profile to draft envelope, then edit amount omitting depositProfileId -> preserves p2Inserted.id
    const subEnvId = await createInspectedDraft(owner, { title: 'Non-Default Deposit Profile Env' });
    const attachedNonDefault = await runtime.execute<{ depositProfileId: string | null; amount: string }>(
      'sign.envelope.deposit.set',
      {
        envelopeId: subEnvId,
        amount: '2000000',
        memoToken: 'CK-NONDEF1',
        depositProfileId: p2Inserted.id,
      },
      { actor: asUser(owner), orgId: org.orgId },
    );
    expect(attachedNonDefault.depositProfileId).toBe(p2Inserted.id);

    const amountOnlyEdit = await runtime.execute<{ depositProfileId: string | null; amount: string }>(
      'sign.envelope.deposit.set',
      {
        envelopeId: subEnvId,
        amount: '3000000',
      },
      { actor: asUser(owner), orgId: org.orgId },
    );
    expect(amountOnlyEdit.depositProfileId).toBe(p2Inserted.id);
    expect(amountOnlyEdit.amount).toBe('3000000');

    // Promoting p2Inserted to default atomically demotes p1 cleanly
    const p2Promoted = await runtime.execute<{ id: string; isDefault: boolean }>(
      'sign.deposit_profile.upsert',
      {
        id: p2Inserted.id,
        bankCode: 'acb',
        accountNumber: '8888777766',
        accountHolder: 'CONG TY PHU V2',
        isDefault: true,
      },
      { actor: asUser(owner), orgId: org.orgId },
    );
    expect(p2Promoted.isDefault).toBe(true);
    await admin(async (c) => {
      const { rows } = await c.query<{ id: string; is_default: boolean }>(
        `SELECT id, is_default FROM ludy_sign.deposit_profile WHERE org_id = $1 AND id IN ($2, $3)`,
        [org.orgId, p1Id, p2Inserted.id],
      );
      const map = new Map(rows.map((r) => [r.id, r.is_default]));
      expect(map.get(p1Id)).toBe(false);
      expect(map.get(p2Inserted.id)).toBe(true);
    });

    // numeric column without fixed (20,4) scale rejects 100.00001 while accepting 100.0000
    const scaleEnvId = await createInspectedDraft(owner, { title: 'Numeric Scale Check Env' });
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT ludy_kernel.enter_context($1::uuid, $2::uuid)', [owner.userId, org.orgId]);
      await expect(
        c.query(
          `INSERT INTO ludy_sign.envelope_deposit (org_id, envelope_id, amount, currency, memo_token, deposit_profile_id, created_by, updated_by)
           VALUES ($1, $2, 100.00001, 'VND', 'CK-SCALE1', $3, $4, $4)`,
          [org.orgId, scaleEnvId, p2Inserted.id, owner.userId],
        ),
      ).rejects.toThrow(/envelope_deposit_vnd_integer_ck/);
      await c.query('ROLLBACK');

      await c.query('BEGIN');
      await c.query('SELECT ludy_kernel.enter_context($1::uuid, $2::uuid)', [owner.userId, org.orgId]);
      await expect(
        c.query(
          `INSERT INTO ludy_sign.envelope_deposit (org_id, envelope_id, amount, currency, memo_token, deposit_profile_id, created_by, updated_by)
           VALUES ($1, $2, 100.0000, 'VND', 'CK-SCALE2', $3, $4, $4)`,
          [org.orgId, scaleEnvId, p2Inserted.id, owner.userId],
        ),
      ).resolves.toBeDefined();
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }

    // Reusing an existing CK-* memo token on another envelope rejects with 409 SIGN_DEPOSIT_MEMO_CONFLICT
    const memoConflictTry = await rpc('sign/deposit/set', owner, {
      envelopeId: scaleEnvId,
      amount: '1500000',
      memoToken: 'CK-NONDEF1',
      depositProfileId: p2Inserted.id,
    });
    expect(memoConflictTry.status).toBe(409);
    expect(memoConflictTry.body.code).toBe('SIGN_DEPOSIT_MEMO_CONFLICT');

    // Clearing with stale expectedId rejects with 409 SIGN_DEPOSIT_PROFILE_CHANGED and preserves active default
    const staleClearTry = await rpc('sign/depositProfile/clear', owner, { expectedId: p1Id });
    expect(staleClearTry.status).toBe(409);
    expect(staleClearTry.body.code).toBe('SIGN_DEPOSIT_PROFILE_CHANGED');
    const getAfterStaleClear = await rpc('sign/depositProfile/get', owner, {});
    expect(getAfterStaleClear.status).toBe(200);
    expect((getAfterStaleClear.body.profile as { id: string } | null)?.id).toBe(p2Inserted.id);

    // depositProfileClear detaches unfrozen draft deposits pointing to the removed default profile
    const clearDefaultWithDraft = await rpc('sign/depositProfile/clear', owner, { expectedId: p2Inserted.id });
    expect(clearDefaultWithDraft.status).toBe(200);
    expect(clearDefaultWithDraft.body.cleared).toBe(true);
    await admin(async (db) => {
      const { rows } = await db.query<{ deposit_profile_id: string | null }>(
        `SELECT deposit_profile_id FROM ludy_sign.envelope_deposit WHERE org_id = $1 AND envelope_id = $2`,
        [org.orgId, subEnvId],
      );
      expect(rows[0]?.deposit_profile_id).toBeNull();
    });
  });

  it('cleans up deposit_profile and envelope_deposit during ludy_kernel.org_purge', async () => {
    const upPurge = await rpc(
      'sign/depositProfile/upsert',
      owner,
      {
        bankCode: 'vcb',
        accountNumber: '0111222333',
        accountHolder: 'PURGE DEPOSIT CORP',
        vietqrPngBase64: TINY_PNG_BASE64,
      },
      purgeOrg.slug,
    );
    expect(upPurge.status, JSON.stringify(upPurge.body)).toBe(200);
    const envId = await createInspectedDraft(owner, { title: 'Purge Deposit Env', targetOrg: purgeOrg });
    const setRes = await rpc(
      'sign/deposit/set',
      owner,
      { envelopeId: envId, amount: '1000000', memoToken: 'CK-PURGE1' },
      purgeOrg.slug,
    );
    expect(setRes.status, JSON.stringify(setRes.body)).toBe(200);

    const dayMs = 24 * 60 * 60 * 1000;
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query("UPDATE ludy_kernel.tenant SET status = 'offboarding' WHERE org_id = $1", [purgeOrg.orgId]);
      await c.query(
        `INSERT INTO ludy_kernel.audit_event (org_id, occurred_at, actor_type, actor_id, command, command_id, outcome, input_sha256, detail)
         VALUES ($1, $2, 'user', $3, 'kernel.org.offboard', $4, 'ok', $5, '{}'::jsonb),
                ($1, $6, 'system', NULL, 'kernel.org.export.record', $7, 'ok', $5, '{"format":"crove.org-export.v2","file_count":1}'::jsonb)`,
        [
          purgeOrg.orgId,
          new Date(Date.now() - 40 * dayMs),
          owner.userId,
          randomUUID(),
          '0'.repeat(64),
          new Date(Date.now() - 31 * dayMs),
          randomUUID(),
        ],
      );
      await c.query('COMMIT');
    });

    const purgeLogs: string[] = [];
    const purgeCode = await runOrgPurge(
      { runtime: workerRuntime, minDays: 30, log: (l) => purgeLogs.push(l), error: (l) => purgeLogs.push(l) },
      [purgeOrg.orgId, '--reason', 'Owner offboarded sign deposit test org'],
    );
    expect(purgeCode, purgeLogs.join('\n')).toBe(0);

    await admin(async (c) => {
      const depProfile = await c.query(`SELECT count(*)::int AS n FROM ludy_sign.deposit_profile WHERE org_id = $1`, [purgeOrg.orgId]);
      const envDeposit = await c.query(`SELECT count(*)::int AS n FROM ludy_sign.envelope_deposit WHERE org_id = $1`, [purgeOrg.orgId]);
      expect(depProfile.rows[0]!.n).toBe(0);
      expect(envDeposit.rows[0]!.n).toBe(0);
    });
  });
});
