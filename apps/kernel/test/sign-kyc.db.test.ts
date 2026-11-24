// SPDX-License-Identifier: AGPL-3.0-only
// PostgreSQL 17 integration tests for eSign Slice 5e (#4443):
// 100% AI-off deterministic PDF & PNG signer KYC attachment checks with real crove-extract pdf_inspect sandbox,
// metered tainted Vy 'sign.kyc_check' proposals vs human confirmation, hr_contract & meeting_minutes confidentiality,
// can_read_sign_file non-existence parity, memberVy write rejection, PDPL Law 91/2025/QH15 find & erase, MODULE_OFF, and org_purge.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AiBudgetExhaustedError, SignAiReader, metered, type AiCall, type AiMeter } from '@ludy/agent';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createExtractApp } from '@ludy/extract';
import { createExtractClient, type ExtractClient } from '@ludy/extract-contract';
import { buildKernelCommands, kernelQueries } from '@ludy/kernel';
import type { PersonalDataErasure, PersonalDataResult, SignKycListResultContract } from '@ludy/kernel-contract';
import { DomainError, Runtime, sha256Hex, type AgentActor, type BlobStore } from '@ludy/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import { signCommands, signQueries } from '@ludy/mod-sign';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { createAuthenticator } from '../src/auth.ts';
import { AVAILABLE_MODULES, loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { orgPurgeCommand, runOrgPurge } from '../src/org-purge.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { proposeEnvelopeKycCheck, signAi } from '../src/sign-ai.ts';
import { runSignPdfInspectJob, runSignPdfSealJob, sweepSignPendingKycWork } from '../src/sign-worker.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const JWT_SIGNING_KEY = 'test-only-jwt-key-for-sign-kyc-4443-0123456789abcdef';
const ISSUER = 'crove-auth';

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

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function makeValidPngBytes(width = 64, height = 32, seed: string = randomUUID()): Uint8Array {
  const chunk = (type: string, data: Uint8Array): Buffer => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 4, 'ascii');
    Buffer.from(data).copy(out, 8);
    let crc = 0xffffffff;
    for (const byte of out.subarray(4, 8 + data.length)) {
      crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
    }
    out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = 1 + width * 4;
  const rawBytes = Buffer.alloc(height * stride, 0);
  const seedBuf = Buffer.from(seed, 'utf8');
  for (let i = 0; i < width && i < seedBuf.length; i++) {
    const px = 1 + i * 4;
    rawBytes[px] = seedBuf[i]!;
    rawBytes[px + 1] = (seedBuf[i]! * 31) & 0xff;
    rawBytes[px + 2] = (seedBuf[i]! * 17) & 0xff;
    rawBytes[px + 3] = 0xff;
  }
  const idat = chunk('IDAT', deflateSync(rawBytes));
  return Uint8Array.from(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      idat,
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

function escapePdfLiteral(line: string): string {
  return line.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function buildValidSinglePagePdf(lines: readonly string[]): Uint8Array {
  const streamLines = ['BT', '/F1 12 Tf', '50 760 Td'];
  for (const [idx, line] of lines.entries()) {
    if (idx > 0) streamLines.push('0 -18 Td');
    streamLines.push(`(${escapePdfLiteral(line)}) Tj`);
  }
  streamLines.push('ET');
  const streamContent = `${streamLines.join('\n')}\n`;
  const streamLen = Buffer.byteLength(streamContent, 'utf8');

  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    `5 0 obj\n<< /Length ${streamLen} >>\nstream\n${streamContent}endstream\nendobj\n`,
  ];

  const header = '%PDF-1.4\n';
  const offsets: number[] = [];
  let cursor = Buffer.byteLength(header, 'utf8');
  for (const obj of objects) {
    offsets.push(cursor);
    cursor += Buffer.byteLength(obj, 'utf8');
  }
  const xrefOffset = cursor;
  const xrefLines = ['xref', `0 ${objects.length + 1}`, '0000000000 65535 f '];
  for (const off of offsets) {
    xrefLines.push(`${String(off).padStart(10, '0')} 00000 n `);
  }
  const trailer = `${xrefLines.join('\n')}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Uint8Array.from(Buffer.from(header + objects.join('') + trailer, 'utf8'));
}

const suite = ADMIN ? describe : describe.skip;

suite('eSign Slice 5e signer KYC attachment verification check (#4443)', () => {
  const dbName = `crove_test_sign_kyc_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let workerPool: pg.Pool;
  let workerDb: Db;
  let runtime: Runtime;
  let workerRuntime: Runtime;
  let appAiOff: ReturnType<typeof createHttpApp>;
  let realExtract: ExtractClient;
  const store = new MemoryStore();

  const owner: Account = { subject: randomUUID(), email: 'owner-kyc@example.com', session: randomUUID(), userId: '' };
  const adminUser: Account = { subject: randomUUID(), email: 'admin-kyc@example.com', session: randomUUID(), userId: '' };
  const member: Account = { subject: randomUUID(), email: 'member-kyc@example.com', session: randomUUID(), userId: '' };
  const otherMember: Account = { subject: randomUUID(), email: 'member2-kyc@example.com', session: randomUUID(), userId: '' };
  const viewer: Account = { subject: randomUUID(), email: 'viewer-kyc@example.com', session: randomUUID(), userId: '' };

  let org = { slug: '', orgId: '' };
  let purgeOrg = { slug: '', orgId: '' };

  const asUser = (who: Account) => ({
    type: 'user' as const,
    userId: who.userId,
    sessionId: who.session,
    aal: 'aal1' as const,
  });

  const asMfa = (who: Account) => ({
    type: 'user' as const,
    userId: who.userId,
    sessionId: who.session,
    aal: 'aal2' as const,
    mfaAt: Math.floor(Date.now() / 1000),
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

  async function rpc(
    path: string,
    who: Account,
    input: unknown,
    slug: string | null = org.slug,
    targetApp = appAiOff,
    options: { mfa?: boolean } = {},
  ) {
    const response = await targetApp.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await tokenFor(who, options)}`,
        'content-type': 'application/json',
        ...(slug ? { 'x-ludy-org': slug } : {}),
      },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json().catch(() => null)) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as Record<string, unknown> };
  }

  async function uploadSignSourcePdf(who: Account, tag: string, slug = org.slug): Promise<string> {
    const pdfBytes = buildValidSinglePagePdf([`Contract ${tag} ${randomUUID()}`, 'Party B: Cong ty TNHH Thuong mai Minh Anh']);
    const form = new FormData();
    form.append('file', new File([Buffer.from(pdfBytes)], `${tag}.pdf`, { type: 'application/pdf' }));
    form.append('purpose', 'sign_document');
    const res = await appAiOff.request('/api/files', {
      method: 'POST',
      headers: { authorization: `Bearer ${await tokenFor(who)}`, 'x-ludy-org': slug },
      body: form,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: Array<{ fileId: string }> };
    return body.files[0]!.fileId;
  }

  async function createEnvelopeWithAttachmentSlots(
    who: Account,
    options: {
      title: string;
      signerName?: string;
      signerEmail?: string;
      sourceKind?: 'standalone' | 'hr_contract';
      slots: Array<{ label: string }>;
      targetOrg?: { slug: string; orgId: string };
    },
  ): Promise<{ envelopeId: string; signerId: string; sigFieldId: string; attachmentFieldIds: string[]; token: string }> {
    const targetOrg = options.targetOrg ?? org;
    const sourceFileId = await uploadSignSourcePdf(who, options.title.replace(/\s+/g, '-').toLowerCase(), targetOrg.slug);
    const sourceKind = options.sourceKind ?? 'standalone';
    const created = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      {
        title: options.title,
        routingMode: 'parallel',
        sourceFileId,
        sourceKind,
        ...(sourceKind !== 'standalone' ? { sourceId: randomUUID() } : {}),
      },
      { actor: asUser(who), orgId: targetOrg.orgId },
    );
    await runSignPdfInspectJob(
      { workerDb, runtime: workerRuntime, store, extract: realExtract },
      { orgId: targetOrg.orgId, envelopeId: created.envelopeId },
    );

    const signerAdded = await runtime.execute<{ signerId: string }>(
      'sign.signer.add',
      {
        envelopeId: created.envelopeId,
        signerRole: 'signer',
        roleLabel: 'Ben B',
        name: options.signerName ?? 'Tran Thi B',
        ...(options.signerEmail ? { email: options.signerEmail } : {}),
        deliveryMode: 'link',
        requireEmailOtp: false,
      },
      { actor: asUser(who), orgId: targetOrg.orgId },
    );

    const fieldSet = await runtime.execute<{ envelopeId: string; fieldIds: string[]; version: number }>(
      'sign.field.set',
      {
        envelopeId: created.envelopeId,
        fields: [
          {
            signerId: signerAdded.signerId,
            fieldType: 'signature',
            pageNumber: 1,
            xNorm: 0.1,
            yNorm: 0.75,
            wNorm: 0.25,
            hNorm: 0.08,
            required: true,
          },
          ...options.slots.map((slot, idx) => ({
            signerId: signerAdded.signerId,
            fieldType: 'attachment' as const,
            pageNumber: 1,
            xNorm: 0.1,
            yNorm: 0.3 + idx * 0.12,
            wNorm: 0.28,
            hNorm: 0.07,
            label: slot.label,
            required: true,
          })),
        ],
      },
      { actor: asUser(who), orgId: targetOrg.orgId },
    );
    const sigFieldId = fieldSet.fieldIds[0]!;
    const attachmentFieldIds = fieldSet.fieldIds.slice(1);

    const sent = await runtime.execute<{ links: Array<{ token: string }> }>(
      'sign.envelope.send',
      { envelopeId: created.envelopeId },
      { actor: asUser(who), orgId: targetOrg.orgId },
    );

    return {
      envelopeId: created.envelopeId,
      signerId: signerAdded.signerId,
      sigFieldId,
      attachmentFieldIds,
      token: sent.links[0]!.token,
    };
  }

  async function uploadPublicSignerAttachment(params: {
    token: string;
    fieldId: string;
    filename: string;
    bytes: Uint8Array;
  }) {
    const res = await appAiOff.request('/api/sign/attachment', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: params.token,
        fieldId: params.fieldId,
        filename: params.filename,
        contentBase64: Buffer.from(params.bytes).toString('base64'),
      }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as {
      fieldId: string;
      filename: string;
      contentType: string;
      sizeBytes: number;
      sha256: string;
    };
  }

  beforeAll(async () => {
    const extractApp = createExtractApp();
    realExtract = createExtractClient({
      url: 'http://extract.internal',
      fetch: async (input, init) => extractApp.request(input instanceof URL ? input.toString() : String(input), init),
    });

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
    const sharedQueries = [...kernelQueries({ inboundDomain: null }), ...signQueries, ...meetingsQueries];
    runtime = new Runtime(db, {
      manifests: TEST_MANIFESTS,
      sessions: createSessionStatusSource('off'),
      stepUp: 'required',
    }).register({
      commands: [...kernelCmds, ...signCommands, ...meetingsCommands],
      queries: sharedQueries,
    });

    workerRuntime = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCmds, ...signCommands, ...meetingsCommands, orgPurgeCommand({ store })],
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
    appAiOff = createHttpApp({ config, runtime, store, authenticate, pool, aiEnabled: false });

    for (const who of [owner, adminUser, member, otherMember, viewer]) {
      const me = await rpc('me/get', who, undefined, null);
      expect(me.status).toBe(200);
      who.userId = String(me.body.userId);
    }

    const created = await rpc('org/create', owner, { name: 'Sign KYC Org', idempotencyKey: randomUUID() }, null);
    expect(created.status).toBe(200);
    org = { slug: String(created.body.slug), orgId: String(created.body.orgId) };

    for (const [who, role] of [
      [adminUser, 'admin'],
      [member, 'member'],
      [otherMember, 'member'],
      [viewer, 'viewer'],
    ] as const) {
      const invite = await rpc('org/invite', owner, { email: who.email, role }, org.slug, appAiOff, { mfa: true });
      expect(invite.status).toBe(200);
      const acceptPath = String(invite.body.acceptPath);
      expect((await rpc('invites/accept', who, { token: acceptPath.split('#')[1] }, null)).status).toBe(200);
    }

    const createdPurge = await rpc('org/create', owner, { name: 'Purge KYC Org', idempotencyKey: randomUUID() }, null);
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

  it('runs 100% AI-off deterministic PDF (real crove-extract pdf_inspect) & PNG attachment checks and manual human confirmations', async () => {
    const setup = await createEnvelopeWithAttachmentSlots(member, {
      title: 'DKKD & CCCD Verification Contract',
      signerName: 'Tran Thi B',
      signerEmail: 'tran@example.com',
      slots: [{ label: 'Giay chung nhan DKKD' }, { label: 'Mat truoc CCCD' }],
    });
    const [pdfFieldId, pngFieldId] = setup.attachmentFieldIds as [string, string];

    const dkkdPdfBytes = buildValidSinglePagePdf([
      'GIAY CHUNG NHAN DANG KY DOANH NGHIEP',
      'Ten cong ty: Cong ty TNHH Thuong mai Minh Anh',
      'MST: 0101234567',
      'Nguoi dai dien theo phap luat: Tran Thi B',
      'CCCD: 001099123456',
    ]);
    const uploadedPdf = await uploadPublicSignerAttachment({
      token: setup.token,
      fieldId: pdfFieldId,
      filename: 'dkkd-minh-anh.pdf',
      bytes: dkkdPdfBytes,
    });
    const uploadedPng = await uploadPublicSignerAttachment({
      token: setup.token,
      fieldId: pngFieldId,
      filename: 'cccd-front.png',
      bytes: makeValidPngBytes(64, 32, 'setup-cccd-front'),
    });

    const listMember = await rpc('sign/kyc/list', member, { envelopeId: setup.envelopeId });
    expect(listMember.status).toBe(200);
    const listed = listMember.body as unknown as SignKycListResultContract;
    expect(listed.canWrite).toBe(true);
    expect(listed.items).toHaveLength(2);
    expect(listed.items.every((i) => i.check === null)).toBe(true);

    const listViewer = await rpc('sign/kyc/list', viewer, { envelopeId: setup.envelopeId });
    expect(listViewer.status).toBe(200);
    expect((listViewer.body as unknown as SignKycListResultContract).canWrite).toBe(false);

    // Trigger deterministic check on PDF without inline pages -> queues crove-extract pdf_inspect worker job!
    const queuedRes = await rpc('sign/kyc/run_deterministic', member, {
      envelopeId: setup.envelopeId,
      fieldId: pdfFieldId,
      expectedEntityName: 'Cong ty TNHH Thuong mai Minh Anh',
      expectedTaxCode: '0101234567',
    });
    expect(queuedRes.status).toBe(200);
    expect(queuedRes.body).toMatchObject({
      fieldId: pdfFieldId,
      fileSha256: uploadedPdf.sha256,
      status: 'pending',
      mode: 'deterministic',
    });

    const outboxCheck = await admin((c) =>
      c.query<{ type: string }>(
        `SELECT type FROM ludy_kernel.outbox_event WHERE org_id = $1 AND type = 'sign.kyc.inspect_queued'`,
        [org.orgId],
      ),
    );
    expect(outboxCheck.rowCount).toBeGreaterThanOrEqual(1);

    // Run worker job with REAL crove-extract pdf_inspect subprocess sandbox!
    const workerRes = await runSignPdfInspectJob(
      { workerDb, runtime: workerRuntime, store, extract: realExtract },
      { orgId: org.orgId, targetKind: 'kyc_attachment', envelopeId: setup.envelopeId, fieldId: pdfFieldId },
    );
    expect(workerRes).toEqual({ status: 'passed', pageCount: 1 });

    const afterInspect = await rpc('sign/kyc/list', member, { envelopeId: setup.envelopeId });
    const pdfSlot = (afterInspect.body as unknown as SignKycListResultContract).items.find(
      (i) => i.fieldId === pdfFieldId,
    )!;
    expect(pdfSlot.check).toMatchObject({
      status: 'matched',
      mode: 'deterministic',
    });
    expect(pdfSlot.check?.findings.extractedTaxCodes).toEqual(['0101234567']);
    expect(pdfSlot.check?.findings.extractedNationalIds).toEqual(['001099123456']);
    expect(pdfSlot.check?.findings.sha256Verified).toBe(true);

    // Run deterministic check on PNG attachment -> verifies MIME/size/SHA-256 and sets needs_review for human visual check.
    const pngDetRes = await rpc('sign/kyc/run_deterministic', member, {
      envelopeId: setup.envelopeId,
      fieldId: pngFieldId,
    });
    expect(pngDetRes.status).toBe(200);
    expect(pngDetRes.body).toMatchObject({
      fieldId: pngFieldId,
      fileSha256: uploadedPng.sha256,
      status: 'needs_review',
      mode: 'deterministic',
    });

    // AI-off analyze returns clean 'off' status while preserving existing check record.
    const aiOffAnalyze = await rpc('sign/kyc/analyze', member, {
      envelopeId: setup.envelopeId,
      fieldId: pdfFieldId,
    });
    expect(aiOffAnalyze.status).toBe(200);
    expect(aiOffAnalyze.body).toMatchObject({
      ai: 'off',
      status: 'off',
    });

    // Human confirmation ('matched' & 'mismatch') transitions mode to 'manual' and records checkedBy/checkedAt.
    const confirmedPng = await rpc('sign/kyc/confirm', member, {
      envelopeId: setup.envelopeId,
      fieldId: pngFieldId,
      status: 'matched',
      manualNote: 'Da xem anh CCCD canh hop dong, khop ho ten Tran Thi B.',
    });
    expect(confirmedPng.status).toBe(200);
    expect(confirmedPng.body).toMatchObject({
      fieldId: pngFieldId,
      status: 'matched',
      mode: 'manual',
      checkedBy: member.userId,
    });
    expect(confirmedPng.body.checkedAt).toBeTruthy();

    const flaggedMismatch = await rpc('sign/kyc/confirm', member, {
      envelopeId: setup.envelopeId,
      fieldId: pngFieldId,
      status: 'mismatch',
      manualNote: 'Anh bi mo goc so dinh danh, yeu cau gui lai.',
    });
    expect(flaggedMismatch.status).toBe(200);
    expect(flaggedMismatch.body).toMatchObject({
      status: 'mismatch',
      mode: 'manual',
    });
  });

  it('meters Vy sign.kyc_check proposals as tainted needs_review with zero auto-reject/auto-void, handles budget exhaustion, and honors AI kill switch', async () => {
    const setup = await createEnvelopeWithAttachmentSlots(member, {
      title: 'Vy KYC Review Contract',
      signerName: 'Tran Thi B',
      slots: [{ label: 'Giay uy quyen' }],
    });
    const fieldId = setup.attachmentFieldIds[0]!;
    const poaPdfBytes = buildValidSinglePagePdf([
      'GIAY UY QUYEN KY HOP DONG',
      'Ten doanh nghiep: Cong ty TNHH Thuong mai Minh Anh',
      'MST: 0101234567',
      'Ben nhan uy quyen: Pham Van Khac',
    ]);
    await uploadPublicSignerAttachment({
      token: setup.token,
      fieldId,
      filename: 'uy-quyen.pdf',
      bytes: poaPdfBytes,
    });

    const admitted: AiCall[] = [];
    const reader = new SignAiReader(
      { baseURL: 'http://model.invalid/v1', apiKey: null, model: 'test', maxRetries: 0 },
      {
        kycCheck: async () => {
          const r = await metered('sign.kyc_check', async () => ({
            output: {
              suggestedStatus: 'mismatch',
              summaryNote: 'Giay uy quyen ghi ten Pham Van Khac khac voi nguoi ky Tran Thi B.',
              findings: [
                {
                  category: 'authorized_signer',
                  assessment: 'mismatch',
                  extractedValue: 'Pham Van Khac',
                  expectedValue: 'Tran Thi B',
                  pageNumber: 1,
                  quoteExcerpt: 'Ben nhan uy quyen: Pham Van Khac',
                  explanation: 'Nguoi nhan uy quyen tren tai lieu la Pham Van Khac.',
                },
              ],
            },
            usage: { inputTokens: 140, outputTokens: 65 },
          }));
          return r;
        },
      },
    );

    const meter: AiMeter = {
      admit: async (call) => {
        admitted.push(call);
      },
      record: async () => {},
    };
    const ai = signAi(reader, new DraftBudget({ perOrgPerMinute: 20, perUserPerMinute: 20 }));

    const res = await proposeEnvelopeKycCheck({
      ai,
      runtime,
      orgId: org.orgId,
      actor: asUser(member),
      envelopeId: setup.envelopeId,
      fieldId,
      expectedEntityName: 'Cong ty TNHH Thuong mai Minh Anh',
      expectedTaxCode: '0101234567',
      attachmentPages: [
        {
          page: 1,
          text: [
            'GIAY UY QUYEN KY HOP DONG',
            'Ten doanh nghiep: Cong ty TNHH Thuong mai Minh Anh',
            'MST: 0101234567',
            'Ben nhan uy quyen: Pham Van Khac',
          ].join('\n'),
        },
      ],
      meter,
    });

    expect(admitted).toEqual([
      expect.objectContaining({
        orgId: org.orgId,
        feature: 'sign.kyc_check',
        module: 'sign',
      }),
    ]);
    expect(res.ai).toBe('used');
    // Tainted AI proposal MUST remain 'needs_review' until a human confirms, even when suggestedStatus is 'mismatch'!
    expect(res.status).toBe('needs_review');
    expect(res.check?.mode).toBe('ai');
    expect(res.check?.status).toBe('needs_review');
    expect(res.check?.checkedBy).toBeNull();
    expect(res.check?.findings.aiProposal).toMatchObject({
      suggestedStatus: 'mismatch',
      proposedByAi: true,
    });

    // Envelope MUST remain active ('sent'), never auto-voided or auto-rejected by AI!
    const envDetail = await rpc('sign/envelope/get', member, { envelopeId: setup.envelopeId });
    expect(envDetail.status).toBe(200);
    expect((envDetail.body.envelope as { status: string }).status).toBe('sent');

    // Budget exhaustion degrades cleanly to 'budget'.
    const exhaustedMeter: AiMeter = {
      admit: async () => {
        throw new AiBudgetExhaustedError('org', null);
      },
      record: async () => {},
    };
    const budgetRes = await proposeEnvelopeKycCheck({
      ai,
      runtime,
      orgId: org.orgId,
      actor: asUser(member),
      envelopeId: setup.envelopeId,
      fieldId,
      attachmentPages: [{ page: 1, text: 'Ben nhan uy quyen: Pham Van Khac' }],
      meter: exhaustedMeter,
    });
    expect(budgetRes.ai).toBe('budget');
    expect(budgetRes.status).toBe('budget');

    // Module AI kill switch stops checkKycAttachment with zero model calls.
    const engaged = await runtime.execute<{ killSwitchId: string }>(
      'kernel.agent.kill_switch.engage',
      { scope: 'module', target: 'sign', reason: 'Stop eSign AI' },
      { actor: asUser(owner), orgId: org.orgId },
    );
    try {
      const beforeCalls = admitted.length;
      const stoppedRes = await proposeEnvelopeKycCheck({
        ai,
        runtime,
        orgId: org.orgId,
        actor: asUser(member),
        envelopeId: setup.envelopeId,
        fieldId,
        attachmentPages: [{ page: 1, text: 'Ben nhan uy quyen: Pham Van Khac' }],
        meter,
      });
      expect(stoppedRes.ai).toBe('off');
      expect(admitted).toHaveLength(beforeCalls);
    } finally {
      await runtime.execute(
        'kernel.agent.kill_switch.release',
        { id: engaged.killSwitchId },
        { actor: asMfa(owner), orgId: org.orgId },
      );
    }
  });

  it('enforces hr_contract confidentiality (404 parity + can_read_sign_file + 0 SQL rows), viewer read-only RBAC, public route non-exposure, and agent write rejection', async () => {
    const hrSetup = await createEnvelopeWithAttachmentSlots(adminUser, {
      title: 'Confidential Executive Offer',
      sourceKind: 'hr_contract',
      slots: [{ label: 'CCCD ung vien' }, { label: 'Giay uy quyen ung vien' }],
    });
    const hrFieldId = hrSetup.attachmentFieldIds[0]!;
    const hrUncheckedFieldId = hrSetup.attachmentFieldIds[1]!;
    await uploadPublicSignerAttachment({
      token: hrSetup.token,
      fieldId: hrFieldId,
      filename: 'cccd-candidate.png',
      bytes: makeValidPngBytes(64, 32, 'hr-candidate-cccd'),
    });

    // Creator adminUser and owner can run deterministic check, list, and confirm.
    expect(
      (await rpc('sign/kyc/run_deterministic', adminUser, { envelopeId: hrSetup.envelopeId, fieldId: hrFieldId })).status,
    ).toBe(200);
    const hrListAdmin = await rpc('sign/kyc/list', adminUser, { envelopeId: hrSetup.envelopeId });
    expect(hrListAdmin.status).toBe(200);
    const hrFileId = (hrListAdmin.body as unknown as SignKycListResultContract).items[0]!.fileId;
    expect((await rpc('sign/kyc/list', owner, { envelopeId: hrSetup.envelopeId })).status).toBe(200);

    // Non-creator members receive identical 404 across all KYC queries/commands (zero existence or file oracle).
    for (const outsiderMember of [member, otherMember]) {
      expect((await rpc('sign/kyc/list', outsiderMember, { envelopeId: hrSetup.envelopeId })).status).toBe(404);
      expect(
        (
          await rpc('sign/kyc/run_deterministic', outsiderMember, {
            envelopeId: hrSetup.envelopeId,
            fieldId: hrFieldId,
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await rpc('sign/kyc/analyze', outsiderMember, {
            envelopeId: hrSetup.envelopeId,
            fieldId: hrFieldId,
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await rpc('sign/kyc/confirm', outsiderMember, {
            envelopeId: hrSetup.envelopeId,
            fieldId: hrFieldId,
            status: 'matched',
          })
        ).status,
      ).toBe(404);
    }

    // Viewer gets 404 on read (list) and 403 on write/analyze commands before any existence check runs.
    expect((await rpc('sign/kyc/list', viewer, { envelopeId: hrSetup.envelopeId })).status).toBe(404);
    expect(
      (await rpc('sign/kyc/run_deterministic', viewer, { envelopeId: hrSetup.envelopeId, fieldId: hrFieldId })).status,
    ).toBe(403);
    expect((await rpc('sign/kyc/analyze', viewer, { envelopeId: hrSetup.envelopeId, fieldId: hrFieldId })).status).toBe(
      403,
    );
    expect(
      (
        await rpc('sign/kyc/confirm', viewer, {
          envelopeId: hrSetup.envelopeId,
          fieldId: hrFieldId,
          status: 'matched',
        })
      ).status,
    ).toBe(403);

    // Viewer cannot write even on a standalone envelope (403 FORBIDDEN).
    const standalone = await createEnvelopeWithAttachmentSlots(member, {
      title: 'Viewer RBAC Standalone',
      slots: [{ label: 'CCCD' }],
    });
    const stFieldId = standalone.attachmentFieldIds[0]!;
    await uploadPublicSignerAttachment({
      token: standalone.token,
      fieldId: stFieldId,
      filename: 'cccd.png',
      bytes: makeValidPngBytes(64, 32, 'standalone-viewer-cccd'),
    });
    const stListMember = await rpc('sign/kyc/list', member, { envelopeId: standalone.envelopeId });
    expect(stListMember.status).toBe(200);
    const stFileId = (stListMember.body as unknown as SignKycListResultContract).items[0]!.fileId;

    // Direct tenant SQL as non-creator member sees 0 rows on ludy_sign.kyc_check, false on can_read_sign_file,
    // and is rejected by RLS (42501) if attempting cross-envelope field_id hijack or non-attachment field binding.
    const tenantClient = await pool.connect();
    try {
      await tenantClient.query('BEGIN');
      await tenantClient.query('SELECT ludy_kernel.enter_context($1::uuid, $2::uuid)', [otherMember.userId, org.orgId]);
      const rlsRows = await tenantClient.query(
        'SELECT id FROM ludy_sign.kyc_check WHERE org_id = $1 AND envelope_id = $2',
        [org.orgId, hrSetup.envelopeId],
      );
      expect(rlsRows.rows).toEqual([]);
      const canRead = await tenantClient.query<{ allowed: boolean }>(
        'SELECT ludy_sign.can_read_sign_file($1::uuid) AS allowed',
        [hrFileId],
      );
      expect(canRead.rows[0]?.allowed).toBe(false);

      await tenantClient.query('SAVEPOINT sp_cross_env_hijack');
      await expect(
        tenantClient.query(
          `INSERT INTO ludy_sign.kyc_check (org_id, envelope_id, field_id, file_id, file_sha256, status, mode, findings_json)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, 'pending', 'manual', '{}'::jsonb)`,
          [org.orgId, standalone.envelopeId, hrUncheckedFieldId, stFileId, 'a'.repeat(64)],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await tenantClient.query('ROLLBACK TO SAVEPOINT sp_cross_env_hijack');

      await tenantClient.query('SAVEPOINT sp_non_attachment_rls');
      await expect(
        tenantClient.query(
          `INSERT INTO ludy_sign.kyc_check (org_id, envelope_id, field_id, file_id, file_sha256, status, mode, findings_json)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, 'pending', 'manual', '{}'::jsonb)`,
          [org.orgId, standalone.envelopeId, standalone.sigFieldId, stFileId, 'a'.repeat(64)],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await tenantClient.query('ROLLBACK TO SAVEPOINT sp_non_attachment_rls');
    } finally {
      await tenantClient.query('ROLLBACK').catch(() => {});
      tenantClient.release();
    }

    // DB-level AFTER constraint trigger (23514) and file_id FK (23503) also enforce integrity when bypassing RLS.
    await admin(async (c) => {
      await c.query('BEGIN');
      try {
        await c.query('SAVEPOINT sp_admin_mismatch');
        await expect(
          c.query(
            `INSERT INTO ludy_sign.kyc_check (org_id, envelope_id, field_id, file_id, file_sha256, status, mode, findings_json)
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, 'pending', 'manual', '{}'::jsonb)`,
            [org.orgId, standalone.envelopeId, hrUncheckedFieldId, stFileId, 'b'.repeat(64)],
          ),
        ).rejects.toMatchObject({ code: '23514' });
        await c.query('ROLLBACK TO SAVEPOINT sp_admin_mismatch');

        await c.query('SAVEPOINT sp_admin_update_mismatch');
        await expect(
          c.query(
            `UPDATE ludy_sign.kyc_check SET envelope_id = $2::uuid WHERE org_id = $1::uuid AND field_id = $3::uuid`,
            [org.orgId, standalone.envelopeId, hrFieldId],
          ),
        ).rejects.toMatchObject({ code: '23514' });
        await c.query('ROLLBACK TO SAVEPOINT sp_admin_update_mismatch');

        await c.query('SAVEPOINT sp_admin_non_attachment');
        await expect(
          c.query(
            `INSERT INTO ludy_sign.kyc_check (org_id, envelope_id, field_id, file_id, file_sha256, status, mode, findings_json)
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, 'pending', 'manual', '{}'::jsonb)`,
            [org.orgId, standalone.envelopeId, standalone.sigFieldId, stFileId, 'b'.repeat(64)],
          ),
        ).rejects.toMatchObject({ code: '23514' });
        await c.query('ROLLBACK TO SAVEPOINT sp_admin_non_attachment');

        await c.query('SAVEPOINT sp_admin_missing_file');
        await expect(
          c.query(
            `INSERT INTO ludy_sign.kyc_check (org_id, envelope_id, field_id, file_id, file_sha256, status, mode, findings_json)
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, 'pending', 'manual', '{}'::jsonb)`,
            [org.orgId, standalone.envelopeId, stFieldId, randomUUID(), 'b'.repeat(64)],
          ),
        ).rejects.toMatchObject({ code: '23503' });
        await c.query('ROLLBACK TO SAVEPOINT sp_admin_missing_file');
      } finally {
        await c.query('ROLLBACK');
      }
    });

    expect(
      (await rpc('sign/kyc/run_deterministic', viewer, { envelopeId: standalone.envelopeId, fieldId: stFieldId }))
        .status,
    ).toBe(403);
    expect(
      (
        await rpc('sign/kyc/confirm', viewer, {
          envelopeId: standalone.envelopeId,
          fieldId: stFieldId,
          status: 'matched',
        })
      ).status,
    ).toBe(403);

    // Agent actor cannot execute KYC write commands (403).
    const agentActor: AgentActor = {
      type: 'agent',
      agentId: randomUUID(),
      runId: randomUUID(),
    };
    await expect(
      runtime.execute(
        'sign.kyc.confirm',
        { envelopeId: standalone.envelopeId, fieldId: stFieldId, status: 'matched' },
        { actor: agentActor, orgId: org.orgId },
      ),
    ).rejects.toMatchObject({ status: 403 });

    // No unauthenticated public /api/sign/kyc* or /api/rpc/sign/kyc/* endpoint is reachable (401 auth gate).
    const pubProbe = await appAiOff.request('/api/sign/kyc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: standalone.token }),
    });
    expect(pubProbe.status).toBe(401);
    const unauthRpcProbe = await appAiOff.request('/api/rpc/sign/kyc/list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ json: { envelopeId: standalone.envelopeId } }),
    });
    expect(unauthRpcProbe.status).toBe(401);
  });

  it('supports PDPL Law 91/2025/QH15 personal_data.find & erase (including attendees-only meeting_minutes rows while preserving sealed PDFs), ADR-0053 MODULE_OFF, and org_purge', async () => {
    const pdplMarker = 'pdpl-kyc-subject-4443@example.com';

    // 1. Completed + sealed standalone envelope with a KYC check containing pdplMarker in manualNote/findings_json.
    const completedSetup = await createEnvelopeWithAttachmentSlots(member, {
      title: 'Completed PDPL KYC Contract',
      signerName: 'Dang Thi Minh Anh',
      slots: [{ label: 'CCCD' }],
    });
    const compFieldId = completedSetup.attachmentFieldIds[0]!;
    await uploadPublicSignerAttachment({
      token: completedSetup.token,
      fieldId: compFieldId,
      filename: 'cccd-pdpl.png',
      bytes: makeValidPngBytes(64, 32, 'completed-pdpl-cccd'),
    });
    const submitRes = await appAiOff.request('/api/sign/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: completedSetup.token,
        consentAccepted: true,
        signatureKind: 'draw',
        fields: [
          {
            fieldId: completedSetup.sigFieldId,
            signaturePngBase64: Buffer.from(makeValidPngBytes(160, 60, 'completed-sig-draw')).toString('base64'),
          },
        ],
      }),
    });
    expect(submitRes.status).toBe(200);
    const sealRes = await runSignPdfSealJob(
      { workerDb, runtime: workerRuntime, store, extract: realExtract },
      { orgId: org.orgId, envelopeId: completedSetup.envelopeId },
    );
    expect(sealRes.status).toBe('sealed');

    const confirmComp = await rpc('sign/kyc/confirm', owner, {
      envelopeId: completedSetup.envelopeId,
      fieldId: compFieldId,
      status: 'matched',
      manualNote: `Verified identity for ${pdplMarker}`,
    });
    expect(confirmComp.status).toBe(200);

    // 2. Attendees-only meeting_minutes envelope created by `member` (where `owner` is NOT a meeting reader!).
    const mtgCreated = await runtime.execute<{ meetingId: string }>(
      'meetings.meeting.create',
      { title: 'Confidential Board Session', visibility: 'attendees', consentMethod: 'told_at_start' },
      { actor: asUser(member), orgId: org.orgId },
    );
    await runtime.execute(
      'meetings.summary.save',
      {
        meetingId: mtgCreated.meetingId,
        summary: 'Approved contract execution.',
        decisions: ['Approved'],
      },
      { actor: asUser(member), orgId: org.orgId },
    );
    await runtime.execute(
      'meetings.result.publish',
      { meetingId: mtgCreated.meetingId, confirmed: true },
      { actor: asUser(member), orgId: org.orgId },
    );
    const mtgPdfId = await uploadSignSourcePdf(member, 'board-minutes-kyc');
    const mtgEnv = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      {
        title: 'Board Minutes Sign-off',
        routingMode: 'parallel',
        sourceFileId: mtgPdfId,
        sourceKind: 'meeting_minutes',
        sourceId: mtgCreated.meetingId,
      },
      { actor: asUser(member), orgId: org.orgId },
    );
    await runSignPdfInspectJob(
      { workerDb, runtime: workerRuntime, store, extract: realExtract },
      { orgId: org.orgId, envelopeId: mtgEnv.envelopeId },
    );
    const mtgSigner = await runtime.execute<{ signerId: string }>(
      'sign.signer.add',
      {
        envelopeId: mtgEnv.envelopeId,
        signerRole: 'signer',
        name: 'Member Signer',
        deliveryMode: 'link',
        requireEmailOtp: false,
      },
      { actor: asUser(member), orgId: org.orgId },
    );
    const mtgFieldSet = await runtime.execute<{ fieldIds: string[] }>(
      'sign.field.set',
      {
        envelopeId: mtgEnv.envelopeId,
        fields: [
          {
            signerId: mtgSigner.signerId,
            fieldType: 'signature',
            pageNumber: 1,
            xNorm: 0.1,
            yNorm: 0.75,
            wNorm: 0.25,
            hNorm: 0.08,
            required: true,
          },
          {
            signerId: mtgSigner.signerId,
            fieldType: 'attachment',
            pageNumber: 1,
            xNorm: 0.1,
            yNorm: 0.35,
            wNorm: 0.28,
            hNorm: 0.07,
            label: 'Giay uy quyen hop',
            required: true,
          },
        ],
      },
      { actor: asUser(member), orgId: org.orgId },
    );
    const mtgAttFieldId = mtgFieldSet.fieldIds[1]!;
    const mtgSent = await runtime.execute<{ links: Array<{ token: string }> }>(
      'sign.envelope.send',
      { envelopeId: mtgEnv.envelopeId },
      { actor: asUser(member), orgId: org.orgId },
    );
    await uploadPublicSignerAttachment({
      token: mtgSent.links[0]!.token,
      fieldId: mtgAttFieldId,
      filename: 'board-poa.png',
      bytes: makeValidPngBytes(64, 32, 'mtg-board-poa'),
    });
    expect(
      (
        await rpc('sign/kyc/confirm', member, {
          envelopeId: mtgEnv.envelopeId,
          fieldId: mtgAttFieldId,
          status: 'matched',
          manualNote: `Confidential board KYC note for ${pdplMarker}`,
        })
      ).status,
    ).toBe(200);

    // Owner cannot read the attendees-only meeting_minutes KYC check via sign/kyc/list (404),
    // yet PDPL personal_data.erase MUST erase BOTH kyc_check rows across the org!
    expect((await rpc('sign/kyc/list', owner, { envelopeId: mtgEnv.envelopeId })).status).toBe(404);

    const found = await runtime.execute<PersonalDataResult>(
      'kernel.personal_data.find',
      { value: pdplMarker },
      { actor: asUser(owner), orgId: org.orgId },
    );
    expect(found.matches).toContainEqual(
      expect.objectContaining({
        column: 'ludy_sign.kyc_check.findings_json',
        handling: 'erase',
      }),
    );

    const erased = await runtime.execute<PersonalDataErasure>(
      'kernel.personal_data.erase',
      { value: pdplMarker },
      { actor: asMfa(owner), orgId: org.orgId },
    );
    expect(erased.erased).toContainEqual({
      column: 'ludy_sign.kyc_check.findings_json',
      rows: 2,
    });
    expect(erased.erased).toContainEqual({
      column: 'ludy_sign.kyc_check.file_id',
      rows: 2,
    });

    const remainingKycRows = await admin((c) =>
      c.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ludy_sign.kyc_check WHERE org_id = $1 AND findings_json::text ILIKE $2`,
        [org.orgId, `%${pdplMarker}%`],
      ),
    );
    expect(Number(remainingKycRows.rows[0]?.count ?? '0')).toBe(0);

    // Sealed PDF evidence on completed envelope remains intact after KYC erasure!
    const sealedRow = await admin((c) =>
      c.query<{ seal_status: string; sealed_file_id: string | null }>(
        `SELECT seal_status, sealed_file_id FROM ludy_sign.envelope WHERE org_id = $1 AND id = $2`,
        [org.orgId, completedSetup.envelopeId],
      ),
    );
    expect(sealedRow.rows[0]?.seal_status).toBe('sealed');
    expect(sealedRow.rows[0]?.sealed_file_id).toBeTruthy();

    // ADR-0053 MODULE_OFF gating on sign.kyc.* and worker inspection.
    await runtime.execute(
      'kernel.org.set_app',
      { module: 'sign', enabled: false },
      { actor: asMfa(owner), orgId: org.orgId },
    );
    try {
      await expect(
        runtime.query('sign.kyc.list', { envelopeId: completedSetup.envelopeId }, { actor: asUser(owner), orgId: org.orgId }),
      ).rejects.toBeInstanceOf(DomainError);
      const skippedWorker = await runSignPdfInspectJob(
        { workerDb, runtime: workerRuntime, store, extract: realExtract },
        { orgId: org.orgId, targetKind: 'kyc_attachment', envelopeId: completedSetup.envelopeId, fieldId: compFieldId },
      );
      expect(skippedWorker).toEqual({ status: 'skipped_app_off' });
    } finally {
      await runtime.execute(
        'kernel.org.set_app',
        { module: 'sign', enabled: true },
        { actor: asMfa(owner), orgId: org.orgId },
      );
    }

    // Verify #4510 KYC follow-ups: partial checked_by index, x-ludy-org vs conflicting header check,
    // incomplete inspectAttachmentPages fallback, stale pending KYC sweep/timeout, and unsealed attachment erasure counts.
    const checkedByIdx = await admin((c) =>
      c.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = 'ludy_sign' AND tablename = 'kyc_check' AND indexname = 'kyc_check_checked_by_idx'`,
      ),
    );
    expect(checkedByIdx.rows[0]?.indexdef).toContain('checked_by IS NOT NULL');

    const conflictHeaderRes = await appAiOff.request('/api/rpc/sign/kyc/list', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await tokenFor(owner)}`,
        'content-type': 'application/json',
        'x-ludy-org': org.slug,
        'x-crove-org': 'other-org',
      },
      body: JSON.stringify({ json: { envelopeId: completedSetup.envelopeId } }),
    });
    expect(conflictHeaderRes.status).toBe(400);
    await expect(conflictHeaderRes.json()).resolves.toMatchObject({ code: 'ORG_HEADER_CONFLICT' });

    // Stale pending KYC sweep recovery vs hard timeout + incomplete inspectAttachmentPages fallback.
    const sweepSetup = await createEnvelopeWithAttachmentSlots(owner, {
      title: 'KYC Sweep & Fallback Contract',
      slots: [{ label: 'CCCD Stale' }, { label: 'CCCD Timeout' }],
    });
    const staleFieldId = sweepSetup.attachmentFieldIds[0]!;
    const timeoutFieldId = sweepSetup.attachmentFieldIds[1]!;
    const unsealedMarkerDigits = '079091887766';
    const samplePdfBytes = buildValidSinglePagePdf([
      'CONG TY TNHH THUONG MAI MINH ANH',
      `CCCD dai dien: ${unsealedMarkerDigits}`,
    ]);
    await uploadPublicSignerAttachment({
      token: sweepSetup.token,
      fieldId: staleFieldId,
      filename: 'stale-kyc.pdf',
      bytes: samplePdfBytes,
    });
    await uploadPublicSignerAttachment({
      token: sweepSetup.token,
      fieldId: timeoutFieldId,
      filename: 'timeout-kyc.pdf',
      bytes: samplePdfBytes,
    });

    // Incomplete inspectAttachmentPages throwing or returning invalid/blank metadata degrades cleanly:
    // - falls back to storedTextPreview when available;
    // - returns 'no_text' without failing when no stored preview or valid page text exists.
    const readerForFallback = new SignAiReader(
      { baseURL: 'http://model.invalid/v1', apiKey: null, model: 'test', maxRetries: 0 },
      {
        kycCheck: async () =>
          metered('sign.kyc_check', async () => ({
            output: {
              suggestedStatus: 'matched',
              summaryNote: 'Fallback succeeded from stored text preview.',
              findings: [
                {
                  category: 'entity_name',
                  assessment: 'match',
                  extractedValue: 'CONG TY TNHH THUONG MAI MINH ANH',
                  expectedValue: 'CONG TY TNHH THUONG MAI MINH ANH',
                  pageNumber: 1,
                  quoteExcerpt: 'CONG TY TNHH THUONG MAI MINH ANH',
                  explanation: 'Matched legal entity name from stored text preview.',
                },
              ],
            },
            usage: { inputTokens: 80, outputTokens: 30 },
          })),
      },
    );
    const fallbackAi = signAi(readerForFallback, new DraftBudget({ perOrgPerMinute: 20, perUserPerMinute: 20 }));
    const noTextIncomplete = await proposeEnvelopeKycCheck({
      ai: fallbackAi,
      runtime,
      orgId: org.orgId,
      actor: asUser(member),
      envelopeId: sweepSetup.envelopeId,
      fieldId: staleFieldId,
      inspectAttachmentPages: async () => [{ page: 0, text: '   ' }],
      meter: { admit: async () => {}, record: async () => {} },
    });
    expect(noTextIncomplete.ai).toBe('no_text');

    // Run deterministic inspection on staleFieldId to populate storedTextPreview, then test throwing inspectAttachmentPages fallback + unsealed PDPL erase.
    await runtime.execute(
      'sign.kyc.run_deterministic',
      { envelopeId: sweepSetup.envelopeId, fieldId: staleFieldId },
      { actor: asUser(member), orgId: org.orgId },
    );
    await runSignPdfInspectJob(
      { workerDb, runtime: workerRuntime, store, extract: realExtract },
      { orgId: org.orgId, targetKind: 'kyc_attachment', envelopeId: sweepSetup.envelopeId, fieldId: staleFieldId },
    );
    const recoveredFromPreview = await proposeEnvelopeKycCheck({
      ai: fallbackAi,
      runtime,
      orgId: org.orgId,
      actor: asUser(member),
      envelopeId: sweepSetup.envelopeId,
      fieldId: staleFieldId,
      inspectAttachmentPages: async () => {
        throw new Error('Transient inspect reader unavailable');
      },
      meter: { admit: async () => {}, record: async () => {} },
    });
    expect(recoveredFromPreview.ai).toBe('used');

    // Backdate staleFieldId & timeoutFieldId pending KYC checks via fresh pending slot + sweepSignPendingKycWork.
    await uploadPublicSignerAttachment({
      token: sweepSetup.token,
      fieldId: staleFieldId,
      filename: 'stale-requeue.pdf',
      bytes: samplePdfBytes,
    });
    await runtime.execute(
      'sign.kyc.run_deterministic',
      { envelopeId: sweepSetup.envelopeId, fieldId: staleFieldId },
      { actor: asUser(member), orgId: org.orgId },
    );
    await runtime.execute(
      'sign.kyc.run_deterministic',
      { envelopeId: sweepSetup.envelopeId, fieldId: timeoutFieldId },
      { actor: asUser(member), orgId: org.orgId },
    );
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(
        `UPDATE ludy_sign.kyc_check SET status = 'pending', updated_at = now() - interval '5 minutes' WHERE org_id = $1 AND field_id = $2`,
        [org.orgId, staleFieldId],
      );
      await c.query(
        `UPDATE ludy_sign.kyc_check SET status = 'pending', updated_at = now() - interval '45 minutes' WHERE org_id = $1 AND field_id = $2`,
        [org.orgId, timeoutFieldId],
      );
      await c.query('COMMIT');
    });

    const requeued: Array<{ orgId: string; envelopeId: string; fieldId: string }> = [];
    const kycSwept = await sweepSignPendingKycWork({
      workerDb,
      runtime: workerRuntime,
      orgId: org.orgId,
      olderThan: new Date(Date.now() - 60_000),
      timeoutBefore: new Date(Date.now() - 30 * 60_000),
      enqueueKycInspect: async (oId, envId, fId) => {
        requeued.push({ orgId: oId, envelopeId: envId, fieldId: fId });
      },
    });
    expect(kycSwept).toEqual({ requeued: 1, timedOut: 1 });
    expect(requeued).toEqual([{ orgId: org.orgId, envelopeId: sweepSetup.envelopeId, fieldId: staleFieldId }]);

    const afterTimeoutRow = await admin((c) =>
      c.query<{ status: string; findings_json: { inspectState?: string } }>(
        `SELECT status, findings_json FROM ludy_sign.kyc_check WHERE org_id = $1 AND field_id = $2`,
        [org.orgId, timeoutFieldId],
      ),
    );
    expect(afterTimeoutRow.rows[0]?.status).toBe('needs_review');
    expect(afterTimeoutRow.rows[0]?.findings_json?.inspectState).toBe('failed');

    // Inspect requeued staleFieldId, void sweepSetup (unsealed), then verify PDPL erase reports + unlinks attachment_file_id.
    await runSignPdfInspectJob(
      { workerDb, runtime: workerRuntime, store, extract: realExtract },
      { orgId: org.orgId, targetKind: 'kyc_attachment', envelopeId: sweepSetup.envelopeId, fieldId: staleFieldId },
    );
    await runtime.execute(
      'sign.envelope.void',
      { envelopeId: sweepSetup.envelopeId, reason: 'Cleanup KYC sweep test' },
      { actor: asUser(owner), orgId: org.orgId },
    );
    const unsealedEraseRes = await runtime.execute<PersonalDataErasure>(
      'kernel.personal_data.erase',
      { value: unsealedMarkerDigits },
      { actor: asMfa(owner), orgId: org.orgId },
    );
    expect(unsealedEraseRes.erased).toContainEqual({ column: 'ludy_sign.kyc_check.findings_json', rows: 1 });
    expect(unsealedEraseRes.erased).toContainEqual({ column: 'ludy_sign.kyc_check.file_id', rows: 1 });
    expect(unsealedEraseRes.erased).toContainEqual({ column: 'ludy_sign.field.attachment_file_id', rows: 1 });
    const detachedField = await admin((c) =>
      c.query<{ attachment_file_id: string | null }>(
        `SELECT attachment_file_id FROM ludy_sign.field WHERE org_id = $1 AND id = $2`,
        [org.orgId, staleFieldId],
      ),
    );
    expect(detachedField.rows[0]?.attachment_file_id).toBeNull();

    // ludy_kernel.org_purge deletes ludy_sign.kyc_check cleanly with zero FK violations.
    const purgeSetup = await createEnvelopeWithAttachmentSlots(owner, {
      title: 'Purge Org KYC Envelope',
      slots: [{ label: 'CCCD Purge' }],
      targetOrg: purgeOrg,
    });
    await uploadPublicSignerAttachment({
      token: purgeSetup.token,
      fieldId: purgeSetup.attachmentFieldIds[0]!,
      filename: 'purge-cccd.png',
      bytes: makeValidPngBytes(64, 32, 'purge-cccd'),
    });
    expect(
      (
        await rpc(
          'sign/kyc/run_deterministic',
          owner,
          { envelopeId: purgeSetup.envelopeId, fieldId: purgeSetup.attachmentFieldIds[0]! },
          purgeOrg.slug,
        )
      ).status,
    ).toBe(200);

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
      [purgeOrg.orgId, '--reason', 'Owner offboarded sign KYC test org'],
    );
    expect(purgeCode, purgeLogs.join('\n')).toBe(0);

    const leftKyc = await admin((c) =>
      c.query<{ count: string }>(`SELECT count(*)::text AS count FROM ludy_sign.kyc_check WHERE org_id = $1`, [
        purgeOrg.orgId,
      ]),
    );
    expect(Number(leftKyc.rows[0]?.count ?? '0')).toBe(0);
  }, 30_000);
});
