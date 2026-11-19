// SPDX-License-Identifier: AGPL-3.0-only
// Self-contained PostgreSQL 17 security invariants for eSign Slice 1b (#3324):
//   - Role isolation on signing_token, signing_otp, enter_system_context, and internal definer helpers
//   - Atomic FOR UPDATE single-use replay guard on concurrent Promise.all submit & decline
//   - Sequential routing_order turn enforcement ('waiting' signer tokens fail closed)
//   - Cross-tenant and cross-signer field/token isolation
//   - Email OTP hash-only storage, 3/hr request throttle, 5-attempt lockout, and PDF/submit gate
//   - org_app_on('sign') MODULE_OFF opaque NULL/not_found parity across all 8 orgless SQL functions
//   - Mixed TS + SQL signing_event hash chain integrity (verifyEventChain) and zero secret leakage
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
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
import { mintContextToken, Runtime, contentGeneration, fileKey, sha256Hex } from '@ludy/kernel-runtime';
import {
  generateCertificateCode,
  generateRawSigningToken,
  hashSigningToken,
  signCommands,
  signManifest,
  signQueries,
  verifyEventChain,
  type SigningEventChainRow,
} from '../../src/index.ts';

type Pool = ReturnType<typeof createPool>;

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
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

suite('eSign Slice 1b public link & OTP PostgreSQL security invariants (#3324)', () => {
  const dbName = `crove_test_sign_inv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let adminPool: Pool | undefined;
  let appPool: Pool | undefined;
  let workerPool: Pool | undefined;
  let runtime: Runtime;
  let workerRuntime: Runtime;

  let orgA = '';
  let orgB = '';
  let userA = '';
  let userB = '';

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asSystem = (component: string) => ({ type: 'system' as const, component });
  const ipHash = sha256Hex('203.0.113.10');

  async function ingestPdf(actorUserId: string, orgId: string, tag: string): Promise<{ fileId: string; sha256: string }> {
    const bytes = Uint8Array.from(
      Buffer.from(`%PDF-1.4\n% sign-inv-${tag}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n`, 'utf8'),
    );
    const sha256 = sha256Hex(bytes);
    const { fileId } = await runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      {
        filename: `${tag}.pdf`,
        contentType: 'application/pdf',
        sizeBytes: bytes.byteLength,
        sha256,
        storageKey: fileKey(orgId, sha256),
        generation: contentGeneration(sha256),
        source: 'sign_document',
      },
      { actor: asUser(actorUserId), orgId },
    );
    return { fileId, sha256 };
  }

  async function setupActiveEnvelope(opts: {
    actorUserId: string;
    orgId: string;
    title: string;
    routingMode: 'sequential' | 'parallel';
    signers: Array<{
      routingOrder: number;
      signerRole: 'signer' | 'approver' | 'cc';
      name: string;
      email: string;
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
      { title: opts.title, sourceFileId: fileId, routingMode: opts.routingMode },
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
          roleLabel: s.signerRole === 'approver' ? 'Approver' : s.signerRole === 'cc' ? 'CC' : 'Signer',
          name: s.name,
          email: s.email,
          deliveryMode: s.deliveryMode ?? 'link',
          requireEmailOtp: Boolean(s.requireEmailOtp),
        },
        { actor: asUser(opts.actorUserId), orgId: opts.orgId },
      );
      signerIds.push(added.signerId);
      if (s.signerRole !== 'cc') {
        fieldInputs.push({
          signerId: added.signerId,
          fieldType: 'signature',
          pageNumber: 1,
          xNorm: 0.1 + i * 0.25,
          yNorm: 0.65,
          wNorm: 0.2,
          hNorm: 0.1,
          required: true,
        });
      }
    }

    await runtime.execute(
      'sign.field.set',
      { envelopeId: created.envelopeId, fields: fieldInputs },
      { actor: asUser(opts.actorUserId), orgId: opts.orgId },
    );
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

  beforeAll(async () => {
    const rootPool = createPool({ connectionString: ADMIN as string, max: 1 });
    await rootPool.query(`CREATE DATABASE ${dbName}`);
    await rootPool.end();

    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();

    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'inv-app-pw', crove_worker: 'inv-worker-pw' });

    const loginUrl = (user: string, pw: string) => {
      const u = new URL(adminUrl);
      u.username = user;
      u.password = pw;
      return u.toString();
    };

    adminPool = createPool({ connectionString: adminUrl, max: 2 });
    appPool = createPool({ connectionString: loginUrl('crove_app', 'inv-app-pw'), max: 6 });
    workerPool = createPool({ connectionString: loginUrl('crove_worker', 'inv-worker-pw'), max: 3 });

    const manifests = [kernelManifest.tables, signManifest.tables];
    const appDb = createDb(appPool);
    const workerDb = createDb(workerPool);

    runtime = new Runtime(appDb, { manifests })
      .register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) })
      .register({ commands: signCommands, queries: signQueries });

    workerRuntime = new Runtime(workerDb, { manifests })
      .register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) })
      .register({ commands: signCommands, queries: signQueries });

    userA = await upsertIdentity(appDb, { issuer: 'sign-inv', subject: 'owner-a', email: 'ownera@sign-inv.test', name: 'Owner A' });
    userB = await upsertIdentity(appDb, { issuer: 'sign-inv', subject: 'owner-b', email: 'ownerb@sign-inv.test', name: 'Owner B' });

    orgA = (await createOrg(runtime, asUser(userA), 'Cong ty Sign A')).orgId;
    orgB = (await createOrg(runtime, asUser(userB), 'Cong ty Sign B')).orgId;
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

  it('denies direct runtime role access to signing_token, signing_otp, enter_system_context, and internal definer helpers', async () => {
    interface QueryClient {
      query(sql: string, params?: unknown[]): Promise<unknown>;
    }
    async function expectInsufficientPrivilege(
      client: QueryClient,
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<void> {
      await client.query('SAVEPOINT sp_deny');
      let err: unknown;
      try {
        await client.query(sql, [...params]);
      } catch (caught) {
        err = caught;
      } finally {
        await client.query('ROLLBACK TO SAVEPOINT sp_deny');
        await client.query('RELEASE SAVEPOINT sp_deny');
      }
      expect(err).toBeDefined();
      expect((err as { code?: string }).code).toBe('42501');
    }

    const appClient = await appPool!.connect();
    try {
      await appClient.query('BEGIN');
      await expectInsufficientPrivilege(appClient, 'SELECT crove_kernel.enter_system_context($1::uuid)', [orgA]);
      await expectInsufficientPrivilege(appClient, 'SELECT crove_sign.mask_email($1::text)', ['signer@sign-inv.test']);
      await appClient.query('ROLLBACK');

      await appClient.query('BEGIN');
      const token = mintContextToken(process.env.CROVE_CONTEXT_TOKEN_KEY ?? '', {
        userId: userA,
        orgId: orgA,
        sessionId: null,
        aal: 'aal1',
        mfaAt: null,
      });
      await appClient.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgA, token]);
      await expectInsufficientPrivilege(appClient, 'SELECT id FROM crove_sign.signing_token');
      await expectInsufficientPrivilege(appClient, 'SELECT id FROM crove_sign.signing_otp');
      await expectInsufficientPrivilege(
        appClient,
        'SELECT crove_sign.public_otp_verified_at_for_token($1::uuid, $1::uuid, $1::uuid)',
        [randomUUID()],
      );
      await expectInsufficientPrivilege(appClient, 'SELECT crove_sign.mask_email($1::text)', ['signer@sign-inv.test']);
      await expectInsufficientPrivilege(
        appClient,
        "SELECT crove_sign.public_otp_issue($1::uuid, now() + interval '10 minutes', now())",
        [randomUUID()],
      );
      await expectInsufficientPrivilege(
        appClient,
        "SELECT crove_sign.public_mail_token_issue($1::uuid, $1::uuid, $1::uuid, now() + interval '1 day', now())",
        [randomUUID()],
      );
      await expectInsufficientPrivilege(
        appClient,
        "SELECT crove_sign.public_append_event($1::uuid, $1::uuid, $1::uuid, 'signer_viewed', 'signer', 'x', $2::text, '{}'::jsonb, NULL, NULL, now())",
        [orgA, 'a'.repeat(64)],
      );
      await expectInsufficientPrivilege(
        appClient,
        'SELECT crove_sign.public_keyed_ip_hash($1::uuid, $2::text)',
        [orgA, 'a'.repeat(64)],
      );
      await appClient.query('ROLLBACK');
    } finally {
      appClient.release();
    }

    const workerClient = await workerPool!.connect();
    try {
      await workerClient.query('BEGIN');
      await workerClient.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgA]);
      await expectInsufficientPrivilege(workerClient, 'SELECT id FROM crove_sign.signing_token');
      await expectInsufficientPrivilege(workerClient, 'SELECT id FROM crove_sign.signing_otp');
      await expectInsufficientPrivilege(
        workerClient,
        'SELECT crove_sign.public_otp_verified_at_for_token($1::uuid, $1::uuid, $1::uuid)',
        [randomUUID()],
      );
      await expectInsufficientPrivilege(workerClient, 'SELECT crove_sign.mask_email($1::text)', ['signer@sign-inv.test']);
      await expectInsufficientPrivilege(
        workerClient,
        "SELECT crove_sign.public_append_event($1::uuid, $1::uuid, $1::uuid, 'signer_viewed', 'signer', 'x', $2::text, '{}'::jsonb, NULL, NULL, now())",
        [orgA, 'a'.repeat(64)],
      );
      await expectInsufficientPrivilege(
        workerClient,
        'SELECT crove_sign.public_keyed_ip_hash($1::uuid, $2::text)',
        [orgA, 'a'.repeat(64)],
      );
      await workerClient.query('ROLLBACK');
    } finally {
      workerClient.release();
    }
  });

  it('enforces sequential turns, OTP brute-force lockout, cross-tenant field rejection, Promise.all single-use submit, and hash-chain integrity', async () => {
    const envA = await setupActiveEnvelope({
      actorUserId: userA,
      orgId: orgA,
      title: 'Sequential Contract A',
      routingMode: 'sequential',
      signers: [
        { routingOrder: 1, signerRole: 'signer', name: 'Signer One', email: 'signer1@sign-inv.test', deliveryMode: 'link', requireEmailOtp: true },
        { routingOrder: 2, signerRole: 'signer', name: 'Signer Two', email: 'signer2@sign-inv.test', deliveryMode: 'email', requireEmailOtp: false },
        { routingOrder: 3, signerRole: 'cc', name: 'Legal CC', email: 'cc@sign-inv.test', requireEmailOtp: false },
      ],
    });
    const envB = await setupActiveEnvelope({
      actorUserId: userB,
      orgId: orgB,
      title: 'Contract B',
      routingMode: 'parallel',
      signers: [{ routingOrder: 1, signerRole: 'signer', name: 'Signer B', email: 'b@sign-inv.test', requireEmailOtp: false }],
    });

    const signer1Id = envA.signerIds[0]!;
    const signer2Id = envA.signerIds[1]!;
    const field1Id = envA.fieldIdsBySigner.get(signer1Id)![0]!;
    const field2Id = envA.fieldIdsBySigner.get(signer2Id)![0]!;
    const fieldBId = envB.fieldIdsBySigner.get(envB.signerIds[0]!)![0]!;

    const rawToken1 = envA.links[0]!.token;
    const hash1 = hashSigningToken(rawToken1);

    // Belt-and-suspenders: even if a token exists in DB while Signer 2 is 'waiting', every orgless RPC denies Signer 2.
    const rawToken2Waiting = generateRawSigningToken();
    const hash2Waiting = hashSigningToken(rawToken2Waiting);
    await adminPool!.query(
      `INSERT INTO crove_sign.signing_token (org_id, envelope_id, signer_id, token_sha256, expires_at, created_by)
       VALUES ($1, $2, $3, $4, now() + interval '7 days', $5)`,
      [orgA, envA.envelopeId, signer2Id, hash2Waiting, userA],
    );

    const waitingResolve = await appPool!.query<{ v: unknown }>('SELECT crove_sign.public_token_resolve($1, false) AS v', [hash2Waiting]);
    expect(waitingResolve.rows[0]?.v).toBeNull();
    const waitingPdf = await appPool!.query<{ v: unknown }>('SELECT crove_sign.public_pdf_source($1) AS v', [hash2Waiting]);
    expect(waitingPdf.rows[0]?.v).toBeNull();
    const waitingView = await appPool!.query<{ v: unknown }>('SELECT crove_sign.public_record_view($1, $2, $3) AS v', [
      hash2Waiting,
      ipHash,
      'InvTest/1.0',
    ]);
    expect(waitingView.rows[0]?.v).toBeNull();
    const waitingOtpReq = await appPool!.query<{ v: unknown }>('SELECT crove_sign.public_request_otp($1, $2) AS v', [
      hash2Waiting,
      DEFAULT_MESSAGE_ID_DOMAIN,
    ]);
    expect(waitingOtpReq.rows[0]?.v).toBeNull();
    const waitingSubmit = await appPool!.query<{ v: { status: string } }>(
      "SELECT crove_sign.public_submit($1, true, 'draw', NULL, $2::jsonb, $3, 'InvTest/1.0', $4) AS v",
      [hash2Waiting, JSON.stringify([{ fieldId: field2Id, signaturePngBase64: VALID_PNG_BASE64 }]), ipHash, DEFAULT_MESSAGE_ID_DOMAIN],
    );
    expect(waitingSubmit.rows[0]?.v).toEqual({ status: 'not_found' });
    const waitingDecline = await appPool!.query<{ v: { status: string } }>(
      "SELECT crove_sign.public_decline($1, 'too early', $2, 'InvTest/1.0') AS v",
      [hash2Waiting, ipHash],
    );
    expect(waitingDecline.rows[0]?.v).toEqual({ status: 'not_found' });

    // Signer 1 views before OTP: gets masked otp_required state and PDF source hides blob keys.
    const viewBeforeOtp = await appPool!.query<{ v: Record<string, unknown> }>(
      'SELECT crove_sign.public_record_view($1, $2, $3) AS v',
      [hash1, ipHash, 'InvTest/1.0'],
    );
    expect(viewBeforeOtp.rows[0]?.v).toMatchObject({ state: 'otp_required', orgName: 'Cong ty Sign A' });
    expect(String(viewBeforeOtp.rows[0]?.v.maskedEmail)).not.toContain('signer1');
    expect(viewBeforeOtp.rows[0]?.v.fields).toBeUndefined();

    const pdfBeforeOtp = await appPool!.query<{ v: Record<string, unknown> }>(
      'SELECT crove_sign.public_pdf_source($1) AS v',
      [hash1],
    );
    expect(pdfBeforeOtp.rows[0]?.v).toEqual({ orgId: orgA, otpRequired: true });

    // Submit and decline both blocked with 403 SIGN_OTP_REQUIRED until OTP verified.
    const submitBeforeOtp = await appPool!.query<{ v: Record<string, unknown> }>(
      "SELECT crove_sign.public_submit($1, true, 'draw', NULL, $2::jsonb, $3, 'InvTest/1.0', $4) AS v",
      [hash1, JSON.stringify([{ fieldId: field1Id, signaturePngBase64: VALID_PNG_BASE64 }]), ipHash, DEFAULT_MESSAGE_ID_DOMAIN],
    );
    expect(submitBeforeOtp.rows[0]?.v).toMatchObject({ status: 'error', code: 'SIGN_OTP_REQUIRED', httpStatus: 403 });

    const declineBeforeOtp = await appPool!.query<{ v: Record<string, unknown> }>(
      "SELECT crove_sign.public_decline($1, 'before otp', $2, 'InvTest/1.0') AS v",
      [hash1, ipHash],
    );
    expect(declineBeforeOtp.rows[0]?.v).toMatchObject({ status: 'error', code: 'SIGN_OTP_REQUIRED', httpStatus: 403 });

    // OTP request #1 -> worker sets hash in memory & DB stores only otp_sha256.
    const otpReq1 = await appPool!.query<{ v: Record<string, unknown> }>(
      'SELECT crove_sign.public_request_otp($1, $2) AS v',
      [hash1, DEFAULT_MESSAGE_ID_DOMAIN],
    );
    expect(otpReq1.rows[0]?.v).toMatchObject({ status: 'ok', sent: true, expiresInMinutes: 10 });

    const otpRow1 = await adminPool!.query<{ id: string; otp_sha256: string | null }>(
      'SELECT id, otp_sha256 FROM crove_sign.signing_otp WHERE org_id = $1 AND signer_id = $2 ORDER BY created_at DESC LIMIT 1',
      [orgA, signer1Id],
    );
    expect(otpRow1.rows[0]?.otp_sha256).toBeNull();

    const otpMailData1 = await workerRuntime.execute<{ code: string }>(
      'sign.public.otp_mail_data',
      { signerId: signer1Id, otpId: otpRow1.rows[0]!.id },
      { actor: asSystem('mail-worker'), orgId: orgA },
    );
    expect(otpMailData1.code).toMatch(/^\d{6}$/);

    // 5 wrong OTP guesses lock this challenge even if the real 6th attempt uses the exact OTP code.
    for (let attempt = 1; attempt <= 5; attempt++) {
      const wrongCode = otpMailData1.code === '000000' ? '999999' : '000000';
      const vRes = await appPool!.query<{ v: { ok: boolean; locked: boolean; attemptsRemaining: number } }>(
        'SELECT crove_sign.public_verify_otp($1, $2, $3, $4) AS v',
        [hash1, wrongCode, ipHash, 'InvTest/1.0'],
      );
      expect(vRes.rows[0]?.v).toEqual({
        ok: false,
        locked: attempt === 5,
        attemptsRemaining: 5 - attempt,
      });
    }
    const afterLockWithReal = await appPool!.query<{ v: { ok: boolean; locked: boolean; attemptsRemaining: number } }>(
      'SELECT crove_sign.public_verify_otp($1, $2, $3, $4) AS v',
      [hash1, otpMailData1.code, ipHash, 'InvTest/1.0'],
    );
    expect(afterLockWithReal.rows[0]?.v).toEqual({ ok: false, locked: true, attemptsRemaining: 0 });

    // Request OTP #2 & #3 -> 4th in 1h hits 429 SIGN_OTP_RATE_LIMITED.
    const otpReq2 = await appPool!.query<{ v: Record<string, unknown> }>('SELECT crove_sign.public_request_otp($1, $2) AS v', [
      hash1,
      DEFAULT_MESSAGE_ID_DOMAIN,
    ]);
    expect(otpReq2.rows[0]?.v.status).toBe('ok');
    const otpReq3 = await appPool!.query<{ v: Record<string, unknown> }>('SELECT crove_sign.public_request_otp($1, $2) AS v', [
      hash1,
      DEFAULT_MESSAGE_ID_DOMAIN,
    ]);
    expect(otpReq3.rows[0]?.v.status).toBe('ok');
    const otpReq4 = await appPool!.query<{ v: Record<string, unknown> }>('SELECT crove_sign.public_request_otp($1, $2) AS v', [
      hash1,
      DEFAULT_MESSAGE_ID_DOMAIN,
    ]);
    expect(otpReq4.rows[0]?.v).toMatchObject({ status: 'error', code: 'SIGN_OTP_RATE_LIMITED', httpStatus: 429 });

    const otpRow3 = await adminPool!.query<{ id: string }>(
      'SELECT id FROM crove_sign.signing_otp WHERE org_id = $1 AND signer_id = $2 ORDER BY created_at DESC LIMIT 1',
      [orgA, signer1Id],
    );
    const otpMailData3 = await workerRuntime.execute<{ code: string }>(
      'sign.public.otp_mail_data',
      { signerId: signer1Id, otpId: otpRow3.rows[0]!.id },
      { actor: asSystem('mail-worker'), orgId: orgA },
    );

    const verifiedOtp = await appPool!.query<{ v: { ok: boolean; locked: boolean } }>(
      'SELECT crove_sign.public_verify_otp($1, $2, $3, $4) AS v',
      [hash1, otpMailData3.code, ipHash, 'InvTest/1.0'],
    );
    expect(verifiedOtp.rows[0]?.v).toMatchObject({ ok: true, locked: false });

    // Now PDF source exposes blob coordinates and view reveals only Signer 1's fields.
    const pdfAfterOtp = await appPool!.query<{ v: Record<string, unknown> }>('SELECT crove_sign.public_pdf_source($1) AS v', [
      hash1,
    ]);
    expect(pdfAfterOtp.rows[0]?.v).toMatchObject({ orgId: orgA, otpRequired: false });
    expect(typeof pdfAfterOtp.rows[0]?.v.storageKey).toBe('string');

    const viewAfterOtp = await appPool!.query<{ v: { state: string; fields: Array<{ id: string }> } }>(
      'SELECT crove_sign.public_record_view($1, $2, $3) AS v',
      [hash1, ipHash, 'InvTest/1.0'],
    );
    expect(viewAfterOtp.rows[0]?.v.state).toBe('ready');
    expect(viewAfterOtp.rows[0]?.v.fields.map((f) => f.id)).toEqual([field1Id]);

    // Submitting a field from another signer in same org or another tenant fails 422 SIGN_INVALID_FIELD without consuming token.
    const crossSigner = await appPool!.query<{ v: Record<string, unknown> }>(
      "SELECT crove_sign.public_submit($1, true, 'draw', NULL, $2::jsonb, $3, 'InvTest/1.0', $4) AS v",
      [hash1, JSON.stringify([{ fieldId: field2Id, signaturePngBase64: VALID_PNG_BASE64 }]), ipHash, DEFAULT_MESSAGE_ID_DOMAIN],
    );
    expect(crossSigner.rows[0]?.v).toMatchObject({ status: 'error', code: 'SIGN_INVALID_FIELD', httpStatus: 422 });

    const crossTenant = await appPool!.query<{ v: Record<string, unknown> }>(
      "SELECT crove_sign.public_submit($1, true, 'draw', NULL, $2::jsonb, $3, 'InvTest/1.0', $4) AS v",
      [hash1, JSON.stringify([{ fieldId: fieldBId, signaturePngBase64: VALID_PNG_BASE64 }]), ipHash, DEFAULT_MESSAGE_ID_DOMAIN],
    );
    expect(crossTenant.rows[0]?.v).toMatchObject({ status: 'error', code: 'SIGN_INVALID_FIELD', httpStatus: 422 });

    const dupMixedCase = await appPool!.query<{ v: Record<string, unknown> }>(
      "SELECT crove_sign.public_submit($1, true, 'draw', NULL, $2::jsonb, $3, 'InvTest/1.0', $4) AS v",
      [
        hash1,
        JSON.stringify([
          { fieldId: field1Id, signaturePngBase64: VALID_PNG_BASE64 },
          { fieldId: field1Id.toUpperCase(), signaturePngBase64: VALID_PNG_BASE64 },
        ]),
        ipHash,
        DEFAULT_MESSAGE_ID_DOMAIN,
      ],
    );
    expect(dupMixedCase.rows[0]?.v).toMatchObject({ status: 'error', code: 'SIGN_DUPLICATE_FIELD', httpStatus: 422 });

    // Concurrent Promise.all single-use submit lock: strictly 1 commits and 1 gets already_used.
    const submitPayload = JSON.stringify([{ fieldId: field1Id, signaturePngBase64: VALID_PNG_BASE64 }]);
    const [race1, race2] = await Promise.all([
      appPool!.query<{ v: { status: string; completed?: boolean; envelopeStatus?: string } }>(
        "SELECT crove_sign.public_submit($1, true, 'draw', NULL, $2::jsonb, $3, 'InvTest/1.0', $4) AS v",
        [hash1, submitPayload, ipHash, DEFAULT_MESSAGE_ID_DOMAIN],
      ),
      appPool!.query<{ v: { status: string; completed?: boolean; envelopeStatus?: string } }>(
        "SELECT crove_sign.public_submit($1, true, 'draw', NULL, $2::jsonb, $3, 'InvTest/1.0', $4) AS v",
        [hash1, submitPayload, ipHash, DEFAULT_MESSAGE_ID_DOMAIN],
      ),
    ]);
    const raceStatuses = [race1.rows[0]!.v.status, race2.rows[0]!.v.status].sort();
    expect(raceStatuses).toEqual(['already_used', 'ok']);

    // Sequential turn advanced: Signer 2 is now 'pending' and queued a 'sign.invite' mail row.
    const signer2Row = await adminPool!.query<{ status: string }>(
      'SELECT status FROM crove_sign.signer WHERE org_id = $1 AND id = $2',
      [orgA, signer2Id],
    );
    expect(signer2Row.rows[0]?.status).toBe('pending');
    const invite2Mail = await adminPool!.query<{ template_key: string; payload: Record<string, unknown> }>(
      "SELECT template_key, payload FROM crove_kernel.mail_message WHERE org_id = $1 AND source_id = $2 AND template_key = 'sign.invite'",
      [orgA, signer2Id],
    );
    expect(invite2Mail.rows).toHaveLength(1);

    // Now Signer 2's pre-minted token resolves cleanly and completes the envelope + queues pdf_seal.
    const readyView2 = await appPool!.query<{ v: { state: string } }>(
      'SELECT crove_sign.public_record_view($1, $2, $3) AS v',
      [hash2Waiting, ipHash, 'InvTest/1.0'],
    );
    expect(readyView2.rows[0]?.v.state).toBe('ready');

    const submit2 = await appPool!.query<{ v: { status: string; envelopeStatus: string; completed: boolean } }>(
      "SELECT crove_sign.public_submit($1, true, 'draw', NULL, $2::jsonb, $3, 'InvTest/1.0', $4) AS v",
      [hash2Waiting, JSON.stringify([{ fieldId: field2Id, signaturePngBase64: VALID_PNG_BASE64 }]), ipHash, DEFAULT_MESSAGE_ID_DOMAIN],
    );
    expect(submit2.rows[0]?.v).toMatchObject({ status: 'ok', envelopeStatus: 'completed', completed: true });

    const outboxSeal = await adminPool!.query<{ type: string; payload: { envelopeId: string } }>(
      "SELECT type, payload FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'sign.envelope.seal_queued'",
      [orgA],
    );
    expect(outboxSeal.rows.some((r) => r.payload.envelopeId === envA.envelopeId)).toBe(true);

    // Mixed TS commands + SQL definer events preserve verifyEventChain integrity.
    const eventRows = await adminPool!.query<SigningEventChainRow>(
      `SELECT id, org_id, envelope_id, signer_id, seq, event_type, actor_type, actor_id, actor_label,
              ip_hash, user_agent, document_sha256, prev_event_hash, event_hash, payload_json, occurred_at
       FROM crove_sign.signing_event
       WHERE org_id = $1 AND envelope_id = $2
       ORDER BY seq ASC`,
      [orgA, envA.envelopeId],
    );
    expect(verifyEventChain(eventRows.rows)).toMatchObject({ valid: true, brokenSeq: null, reason: null });

    // Keyed HMAC-SHA256 IP hashing: deterministic within an org, distinct from unkeyed input, and unlinkable across orgs.
    const keyedOrgAIpHashes = new Set(eventRows.rows.map((r) => r.ip_hash).filter((h): h is string => h !== null));
    expect(keyedOrgAIpHashes.size).toBe(1);
    const keyedOrgAIp = [...keyedOrgAIpHashes][0]!;
    expect(keyedOrgAIp).toMatch(/^[0-9a-f]{64}$/);
    expect(keyedOrgAIp).not.toBe(ipHash);

    const envOrgBCheck = await setupActiveEnvelope({
      actorUserId: userB,
      orgId: orgB,
      title: 'Cross-Org IP HMAC Check',
      routingMode: 'parallel',
      signers: [{ routingOrder: 1, signerRole: 'signer', name: 'Signer B', email: 'hmac-b@sign-inv.test', requireEmailOtp: false }],
    });
    await appPool!.query('SELECT crove_sign.public_record_view($1, $2, $3)', [
      hashSigningToken(envOrgBCheck.links[0]!.token),
      ipHash,
      'InvTest/1.0',
    ]);
    const keyedOrgBIpRow = await adminPool!.query<{ signer_ip_hash: string | null }>(
      'SELECT signer_ip_hash FROM crove_sign.signer WHERE org_id = $1 AND envelope_id = $2',
      [orgB, envOrgBCheck.envelopeId],
    );
    const keyedOrgBIp = keyedOrgBIpRow.rows[0]?.signer_ip_hash ?? '';
    expect(keyedOrgBIp).toMatch(/^[0-9a-f]{64}$/);
    expect(keyedOrgBIp).not.toBe(ipHash);
    expect(keyedOrgBIp).not.toBe(keyedOrgAIp);

    // Zero raw tokens or OTP codes persist in any DB table.
    const tableDumps = await Promise.all([
      adminPool!.query('SELECT * FROM crove_sign.signing_token WHERE org_id = $1', [orgA]),
      adminPool!.query('SELECT * FROM crove_sign.signing_otp WHERE org_id = $1', [orgA]),
      adminPool!.query('SELECT * FROM crove_sign.signing_event WHERE org_id = $1', [orgA]),
      adminPool!.query('SELECT * FROM crove_kernel.audit_event WHERE org_id = $1', [orgA]),
      adminPool!.query('SELECT * FROM crove_kernel.outbox_event WHERE org_id = $1', [orgA]),
      adminPool!.query('SELECT * FROM crove_kernel.mail_message WHERE org_id = $1', [orgA]),
    ]);
    const serialized = JSON.stringify(tableDumps.map((r) => r.rows));
    for (const secret of [rawToken1, rawToken2Waiting, otpMailData1.code, otpMailData3.code]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('serializes concurrent Promise.all public_decline and revokes all remaining envelope tokens', async () => {
    const envDecline = await setupActiveEnvelope({
      actorUserId: userB,
      orgId: orgB,
      title: 'Parallel Decline B',
      routingMode: 'parallel',
      signers: [
        { routingOrder: 1, signerRole: 'signer', name: 'B One', email: 'b1@sign-inv.test', requireEmailOtp: false },
        { routingOrder: 1, signerRole: 'signer', name: 'B Two', email: 'b2@sign-inv.test', requireEmailOtp: false },
      ],
    });
    const hashA = hashSigningToken(envDecline.links[0]!.token);
    const hashB = hashSigningToken(envDecline.links[1]!.token);

    const [d1, d2] = await Promise.all([
      appPool!.query<{ v: { status: string; envelopeStatus?: string } }>(
        "SELECT crove_sign.public_decline($1, 'Terms rejected', $2, 'InvTest/1.0') AS v",
        [hashA, ipHash],
      ),
      appPool!.query<{ v: { status: string; envelopeStatus?: string } }>(
        "SELECT crove_sign.public_decline($1, 'Terms rejected', $2, 'InvTest/1.0') AS v",
        [hashA, ipHash],
      ),
    ]);
    expect([d1.rows[0]!.v.status, d2.rows[0]!.v.status].sort()).toEqual(['already_used', 'ok']);

    const tokB = await adminPool!.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM crove_sign.signing_token WHERE token_sha256 = $1',
      [hashB],
    );
    expect(tokB.rows[0]?.revoked_at).not.toBeNull();
    const viewB = await appPool!.query<{ v: unknown }>('SELECT crove_sign.public_record_view($1, $2, $3) AS v', [
      hashB,
      ipHash,
      'InvTest/1.0',
    ]);
    expect(viewB.rows[0]?.v).toBeNull();

    const eventRows = await adminPool!.query<SigningEventChainRow>(
      `SELECT id, org_id, envelope_id, signer_id, seq, event_type, actor_type, actor_id, actor_label,
              ip_hash, user_agent, document_sha256, prev_event_hash, event_hash, payload_json, occurred_at
       FROM crove_sign.signing_event
       WHERE org_id = $1 AND envelope_id = $2
       ORDER BY seq ASC`,
      [orgB, envDecline.envelopeId],
    );
    expect(verifyEventChain(eventRows.rows)).toMatchObject({ valid: true, brokenSeq: null, reason: null });
  });

  it('fails closed identically (MODULE_OFF) across all 8 orgless SQL functions when sign app is disabled', async () => {
    const activeEnv = await setupActiveEnvelope({
      actorUserId: userB,
      orgId: orgB,
      title: 'Toggle Test B',
      routingMode: 'parallel',
      signers: [{ routingOrder: 1, signerRole: 'signer', name: 'Toggle B', email: 'toggle@sign-inv.test', requireEmailOtp: true }],
    });
    const hashActive = hashSigningToken(activeEnv.links[0]!.token);

    // Also create a sealed completed envelope in orgB to cover public_verify_certificate.
    const sealedEnv = await setupActiveEnvelope({
      actorUserId: userB,
      orgId: orgB,
      title: 'Sealed Toggle B',
      routingMode: 'parallel',
      signers: [{ routingOrder: 1, signerRole: 'signer', name: 'Sealed S', email: 'sealed@sign-inv.test', requireEmailOtp: false }],
    });
    const sealedSignerField = sealedEnv.fieldIdsBySigner.get(sealedEnv.signerIds[0]!)![0]!;
    const sealedHashToken = hashSigningToken(sealedEnv.links[0]!.token);
    await appPool!.query(
      "SELECT crove_sign.public_submit($1, true, 'draw', NULL, $2::jsonb, $3, 'InvTest/1.0', $4)",
      [sealedHashToken, JSON.stringify([{ fieldId: sealedSignerField, signaturePngBase64: VALID_PNG_BASE64 }]), ipHash, DEFAULT_MESSAGE_ID_DOMAIN],
    );
    const certSha = sha256Hex('sealed-pdf-bytes-toggle');
    const certCode = generateCertificateCode(sealedEnv.envelopeId, '2027-01-05T00:00:00.000Z', certSha);
    await adminPool!.query(
      `UPDATE crove_sign.envelope
       SET seal_status = 'sealed',
           sealed_sha256 = $2,
           certificate_code = $3
       WHERE org_id = $1 AND id = $4`,
      [orgB, certSha, certCode, sealedEnv.envelopeId],
    );

    const beforeDisableCert = await appPool!.query<{ v: Record<string, unknown> | null }>(
      'SELECT crove_sign.public_verify_certificate($1, $2) AS v',
      [certCode, certSha],
    );
    expect(beforeDisableCert.rows[0]?.v).toMatchObject({ orgId: orgB, matched: true });

    await runtime.execute(
      'kernel.org.set_app',
      { module: 'sign', enabled: false },
      { actor: asUser(userB), orgId: orgB, idempotencyKey: randomUUID() },
    );

    const probe = async (h: string) => {
      const [resolve, pdf, view, otpReq, otpVer, submit, decline, cert] = await Promise.all([
        appPool!.query<{ v: unknown }>('SELECT crove_sign.public_token_resolve($1, false) AS v', [h]),
        appPool!.query<{ v: unknown }>('SELECT crove_sign.public_pdf_source($1) AS v', [h]),
        appPool!.query<{ v: unknown }>('SELECT crove_sign.public_record_view($1, $2, $3) AS v', [h, ipHash, 'InvTest/1.0']),
        appPool!.query<{ v: unknown }>('SELECT crove_sign.public_request_otp($1, $2) AS v', [h, DEFAULT_MESSAGE_ID_DOMAIN]),
        appPool!.query<{ v: unknown }>('SELECT crove_sign.public_verify_otp($1, $2, $3, $4) AS v', [h, '123456', ipHash, 'InvTest/1.0']),
        appPool!.query<{ v: unknown }>("SELECT crove_sign.public_submit($1, true, 'draw', NULL, '[]'::jsonb, $2, 'InvTest/1.0', $3) AS v", [
          h,
          ipHash,
          DEFAULT_MESSAGE_ID_DOMAIN,
        ]),
        appPool!.query<{ v: unknown }>("SELECT crove_sign.public_decline($1, 'off', $2, 'InvTest/1.0') AS v", [h, ipHash]),
        appPool!.query<{ v: unknown }>('SELECT crove_sign.public_verify_certificate($1, $2) AS v', [certCode, certSha]),
      ]);
      return [
        resolve.rows[0]?.v,
        pdf.rows[0]?.v,
        view.rows[0]?.v,
        otpReq.rows[0]?.v,
        otpVer.rows[0]?.v,
        submit.rows[0]?.v,
        decline.rows[0]?.v,
        cert.rows[0]?.v,
      ];
    };

    const bogusHash = sha256Hex('nonexistent-sign-token');
    const disabledOutputs = await probe(hashActive);
    expect(disabledOutputs).toEqual([null, null, null, null, null, { status: 'not_found' }, { status: 'not_found' }, null]);
    expect(disabledOutputs.slice(0, 7)).toEqual((await probe(bogusHash)).slice(0, 7));

    // Re-enabling restores opaque resolution.
    await runtime.execute(
      'kernel.org.set_app',
      { module: 'sign', enabled: true },
      { actor: asUser(userB), orgId: orgB, idempotencyKey: randomUUID() },
    );
    const afterEnableCert = await appPool!.query<{ v: Record<string, unknown> | null }>(
      'SELECT crove_sign.public_verify_certificate($1, $2) AS v',
      [certCode, certSha],
    );
    expect(afterEnableCert.rows[0]?.v).toMatchObject({ orgId: orgB, matched: true });
  });

  it('resets OTP verification trust when a signer link is rotated via sign.signer.create_link', async () => {
    const env = await setupActiveEnvelope({
      actorUserId: userA,
      orgId: orgA,
      title: 'OTP Rotation Reset',
      routingMode: 'parallel',
      signers: [{ routingOrder: 1, signerRole: 'signer', name: 'Rotated Signer', email: 'rotate@sign-inv.test', deliveryMode: 'link', requireEmailOtp: true }],
    });
    const signerId = env.signerIds[0]!;
    const fieldId = env.fieldIdsBySigner.get(signerId)![0]!;
    const token1 = env.links[0]!.token;
    const hash1 = hashSigningToken(token1);

    const otpReq1 = await appPool!.query<{ v: { status: string; sent: boolean } }>(
      'SELECT crove_sign.public_request_otp($1, $2) AS v',
      [hash1, DEFAULT_MESSAGE_ID_DOMAIN],
    );
    expect(otpReq1.rows[0]?.v).toMatchObject({ status: 'ok', sent: true });
    const otpRow1 = await adminPool!.query<{ id: string }>(
      'SELECT id FROM crove_sign.signing_otp WHERE org_id = $1 AND signer_id = $2 ORDER BY created_at DESC LIMIT 1',
      [orgA, signerId],
    );
    const otpMail1 = await workerRuntime.execute<{ code: string }>(
      'sign.public.otp_mail_data',
      { signerId, otpId: otpRow1.rows[0]!.id },
      { actor: asSystem('mail-worker'), orgId: orgA },
    );
    const otpVerify1 = await appPool!.query<{ v: { ok: boolean } }>(
      'SELECT crove_sign.public_verify_otp($1, $2, $3, $4) AS v',
      [hash1, otpMail1.code, ipHash, 'InvTest/1.0'],
    );
    expect(otpVerify1.rows[0]?.v.ok).toBe(true);

    const readyPdf1 = await appPool!.query<{ v: { otpRequired: boolean } }>(
      'SELECT crove_sign.public_pdf_source($1) AS v',
      [hash1],
    );
    expect(readyPdf1.rows[0]?.v.otpRequired).toBe(false);

    // Owner rotates the signing link before submission: Link 2 must NOT inherit Link 1's OTP verification.
    const rotated = await runtime.execute<{ token: string }>(
      'sign.signer.create_link',
      { envelopeId: env.envelopeId, signerId },
      { actor: asUser(userA), orgId: orgA },
    );
    const hash2 = hashSigningToken(rotated.token);
    expect(hash2).not.toBe(hash1);

    expect((await appPool!.query<{ v: unknown }>('SELECT crove_sign.public_token_resolve($1, false) AS v', [hash1])).rows[0]?.v).toBeNull();
    expect((await appPool!.query<{ v: { otpRequired: boolean } }>('SELECT crove_sign.public_pdf_source($1) AS v', [hash2])).rows[0]?.v).toEqual({
      orgId: orgA,
      otpRequired: true,
    });
    expect((await appPool!.query<{ v: { state: string } }>('SELECT crove_sign.public_record_view($1, $2, $3) AS v', [hash2, ipHash, 'InvTest/1.0'])).rows[0]?.v).toMatchObject({
      state: 'otp_required',
    });
    const submitBlocked = await appPool!.query<{ v: { status: string; code: string } }>(
      "SELECT crove_sign.public_submit($1, true, 'draw', NULL, $2::jsonb, $3, 'InvTest/1.0', $4) AS v",
      [hash2, JSON.stringify([{ fieldId, signaturePngBase64: VALID_PNG_BASE64 }]), ipHash, DEFAULT_MESSAGE_ID_DOMAIN],
    );
    expect(submitBlocked.rows[0]?.v).toMatchObject({ status: 'error', code: 'SIGN_OTP_REQUIRED' });

    // Completing a fresh OTP challenge on Link 2 unblocks Link 2 cleanly.
    const otpReq2 = await appPool!.query<{ v: { status: string; sent: boolean } }>(
      'SELECT crove_sign.public_request_otp($1, $2) AS v',
      [hash2, DEFAULT_MESSAGE_ID_DOMAIN],
    );
    expect(otpReq2.rows[0]?.v).toMatchObject({ status: 'ok', sent: true });
    const otpRow2 = await adminPool!.query<{ id: string }>(
      'SELECT id FROM crove_sign.signing_otp WHERE org_id = $1 AND signer_id = $2 ORDER BY created_at DESC LIMIT 1',
      [orgA, signerId],
    );
    const otpMail2 = await workerRuntime.execute<{ code: string }>(
      'sign.public.otp_mail_data',
      { signerId, otpId: otpRow2.rows[0]!.id },
      { actor: asSystem('mail-worker'), orgId: orgA },
    );
    expect(
      (
        await appPool!.query<{ v: { ok: boolean } }>('SELECT crove_sign.public_verify_otp($1, $2, $3, $4) AS v', [
          hash2,
          otpMail2.code,
          ipHash,
          'InvTest/1.0',
        ])
      ).rows[0]?.v.ok,
    ).toBe(true);
    const submitAfterOtp2 = await appPool!.query<{ v: { status: string; completed: boolean } }>(
      "SELECT crove_sign.public_submit($1, true, 'draw', NULL, $2::jsonb, $3, 'InvTest/1.0', $4) AS v",
      [hash2, JSON.stringify([{ fieldId, signaturePngBase64: VALID_PNG_BASE64 }]), ipHash, DEFAULT_MESSAGE_ID_DOMAIN],
    );
    expect(submitAfterOtp2.rows[0]?.v).toMatchObject({ status: 'ok', completed: true });
  });

  it('locks concurrent cross-signer submit and decline without deadlocks and advances envelope version monotonically', async () => {
    const envSubmitRace = await setupActiveEnvelope({
      actorUserId: userA,
      orgId: orgA,
      title: 'Parallel Submit Lock Order',
      routingMode: 'parallel',
      signers: [
        { routingOrder: 1, signerRole: 'signer', name: 'Parallel A', email: 'pa@sign-inv.test', deliveryMode: 'link' },
        { routingOrder: 1, signerRole: 'signer', name: 'Parallel B', email: 'pb@sign-inv.test', deliveryMode: 'link' },
      ],
    });
    const [signer1, signer2] = envSubmitRace.signerIds;
    const tok1 = envSubmitRace.links.find((l) => l.signerId === signer1)!.token;
    const tok2 = envSubmitRace.links.find((l) => l.signerId === signer2)!.token;
    const f1 = envSubmitRace.fieldIdsBySigner.get(signer1!)![0]!;
    const f2 = envSubmitRace.fieldIdsBySigner.get(signer2!)![0]!;
    const beforeVer = (
      await adminPool!.query<{ version: number }>('SELECT version FROM crove_sign.envelope WHERE org_id = $1 AND id = $2', [orgA, envSubmitRace.envelopeId])
    ).rows[0]!.version;

    const [sub1, sub2] = await Promise.all([
      appPool!.query<{ v: { status: string; completed: boolean } }>(
        "SELECT crove_sign.public_submit($1, true, 'draw', NULL, $2::jsonb, $3, 'InvTest/1.0', $4) AS v",
        [hashSigningToken(tok1), JSON.stringify([{ fieldId: f1, signaturePngBase64: VALID_PNG_BASE64 }]), ipHash, DEFAULT_MESSAGE_ID_DOMAIN],
      ),
      appPool!.query<{ v: { status: string; completed: boolean } }>(
        "SELECT crove_sign.public_submit($1, true, 'draw', NULL, $2::jsonb, $3, 'InvTest/1.0', $4) AS v",
        [hashSigningToken(tok2), JSON.stringify([{ fieldId: f2, signaturePngBase64: VALID_PNG_BASE64 }]), ipHash, DEFAULT_MESSAGE_ID_DOMAIN],
      ),
    ]);
    expect([sub1.rows[0]?.v.status, sub2.rows[0]?.v.status]).toEqual(['ok', 'ok']);
    expect([sub1.rows[0]?.v.completed, sub2.rows[0]?.v.completed].sort()).toEqual([false, true]);

    const afterEnv = (
      await adminPool!.query<{ status: string; version: number; seal_status: string | null }>(
        'SELECT status, version, seal_status FROM crove_sign.envelope WHERE org_id = $1 AND id = $2',
        [orgA, envSubmitRace.envelopeId],
      )
    ).rows[0]!;
    expect(afterEnv.status).toBe('completed');
    expect(afterEnv.version).toBe(beforeVer + 2);
    expect(afterEnv.seal_status).toBeNull();
    const sealOutbox = await adminPool!.query<{ cnt: number }>(
      "SELECT count(*)::int AS cnt FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'sign.envelope.seal_queued' AND payload->>'envelopeId' = $2",
      [orgA, envSubmitRace.envelopeId],
    );
    expect(sealOutbox.rows[0]?.cnt).toBe(1);

    // Concurrent submit + decline across two parallel signers resolves cleanly in lock order.
    const envMixedRace = await setupActiveEnvelope({
      actorUserId: userA,
      orgId: orgA,
      title: 'Parallel Submit vs Decline',
      routingMode: 'parallel',
      signers: [
        { routingOrder: 1, signerRole: 'signer', name: 'Mixed A', email: 'ma@sign-inv.test', deliveryMode: 'link' },
        { routingOrder: 1, signerRole: 'signer', name: 'Mixed B', email: 'mb@sign-inv.test', deliveryMode: 'link' },
      ],
    });
    const [m1, m2] = envMixedRace.signerIds;
    const mTok1 = envMixedRace.links.find((l) => l.signerId === m1)!.token;
    const mTok2 = envMixedRace.links.find((l) => l.signerId === m2)!.token;
    const mf1 = envMixedRace.fieldIdsBySigner.get(m1!)![0]!;
    const mixVerBefore = (
      await adminPool!.query<{ version: number }>('SELECT version FROM crove_sign.envelope WHERE org_id = $1 AND id = $2', [orgA, envMixedRace.envelopeId])
    ).rows[0]!.version;

    const [mixSub, mixDec] = await Promise.all([
      appPool!.query<{ v: { status: string } }>(
        "SELECT crove_sign.public_submit($1, true, 'draw', NULL, $2::jsonb, $3, 'InvTest/1.0', $4) AS v",
        [hashSigningToken(mTok1), JSON.stringify([{ fieldId: mf1, signaturePngBase64: VALID_PNG_BASE64 }]), ipHash, DEFAULT_MESSAGE_ID_DOMAIN],
      ),
      appPool!.query<{ v: { status: string } }>(
        "SELECT crove_sign.public_decline($1, 'concurrent decline', $2, 'InvTest/1.0') AS v",
        [hashSigningToken(mTok2), ipHash],
      ),
    ]);
    expect(mixDec.rows[0]?.v.status).toBe('ok');
    expect(['ok', 'not_found']).toContain(mixSub.rows[0]?.v.status);

    const mixEnvAfter = (
      await adminPool!.query<{ status: string; version: number }>('SELECT status, version FROM crove_sign.envelope WHERE org_id = $1 AND id = $2', [
        orgA,
        envMixedRace.envelopeId,
      ])
    ).rows[0]!;
    expect(mixEnvAfter.status).toBe('declined');
    expect(mixEnvAfter.version).toBe(mixSub.rows[0]?.v.status === 'ok' ? mixVerBefore + 2 : mixVerBefore + 1);
  });
});
