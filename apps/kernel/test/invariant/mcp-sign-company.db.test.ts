// SPDX-License-Identifier: AGPL-3.0-only
// Database and projection privacy invariants for the four eSign MCP company reads (#4441, Slice 5c, ADR-0051):
//   - Database RLS & MACHINERY isolation: sealed `mcp_company` and `mcp_member` contexts read zero rows of
//     `crove_sign.api_key`, `signing_token`, `signing_otp`, `template_direct_link`, `ca_connection`,
//     `member_signature`, and `org_stamp`, zero `hr_contract` or `meeting_minutes` envelopes (and zero child rows),
//     and zero rows of another org; no `crove_sign` function or policy names `'mcp_company'` or `'mcp_member'`.
//   - Projection isolation: `sign.mcp.envelopes`, `sign.mcp.envelope_get`, `sign.mcp.renewals`, and
//     `sign.mcp.templates` return only the exact allowlisted keys, strip newlines/control/bidi characters via
//     `plainLine`, and never leak canary strings from signer names/emails/phones, signing tokens, OTPs,
//     `counterparty_name`, unconfirmed AI obligation proposals, confidential envelopes, or direct-link tokens.
//   - Non-existence parity & gates: unknown IDs, `hr_contract`, `meeting_minutes`, and foreign-org IDs answer
//     identical `404 SIGN_ENVELOPE_NOT_FOUND`; member grants, plain browser sessions, missing `ludy.read`,
//     revoked grants, `MODULE_OFF`, and Stop AI switches are refused.
// Self-contained invariant suite file: imports only workspace packages, app code under test, and `./fixtures/*`.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@ludy/db';
import { migrate } from '@ludy/db/migrate';
import type { ExtractClient } from '@ludy/extract-contract';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import {
  DomainError,
  Runtime,
  contentGeneration,
  fileKey,
  sha256Hex,
  type BlobStore,
  type UserActor,
} from '@ludy/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import {
  addDaysIso,
  signCommands,
  signQueries,
  type McpSignEnvelopeDetail,
  type McpSignEnvelopesResult,
  type McpSignRenewalsResult,
  type McpSignTemplatesResult,
} from '@ludy/mod-sign';
import { runSignPdfSealJob } from '../../src/sign-worker.ts';
import {
  createDbClient,
  createDbPool,
  resolveDbIdentifiers,
  setActiveRolePasswords,
  type DbIdentifiers,
} from './fixtures/db-identifiers.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const CANARY = 'CANARY-SIGN-MCP-4441';

const ENVELOPE_ROW_KEYS = [
  'completedAt',
  'createdAt',
  'expiresAt',
  'id',
  'routingMode',
  'signerCounts',
  'sourceKind',
  'status',
  'title',
];
const SIGNER_COUNTS_KEYS = ['declined', 'pending', 'signed', 'total'];
const ENVELOPE_DETAIL_KEYS = [
  'certificateCode',
  'completedAt',
  'createdAt',
  'declinedAt',
  'expiredAt',
  'expiresAt',
  'id',
  'inspectStatus',
  'obligation',
  'pageCount',
  'routingMode',
  'sealStatus',
  'sentAt',
  'signerCounts',
  'signers',
  'sourceKind',
  'status',
  'title',
  'voidedAt',
];
const MASKED_SIGNER_KEYS = [
  'declinedAt',
  'id',
  'roleLabel',
  'routingOrder',
  'signedAt',
  'signerRole',
  'status',
  'viewedAt',
];
const OBLIGATION_KEYS = [
  'autoRenew',
  'contractValue',
  'currency',
  'effectiveDate',
  'expiryDate',
  'items',
  'renewalNoticeDays',
];
const OBLIGATION_ITEM_KEYS = ['completedAt', 'dueDate', 'id', 'status', 'title'];
const RENEWAL_ROW_KEYS = [
  'autoRenew',
  'contractValue',
  'currency',
  'daysUntilExpiry',
  'daysUntilNotice',
  'effectiveDate',
  'envelopeId',
  'expiryDate',
  'nextObligationDueDate',
  'overdueObligationCount',
  'pendingObligationCount',
  'renewalNoticeDate',
  'title',
];
const TEMPLATE_ROW_KEYS = ['directLinkEnabled', 'id', 'roleCount', 'routingMode', 'title', 'updatedAt'];

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

function pngChunk(type: string, data: Uint8Array): Buffer {
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
}

function makePngBase64(width = 160, height = 60): string {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rawBytes = Buffer.alloc(height * (1 + width * 4), 0);
  const idat = pngChunk('IDAT', deflateSync(rawBytes));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    idat,
    pngChunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

const VALID_PNG_BASE64 = makePngBase64();
const makePdf = (tag: string): Uint8Array =>
  Uint8Array.from(
    Buffer.from(`%PDF-1.4\n% mcp-sign-${tag}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n`, 'utf8'),
  );

const mockExtract: ExtractClient = {
  async extract(kind) {
    if (kind === 'pdf_seal') {
      return {
        ok: true,
        kind: 'pdf_seal',
        sealedPdfBase64: Buffer.from(makePdf('sealed')).toString('base64'),
      } as never;
    }
    throw new Error(`Unexpected extract kind: ${kind}`);
  },
};

suite('eSign MCP company grant database and projection invariants (#4441)', () => {
  const dbName = `crove_test_mcp_sign_inv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let dbIds: DbIdentifiers | undefined;
  const pools: pg.Pool[] = [];
  const store = new MemoryStore();

  let workerDb!: Db;
  let runtime!: Runtime;
  let workerRuntime!: Runtime;
  let orgA = '';
  let orgB = '';
  const users: Record<string, string> = {};
  const sessions: Record<string, string> = {};
  const ids: Record<string, string> = {};

  const asUser = (who: string): UserActor => ({
    type: 'user',
    userId: users[who]!,
    sessionId: (sessions[who] ??= randomUUID()),
    aal: 'aal1',
  });
  const asMfa = (who: string): UserActor => ({
    type: 'user',
    userId: users[who]!,
    sessionId: (sessions[who] ??= randomUUID()),
    aal: 'aal2',
    mfaAt: Math.floor(Date.now() / 1000),
  });
  const asSystem = { type: 'system' as const, component: 'sign-worker' };

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = createDbClient({ connectionString: adminUrl }, dbIds);
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  const sqlAdmin = <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []) =>
    admin((c) => c.query<R>(text, params));

  type Sealed = Record<string, unknown>;
  const sealedCompany = (org: string, grantor: string): Sealed => ({
    v: 1,
    org,
    actor: 'agent',
    user: null,
    role: 'admin',
    agent: randomUUID(),
    run: null,
    position: null,
    module: 'kernel',
    max_risk: 'R0',
    tainted: true,
    le_scope: ['*'],
    flags: [],
    kind: 'mcp_company',
    grantor,
  });
  const sealedMember = (org: string, who: string): Sealed => ({
    v: 1,
    org,
    actor: 'agent',
    user: null,
    role: 'member',
    agent: randomUUID(),
    run: null,
    position: null,
    module: 'kernel',
    max_risk: 'R0',
    tainted: true,
    le_scope: ['*'],
    flags: [],
    kind: 'mcp_member',
    member: who,
  });

  async function asSealed<T>(ctx: Sealed, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = createDbClient({ connectionString: adminUrl }, dbIds);
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT ludy_kernel.ctx_write($1::jsonb)', [JSON.stringify(ctx)]);
      await c.query('SET LOCAL ROLE ludy_tenant');
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  }

  async function visibleIds(ctx: Sealed, table: string): Promise<string[]> {
    return asSealed(ctx, async (c) => {
      try {
        const res = await c.query<{ id: string }>(`SELECT id FROM crove_sign.${table}`);
        return res.rows.map((r) => r.id).sort();
      } catch (err) {
        if ((err as { code?: string }).code === '42501') return [];
        throw err;
      }
    });
  }

  async function ingestPdf(org: string, who: string, tag: string): Promise<{ fileId: string; sha256: string }> {
    const bytes = makePdf(`${tag}-${randomUUID()}`);
    const sha256 = sha256Hex(bytes);
    const key = fileKey(org, sha256);
    const generation = await store.put(key, bytes);
    const { fileId } = await runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      {
        filename: `${tag}.pdf`,
        contentType: 'application/pdf',
        sizeBytes: bytes.byteLength,
        sha256,
        storageKey: key,
        generation,
        source: 'sign_document',
      },
      { actor: asUser(who), orgId: org },
    );
    return { fileId, sha256 };
  }

  async function insertGrant(
    org: string,
    userId: string,
    kind: 'company' | 'member' = 'company',
    scopes: readonly string[] = ['ludy.read'],
  ): Promise<string> {
    const id = randomUUID();
    await sqlAdmin(
      `INSERT INTO ludy_kernel.agent_grant (
         org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id,
         created_at, expires_at, created_by, kind, member_id
       )
       VALUES (
         $1, $2, $3, $4, 'Test MCP Client', 'mcp.example.com', $5::text[], $6,
         clock_timestamp(), now() + interval '30 days', $3, $7, ${kind === 'member' ? '$3' : 'NULL'}
       )`,
      [org, id, userId, `client-${id}`, scopes, `oauth-${id}`, kind],
    );
    return id;
  }

  const mcpActor = (
    userId: string,
    grantId: string,
    kind: 'company' | 'member' = 'company',
    scopes: readonly string[] = ['ludy.read'],
  ): UserActor => ({
    type: 'user',
    userId,
    aal: 'aal1',
    mcp: { grantId, clientId: 'client-1', clientName: 'Test MCP Client', scopes, kind },
  });

  async function refusal(promise: Promise<unknown>): Promise<DomainError> {
    try {
      await promise;
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      return err as DomainError;
    }
    throw new Error('expected DomainError refusal');
  }

  beforeAll(async () => {
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.query(`REVOKE TEMPORARY ON DATABASE ${dbName} FROM PUBLIC`);
    await root.end();

    const base = new URL(ADMIN);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();

    await migrate({ adminUrl, dir: MIGRATIONS });
    dbIds = await resolveDbIdentifiers(adminUrl);
    await setActiveRolePasswords(adminUrl, { ludy_app: 'mcp-sign-app-pw', ludy_worker: 'mcp-sign-worker-pw' }, dbIds);

    const login = (u: string, pw: string) => {
      const url = new URL(adminUrl);
      url.username = dbIds ? dbIds.roleName(u) : u;
      url.password = pw;
      return url.toString();
    };

    const appPool = createDbPool({ connectionString: login('ludy_app', 'mcp-sign-app-pw'), max: 5 }, dbIds);
    const workerPool = createDbPool({ connectionString: login('ludy_worker', 'mcp-sign-worker-pw'), max: 3 }, dbIds);
    pools.push(appPool, workerPool);

    const appDb = createDb(appPool);
    workerDb = createDb(workerPool);

    runtime = new Runtime(appDb, { manifests: TEST_MANIFESTS })
      .register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) })
      .register({ commands: meetingsCommands, queries: meetingsQueries })
      .register({ commands: signCommands, queries: signQueries });

    workerRuntime = new Runtime(workerDb, { manifests: TEST_MANIFESTS })
      .register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) })
      .register({ commands: meetingsCommands, queries: meetingsQueries })
      .register({ commands: signCommands, queries: signQueries });

    for (const key of ['owner', 'admin', 'member', 'foreign']) {
      users[key] = await upsertIdentity(appDb, {
        issuer: 'mcp-sign-inv',
        subject: key,
        email: `${key}@mcp-sign.test`,
        name: `User ${key}`,
      });
    }

    orgA = (await createOrg(runtime, asUser('owner'), 'Cong ty Sign MCP A')).orgId;
    orgB = (await createOrg(runtime, asUser('foreign'), 'Cong ty Sign MCP B')).orgId;
    // #4703: once the org setting "Ký biên bản họp" exists it is off by default and the server refuses to create a minutes envelope while it is off. These cases create them, so the org turns it
    // on; before the setting's column exists the update finds no column (42703) and is skipped.
    for (const id of [orgA, orgB]) {
      await sqlAdmin('UPDATE ludy_kernel.tenant SET meeting_minutes_esign = true WHERE org_id = $1::uuid', [id]).catch((error: { code?: string }) => {
        if (error.code !== '42703') throw error;
      });
    }

    await sqlAdmin(
      `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role)
       VALUES ($1, $2, 'admin'), ($1, $3, 'member')`,
      [orgA, users.admin, users.member],
    );

    // 1. Seed a completed standalone envelope in Org A with canary PII, token, OTP, and confirmed obligation.
    const completedPdf = await ingestPdf(orgA, 'admin', 'completed-contract');
    const createdCompleted = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      {
        title: `Hop dong dich vu\u202e\u200b\nchinh thuc`,
        sourceFileId: completedPdf.fileId,
        routingMode: 'parallel',
      },
      { actor: asUser('admin'), orgId: orgA },
    );
    ids.completedEnv = createdCompleted.envelopeId;

    await workerRuntime.execute(
      'sign.envelope.inspect_complete',
      {
        envelopeId: ids.completedEnv,
        outcome: 'passed',
        pageCount: 1,
        pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0 }],
      },
      { actor: asSystem, orgId: orgA },
    );

    const signer1 = await runtime.execute<{ signerId: string }>(
      'sign.signer.add',
      {
        envelopeId: ids.completedEnv,
        routingOrder: 1,
        signerRole: 'signer',
        roleLabel: `Dai dien\u202e\nkhach hang`,
        name: `${CANARY} Signer Full Name`,
        email: `canary-email@mcp-sign.test`,
        phone: `+84909999999`,
        deliveryMode: 'link',
        requireEmailOtp: true,
      },
      { actor: asUser('admin'), orgId: orgA },
    );
    ids.completedSigner = signer1.signerId;

    await runtime.execute(
      'sign.field.set',
      {
        envelopeId: ids.completedEnv,
        fields: [
          {
            signerId: signer1.signerId,
            fieldType: 'signature',
            pageNumber: 1,
            xNorm: 0.1,
            yNorm: 0.7,
            wNorm: 0.25,
            hNorm: 0.1,
            required: true,
          },
        ],
      },
      { actor: asUser('admin'), orgId: orgA },
    );

    const sent = await runtime.execute<{ links: Array<{ tokenId: string; token: string }> }>(
      'sign.envelope.send',
      { envelopeId: ids.completedEnv },
      { actor: asUser('admin'), orgId: orgA },
    );
    ids.signingTokenClear = sent.links[0]!.token;

    // Seed an OTP row in crove_sign.signing_otp to prove MACHINERY isolation.
    await sqlAdmin(
      `INSERT INTO crove_sign.signing_otp (org_id, signer_id, signing_token_id, email, otp_sha256, expires_at, verified_at)
       VALUES ($1, $2, $3, 'canary-email@mcp-sign.test', $4, now() + interval '10 minutes', now())`,
      [orgA, signer1.signerId, sent.links[0]!.tokenId, 'a'.repeat(64)],
    );

    // Complete & seal the standalone envelope via public submit + worker seal job.
    const fieldIdRow = await sqlAdmin<{ id: string }>(
      `SELECT id FROM crove_sign.field WHERE org_id = $1 AND envelope_id = $2 LIMIT 1`,
      [orgA, ids.completedEnv],
    );
    await sqlAdmin(
      `SELECT crove_sign.public_submit($1, true, 'draw', NULL, $2::jsonb, NULL, 'InvTest/1.0', NULL)`,
      [
        sha256Hex(ids.signingTokenClear),
        JSON.stringify([{ fieldId: fieldIdRow.rows[0]!.id, signaturePngBase64: VALID_PNG_BASE64 }]),
      ],
    );
    await runSignPdfSealJob(
      { workerDb, runtime: workerRuntime, store, extract: mockExtract },
      { orgId: orgA, envelopeId: ids.completedEnv },
    );

    const today = new Date().toISOString().slice(0, 10);
    await runtime.execute(
      'sign.obligation.upsert',
      {
        envelopeId: ids.completedEnv,
        counterpartyName: `${CANARY} Counterparty Private Name`,
        effectiveDate: today,
        expiryDate: addDaysIso(today, 30),
        renewalNoticeDays: 15,
        autoRenew: true,
        contractValue: '125000000',
        currency: 'VND',
        obligations: [
          {
            title: `Nghiem thu\u202e\ndot 1`,
            dueDate: addDaysIso(today, 10),
            status: 'pending',
          },
        ],
      },
      { actor: asUser('admin'), orgId: orgA },
    );

    // 2. Seed a second completed standalone envelope with ONLY an unconfirmed AI proposal (status = 'proposed').
    const unconfirmedPdf = await ingestPdf(orgA, 'admin', 'unconfirmed-proposal');
    const createdProposed = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      { title: 'Hop dong chua xac nhan nghia vu', sourceFileId: unconfirmedPdf.fileId, routingMode: 'parallel' },
      { actor: asUser('admin'), orgId: orgA },
    );
    ids.proposedEnv = createdProposed.envelopeId;
    await sqlAdmin(
      `INSERT INTO crove_sign.envelope_obligation (
         org_id, envelope_id, counterparty_name, effective_date, expiry_date, renewal_notice_days,
         auto_renew, contract_value, currency, obligations_json, proposal_json, status, created_by
       )
       VALUES (
         $1, $2, $3, current_date, current_date + 10, 5, false, 50000000, 'VND',
         $4::jsonb, $5::jsonb, 'proposed', $6
       )`,
      [
        orgA,
        ids.proposedEnv,
        `${CANARY} Unconfirmed Counterparty`,
        JSON.stringify([{ id: randomUUID(), title: `${CANARY} Unconfirmed Milestone`, dueDate: addDaysIso(today, 5), status: 'pending', completedAt: null }]),
        JSON.stringify({ summary: `${CANARY} Tainted AI Proposal` }),
        users.admin,
      ],
    );

    // 3. Seed confidential `hr_contract` envelope in Org A (created by admin, who is also the MCP grantor!).
    const hrPdf = await ingestPdf(orgA, 'admin', 'hr-confidential');
    const createdHr = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      {
        title: `${CANARY} Hop dong lao dong giam doc`,
        sourceFileId: hrPdf.fileId,
        routingMode: 'parallel',
        sourceKind: 'hr_contract',
        sourceId: randomUUID(),
      },
      { actor: asUser('admin'), orgId: orgA },
    );
    ids.hrEnv = createdHr.envelopeId;
    await sqlAdmin(
      `INSERT INTO crove_sign.signer (org_id, envelope_id, role_key, routing_order, signer_role, role_label, name, email, delivery_mode)
       VALUES ($1, $2, 'employee', 1, 'signer', 'Nhan vien', $3, 'hr-secret@mcp-sign.test', 'link')`,
      [orgA, ids.hrEnv, `${CANARY} HR Employee`],
    );
    await sqlAdmin(
      `INSERT INTO crove_sign.envelope_obligation (
         org_id, envelope_id, counterparty_name, effective_date, expiry_date, renewal_notice_days,
         status, confirmed_by, confirmed_at, created_by
       )
       VALUES ($1, $2, $3, current_date, current_date + 7, 3, 'confirmed', $4, now(), $4)`,
      [orgA, ids.hrEnv, `${CANARY} HR Salary Party`, users.admin],
    );

    // 4. Seed confidential `meeting_minutes` envelope in Org A (recorded by admin!).
    const { meetingId } = await runtime.execute<{ meetingId: string }>(
      'meetings.meeting.create',
      {
        title: `${CANARY} Cuoc hop noi bo`,
        language: 'vi',
        visibility: 'attendees',
        keepVideo: false,
        liveNotes: false,
        summaryTemplate: 'general',
        consentMethod: 'told_at_start',
        readerUserIds: [users.member!],
      },
      { actor: asUser('admin'), orgId: orgA },
    );
    await runtime.execute(
      'meetings.summary.save',
      { meetingId, summary: 'Noi dung hop mat', decisions: ['Chot luong'] },
      { actor: asUser('admin'), orgId: orgA },
    );
    await runtime.execute(
      'meetings.result.publish',
      { meetingId, confirmed: true },
      { actor: asUser('admin'), orgId: orgA },
    );
    const mtgPdf = await ingestPdf(orgA, 'admin', 'meeting-confidential');
    const createdMtg = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      {
        title: `${CANARY} Bien ban hop HDQT`,
        sourceFileId: mtgPdf.fileId,
        routingMode: 'parallel',
        sourceKind: 'meeting_minutes',
        sourceId: meetingId,
      },
      { actor: asUser('admin'), orgId: orgA },
    );
    ids.mtgEnv = createdMtg.envelopeId;
    await sqlAdmin(
      `INSERT INTO crove_sign.envelope_obligation (
         org_id, envelope_id, counterparty_name, effective_date, expiry_date, renewal_notice_days,
         status, confirmed_by, confirmed_at, created_by
       )
       VALUES ($1, $2, $3, current_date, current_date + 7, 3, 'confirmed', $4, now(), $4)`,
      [orgA, ids.mtgEnv, `${CANARY} Meeting Party`, users.admin],
    );

    // 5. Seed active + archived templates in Org A (with direct link enabled on the active one), member_signature, org_stamp, and api_key.
    const tplPdf = await ingestPdf(orgA, 'admin', 'reusable-template');
    const createdTpl = await runtime.execute<{ templateId: string }>(
      'sign.template.create',
      {
        title: 'Mau hop dong ban hang',
        sourceFileId: tplPdf.fileId,
        routingMode: 'sequential',
      },
      { actor: asUser('admin'), orgId: orgA },
    );
    ids.activeTpl = createdTpl.templateId;
    await workerRuntime.execute(
      'sign.template.inspect_complete',
      {
        templateId: ids.activeTpl,
        outcome: 'passed',
        pageCount: 1,
        pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0 }],
      },
      { actor: asSystem, orgId: orgA },
    );
    await runtime.execute(
      'sign.template.roles_set',
      {
        templateId: ids.activeTpl,
        roles: [{ roleKey: 'customer', signerRole: 'signer', roleLabel: 'Khach hang', routingOrder: 1, deliveryMode: 'email', requireEmailOtp: false }],
      },
      { actor: asUser('admin'), orgId: orgA },
    );
    await runtime.execute(
      'sign.template.fields_set',
      {
        templateId: ids.activeTpl,
        fields: [{ roleKey: 'customer', fieldType: 'signature', pageNumber: 1, xNorm: 0.2, yNorm: 0.7, wNorm: 0.25, hNorm: 0.1, required: true }],
      },
      { actor: asUser('admin'), orgId: orgA },
    );
    await runtime.execute(
      'sign.template.update',
      { templateId: ids.activeTpl, status: 'active' },
      { actor: asUser('admin'), orgId: orgA },
    );
    await sqlAdmin(
      `UPDATE crove_sign.template SET title = $3 WHERE org_id = $1 AND id = $2`,
      [orgA, ids.activeTpl, `Mau hop dong\u202e\nban hang`],
    );
    const directRes = await runtime.execute<{ token: string }>(
      'sign.template.direct_link_set',
      { templateId: ids.activeTpl, enabled: true, requireEmailOtp: false },
      { actor: asUser('admin'), orgId: orgA },
    );
    ids.directTokenClear = directRes.token;

    const archivedTplPdf = await ingestPdf(orgA, 'admin', 'archived-template');
    const createdArchivedTpl = await runtime.execute<{ templateId: string }>(
      'sign.template.create',
      {
        title: `${CANARY} Mau da luu tru`,
        sourceFileId: archivedTplPdf.fileId,
        routingMode: 'parallel',
      },
      { actor: asUser('admin'), orgId: orgA },
    );
    await runtime.execute(
      'sign.template.archive',
      { templateId: createdArchivedTpl.templateId },
      { actor: asUser('admin'), orgId: orgA },
    );
    ids.archivedTpl = createdArchivedTpl.templateId;

    await runtime.execute(
      'sign.member_signature.upsert',
      { kind: 'signature', signatureKind: 'draw', signaturePngBase64: VALID_PNG_BASE64 },
      { actor: asUser('admin'), orgId: orgA },
    );
    await runtime.execute(
      'sign.stamp.create',
      { name: `${CANARY} Con dau cong ty`, stampKind: 'company', stampPngBase64: VALID_PNG_BASE64 },
      { actor: asUser('admin'), orgId: orgA },
    );
    await runtime.execute(
      'sign.api_key.create',
      {
        name: `${CANARY} Internal ERP Key`,
        keyPrefix: 'ludy_sk_aaaaaaaa',
        keySha256: 'b'.repeat(64),
        scopes: ['sign:read'],
      },
      { actor: asUser('admin'), orgId: orgA },
    );

    // 6. Seed an envelope and template in Org B.
    const orgBPdf = await ingestPdf(orgB, 'foreign', 'org-b-contract');
    const createdOrgBEnv = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      { title: `${CANARY} Hop dong cong ty B`, sourceFileId: orgBPdf.fileId, routingMode: 'parallel' },
      { actor: asUser('foreign'), orgId: orgB },
    );
    ids.orgBEnv = createdOrgBEnv.envelopeId;
  }, 180_000);

  afterAll(async () => {
    for (const p of pools) await p.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('enforces database-level RLS and MACHINERY isolation for sealed mcp_company and mcp_member contexts', async () => {
    const companyCtx = sealedCompany(orgA, users.admin!);
    const memberCtx = sealedMember(orgA, users.member!);

    for (const closedTable of [
      'api_key',
      'ca_connection',
      'member_signature',
      'org_stamp',
      'signing_otp',
      'signing_token',
      'template_direct_link',
    ]) {
      expect(await visibleIds(companyCtx, closedTable), `company ${closedTable}`).toEqual([]);
      expect(await visibleIds(memberCtx, closedTable), `member ${closedTable}`).toEqual([]);
    }

    const companyEnvelopes = await visibleIds(companyCtx, 'envelope');
    expect(companyEnvelopes).toEqual([ids.completedEnv!, ids.proposedEnv!].sort());
    expect(companyEnvelopes).not.toContain(ids.hrEnv);
    expect(companyEnvelopes).not.toContain(ids.mtgEnv);
    expect(companyEnvelopes).not.toContain(ids.orgBEnv);

    // Confidential child rows (signer, envelope_obligation) are also hidden by restrictive RLS in PostgreSQL.
    const companyObligations = await asSealed(companyCtx, async (c) =>
      (await c.query<{ envelope_id: string }>('SELECT envelope_id FROM crove_sign.envelope_obligation')).rows.map(
        (r) => r.envelope_id,
      ),
    );
    expect(companyObligations.sort()).toEqual([ids.completedEnv!, ids.proposedEnv!].sort());

    // Helper crove_sign.template_direct_link_enabled returns true for mcp_company and false for mcp_member / foreign org.
    const companyDirect = await asSealed(companyCtx, async (c) =>
      (await c.query<{ on: boolean }>('SELECT crove_sign.template_direct_link_enabled($1::uuid) AS on', [ids.activeTpl]))
        .rows[0]!.on,
    );
    expect(companyDirect).toBe(true);

    const memberDirect = await asSealed(memberCtx, async (c) =>
      (await c.query<{ on: boolean }>('SELECT crove_sign.template_direct_link_enabled($1::uuid) AS on', [ids.activeTpl]))
        .rows[0]!.on,
    );
    expect(memberDirect).toBe(false);

    const foreignDirect = await asSealed(sealedCompany(orgB, users.foreign!), async (c) =>
      (await c.query<{ on: boolean }>('SELECT crove_sign.template_direct_link_enabled($1::uuid) AS on', [ids.activeTpl]))
        .rows[0]!.on,
    );
    expect(foreignDirect).toBe(false);

    // No crove_sign SQL function or RLS policy names 'mcp_company'; only template_direct_link_enabled refuses 'mcp_member'.
    const companyFnLeaks = await sqlAdmin<{ proname: string }>(
      `SELECT p.proname
       FROM pg_proc p
       WHERE p.pronamespace = 'crove_sign'::regnamespace
         AND p.prokind IN ('f', 'p')
         AND CASE WHEN p.prokind IN ('f', 'p') THEN pg_get_functiondef(p.oid) ELSE '' END ~ '''mcp_company'''`,
    );
    expect(companyFnLeaks.rows).toEqual([]);
    const memberFnRefs = await sqlAdmin<{ proname: string }>(
      `SELECT p.proname
       FROM pg_proc p
       WHERE p.pronamespace = 'crove_sign'::regnamespace
         AND p.prokind IN ('f', 'p')
         AND CASE WHEN p.prokind IN ('f', 'p') THEN pg_get_functiondef(p.oid) ELSE '' END ~ '''mcp_member'''
       ORDER BY 1`,
    );
    expect(memberFnRefs.rows).toEqual([{ proname: 'template_direct_link_enabled' }]);
    const polLeaks = await sqlAdmin<{ policyname: string }>(
      `SELECT policyname
       FROM pg_policies
       WHERE schemaname = 'crove_sign'
         AND (COALESCE(qual, '') ~ '''mcp_(company|member)''' OR COALESCE(with_check, '') ~ '''mcp_(company|member)''')`,
    );
    expect(polLeaks.rows).toEqual([]);
  });

  it('returns exact allowlisted keys across all four MCP projections and leaks zero canary PII, tokens, OTPs, or unconfirmed proposals', async () => {
    const grantId = await insertGrant(orgA, users.admin!, 'company');
    const ctx = { actor: mcpActor(users.admin!, grantId, 'company'), orgId: orgA };

    const envList = await runtime.query<McpSignEnvelopesResult>('sign.mcp.envelopes', { limit: 25 }, ctx);
    expect(envList.total).toBe(2);
    expect(envList.truncated).toBe(false);
    expect(envList.envelopes.map((e) => e.id).sort()).toEqual([ids.completedEnv!, ids.proposedEnv!].sort());
    for (const row of envList.envelopes) {
      expect(Object.keys(row).sort()).toEqual(ENVELOPE_ROW_KEYS);
      expect(Object.keys(row.signerCounts).sort()).toEqual(SIGNER_COUNTS_KEYS);
      expect(/[\p{Cc}\p{Cf}]/u.test(row.title)).toBe(false);
    }

    const detail = await runtime.query<McpSignEnvelopeDetail>(
      'sign.mcp.envelope_get',
      { envelopeId: ids.completedEnv },
      ctx,
    );
    expect(Object.keys(detail).sort()).toEqual(ENVELOPE_DETAIL_KEYS);
    expect(detail.title).toBe('Hop dong dich vu chinh thuc');
    expect(detail.signerCounts).toEqual({ total: 1, signed: 1, pending: 0, declined: 0 });
    expect(detail.signers).toHaveLength(1);
    expect(Object.keys(detail.signers[0]!).sort()).toEqual(MASKED_SIGNER_KEYS);
    expect(detail.signers[0]!.roleLabel).toBe('Dai dien khach hang');
    expect(detail.obligation).not.toBeNull();
    expect(Object.keys(detail.obligation!).sort()).toEqual(OBLIGATION_KEYS);
    expect(detail.obligation!.contractValue).toBe('125000000');
    expect(detail.obligation!.items).toHaveLength(1);
    expect(Object.keys(detail.obligation!.items[0]!).sort()).toEqual(OBLIGATION_ITEM_KEYS);
    expect(detail.obligation!.items[0]!.title).toBe('Nghiem thu dot 1');

    // Envelope with unconfirmed AI proposal returns obligation: null.
    const unconfirmedDetail = await runtime.query<McpSignEnvelopeDetail>(
      'sign.mcp.envelope_get',
      { envelopeId: ids.proposedEnv },
      ctx,
    );
    expect(unconfirmedDetail.obligation).toBeNull();

    // Redact email-shaped substrings from signer.roleLabel (including U+FEFF BOM attempts) without modifying ordinary labels (#4510).
    const proposedSignerAdded = await runtime.execute<{ signerId: string }>(
      'sign.signer.add',
      {
        envelopeId: ids.proposedEnv,
        signerRole: 'signer',
        roleLabel: 'Ben B <signer-leak@mcp-company.test>',
        routingOrder: 1,
        name: 'Signer Proposed Canary',
        email: 'signer-leak@mcp-company.test',
        deliveryMode: 'link',
        requireEmailOtp: false,
      },
      { actor: asUser('admin'), orgId: orgA },
    );
    const redactedDetail = await runtime.query<McpSignEnvelopeDetail>(
      'sign.mcp.envelope_get',
      { envelopeId: ids.proposedEnv },
      ctx,
    );
    expect(redactedDetail.signers[0]?.roleLabel).toBe('Ben B <[redacted]>');
    expect(JSON.stringify(redactedDetail)).not.toContain('signer-leak@mcp-company.test');

    await sqlAdmin(
      `UPDATE ludy_sign.signer SET role_label = $3 WHERE org_id = $1 AND id = $2`,
      [orgA, proposedSignerAdded.signerId, 'Ben B alice@\uFEFFexample.com'],
    );
    const bomRedactedDetail = await runtime.query<McpSignEnvelopeDetail>(
      'sign.mcp.envelope_get',
      { envelopeId: ids.proposedEnv },
      ctx,
    );
    expect(bomRedactedDetail.signers[0]?.roleLabel).toBe('Ben B [redacted]');
    expect(JSON.stringify(bomRedactedDetail)).not.toContain('alice@');
    expect(JSON.stringify(bomRedactedDetail)).not.toContain('example.com');

    const renewals = await runtime.query<McpSignRenewalsResult>(
      'sign.mcp.renewals',
      { withinDays: 90, limit: 25 },
      ctx,
    );
    expect(renewals.total).toBe(1);
    expect(renewals.items).toHaveLength(1);
    expect(Object.keys(renewals.items[0]!).sort()).toEqual(RENEWAL_ROW_KEYS);
    expect(renewals.items[0]!.envelopeId).toBe(ids.completedEnv);
    expect(renewals.items[0]!.pendingObligationCount).toBe(1);

    const templates = await runtime.query<McpSignTemplatesResult>('sign.mcp.templates', { limit: 25 }, ctx);
    expect(templates.total).toBe(1);
    expect(templates.templates).toHaveLength(1);
    expect(Object.keys(templates.templates[0]!).sort()).toEqual(TEMPLATE_ROW_KEYS);
    expect(templates.templates[0]).toMatchObject({
      id: ids.activeTpl,
      title: 'Mau hop dong ban hang',
      routingMode: 'sequential',
      roleCount: 1,
      directLinkEnabled: true,
    });

    const combined = JSON.stringify({ envList, detail, unconfirmedDetail, renewals, templates });
    expect(combined).not.toContain(CANARY);
    expect(combined).not.toContain('canary-email@mcp-sign.test');
    expect(combined).not.toContain('+84909999999');
    expect(combined).not.toContain(ids.signingTokenClear!);
    expect(combined).not.toContain(ids.directTokenClear!);
    expect(combined).not.toContain('ludy_sk_');
  });

  it('answers identical 404 SIGN_ENVELOPE_NOT_FOUND for unknown, hr_contract, meeting_minutes, and foreign-org envelopes', async () => {
    const grantId = await insertGrant(orgA, users.admin!, 'company');
    const ctx = { actor: mcpActor(users.admin!, grantId, 'company'), orgId: orgA };

    const shapes = [];
    for (const targetId of [randomUUID(), ids.hrEnv!, ids.mtgEnv!, ids.orgBEnv!]) {
      const err = await refusal(runtime.query('sign.mcp.envelope_get', { envelopeId: targetId }, ctx));
      shapes.push({ code: err.code, status: err.status, message: err.message });
    }
    expect(shapes[0]).toEqual({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404, message: 'Envelope not found' });
    for (const s of shapes) {
      expect(s).toEqual(shapes[0]);
    }
  });

  it('refuses member grants, plain browser sessions, missing scopes, revoked grants, MODULE_OFF, and Stop AI switches', async () => {
    await sqlAdmin(`UPDATE ludy_kernel.tenant SET mcp_member_grants = true WHERE org_id = $1`, [orgA]);
    const memberGrantId = await insertGrant(orgA, users.member!, 'member');
    const asMemberGrant = { actor: mcpActor(users.member!, memberGrantId, 'member'), orgId: orgA };

    for (const [q, input] of [
      ['sign.mcp.envelopes', {}],
      ['sign.mcp.envelope_get', { envelopeId: ids.completedEnv }],
      ['sign.mcp.renewals', {}],
      ['sign.mcp.templates', {}],
    ] as const) {
      expect((await refusal(runtime.query(q, input, asMemberGrant))).code, `member grant ${q}`).toBe('FORBIDDEN');
      expect((await refusal(runtime.query(q, input, { actor: asUser('admin'), orgId: orgA }))).code, `browser ${q}`).toBe(
        'FORBIDDEN',
      );
    }

    const companyGrantId = await insertGrant(orgA, users.owner!, 'company');
    const asOwnerGrant = { actor: mcpActor(users.owner!, companyGrantId, 'company'), orgId: orgA };

    // Missing scope in actor token
    expect(
      (
        await refusal(
          runtime.query(
            'sign.mcp.envelopes',
            {},
            { actor: mcpActor(users.owner!, companyGrantId, 'company', []), orgId: orgA },
          ),
        )
      ).code,
    ).toBe('FORBIDDEN');

    // Switching off eSign app answers MODULE_OFF; turning it back on restores access.
    await runtime.execute('kernel.org.set_app', { module: 'sign', enabled: false }, { actor: asMfa('owner'), orgId: orgA });
    try {
      expect((await refusal(runtime.query('sign.mcp.envelopes', {}, asOwnerGrant))).code).toBe('MODULE_OFF');
    } finally {
      await runtime.execute('kernel.org.set_app', { module: 'sign', enabled: true }, { actor: asMfa('owner'), orgId: orgA });
    }
    expect((await runtime.query<McpSignEnvelopesResult>('sign.mcp.envelopes', {}, asOwnerGrant)).total).toBe(2);

    // Org-wide Stop AI switch cuts MCP grant standing immediately.
    const switchRow = await sqlAdmin<{ id: string }>(
      `INSERT INTO ludy_kernel.kill_switch (org_id, scope, target, reason, engaged_by)
       VALUES ($1, 'org', '*', 'Stop AI test', $2)
       RETURNING id`,
      [orgA, users.owner],
    );
    try {
      const err = await refusal(runtime.query('sign.mcp.envelopes', {}, asOwnerGrant));
      expect([401, 403]).toContain(err.status);
    } finally {
      await sqlAdmin(`UPDATE ludy_kernel.kill_switch SET released_at = now(), released_by = $3 WHERE org_id = $1 AND id = $2`, [
        orgA,
        switchRow.rows[0]!.id,
        users.owner,
      ]);
    }

    // Revoking the grant ends access immediately.
    await sqlAdmin(`UPDATE ludy_kernel.agent_grant SET revoked_at = clock_timestamp() WHERE org_id = $1 AND id = $2`, [
      orgA,
      companyGrantId,
    ]);
    const revokedErr = await refusal(runtime.query('sign.mcp.envelopes', {}, asOwnerGrant));
    expect([401, 403]).toContain(revokedErr.status);
  });

  it('orders dated upcoming renewals ahead of undated obligations when over the 200-row SQL cap', async () => {
    const grantB = await insertGrant(orgB, users.foreign!, 'company');
    const asGrantB = { actor: mcpActor(users.foreign!, grantB, 'company'), orgId: orgB };
    const createdEnvIds: string[] = [];

    try {
      const seedRes = await sqlAdmin<{ id: string; dated: boolean }>(
        `WITH base AS (
           SELECT org_id, source_file_id, source_storage_key, source_generation, source_sha256
           FROM crove_sign.envelope
           WHERE org_id = $1 AND id = $2
         ),
         env_rows AS (
           INSERT INTO crove_sign.envelope (
             org_id, id, title, status, source_file_id, source_storage_key, source_generation, source_sha256, created_by
           )
           SELECT
             b.org_id,
             ludy_kernel.uuid_v7(),
             CASE
               WHEN g.n = 0 THEN 'Dated Renewal Priority Contract'
               WHEN g.n = 1 THEN 'Undated Obligation Urgent Due Date'
               ELSE 'Undated Obligation ' || g.n
             END,
             'completed',
             b.source_file_id,
             b.source_storage_key,
             b.source_generation,
             b.source_sha256,
             $3::uuid
           FROM base b
           CROSS JOIN generate_series(0, 202) AS g(n)
           RETURNING id, title
         ),
         ob_rows AS (
           INSERT INTO crove_sign.envelope_obligation (
             org_id, envelope_id, effective_date, expiry_date, renewal_notice_days,
             obligations_json, status, confirmed_by, confirmed_at, created_by, updated_at
           )
           SELECT
             $1::uuid,
             e.id,
             current_date,
             CASE WHEN e.title = 'Dated Renewal Priority Contract' THEN current_date + 20 ELSE NULL END,
             CASE WHEN e.title = 'Dated Renewal Priority Contract' THEN 5 ELSE NULL END,
             CASE
               WHEN e.title = 'Undated Obligation Urgent Due Date'
                 THEN jsonb_build_array(jsonb_build_object(
                   'id', 'ob-urgent',
                   'title', 'Urgent undated contract check',
                   'dueDate', to_char(current_date + 2, 'YYYY-MM-DD'),
                   'status', 'pending',
                   'completedAt', NULL
                 ))
               ELSE '[{"id":"ob-1","title":"Pending check","dueDate":null,"status":"pending","completedAt":null}]'::jsonb
             END,
             'confirmed',
             $3::uuid,
             now(),
             $3::uuid,
             CASE
               WHEN e.title IN ('Dated Renewal Priority Contract', 'Undated Obligation Urgent Due Date')
                 THEN now() - interval '1 day'
               ELSE now()
             END
           FROM env_rows e
           RETURNING envelope_id, (expiry_date IS NOT NULL) AS dated, (next_pending_due_date IS NOT NULL) AS has_due
         )
         SELECT envelope_id AS id, dated, has_due FROM ob_rows`,
        [orgB, ids.orgBEnv!, users.foreign!],
      );
      for (const r of seedRes.rows) createdEnvIds.push(r.id);
      const datedId = seedRes.rows.find((r) => r.dated)!.id;
      const urgentDueId = seedRes.rows.find((r) => (r as unknown as { has_due: boolean }).has_due)!.id;

      const renewals = await runtime.query<McpSignRenewalsResult>(
        'sign.mcp.renewals',
        { withinDays: 90, limit: 25 },
        asGrantB,
      );
      expect(renewals.items.some((item) => item.envelopeId === datedId)).toBe(true);
      expect(renewals.items.some((item) => item.envelopeId === urgentDueId)).toBe(true);
      expect(renewals.total).toBeGreaterThan(200);
      expect(renewals.truncated).toBe(true);
      expect(renewals.items[0]!.envelopeId).toBe(urgentDueId);
    } finally {
      if (createdEnvIds.length > 0) {
        await sqlAdmin(
          `DELETE FROM crove_sign.envelope_obligation WHERE org_id = $1 AND envelope_id = ANY($2::uuid[])`,
          [orgB, createdEnvIds],
        );
        await sqlAdmin(
          `DELETE FROM crove_sign.envelope WHERE org_id = $1 AND id = ANY($2::uuid[])`,
          [orgB, createdEnvIds],
        );
      }
    }
  });
});
