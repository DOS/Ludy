// SPDX-License-Identifier: AGPL-3.0-only
// PostgreSQL 17 integration & security tests for eSign Slice 4a (#3817):
//   - Member-private saved signature & initials (author-only RLS: even org owner cannot read/modify another member's row)
//   - Automatic cascade deletion of member_signature when a member is removed from tenant_member
//   - Org stamp RBAC (owner/admin create & archive, plain member read-only, viewer denied)
//   - Stamp-only signer envelope send, ludy_sign.public_submit PNG magic validation, and buildPdfSealFields payload
//   - Direct signing link start on a stamp-only template
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
  generateRawSigningToken,
  hashSigningToken,
} from '../src/sealing.ts';
import {
  signCommands,
  signManifest,
  signQueries,
  type SignSealJobData,
} from '../src/index.ts';
import { buildPdfSealFields } from '../src/sealing.ts';

type Pool = ReturnType<typeof createPool>;

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
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

function makePngBase64(width = 120, height = 80, red = 180): string {
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
  const rawBytes = Buffer.alloc(height * (1 + width * 4), 0);
  rawBytes[1] = red;
  rawBytes[4] = 255;
  const idat = chunk('IDAT', deflateSync(rawBytes));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    idat,
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

const VALID_SIG_PNG = makePngBase64(160, 60, 20);
const VALID_STAMP_PNG = makePngBase64(140, 100, 200);

suite('eSign Slice 4a stamps & saved member signatures on PostgreSQL 17 (#3817)', () => {
  const dbName = `crove_test_sign_s4a_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let adminPool: Pool | undefined;
  let appPool: Pool | undefined;
  let workerPool: Pool | undefined;
  let runtime: Runtime;
  let workerRuntime: Runtime;

  let orgA = '';
  let orgB = '';
  let ownerA = '';
  let adminA = '';
  let memberA = '';
  let tempMemberA = '';
  let viewerA = '';
  let ownerB = '';

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asSystem = (component: string) => ({ type: 'system' as const, component });

  async function ingestPdf(
    actorUserId: string,
    orgId: string,
    tag: string,
  ): Promise<{ fileId: string; sha256: string; storageKey: string; generation: string }> {
    const bytes = Uint8Array.from(
      Buffer.from(`%PDF-1.4\n% sign-s4a-${tag}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n`, 'utf8'),
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
    await setRolePasswords(adminUrl, { ludy_app: 's4a-app-pw', ludy_worker: 's4a-worker-pw' });

    const loginUrl = (user: string, pw: string) => {
      const u = new URL(adminUrl);
      u.username = user;
      u.password = pw;
      return u.toString();
    };

    adminPool = createPool({ connectionString: adminUrl, max: 2 });
    appPool = createPool({ connectionString: loginUrl('ludy_app', 's4a-app-pw'), max: 6 });
    workerPool = createPool({ connectionString: loginUrl('ludy_worker', 's4a-worker-pw'), max: 3 });

    const manifests = [kernelManifest.tables, signManifest.tables];
    const appDb = createDb(appPool);
    const workerDb = createDb(workerPool);

    runtime = new Runtime(appDb, { manifests })
      .register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) })
      .register({ commands: signCommands, queries: signQueries });

    workerRuntime = new Runtime(workerDb, { manifests })
      .register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) })
      .register({ commands: signCommands, queries: signQueries });

    ownerA = await upsertIdentity(appDb, { issuer: 's4a', subject: 'owner-a', email: 'ownera@example.com', name: 'Owner A' });
    adminA = await upsertIdentity(appDb, { issuer: 's4a', subject: 'admin-a', email: 'admina@example.com', name: 'Admin A' });
    memberA = await upsertIdentity(appDb, { issuer: 's4a', subject: 'member-a', email: 'membera@example.com', name: 'Member A' });
    tempMemberA = await upsertIdentity(appDb, { issuer: 's4a', subject: 'temp-a', email: 'tempa@example.com', name: 'Temp Member A' });
    viewerA = await upsertIdentity(appDb, { issuer: 's4a', subject: 'viewer-a', email: 'viewera@example.com', name: 'Viewer A' });
    ownerB = await upsertIdentity(appDb, { issuer: 's4a', subject: 'owner-b', email: 'ownerb@example.com', name: 'Owner B' });

    orgA = (await createOrg(runtime, asUser(ownerA), 'Cong ty Dau A')).orgId;
    orgB = (await createOrg(runtime, asUser(ownerB), 'Cong ty Dau B')).orgId;

    await adminPool.query(
      `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role)
       VALUES ($1::uuid, $2::uuid, 'admin'),
              ($1::uuid, $3::uuid, 'member'),
              ($1::uuid, $4::uuid, 'member'),
              ($1::uuid, $5::uuid, 'viewer')`,
      [orgA, adminA, memberA, tempMemberA, viewerA],
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

  it('enforces author-only RLS on ludy_sign.member_signature and cascades on member removal', async () => {
    const savedSig = await runtime.execute<{ id: string; kind: string; widthPx: number; heightPx: number }>(
      'sign.member_signature.upsert',
      {
        kind: 'signature',
        signatureKind: 'draw',
        signaturePngBase64: `data:image/png;base64,${VALID_SIG_PNG}`,
      },
      { actor: asUser(memberA), orgId: orgA },
    );
    expect(savedSig).toMatchObject({ kind: 'signature', widthPx: 160, heightPx: 60 });

    await runtime.execute(
      'sign.member_signature.upsert',
      {
        kind: 'initials',
        signatureKind: 'type',
        signatureTypedText: 'MA',
        signaturePngBase64: VALID_SIG_PNG,
      },
      { actor: asUser(memberA), orgId: orgA },
    );

    const memberItems = await runtime.query<{ items: Array<{ kind: string; signatureTypedText: string | null }> }>(
      'sign.member_signature.list',
      {},
      { actor: asUser(memberA), orgId: orgA },
    );
    expect(memberItems.items.map((i) => i.kind)).toEqual(['initials', 'signature']);

    // Even the workspace owner cannot see memberA's saved signatures via query OR direct SQL under ownerA's context!
    const ownerItems = await runtime.query<{ items: unknown[] }>(
      'sign.member_signature.list',
      {},
      { actor: asUser(ownerA), orgId: orgA },
    );
    expect(ownerItems.items).toEqual([]);

    const client = await appPool!.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT ludy_kernel.enter_user_context($1::uuid, $2::text)', [
        orgA,
        mintContextToken(process.env.CROVE_CONTEXT_TOKEN_KEY ?? '', {
          userId: ownerA,
          orgId: orgA,
          sessionId: null,
          aal: 'aal1',
          mfaAt: null,
        }),
      ]);
      const directRead = await client.query('SELECT id FROM ludy_sign.member_signature WHERE org_id = $1::uuid', [orgA]);
      expect(directRead.rows).toEqual([]);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    // Rejects embedded SVG polyglot payloads on member_signature.upsert.
    const svgPolyglot = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'utf8'),
    ]).toString('base64');
    await expect(
      runtime.execute(
        'sign.member_signature.upsert',
        { kind: 'signature', signatureKind: 'draw', signaturePngBase64: svgPolyglot },
        { actor: asUser(memberA), orgId: orgA },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_INVALID_SIGNATURE_PNG', status: 422 });

    // Removing tempMemberA from tenant_member cascades their saved signature out of ludy_sign.member_signature.
    await runtime.execute(
      'sign.member_signature.upsert',
      { kind: 'signature', signatureKind: 'draw', signaturePngBase64: VALID_SIG_PNG },
      { actor: asUser(tempMemberA), orgId: orgA },
    );
    await adminPool!.query('DELETE FROM ludy_kernel.tenant_member WHERE org_id = $1::uuid AND user_id = $2::uuid', [
      orgA,
      tempMemberA,
    ]);
    const remainingForTemp = await adminPool!.query(
      'SELECT count(*)::int AS cnt FROM ludy_sign.member_signature WHERE org_id = $1::uuid AND user_id = $2::uuid',
      [orgA, tempMemberA],
    );
    expect(remainingForTemp.rows[0]?.cnt).toBe(0);

    const delRes = await runtime.execute<{ deleted: boolean }>(
      'sign.member_signature.delete',
      { kind: 'initials' },
      { actor: asUser(memberA), orgId: orgA },
    );
    expect(delRes.deleted).toBe(true);
  });

  it('enforces owner/admin write and SIGN_WRITERS read RBAC on ludy_sign.org_stamp', async () => {
    const created = await runtime.execute<{ id: string; name: string; stampKind: string; status: string }>(
      'sign.stamp.create',
      {
        name: 'Dau tron Cong ty Dau A',
        stampKind: 'company',
        stampPngBase64: VALID_STAMP_PNG,
      },
      { actor: asUser(adminA), orgId: orgA },
    );
    expect(created).toMatchObject({
      name: 'Dau tron Cong ty Dau A',
      stampKind: 'company',
      status: 'active',
    });

    // Duplicate active name is refused with SIGN_STAMP_NAME_TAKEN.
    await expect(
      runtime.execute(
        'sign.stamp.create',
        { name: 'Dau tron Cong ty Dau A', stampKind: 'company', stampPngBase64: VALID_STAMP_PNG },
        { actor: asUser(ownerA), orgId: orgA },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_STAMP_NAME_TAKEN', status: 409 });

    // Optional fileId must match the PNG content type and SHA-256 digest.
    const unrelatedFile = await ingestPdf(ownerA, orgA, 'unrelated-doc');
    await expect(
      runtime.execute(
        'sign.stamp.create',
        {
          name: 'Dau gan file sai',
          stampKind: 'company',
          fileId: unrelatedFile.fileId,
          stampPngBase64: VALID_STAMP_PNG,
        },
        { actor: asUser(ownerA), orgId: orgA },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_INVALID_SIGNATURE_PNG', status: 422 });

    // Plain member can list active stamps (canManage: false) to stamp contracts, but cannot create or archive.
    const memberStampList = await runtime.query<{ items: Array<{ id: string }>; canManage: boolean }>(
      'sign.stamp.list',
      {},
      { actor: asUser(memberA), orgId: orgA },
    );
    expect(memberStampList.canManage).toBe(false);
    expect(memberStampList.items.map((s) => s.id)).toEqual([created.id]);

    await expect(
      runtime.execute(
        'sign.stamp.create',
        { name: 'Dau trai phep', stampKind: 'title', stampPngBase64: VALID_STAMP_PNG },
        { actor: asUser(memberA), orgId: orgA },
      ),
    ).rejects.toMatchObject({ status: 403 });

    await expect(
      runtime.execute('sign.stamp.archive', { stampId: created.id }, { actor: asUser(memberA), orgId: orgA }),
    ).rejects.toMatchObject({ status: 403 });

    // Viewer cannot list stamps.
    await expect(runtime.query('sign.stamp.list', {}, { actor: asUser(viewerA), orgId: orgA })).rejects.toMatchObject({
      status: 403,
    });

    // Cross-tenant isolation: orgB sees zero stamps from orgA.
    const orgBList = await runtime.query<{ items: unknown[] }>('sign.stamp.list', {}, { actor: asUser(ownerB), orgId: orgB });
    expect(orgBList.items).toEqual([]);

    // Owner archives the stamp; plain member no longer sees archived stamps.
    const archived = await runtime.execute<{ stampId: string; status: string }>(
      'sign.stamp.archive',
      { stampId: created.id },
      { actor: asUser(ownerA), orgId: orgA },
    );
    expect(archived).toMatchObject({ stampId: created.id, status: 'archived' });

    const afterArchiveMember = await runtime.query<{ items: unknown[] }>(
      'sign.stamp.list',
      {},
      { actor: asUser(memberA), orgId: orgA },
    );
    expect(afterArchiveMember.items).toEqual([]);
  });

  it('completes end-to-end signing & seal payload for a stamp-only signer and stamp-only direct link template', async () => {
    const file = await ingestPdf(ownerA, orgA, 'stamp-contract');

    const env = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      {
        title: 'Hop dong dong dau to chuc',
        routingMode: 'parallel',
        sourceKind: 'standalone',
        sourceFileId: file.fileId,
      },
      { actor: asUser(ownerA), orgId: orgA },
    );

    await workerRuntime.execute(
      'sign.envelope.inspect_complete',
      {
        envelopeId: env.envelopeId,
        outcome: 'passed',
        pageCount: 3,
        pageDimensions: [
          { page: 1, widthPt: 595, heightPt: 842, rotation: 0 },
          { page: 2, widthPt: 595, heightPt: 842, rotation: 0 },
          { page: 3, widthPt: 595, heightPt: 842, rotation: 0 },
        ],
      },
      { actor: asSystem('sign-worker'), orgId: orgA },
    );

    const custodian = await runtime.execute<{ signerId: string }>(
      'sign.signer.add',
      {
        envelopeId: env.envelopeId,
        signerRole: 'signer',
        roleLabel: 'Van thu dong dau',
        name: 'Van thu Cong ty A',
        deliveryMode: 'link',
        requireEmailOtp: false,
      },
      { actor: asUser(ownerA), orgId: orgA },
    );

    const fieldRes = await runtime.execute<{ fieldIds: string[] }>(
      'sign.field.set',
      {
        envelopeId: env.envelopeId,
        fields: [
          {
            signerId: custodian.signerId,
            fieldType: 'stamp',
            pageNumber: 3,
            xNorm: 0.58,
            yNorm: 0.72,
            wNorm: 0.18,
            hNorm: 0.11,
            label: 'Dau tron cong ty',
            required: true,
            proposedByAi: false,
          },
        ],
      },
      { actor: asUser(ownerA), orgId: orgA },
    );
    const stampFieldId = fieldRes.fieldIds[0]!;

    const sent = await runtime.execute<{ status: string; links: Array<{ signerId: string; token: string }> }>(
      'sign.envelope.send',
      { envelopeId: env.envelopeId },
      { actor: asUser(ownerA), orgId: orgA },
    );
    expect(sent.status).toBe('sent');
    const tokenHash = hashSigningToken(sent.links[0]!.token);

    // Submitting without PNG on a required stamp field is rejected with SIGN_FIELD_REQUIRED.
    const missingRes = await runtime.orgless(async (db) => {
      const { rows } = await sql<{ result: { status: string; code?: string } }>`
        SELECT ludy_sign.public_submit(
          ${tokenHash},
          true,
          null,
          null,
          ${JSON.stringify([{ fieldId: stampFieldId }])}::jsonb,
          null,
          'Vitest/1.0',
          ${DEFAULT_MESSAGE_ID_DOMAIN}
        ) AS result
      `.execute(db);
      return rows[0]?.result;
    });
    expect(missingRes).toMatchObject({ status: 'error', code: 'SIGN_FIELD_REQUIRED' });

    // Submitting a valid PNG stamp completes the envelope and produces a type: 'stamp' seal field.
    const okRes = await runtime.orgless(async (db) => {
      const { rows } = await sql<{ result: { status: string; completed?: boolean; envelopeStatus?: string } }>`
        SELECT ludy_sign.public_submit(
          ${tokenHash},
          true,
          null,
          null,
          ${JSON.stringify([{ fieldId: stampFieldId, signaturePngBase64: `data:image/png;base64,${VALID_STAMP_PNG}` }])}::jsonb,
          null,
          'Vitest/1.0',
          ${DEFAULT_MESSAGE_ID_DOMAIN}
        ) AS result
      `.execute(db);
      return rows[0]?.result;
    });
    expect(okRes).toMatchObject({ status: 'ok', completed: true, envelopeStatus: 'completed' });

    const jobData = await workerRuntime.query<SignSealJobData>(
      'sign.envelope.seal_job_data',
      { envelopeId: env.envelopeId },
      { actor: asSystem('sign-worker'), orgId: orgA },
    );
    expect(jobData).not.toBeNull();
    const sealFields = buildPdfSealFields(jobData!.envelope.pageCount!, jobData!.fields);
    expect(sealFields).toEqual([
      {
        type: 'stamp',
        page: 3,
        xNorm: 0.58,
        yNorm: 0.72,
        wNorm: 0.18,
        hNorm: 0.11,
        imagePngBase64: VALID_STAMP_PNG,
      },
    ]);

    // Direct signing link start also accepts a stamp-only signer template role.
    const tpl = await runtime.execute<{ templateId: string }>(
      'sign.template.create',
      {
        title: 'Mau phieu dong dau',
        routingMode: 'parallel',
        sourceFileId: file.fileId,
      },
      { actor: asUser(ownerA), orgId: orgA },
    );
    await runtime.execute(
      'sign.template.roles_set',
      {
        templateId: tpl.templateId,
        roles: [
          {
            roleKey: 'r1',
            signerRole: 'signer',
            roleLabel: 'Van thu',
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
            fieldType: 'stamp',
            pageNumber: 1,
            xNorm: 0.5,
            yNorm: 0.7,
            wNorm: 0.18,
            hNorm: 0.11,
            required: true,
          },
        ],
      },
      { actor: asUser(ownerA), orgId: orgA },
    );
    await runtime.execute(
      'sign.template.update',
      { templateId: tpl.templateId, status: 'active' },
      { actor: asUser(ownerA), orgId: orgA },
    );
    const directLink = await runtime.execute<{ token: string | null }>(
      'sign.template.direct_link_set',
      { templateId: tpl.templateId, enabled: true, requireEmailOtp: false },
      { actor: asUser(ownerA), orgId: orgA },
    );
    expect(directLink.token).toBeTruthy();

    const startRes = await runtime.orgless(async (db) => {
      const { rows } = await sql<{ result: { status: string; envelopeId?: string } }>`
        SELECT ludy_sign.public_direct_start(
          ${hashSigningToken(directLink.token!)},
          'Nguyen Van Thu',
          null,
          null,
          ${hashSigningToken(generateRawSigningToken())},
          null,
          'Vitest/1.0'
        ) AS result
      `.execute(db);
      return rows[0]?.result;
    });
    expect(startRes?.status).toBe('ok');
  });
});
