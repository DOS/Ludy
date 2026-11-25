// SPDX-License-Identifier: AGPL-3.0-only
// Self-contained PostgreSQL 17 security invariants for eSign Slice 2b A4 (#3553, owner decisions 2026-11-08 & 2026-11-17):
//   - Strict owner / admin / created_by confidentiality on source_kind = 'hr_contract' envelopes
//   - Zero existence oracle (identical 404) across get / events / verify / ai_analysis / mutations / file downloads
//   - Identical enforcement whether AI is enabled or stopped, and zero visibility to agent contexts
//   - Full system worker and public signing ceremony compatibility (inspect, AI record, sign, seal, mail, sweep, cleanup)
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate } from '@ludy/db/migrate';
import {
  DEFAULT_MESSAGE_ID_DOMAIN,
  createOrg,
  kernelCommands,
  kernelManifest,
  kernelQueries,
  upsertIdentity,
} from '@ludy/kernel';
import { contentGeneration, fileKey, mintContextToken, Runtime, sha256Hex } from '@ludy/kernel-runtime';
import {
  generateCertificateCode,
  generateRawSigningToken,
  hashSigningToken,
  signAiCommands,
  signAiQueries,
  signCommands,
  signManifest,
  signQueries,
} from '../../src/index.ts';
import { resolveDbIdentifiers, roleUrl, setActiveRolePasswords, wrapPool } from './fixtures/db-identifiers.ts';

type Pool = ReturnType<typeof createPool>;

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
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

suite('eSign HR contract envelope confidentiality invariants (#3553, A4)', () => {
  const dbName = `crove_test_sign_hr_inv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let adminPool: Pool | undefined;
  let appPool: Pool | undefined;
  let workerPool: Pool | undefined;
  let runtime: Runtime;
  let workerRuntime: Runtime;

  let orgId = '';
  let otherOrgId = '';
  let ownerId = '';
  let adminId = '';
  let creatorDemotedId = '';
  let memberId = '';
  let viewerId = '';
  let otherOwnerId = '';

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asSystem = (component: string) => ({ type: 'system' as const, component });
  const ipHash = sha256Hex('203.0.113.77');

  async function ingestSignFile(
    actor: { type: 'user'; userId: string; aal: 'aal1' } | { type: 'system'; component: string },
    targetOrgId: string,
    tag: string,
    source: 'sign_document' | 'sign_sealed' | 'sign_certificate' = 'sign_document',
    contentType = 'application/pdf',
  ): Promise<{ fileId: string; sha256: string }> {
    const body =
      source === 'sign_certificate'
        ? JSON.stringify({ tag, issuedAt: '2026-11-17T08:00:00.000Z' })
        : `%PDF-1.4\n% hr-inv-${tag}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n`;
    const bytes = Uint8Array.from(Buffer.from(body, 'utf8'));
    const sha256 = sha256Hex(bytes);
    const runner = actor.type === 'system' ? workerRuntime : runtime;
    const { fileId } = await runner.execute<{ fileId: string }>(
      'kernel.file.ingest',
      {
        filename: source === 'sign_certificate' ? `${tag}.json` : `${tag}.pdf`,
        contentType,
        sizeBytes: bytes.byteLength,
        sha256,
        storageKey: fileKey(targetOrgId, sha256),
        generation: contentGeneration(sha256),
        source,
      },
      { actor, orgId: targetOrgId },
    );
    return { fileId, sha256 };
  }

  beforeAll(async () => {
    const rootPool = createPool({ connectionString: ADMIN as string, max: 1 });
    await rootPool.query(`CREATE DATABASE ${dbName}`);
    await rootPool.end();

    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();

    await migrate({ adminUrl, dir: MIGRATIONS });
    const ids = await resolveDbIdentifiers(adminUrl);
    await setActiveRolePasswords(adminUrl, { crove_app: 'hr-inv-app-pw', crove_worker: 'hr-inv-worker-pw' }, ids);

    adminPool = wrapPool(createPool({ connectionString: adminUrl, max: 2 }), ids);
    appPool = wrapPool(createPool({ connectionString: roleUrl(adminUrl, 'crove_app', 'hr-inv-app-pw', ids), max: 6 }), ids);
    workerPool = wrapPool(createPool({ connectionString: roleUrl(adminUrl, 'crove_worker', 'hr-inv-worker-pw', ids), max: 3 }), ids);

    const manifests = [kernelManifest.tables, signManifest.tables];
    const appDb = createDb(appPool);
    const workerDb = createDb(workerPool);

    runtime = new Runtime(appDb, { manifests })
      .register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) })
      .register({ commands: [...signCommands, ...signAiCommands], queries: [...signQueries, ...signAiQueries] });

    workerRuntime = new Runtime(workerDb, { manifests })
      .register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) })
      .register({ commands: [...signCommands, ...signAiCommands], queries: [...signQueries, ...signAiQueries] });

    ownerId = await upsertIdentity(appDb, {
      issuer: 'hr-sign-inv',
      subject: 'owner',
      email: 'owner@hr-sign.test',
      name: 'Org Owner',
    });
    adminId = await upsertIdentity(appDb, {
      issuer: 'hr-sign-inv',
      subject: 'admin',
      email: 'admin@hr-sign.test',
      name: 'HR Admin',
    });
    creatorDemotedId = await upsertIdentity(appDb, {
      issuer: 'hr-sign-inv',
      subject: 'creator-demoted',
      email: 'creator@hr-sign.test',
      name: 'Former Admin Creator',
    });
    memberId = await upsertIdentity(appDb, {
      issuer: 'hr-sign-inv',
      subject: 'member',
      email: 'member@hr-sign.test',
      name: 'Ordinary Member',
    });
    viewerId = await upsertIdentity(appDb, {
      issuer: 'hr-sign-inv',
      subject: 'viewer',
      email: 'viewer@hr-sign.test',
      name: 'Org Viewer',
    });
    otherOwnerId = await upsertIdentity(appDb, {
      issuer: 'hr-sign-inv',
      subject: 'other-owner',
      email: 'other@hr-sign.test',
      name: 'Other Org Owner',
    });

    orgId = (await createOrg(runtime, asUser(ownerId), 'Cong ty Nhan su A')).orgId;
    otherOrgId = (await createOrg(runtime, asUser(otherOwnerId), 'Cong ty Nhan su B')).orgId;

    await adminPool.query(
      `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role)
       VALUES ($1::uuid, $2::uuid, 'admin'),
              ($1::uuid, $3::uuid, 'admin'),
              ($1::uuid, $4::uuid, 'member'),
              ($1::uuid, $5::uuid, 'viewer')`,
      [orgId, adminId, creatorDemotedId, memberId, viewerId],
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

  it('restricts hr_contract creation and template instantiation to owner and admin, blocking member/viewer', async () => {
    const { fileId: memberFile } = await ingestSignFile(asUser(memberId), orgId, `member-attempt-${randomUUID()}`);
    const contractSourceId = randomUUID();

    await expect(
      runtime.execute(
        'sign.envelope.create',
        {
          title: 'Unauthorized HR Contract',
          sourceKind: 'hr_contract',
          sourceId: contractSourceId,
          sourceFileId: memberFile,
        },
        { actor: asUser(memberId), orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_FORBIDDEN', status: 403 });

    await expect(
      runtime.execute(
        'sign.envelope.create',
        {
          title: 'Viewer HR Contract',
          sourceKind: 'hr_contract',
          sourceId: contractSourceId,
          sourceFileId: memberFile,
        },
        { actor: asUser(viewerId), orgId },
      ),
    ).rejects.toMatchObject({ status: 403 });

    const { fileId: tplFile } = await ingestSignFile(asUser(ownerId), orgId, `hr-tpl-${randomUUID()}`);
    const tpl = await runtime.execute<{ templateId: string }>(
      'sign.template.create',
      { title: 'Standard Contract Template', sourceFileId: tplFile },
      { actor: asUser(ownerId), orgId },
    );
    await workerRuntime.execute(
      'sign.template.inspect_complete',
      {
        templateId: tpl.templateId,
        outcome: 'passed',
        pageCount: 1,
        pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0 }],
      },
      { actor: asSystem('sign-worker'), orgId },
    );
    await runtime.execute(
      'sign.template.roles_set',
      {
        templateId: tpl.templateId,
        roles: [
          {
            roleKey: 'r1',
            signerRole: 'signer',
            roleLabel: 'Employee',
            routingOrder: 1,
            deliveryMode: 'link',
            requireEmailOtp: false,
          },
        ],
      },
      { actor: asUser(ownerId), orgId },
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
            xNorm: 0.1,
            yNorm: 0.7,
            wNorm: 0.25,
            hNorm: 0.08,
            required: true,
          },
        ],
      },
      { actor: asUser(ownerId), orgId },
    );
    await runtime.execute(
      'sign.template.update',
      { templateId: tpl.templateId, status: 'active' },
      { actor: asUser(ownerId), orgId },
    );

    await expect(
      runtime.execute(
        'sign.template.instantiate',
        {
          templateId: tpl.templateId,
          sourceKind: 'hr_contract',
          sourceId: contractSourceId,
          recipients: [{ roleKey: 'r1', name: 'Tran Thi B', deliveryMode: 'link' }],
        },
        { actor: asUser(memberId), orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_FORBIDDEN', status: 403 });

    const adminInstantiated = await runtime.execute<{ envelopeId: string }>(
      'sign.template.instantiate',
      {
        templateId: tpl.templateId,
        title: 'Hop dong tu mau - Tran Thi B',
        sourceKind: 'hr_contract',
        sourceId: contractSourceId,
        recipients: [{ roleKey: 'r1', name: 'Tran Thi B', deliveryMode: 'link' }],
      },
      { actor: asUser(adminId), orgId },
    );
    expect(adminInstantiated.envelopeId).toBeTruthy();

    await expect(
      runtime.query('sign.envelope.get', { envelopeId: adminInstantiated.envelopeId }, { actor: asUser(memberId), orgId }),
    ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });

    // Shared blank template PDF remains readable to workspace members and viewers after hr_contract instantiation.
    for (const readerId of [memberId, viewerId]) {
      const tplFileRead = await runtime.query<{ id: string }>(
        'kernel.file.get',
        { id: tplFile },
        { actor: asUser(readerId), orgId },
      );
      expect(tplFileRead.id).toBe(tplFile);
    }
  });

  it('enforces owner/admin/created_by visibility, 404 parity with AI on/off, file download gating, and full worker/public lifecycle', async () => {
    const missingId = randomUUID();
    const hrSourceIdOwner = randomUUID();
    const hrSourceIdCreator = randomUUID();

    // 1. Pre-create unattached sign_document uploaded by owner cannot be downloaded or hijacked by member.
    const { fileId: ownerHrFile, sha256: ownerHrSha } = await ingestSignFile(
      asUser(ownerId),
      orgId,
      `owner-hr-salary-${randomUUID()}`,
    );
    await expect(
      runtime.query('kernel.file.get', { id: ownerHrFile }, { actor: asUser(memberId), orgId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    await expect(
      runtime.execute(
        'sign.envelope.create',
        { title: 'Hijack Attempt', sourceKind: 'standalone', sourceFileId: ownerHrFile },
        { actor: asUser(memberId), orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_FILE_NOT_FOUND', status: 404 });

    // 2. Owner creates HR contract #1; creatorDemoted creates HR contract #2 while admin, then is demoted to member.
    const ownerEnv = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      {
        title: 'Hop dong lao dong - Nguyen Van A (45.000.000 VND)',
        sourceKind: 'hr_contract',
        sourceId: hrSourceIdOwner,
        sourceFileId: ownerHrFile,
      },
      { actor: asUser(ownerId), orgId },
    );

    const { fileId: creatorHrFile } = await ingestSignFile(
      asUser(creatorDemotedId),
      orgId,
      `creator-hr-salary-${randomUUID()}`,
    );
    const creatorEnv = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      {
        title: 'Hop dong lao dong - Le Van C (32.000.000 VND)',
        sourceKind: 'hr_contract',
        sourceId: hrSourceIdCreator,
        sourceFileId: creatorHrFile,
      },
      { actor: asUser(creatorDemotedId), orgId },
    );

    // Demote creatorDemotedId to ordinary member: they must still retain created_by access to creatorEnv ONLY, never ownerEnv!
    await adminPool!.query(
      `UPDATE crove_kernel.tenant_member SET role = 'member' WHERE org_id = $1::uuid AND user_id = $2::uuid`,
      [orgId, creatorDemotedId],
    );

    // Also create a standalone envelope so we verify list filtering & pagination counts preserve non-HR envelopes.
    const { fileId: standaloneFile } = await ingestSignFile(
      asUser(ownerId),
      orgId,
      `standalone-nda-${randomUUID()}`,
    );
    const standaloneEnv = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      {
        title: 'NDA Doi tac Cong khai Nội bộ',
        sourceKind: 'standalone',
        sourceFileId: standaloneFile,
      },
      { actor: asUser(ownerId), orgId },
    );

    // Inspect ownerEnv via system worker and record AI analysis.
    const inspectData = await workerRuntime.query<{ id: string } | null>(
      'sign.envelope.inspect_job_data',
      { envelopeId: ownerEnv.envelopeId },
      { actor: asSystem('sign-pdf-inspect'), orgId },
    );
    expect(inspectData?.id).toBe(ownerEnv.envelopeId);

    await workerRuntime.execute(
      'sign.envelope.inspect_complete',
      {
        envelopeId: ownerEnv.envelopeId,
        outcome: 'passed',
        pageCount: 1,
        pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0 }],
      },
      { actor: asSystem('sign-pdf-inspect'), orgId },
    );

    const addedSigner = await runtime.execute<{ signerId: string }>(
      'sign.signer.add',
      {
        envelopeId: ownerEnv.envelopeId,
        routingOrder: 1,
        signerRole: 'signer',
        roleLabel: 'Employee',
        name: 'Nguyen Van A',
        email: 'nguyenvana@employee.test',
        deliveryMode: 'link',
        requireEmailOtp: false,
      },
      { actor: asUser(ownerId), orgId },
    );

    await runtime.execute(
      'sign.field.set',
      {
        envelopeId: ownerEnv.envelopeId,
        fields: [
          {
            signerId: addedSigner.signerId,
            fieldType: 'signature',
            pageNumber: 1,
            xNorm: 0.12,
            yNorm: 0.72,
            wNorm: 0.25,
            hNorm: 0.08,
            required: true,
          },
        ],
      },
      { actor: asUser(ownerId), orgId },
    );

    await workerRuntime.execute(
      'sign.ai_analysis.record',
      {
        envelopeId: ownerEnv.envelopeId,
        sourceSha256: ownerHrSha,
        status: 'completed',
        summaryText: 'Base monthly wage is 45.000.000 VND.',
        extractedPages: [{ page: 1, text: 'Base monthly wage is 45.000.000 VND.' }],
      },
      { actor: asSystem('sign-ai-analyze'), orgId },
    );

    // 3. List and by_source isolation across roles.
    const ownerList = await runtime.query<{ items: Array<{ id: string; sourceKind: string }> }>(
      'sign.envelope.list',
      { limit: 50 },
      { actor: asUser(ownerId), orgId },
    );
    expect(ownerList.items.map((i) => i.id)).toEqual(
      expect.arrayContaining([ownerEnv.envelopeId, creatorEnv.envelopeId, standaloneEnv.envelopeId]),
    );

    const adminHrList = await runtime.query<{ items: Array<{ id: string }> }>(
      'sign.envelope.list',
      { sourceKind: 'hr_contract', limit: 50 },
      { actor: asUser(adminId), orgId },
    );
    expect(adminHrList.items.map((i) => i.id)).toEqual(
      expect.arrayContaining([ownerEnv.envelopeId, creatorEnv.envelopeId]),
    );

    const memberList = await runtime.query<{ items: Array<{ id: string; sourceKind: string }> }>(
      'sign.envelope.list',
      { limit: 1 },
      { actor: asUser(memberId), orgId },
    );
    // Pagination limit=1 returns the standalone envelope instead of returning 0 rows after post-filtering!
    expect(memberList.items.map((i) => i.id)).toEqual([standaloneEnv.envelopeId]);

    const memberHrList = await runtime.query<{ items: Array<{ id: string }> }>(
      'sign.envelope.list',
      { sourceKind: 'hr_contract', limit: 50 },
      { actor: asUser(memberId), orgId },
    );
    expect(memberHrList.items).toEqual([]);

    const viewerHrList = await runtime.query<{ items: Array<{ id: string }> }>(
      'sign.envelope.list',
      { sourceKind: 'hr_contract', limit: 50 },
      { actor: asUser(viewerId), orgId },
    );
    expect(viewerHrList.items).toEqual([]);

    const demotedCreatorHrList = await runtime.query<{ items: Array<{ id: string }> }>(
      'sign.envelope.list',
      { sourceKind: 'hr_contract', limit: 50 },
      { actor: asUser(creatorDemotedId), orgId },
    );
    expect(demotedCreatorHrList.items.map((i) => i.id)).toEqual([creatorEnv.envelopeId]);

    const memberBySource = await runtime.query<{ items: unknown[] }>(
      'sign.envelope.by_source',
      { sourceKind: 'hr_contract', sourceIds: [hrSourceIdOwner, hrSourceIdCreator] },
      { actor: asUser(memberId), orgId },
    );
    expect(memberBySource.items).toEqual([]);

    const creatorBySource = await runtime.query<{ items: Array<{ envelopeId: string }> }>(
      'sign.envelope.by_source',
      { sourceKind: 'hr_contract', sourceIds: [hrSourceIdOwner, hrSourceIdCreator] },
      { actor: asUser(creatorDemotedId), orgId },
    );
    expect(creatorBySource.items.map((i) => i.envelopeId)).toEqual([creatorEnv.envelopeId]);

    // 4. Zero-existence-oracle 404 parity on all reads with AI enabled AND with AI stopped.
    for (const aiStopped of [false, true]) {
      await adminPool!.query(`DELETE FROM crove_kernel.kill_switch WHERE org_id = $1::uuid`, [orgId]);
      if (aiStopped) {
        await adminPool!.query(
          `INSERT INTO crove_kernel.kill_switch (org_id, scope, target, reason, engaged_by)
           VALUES ($1::uuid, 'module', 'sign', 'AI stopped for invariant test', $2::uuid)`,
          [orgId, ownerId],
        );
      }

      for (const queryName of [
        'sign.envelope.get',
        'sign.envelope.events',
        'sign.envelope.verify',
        'sign.ai_analysis.source',
        'sign.ai_analysis.get',
      ] as const) {
        let existingErr: { code?: string; status?: number; message?: string } | undefined;
        let missingErr: { code?: string; status?: number; message?: string } | undefined;
        try {
          await runtime.query(queryName, { envelopeId: ownerEnv.envelopeId }, { actor: asUser(memberId), orgId });
        } catch (err) {
          existingErr = err as { code?: string; status?: number; message?: string };
        }
        try {
          await runtime.query(queryName, { envelopeId: missingId }, { actor: asUser(memberId), orgId });
        } catch (err) {
          missingErr = err as { code?: string; status?: number; message?: string };
        }
        expect(existingErr).toBeDefined();
        expect(missingErr).toBeDefined();
        expect({ code: existingErr?.code, status: existingErr?.status, message: existingErr?.message }).toEqual({
          code: 'SIGN_ENVELOPE_NOT_FOUND',
          status: 404,
          message: missingErr?.message,
        });
      }

      // Admin and owner can read both envelope and AI analysis regardless of AI stopped state.
      const adminDetail = await runtime.query<{ envelope: { id: string } }>(
        'sign.envelope.get',
        { envelopeId: ownerEnv.envelopeId },
        { actor: asUser(adminId), orgId },
      );
      expect(adminDetail.envelope.id).toBe(ownerEnv.envelopeId);
      const adminAiSource = await runtime.query<{ aiStopped: boolean }>(
        'sign.ai_analysis.source',
        { envelopeId: ownerEnv.envelopeId },
        { actor: asUser(adminId), orgId },
      );
      expect(adminAiSource.aiStopped).toBe(aiStopped);
      const adminAi = await runtime.query<{ summaryText: string | null } | null>(
        'sign.ai_analysis.get',
        { envelopeId: ownerEnv.envelopeId },
        { actor: asUser(adminId), orgId },
      );
      expect(adminAi?.summaryText).toContain('45.000.000 VND');
    }
    await adminPool!.query(`DELETE FROM crove_kernel.kill_switch WHERE org_id = $1::uuid`, [orgId]);

    // 5. Mutation, template cloning, and sourceFileId reuse attempts by unauthorized member all fail closed.
    await expect(
      runtime.execute(
        'sign.envelope.update',
        { envelopeId: ownerEnv.envelopeId, title: 'Tampered' },
        { actor: asUser(memberId), orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });

    await expect(
      runtime.execute(
        'sign.signer.add',
        {
          envelopeId: ownerEnv.envelopeId,
          signerRole: 'cc',
          name: 'Spy',
          email: 'spy@hr-sign.test',
          deliveryMode: 'email',
        },
        { actor: asUser(memberId), orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });

    await expect(
      runtime.execute(
        'sign.signer.remove',
        { envelopeId: ownerEnv.envelopeId, signerId: addedSigner.signerId },
        { actor: asUser(memberId), orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });

    await expect(
      runtime.execute(
        'sign.signer.reorder',
        { envelopeId: ownerEnv.envelopeId, orders: [{ signerId: addedSigner.signerId, routingOrder: 1 }] },
        { actor: asUser(memberId), orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });

    await expect(
      runtime.execute(
        'sign.field.set',
        { envelopeId: ownerEnv.envelopeId, fields: [] },
        { actor: asUser(memberId), orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });

    await expect(
      runtime.execute(
        'sign.envelope.propose_fields',
        { envelopeId: ownerEnv.envelopeId, sourceSha256: ownerHrSha, status: 'failed', errorMessage: 'probe' },
        { actor: asUser(memberId), orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });

    await expect(
      runtime.execute(
        'sign.envelope.send',
        { envelopeId: ownerEnv.envelopeId },
        { actor: asUser(memberId), orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });

    await expect(
      runtime.execute(
        'sign.template.create',
        { title: 'Clone HR Contract', sourceEnvelopeId: ownerEnv.envelopeId },
        { actor: asUser(memberId), orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });

    // Even owner cannot convert a confidential HR contract envelope or its dedicated PDF into an org-wide template.
    await expect(
      runtime.execute(
        'sign.template.create',
        { title: 'Accidental Org Template', sourceEnvelopeId: ownerEnv.envelopeId },
        { actor: asUser(ownerId), orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_FORBIDDEN', status: 403 });

    await expect(
      runtime.execute(
        'sign.template.create',
        { title: 'Accidental Org Template From File', sourceFileId: ownerHrFile },
        { actor: asUser(ownerId), orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_FORBIDDEN', status: 403 });

    await expect(
      runtime.execute(
        'sign.template.create',
        { title: 'Reuse HR Source File', sourceFileId: ownerHrFile },
        { actor: asUser(memberId), orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_FILE_NOT_FOUND', status: 404 });

    // 6. Send envelope as admin, verify active-envelope mutations (create_link, remind, void) still return 404 to member,
    // then complete public signing ceremony + worker sealing, and verify file downloads!
    const sent = await runtime.execute<{
      links: Array<{ signerId: string; tokenId: string; token: string }>;
    }>(
      'sign.envelope.send',
      { envelopeId: ownerEnv.envelopeId },
      { actor: asUser(adminId), orgId },
    );
    expect(sent.links).toHaveLength(1);
    const rawSignToken = sent.links[0]!.token;

    await expect(
      runtime.execute(
        'sign.signer.create_link',
        { envelopeId: ownerEnv.envelopeId, signerId: addedSigner.signerId },
        { actor: asUser(memberId), orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });

    await expect(
      runtime.execute(
        'sign.envelope.remind',
        { envelopeId: ownerEnv.envelopeId },
        { actor: asUser(memberId), orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });

    await expect(
      runtime.execute(
        'sign.envelope.void',
        { envelopeId: ownerEnv.envelopeId, reason: 'Unauthorized cancel' },
        { actor: asUser(memberId), orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });

    // Public signing ceremony works end-to-end for the employee holding the capability token.
    const fieldRows = await adminPool!.query<{ id: string }>(
      `SELECT id FROM crove_sign.field WHERE org_id = $1::uuid AND envelope_id = $2::uuid`,
      [orgId, ownerEnv.envelopeId],
    );
    const sigFieldId = fieldRows.rows[0]!.id;

    const tokenSha = hashSigningToken(rawSignToken);
    const viewed = await appPool!.query<{ v: Record<string, unknown> }>(
      `SELECT crove_sign.public_record_view($1, $2, $3) AS v`,
      [tokenSha, ipHash, 'EmployeeBrowser/1.0'],
    );
    expect(viewed.rows[0]?.v).toMatchObject({ state: 'ready', signerName: 'Nguyen Van A' });

    const pdfSource = await appPool!.query<{ v: Record<string, unknown> }>(
      `SELECT crove_sign.public_pdf_source($1) AS v`,
      [tokenSha],
    );
    expect(pdfSource.rows[0]?.v).toMatchObject({ orgId, otpRequired: false });

    const submitted = await appPool!.query<{ v: { status: string; completed?: boolean; envelopeStatus?: string } }>(
      `SELECT crove_sign.public_submit($1, true, 'draw', NULL, $2::jsonb, $3, 'EmployeeBrowser/1.0', $4) AS v`,
      [
        tokenSha,
        JSON.stringify([{ fieldId: sigFieldId, signaturePngBase64: VALID_PNG_BASE64 }]),
        ipHash,
        DEFAULT_MESSAGE_ID_DOMAIN,
      ],
    );
    expect(submitted.rows[0]?.v).toMatchObject({
      status: 'ok',
      completed: true,
      envelopeStatus: 'completed',
    });

    // Seal worker reads seal_job_data and records sealed PDF + canonical certificate JSON.
    const sealJob = await workerRuntime.query<{ envelope: { id: string; completedAtIso: string | null }; events: Array<{ event_hash: string }> } | null>(
      'sign.envelope.seal_job_data',
      { envelopeId: ownerEnv.envelopeId },
      { actor: asSystem('sign-pdf-seal'), orgId },
    );
    expect(sealJob?.envelope.id).toBe(ownerEnv.envelopeId);

    const { fileId: sealedFileId } = await ingestSignFile(
      asSystem('sign-pdf-seal'),
      orgId,
      `hr-sealed-${randomUUID()}`,
      'sign_sealed',
    );
    const { fileId: certFileId } = await ingestSignFile(
      asSystem('sign-pdf-seal'),
      orgId,
      `hr-cert-${randomUUID()}`,
      'sign_certificate',
      'application/json',
    );
    const certCode = generateCertificateCode(
      ownerEnv.envelopeId,
      sealJob!.envelope.completedAtIso ?? new Date().toISOString(),
      sealJob!.events[sealJob!.events.length - 1]!.event_hash,
    );

    await workerRuntime.execute(
      'sign.envelope.seal_complete',
      {
        envelopeId: ownerEnv.envelopeId,
        outcome: 'sealed',
        certificateCode: certCode,
        sealedFileId,
        certificateFileId: certFileId,
      },
      { actor: asSystem('sign-pdf-seal'), orgId },
    );

    // System sweep & cleanup commands continue to run cleanly with hr_contract rows present.
    await workerRuntime.execute('sign.envelope.expire_sweep', {}, { actor: asSystem('sign-expire-sweep'), orgId });
    await workerRuntime.execute('sign.org.cleanup', {}, { actor: asSystem('sign-cleanup'), orgId });

    // File download authorization: owner & admin get 200 on source, sealed, and certificate files;
    // unauthorized member & viewer get identical 404 NOT_FOUND on all three, while still reading standalone files!
    for (const authorizedUserId of [ownerId, adminId]) {
      for (const fId of [ownerHrFile, sealedFileId, certFileId]) {
        const fileRes = await runtime.query<{ id: string }>(
          'kernel.file.get',
          { id: fId },
          { actor: asUser(authorizedUserId), orgId },
        );
        expect(fileRes.id).toBe(fId);
      }
    }

    // Demoted creator can still download their own HR contract's source file, NOT owner's HR contract files!
    const ownCreatorFile = await runtime.query<{ id: string }>(
      'kernel.file.get',
      { id: creatorHrFile },
      { actor: asUser(creatorDemotedId), orgId },
    );
    expect(ownCreatorFile.id).toBe(creatorHrFile);

    for (const unauthorizedUserId of [memberId, viewerId, creatorDemotedId]) {
      let missingFileErr: { code?: string; status?: number; message?: string } | undefined;
      try {
        await runtime.query('kernel.file.get', { id: missingId }, { actor: asUser(unauthorizedUserId), orgId });
      } catch (err) {
        missingFileErr = err as { code?: string; status?: number; message?: string };
      }
      for (const confidentialFileId of [ownerHrFile, sealedFileId, certFileId]) {
        await expect(
          runtime.query('kernel.file.get', { id: confidentialFileId }, { actor: asUser(unauthorizedUserId), orgId }),
        ).rejects.toMatchObject({
          code: 'NOT_FOUND',
          status: 404,
          message: missingFileErr?.message,
        });
      }
    }

    // Probing sealedFileId or certFileId via sign.envelope.create returns 404 SIGN_FILE_NOT_FOUND, never 422.
    for (const confidentialId of [sealedFileId, certFileId]) {
      await expect(
        runtime.execute(
          'sign.envelope.create',
          { title: 'Probe Sealed Or Cert File', sourceKind: 'standalone', sourceFileId: confidentialId },
          { actor: asUser(memberId), orgId },
        ),
      ).rejects.toMatchObject({ code: 'SIGN_FILE_NOT_FOUND', status: 404 });
    }

    // Member CAN still download non-HR standalone sign_document files in the same org.
    const standaloneDownload = await runtime.query<{ id: string }>(
      'kernel.file.get',
      { id: standaloneFile },
      { actor: asUser(memberId), orgId },
    );
    expect(standaloneDownload.id).toBe(standaloneFile);

    // Owner/admin by_source includes sealedFileId for 1-click download on Ludy Nhan su.
    const adminBySource = await runtime.query<{
      items: Array<{ sourceId: string; envelopeId: string; status: string; sealStatus: string | null; sealedFileId?: string | null }>;
    }>(
      'sign.envelope.by_source',
      { sourceKind: 'hr_contract', sourceIds: [hrSourceIdOwner] },
      { actor: asUser(adminId), orgId },
    );
    expect(adminBySource.items).toEqual([
      expect.objectContaining({
        sourceId: hrSourceIdOwner,
        envelopeId: ownerEnv.envelopeId,
        status: 'completed',
        sealStatus: 'sealed',
        sealedFileId,
      }),
    ]);

    // 7. Direct SQL RLS & SECURITY DEFINER checks under crove_tenant (member, viewer, and cross-org).
    const appClient = await appPool!.connect();
    try {
      for (const unauthorizedUserId of [memberId, viewerId]) {
        await appClient.query('BEGIN');
        const ctxToken = mintContextToken(process.env.LUDY_CONTEXT_TOKEN_KEY ?? process.env.CROVE_CONTEXT_TOKEN_KEY ?? '', {
          userId: unauthorizedUserId,
          orgId,
          sessionId: null,
          aal: 'aal1',
          mfaAt: null,
        });
        await appClient.query(
          `SELECT crove_kernel.enter_user_context($1::uuid, $2::text)`,
          [orgId, ctxToken],
        );

        for (const table of ['envelope', 'signer', 'field', 'ai_analysis', 'signing_event'] as const) {
          const col = table === 'envelope' ? 'id' : 'envelope_id';
          const res = await appClient.query<{ cnt: string }>(
            `SELECT count(*)::text AS cnt FROM crove_sign.${table} WHERE org_id = $1::uuid AND ${col} = $2::uuid`,
            [orgId, ownerEnv.envelopeId],
          );
          expect(Number(res.rows[0]?.cnt ?? -1)).toBe(0);
        }

        const canReadRes = await appClient.query<{ ok: boolean }>(
          `SELECT crove_sign.can_read_sign_file($1::uuid) AS ok`,
          [sealedFileId],
        );
        expect(canReadRes.rows[0]?.ok).toBe(false);

        const updRes = await appClient.query(
          `UPDATE crove_sign.envelope SET title = 'RLS Bypass' WHERE org_id = $1::uuid AND id = $2::uuid`,
          [orgId, ownerEnv.envelopeId],
        );
        expect(updRes.rowCount).toBe(0);

        await appClient.query('SAVEPOINT sp_mint');
        let mintErr: unknown;
        try {
          await appClient.query(
            `SELECT crove_sign.mint_signing_token($1::uuid, $2::uuid, $3::text, now() + interval '1 day')`,
            [ownerEnv.envelopeId, addedSigner.signerId, hashSigningToken(generateRawSigningToken())],
          );
        } catch (err) {
          mintErr = err;
        } finally {
          await appClient.query('ROLLBACK TO SAVEPOINT sp_mint');
        }
        expect((mintErr as { code?: string } | undefined)?.code).toBe('42501');

        await appClient.query('SAVEPOINT sp_revoke');
        let revokeErr: unknown;
        try {
          await appClient.query(`SELECT crove_sign.revoke_envelope_tokens($1::uuid)`, [ownerEnv.envelopeId]);
        } catch (err) {
          revokeErr = err;
        } finally {
          await appClient.query('ROLLBACK TO SAVEPOINT sp_revoke');
        }
        expect((revokeErr as { code?: string } | undefined)?.code).toBe('42501');

        await appClient.query('ROLLBACK');
      }

      // Cross-org owner in otherOrgId also sees zero rows and gets 404.
      await expect(
        runtime.query('sign.envelope.get', { envelopeId: ownerEnv.envelopeId }, { actor: asUser(otherOwnerId), orgId: otherOrgId }),
      ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });
    } finally {
      appClient.release();
    }
  });
});
