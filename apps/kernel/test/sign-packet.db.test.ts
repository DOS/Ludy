// SPDX-License-Identifier: AGPL-3.0-only
// PostgreSQL 17 integration tests for eSign Slice 6c multi-document signing packets (#4722):
//   - Lazy doc 1 materialization + existing field backfill on doc 2 add
//   - Add / reorder / remove (1-5 PDFs, .docx provenance, 25 MiB cap, 200-page aggregate cap, cascade cleanup)
//   - Post-draft DB trigger immutability (envelope_document_guard, field_guard)
//   - Confidential source visibility parity (hr_contract & meeting_minutes can_read_sign_file + cleanup_meeting_minutes_envelopes)
//   - End-to-end worker inspect, real @ludy/extract multi-doc pdf_seal (/Outlines + unified SHA-256 + certificate.documents), and /api/sign/verify
//   - Public ceremony public_record_view, 1-arg & 2-arg public_pdf_source OTP gate & cross-envelope isolation, and single-consent public_submit
//   - Vy cross-document consistency check (ai: used / off / budget + deterministic missing-signature finding)
//   - Cross-tenant RLS isolation, viewer/agent write refusal, and org_purge cleanup of ludy_sign.envelope_document
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { AiBudgetExhaustedError, SignAiReader, type AiCall, type AiMeter } from '@ludy/agent';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createExtractApp } from '@ludy/extract';
import { createExtractClient, type ExtractClient } from '@ludy/extract-contract';
import { buildKernelCommands, kernelQueries } from '@ludy/kernel';
import { zSignEnvelopeDetail, type SignPacketConsistencyCheckResult } from '@ludy/kernel-contract';
import {
  Runtime,
  contentGeneration,
  fileKey,
  putFile,
  sha256Hex,
  type AgentActor,
  type BlobStore,
} from '@ludy/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import { signCommands, signQueries } from '@ludy/mod-sign';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { createAuthenticator } from '../src/auth.ts';
import { AVAILABLE_MODULES, loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { orgPurgeCommand, runOrgPurge } from '../src/org-purge.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { analyzeSignPacketConsistency, signAi } from '../src/sign-ai.ts';
import { runSignPdfInspectJob, runSignPdfSealJob } from '../src/sign-worker.ts';
import { TEST_MANIFESTS } from './manifests.ts';

type SignEnvelopeDetail = z.infer<typeof zSignEnvelopeDetail> & {
  documents: NonNullable<z.infer<typeof zSignEnvelopeDetail>['documents']>;
};

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const JWT_SIGNING_KEY = 'test-only-jwt-key-for-sign-packet-4722-0123456789abcdef';
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

function makeValidPngBytes(width = 64, height = 32, seed = 'sig'): Uint8Array {
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
    rawBytes[px + 1] = 0x22;
    rawBytes[px + 2] = 0x44;
    rawBytes[px + 3] = 0xff;
  }
  return Uint8Array.from(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(rawBytes)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

function escapePdfLiteral(line: string): string {
  return line.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function buildValidMultiPagePdf(linesPerPage: readonly (readonly string[])[]): Uint8Array {
  const objects: string[] = [];
  const pageCount = linesPerPage.length;
  const pageIds: number[] = [];
  for (let i = 0; i < pageCount; i++) {
    pageIds.push(4 + i * 2);
  }
  objects.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  objects.push(`2 0 obj\n<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>\nendobj\n`);
  objects.push('3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');

  for (let i = 0; i < pageCount; i++) {
    const pageObjId = 4 + i * 2;
    const contentObjId = 5 + i * 2;
    const streamLines = ['BT', '/F1 12 Tf', '50 760 Td'];
    for (const [lineIdx, line] of (linesPerPage[i] ?? []).entries()) {
      if (lineIdx > 0) streamLines.push('0 -18 Td');
      streamLines.push(`(${escapePdfLiteral(line)}) Tj`);
    }
    streamLines.push('ET');
    const streamContent = `${streamLines.join('\n')}\n`;
    const streamLen = Buffer.byteLength(streamContent, 'utf8');
    objects.push(
      `${pageObjId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObjId} 0 R >>\nendobj\n`,
    );
    objects.push(`${contentObjId} 0 obj\n<< /Length ${streamLen} >>\nstream\n${streamContent}endstream\nendobj\n`);
  }

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

const VALID_PNG_BASE64 = Buffer.from(makeValidPngBytes(96, 36, 'packet-sig')).toString('base64');

const suite = ADMIN ? describe : describe.skip;

suite('eSign Slice 6c multi-document signing packet on PostgreSQL 17 (#4722)', () => {
  const dbName = `ludy_test_sign_packet_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

  const owner: Account = { subject: randomUUID(), email: 'owner-pkt@example.com', session: randomUUID(), userId: '' };
  const adminUser: Account = { subject: randomUUID(), email: 'admin-pkt@example.com', session: randomUUID(), userId: '' };
  const member: Account = { subject: randomUUID(), email: 'member-pkt@example.com', session: randomUUID(), userId: '' };
  const attendee: Account = { subject: randomUUID(), email: 'attendee-pkt@example.com', session: randomUUID(), userId: '' };
  const viewer: Account = { subject: randomUUID(), email: 'viewer-pkt@example.com', session: randomUUID(), userId: '' };
  const orgBOwner: Account = { subject: randomUUID(), email: 'orgb-pkt@example.com', session: randomUUID(), userId: '' };

  let org = { slug: '', orgId: '' };
  let orgB = { slug: '', orgId: '' };
  let purgeOrg = { slug: '', orgId: '' };

  const asUser = (who: Account) => ({
    type: 'user' as const,
    userId: who.userId,
    sessionId: who.session,
    aal: 'aal1' as const,
  });

  const asSystem = { type: 'system' as const, component: 'sign.test' };

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
    options: { mfa?: boolean } = {},
  ) {
    const response = await appAiOff.request(`/api/rpc/${path}`, {
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

  async function postPublic(path: string, body: unknown, ip = '203.0.113.42') {
    return appAiOff.request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': ip,
      },
      body: JSON.stringify(body),
    });
  }

  async function ingestPdfBytes(
    who: Account,
    pdfBytes: Uint8Array,
    filename: string,
    targetOrgId = org.orgId,
    source: string = 'sign_document',
  ): Promise<{ fileId: string; sha256: string; storageKey: string; generation: string }> {
    const sha256 = sha256Hex(pdfBytes);
    const key = fileKey(targetOrgId, sha256);
    const generation = await putFile(store, key, pdfBytes, 'application/pdf', sha256);
    const { fileId } = await runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      {
        filename,
        contentType: 'application/pdf',
        sizeBytes: pdfBytes.byteLength,
        sha256,
        storageKey: key,
        generation: generation || contentGeneration(sha256),
        source,
      },
      { actor: asUser(who), orgId: targetOrgId },
    );
    return { fileId, sha256, storageKey: key, generation: generation || contentGeneration(sha256) };
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

    for (const who of [owner, adminUser, member, attendee, viewer, orgBOwner]) {
      const me = await rpc('me/get', who, undefined, null);
      expect(me.status).toBe(200);
      who.userId = String(me.body.userId);
    }

    const createdA = await rpc('org/create', owner, { name: 'Packet Org A', idempotencyKey: randomUUID() }, null);
    expect(createdA.status).toBe(200);
    org = { slug: String(createdA.body.slug), orgId: String(createdA.body.orgId) };

    for (const [who, role] of [
      [adminUser, 'admin'],
      [member, 'member'],
      [attendee, 'member'],
      [viewer, 'viewer'],
    ] as const) {
      const invite = await rpc('org/invite', owner, { email: who.email, role }, org.slug, { mfa: true });
      expect(invite.status).toBe(200);
      const acceptPath = String(invite.body.acceptPath);
      expect((await rpc('invites/accept', who, { token: acceptPath.split('#')[1] }, null)).status).toBe(200);
    }

    const createdB = await rpc('org/create', orgBOwner, { name: 'Packet Org B', idempotencyKey: randomUUID() }, null);
    expect(createdB.status).toBe(200);
    orgB = { slug: String(createdB.body.slug), orgId: String(createdB.body.orgId) };

    const createdPurge = await rpc('org/create', owner, { name: 'Purge Packet Org', idempotencyKey: randomUUID() }, null);
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

  it('materializes doc 1 lazily, backfills existing fields, handles reorder/remove, and enforces 5-doc/25MiB/200-page limits & triggers', async () => {
    const pdf1 = buildValidMultiPagePdf([['Hop dong chinh trang 1'], ['Hop dong chinh trang 2']]);
    const pdf2 = buildValidMultiPagePdf([['Phu luc 01 trang 1'], ['Phu luc 01 trang 2'], ['Phu luc 01 trang 3']]);
    const pdf3 = buildValidMultiPagePdf([['Phu luc 02']]);
    const pdf4 = buildValidMultiPagePdf([['Phu luc 03']]);
    const pdf5 = buildValidMultiPagePdf([['Phu luc 04']]);
    const pdf6 = buildValidMultiPagePdf([['Phu luc 05']]);

    const f1 = await ingestPdfBytes(member, pdf1, 'main-contract.pdf');
    const created = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      { title: 'Packet Limits Draft', routingMode: 'parallel', sourceFileId: f1.fileId },
      { actor: asUser(member), orgId: org.orgId },
    );
    const envelopeId = created.envelopeId;

    const pendingSingle = zSignEnvelopeDetail.parse(
      await runtime.query<SignEnvelopeDetail>('sign.envelope.get', { envelopeId }, { actor: asUser(member), orgId: org.orgId }),
    );
    expect(pendingSingle.envelope.inspectStatus).toBe('pending');
    expect(pendingSingle.envelope.pageDimensions).toBeNull();
    expect(pendingSingle.documents).toHaveLength(1);
    expect(pendingSingle.documents![0]!.pageDimensions).toBeNull();

    await runSignPdfInspectJob({ workerDb, runtime: workerRuntime, store, extract: realExtract }, { orgId: org.orgId, envelopeId });

    const signerRes = await runtime.execute<{ signerId: string }>(
      'sign.signer.add',
      {
        envelopeId,
        routingOrder: 1,
        signerRole: 'signer',
        roleLabel: 'Ben B',
        name: 'Tran Van B',
        email: 'tranb@example.com',
        deliveryMode: 'link',
        requireEmailOtp: false,
      },
      { actor: asUser(member), orgId: org.orgId },
    );

    // Place a field BEFORE adding doc 2 (document_id is NULL on legacy single-doc).
    await runtime.execute(
      'sign.field.set',
      {
        envelopeId,
        fields: [
          {
            signerId: signerRes.signerId,
            fieldType: 'signature',
            pageNumber: 2,
            xNorm: 0.1,
            yNorm: 0.7,
            wNorm: 0.25,
            hNorm: 0.08,
            required: true,
          },
        ],
      },
      { actor: asUser(member), orgId: org.orgId },
    );

    // Add doc 2: lazily materializes doc 1 and backfills the existing NULL field to doc 1's id.
    const f2 = await ingestPdfBytes(member, pdf2, 'annex-1.pdf');
    const added2 = await runtime.execute<{ documentId: string; docIndex: number }>(
      'sign.envelope.document.add',
      { envelopeId, sourceFileId: f2.fileId, title: 'Phu luc 01' },
      { actor: asUser(member), orgId: org.orgId },
    );
    expect(added2.docIndex).toBe(2);

    const pendingMulti = zSignEnvelopeDetail.parse(
      await runtime.query<SignEnvelopeDetail>('sign.envelope.get', { envelopeId }, { actor: asUser(member), orgId: org.orgId }),
    );
    expect(pendingMulti.documents).toHaveLength(2);
    expect(pendingMulti.documents![0]!.pageDimensions).toHaveLength(2);
    expect(pendingMulti.documents![1]!.inspectStatus).toBe('pending');
    expect(pendingMulti.documents![1]!.pageDimensions).toBeNull();

    await runSignPdfInspectJob(
      { workerDb, runtime: workerRuntime, store, extract: realExtract },
      { orgId: org.orgId, targetKind: 'envelope_document', envelopeId, documentId: added2.documentId },
    );

    const detailAfterAdd2 = await runtime.query<SignEnvelopeDetail>('sign.envelope.get', { envelopeId }, { actor: asUser(member), orgId: org.orgId });
    expect(detailAfterAdd2.documents).toHaveLength(2);
    const doc1Id = detailAfterAdd2.documents[0]!.id!;
    expect(doc1Id).toBeTruthy();
    expect(detailAfterAdd2.documents[0]!.pageCount).toBe(2);
    expect(detailAfterAdd2.documents[1]!.pageCount).toBe(3);
    expect(detailAfterAdd2.envelope.pageCount).toBe(5);
    expect(detailAfterAdd2.envelope.inspectStatus).toBe('passed');
    expect(detailAfterAdd2.fields[0]!.documentId).toBe(doc1Id);

    // Viewer and Agent cannot mutate envelope_document (writer_insert / agent_write_guard).
    await expect(
      runtime.execute(
        'sign.envelope.document.add',
        { envelopeId, sourceFileId: (await ingestPdfBytes(member, pdf3, 'viewer-blocked.pdf')).fileId },
        { actor: asUser(viewer), orgId: org.orgId },
      ),
    ).rejects.toMatchObject({ status: 403 });
    const agentActor: AgentActor = { type: 'agent', agentId: '01900000-0000-7000-8000-000000009999', runId: randomUUID() };
    await expect(
      runtime.execute(
        'sign.envelope.document.add',
        { envelopeId, sourceFileId: (await ingestPdfBytes(member, pdf3, 'agent-blocked.pdf')).fileId },
        { actor: agentActor, orgId: org.orgId },
      ),
    ).rejects.toMatchObject({ status: 403 });

    // Reorder [doc2, doc1] and place a field on doc2 page 3, verify field_guard out-of-bounds rejection.
    await runtime.execute(
      'sign.envelope.document.reorder',
      { envelopeId, documentIds: [added2.documentId, doc1Id] },
      { actor: asUser(member), orgId: org.orgId },
    );
    await expect(
      runtime.execute(
        'sign.envelope.document.reorder',
        { envelopeId, documentIds: [doc1Id] },
        { actor: asUser(member), orgId: org.orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_INVALID_DOCUMENT_ORDER' });

    const reordered = await runtime.query<SignEnvelopeDetail>('sign.envelope.get', { envelopeId }, { actor: asUser(member), orgId: org.orgId });
    expect(reordered.documents.map((d) => d.id)).toEqual([added2.documentId, doc1Id]);
    expect(reordered.documents.map((d) => d.fileId)).toEqual([f2.fileId, f1.fileId]);

    // Field saved with documentId omitted on a materialized packet binds explicitly to doc_index = 1.
    await runtime.execute(
      'sign.field.set',
      {
        envelopeId,
        fields: [
          {
            signerId: signerRes.signerId,
            fieldType: 'signature',
            pageNumber: 1,
            xNorm: 0.1,
            yNorm: 0.7,
            wNorm: 0.25,
            hNorm: 0.08,
            required: true,
          },
        ],
      },
      { actor: asUser(member), orgId: org.orgId },
    );
    const boundNullDetail = await runtime.query<SignEnvelopeDetail>('sign.envelope.get', { envelopeId }, { actor: asUser(member), orgId: org.orgId });
    expect(boundNullDetail.fields[0]!.documentId).toBe(added2.documentId);

    // Concurrent race test: legacy inspect_complete without documentId resolves lazily materialized Doc 1 cleanly.
    const raceDoc1 = await ingestPdfBytes(member, pdf1, 'race-doc1.pdf');
    const raceDoc2 = await ingestPdfBytes(member, pdf3, 'race-doc2.pdf');
    const raceEnv = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      { title: 'Inspect Race Draft', routingMode: 'parallel', sourceFileId: raceDoc1.fileId },
      { actor: asUser(member), orgId: org.orgId },
    );
    await runtime.execute(
      'sign.envelope.document.add',
      { envelopeId: raceEnv.envelopeId, sourceFileId: raceDoc2.fileId, title: 'Race Doc 2' },
      { actor: asUser(member), orgId: org.orgId },
    );
    await workerRuntime.execute(
      'sign.envelope.inspect_complete',
      {
        envelopeId: raceEnv.envelopeId,
        outcome: 'passed',
        pageCount: 2,
        pageDimensions: [
          { page: 1, widthPt: 595, heightPt: 842, rotation: 0 },
          { page: 2, widthPt: 595, heightPt: 842, rotation: 0 },
        ],
        detectedTags: [],
      },
      { actor: asSystem, orgId: org.orgId },
    );
    const raceDetail = await runtime.query<SignEnvelopeDetail>('sign.envelope.get', { envelopeId: raceEnv.envelopeId }, { actor: asUser(member), orgId: org.orgId });
    expect(raceDetail.documents[0]!.inspectStatus).toBe('passed');
    expect(raceDetail.documents[1]!.inspectStatus).toBe('pending');
    expect(raceDetail.envelope.inspectStatus).toBe('pending');

    await expect(
      runtime.execute(
        'sign.field.set',
        {
          envelopeId,
          fields: [
            {
              documentId: added2.documentId,
              signerId: signerRes.signerId,
              fieldType: 'text',
              pageNumber: 9,
              xNorm: 0.1,
              yNorm: 0.2,
              wNorm: 0.2,
              hNorm: 0.05,
              required: true,
            },
          ],
        },
        { actor: asUser(member), orgId: org.orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_FIELD_OUT_OF_BOUNDS' });

    await runtime.execute(
      'sign.field.set',
      {
        envelopeId,
        fields: [
          {
            documentId: doc1Id,
            signerId: signerRes.signerId,
            fieldType: 'signature',
            pageNumber: 2,
            xNorm: 0.1,
            yNorm: 0.7,
            wNorm: 0.25,
            hNorm: 0.08,
            required: true,
          },
          {
            documentId: added2.documentId,
            signerId: signerRes.signerId,
            fieldType: 'text',
            pageNumber: 3,
            xNorm: 0.2,
            yNorm: 0.3,
            wNorm: 0.25,
            hNorm: 0.06,
            required: true,
          },
        ],
      },
      { actor: asUser(member), orgId: org.orgId },
    );

    // Add docs 3, 4, 5 -> 6th doc fails SIGN_PACKET_DOC_LIMIT.
    const f3 = await ingestPdfBytes(member, pdf3, 'annex-2.pdf');
    const f4 = await ingestPdfBytes(member, pdf4, 'annex-3.pdf');
    const f5 = await ingestPdfBytes(member, pdf5, 'annex-4.pdf');
    const f6 = await ingestPdfBytes(member, pdf6, 'annex-5.pdf');
    const d3 = await runtime.execute<{ documentId: string }>('sign.envelope.document.add', { envelopeId, sourceFileId: f3.fileId }, { actor: asUser(member), orgId: org.orgId });
    const d4 = await runtime.execute<{ documentId: string }>('sign.envelope.document.add', { envelopeId, sourceFileId: f4.fileId }, { actor: asUser(member), orgId: org.orgId });
    const d5 = await runtime.execute<{ documentId: string }>('sign.envelope.document.add', { envelopeId, sourceFileId: f5.fileId }, { actor: asUser(member), orgId: org.orgId });

    await expect(
      runtime.execute('sign.envelope.document.add', { envelopeId, sourceFileId: f6.fileId }, { actor: asUser(member), orgId: org.orgId }),
    ).rejects.toMatchObject({ code: 'SIGN_PACKET_DOC_LIMIT' });

    // Remove d3, d4, d5 and doc1Id until 1 left -> removing last fails SIGN_PACKET_MIN_DOCS, removing added2 cascades its field.
    await runtime.execute('sign.envelope.document.remove', { envelopeId, documentId: d3.documentId }, { actor: asUser(member), orgId: org.orgId });
    await runtime.execute('sign.envelope.document.remove', { envelopeId, documentId: d4.documentId }, { actor: asUser(member), orgId: org.orgId });
    await runtime.execute('sign.envelope.document.remove', { envelopeId, documentId: d5.documentId }, { actor: asUser(member), orgId: org.orgId });
    await runtime.execute('sign.envelope.document.remove', { envelopeId, documentId: added2.documentId }, { actor: asUser(member), orgId: org.orgId });

    const remaining = await runtime.query<SignEnvelopeDetail>('sign.envelope.get', { envelopeId }, { actor: asUser(member), orgId: org.orgId });
    expect(remaining.documents).toHaveLength(1);
    expect(remaining.documents[0]!.id).toBe(doc1Id);
    expect(remaining.fields).toHaveLength(1);
    expect(remaining.fields[0]!.documentId).toBe(doc1Id);

    await expect(
      runtime.execute('sign.envelope.document.remove', { envelopeId, documentId: doc1Id }, { actor: asUser(member), orgId: org.orgId }),
    ).rejects.toMatchObject({ code: 'SIGN_PACKET_MIN_DOCS' });

    // >25 MiB aggregate rejection (two files <= 25 MiB each whose sum exceeds 25 MiB).
    const bigPdf = await ingestPdfBytes(member, pdf6, 'oversized.pdf');
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(`UPDATE ludy_kernel.file SET size_bytes = 15728640 WHERE org_id = $1 AND id = $2`, [org.orgId, f1.fileId]);
      await c.query(`UPDATE ludy_kernel.file SET size_bytes = 11534336 WHERE org_id = $1 AND id = $2`, [org.orgId, bigPdf.fileId]);
      await c.query('COMMIT');
    });
    await expect(
      runtime.execute('sign.envelope.document.add', { envelopeId, sourceFileId: bigPdf.fileId }, { actor: asUser(member), orgId: org.orgId }),
    ).rejects.toMatchObject({ code: 'SIGN_PACKET_SIZE_LIMIT' });

    // >200 total pages rejection across 2 documents.
    const bigPages1 = buildValidMultiPagePdf(Array.from({ length: 110 }, (_, idx) => [`Page ${idx + 1}`]));
    const bigPages2 = buildValidMultiPagePdf(Array.from({ length: 95 }, (_, idx) => [`Annex Page ${idx + 1}`]));
    const bp1 = await ingestPdfBytes(member, bigPages1, '110-pages.pdf');
    const bp2 = await ingestPdfBytes(member, bigPages2, '95-pages.pdf');
    const envOver = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      { title: 'Over 200 Pages', routingMode: 'parallel', sourceFileId: bp1.fileId },
      { actor: asUser(member), orgId: org.orgId },
    );
    await runSignPdfInspectJob({ workerDb, runtime: workerRuntime, store, extract: realExtract }, { orgId: org.orgId, envelopeId: envOver.envelopeId });
    const overDoc2 = await runtime.execute<{ documentId: string }>(
      'sign.envelope.document.add',
      { envelopeId: envOver.envelopeId, sourceFileId: bp2.fileId },
      { actor: asUser(member), orgId: org.orgId },
    );
    await runSignPdfInspectJob(
      { workerDb, runtime: workerRuntime, store, extract: realExtract },
      { orgId: org.orgId, targetKind: 'envelope_document', envelopeId: envOver.envelopeId, documentId: overDoc2.documentId },
    );
    const overDetail = await runtime.query<SignEnvelopeDetail>('sign.envelope.get', { envelopeId: envOver.envelopeId }, { actor: asUser(member), orgId: org.orgId });
    expect(overDetail.envelope.inspectStatus).toBe('failed');
    expect(overDetail.envelope.inspectError).toContain('200');
  }, 60_000);

  it('seals multi-doc packets end-to-end with OTP ceremony, /Outlines, unified SHA-256, certificate.documents, and Vy consistency check', async () => {
    const doc1Pdf = buildValidMultiPagePdf([
      ['HOP DONG DICH VU SO 01', 'Ben A: Cong ty TNHH Alpha', 'Gia tri: 120.000.000 VND'],
    ]);
    const doc2Pdf = buildValidMultiPagePdf([
      ['PHU LUC 01 - DIEU KHOAN BO SUNG', 'Trang 1 phu luc'],
      ['PHU LUC 01 - BANG GIA', 'Tong thanh toan: 150.000.000 VND'],
    ]);
    const f1 = await ingestPdfBytes(member, doc1Pdf, 'contract-main.pdf');
    const f2 = await ingestPdfBytes(member, doc2Pdf, 'contract-annex.pdf');

    const { envelopeId } = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      { title: 'Bo ho so ky da tai lieu', routingMode: 'parallel', sourceFileId: f1.fileId },
      { actor: asUser(member), orgId: org.orgId },
    );
    await runSignPdfInspectJob({ workerDb, runtime: workerRuntime, store, extract: realExtract }, { orgId: org.orgId, envelopeId });
    const doc2Added = await runtime.execute<{ documentId: string }>(
      'sign.envelope.document.add',
      { envelopeId, sourceFileId: f2.fileId, title: 'Phu luc 01' },
      { actor: asUser(member), orgId: org.orgId },
    );
    // Test plain SignEnvelopeJob sweeping pendingDocuments automatically.
    await runSignPdfInspectJob({ workerDb, runtime: workerRuntime, store, extract: realExtract }, { orgId: org.orgId, envelopeId });

    const detail = await runtime.query<SignEnvelopeDetail>('sign.envelope.get', { envelopeId }, { actor: asUser(member), orgId: org.orgId });
    expect(detail.documents).toHaveLength(2);
    const doc1Id = detail.documents[0]!.id!;
    const doc2Id = doc2Added.documentId;
    expect(detail.envelope.pageCount).toBe(3);

    const { signerId } = await runtime.execute<{ signerId: string }>(
      'sign.signer.add',
      {
        envelopeId,
        routingOrder: 1,
        signerRole: 'signer',
        roleLabel: 'Ben B',
        name: 'Le Thi C',
        email: 'lethic@example.com',
        deliveryMode: 'link',
        requireEmailOtp: true,
      },
      { actor: asUser(member), orgId: org.orgId },
    );

    // Place signature on Doc 1 only first -> deterministic consistency check warns about missing signature on annex Doc 2.
    await runtime.execute(
      'sign.field.set',
      {
        envelopeId,
        fields: [
          {
            documentId: doc1Id,
            signerId,
            fieldType: 'signature',
            pageNumber: 1,
            xNorm: 0.12,
            yNorm: 0.72,
            wNorm: 0.24,
            hNorm: 0.08,
            required: true,
          },
        ],
      },
      { actor: asUser(member), orgId: org.orgId },
    );

    const aiOffRes: SignPacketConsistencyCheckResult = await analyzeSignPacketConsistency({
      ai: signAi(null, new DraftBudget({ perUserPerMinute: 10, perOrgPerMinute: 20 })),
      runtime,
      orgId: org.orgId,
      actor: asUser(member),
      envelopeId,
      meter: { admit: async () => {}, record: async () => {} },
    });
    expect(aiOffRes.ai).toBe('off');
    expect(aiOffRes.findings.some((f) => f.kind === 'missing_signature_field' && f.source === 'deterministic' && f.documentId === doc2Id)).toBe(true);

    // Read-only viewer cannot invoke metered packet consistency check (403 FORBIDDEN).
    await expect(
      analyzeSignPacketConsistency({
        ai: signAi(null, new DraftBudget({ perUserPerMinute: 10, perOrgPerMinute: 20 })),
        runtime,
        orgId: org.orgId,
        actor: asUser(viewer),
        envelopeId,
        meter: { admit: async () => {}, record: async () => {} },
      }),
    ).rejects.toMatchObject({ status: 403 });

    // Placing 'initials' on annex Doc 2 satisfies signature coverage in deterministic consistency check.
    await runtime.execute(
      'sign.field.set',
      {
        envelopeId,
        fields: [
          {
            documentId: doc1Id,
            signerId,
            fieldType: 'signature',
            pageNumber: 1,
            xNorm: 0.12,
            yNorm: 0.72,
            wNorm: 0.24,
            hNorm: 0.08,
            required: true,
          },
          {
            documentId: doc2Id,
            signerId,
            fieldType: 'initials',
            pageNumber: 1,
            xNorm: 0.75,
            yNorm: 0.85,
            wNorm: 0.14,
            hNorm: 0.06,
            required: false,
          },
        ],
      },
      { actor: asUser(member), orgId: org.orgId },
    );
    const initialsCoveredRes = await analyzeSignPacketConsistency({
      ai: signAi(null, new DraftBudget({ perUserPerMinute: 10, perOrgPerMinute: 20 })),
      runtime,
      orgId: org.orgId,
      actor: asUser(member),
      envelopeId,
      meter: { admit: async () => {}, record: async () => {} },
    });
    expect(initialsCoveredRes.findings.some((f) => f.kind === 'missing_signature_field' && f.documentId === doc2Id)).toBe(false);

    // Restore Doc 1 only for the metered AI test below.
    await runtime.execute(
      'sign.field.set',
      {
        envelopeId,
        fields: [
          {
            documentId: doc1Id,
            signerId,
            fieldType: 'signature',
            pageNumber: 1,
            xNorm: 0.12,
            yNorm: 0.72,
            wNorm: 0.24,
            hNorm: 0.08,
            required: true,
          },
        ],
      },
      { actor: asUser(member), orgId: org.orgId },
    );

    // Metered Vy packet consistency check with AI on & budget exhaustion degradation.
    const admittedCalls: AiCall[] = [];
    const okMeter: AiMeter = {
      admit: async (call) => {
        admittedCalls.push(call);
      },
      record: async () => {},
    };
    const meteredReader = new SignAiReader({ baseURL: 'http://model.invalid/v1', apiKey: null, model: 'test', maxRetries: 0 });
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          id: 'chatcmpl-db-packet',
          object: 'chat.completion',
          created: 1,
          model: 'test',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  summaryText: 'Hop dong ghi 120.000.000 VND nhung phu luc ghi 150.000.000 VND.',
                  findings: [
                    {
                      kind: 'mismatched_total',
                      severity: 'critical',
                      title: 'Lech gia tri hop dong va phu luc',
                      explanation: 'Gia tri hop dong 120.000.000 VND khac 150.000.000 VND o phu luc.',
                      docIndex: 2,
                      documentTitle: 'Phu luc 01',
                      pageNumber: 2,
                      quoteExcerpt: 'Tong thanh toan: 150.000.000 VND',
                    },
                  ],
                }),
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;

    try {
      const aiUsedRes = await analyzeSignPacketConsistency({
        ai: signAi(meteredReader, new DraftBudget({ perUserPerMinute: 10, perOrgPerMinute: 20 })),
        runtime,
        orgId: org.orgId,
        actor: asUser(member),
        envelopeId,
        documents: [
          { documentId: doc1Id, pages: [{ page: 1, text: 'HOP DONG DICH VU SO 01\nGia tri: 120.000.000 VND' }] },
          { documentId: doc2Id, pages: [{ page: 1, text: 'PHU LUC 01' }, { page: 2, text: 'Tong thanh toan: 150.000.000 VND' }] },
        ],
        meter: okMeter,
      });
      expect(aiUsedRes.ai).toBe('used');
      expect(admittedCalls).toHaveLength(1);
      expect(admittedCalls[0]!.feature).toBe('sign.packet_consistency');
      expect(aiUsedRes.findings.some((f) => f.kind === 'mismatched_total' && f.source === 'ai' && f.tainted === true)).toBe(true);

      const exhaustedMeter: AiMeter = {
        admit: async () => {
          throw new AiBudgetExhaustedError('org', null);
        },
        record: async () => {},
      };
      const budgetRes = await analyzeSignPacketConsistency({
        ai: signAi(meteredReader, new DraftBudget({ perUserPerMinute: 10, perOrgPerMinute: 20 })),
        runtime,
        orgId: org.orgId,
        actor: asUser(member),
        envelopeId,
        documents: [
          { documentId: doc1Id, pages: [{ page: 1, text: 'Gia tri: 120.000.000 VND' }] },
          { documentId: doc2Id, pages: [{ page: 2, text: 'Tong thanh toan: 150.000.000 VND' }] },
        ],
        meter: exhaustedMeter,
      });
      expect(budgetRes.ai).toBe('budget');
      expect(budgetRes.findings.some((f) => f.source === 'deterministic')).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }

    // Add required text field on Doc 2 page 2 and send envelope.
    await runtime.execute(
      'sign.field.set',
      {
        envelopeId,
        fields: [
          {
            documentId: doc1Id,
            signerId,
            fieldType: 'signature',
            pageNumber: 1,
            xNorm: 0.12,
            yNorm: 0.72,
            wNorm: 0.24,
            hNorm: 0.08,
            required: true,
          },
          {
            documentId: doc2Id,
            signerId,
            fieldType: 'text',
            pageNumber: 2,
            xNorm: 0.15,
            yNorm: 0.55,
            wNorm: 0.35,
            hNorm: 0.06,
            label: 'Xac nhan gia',
            required: true,
          },
        ],
      },
      { actor: asUser(member), orgId: org.orgId },
    );

    const sent = await runtime.execute<{ links: Array<{ token: string }> }>(
      'sign.envelope.send',
      { envelopeId },
      { actor: asUser(member), orgId: org.orgId },
    );
    const token = sent.links[0]!.token;

    // Post-draft DB trigger immutability check inside real tenant user context.
    const guardClient = await pool.connect();
    try {
      await guardClient.query('BEGIN');
      await guardClient.query('SELECT ludy_kernel.enter_context($1::uuid, $2::uuid)', [member.userId, org.orgId]);
      await guardClient.query('SAVEPOINT doc_guard_upd');
      await expect(
        guardClient.query(`UPDATE ludy_sign.envelope_document SET title = 'tampered' WHERE org_id = $1 AND id = $2`, [
          org.orgId,
          doc2Id,
        ]),
      ).rejects.toThrow(/ENVELOPE_FROZEN/);
      await guardClient.query('ROLLBACK TO SAVEPOINT doc_guard_upd');
      await guardClient.query('SAVEPOINT doc_guard_del');
      await expect(
        guardClient.query(`DELETE FROM ludy_sign.envelope_document WHERE org_id = $1 AND id = $2`, [org.orgId, doc2Id]),
      ).rejects.toThrow(/ENVELOPE_FROZEN/);
      await guardClient.query('ROLLBACK TO SAVEPOINT doc_guard_del');
      await guardClient.query('ROLLBACK');
    } finally {
      guardClient.release();
    }

    // OTP gate must block both 1-arg and 2-arg /api/sign/pdf before OTP verification.
    expect((await postPublic('/api/sign/pdf', { token })).status).toBe(403);
    expect((await postPublic('/api/sign/pdf', { token, documentId: doc2Id })).status).toBe(403);

    expect((await postPublic('/api/sign/otp/request', { token })).status).toBe(200);
    const otpRow = await admin((c) =>
      c.query<{ id: string }>(`SELECT id FROM ludy_sign.signing_otp WHERE org_id = $1 AND signer_id = $2 ORDER BY created_at DESC LIMIT 1`, [
        org.orgId,
        signerId,
      ]),
    );
    const otpMail = await workerRuntime.execute<{ code: string }>(
      'sign.public.otp_mail_data',
      { signerId, otpId: otpRow.rows[0]!.id },
      { actor: asSystem, orgId: org.orgId },
    );
    expect((await postPublic('/api/sign/otp/verify', { token, code: otpMail.code })).status).toBe(200);

    // Public view returns ordered packet documents and per-document fields.
    const viewRes = await postPublic('/api/sign/view', { token });
    expect(viewRes.status).toBe(200);
    const viewJson = (await viewRes.json()) as {
      state: string;
      documents: Array<{ id: string; docIndex: number; pageCount: number; sourceSha256: string }>;
      fields: Array<{ id: string; documentId: string | null }>;
    };
    expect(viewJson.state).toBe('ready');
    expect(viewJson.documents.map((d) => d.id)).toEqual([doc1Id, doc2Id]);
    expect(viewJson.documents.map((d) => d.pageCount)).toEqual([1, 2]);
    expect(viewJson.fields).toHaveLength(2);

    // Verified OTP unlocks doc1 and doc2 PDFs, while foreign documentId is rejected (404).
    const pdf1Res = await postPublic('/api/sign/pdf', { token, documentId: doc1Id });
    const pdf2Res = await postPublic('/api/sign/pdf', { token, documentId: doc2Id });
    expect(pdf1Res.status).toBe(200);
    expect(pdf2Res.status).toBe(200);
    expect(sha256Hex(new Uint8Array(await pdf1Res.arrayBuffer()))).toBe(f1.sha256);
    expect(sha256Hex(new Uint8Array(await pdf2Res.arrayBuffer()))).toBe(f2.sha256);
    expect((await postPublic('/api/sign/pdf', { token, documentId: randomUUID() })).status).toBe(404);

    // Submitting without Doc 2's required field fails cleanly across docs.
    const field1Id = viewJson.fields.find((f) => f.documentId === doc1Id)!.id;
    const field2Id = viewJson.fields.find((f) => f.documentId === doc2Id)!.id;
    const missingDoc2FieldRes = await postPublic('/api/sign/submit', {
      token,
      consentAccepted: true,
      signatureKind: 'draw',
      fields: [{ fieldId: field1Id, signaturePngBase64: VALID_PNG_BASE64 }],
    });
    expect(missingDoc2FieldRes.status).toBe(422);

    // Completing fields across BOTH documents under single consentAccepted succeeds.
    const submitOk = await postPublic('/api/sign/submit', {
      token,
      consentAccepted: true,
      signatureKind: 'draw',
      fields: [
        { fieldId: field1Id, signaturePngBase64: VALID_PNG_BASE64 },
        { fieldId: field2Id, valueText: 'Xac nhan 150M VND' },
      ],
    });
    expect(submitOk.status).toBe(200);

    // Real multi-doc pdf_seal job merges doc 1 + doc 2 + audit pages, embeds /Outlines, writes certificate.json documents, and verifies via /api/sign/verify.
    const sealed = await runSignPdfSealJob(
      { workerDb, runtime: workerRuntime, store, extract: realExtract },
      { orgId: org.orgId, envelopeId },
    );
    expect(sealed.status).toBe('sealed');

    const sealedDetail = await runtime.query<SignEnvelopeDetail>('sign.envelope.get', { envelopeId }, { actor: asUser(member), orgId: org.orgId });
    expect(sealedDetail.envelope.sealStatus).toBe('sealed');
    expect(sealedDetail.envelope.sealedSha256).toMatch(/^[0-9a-f]{64}$/);

    const sealedFileRow = await admin((c) =>
      c.query<{ storage_key: string }>(`SELECT storage_key FROM ludy_kernel.file WHERE org_id = $1 AND id = $2`, [
        org.orgId,
        sealedDetail.envelope.sealedFileId!,
      ]),
    );
    const sealedBytes = await store.get(sealedFileRow.rows[0]!.storage_key);
    const inspectedSealed = await realExtract.extract('pdf_inspect', sealedBytes);
    expect(inspectedSealed.ok).toBe(true);
    if (inspectedSealed.ok) {
      // 1 (doc1) + 2 (doc2) + >= 1 audit certificate page
      expect(inspectedSealed.pageCount).toBeGreaterThanOrEqual(4);
    }
    const rawLatin1 = Buffer.from(sealedBytes).toString('latin1');
    const inflatedText = Array.from(rawLatin1.matchAll(/<<[^>]*\/Type\s*\/ObjStm[^>]*>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/g))
      .map((m) => {
        try {
          return inflateSync(Buffer.from(m[1]!, 'latin1')).toString('latin1');
        } catch {
          return '';
        }
      })
      .join('\n');
    expect(rawLatin1 + '\n' + inflatedText).toContain('/Outlines');

    const certFileRow = await admin((c) =>
      c.query<{ storage_key: string }>(`SELECT storage_key FROM ludy_kernel.file WHERE org_id = $1 AND id = $2`, [
        org.orgId,
        sealedDetail.envelope.certificateFileId!,
      ]),
    );
    const certJson = JSON.parse(Buffer.from(await store.get(certFileRow.rows[0]!.storage_key)).toString('utf8')) as {
      sealedSha256: string;
      documents: Array<{ index: number; startPage: number; endPage: number; pageCount: number; sourceSha256: string }>;
    };
    expect(certJson.sealedSha256).toBe(sealedDetail.envelope.sealedSha256);
    expect(certJson.documents).toEqual([
      expect.objectContaining({ index: 1, startPage: 1, endPage: 1, pageCount: 1, sourceSha256: f1.sha256 }),
      expect.objectContaining({ index: 2, startPage: 2, endPage: 3, pageCount: 2, sourceSha256: f2.sha256 }),
    ]);

    const verifyHttp = await postPublic('/api/sign/verify', {
      certificateCode: sealed.certificateCode!,
      fileSha256: sealedDetail.envelope.sealedSha256!,
    });
    expect(verifyHttp.status).toBe(200);
    await expect(verifyHttp.json()).resolves.toMatchObject({
      matched: true,
      sealedSha256: sealedDetail.envelope.sealedSha256,
    });
  }, 60_000);

  it('enforces hr_contract and meeting_minutes confidentiality on envelope_document.file_id, cleanup_meeting_minutes_envelopes, cross-org RLS, and org_purge', async () => {
    const pdf1 = buildValidMultiPagePdf([['HR Contract Page 1']]);
    const pdf2 = buildValidMultiPagePdf([['HR Addendum Secret']]);
    const hrDoc1 = await ingestPdfBytes(adminUser, pdf1, 'hr-main.pdf', org.orgId, 'sign_document');
    const hrDoc2 = await ingestPdfBytes(adminUser, pdf2, 'hr-annex.pdf', org.orgId, 'sign_document');

    const hrEnv = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      { title: 'HR Contract Packet', routingMode: 'parallel', sourceFileId: hrDoc1.fileId, sourceKind: 'hr_contract', sourceId: randomUUID() },
      { actor: asUser(adminUser), orgId: org.orgId },
    );
    await runtime.execute(
      'sign.envelope.document.add',
      { envelopeId: hrEnv.envelopeId, sourceFileId: hrDoc2.fileId, title: 'HR Confidential Addendum' },
      { actor: asUser(adminUser), orgId: org.orgId },
    );

    // Owner/admin can read doc 2 file; non-creator regular member and viewer are denied via can_read_sign_file.
    expect((await appAiOff.request(`/api/files/${hrDoc2.fileId}`, { headers: { authorization: `Bearer ${await tokenFor(owner)}`, 'x-ludy-org': org.slug } })).status).toBe(200);
    expect((await appAiOff.request(`/api/files/${hrDoc2.fileId}`, { headers: { authorization: `Bearer ${await tokenFor(member)}`, 'x-ludy-org': org.slug } })).status).toBe(404);
    expect((await appAiOff.request(`/api/files/${hrDoc2.fileId}`, { headers: { authorization: `Bearer ${await tokenFor(viewer)}`, 'x-ludy-org': org.slug } })).status).toBe(404);

    // Confidential HR addendum file cannot be reused on a standalone envelope or org-wide template.
    await expect(
      runtime.execute(
        'sign.envelope.create',
        { title: 'Leak HR Doc 2', routingMode: 'parallel', sourceFileId: hrDoc2.fileId },
        { actor: asUser(adminUser), orgId: org.orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_FORBIDDEN' });
    await expect(
      runtime.execute(
        'sign.template.create',
        { title: 'Leak HR Doc 2 Template', routingMode: 'parallel', sourceFileId: hrDoc2.fileId },
        { actor: asUser(adminUser), orgId: org.orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_FORBIDDEN' });

    // Shared meeting_minutes (visibility: 'attendees'): attendee allowed on child envelope_document.file_id, non-attendee member denied, meeting delete cleans up child rows.
    await admin((c) => c.query('UPDATE ludy_kernel.tenant SET meeting_minutes_esign = true WHERE org_id = $1::uuid', [org.orgId]));
    const { meetingId } = await runtime.execute<{ meetingId: string }>(
      'meetings.meeting.create',
      {
        title: 'Hop HDQT',
        language: 'vi',
        visibility: 'attendees',
        keepVideo: false,
        liveNotes: false,
        summaryTemplate: 'general',
        consentMethod: 'told_at_start',
        readerUserIds: [attendee.userId],
      },
      { actor: asUser(owner), orgId: org.orgId },
    );
    await runtime.execute('meetings.summary.save', { meetingId, summary: 'Tom tat', decisions: ['Thong qua'] }, { actor: asUser(owner), orgId: org.orgId });
    await runtime.execute('meetings.result.publish', { meetingId, confirmed: true }, { actor: asUser(owner), orgId: org.orgId });

    const mmDoc1 = await ingestPdfBytes(owner, buildValidMultiPagePdf([['Bien ban hop']]), 'minutes.pdf');
    const mmDoc2 = await ingestPdfBytes(owner, buildValidMultiPagePdf([['Phu luc bien ban']]), 'minutes-annex.pdf');
    const mmEnv = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      { title: 'Minutes Packet', routingMode: 'parallel', sourceFileId: mmDoc1.fileId, sourceKind: 'meeting_minutes', sourceId: meetingId },
      { actor: asUser(owner), orgId: org.orgId },
    );
    await runtime.execute(
      'sign.envelope.document.add',
      { envelopeId: mmEnv.envelopeId, sourceFileId: mmDoc2.fileId, title: 'Minutes Annex' },
      { actor: asUser(owner), orgId: org.orgId },
    );

    expect((await appAiOff.request(`/api/files/${mmDoc2.fileId}`, { headers: { authorization: `Bearer ${await tokenFor(attendee)}`, 'x-ludy-org': org.slug } })).status).toBe(200);
    expect((await appAiOff.request(`/api/files/${mmDoc2.fileId}`, { headers: { authorization: `Bearer ${await tokenFor(member)}`, 'x-ludy-org': org.slug } })).status).toBe(404);

    // Direct SQL ludy_tenant RLS & guard checks (#4722 BLOCK-1): an unprivileged member must not bypass
    // confidentiality by inserting an envelope_document on a standalone envelope referencing an hr_contract
    // or meeting_minutes file_id OR spoofing its storage_key alongside a benign file_id.
    const safePdf1 = await ingestPdfBytes(member, buildValidMultiPagePdf([['Safe Member Doc 1']]), 'member-safe-1.pdf');
    const safePdf2 = await ingestPdfBytes(member, buildValidMultiPagePdf([['Safe Member Doc 2']]), 'member-safe-2.pdf');
    const safeEnv = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      { title: 'Member Standalone Packet', routingMode: 'parallel', sourceFileId: safePdf1.fileId },
      { actor: asUser(member), orgId: org.orgId },
    );
    await expect(
      runtime.execute(
        'sign.envelope.document.add',
        { envelopeId: safeEnv.envelopeId, sourceFileId: hrDoc2.fileId, title: 'Exfiltrate HR via command (member)' },
        { actor: asUser(member), orgId: org.orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_FILE_NOT_FOUND' });
    await expect(
      runtime.execute(
        'sign.envelope.document.add',
        { envelopeId: safeEnv.envelopeId, sourceFileId: hrDoc2.fileId, title: 'Exfiltrate HR via command (admin)' },
        { actor: asUser(adminUser), orgId: org.orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_FORBIDDEN' });

    const rlsClient = await pool.connect();
    try {
      await rlsClient.query('BEGIN');
      await rlsClient.query('SELECT ludy_kernel.enter_context($1::uuid, $2::uuid)', [member.userId, org.orgId]);

      await rlsClient.query('SAVEPOINT sp_hr_file_id');
      await expect(
        rlsClient.query(
          `INSERT INTO ludy_sign.envelope_document
            (org_id, envelope_id, doc_index, title, file_id, storage_key, generation, source_sha256, inspect_status)
           VALUES ($1, $2, 2, 'Leak HR fileId', $3, $4, $5, $6, 'pending')`,
          [org.orgId, safeEnv.envelopeId, hrDoc2.fileId, hrDoc2.storageKey, hrDoc2.generation, hrDoc2.sha256],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await rlsClient.query('ROLLBACK TO SAVEPOINT sp_hr_file_id');

      await rlsClient.query('SAVEPOINT sp_mm_file_id');
      await expect(
        rlsClient.query(
          `INSERT INTO ludy_sign.envelope_document
            (org_id, envelope_id, doc_index, title, file_id, storage_key, generation, source_sha256, inspect_status)
           VALUES ($1, $2, 2, 'Leak Minutes fileId', $3, $4, $5, $6, 'pending')`,
          [org.orgId, safeEnv.envelopeId, mmDoc2.fileId, mmDoc2.storageKey, mmDoc2.generation, mmDoc2.sha256],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await rlsClient.query('ROLLBACK TO SAVEPOINT sp_mm_file_id');

      await rlsClient.query('SAVEPOINT sp_spoof_hr_key');
      await expect(
        rlsClient.query(
          `INSERT INTO ludy_sign.envelope_document
            (org_id, envelope_id, doc_index, title, file_id, storage_key, generation, source_sha256, inspect_status)
           VALUES ($1, $2, 2, 'Spoof HR key', $3, $4, $5, $6, 'pending')`,
          [org.orgId, safeEnv.envelopeId, safePdf2.fileId, hrDoc2.storageKey, hrDoc2.generation, hrDoc2.sha256],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await rlsClient.query('ROLLBACK TO SAVEPOINT sp_spoof_hr_key');

      await rlsClient.query('SAVEPOINT sp_spoof_arbitrary_key');
      await expect(
        rlsClient.query(
          `INSERT INTO ludy_sign.envelope_document
            (org_id, envelope_id, doc_index, title, file_id, storage_key, generation, source_sha256, inspect_status)
           VALUES ($1, $2, 2, 'Spoof arbitrary key', $3, 'org/fake/nonexistent.pdf', '1', $4, 'pending')`,
          [org.orgId, safeEnv.envelopeId, safePdf2.fileId, safePdf2.sha256],
        ),
      ).rejects.toThrow(/ENVELOPE_DOCUMENT_INVALID_FILE/);
      await rlsClient.query('ROLLBACK TO SAVEPOINT sp_spoof_arbitrary_key');

      // Even if a malicious tenant row wrote a spoofed standalone envelope directly, Doc 1 lazy materialization rejects confidential storage_key.
      const spoofEnvId = randomUUID();
      await rlsClient.query(
        `INSERT INTO ludy_sign.envelope
          (org_id, id, title, routing_mode, source_kind, source_file_id, source_storage_key, source_generation, source_sha256, created_by)
         VALUES ($1, $2, 'Spoof parent', 'parallel', 'standalone', $3, $4, $5, $6, $7)`,
        [org.orgId, spoofEnvId, safePdf2.fileId, hrDoc2.storageKey, hrDoc2.generation, hrDoc2.sha256, member.userId],
      );
      await rlsClient.query('SAVEPOINT sp_spoof_doc1_lazy');
      await expect(
        rlsClient.query(
          `INSERT INTO ludy_sign.envelope_document
            (org_id, envelope_id, doc_index, title, file_id, storage_key, generation, source_sha256, inspect_status)
           VALUES ($1, $2, 1, 'Spoof lazy Doc 1', $3, $4, $5, $6, 'pending')`,
          [org.orgId, spoofEnvId, safePdf2.fileId, hrDoc2.storageKey, hrDoc2.generation, hrDoc2.sha256],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await rlsClient.query('ROLLBACK TO SAVEPOINT sp_spoof_doc1_lazy');

      await rlsClient.query('ROLLBACK');
    } finally {
      rlsClient.release();
    }

    // Even when an admin CAN read hrDoc2 in ludy_kernel.file, confidential_source_insert RLS still blocks attaching hrDoc2.file_id or storage_key to a standalone envelope.
    const adminRlsClient = await pool.connect();
    try {
      await adminRlsClient.query('BEGIN');
      await adminRlsClient.query('SELECT ludy_kernel.enter_context($1::uuid, $2::uuid)', [adminUser.userId, org.orgId]);
      await adminRlsClient.query('SAVEPOINT sp_admin_hr_leak');
      await expect(
        adminRlsClient.query(
          `INSERT INTO ludy_sign.envelope_document
            (org_id, envelope_id, doc_index, title, file_id, storage_key, generation, source_sha256, inspect_status)
           VALUES ($1, $2, 2, 'Admin leak HR fileId to standalone', $3, $4, $5, $6, 'pending')`,
          [org.orgId, safeEnv.envelopeId, hrDoc2.fileId, hrDoc2.storageKey, hrDoc2.generation, hrDoc2.sha256],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await adminRlsClient.query('ROLLBACK TO SAVEPOINT sp_admin_hr_leak');
      await adminRlsClient.query('ROLLBACK');
    } finally {
      adminRlsClient.release();
    }

    await runtime.execute('meetings.meeting.delete', { meetingId }, { actor: asUser(owner), orgId: org.orgId });
    const afterMeetingDelete = await admin((c) =>
      c.query<{ count: string }>(`SELECT count(*)::text AS count FROM ludy_sign.envelope_document WHERE org_id = $1 AND envelope_id = $2`, [
        org.orgId,
        mmEnv.envelopeId,
      ]),
    );
    expect(Number(afterMeetingDelete.rows[0]?.count ?? '0')).toBe(0);

    // Cross-tenant RLS isolation: Org B cannot view Org A's packet envelope.
    await expect(
      runtime.query('sign.envelope.get', { envelopeId: hrEnv.envelopeId }, { actor: asUser(orgBOwner), orgId: orgB.orgId }),
    ).rejects.toMatchObject({ status: 404 });

    // org_purge deletes ludy_sign.envelope_document rows cleanly before ludy_sign.envelope.
    const p1 = await ingestPdfBytes(owner, buildValidMultiPagePdf([['Purge doc 1']]), 'purge-1.pdf', purgeOrg.orgId);
    const p2 = await ingestPdfBytes(owner, buildValidMultiPagePdf([['Purge doc 2']]), 'purge-2.pdf', purgeOrg.orgId);
    const purgeEnv = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      { title: 'Purge Packet', routingMode: 'parallel', sourceFileId: p1.fileId },
      { actor: asUser(owner), orgId: purgeOrg.orgId },
    );
    await runtime.execute(
      'sign.envelope.document.add',
      { envelopeId: purgeEnv.envelopeId, sourceFileId: p2.fileId },
      { actor: asUser(owner), orgId: purgeOrg.orgId },
    );

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
      [purgeOrg.orgId, '--reason', 'Owner offboarded sign packet test org'],
    );
    expect(purgeCode, purgeLogs.join('\n')).toBe(0);
    const leftDocs = await admin((c) =>
      c.query<{ count: string }>(`SELECT count(*)::text AS count FROM ludy_sign.envelope_document WHERE org_id = $1`, [purgeOrg.orgId]),
    );
    expect(Number(leftDocs.rows[0]?.count ?? '0')).toBe(0);
  }, 60_000);
});
