// SPDX-License-Identifier: AGPL-3.0-only
// Self-contained PostgreSQL 17 security invariants for eSign Slice 4c (#3819):
//   - Role & trigger guards: crove_worker / PUBLIC denied on correct_signer_recipient and public_delegate;
//     signer_guard() and envelope_guard() block direct tenant SQL updates on non-draft envelopes
//   - In-flight recipient correction (sign.signer.correct_recipient):
//     creator / owner / admin RBAC, hr_contract 404 confidentiality parity, preservation of completed signers,
//     atomic revocation of active signing_token and open signing_otp rows, hash-chained signer_corrected event,
//     mail_suppression & single-mailbox checks, and end-to-end sealing with Audit Certificate provenance
//   - Audited signer delegation (crove_sign.public_delegate):
//     org_app_on('sign') MODULE_OFF opaque not_found, allow_delegation = true gate, OTP verification gate,
//     self-delegation / suppression / multi-mailbox rejection, atomic FOR UPDATE concurrent replay guard,
//     2-hop delegation_count anti-relay cap, PII-free sender sign.delegated mail payload, and PDPL erasure
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
import type { PersonalDataErasure, PersonalDataResult } from '@ludy/kernel-contract';
import { contentGeneration, fileKey, mintContextToken, Runtime, sha256Hex } from '@ludy/kernel-runtime';
import {
  SIGN_DELEGATED_MAIL_TEMPLATE,
  SIGN_INVITE_MAIL_TEMPLATE,
  buildPdfSealCertificate,
  generateCertificateCode,
  hashSigningToken,
  signCommands,
  signManifest,
  signQueries,
  verifyEventChain,
  type SignSealJobData,
} from '../../src/index.ts';
import { resolveDbIdentifiers, roleUrl, setActiveRolePasswords, wrapPool, type DbIdentifiers } from './fixtures/db-identifiers.ts';

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

suite('eSign Slice 4c recipient correction & audited signer delegation invariants (#3819)', () => {
  const dbName = `crove_test_sign_4c_inv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let adminPool: Pool | undefined;
  let appPool: Pool | undefined;
  let workerPool: Pool | undefined;
  let ids: DbIdentifiers;
  let runtime: Runtime;
  let workerRuntime: Runtime;

  let orgId = '';
  let ownerId = '';
  let adminId = '';
  let creatorMemberId = '';
  let plainMemberId = '';
  let viewerId = '';

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    mfaAt: Math.floor(Date.now() / 1000),
  });
  const asSystem = (component: string) => ({ type: 'system' as const, component });
  const ipHash = sha256Hex('203.0.113.42');

  async function ingestPdf(actorUserId: string, targetOrgId: string, tag: string): Promise<{ fileId: string; sha256: string }> {
    const bytes = Uint8Array.from(
      Buffer.from(`%PDF-1.4\n% sign-4c-${tag}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n`, 'utf8'),
    );
    const sha256 = sha256Hex(bytes);
    const { fileId } = await runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      {
        filename: `${tag}.pdf`,
        contentType: 'application/pdf',
        sizeBytes: bytes.byteLength,
        sha256,
        storageKey: fileKey(targetOrgId, sha256),
        generation: contentGeneration(sha256),
        source: 'sign_document',
      },
      { actor: asUser(actorUserId), orgId: targetOrgId },
    );
    return { fileId, sha256 };
  }

  async function setupActiveEnvelope(opts: {
    actorUserId: string;
    orgId: string;
    title: string;
    routingMode: 'sequential' | 'parallel';
    allowDelegation?: boolean;
    sourceKind?: 'standalone' | 'hr_contract';
    signers: Array<{
      routingOrder: number;
      signerRole: 'signer' | 'approver' | 'cc';
      name: string;
      email: string;
      phone?: string | null;
      deliveryMode?: 'link' | 'email';
      requireEmailOtp?: boolean;
    }>;
  }): Promise<{
    envelopeId: string;
    signerIds: string[];
    fieldIdsBySigner: Map<string, string[]>;
    links: Array<{ signerId: string; tokenId: string; token: string }>;
  }> {
    const { fileId } = await ingestPdf(opts.actorUserId, opts.orgId, `${opts.title}-${randomUUID()}`);
    const created = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      {
        title: opts.title,
        sourceFileId: fileId,
        routingMode: opts.routingMode,
        allowDelegation: opts.allowDelegation ?? false,
        ...(opts.sourceKind ? { sourceKind: opts.sourceKind, sourceId: randomUUID() } : {}),
      },
      { actor: asUser(opts.actorUserId), orgId: opts.orgId },
    );
    await workerRuntime.execute(
      'sign.envelope.inspect_complete',
      {
        envelopeId: created.envelopeId,
        outcome: 'passed',
        pageCount: 1,
        pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0 }],
      },
      { actor: asSystem('sign-worker'), orgId: opts.orgId },
    );

    const signerIds: string[] = [];
    const fieldInputs: Array<{
      signerId: string;
      fieldType: 'signature' | 'text';
      pageNumber: number;
      xNorm: number;
      yNorm: number;
      wNorm: number;
      hNorm: number;
      required?: boolean;
    }> = [];

    for (let i = 0; i < opts.signers.length; i++) {
      const s = opts.signers[i]!;
      const added = await runtime.execute<{ signerId: string }>(
        'sign.signer.add',
        {
          envelopeId: created.envelopeId,
          routingOrder: s.routingOrder,
          signerRole: s.signerRole,
          roleLabel: s.signerRole === 'approver' ? 'Approver' : s.signerRole === 'cc' ? 'CC' : `Party ${i + 1}`,
          name: s.name,
          email: s.email,
          phone: s.phone ?? null,
          deliveryMode: s.deliveryMode ?? 'link',
          requireEmailOtp: Boolean(s.requireEmailOtp),
        },
        { actor: asUser(opts.actorUserId), orgId: opts.orgId },
      );
      signerIds.push(added.signerId);
      if (s.signerRole !== 'cc') {
        fieldInputs.push({
          signerId: added.signerId,
          fieldType: s.signerRole === 'approver' ? 'text' : 'signature',
          pageNumber: 1,
          xNorm: 0.1 + i * 0.25,
          yNorm: 0.65,
          wNorm: 0.2,
          hNorm: 0.1,
          required: s.signerRole !== 'approver',
        });
      }
    }

    if (fieldInputs.length > 0) {
      await runtime.execute(
        'sign.field.set',
        { envelopeId: created.envelopeId, fields: fieldInputs },
        { actor: asUser(opts.actorUserId), orgId: opts.orgId },
      );
    }

    const fieldRows = await adminPool!.query<{ id: string; signer_id: string }>(
      'SELECT id, signer_id FROM crove_sign.field WHERE org_id = $1 AND envelope_id = $2 ORDER BY id',
      [opts.orgId, created.envelopeId],
    );
    const fieldIdsBySigner = new Map<string, string[]>();
    for (const f of fieldRows.rows) {
      const arr = fieldIdsBySigner.get(f.signer_id) ?? [];
      arr.push(f.id);
      fieldIdsBySigner.set(f.signer_id, arr);
    }

    const sent = await runtime.execute<{
      links: Array<{ signerId: string; tokenId: string; token: string }>;
    }>(
      'sign.envelope.send',
      { envelopeId: created.envelopeId },
      { actor: asUser(opts.actorUserId), orgId: opts.orgId },
    );

    return {
      envelopeId: created.envelopeId,
      signerIds,
      fieldIdsBySigner,
      links: sent.links,
    };
  }

  async function callPublicDelegate(
    rawToken: string,
    delegateName: string,
    delegateEmail: string,
    reason: string,
  ): Promise<Record<string, unknown>> {
    const tokenHash = hashSigningToken(rawToken);
    const res = await appPool!.query<{ result: Record<string, unknown> }>(
      'SELECT crove_sign.public_delegate($1, $2, $3, $4, $5, $6, $7) AS result',
      [tokenHash, delegateName, delegateEmail, reason, ipHash, 'VitestSignCeremony/1.0', DEFAULT_MESSAGE_ID_DOMAIN],
    );
    return res.rows[0]?.result ?? { status: 'not_found' };
  }

  async function callPublicView(rawToken: string): Promise<Record<string, unknown> | null> {
    const tokenHash = hashSigningToken(rawToken);
    const res = await appPool!.query<{ result: Record<string, unknown> | null }>(
      'SELECT crove_sign.public_record_view($1, $2, $3) AS result',
      [tokenHash, ipHash, 'VitestSignCeremony/1.0'],
    );
    return res.rows[0]?.result ?? null;
  }

  async function verifyOtpForToken(rawToken: string, signerId: string, targetOrgId: string): Promise<void> {
    const tokenHash = hashSigningToken(rawToken);
    const otpReq = await appPool!.query<{ v: { status: string; sent: boolean } }>(
      'SELECT crove_sign.public_request_otp($1, $2) AS v',
      [tokenHash, DEFAULT_MESSAGE_ID_DOMAIN],
    );
    expect(otpReq.rows[0]?.v).toMatchObject({ status: 'ok', sent: true });
    const otpRow = await adminPool!.query<{ id: string }>(
      'SELECT id FROM crove_sign.signing_otp WHERE org_id = $1 AND signer_id = $2 ORDER BY created_at DESC LIMIT 1',
      [targetOrgId, signerId],
    );
    const otpMail = await workerRuntime.execute<{ code: string }>(
      'sign.public.otp_mail_data',
      { signerId, otpId: otpRow.rows[0]!.id },
      { actor: asSystem('mail-worker'), orgId: targetOrgId },
    );
    const otpVer = await appPool!.query<{ v: { ok: boolean } }>(
      'SELECT crove_sign.public_verify_otp($1, $2, $3, $4) AS v',
      [tokenHash, otpMail.code, ipHash, 'VitestSignCeremony/1.0'],
    );
    expect(otpVer.rows[0]?.v.ok).toBe(true);
  }

  async function callPublicSubmit(
    rawToken: string,
    fieldId: string,
    signatureKind: 'draw' | 'type' | null = 'draw',
  ): Promise<Record<string, unknown>> {
    const tokenHash = hashSigningToken(rawToken);
    const fieldsJson = signatureKind === null ? [] : [{ fieldId, signaturePngBase64: VALID_PNG_BASE64 }];
    const res = await appPool!.query<{ result: Record<string, unknown> }>(
      'SELECT crove_sign.public_submit($1, true, $2, $3, $4::jsonb, $5, $6, $7) AS result',
      [
        tokenHash,
        signatureKind,
        signatureKind === 'type' ? 'Signed Name' : null,
        JSON.stringify(fieldsJson),
        ipHash,
        'VitestSignCeremony/1.0',
        DEFAULT_MESSAGE_ID_DOMAIN,
      ],
    );
    return res.rows[0]?.result ?? { status: 'not_found' };
  }

  beforeAll(async () => {
    const rootPool = createPool({ connectionString: ADMIN as string, max: 1 });
    await rootPool.query(`CREATE DATABASE ${dbName}`);
    await rootPool.end();

    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();

    await migrate({ adminUrl, dir: MIGRATIONS });
    ids = await resolveDbIdentifiers(adminUrl);
    await setActiveRolePasswords(adminUrl, { crove_app: 's4c-app-pw', crove_worker: 's4c-worker-pw' }, ids);

    adminPool = wrapPool(createPool({ connectionString: adminUrl, max: 3 }), ids);
    appPool = wrapPool(createPool({ connectionString: roleUrl(adminUrl, 'crove_app', 's4c-app-pw', ids), max: 6 }), ids);
    workerPool = wrapPool(createPool({ connectionString: roleUrl(adminUrl, 'crove_worker', 's4c-worker-pw', ids), max: 3 }), ids);

    const manifests = [kernelManifest.tables, signManifest.tables];
    const appDb = createDb(appPool);
    const workerDb = createDb(workerPool);

    runtime = new Runtime(appDb, { manifests })
      .register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) })
      .register({ commands: signCommands, queries: signQueries });

    workerRuntime = new Runtime(workerDb, { manifests })
      .register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) })
      .register({ commands: signCommands, queries: signQueries });

    ownerId = await upsertIdentity(appDb, { issuer: 'sign-4c', subject: 'owner', email: 'owner@example.com', name: 'Org Owner' });
    adminId = await upsertIdentity(appDb, { issuer: 'sign-4c', subject: 'admin', email: 'admin@example.com', name: 'Org Admin' });
    creatorMemberId = await upsertIdentity(appDb, {
      issuer: 'sign-4c',
      subject: 'creator-member',
      email: 'creator@example.com',
      name: 'Creator Member',
    });
    plainMemberId = await upsertIdentity(appDb, {
      issuer: 'sign-4c',
      subject: 'plain-member',
      email: 'member@example.com',
      name: 'Plain Member',
    });
    viewerId = await upsertIdentity(appDb, { issuer: 'sign-4c', subject: 'viewer', email: 'viewer@example.com', name: 'Org Viewer' });

    orgId = (await createOrg(runtime, asUser(ownerId), 'Cong ty Ky So 4c')).orgId;

    await adminPool.query(
      `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role)
       VALUES ($1::uuid, $2::uuid, 'admin'),
              ($1::uuid, $3::uuid, 'member'),
              ($1::uuid, $4::uuid, 'member'),
              ($1::uuid, $5::uuid, 'viewer')`,
      [orgId, adminId, creatorMemberId, plainMemberId, viewerId],
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

  it('enforces EXECUTE privilege matrix and blocks direct tenant SQL mutations via envelope_guard and signer_guard', async () => {
    const env = await setupActiveEnvelope({
      actorUserId: ownerId,
      orgId,
      title: 'Guard Check Envelope',
      routingMode: 'parallel',
      allowDelegation: false,
      signers: [{ routingOrder: 1, signerRole: 'signer', name: 'Signer A', email: 'guard-a@example.com' }],
    });

    const workerClient = await workerPool!.connect();
    try {
      await workerClient.query('BEGIN');
      await workerClient.query('SAVEPOINT sp_worker');
      await expect(
        workerClient.query(
          'SELECT crove_sign.public_delegate($1, $2, $3, $4, $5, $6, $7)',
          ['a'.repeat(64), 'Delegate', 'del@example.com', 'Reason', ipHash, 'UA', DEFAULT_MESSAGE_ID_DOMAIN],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await workerClient.query('ROLLBACK TO SAVEPOINT sp_worker');
      await expect(
        workerClient.query(
          'SELECT crove_sign.correct_signer_recipient($1, $2, $3, $4, $5, $6, $7)',
          [env.envelopeId, env.signerIds[0]!, 'New Name', 'new@example.com', null, 'link', false],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await workerClient.query('ROLLBACK');
    } finally {
      workerClient.release();
    }

    const appClient = await appPool!.connect();
    try {
      const ctxToken = mintContextToken(process.env.LUDY_CONTEXT_TOKEN_KEY ?? process.env.CROVE_CONTEXT_TOKEN_KEY ?? '', {
        userId: ownerId,
        orgId,
        sessionId: null,
        aal: 'aal1',
        mfaAt: null,
      });
      await appClient.query('BEGIN');
      await appClient.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, ctxToken]);

      await appClient.query('SAVEPOINT sp_env_guard');
      await expect(
        appClient.query('UPDATE crove_sign.envelope SET allow_delegation = true WHERE org_id = $1 AND id = $2', [
          orgId,
          env.envelopeId,
        ]),
      ).rejects.toThrow(/ENVELOPE_FROZEN/);
      await appClient.query('ROLLBACK TO SAVEPOINT sp_env_guard');

      await appClient.query('SAVEPOINT sp_signer_guard');
      await expect(
        appClient.query('UPDATE crove_sign.signer SET email = $3 WHERE org_id = $1 AND id = $2', [
          orgId,
          env.signerIds[0]!,
          'tampered@example.com',
        ]),
      ).rejects.toThrow(/ENVELOPE_FROZEN/);
      await appClient.query('ROLLBACK TO SAVEPOINT sp_signer_guard');

      await appClient.query('SAVEPOINT sp_delegated_guard');
      await expect(
        appClient.query('UPDATE crove_sign.signer SET delegated_from_name = $3 WHERE org_id = $1 AND id = $2', [
          orgId,
          env.signerIds[0]!,
          'Forged Delegator',
        ]),
      ).rejects.toThrow(/SIGNER_SYSTEM_ONLY/);
      await appClient.query('ROLLBACK TO SAVEPOINT sp_delegated_guard');

      await appClient.query('ROLLBACK');
    } finally {
      appClient.release();
    }
  });

  it('corrects an unsigned recipient in flight without voiding completed signers, revokes old tokens/OTPs, and seals with provenance', async () => {
    // Suppress one email address in the org to verify mail_suppression enforcement on recipient correction.
    await adminPool!.query(
      `INSERT INTO crove_kernel.mail_suppression (org_id, to_hash, scope, reason)
       VALUES ($1::uuid, crove_kernel.mail_address_hash('suppressed@example.com'), 'all', 'hard_bounce')
       ON CONFLICT DO NOTHING`,
      [orgId],
    );

    // Confidential hr_contract created by owner: non-privileged plainMember gets opaque 404 SIGN_ENVELOPE_NOT_FOUND.
    const hrEnv = await setupActiveEnvelope({
      actorUserId: ownerId,
      orgId,
      title: 'Confidential Employment Contract',
      routingMode: 'sequential',
      sourceKind: 'hr_contract',
      signers: [{ routingOrder: 1, signerRole: 'signer', name: 'Employee One', email: 'emp1@example.com' }],
    });
    await expect(
      runtime.execute(
        'sign.signer.correct_recipient',
        {
          envelopeId: hrEnv.envelopeId,
          signerId: hrEnv.signerIds[0]!,
          name: 'Employee Fixed',
          email: 'emp-fixed@example.com',
          deliveryMode: 'link',
        },
        { actor: asUser(plainMemberId), orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });

    // Standalone 2-signer sequential envelope created by creatorMemberId.
    const env = await setupActiveEnvelope({
      actorUserId: creatorMemberId,
      orgId,
      title: 'Two-Party Service Agreement',
      routingMode: 'sequential',
      signers: [
        { routingOrder: 1, signerRole: 'signer', name: 'Party One', email: 'party1@example.com', deliveryMode: 'link' },
        {
          routingOrder: 2,
          signerRole: 'signer',
          name: 'Party Two Typo',
          email: 'party2-typo@example.com',
          deliveryMode: 'link',
          requireEmailOtp: true,
        },
      ],
    });
    const [signer1Id, signer2Id] = env.signerIds as [string, string];
    const signer1FieldId = env.fieldIdsBySigner.get(signer1Id)![0]!;
    const signer2FieldId = env.fieldIdsBySigner.get(signer2Id)![0]!;
    const signer1Token = env.links.find((l) => l.signerId === signer1Id)!.token;

    // Non-creator plainMember and viewer are rejected with 403 SIGN_FORBIDDEN.
    await expect(
      runtime.execute(
        'sign.signer.correct_recipient',
        {
          envelopeId: env.envelopeId,
          signerId: signer2Id,
          name: 'Party Two Fixed',
          email: 'party2-fixed@example.com',
          deliveryMode: 'link',
        },
        { actor: asUser(plainMemberId), orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_FORBIDDEN', status: 403 });

    await expect(
      runtime.execute(
        'sign.signer.correct_recipient',
        {
          envelopeId: env.envelopeId,
          signerId: signer2Id,
          name: 'Party Two Fixed',
          email: 'party2-fixed@example.com',
          deliveryMode: 'link',
        },
        { actor: asUser(viewerId), orgId },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });

    // Party 1 signs -> envelope moves to 'in_progress', Party 2 moves from 'waiting' -> 'pending'.
    const submit1 = await callPublicSubmit(signer1Token, signer1FieldId, 'draw');
    expect(submit1).toMatchObject({ status: 'ok', envelopeStatus: 'in_progress' });

    // Mint an active link for Party 2, verify OTP + view (putting Party 2 in 'viewed'), and add an open OTP row.
    const priorLink = await runtime.execute<{ token: string; tokenId: string }>(
      'sign.signer.create_link',
      { envelopeId: env.envelopeId, signerId: signer2Id },
      { actor: asUser(creatorMemberId), orgId },
    );
    await verifyOtpForToken(priorLink.token, signer2Id, orgId);
    const viewedBefore = await callPublicView(priorLink.token);
    expect(viewedBefore).toMatchObject({ state: 'ready' });
    await appPool!.query('SELECT crove_sign.public_request_otp($1, $2)', [
      hashSigningToken(priorLink.token),
      DEFAULT_MESSAGE_ID_DOMAIN,
    ]);

    // Completed Party 1 cannot be corrected (409 SIGN_SIGNER_ALREADY_COMPLETED).
    await expect(
      runtime.execute(
        'sign.signer.correct_recipient',
        {
          envelopeId: env.envelopeId,
          signerId: signer1Id,
          name: 'Attempt Overwrite Signed',
          email: 'overwrite@example.com',
          deliveryMode: 'link',
        },
        { actor: asUser(creatorMemberId), orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_SIGNER_ALREADY_COMPLETED', status: 409 });

    // Suppressed email and multi-mailbox header injection are rejected on email delivery correction.
    await expect(
      runtime.execute(
        'sign.signer.correct_recipient',
        {
          envelopeId: env.envelopeId,
          signerId: signer2Id,
          name: 'Party Two Suppressed',
          email: 'suppressed@example.com',
          deliveryMode: 'email',
        },
        { actor: asUser(creatorMemberId), orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_EMAIL_SUPPRESSED', status: 422 });

    await expect(
      runtime.execute(
        'sign.signer.correct_recipient',
        {
          envelopeId: env.envelopeId,
          signerId: signer2Id,
          name: 'Party Two Injected',
          email: 'a@example.com, b@example.com',
          deliveryMode: 'email',
        },
        { actor: asUser(creatorMemberId), orgId },
      ),
    ).rejects.toThrow();

    // Creator corrects Party 2 to email delivery first (verifies queued sign.invite mail + zero PII in payload),
    // then admin corrects Party 2 to link delivery (mints fresh link) so Party 2 can complete signing.
    const correctedEmail = await runtime.execute<{
      status: string;
      deliveryMode: string;
      revokedTokens: number;
      mailStatus: string | null;
      link: unknown;
    }>(
      'sign.signer.correct_recipient',
      {
        envelopeId: env.envelopeId,
        signerId: signer2Id,
        name: 'Party Two Corrected Email',
        email: 'party2-email@example.com',
        deliveryMode: 'email',
        requireEmailOtp: false,
      },
      { actor: asUser(creatorMemberId), orgId },
    );
    expect(correctedEmail.status).toBe('pending');
    expect(correctedEmail.deliveryMode).toBe('email');
    expect(correctedEmail.revokedTokens).toBeGreaterThanOrEqual(1);
    expect(correctedEmail.mailStatus).toBe('queued');
    expect(correctedEmail.link).toBeNull();

    // Prior token is immediately dead (NULL), and open OTPs are invalidated.
    expect(await callPublicView(priorLink.token)).toBeNull();
    const activeOtps = await adminPool!.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM crove_sign.signing_otp
       WHERE org_id = $1 AND signer_id = $2 AND invalidated_at IS NULL`,
      [orgId, signer2Id],
    );
    expect(Number(activeOtps.rows[0]?.count ?? 0)).toBe(0);

    // Queued sign.invite mail has zero recipient PII in mail_message.payload.
    const inviteMails = await adminPool!.query<{ id: string; template_key: string; to_address: string; payload: unknown }>(
      `SELECT id, template_key, to_address, payload FROM crove_kernel.mail_message
       WHERE org_id = $1 AND source_id = $2 AND template_key = $3 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [orgId, signer2Id, SIGN_INVITE_MAIL_TEMPLATE],
    );
    const firstQueuedMailId = inviteMails.rows[0]!.id;
    expect(inviteMails.rows[0]?.to_address).toBe('party2-email@example.com');
    expect(JSON.stringify(inviteMails.rows[0]?.payload ?? {})).not.toContain('party2-email@example.com');
    expect(JSON.stringify(inviteMails.rows[0]?.payload ?? {})).not.toContain('Party Two Corrected Email');

    // A -> B -> A round-trip: correcting away and back to party2-email@example.com supersedes firstQueuedMailId,
    // so dispatching firstQueuedMailId later returns null while the newest queued mail mints a live token!
    await runtime.execute(
      'sign.signer.correct_recipient',
      {
        envelopeId: env.envelopeId,
        signerId: signer2Id,
        name: 'Party Two Mid',
        email: 'party2-mid@example.com',
        deliveryMode: 'email',
        requireEmailOtp: false,
      },
      { actor: asUser(creatorMemberId), orgId },
    );
    await runtime.execute(
      'sign.signer.correct_recipient',
      {
        envelopeId: env.envelopeId,
        signerId: signer2Id,
        name: 'Party Two Roundtrip',
        email: 'party2-email@example.com',
        deliveryMode: 'email',
        requireEmailOtp: false,
      },
      { actor: asUser(creatorMemberId), orgId },
    );
    const roundtripMails = await adminPool!.query<{ id: string }>(
      `SELECT id FROM crove_kernel.mail_message
       WHERE org_id = $1 AND source_id = $2 AND template_key = $3 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [orgId, signer2Id, SIGN_INVITE_MAIL_TEMPLATE],
    );
    const newestEmailId = roundtripMails.rows[0]!.id;
    expect(newestEmailId).not.toBe(firstQueuedMailId);

    const staleRoundtripIssue = await workerRuntime.execute(
      'sign.signer.mail_data',
      { envelopeId: env.envelopeId, signerId: signer2Id, messageId: firstQueuedMailId },
      { actor: asSystem('mail-worker'), orgId },
    );
    expect(staleRoundtripIssue).toBeNull();

    const freshRoundtripIssue = await workerRuntime.execute<{ token: string } | null>(
      'sign.signer.mail_data',
      { envelopeId: env.envelopeId, signerId: signer2Id, messageId: newestEmailId },
      { actor: asSystem('mail-worker'), orgId },
    );
    expect(freshRoundtripIssue?.token).toBeTruthy();

    // Admin corrects Party 2 to link delivery and gets a fresh one-time link; Party 1's signature stays intact.
    // Dispatching newestEmailId AFTER switching to link delivery returns null without revoking correctedLink!
    const correctedLink = await runtime.execute<{
      status: string;
      link: { signerId: string; tokenId: string; token: string; expiresAt: string } | null;
    }>(
      'sign.signer.correct_recipient',
      {
        envelopeId: env.envelopeId,
        signerId: signer2Id,
        name: 'Party Two Final',
        email: 'party2-final@example.com',
        deliveryMode: 'link',
        requireEmailOtp: false,
      },
      { actor: asUser(adminId), orgId },
    );
    expect(correctedLink.link).not.toBeNull();

    const staleAfterSwitchToLink = await workerRuntime.execute(
      'sign.signer.mail_data',
      { envelopeId: env.envelopeId, signerId: signer2Id, messageId: newestEmailId },
      { actor: asSystem('mail-worker'), orgId },
    );
    expect(staleAfterSwitchToLink).toBeNull();
    const staleFallbackWithoutMessageId = await workerRuntime.execute(
      'sign.signer.mail_data',
      { envelopeId: env.envelopeId, signerId: signer2Id },
      { actor: asSystem('mail-worker'), orgId },
    );
    expect(staleFallbackWithoutMessageId).toBeNull();

    const signer1Row = await adminPool!.query<{ status: string; signature_kind: string }>(
      'SELECT status, signature_kind FROM crove_sign.signer WHERE org_id = $1 AND id = $2',
      [orgId, signer1Id],
    );
    expect(signer1Row.rows[0]).toEqual({ status: 'signed', signature_kind: 'draw' });

    // Party 2 signs using the newly minted link -> envelope completes!
    const submit2 = await callPublicSubmit(correctedLink.link!.token, signer2FieldId, 'draw');
    expect(submit2).toMatchObject({ status: 'ok', envelopeStatus: 'completed' });

    const sealData = await workerRuntime.query<SignSealJobData | null>(
      'sign.envelope.seal_job_data',
      { envelopeId: env.envelopeId },
      { actor: asSystem('sign-worker'), orgId },
    );
    expect(sealData).not.toBeNull();
    expect(sealData!.events.filter((e) => e.event_type === 'signer_corrected')).toHaveLength(4);
    const verifiedChain = verifyEventChain(sealData!.events);
    expect(verifiedChain.valid).toBe(true);

    const completedIso = sealData!.envelope.completedAtIso ?? new Date().toISOString();
    const tipHash = sealData!.events.at(-1)!.event_hash;
    const cert = buildPdfSealCertificate({
      certificateCode: generateCertificateCode(env.envelopeId, completedIso, tipHash),
      envelopeTitle: sealData!.envelope.title,
      sourceSha256: sealData!.envelope.sourceSha256,
      completedAtIso: completedIso,
      eventChainTipHash: tipHash,
      signers: sealData!.signers,
      events: sealData!.events,
    });
    expect(cert.signers[0]?.recipientCorrected).toBeUndefined();
    expect(cert.signers[1]?.recipientCorrected).toBe(true);
  });

  it('enforces delegation gates, OTP check, atomic concurrent replay guard, 2-hop cap, PII-free sender mail, and PDPL erasure', async () => {
    // 1. allow_delegation = false rejects public_delegate with 403 SIGN_DELEGATION_DISABLED.
    const disabledEnv = await setupActiveEnvelope({
      actorUserId: ownerId,
      orgId,
      title: 'Delegation Disabled Contract',
      routingMode: 'parallel',
      allowDelegation: false,
      signers: [{ routingOrder: 1, signerRole: 'signer', name: 'No Delegate Signer', email: 'nodelegate@example.com' }],
    });
    const disabledRes = await callPublicDelegate(
      disabledEnv.links[0]!.token,
      'Attempt Delegate',
      'attempt@example.com',
      'Out of office',
    );
    expect(disabledRes).toMatchObject({
      status: 'error',
      code: 'SIGN_DELEGATION_DISABLED',
      httpStatus: 403,
    });

    // 2. OTP-gated signer cannot delegate before OTP verification, and succeeds once OTP is verified.
    const otpEnv = await setupActiveEnvelope({
      actorUserId: creatorMemberId,
      orgId,
      title: 'OTP Delegated Contract',
      routingMode: 'parallel',
      allowDelegation: true,
      signers: [
        {
          routingOrder: 1,
          signerRole: 'signer',
          name: 'Original Signer',
          email: 'orig@example.com',
          deliveryMode: 'link',
          requireEmailOtp: true,
        },
      ],
    });
    const origToken = otpEnv.links[0]!.token;
    const otpSignerId = otpEnv.signerIds[0]!;
    const otpFieldId = otpEnv.fieldIdsBySigner.get(otpSignerId)![0]!;

    // MODULE_OFF returns opaque not_found without leaking envelope state.
    await runtime.execute(
      'kernel.org.set_app',
      { module: 'sign', enabled: false },
      { actor: asUser(ownerId), orgId, idempotencyKey: randomUUID() },
    );
    expect(await callPublicDelegate(origToken, 'Delegate One', 'delegate1@example.com', 'Travelling')).toEqual({
      status: 'not_found',
    });
    await runtime.execute(
      'kernel.org.set_app',
      { module: 'sign', enabled: true },
      { actor: asUser(ownerId), orgId, idempotencyKey: randomUUID() },
    );

    // Unverified OTP -> 403 SIGN_OTP_REQUIRED.
    const otpBlocked = await callPublicDelegate(origToken, 'Delegate One', 'delegate1@example.com', 'Travelling');
    expect(otpBlocked).toMatchObject({
      status: 'error',
      code: 'SIGN_OTP_REQUIRED',
      httpStatus: 403,
    });

    // Verify OTP on origToken.
    await verifyOtpForToken(origToken, otpSignerId, orgId);

    // Self-delegation, suppressed email, and multi-mailbox header injection fail without consuming origToken.
    expect(await callPublicDelegate(origToken, 'Self Delegate', 'ORIG@example.com', 'Same mailbox')).toMatchObject({
      status: 'error',
      code: 'SIGN_DELEGATE_SAME_EMAIL',
      httpStatus: 422,
    });
    expect(await callPublicDelegate(origToken, 'Suppressed', 'suppressed@example.com', 'Bounced mailbox')).toMatchObject({
      status: 'error',
      code: 'SIGN_EMAIL_SUPPRESSED',
      httpStatus: 422,
    });
    expect(
      await callPublicDelegate(origToken, 'Header Inject', 'one@example.com, two@example.com', 'Bad mailbox'),
    ).toMatchObject({
      status: 'error',
      code: 'VALIDATION',
      httpStatus: 422,
    });

    // 3. Atomic FOR UPDATE concurrent delegation: 1 winner ('ok'), 1 replay ('already_used').
    const [raceA, raceB] = await Promise.all([
      callPublicDelegate(origToken, 'Delegate One', 'delegate1@example.com', 'Business trip week 47'),
      callPublicDelegate(origToken, 'Delegate One', 'delegate1@example.com', 'Business trip week 47'),
    ]);
    const statuses = [raceA.status, raceB.status].sort();
    expect(statuses).toEqual(['already_used', 'ok']);

    // Consumed delegator token is dead on public_record_view (NULL) and resolves as tokenUsed=true when allowUsed=true.
    expect(await callPublicView(origToken)).toBeNull();
    const resolvedUsed = await appPool!.query<{ v: Record<string, unknown> | null }>(
      'SELECT crove_sign.public_token_resolve($1, true) AS v',
      [hashSigningToken(origToken)],
    );
    expect(resolvedUsed.rows[0]?.v).toMatchObject({
      tokenUsed: true,
      delegationCount: 1,
      delegatedFromName: 'Original Signer',
    });

    // Sender notification mail (sign.delegated) queued to creatorMemberId has zero PII in mail_message.payload,
    // while sign.signer.delegated_mail_data hydrates the full delegation details in system context.
    const delegatedMails = await adminPool!.query<{ to_address: string; payload: Record<string, unknown> }>(
      `SELECT to_address, payload FROM crove_kernel.mail_message
       WHERE org_id = $1 AND source_id = $2 AND template_key = $3 ORDER BY created_at DESC LIMIT 1`,
      [orgId, otpEnv.envelopeId, SIGN_DELEGATED_MAIL_TEMPLATE],
    );
    expect(delegatedMails.rows).toHaveLength(1);
    expect(delegatedMails.rows[0]?.to_address).toBe('creator@example.com');
    const serializedPayload = JSON.stringify(delegatedMails.rows[0]?.payload ?? {});
    expect(serializedPayload).not.toContain('orig@example.com');
    expect(serializedPayload).not.toContain('delegate1@example.com');
    expect(serializedPayload).not.toContain('Original Signer');
    expect(serializedPayload).not.toContain('Delegate One');
    expect(serializedPayload).not.toContain('Business trip week 47');

    const hydratedMailData = await workerRuntime.execute<{
      orgSlug: string;
      fromName: string | null;
      fromEmail: string | null;
      delegateName: string;
      delegateEmail: string | null;
      reason: string | null;
    }>(
      'sign.signer.delegated_mail_data',
      { envelopeId: otpEnv.envelopeId, signerId: otpSignerId },
      { actor: asSystem('mail-worker'), orgId },
    );
    expect(hydratedMailData.orgSlug.length).toBeGreaterThan(0);
    expect(hydratedMailData).toMatchObject({
      fromName: 'Original Signer',
      fromEmail: 'orig@example.com',
      delegateName: 'Delegate One',
      delegateEmail: 'delegate1@example.com',
      reason: 'Business trip week 47',
    });

    const hop1InviteRow = await adminPool!.query<{ id: string }>(
      `SELECT id FROM crove_kernel.mail_message
       WHERE org_id = $1 AND source_id = $2 AND template_key = $3 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [orgId, otpSignerId, SIGN_INVITE_MAIL_TEMPLATE],
    );
    const hop1InviteMailId = hop1InviteRow.rows[0]!.id;

    // 4. Anti-relay cap at 2 delegations: hop 2 succeeds (delegation_count = 2), hop 3 fails with 409 SIGN_DELEGATION_LIMIT_REACHED.
    const hop1Link = await runtime.execute<{ token: string }>(
      'sign.signer.create_link',
      { envelopeId: otpEnv.envelopeId, signerId: otpSignerId },
      { actor: asUser(creatorMemberId), orgId },
    );
    await verifyOtpForToken(hop1Link.token, otpSignerId, orgId);

    const hop2Res = await callPublicDelegate(
      hop1Link.token,
      'Delegate Two',
      'delegate2@example.com',
      'Escalated to deputy director',
    );
    expect(hop2Res).toMatchObject({
      status: 'ok',
      delegateName: 'Delegate Two',
      delegationCount: 2,
    });

    // Stale hop-1 invite mail to delegate1@example.com returns null once hop-2 delegated to delegate2@example.com.
    const staleHop1Invite = await workerRuntime.execute(
      'sign.signer.mail_data',
      { envelopeId: otpEnv.envelopeId, signerId: otpSignerId, messageId: hop1InviteMailId },
      { actor: asSystem('mail-worker'), orgId },
    );
    expect(staleHop1Invite).toBeNull();

    const hop2Link = await runtime.execute<{ token: string }>(
      'sign.signer.create_link',
      { envelopeId: otpEnv.envelopeId, signerId: otpSignerId },
      { actor: asUser(creatorMemberId), orgId },
    );
    await verifyOtpForToken(hop2Link.token, otpSignerId, orgId);

    const hop3Blocked = await callPublicDelegate(
      hop2Link.token,
      'Delegate Three',
      'delegate3@example.com',
      'Third hop should be blocked',
    );
    expect(hop3Blocked).toMatchObject({
      status: 'error',
      code: 'SIGN_DELEGATION_LIMIT_REACHED',
      httpStatus: 409,
    });

    // Delegate Two's token was NOT consumed by the rejected 3rd-hop attempt, so Delegate Two can complete signing!
    const finalSubmit = await callPublicSubmit(hop2Link.token, otpFieldId, 'draw');
    expect(finalSubmit).toMatchObject({ status: 'ok', envelopeStatus: 'completed' });

    const otpSealData = await workerRuntime.query<SignSealJobData | null>(
      'sign.envelope.seal_job_data',
      { envelopeId: otpEnv.envelopeId },
      { actor: asSystem('sign-worker'), orgId },
    );
    expect(otpSealData).not.toBeNull();
    expect(otpSealData!.events.filter((e) => e.event_type === 'signer_delegated')).toHaveLength(2);
    expect(verifyEventChain(otpSealData!.events).valid).toBe(true);

    const otpCompletedIso = otpSealData!.envelope.completedAtIso ?? new Date().toISOString();
    const otpTipHash = otpSealData!.events.at(-1)!.event_hash;
    const otpCert = buildPdfSealCertificate({
      certificateCode: generateCertificateCode(otpEnv.envelopeId, otpCompletedIso, otpTipHash),
      envelopeTitle: otpSealData!.envelope.title,
      sourceSha256: otpSealData!.envelope.sourceSha256,
      completedAtIso: otpCompletedIso,
      eventChainTipHash: otpTipHash,
      signers: otpSealData!.signers,
      events: otpSealData!.events,
    });
    expect(otpCert.signers[0]).toMatchObject({
      name: 'Delegate Two',
      delegatedFromName: 'Delegate One',
      delegatedFromMaskedEmail: 'd***1@example.com',
      delegationCount: 2,
    });

    // 5. PDPL erasure scrubs delegated_from_* on unsealed voided envelopes while preserving completed/sealed records.
    const unsealedEnv = await setupActiveEnvelope({
      actorUserId: ownerId,
      orgId,
      title: 'Voided Delegated Envelope',
      routingMode: 'parallel',
      allowDelegation: true,
      signers: [{ routingOrder: 1, signerRole: 'signer', name: 'Erase Delegator', email: 'erase-delegator@example.com' }],
    });
    const unsealedDelRes = await callPublicDelegate(
      unsealedEnv.links[0]!.token,
      'Active Delegate Keep',
      'keep-delegate@example.com',
      'Leave of absence',
    );
    expect(unsealedDelRes).toMatchObject({ status: 'ok', delegationCount: 1 });

    await runtime.execute(
      'sign.envelope.void',
      { envelopeId: unsealedEnv.envelopeId, reason: 'Cancelled deal' },
      { actor: asUser(ownerId), orgId },
    );

    const foundBefore = await runtime.execute<PersonalDataResult>(
      'kernel.personal_data.find',
      { value: 'erase-delegator@example.com' },
      { actor: asMfa(ownerId), orgId },
    );
    const signSchema = ids.schema('sign');
    expect(foundBefore.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          column: `${signSchema}.signer.delegated_from_email`,
          handling: 'erase',
          rowId: unsealedEnv.signerIds[0]!,
        }),
      ]),
    );

    const erasedRes = await runtime.execute<PersonalDataErasure>(
      'kernel.personal_data.erase',
      { value: 'erase-delegator@example.com' },
      { actor: asMfa(ownerId), orgId },
    );
    expect(erasedRes.erased).toEqual(
      expect.arrayContaining([
        { column: `${signSchema}.signer.delegated_from_name`, rows: 1 },
        { column: `${signSchema}.signer.delegated_from_email`, rows: 1 },
        { column: `${signSchema}.signer.delegation_reason`, rows: 1 },
      ]),
    );

    const scrubbedRow = await adminPool!.query<{
      name: string;
      email: string | null;
      delegated_from_name: string | null;
      delegated_from_email: string | null;
      delegation_reason: string | null;
    }>(
      `SELECT name, email, delegated_from_name, delegated_from_email, delegation_reason
       FROM crove_sign.signer WHERE org_id = $1 AND id = $2`,
      [orgId, unsealedEnv.signerIds[0]!],
    );
    expect(scrubbedRow.rows[0]).toEqual({
      name: 'Active Delegate Keep',
      email: 'keep-delegate@example.com',
      delegated_from_name: null,
      delegated_from_email: null,
      delegation_reason: null,
    });

    // Completed envelope's delegated_from_email ('delegate1@example.com') is retained under statutory keep_record.
    const completedErase = await runtime.execute<PersonalDataErasure>(
      'kernel.personal_data.erase',
      { value: 'delegate1@example.com' },
      { actor: asMfa(ownerId), orgId },
    );
    expect(completedErase.kept).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ column: `${signSchema}.signer.delegated_from_email`, rows: 1 }),
      ]),
    );
  });
});
