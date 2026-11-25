// SPDX-License-Identifier: AGPL-3.0-only
// PostgreSQL 17 integration & security tests for eSign Slice 2a (#3526):
//   - Template CRUD, PDF inspection handoff & reuse, and sourceEnvelopeId cloning
//   - Approver / CC / Signer role presets, field validation, and role-key swapping
//   - One-click envelope instantiation (draft & atomic autoSend) preserving envelope_guard integrity
//   - A1 single non-CC role Direct Signing Link enable/OTP/rotate/revoke & org_app_on('sign') checks
//   - Cross-tenant RLS isolation, viewer read-only enforcement, machinery grant denial, and org purge
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import {
  DEFAULT_MESSAGE_ID_DOMAIN,
  createOrg,
  kernelCommands,
  kernelManifest,
  kernelQueries,
  upsertIdentity,
} from '@ludy/kernel';
import { Runtime, contentGeneration, fileKey, mintContextToken, sha256Hex } from '@ludy/kernel-runtime';
import {
  SIGN_DIRECT_PAGE_PATH,
  SIGN_TOKEN_PATTERN,
  zSignEnvelopeDetail,
} from '@ludy/kernel-contract';
import {
  generateCertificateCode,
  generateRawSigningToken,
  hashSigningToken,
  signCommands,
  signManifest,
  signQueries,
} from '../src/index.ts';

type Pool = ReturnType<typeof createPool>;

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

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

function makePngBase64(width = 160, height = 60): string {
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
  const rawBytes = width > 0 && height > 0 ? Buffer.alloc(height * (1 + width * 4), 0) : Buffer.from([0, 0, 0, 0, 255]);
  const idat = chunk('IDAT', deflateSync(rawBytes));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    idat,
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

const VALID_PNG_BASE64 = makePngBase64();

suite('eSign Slice 2a reusable templates, roles & direct signing links on PostgreSQL 17 (#3526)', () => {
  const dbName = `ludy_test_sign_tpl_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let adminPool: Pool | undefined;
  let appPool: Pool | undefined;
  let workerPool: Pool | undefined;
  let runtime: Runtime;
  let workerRuntime: Runtime;

  let orgA = '';
  let orgB = '';
  let ownerA = '';
  let viewerA = '';
  let ownerB = '';

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asSystem = (component: string) => ({ type: 'system' as const, component });

  async function ingestPdf(
    actorUserId: string,
    orgId: string,
    tag: string,
    source: 'sign_document' | 'sign_sealed' | 'sign_certificate' = 'sign_document',
  ): Promise<{ fileId: string; sha256: string; storageKey: string; generation: string }> {
    const bytes = Uint8Array.from(
      Buffer.from(`%PDF-1.4\n% sign-tpl-${tag}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n`, 'utf8'),
    );
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(orgId, sha256);
    const generation = contentGeneration(sha256);
    const execRuntime = source === 'sign_document' ? runtime : workerRuntime;
    const actor = source === 'sign_document' ? asUser(actorUserId) : asSystem('sign-worker');
    const { fileId } = await execRuntime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      {
        filename: `${tag}.pdf`,
        contentType: source === 'sign_certificate' ? 'application/json' : 'application/pdf',
        sizeBytes: bytes.byteLength,
        sha256,
        storageKey,
        generation,
        source,
      },
      { actor, orgId },
    );
    return { fileId, sha256, storageKey, generation };
  }

  beforeAll(async () => {
    const rootPool = createPool({ connectionString: ADMIN as string, max: 1 });
    await rootPool.query(`CREATE DATABASE ${dbName}`);
    await rootPool.end();

    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();

    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'tpl-app-pw', ludy_worker: 'tpl-worker-pw' });

    const loginUrl = (user: string, pw: string) => {
      const u = new URL(adminUrl);
      u.username = user;
      u.password = pw;
      return u.toString();
    };

    adminPool = createPool({ connectionString: adminUrl, max: 2 });
    appPool = createPool({ connectionString: loginUrl('ludy_app', 'tpl-app-pw'), max: 6 });
    workerPool = createPool({ connectionString: loginUrl('ludy_worker', 'tpl-worker-pw'), max: 3 });

    const manifests = [kernelManifest.tables, signManifest.tables];
    const appDb = createDb(appPool);
    const workerDb = createDb(workerPool);

    runtime = new Runtime(appDb, { manifests })
      .register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) })
      .register({ commands: signCommands, queries: signQueries });

    workerRuntime = new Runtime(workerDb, { manifests })
      .register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) })
      .register({ commands: signCommands, queries: signQueries });

    ownerA = await upsertIdentity(appDb, { issuer: 'sign-tpl', subject: 'owner-a', email: 'ownera@sign-tpl.test', name: 'Owner A' });
    viewerA = await upsertIdentity(appDb, { issuer: 'sign-tpl', subject: 'viewer-a', email: 'viewera@sign-tpl.test', name: 'Viewer A' });
    ownerB = await upsertIdentity(appDb, { issuer: 'sign-tpl', subject: 'owner-b', email: 'ownerb@sign-tpl.test', name: 'Owner B' });

    orgA = (await createOrg(runtime, asUser(ownerA), 'Cong ty Mau A')).orgId;
    orgB = (await createOrg(runtime, asUser(ownerB), 'Cong ty Mau B')).orgId;

    await adminPool.query(
      "INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1::uuid, $2::uuid, 'viewer')",
      [orgA, viewerA],
    );
  }, 120_000);

  afterAll(async () => {
    await appPool?.end();
    await workerPool?.end();
    await adminPool?.end();
    if (!ADMIN) return;
    const rootPool = createPool({ connectionString: ADMIN, max: 1 });
    await rootPool.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await rootPool.end();
  });

  it('creates templates, runs inspection, updates roles (Signer/Approver/CC) & fields, and reuses passed inspection', async () => {
    const file = await ingestPdf(ownerA, orgA, 'service-agreement');

    const created = await runtime.execute<{
      templateId: string;
      status: string;
      inspectStatus: string;
      version: number;
    }>(
      'sign.template.create',
      {
        title: 'Hop dong dich vu chuan',
        description: 'Dung cho khach hang SME',
        routingMode: 'sequential',
        subject: 'Moi ky hop dong',
        message: 'Vui long kiem tra va ky.',
        expiresInHours: 168,
        sourceFileId: file.fileId,
      },
      { actor: asUser(ownerA), orgId: orgA },
    );

    expect(created.status).toBe('draft');
    expect(created.inspectStatus).toBe('pending');
    expect(created.version).toBe(1);

    // Outbox emitted sign.template.inspect_queued.
    const queued = await adminPool!.query<{ type: string }>(
      "SELECT type FROM ludy_kernel.outbox_event WHERE org_id = $1 AND type = 'sign.template.inspect_queued'",
      [orgA],
    );
    expect(queued.rows.length).toBeGreaterThanOrEqual(1);

    // Cannot activate while inspectStatus === 'pending'.
    await expect(
      runtime.execute(
        'sign.template.update',
        { templateId: created.templateId, status: 'active' },
        { actor: asUser(ownerA), orgId: orgA },
      ),
    ).rejects.toThrow(/SIGN_TEMPLATE_NOT_INSPECTED|pass inspection/i);

    // Inspect job data query & complete command as system.
    const jobData = await workerRuntime.query<{ id: string; status: string; inspectStatus: string } | null>(
      'sign.template.inspect_job_data',
      { templateId: created.templateId },
      { actor: asSystem('sign-worker'), orgId: orgA },
    );
    expect(jobData).toMatchObject({ id: created.templateId, status: 'draft', inspectStatus: 'pending' });

    const inspected = await workerRuntime.execute<{ inspectStatus: string; pageCount: number }>(
      'sign.template.inspect_complete',
      {
        templateId: created.templateId,
        outcome: 'passed',
        pageCount: 2,
        pageDimensions: [
          { page: 1, widthPt: 595, heightPt: 842, rotation: 0 },
          { page: 2, widthPt: 595, heightPt: 842, rotation: 0 },
        ],
      },
      { actor: asSystem('sign-worker'), orgId: orgA },
    );
    expect(inspected).toMatchObject({ inspectStatus: 'passed', pageCount: 2 });

    // Activate now succeeds.
    const activated = await runtime.execute<{ status: string }>(
      'sign.template.update',
      { templateId: created.templateId, status: 'active' },
      { actor: asUser(ownerA), orgId: orgA },
    );
    expect(activated.status).toBe('active');

    // Configure Signer, Approver, and CC roles.
    const savedRoles = await runtime.execute<{
      roles: Array<{ id: string; roleKey: string; signerRole: string }>;
    }>(
      'sign.template.roles_set',
      {
        templateId: created.templateId,
        roles: [
          {
            roleKey: 'r1',
            signerRole: 'approver',
            roleLabel: 'Quan ly duyet',
            routingOrder: 1,
            deliveryMode: 'email',
            requireEmailOtp: false,
          },
          {
            roleKey: 'r2',
            signerRole: 'signer',
            roleLabel: 'Dai dien ky',
            routingOrder: 2,
            deliveryMode: 'link',
            requireEmailOtp: false,
          },
          {
            roleKey: 'cc1',
            signerRole: 'cc',
            roleLabel: 'Ke toan nhan ban sao',
            routingOrder: 3,
            deliveryMode: 'email',
            requireEmailOtp: false,
          },
        ],
      },
      { actor: asUser(ownerA), orgId: orgA },
    );
    expect(savedRoles.roles.map((r) => [r.roleKey, r.signerRole])).toEqual([
      ['r1', 'approver'],
      ['r2', 'signer'],
      ['cc1', 'cc'],
    ]);

    // CC role cannot have fields assigned.
    await expect(
      runtime.execute(
        'sign.template.fields_set',
        {
          templateId: created.templateId,
          fields: [
            { roleKey: 'cc1', fieldType: 'text', pageNumber: 1, xNorm: 0.1, yNorm: 0.1, wNorm: 0.2, hNorm: 0.05, required: true },
          ],
        },
        { actor: asUser(ownerA), orgId: orgA },
      ),
    ).rejects.toThrow(/CC/);

    // Page out of bounds fails cleanly.
    await expect(
      runtime.execute(
        'sign.template.fields_set',
        {
          templateId: created.templateId,
          fields: [
            { roleKey: 'r2', fieldType: 'signature', pageNumber: 3, xNorm: 0.1, yNorm: 0.1, wNorm: 0.2, hNorm: 0.08, required: true },
          ],
        },
        { actor: asUser(ownerA), orgId: orgA },
      ),
    ).rejects.toThrow(/page count/);

    // Valid fields assigned to signer & approver.
    const fieldsSet = await runtime.execute<{ fieldCount: number }>(
      'sign.template.fields_set',
      {
        templateId: created.templateId,
        fields: [
          { roleKey: 'r2', fieldType: 'signature', pageNumber: 2, xNorm: 0.55, yNorm: 0.72, wNorm: 0.24, hNorm: 0.08, label: 'Chu ky B', required: true },
          { roleKey: 'r1', fieldType: 'date', pageNumber: 1, xNorm: 0.1, yNorm: 0.2, wNorm: 0.18, hNorm: 0.05, label: 'Ngay duyet', required: false },
        ],
      },
      { actor: asUser(ownerA), orgId: orgA },
    );
    expect(fieldsSet.fieldCount).toBe(2);

    // Swapping roleKeys preserves field links and prevents existing-field role from becoming CC.
    const r2Id = savedRoles.roles.find((r) => r.roleKey === 'r2')!.id;
    const r1Id = savedRoles.roles.find((r) => r.roleKey === 'r1')!.id;

    // Explicit templateRoleId must resolve directly and never fall back to roleByKey (#3566).
    await expect(
      runtime.execute(
        'sign.template.fields_set',
        {
          templateId: created.templateId,
          fields: [
            {
              templateRoleId: randomUUID(),
              roleKey: 'r2',
              fieldType: 'signature',
              pageNumber: 1,
              xNorm: 0.2,
              yNorm: 0.3,
              wNorm: 0.24,
              hNorm: 0.08,
              required: true,
            },
          ],
        },
        { actor: asUser(ownerA), orgId: orgA },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_ROLE_NOT_FOUND', status: 422 });

    // Conflicting templateRoleId and roleKey is rejected with 422 SIGN_INVALID_FIELD.
    await expect(
      runtime.execute(
        'sign.template.fields_set',
        {
          templateId: created.templateId,
          fields: [
            {
              templateRoleId: r1Id,
              roleKey: 'r2',
              fieldType: 'date',
              pageNumber: 1,
              xNorm: 0.1,
              yNorm: 0.2,
              wNorm: 0.18,
              hNorm: 0.05,
              required: false,
            },
          ],
        },
        { actor: asUser(ownerA), orgId: orgA },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_INVALID_FIELD', status: 422 });

    // Unknown roleKey without templateRoleId is rejected with 422 SIGN_ROLE_NOT_FOUND.
    await expect(
      runtime.execute(
        'sign.template.fields_set',
        {
          templateId: created.templateId,
          fields: [
            {
              roleKey: 'r99',
              fieldType: 'date',
              pageNumber: 1,
              xNorm: 0.1,
              yNorm: 0.2,
              wNorm: 0.18,
              hNorm: 0.05,
              required: false,
            },
          ],
        },
        { actor: asUser(ownerA), orgId: orgA },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_ROLE_NOT_FOUND', status: 422 });

    // Matching templateRoleId + roleKey succeeds cleanly.
    const matchedFieldsSet = await runtime.execute<{ fieldCount: number }>(
      'sign.template.fields_set',
      {
        templateId: created.templateId,
        fields: [
          {
            templateRoleId: r2Id,
            roleKey: 'r2',
            fieldType: 'signature',
            pageNumber: 2,
            xNorm: 0.55,
            yNorm: 0.72,
            wNorm: 0.24,
            hNorm: 0.08,
            label: 'Chu ky B',
            required: true,
          },
          {
            templateRoleId: r1Id,
            roleKey: 'r1',
            fieldType: 'date',
            pageNumber: 1,
            xNorm: 0.1,
            yNorm: 0.2,
            wNorm: 0.18,
            hNorm: 0.05,
            label: 'Ngay duyet',
            required: false,
          },
        ],
      },
      { actor: asUser(ownerA), orgId: orgA },
    );
    expect(matchedFieldsSet.fieldCount).toBe(2);
    await expect(
      runtime.execute(
        'sign.template.roles_set',
        {
          templateId: created.templateId,
          roles: [
            { id: r2Id, roleKey: 'r2', signerRole: 'cc', roleLabel: 'Become CC', routingOrder: 1, deliveryMode: 'link', requireEmailOtp: false },
          ],
        },
        { actor: asUser(ownerA), orgId: orgA },
      ),
    ).rejects.toThrow(/cannot become CC/);

    await expect(
      runtime.execute(
        'sign.template.roles_set',
        {
          templateId: created.templateId,
          roles: [
            { roleKey: 'cc_bad', signerRole: 'cc', roleLabel: 'Bad CC', routingOrder: 1, deliveryMode: 'email', requireEmailOtp: true },
          ],
        },
        { actor: asUser(ownerA), orgId: orgA },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_INVALID_SIGNER', status: 422 });

    // Swap r1 <-> r2 keys across surviving rows cleanly, and verify id match precedes key reuse on a single update.
    await runtime.execute(
      'sign.template.roles_set',
      {
        templateId: created.templateId,
        roles: [
          { id: r1Id, roleKey: 'r2', signerRole: 'approver', roleLabel: 'Quan ly duyet', routingOrder: 1, deliveryMode: 'email', requireEmailOtp: false },
          { id: r2Id, roleKey: 'r1', signerRole: 'signer', roleLabel: 'Dai dien ky', routingOrder: 2, deliveryMode: 'link', requireEmailOtp: false },
          { roleKey: 'cc1', signerRole: 'cc', roleLabel: 'Ke toan', routingOrder: 3, deliveryMode: 'email', requireEmailOtp: false },
        ],
      },
      { actor: asUser(ownerA), orgId: orgA },
    );
    await runtime.execute(
      'sign.template.roles_set',
      {
        templateId: created.templateId,
        roles: [
          { roleKey: 'r2', signerRole: 'approver', roleLabel: 'Duyet moi', routingOrder: 1, deliveryMode: 'email', requireEmailOtp: false },
          { id: r1Id, roleKey: 'r3', signerRole: 'approver', roleLabel: 'Quan ly duyet', routingOrder: 2, deliveryMode: 'email', requireEmailOtp: false },
          { id: r2Id, roleKey: 'r1', signerRole: 'signer', roleLabel: 'Dai dien ky', routingOrder: 3, deliveryMode: 'link', requireEmailOtp: false },
          { roleKey: 'cc1', signerRole: 'cc', roleLabel: 'Ke toan', routingOrder: 4, deliveryMode: 'email', requireEmailOtp: false },
        ],
      },
      { actor: asUser(ownerA), orgId: orgA },
    );

    const detail = await runtime.query<{
      template: { status: string; inspectStatus: string; pageCount: number };
      roles: Array<{ id: string; roleKey: string; signerRole: string }>;
      fields: Array<{ templateRoleId: string; roleKey: string }>;
    }>('sign.template.get', { templateId: created.templateId }, { actor: asUser(ownerA), orgId: orgA });

    expect(detail.fields).toHaveLength(2);
    expect(detail.fields.find((f) => f.templateRoleId === r2Id)?.roleKey).toBe('r1');
    expect(detail.fields.find((f) => f.templateRoleId === r1Id)?.roleKey).toBe('r3');

    // Second template from identical already-inspected file reuses passed inspection immediately.
    const reused = await runtime.execute<{ status: string; inspectStatus: string }>(
      'sign.template.create',
      {
        title: 'Ban sao cung PDF',
        routingMode: 'parallel',
        sourceFileId: file.fileId,
        status: 'active',
      },
      { actor: asUser(ownerA), orgId: orgA },
    );
    expect(reused).toMatchObject({ status: 'active', inspectStatus: 'passed' });
  });

  it('enforces A1 single active non-CC role direct-link rule, zero plaintext storage, rotate/disable/archive revocation, and app-off guard', async () => {
    const file = await ingestPdf(ownerA, orgA, 'direct-link-nda');
    const tpl = await runtime.execute<{ templateId: string; inspectStatus: string }>(
      'sign.template.create',
      { title: 'NDA 1 ben ky', routingMode: 'parallel', sourceFileId: file.fileId },
      { actor: asUser(ownerA), orgId: orgA },
    );
    await workerRuntime.execute(
      'sign.template.inspect_complete',
      {
        templateId: tpl.templateId,
        outcome: 'passed',
        pageCount: 1,
        pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0 }],
      },
      { actor: asSystem('sign-worker'), orgId: orgA },
    );

    // Draft template cannot enable direct link.
    await expect(
      runtime.execute(
        'sign.template.direct_link_set',
        { templateId: tpl.templateId, enabled: true },
        { actor: asUser(ownerA), orgId: orgA },
      ),
    ).rejects.toThrow(/active template/);

    await runtime.execute(
      'sign.template.update',
      { templateId: tpl.templateId, status: 'active' },
      { actor: asUser(ownerA), orgId: orgA },
    );

    // Zero active non-CC roles -> refused (A1).
    await expect(
      runtime.execute(
        'sign.template.direct_link_set',
        { templateId: tpl.templateId, enabled: true },
        { actor: asUser(ownerA), orgId: orgA },
      ),
    ).rejects.toThrow(/exactly one active non-CC/);

    // 2 active non-CC roles -> refused (A1).
    await runtime.execute(
      'sign.template.roles_set',
      {
        templateId: tpl.templateId,
        roles: [
          { roleKey: 'r1', signerRole: 'signer', roleLabel: 'Ben A', routingOrder: 1, deliveryMode: 'link', requireEmailOtp: false },
          { roleKey: 'r2', signerRole: 'approver', roleLabel: 'Duyet', routingOrder: 2, deliveryMode: 'email', requireEmailOtp: false },
        ],
      },
      { actor: asUser(ownerA), orgId: orgA },
    );
    await expect(
      runtime.execute(
        'sign.template.direct_link_set',
        { templateId: tpl.templateId, enabled: true },
        { actor: asUser(ownerA), orgId: orgA },
      ),
    ).rejects.toThrow(/exactly one active non-CC/);

    // 1 active non-CC role + 1 CC role -> allowed (CC does not violate A1!).
    await runtime.execute(
      'sign.template.roles_set',
      {
        templateId: tpl.templateId,
        roles: [
          { roleKey: 'r1', signerRole: 'signer', roleLabel: 'Khach ky', routingOrder: 1, deliveryMode: 'link', requireEmailOtp: false },
          { roleKey: 'cc1', signerRole: 'cc', roleLabel: 'Luu tru', routingOrder: 2, deliveryMode: 'email', requireEmailOtp: false },
        ],
      },
      { actor: asUser(ownerA), orgId: orgA },
    );

    const enabled = await runtime.execute<{
      enabled: boolean;
      requireEmailOtp: boolean;
      url: string | null;
      token: string | null;
    }>(
      'sign.template.direct_link_set',
      { templateId: tpl.templateId, enabled: true, requireEmailOtp: false },
      { actor: asUser(ownerA), orgId: orgA },
    );
    expect(enabled.enabled).toBe(true);
    expect(enabled.token).toMatch(SIGN_TOKEN_PATTERN);
    expect(enabled.url).toBe(`${SIGN_DIRECT_PAGE_PATH}#${enabled.token}`);

    // Only SHA-256 stored in DB; never plaintext token.
    const storedRows = await adminPool!.query<{
      token_sha256: string;
      enabled: boolean;
      require_email_otp: boolean;
      revoked_at: Date | null;
    }>(
      'SELECT token_sha256, enabled, require_email_otp, revoked_at FROM ludy_sign.template_direct_link WHERE org_id = $1 AND template_id = $2',
      [orgA, tpl.templateId],
    );
    expect(storedRows.rows).toHaveLength(1);
    expect(storedRows.rows[0]!.token_sha256).toBe(hashSigningToken(enabled.token!));
    expect(storedRows.rows[0]!.token_sha256).not.toContain(enabled.token);

    // Toggling OTP keeps active link without leaking or minting new secret.
    const otpUpdated = await runtime.execute<{ enabled: boolean; requireEmailOtp: boolean; url: string | null; token: string | null }>(
      'sign.template.direct_link_set',
      { templateId: tpl.templateId, enabled: true, requireEmailOtp: true },
      { actor: asUser(ownerA), orgId: orgA },
    );
    expect(otpUpdated).toMatchObject({ enabled: true, requireEmailOtp: true, url: null, token: null });

    // Rotating revokes previous token hash and mints fresh token preserving requireEmailOtp.
    const rotated = await runtime.execute<{ enabled: boolean; requireEmailOtp: boolean; url: string | null; token: string | null }>(
      'sign.template.direct_link_rotate',
      { templateId: tpl.templateId },
      { actor: asUser(ownerA), orgId: orgA },
    );
    expect(rotated.enabled).toBe(true);
    expect(rotated.requireEmailOtp).toBe(true);
    expect(rotated.token).toMatch(SIGN_TOKEN_PATTERN);
    expect(rotated.token).not.toBe(enabled.token);
    expect(rotated.url).toBe(`${SIGN_DIRECT_PAGE_PATH}#${rotated.token}`);

    const afterRotate = await adminPool!.query<{ token_sha256: string; revoked_at: Date | null }>(
      'SELECT token_sha256, revoked_at FROM ludy_sign.template_direct_link WHERE org_id = $1 AND template_id = $2 ORDER BY created_at ASC',
      [orgA, tpl.templateId],
    );
    expect(afterRotate.rows).toHaveLength(2);
    expect(afterRotate.rows[0]!.revoked_at).not.toBeNull();
    expect(afterRotate.rows[1]!.revoked_at).toBeNull();
    expect(afterRotate.rows[1]!.token_sha256).toBe(hashSigningToken(rotated.token!));

    // App disabled in SQL definer fails closed (org_app_on check).
    await adminPool!.query("UPDATE ludy_kernel.tenant SET apps_off = ARRAY['sign'] WHERE org_id = $1", [orgA]);
    const c = await appPool!.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT ludy_kernel.enter_user_context($1::uuid, $2::text)', [
        orgA,
        mintContextToken(process.env.LUDY_CONTEXT_TOKEN_KEY ?? process.env.CROVE_CONTEXT_TOKEN_KEY ?? '', {
          userId: ownerA,
          orgId: orgA,
          sessionId: null,
          aal: 'aal1',
          mfaAt: null,
        }),
      ]);
      await expect(
        c.query('SELECT ludy_sign.template_direct_link_set($1::uuid, true, false, $2)', [
          tpl.templateId,
          'f'.repeat(64),
        ]),
      ).rejects.toThrow(/SIGN_APP_DISABLED/);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
      await adminPool!.query("UPDATE ludy_kernel.tenant SET apps_off = '{}' WHERE org_id = $1", [orgA]);
    }

    // Adding a second non-CC role automatically revokes active direct link.
    await runtime.execute(
      'sign.template.roles_set',
      {
        templateId: tpl.templateId,
        roles: [
          { roleKey: 'r1', signerRole: 'signer', roleLabel: 'Khach ky', routingOrder: 1, deliveryMode: 'link', requireEmailOtp: false },
          { roleKey: 'r2', signerRole: 'signer', roleLabel: 'Ben B', routingOrder: 2, deliveryMode: 'link', requireEmailOtp: false },
        ],
      },
      { actor: asUser(ownerA), orgId: orgA },
    );
    const activeAfterMulti = await adminPool!.query<{ id: string }>(
      'SELECT id FROM ludy_sign.template_direct_link WHERE org_id = $1 AND template_id = $2 AND revoked_at IS NULL',
      [orgA, tpl.templateId],
    );
    expect(activeAfterMulti.rows).toHaveLength(0);

    // Re-set to 1 role, re-enable link, then archive -> link revoked cleanly.
    await runtime.execute(
      'sign.template.roles_set',
      {
        templateId: tpl.templateId,
        roles: [
          { roleKey: 'r1', signerRole: 'signer', roleLabel: 'Khach ky', routingOrder: 1, deliveryMode: 'link', requireEmailOtp: false },
        ],
      },
      { actor: asUser(ownerA), orgId: orgA },
    );
    await runtime.execute(
      'sign.template.direct_link_set',
      { templateId: tpl.templateId, enabled: true },
      { actor: asUser(ownerA), orgId: orgA },
    );
    const archived = await runtime.execute<{ status: string; revokedLinks: number }>(
      'sign.template.archive',
      { templateId: tpl.templateId },
      { actor: asUser(ownerA), orgId: orgA },
    );
    expect(archived).toMatchObject({ status: 'archived', revokedLinks: 1 });
  });

  it('instantiates draft & autoSent envelopes in one transaction without weakening envelope_guard', async () => {
    const file = await ingestPdf(ownerA, orgA, 'instantiate-flow');
    const tpl = await runtime.execute<{ templateId: string }>(
      'sign.template.create',
      {
        title: 'Hop dong lao dong chuan',
        routingMode: 'sequential',
        subject: 'Moi ky HDLĐ',
        message: 'Xin moi ky',
        sourceFileId: file.fileId,
      },
      { actor: asUser(ownerA), orgId: orgA },
    );
    await workerRuntime.execute(
      'sign.template.inspect_complete',
      {
        templateId: tpl.templateId,
        outcome: 'passed',
        pageCount: 1,
        pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0 }],
      },
      { actor: asSystem('sign-worker'), orgId: orgA },
    );
    await runtime.execute(
      'sign.template.update',
      { templateId: tpl.templateId, status: 'active' },
      { actor: asUser(ownerA), orgId: orgA },
    );
    await runtime.execute(
      'sign.template.roles_set',
      {
        templateId: tpl.templateId,
        roles: [
          { roleKey: 'r1', signerRole: 'approver', roleLabel: 'Truong phong duyet', routingOrder: 1, deliveryMode: 'link', requireEmailOtp: false },
          { roleKey: 'r2', signerRole: 'signer', roleLabel: 'Nhan vien ky', routingOrder: 2, deliveryMode: 'link', requireEmailOtp: false },
          { roleKey: 'cc1', signerRole: 'cc', roleLabel: 'Nhan su', routingOrder: 3, deliveryMode: 'email', requireEmailOtp: false },
        ],
      },
      { actor: asUser(ownerA), orgId: orgA },
    );

    // autoSend fails cleanly if signer role r2 has no signature field yet.
    await expect(
      runtime.execute(
        'sign.template.instantiate',
        {
          templateId: tpl.templateId,
          autoSend: true,
          recipients: [
            { roleKey: 'r1', name: 'Anh Minh' },
            { roleKey: 'r2', name: 'Chi Lan' },
          ],
        },
        { actor: asUser(ownerA), orgId: orgA },
      ),
    ).rejects.toThrow(/signature( or stamp)? field/i);

    // Place signature field on r2 (approver r1 requires 0 signature fields).
    await runtime.execute(
      'sign.template.fields_set',
      {
        templateId: tpl.templateId,
        fields: [
          { roleKey: 'r2', fieldType: 'signature', pageNumber: 1, xNorm: 0.5, yNorm: 0.7, wNorm: 0.25, hNorm: 0.08, required: true },
        ],
      },
      { actor: asUser(ownerA), orgId: orgA },
    );

    // Draft instantiate clones roles & fields and inherits passed PDF inspection.
    const draftInst = await runtime.execute<{ envelopeId: string; status: string; links: unknown[] }>(
      'sign.template.instantiate',
      {
        templateId: tpl.templateId,
        title: 'HDLĐ - Nguyen Van A',
        autoSend: false,
        recipients: [
          { roleKey: 'r1', name: 'Anh Minh', email: 'minh@sign-tpl.test' },
          { roleKey: 'r2', name: 'Nguyen Van A', email: 'vana@sign-tpl.test', phone: '0901234567' },
          { roleKey: 'cc1', name: 'Phong Nhan su', email: 'hr@sign-tpl.test' },
        ],
      },
      { actor: asUser(ownerA), orgId: orgA },
    );
    expect(draftInst.status).toBe('draft');
    expect(draftInst.links).toEqual([]);

    const envDetail = await runtime.query<{
      envelope: { title: string; status: string; inspectStatus: string; pageCount: number };
      signers: Array<{ signerRole: string; name: string; status: string }>;
      fields: Array<{ fieldType: string; pageNumber: number }>;
    }>('sign.envelope.get', { envelopeId: draftInst.envelopeId }, { actor: asUser(ownerA), orgId: orgA });
    expect(envDetail.envelope).toMatchObject({ title: 'HDLĐ - Nguyen Van A', status: 'draft', inspectStatus: 'passed', pageCount: 1 });
    expect(envDetail.signers).toHaveLength(3);
    expect(envDetail.fields).toHaveLength(1);

    // autoSend instantiate transitions to 'sent' and mints 1-time link for due r1 (sequential order 1).
    const sentInst = await runtime.execute<{
      envelopeId: string;
      status: string;
      links: Array<{ signerId: string; token: string }>;
    }>(
      'sign.template.instantiate',
      {
        templateId: tpl.templateId,
        autoSend: true,
        recipients: [
          { roleKey: 'r1', name: 'Anh Minh' },
          { roleKey: 'r2', name: 'Nguyen Van B' },
        ],
      },
      { actor: asUser(ownerA), orgId: orgA },
    );
    expect(sentInst.status).toBe('sent');
    expect(sentInst.links).toHaveLength(1);
    expect(sentInst.links[0]!.token).toMatch(SIGN_TOKEN_PATTERN);

    // Direct tenant SQL still cannot forge inspect_status = 'passed' on envelope or tamper with template inspection/direct links.
    const expectTenantSqlRejects = async (sqlText: string, params: unknown[], pattern: RegExp) => {
      const c = await appPool!.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT ludy_kernel.enter_user_context($1::uuid, $2::text)', [
          orgA,
          mintContextToken(process.env.LUDY_CONTEXT_TOKEN_KEY ?? process.env.CROVE_CONTEXT_TOKEN_KEY ?? '', {
            userId: ownerA,
            orgId: orgA,
            sessionId: null,
            aal: 'aal1',
            mfaAt: null,
          }),
        ]);
        await expect(c.query(sqlText, params)).rejects.toThrow(pattern);
      } finally {
        await c.query('ROLLBACK').catch(() => {});
        c.release();
      }
    };
    await expectTenantSqlRejects(
      `INSERT INTO ludy_sign.envelope (org_id, title, source_file_id, source_storage_key, source_generation, source_sha256, inspect_status, created_by)
       VALUES ($1, 'Forged', $2, $3, $4, $5, 'passed', $6)`,
      [orgA, file.fileId, file.storageKey, file.generation, file.sha256, ownerA],
      /ENVELOPE_FORBIDDEN/,
    );
    await expectTenantSqlRejects(
      "UPDATE ludy_sign.template SET inspect_status = 'failed' WHERE org_id = $1 AND id = $2",
      [orgA, tpl.templateId],
      /SIGN_TEMPLATE_SYSTEM_ONLY/,
    );
    await expectTenantSqlRejects(
      'SELECT * FROM ludy_sign.template_direct_link WHERE org_id = $1',
      [orgA],
      /permission denied/,
    );
    const uninspectedFile = await ingestPdf(ownerA, orgA, 'forge-uninspected');
    await expectTenantSqlRejects(
      `INSERT INTO ludy_sign.template (org_id, title, source_file_id, source_storage_key, source_generation, source_sha256, inspect_status, page_count, status, created_by)
       VALUES ($1, 'Forged Passed', $2, $3, $4, $5, 'passed', 1, 'active', $6)`,
      [orgA, uninspectedFile.fileId, uninspectedFile.storageKey, uninspectedFile.generation, uninspectedFile.sha256, ownerA],
      /SIGN_TEMPLATE_SYSTEM_ONLY/,
    );
    // Raw SQL INSERT with inspect_status = 'passed' and NULL page_count is rejected both for uninspected and inspected source PDFs (#3566).
    await expectTenantSqlRejects(
      `INSERT INTO ludy_sign.template (org_id, title, source_file_id, source_storage_key, source_generation, source_sha256, inspect_status, status, created_by)
       VALUES ($1, 'Forged Passed Null PageCount Draft', $2, $3, $4, $5, 'passed', 'draft', $6)`,
      [orgA, uninspectedFile.fileId, uninspectedFile.storageKey, uninspectedFile.generation, uninspectedFile.sha256, ownerA],
      /SIGN_TEMPLATE_SYSTEM_ONLY/,
    );
    await expectTenantSqlRejects(
      `INSERT INTO ludy_sign.template (org_id, title, source_file_id, source_storage_key, source_generation, source_sha256, inspect_status, status, created_by)
       VALUES ($1, 'Forged Passed Null PageCount Active', $2, $3, $4, $5, 'passed', 'active', $6)`,
      [orgA, uninspectedFile.fileId, uninspectedFile.storageKey, uninspectedFile.generation, uninspectedFile.sha256, ownerA],
      /SIGN_TEMPLATE_SYSTEM_ONLY/,
    );
    await expectTenantSqlRejects(
      `INSERT INTO ludy_sign.template (org_id, title, source_file_id, source_storage_key, source_generation, source_sha256, inspect_status, status, created_by)
       VALUES ($1, 'Forged Passed Null PageCount Inspected File', $2, $3, $4, $5, 'passed', 'active', $6)`,
      [orgA, file.fileId, file.storageKey, file.generation, file.sha256, ownerA],
      /SIGN_TEMPLATE_SYSTEM_ONLY/,
    );
    await expect(
      adminPool!.query(
        "UPDATE ludy_sign.template SET page_count = NULL WHERE org_id = $1 AND id = $2",
        [orgA, tpl.templateId],
      ),
    ).rejects.toThrow(/SIGN_TEMPLATE_SYSTEM_ONLY/);
    await expectTenantSqlRejects(
      `INSERT INTO ludy_sign.template (org_id, title, source_file_id, source_storage_key, source_generation, source_sha256, inspect_status, created_by)
       VALUES ($1, 'Forged Failed', $2, $3, $4, $5, 'failed', $6)`,
      [orgA, uninspectedFile.fileId, uninspectedFile.storageKey, uninspectedFile.generation, uninspectedFile.sha256, ownerA],
      /SIGN_TEMPLATE_SYSTEM_ONLY/,
    );
    await expectTenantSqlRejects(
      'SELECT * FROM ludy_sign.template_work_recovery_candidates(pg_catalog.now(), 10, NULL)',
      [],
      /permission denied/,
    );
    const pendingEnv = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      { title: 'Pending Guard Check', sourceKind: 'standalone', sourceFileId: uninspectedFile.fileId },
      { actor: asUser(ownerA), orgId: orgA },
    );
    const inheritBypassClient = await appPool!.connect();
    try {
      await inheritBypassClient.query('BEGIN');
      await inheritBypassClient.query('SELECT ludy_kernel.enter_user_context($1::uuid, $2::text)', [
        orgA,
        mintContextToken(process.env.LUDY_CONTEXT_TOKEN_KEY ?? process.env.CROVE_CONTEXT_TOKEN_KEY ?? '', {
          userId: ownerA,
          orgId: orgA,
          sessionId: null,
          aal: 'aal1',
          mfaAt: null,
        }),
      ]);
      await inheritBypassClient.query("SELECT pg_catalog.set_config('crove.sign_template_inherit', $1, true)", [
        pendingEnv.envelopeId,
      ]);
      await expect(
        inheritBypassClient.query(
          "UPDATE ludy_sign.envelope SET inspect_status = 'passed', page_count = 1 WHERE org_id = $1 AND id = $2",
          [orgA, pendingEnv.envelopeId],
        ),
      ).rejects.toThrow(/ENVELOPE_SYSTEM_ONLY/);
    } finally {
      await inheritBypassClient.query('ROLLBACK').catch(() => {});
      inheritBypassClient.release();
    }

    // DB triggers also revoke an active direct link on raw tenant SQL status downgrade or extra non-CC role insert.
    const triggerFile = await ingestPdf(ownerA, orgA, 'trigger-a1');
    const triggerTpl = await runtime.execute<{ templateId: string }>(
      'sign.template.create',
      { title: 'Trigger A1 Check', routingMode: 'parallel', sourceFileId: triggerFile.fileId },
      { actor: asUser(ownerA), orgId: orgA },
    );
    await workerRuntime.execute(
      'sign.template.inspect_complete',
      {
        templateId: triggerTpl.templateId,
        outcome: 'passed',
        pageCount: 1,
        pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0 }],
      },
      { actor: asSystem('sign-worker'), orgId: orgA },
    );
    await runtime.execute(
      'sign.template.update',
      { templateId: triggerTpl.templateId, status: 'active' },
      { actor: asUser(ownerA), orgId: orgA },
    );
    await runtime.execute(
      'sign.template.roles_set',
      {
        templateId: triggerTpl.templateId,
        roles: [{ roleKey: 'r1', signerRole: 'signer', roleLabel: 'Signer', routingOrder: 1, deliveryMode: 'link', requireEmailOtp: false }],
      },
      { actor: asUser(ownerA), orgId: orgA },
    );
    await runtime.execute(
      'sign.template.direct_link_set',
      { templateId: triggerTpl.templateId, enabled: true },
      { actor: asUser(ownerA), orgId: orgA },
    );
    const trigClient = await appPool!.connect();
    try {
      await trigClient.query('BEGIN');
      await trigClient.query('SELECT ludy_kernel.enter_user_context($1::uuid, $2::text)', [
        orgA,
        mintContextToken(process.env.LUDY_CONTEXT_TOKEN_KEY ?? process.env.CROVE_CONTEXT_TOKEN_KEY ?? '', {
          userId: ownerA,
          orgId: orgA,
          sessionId: null,
          aal: 'aal1',
          mfaAt: null,
        }),
      ]);
      await trigClient.query("UPDATE ludy_sign.template SET status = 'draft' WHERE org_id = $1 AND id = $2", [
        orgA,
        triggerTpl.templateId,
      ]);
      await trigClient.query('COMMIT');
    } catch (e) {
      await trigClient.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      trigClient.release();
    }
    const revokedAfterRawStatus = await adminPool!.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM ludy_sign.template_direct_link WHERE org_id = $1 AND template_id = $2',
      [orgA, triggerTpl.templateId],
    );
    expect(revokedAfterRawStatus.rows[0]?.revoked_at).not.toBeNull();

    // CC recipient cannot request requireEmailOtp override on instantiate.
    await expect(
      runtime.execute(
        'sign.template.instantiate',
        {
          templateId: tpl.templateId,
          recipients: [
            { roleKey: 'r1', name: 'Anh Minh' },
            { roleKey: 'r2', name: 'Nguyen Van B' },
            { roleKey: 'cc1', name: 'Ke toan', email: 'kt@sign-tpl.test', deliveryMode: 'email', requireEmailOtp: true },
          ],
        },
        { actor: asUser(ownerA), orgId: orgA },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_INVALID_SIGNER', status: 422 });

    // Viewer cannot mutate; orgB cannot read orgA template.
    await expect(
      runtime.execute(
        'sign.template.create',
        { title: 'Viewer forbidden', routingMode: 'parallel', sourceFileId: file.fileId },
        { actor: asUser(viewerA), orgId: orgA },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(
      runtime.query('sign.template.get', { templateId: tpl.templateId }, { actor: asUser(ownerB), orgId: orgB }),
    ).rejects.toMatchObject({ code: 'SIGN_TEMPLATE_NOT_FOUND', status: 404 });

    // Also test cloning directly from an envelope (sourceEnvelopeId) inherits routingMode + org_purge of orgB.
    const clonedFromEnv = await runtime.execute<{ templateId: string; inspectStatus: string }>(
      'sign.template.create',
      {
        title: 'Tu ho so draft',
        sourceEnvelopeId: draftInst.envelopeId,
        copyRolesAndFields: true,
        status: 'active',
      },
      { actor: asUser(ownerA), orgId: orgA },
    );
    expect(clonedFromEnv.inspectStatus).toBe('passed');
    const clonedDetail = await runtime.query<{ template: { routingMode: string }; roles: unknown[]; fields: unknown[] }>(
      'sign.template.get',
      { templateId: clonedFromEnv.templateId },
      { actor: asUser(ownerA), orgId: orgA },
    );
    expect(clonedDetail.template.routingMode).toBe('sequential');
    expect(clonedDetail.roles).toHaveLength(3);
    expect(clonedDetail.fields).toHaveLength(1);
  });

  it('persists, inherits, and guards detected_tags_json across templates and envelopes (#3552)', async () => {
    const taggedFile = await ingestPdf(ownerA, orgA, 'tagged-contract-3552');
    const detectedTags = [
      {
        pageNumber: 1,
        fieldType: 'signature' as const,
        roleOrder: 1,
        roleKey: 'r1',
        required: true,
        label: null,
        xNorm: 0.14,
        yNorm: 0.72,
        wNorm: 0.22,
        hNorm: 0.06,
      },
      {
        pageNumber: 2,
        fieldType: 'text' as const,
        roleOrder: 2,
        roleKey: 'r2',
        required: false,
        label: 'Chuc danh',
        xNorm: 0.25,
        yNorm: 0.45,
        wNorm: 0.24,
        hNorm: 0.03,
      },
    ];

    const tpl = await runtime.execute<{ templateId: string }>(
      'sign.template.create',
      { title: 'Mau PDF co the van ban', routingMode: 'sequential', sourceFileId: taggedFile.fileId },
      { actor: asUser(ownerA), orgId: orgA },
    );

    await workerRuntime.execute(
      'sign.template.inspect_complete',
      {
        templateId: tpl.templateId,
        outcome: 'passed',
        pageCount: 2,
        pageDimensions: [
          { page: 1, widthPt: 595, heightPt: 842, rotation: 0 },
          { page: 2, widthPt: 595, heightPt: 842, rotation: 0 },
        ],
        detectedTags,
      },
      { actor: asSystem('sign-worker'), orgId: orgA },
    );

    const tplDetail = await runtime.query<{ template: { detectedTags: typeof detectedTags } }>(
      'sign.template.get',
      { templateId: tpl.templateId },
      { actor: asUser(ownerA), orgId: orgA },
    );
    expect(tplDetail.template.detectedTags).toEqual(detectedTags);

    // Reusing the same inspected sourceFileId on a second template preserves detectedTags cleanly under template_guard.
    const reusedTpl = await runtime.execute<{ templateId: string; inspectStatus: string }>(
      'sign.template.create',
      { title: 'Mau dung lai tep da kiem tra', routingMode: 'parallel', sourceFileId: taggedFile.fileId },
      { actor: asUser(ownerA), orgId: orgA },
    );
    expect(reusedTpl.inspectStatus).toBe('passed');
    const reusedDetail = await runtime.query<{ template: { detectedTags: typeof detectedTags } }>(
      'sign.template.get',
      { templateId: reusedTpl.templateId },
      { actor: asUser(ownerA), orgId: orgA },
    );
    expect(reusedDetail.template.detectedTags).toEqual(detectedTags);

    // Instantiating a draft envelope from the template inherits detected_tags_json via template_inherit_inspect
    // AND preserves roleKey on ludy_sign.signer even when r1 is routingOrder 2 and r2 is routingOrder 1.
    await runtime.execute(
      'sign.template.roles_set',
      {
        templateId: tpl.templateId,
        roles: [
          { roleKey: 'r2', signerRole: 'signer', roleLabel: 'Ben B ky truoc', routingOrder: 1, deliveryMode: 'link', requireEmailOtp: false },
          { roleKey: 'r1', signerRole: 'signer', roleLabel: 'Ben A ky sau', routingOrder: 2, deliveryMode: 'link', requireEmailOtp: false },
        ],
      },
      { actor: asUser(ownerA), orgId: orgA },
    );

    const inst = await runtime.execute<{ envelopeId: string }>(
      'sign.template.instantiate',
      {
        templateId: tpl.templateId,
        autoSend: false,
        recipients: [
          { roleKey: 'r1', name: 'Nguyen Van A' },
          { roleKey: 'r2', name: 'Tran Thi B' },
        ],
      },
      { actor: asUser(ownerA), orgId: orgA },
    );

    const envDetail = await runtime.query<{
      envelope: { inspectStatus: string; detectedTags: typeof detectedTags };
      signers: Array<{ name: string; roleKey: string | null; routingOrder: number }>;
    }>(
      'sign.envelope.get',
      { envelopeId: inst.envelopeId },
      { actor: asUser(ownerA), orgId: orgA },
    );
    expect(envDetail.envelope.inspectStatus).toBe('passed');
    expect(envDetail.envelope.detectedTags).toEqual(detectedTags);
    expect(envDetail.signers).toEqual([
      { ...envDetail.signers[0]!, name: 'Tran Thi B', roleKey: 'r2', routingOrder: 1 },
      { ...envDetail.signers[1]!, name: 'Nguyen Van A', roleKey: 'r1', routingOrder: 2 },
    ]);

    // Cloning a template back from that envelope preserves roleKey r2 (order 1) and r1 (order 2).
    const roundTripTpl = await runtime.execute<{ templateId: string }>(
      'sign.template.create',
      { title: 'Mau clone giu roleKey', sourceEnvelopeId: inst.envelopeId, copyRolesAndFields: true },
      { actor: asUser(ownerA), orgId: orgA },
    );
    const roundTripDetail = await runtime.query<{
      roles: Array<{ roleKey: string; routingOrder: number }>;
    }>('sign.template.get', { templateId: roundTripTpl.templateId }, { actor: asUser(ownerA), orgId: orgA });
    expect(roundTripDetail.roles.map((r) => [r.roleKey, r.routingOrder])).toEqual([
      ['r2', 1],
      ['r1', 2],
    ]);

    // Hyphenated and 40-char template roleKeys instantiate cleanly into ludy_sign.signer.role_key and pass zSignEnvelopeDetail.
    const longRoleKey = 'dai-dien-phap-luat-cong-ty-doi-tac-chien'; // 40 chars
    expect(longRoleKey).toHaveLength(40);
    await runtime.execute(
      'sign.template.roles_set',
      {
        templateId: roundTripTpl.templateId,
        roles: [
          { roleKey: 'ben-a', signerRole: 'signer', roleLabel: 'Ben A', routingOrder: 1, deliveryMode: 'link', requireEmailOtp: false },
          { roleKey: longRoleKey, signerRole: 'approver', roleLabel: 'Dai dien 40 ky tu', routingOrder: 2, deliveryMode: 'link', requireEmailOtp: false },
        ],
      },
      { actor: asUser(ownerA), orgId: orgA },
    );
    const hyphenInst = await runtime.execute<{ envelopeId: string }>(
      'sign.template.instantiate',
      {
        templateId: roundTripTpl.templateId,
        autoSend: false,
        recipients: [
          { roleKey: 'ben-a', name: 'Pham Minh C' },
          { roleKey: longRoleKey, name: 'Le Hoang D' },
        ],
      },
      { actor: asUser(ownerA), orgId: orgA },
    );
    const hyphenEnvRaw = await runtime.query('sign.envelope.get', { envelopeId: hyphenInst.envelopeId }, { actor: asUser(ownerA), orgId: orgA });
    const hyphenEnvParsed = zSignEnvelopeDetail.parse(hyphenEnvRaw);
    expect(hyphenEnvParsed.signers.map((s) => s.roleKey)).toEqual(['ben-a', longRoleKey]);

    // Direct tenant UPDATE of detected_tags_json on template or envelope is blocked by guard triggers.
    const client = await appPool!.connect();
    try {
      const token = mintContextToken(process.env.LUDY_CONTEXT_TOKEN_KEY ?? process.env.CROVE_CONTEXT_TOKEN_KEY ?? '', {
        userId: ownerA,
        orgId: orgA,
        sessionId: null,
        aal: 'aal1',
        mfaAt: null,
      });
      await client.query('BEGIN');
      await client.query('SELECT ludy_kernel.enter_user_context($1::uuid, $2::text)', [orgA, token]);
      await expect(
        client.query("UPDATE ludy_sign.template SET detected_tags_json = '[]'::jsonb WHERE org_id = $1 AND id = $2", [
          orgA,
          tpl.templateId,
        ]),
      ).rejects.toThrow(/SIGN_TEMPLATE_SYSTEM_ONLY/);
      await client.query('ROLLBACK');

      await client.query('BEGIN');
      await client.query('SELECT ludy_kernel.enter_user_context($1::uuid, $2::text)', [orgA, token]);
      await expect(
        client.query("UPDATE ludy_sign.envelope SET detected_tags_json = '[]'::jsonb WHERE org_id = $1 AND id = $2", [
          orgA,
          inst.envelopeId,
        ]),
      ).rejects.toThrow(/ENVELOPE_SYSTEM_ONLY/);
      await client.query('ROLLBACK');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  it('sends sign.completed copies to CC and link-mode recipients on standard envelopes while blocking unverified direct-link relays even after link pruning (#3774)', async () => {
    const ipHash = sha256Hex('198.51.100.77');
    const sealEnvelope = async (envelopeId: string) => {
      const sealedPdf = await ingestPdf(ownerA, orgA, `sealed-3774-${randomUUID()}`, 'sign_sealed');
      const certPdf = await ingestPdf(ownerA, orgA, `cert-3774-${randomUUID()}`, 'sign_certificate');
      await workerRuntime.execute(
        'sign.envelope.seal_complete',
        {
          envelopeId,
          outcome: 'sealed',
          certificateCode: generateCertificateCode(envelopeId, new Date().toISOString(), sealedPdf.sha256),
          sealedFileId: sealedPdf.fileId,
          certificateFileId: certPdf.fileId,
        },
        { actor: asSystem('sign-worker'), orgId: orgA },
      );
    };

    const completedRecipientsFor = async (envelopeId: string) => {
      const { rows } = await adminPool!.query<{ to_address: string; signer_count: number }>(
        `SELECT to_address, (payload->>'signerCount')::integer AS signer_count
         FROM ludy_kernel.mail_message
         WHERE org_id = $1 AND template_key = 'sign.completed' AND source_id = $2
         ORDER BY to_address ASC`,
        [orgA, envelopeId],
      );
      return rows;
    };

    // 1. Standard standalone envelope (direct_link_id IS NULL): link-mode CC, email-mode CC, and link-mode signer with email all get completion copies.
    const stdFile = await ingestPdf(ownerA, orgA, 'std-cc-completion-3774');
    const stdEnv = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      { title: 'Bien ban nghiem thu #3774', routingMode: 'parallel', sourceKind: 'standalone', sourceFileId: stdFile.fileId },
      { actor: asUser(ownerA), orgId: orgA },
    );
    await workerRuntime.execute(
      'sign.envelope.inspect_complete',
      {
        envelopeId: stdEnv.envelopeId,
        outcome: 'passed',
        pageCount: 1,
        pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0 }],
      },
      { actor: asSystem('sign-worker'), orgId: orgA },
    );
    const stdSigner = await runtime.execute<{ signerId: string }>(
      'sign.signer.add',
      {
        envelopeId: stdEnv.envelopeId,
        signerRole: 'signer',
        name: 'Khach ky qua Zalo',
        email: 'zalo-signer@sign-tpl.test',
        deliveryMode: 'link',
      },
      { actor: asUser(ownerA), orgId: orgA },
    );
    await runtime.execute(
      'sign.signer.add',
      {
        envelopeId: stdEnv.envelopeId,
        signerRole: 'cc',
        name: 'Ke toan luu ban sao (mac dinh link)',
        email: 'cc-link@sign-tpl.test',
      },
      { actor: asUser(ownerA), orgId: orgA },
    );
    await runtime.execute(
      'sign.signer.add',
      {
        envelopeId: stdEnv.envelopeId,
        signerRole: 'cc',
        name: 'Phap che luu ban sao (email)',
        email: 'cc-email@sign-tpl.test',
        deliveryMode: 'email',
      },
      { actor: asUser(ownerA), orgId: orgA },
    );
    await runtime.execute(
      'sign.signer.add',
      {
        envelopeId: stdEnv.envelopeId,
        signerRole: 'cc',
        name: 'CC khong co email',
        deliveryMode: 'link',
      },
      { actor: asUser(ownerA), orgId: orgA },
    );
    const stdFields = await runtime.execute<{ fieldIds: string[] }>(
      'sign.field.set',
      {
        envelopeId: stdEnv.envelopeId,
        fields: [
          {
            signerId: stdSigner.signerId,
            fieldType: 'signature',
            pageNumber: 1,
            xNorm: 0.1,
            yNorm: 0.7,
            wNorm: 0.3,
            hNorm: 0.08,
            required: true,
          },
        ],
      },
      { actor: asUser(ownerA), orgId: orgA },
    );
    const stdSent = await runtime.execute<{ links: Array<{ token: string }> }>(
      'sign.envelope.send',
      { envelopeId: stdEnv.envelopeId },
      { actor: asUser(ownerA), orgId: orgA },
    );
    await runtime.orgless(async (db) => {
      await sql`
        SELECT ludy_sign.public_submit(
          ${hashSigningToken(stdSent.links[0]!.token)},
          true,
          'draw',
          NULL,
          ${JSON.stringify([{ fieldId: stdFields.fieldIds[0]!, signaturePngBase64: VALID_PNG_BASE64 }])}::jsonb,
          ${ipHash},
          'CCCompletionTest/1.0',
          ${DEFAULT_MESSAGE_ID_DOMAIN}
        )
      `.execute(db);
    });
    await sealEnvelope(stdEnv.envelopeId);

    const { rows: stdEnvRow } = await adminPool!.query<{ direct_link_id: string | null }>(
      'SELECT direct_link_id FROM ludy_sign.envelope WHERE org_id = $1 AND id = $2',
      [orgA, stdEnv.envelopeId],
    );
    expect(stdEnvRow[0]?.direct_link_id).toBeNull();

    const stdMails = await completedRecipientsFor(stdEnv.envelopeId);
    expect(stdMails.map((r) => r.to_address)).toEqual([
      'cc-email@sign-tpl.test',
      'cc-link@sign-tpl.test',
      'ownera@sign-tpl.test',
      'zalo-signer@sign-tpl.test',
    ]);
    expect(stdMails.every((r) => r.signer_count === 1)).toBe(true);

    // 2. Template-instantiated envelope (direct_link_id IS NULL) vs direct-link envelopes on the same template.
    const tplFile = await ingestPdf(ownerA, orgA, 'tpl-cc-completion-3774');
    const tpl = await runtime.execute<{ templateId: string }>(
      'sign.template.create',
      { title: 'Mau NDA co CC #3774', routingMode: 'parallel', sourceFileId: tplFile.fileId },
      { actor: asUser(ownerA), orgId: orgA },
    );
    await workerRuntime.execute(
      'sign.template.inspect_complete',
      {
        templateId: tpl.templateId,
        outcome: 'passed',
        pageCount: 1,
        pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0 }],
      },
      { actor: asSystem('sign-worker'), orgId: orgA },
    );
    await runtime.execute(
      'sign.template.roles_set',
      {
        templateId: tpl.templateId,
        roles: [
          { roleKey: 'r1', signerRole: 'signer', roleLabel: 'Doi tac', routingOrder: 1, deliveryMode: 'link', requireEmailOtp: false },
          { roleKey: 'cc1', signerRole: 'cc', roleLabel: 'Hanh chinh', routingOrder: 2, deliveryMode: 'link', requireEmailOtp: false },
        ],
      },
      { actor: asUser(ownerA), orgId: orgA },
    );
    await runtime.execute(
      'sign.template.fields_set',
      {
        templateId: tpl.templateId,
        fields: [{ roleKey: 'r1', fieldType: 'signature', pageNumber: 1, xNorm: 0.15, yNorm: 0.72, wNorm: 0.3, hNorm: 0.08, required: true }],
      },
      { actor: asUser(ownerA), orgId: orgA },
    );
    await runtime.execute(
      'sign.template.update',
      { templateId: tpl.templateId, status: 'active' },
      { actor: asUser(ownerA), orgId: orgA },
    );

    const instSent = await runtime.execute<{ envelopeId: string; links: Array<{ token: string }> }>(
      'sign.template.instantiate',
      {
        templateId: tpl.templateId,
        autoSend: true,
        recipients: [
          { roleKey: 'r1', name: 'Doi tac A', email: 'inst-signer@sign-tpl.test' },
          { roleKey: 'cc1', name: 'Phong Hanh chinh', email: 'inst-cc@sign-tpl.test' },
        ],
      },
      { actor: asUser(ownerA), orgId: orgA },
    );
    const instTokenHash = hashSigningToken(instSent.links[0]!.token);
    const instView = await runtime.orgless(async (db) => {
      const { rows } = await sql<{ v: { fields: Array<{ id: string }> } }>`
        SELECT ludy_sign.public_record_view(${instTokenHash}, ${ipHash}, 'InstTest/1.0') AS v
      `.execute(db);
      return rows[0]!.v;
    });
    await runtime.orgless(async (db) => {
      await sql`
        SELECT ludy_sign.public_submit(
          ${instTokenHash},
          true,
          'draw',
          NULL,
          ${JSON.stringify([{ fieldId: instView.fields[0]!.id, signaturePngBase64: VALID_PNG_BASE64 }])}::jsonb,
          ${ipHash},
          'InstTest/1.0',
          ${DEFAULT_MESSAGE_ID_DOMAIN}
        )
      `.execute(db);
    });
    await sealEnvelope(instSent.envelopeId);

    const instMails = await completedRecipientsFor(instSent.envelopeId);
    expect(instMails.map((r) => r.to_address)).toEqual([
      'inst-cc@sign-tpl.test',
      'inst-signer@sign-tpl.test',
      'ownera@sign-tpl.test',
    ]);

    // 3. Direct-link envelope (direct_link_id IS NOT NULL, requireEmailOtp = false): unverified typed email gets ZERO mail (N1(a)).
    const directLink = await runtime.execute<{ token: string | null }>(
      'sign.template.direct_link_set',
      { templateId: tpl.templateId, enabled: true, requireEmailOtp: false },
      { actor: asUser(ownerA), orgId: orgA },
    );
    const directTokenHash = hashSigningToken(directLink.token!);

    const startAndCompleteUnverifiedDirect = async (victimEmail: string): Promise<string> => {
      const signingTokenHash = hashSigningToken(generateRawSigningToken());
      const started = await runtime.orgless(async (db) => {
        const { rows } = await sql<{ v: { status: string; envelopeId: string } }>`
          SELECT ludy_sign.public_direct_start(
            ${directTokenHash},
            'Anonymous Caller',
            ${victimEmail},
            NULL,
            ${signingTokenHash},
            ${ipHash},
            'RelayCheck/1.0'
          ) AS v
        `.execute(db);
        return rows[0]!.v;
      });
      expect(started.status).toBe('ok');
      const view = await runtime.orgless(async (db) => {
        const { rows } = await sql<{ v: { fields: Array<{ id: string }> } }>`
          SELECT ludy_sign.public_record_view(${signingTokenHash}, ${ipHash}, 'RelayCheck/1.0') AS v
        `.execute(db);
        return rows[0]!.v;
      });
      await runtime.orgless(async (db) => {
        await sql`
          SELECT ludy_sign.public_submit(
            ${signingTokenHash},
            true,
            'draw',
            NULL,
            ${JSON.stringify([{ fieldId: view.fields[0]!.id, signaturePngBase64: VALID_PNG_BASE64 }])}::jsonb,
            ${ipHash},
            'RelayCheck/1.0',
            ${DEFAULT_MESSAGE_ID_DOMAIN}
          )
        `.execute(db);
      });
      return started.envelopeId;
    };

    const directEnvId = await startAndCompleteUnverifiedDirect('unverified-victim@sign-tpl.test');
    const { rows: directEnvBefore } = await adminPool!.query<{ direct_link_id: string | null }>(
      'SELECT direct_link_id FROM ludy_sign.envelope WHERE org_id = $1 AND id = $2',
      [orgA, directEnvId],
    );
    expect(directEnvBefore[0]?.direct_link_id).not.toBeNull();

    await sealEnvelope(directEnvId);
    const directMails = await completedRecipientsFor(directEnvId);
    expect(directMails.map((r) => r.to_address)).toEqual(['ownera@sign-tpl.test']);

    // 4. Defense in depth: even if the revoked template_direct_link row is pruned (ON DELETE SET NULL on direct_link_id),
    // sealing still recognizes the genesis direct-link event and sends ZERO mail to the unverified email.
    const prunedDirectEnvId = await startAndCompleteUnverifiedDirect('pruned-victim@sign-tpl.test');
    await runtime.execute(
      'sign.template.direct_link_set',
      { templateId: tpl.templateId, enabled: false },
      { actor: asUser(ownerA), orgId: orgA },
    );

    const adminClient = await adminPool!.connect();
    try {
      await adminClient.query('BEGIN');
      await adminClient.query('SET LOCAL session_replication_role = replica');
      await adminClient.query(
        `UPDATE ludy_sign.template_direct_link
         SET revoked_at = now() - interval '35 days'
         WHERE org_id = $1 AND template_id = $2`,
        [orgA, tpl.templateId],
      );
      await adminClient.query('COMMIT');
    } finally {
      await adminClient.query('ROLLBACK').catch(() => {});
      adminClient.release();
    }

    const cleanupRes = await workerRuntime.execute<{ directLinks?: number }>(
      'sign.org.cleanup',
      {},
      { actor: asSystem('sign-worker'), orgId: orgA },
    );
    expect(cleanupRes.directLinks).toBeGreaterThanOrEqual(1);

    const { rows: prunedEnvRow } = await adminPool!.query<{ direct_link_id: string | null }>(
      'SELECT direct_link_id FROM ludy_sign.envelope WHERE org_id = $1 AND id = $2',
      [orgA, prunedDirectEnvId],
    );
    expect(prunedEnvRow[0]?.direct_link_id).toBeNull();

    await sealEnvelope(prunedDirectEnvId);
    const prunedMails = await completedRecipientsFor(prunedDirectEnvId);
    expect(prunedMails.map((r) => r.to_address)).toEqual(['ownera@sign-tpl.test']);
  });

  it('purges templates, roles, fields, and direct links on org_purge', async () => {
    const fileB = await ingestPdf(ownerB, orgB, 'orgb-purge-tpl');
    const tplB = await runtime.execute<{ templateId: string }>(
      'sign.template.create',
      { title: 'Mau B', routingMode: 'parallel', sourceFileId: fileB.fileId },
      { actor: asUser(ownerB), orgId: orgB },
    );
    await workerRuntime.execute(
      'sign.template.inspect_complete',
      {
        templateId: tplB.templateId,
        outcome: 'passed',
        pageCount: 1,
        pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0 }],
      },
      { actor: asSystem('sign-worker'), orgId: orgB },
    );
    await runtime.execute(
      'sign.template.update',
      { templateId: tplB.templateId, status: 'active' },
      { actor: asUser(ownerB), orgId: orgB },
    );
    await runtime.execute(
      'sign.template.roles_set',
      {
        templateId: tplB.templateId,
        roles: [{ roleKey: 'r1', signerRole: 'signer', roleLabel: 'Ky', routingOrder: 1, deliveryMode: 'link', requireEmailOtp: false }],
      },
      { actor: asUser(ownerB), orgId: orgB },
    );
    await runtime.execute(
      'sign.template.direct_link_set',
      { templateId: tplB.templateId, enabled: true },
      { actor: asUser(ownerB), orgId: orgB },
    );

    const adminClient = await adminPool!.connect();
    try {
      await adminClient.query('BEGIN');
      await adminClient.query('SET LOCAL session_replication_role = replica');
      await adminClient.query("UPDATE ludy_kernel.tenant SET status = 'offboarding' WHERE org_id = $1", [orgB]);
      await adminClient.query(
        `INSERT INTO ludy_kernel.audit_event (org_id, occurred_at, actor_type, actor_id, command, command_id, outcome, input_sha256, detail)
         VALUES ($1, $2, 'user', $3, 'kernel.org.offboard', $4, 'ok', $5, '{}'::jsonb),
                ($1, $6, 'system', NULL, 'kernel.org.export.record', $7, 'ok', $5, '{"format":"crove.org-export.v2","file_count":1}'::jsonb)`,
        [
          orgB,
          new Date(Date.now() - 40 * 86_400_000),
          ownerB,
          randomUUID(),
          '0'.repeat(64),
          new Date(Date.now() - 31 * 86_400_000),
          randomUUID(),
        ],
      );
      await adminClient.query('COMMIT');

      await adminClient.query('BEGIN');
      await adminClient.query('SELECT ludy_kernel.enter_system_context($1::uuid)', [orgB]);
      const purgeRes = await adminClient.query<{ outcome: string }>(
        'SELECT outcome FROM ludy_kernel.org_purge(30)',
      );
      await adminClient.query('COMMIT');
      expect(purgeRes.rows[0]?.outcome).toBe('ok');
    } finally {
      await adminClient.query('ROLLBACK').catch(() => {});
      adminClient.release();
    }

    for (const tbl of ['ludy_sign.template', 'ludy_sign.template_role', 'ludy_sign.template_field', 'ludy_sign.template_direct_link']) {
      const left = await adminPool!.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${tbl} WHERE org_id = $1`, [orgB]);
      expect(Number(left.rows[0]!.count), tbl).toBe(0);
    }
  });

  it('clamps ludy_sign.public_direct_start token expires_at at 720 hours on legacy templates with >720h expires_in_hours (#4270)', async () => {
    const tplFile = await ingestPdf(ownerA, orgA, 'legacy-tpl-8760h');
    const tpl = await runtime.execute<{ templateId: string }>(
      'sign.template.create',
      { title: 'Legacy 365d Direct Template', sourceFileId: tplFile.fileId, routingMode: 'parallel' },
      { actor: asUser(ownerA), orgId: orgA },
    );
    await workerRuntime.execute(
      'sign.template.inspect_complete',
      {
        templateId: tpl.templateId,
        outcome: 'passed',
        pageCount: 1,
        pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0 }],
      },
      { actor: asSystem('sign-worker'), orgId: orgA },
    );
    await runtime.execute(
      'sign.template.roles_set',
      {
        templateId: tpl.templateId,
        roles: [
          {
            roleKey: 'r1',
            signerRole: 'signer',
            roleLabel: 'Ben ky',
            routingOrder: 1,
            deliveryMode: 'link',
            requireEmailOtp: false,
          },
        ],
      },
      { actor: asUser(ownerA), orgId: orgA },
    );
    await runtime.execute(
      'sign.template.fields_set',
      {
        templateId: tpl.templateId,
        fields: [
          {
            roleKey: 'r1',
            fieldType: 'signature',
            pageNumber: 1,
            xNorm: 0.2,
            yNorm: 0.7,
            wNorm: 0.25,
            hNorm: 0.08,
            required: true,
          },
        ],
      },
      { actor: asUser(ownerA), orgId: orgA },
    );
    await runtime.execute('sign.template.update', { templateId: tpl.templateId, status: 'active' }, { actor: asUser(ownerA), orgId: orgA });

    // Simulate a legacy template row carrying 8760h (365d) expires_in_hours and a direct link expiring in 1 year.
    await adminPool!.query(
      `UPDATE ludy_sign.template SET expires_in_hours = 8760 WHERE org_id = $1::uuid AND id = $2::uuid`,
      [orgA, tpl.templateId],
    );
    const direct = await runtime.execute<{ token: string | null }>(
      'sign.template.direct_link_set',
      {
        templateId: tpl.templateId,
        enabled: true,
        requireEmailOtp: false,
        expiresAt: new Date(Date.now() + 365 * 24 * 3_600_000).toISOString(),
      },
      { actor: asUser(ownerA), orgId: orgA },
    );

    const started = await runtime.orgless(async (db) => {
      const { rows } = await sql<{ v: { status: string; signingTokenId: string; envelopeId: string; expiresAt: string } }>`
        SELECT ludy_sign.public_direct_start(
          ${hashSigningToken(direct.token!)},
          'Legacy Direct Caller',
          NULL,
          NULL,
          ${hashSigningToken(generateRawSigningToken())},
          NULL,
          'ClampCheck/1.0'
        ) AS v
      `.execute(db);
      return rows[0]!.v;
    });
    expect(started.status).toBe('ok');

    const { rows: checkRows } = await adminPool!.query<{ diff_hours: number }>(
      `SELECT EXTRACT(EPOCH FROM (st.expires_at - e.created_at)) / 3600.0 AS diff_hours
       FROM ludy_sign.signing_token st
       JOIN ludy_sign.envelope e ON e.org_id = st.org_id AND e.id = st.envelope_id
       WHERE st.org_id = $1::uuid AND st.id = $2::uuid`,
      [orgA, started.signingTokenId],
    );
    expect(Number(checkRows[0]!.diff_hours)).toBeGreaterThan(719);
    expect(Number(checkRows[0]!.diff_hours)).toBeLessThanOrEqual(720);
  });
});
