// SPDX-License-Identifier: AGPL-3.0-only
// PostgreSQL 17 integration & security tests for eSign Slice 2a (#3526):
//   - Template CRUD, PDF inspection handoff & reuse, and sourceEnvelopeId cloning
//   - Approver / CC / Signer role presets, field validation, and role-key swapping
//   - One-click envelope instantiation (draft & atomic autoSend) preserving envelope_guard integrity
//   - A1 single non-CC role Direct Signing Link enable/OTP/rotate/revoke & org_app_on('sign') checks
//   - Cross-tenant RLS isolation, viewer read-only enforcement, machinery grant denial, and org purge
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import {
  createOrg,
  kernelCommands,
  kernelManifest,
  kernelQueries,
  upsertIdentity,
} from '@crove/kernel';
import { Runtime, contentGeneration, fileKey, mintContextToken, sha256Hex } from '@crove/kernel-runtime';
import {
  SIGN_DIRECT_PAGE_PATH,
  SIGN_TOKEN_PATTERN,
  zSignEnvelopeDetail,
} from '@crove/kernel-contract';
import {
  hashSigningToken,
  signCommands,
  signManifest,
  signQueries,
} from '../src/index.ts';

type Pool = ReturnType<typeof createPool>;

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('eSign Slice 2a reusable templates, roles & direct signing links on PostgreSQL 17 (#3526)', () => {
  const dbName = `crove_test_sign_tpl_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

  async function ingestPdf(actorUserId: string, orgId: string, tag: string): Promise<{ fileId: string; sha256: string; storageKey: string; generation: string }> {
    const bytes = Uint8Array.from(
      Buffer.from(`%PDF-1.4\n% sign-tpl-${tag}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n`, 'utf8'),
    );
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(orgId, sha256);
    const generation = contentGeneration(sha256);
    const { fileId } = await runtime.execute<{ fileId: string }>(
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
      { actor: asUser(actorUserId), orgId },
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
    await setRolePasswords(adminUrl, { crove_app: 'tpl-app-pw', crove_worker: 'tpl-worker-pw' });

    const loginUrl = (user: string, pw: string) => {
      const u = new URL(adminUrl);
      u.username = user;
      u.password = pw;
      return u.toString();
    };

    adminPool = createPool({ connectionString: adminUrl, max: 2 });
    appPool = createPool({ connectionString: loginUrl('crove_app', 'tpl-app-pw'), max: 6 });
    workerPool = createPool({ connectionString: loginUrl('crove_worker', 'tpl-worker-pw'), max: 3 });

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
      "INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1::uuid, $2::uuid, 'viewer')",
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
      "SELECT type FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'sign.template.inspect_queued'",
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
      'SELECT token_sha256, enabled, require_email_otp, revoked_at FROM crove_sign.template_direct_link WHERE org_id = $1 AND template_id = $2',
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
      'SELECT token_sha256, revoked_at FROM crove_sign.template_direct_link WHERE org_id = $1 AND template_id = $2 ORDER BY created_at ASC',
      [orgA, tpl.templateId],
    );
    expect(afterRotate.rows).toHaveLength(2);
    expect(afterRotate.rows[0]!.revoked_at).not.toBeNull();
    expect(afterRotate.rows[1]!.revoked_at).toBeNull();
    expect(afterRotate.rows[1]!.token_sha256).toBe(hashSigningToken(rotated.token!));

    // App disabled in SQL definer fails closed (org_app_on check).
    await adminPool!.query("UPDATE crove_kernel.tenant SET apps_off = ARRAY['sign'] WHERE org_id = $1", [orgA]);
    const c = await appPool!.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [
        orgA,
        mintContextToken(process.env.CROVE_CONTEXT_TOKEN_KEY ?? '', {
          userId: ownerA,
          orgId: orgA,
          sessionId: null,
          aal: 'aal1',
          mfaAt: null,
        }),
      ]);
      await expect(
        c.query('SELECT crove_sign.template_direct_link_set($1::uuid, true, false, $2)', [
          tpl.templateId,
          'f'.repeat(64),
        ]),
      ).rejects.toThrow(/SIGN_APP_DISABLED/);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
      await adminPool!.query("UPDATE crove_kernel.tenant SET apps_off = '{}' WHERE org_id = $1", [orgA]);
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
      'SELECT id FROM crove_sign.template_direct_link WHERE org_id = $1 AND template_id = $2 AND revoked_at IS NULL',
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
    ).rejects.toThrow(/signature field/i);

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
        await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [
          orgA,
          mintContextToken(process.env.CROVE_CONTEXT_TOKEN_KEY ?? '', {
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
      `INSERT INTO crove_sign.envelope (org_id, title, source_file_id, source_storage_key, source_generation, source_sha256, inspect_status, created_by)
       VALUES ($1, 'Forged', $2, $3, $4, $5, 'passed', $6)`,
      [orgA, file.fileId, file.storageKey, file.generation, file.sha256, ownerA],
      /ENVELOPE_FORBIDDEN/,
    );
    await expectTenantSqlRejects(
      "UPDATE crove_sign.template SET inspect_status = 'failed' WHERE org_id = $1 AND id = $2",
      [orgA, tpl.templateId],
      /SIGN_TEMPLATE_SYSTEM_ONLY/,
    );
    await expectTenantSqlRejects(
      'SELECT * FROM crove_sign.template_direct_link WHERE org_id = $1',
      [orgA],
      /permission denied/,
    );
    const uninspectedFile = await ingestPdf(ownerA, orgA, 'forge-uninspected');
    await expectTenantSqlRejects(
      `INSERT INTO crove_sign.template (org_id, title, source_file_id, source_storage_key, source_generation, source_sha256, inspect_status, page_count, status, created_by)
       VALUES ($1, 'Forged Passed', $2, $3, $4, $5, 'passed', 1, 'active', $6)`,
      [orgA, uninspectedFile.fileId, uninspectedFile.storageKey, uninspectedFile.generation, uninspectedFile.sha256, ownerA],
      /SIGN_TEMPLATE_SYSTEM_ONLY/,
    );
    await expectTenantSqlRejects(
      `INSERT INTO crove_sign.template (org_id, title, source_file_id, source_storage_key, source_generation, source_sha256, inspect_status, created_by)
       VALUES ($1, 'Forged Failed', $2, $3, $4, $5, 'failed', $6)`,
      [orgA, uninspectedFile.fileId, uninspectedFile.storageKey, uninspectedFile.generation, uninspectedFile.sha256, ownerA],
      /SIGN_TEMPLATE_SYSTEM_ONLY/,
    );
    await expectTenantSqlRejects(
      'SELECT * FROM crove_sign.template_work_recovery_candidates(pg_catalog.now(), 10, NULL)',
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
      await inheritBypassClient.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [
        orgA,
        mintContextToken(process.env.CROVE_CONTEXT_TOKEN_KEY ?? '', {
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
          "UPDATE crove_sign.envelope SET inspect_status = 'passed', page_count = 1 WHERE org_id = $1 AND id = $2",
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
      await trigClient.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [
        orgA,
        mintContextToken(process.env.CROVE_CONTEXT_TOKEN_KEY ?? '', {
          userId: ownerA,
          orgId: orgA,
          sessionId: null,
          aal: 'aal1',
          mfaAt: null,
        }),
      ]);
      await trigClient.query("UPDATE crove_sign.template SET status = 'draft' WHERE org_id = $1 AND id = $2", [
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
      'SELECT revoked_at FROM crove_sign.template_direct_link WHERE org_id = $1 AND template_id = $2',
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
    // AND preserves roleKey on crove_sign.signer even when r1 is routingOrder 2 and r2 is routingOrder 1.
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

    // Hyphenated and 40-char template roleKeys instantiate cleanly into crove_sign.signer.role_key and pass zSignEnvelopeDetail.
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
      const token = mintContextToken(process.env.CROVE_CONTEXT_TOKEN_KEY ?? '', {
        userId: ownerA,
        orgId: orgA,
        sessionId: null,
        aal: 'aal1',
        mfaAt: null,
      });
      await client.query('BEGIN');
      await client.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgA, token]);
      await expect(
        client.query("UPDATE crove_sign.template SET detected_tags_json = '[]'::jsonb WHERE org_id = $1 AND id = $2", [
          orgA,
          tpl.templateId,
        ]),
      ).rejects.toThrow(/SIGN_TEMPLATE_SYSTEM_ONLY/);
      await client.query('ROLLBACK');

      await client.query('BEGIN');
      await client.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgA, token]);
      await expect(
        client.query("UPDATE crove_sign.envelope SET detected_tags_json = '[]'::jsonb WHERE org_id = $1 AND id = $2", [
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
      await adminClient.query("UPDATE crove_kernel.tenant SET status = 'offboarding' WHERE org_id = $1", [orgB]);
      await adminClient.query(
        `INSERT INTO crove_kernel.audit_event (org_id, occurred_at, actor_type, actor_id, command, command_id, outcome, input_sha256, detail)
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
      await adminClient.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgB]);
      const purgeRes = await adminClient.query<{ outcome: string }>(
        'SELECT outcome FROM crove_kernel.org_purge(30)',
      );
      await adminClient.query('COMMIT');
      expect(purgeRes.rows[0]?.outcome).toBe('ok');
    } finally {
      await adminClient.query('ROLLBACK').catch(() => {});
      adminClient.release();
    }

    for (const tbl of ['crove_sign.template', 'crove_sign.template_role', 'crove_sign.template_field', 'crove_sign.template_direct_link']) {
      const left = await adminPool!.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${tbl} WHERE org_id = $1`, [orgB]);
      expect(Number(left.rows[0]!.count), tbl).toBe(0);
    }
  });
});
