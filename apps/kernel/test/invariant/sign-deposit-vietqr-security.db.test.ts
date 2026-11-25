// SPDX-License-Identifier: AGPL-3.0-only
// Self-contained security invariants for eSign Slice 6d VietQR deposit (#4723, #4837 items 9, 10, 17):
//   - Hard confidentiality trigger block on hr_contract & meeting_minutes (envelope_deposit + deposit_profile)
//   - Strict 'sign_deposit_qr' file source and spoofed storage key SQL trigger enforcement
//   - System-only mutation guards (SIGN_DEPOSIT_SYSTEM_ONLY / SIGN_DEPOSIT_FROZEN) & GUC spoof prevention
//   - Direct freeze_envelope_deposit_snapshot guards (draft rejection, forged EMVCo rejection, double-freeze block)
//   - Integer VND NUMERIC scale constraint (envelope_deposit_vnd_integer_ck)
//   - Direct SQL OTP gate enforcement on both public_deposit_notice_preflight and public_record_deposit_notice
//     even when signer_notice_at is already populated (#4837 item 17)
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@ludy/db';
import { migrate } from '@ludy/db/migrate';
import {
  createOrg,
  kernelCommands,
  kernelQueries,
  upsertIdentity,
} from '@ludy/kernel';
import { Runtime, contentGeneration, fileKey, sha256Hex, type BlobStore } from '@ludy/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import { signCommands, signQueries } from '@ludy/mod-sign';
import { createSessionStatusSource } from '../../src/sessions.ts';
import { createDbClient, createDbPool, resolveDbIdentifiers, setActiveRolePasswords, type DbIdentifiers } from './fixtures/db-identifiers.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const TINY_PNG_BYTES = Uint8Array.from(Buffer.from(TINY_PNG_BASE64, 'base64'));

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

const makePdf = (tag: string): Uint8Array =>
  Uint8Array.from(Buffer.from(`%PDF-1.4\n% dep-sec-${tag}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n`, 'utf8'));

suite('eSign Slice 6d VietQR deposit direct-SQL & OTP security invariants (#4723, #4837)', () => {
  const dbName = `ludy_test_dep_sec_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let dbIds: DbIdentifiers | undefined;
  let pool: pg.Pool | undefined;
  let workerPool: pg.Pool | undefined;
  let db!: Db;
  let workerDb!: Db;
  let runtime!: Runtime;
  let workerRuntime!: Runtime;
  const store = new MemoryStore();

  let orgId = '';
  let ownerUserId = '';
  let memberUserId = '';

  const ownerSession = randomUUID();
  const memberSession = randomUUID();
  const asOwner = () => ({ type: 'user' as const, userId: ownerUserId, sessionId: ownerSession, aal: 'aal2' as const });
  const asMember = () => ({ type: 'user' as const, userId: memberUserId, sessionId: memberSession, aal: 'aal2' as const });
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

  async function ingestPdf(actor: ReturnType<typeof asOwner>, title: string): Promise<string> {
    const pdf = makePdf(`${title}-${randomUUID()}`);
    const sha = sha256Hex(pdf);
    const key = fileKey(orgId, sha);
    const gen = await store.put(key, pdf);
    const file = await runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      {
        filename: `${title}.pdf`,
        contentType: 'application/pdf',
        sizeBytes: pdf.byteLength,
        sha256: sha,
        storageKey: key,
        generation: gen,
        source: 'sign_document',
      },
      { actor, orgId },
    );
    return file.fileId;
  }

  async function ingestQrPng(actor: ReturnType<typeof asOwner>, source: 'sign_deposit_qr' | 'upload' | 'social', tag: string) {
    const ihdrExtra = Buffer.from(`${tag}-${randomUUID()}`, 'utf8');
    const pngBytes = Buffer.concat([TINY_PNG_BYTES, ihdrExtra]);
    const sha = sha256Hex(pngBytes);
    const key = fileKey(orgId, sha);
    const gen = await store.put(key, pngBytes);
    const file = await runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      {
        filename: `${tag}.png`,
        contentType: 'image/png',
        sizeBytes: pngBytes.byteLength,
        sha256: sha,
        storageKey: key,
        generation: gen,
        source,
      },
      { actor, orgId },
    );
    return { fileId: file.fileId, storageKey: key, generation: gen, sha256: sha };
  }

  async function createInspectedDraft(
    actor: ReturnType<typeof asOwner>,
    opts: { title: string; sourceKind?: 'standalone' | 'hr_contract' | 'meeting_minutes'; sourceId?: string },
  ): Promise<string> {
    const fileId = await ingestPdf(actor, opts.title.replace(/\s+/g, '-').toLowerCase());
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
      { actor, orgId },
    );
    await workerRuntime.execute(
      'sign.envelope.inspect_complete',
      {
        envelopeId: created.envelopeId,
        outcome: 'passed',
        pageCount: 1,
        pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0 }],
      },
      { actor: asSystem, orgId },
    );
    return created.envelopeId;
  }

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN as string });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();

    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();

    await migrate({ adminUrl, dir: MIGRATIONS });
    dbIds = await resolveDbIdentifiers(adminUrl);
    await setActiveRolePasswords(adminUrl, { crove_app: 'dep-sec-app-pw', crove_worker: 'dep-sec-worker-pw' }, dbIds);

    const login = (role: string, pw: string) => {
      const url = new URL(adminUrl);
      url.username = dbIds ? dbIds.roleName(role) : role;
      url.password = pw;
      return url.toString();
    };

    appUrl = login('crove_app', 'dep-sec-app-pw');
    pool = createDbPool({ connectionString: appUrl, max: 6 }, dbIds);
    workerPool = createDbPool({ connectionString: login('crove_worker', 'dep-sec-worker-pw'), max: 3 }, dbIds);
    db = createDb(pool);
    workerDb = createDb(workerPool);

    runtime = new Runtime(db, {
      manifests: TEST_MANIFESTS,
      sessions: createSessionStatusSource('off'),
      stepUp: 'required',
    }).register({
      commands: [...kernelCommands, ...signCommands, ...meetingsCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...signQueries, ...meetingsQueries],
    });

    workerRuntime = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...signCommands, ...meetingsCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...signQueries, ...meetingsQueries],
    });

    ownerUserId = await upsertIdentity(db, {
      issuer: 'dep-sec-inv',
      subject: 'owner',
      email: 'owner@dep-sec.test',
      name: 'Owner Sec',
    });
    memberUserId = await upsertIdentity(db, {
      issuer: 'dep-sec-inv',
      subject: 'member',
      email: 'member@dep-sec.test',
      name: 'Member Sec',
    });
    orgId = (await createOrg(runtime, asOwner(), 'Cong ty Bao mat VietQR')).orgId;

    await admin(async (c) => {
      await c.query(
        `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`,
        [orgId, memberUserId],
      );
      await c.query(`UPDATE ludy_kernel.tenant SET meeting_minutes_esign = true WHERE org_id = $1::uuid`, [orgId]);
    });
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

  it('enforces confidential envelope blocks, strict sign_deposit_qr file source, and deposit_profile SQL guards', async () => {
    const validQr = await ingestQrPng(asOwner(), 'sign_deposit_qr', 'valid-qr');
    await runtime.execute(
      'sign.deposit_profile.upsert',
      {
        bankCode: 'vcb',
        accountNumber: '0123456789',
        accountHolder: 'CONG TY SEC',
        vietqrFileId: validQr.fileId,
      },
      { actor: asOwner(), orgId },
    );

    const hrEnvId = await createInspectedDraft(asOwner(), { title: 'HR Secret Contract', sourceKind: 'hr_contract' });
    const mtg = await runtime.execute<{ meetingId: string }>(
      'meetings.meeting.create',
      { title: 'Confidential Board', visibility: 'org', consentMethod: 'told_at_start' },
      { actor: asOwner(), orgId },
    );
    await runtime.execute(
      'meetings.summary.save',
      { meetingId: mtg.meetingId, summary: 'Confidential minutes.', decisions: ['Agreed'] },
      { actor: asOwner(), orgId },
    );
    await runtime.execute(
      'meetings.result.publish',
      { meetingId: mtg.meetingId, confirmed: true },
      { actor: asOwner(), orgId },
    );
    const mmEnvId = await createInspectedDraft(asOwner(), {
      title: 'Meeting Minutes Secret',
      sourceKind: 'meeting_minutes',
      sourceId: mtg.meetingId,
    });

    for (const envId of [hrEnvId, mmEnvId]) {
      await admin(async (c) => {
        await expect(
          c.query(
            `INSERT INTO ludy_sign.envelope_deposit (org_id, id, envelope_id, amount, currency, memo_token, created_by)
             VALUES ($1, $2, $3, 5000000, 'VND', 'CK-SQLBLK1', $4)`,
            [orgId, randomUUID(), envId, ownerUserId],
          ),
        ).rejects.toThrow(/SIGN_CONFIDENTIAL_DEPOSIT_FORBIDDEN/);
      });
    }

    const hrFile = await admin(async (c) => {
      const { rows } = await c.query<{ id: string; storage_key: string; generation: string; sha256: string }>(
        `SELECT f.id, f.storage_key, f.generation, f.sha256
         FROM ludy_sign.envelope e
         JOIN ludy_kernel.file f ON f.org_id = e.org_id AND f.id = e.source_file_id
         WHERE e.org_id = $1 AND e.id = $2`,
        [orgId, hrEnvId],
      );
      return rows[0]!;
    });

    // Reject 'upload' and 'social' sources via SQL deposit_guard_file_error & trigger (#4837 item 10)
    const uploadPng = await ingestQrPng(asOwner(), 'upload', 'non-qr-upload');
    const socialPng = await ingestQrPng(asOwner(), 'social', 'non-qr-social');

    const c = createDbClient({ connectionString: appUrl }, dbIds);
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT ludy_kernel.enter_context($1::uuid, $2::uuid)', [ownerUserId, orgId]);
      await expect(
        c.query(
          `UPDATE ludy_sign.deposit_profile
           SET vietqr_file_id = $1, vietqr_storage_key = 'org/other/evil.png', vietqr_generation = $2, vietqr_sha256 = $3
           WHERE org_id = $4`,
          [validQr.fileId, validQr.generation, validQr.sha256, orgId],
        ),
      ).rejects.toThrow(/SIGN_DEPOSIT_QR_FILE_INVALID/);
      await c.query('ROLLBACK');

      await c.query('BEGIN');
      await c.query('SELECT ludy_kernel.enter_context($1::uuid, $2::uuid)', [ownerUserId, orgId]);
      await expect(
        c.query(
          `UPDATE ludy_sign.deposit_profile
           SET vietqr_file_id = $1, vietqr_storage_key = $2, vietqr_generation = $3, vietqr_sha256 = $4
           WHERE org_id = $5`,
          [hrFile.id, hrFile.storage_key, hrFile.generation, hrFile.sha256, orgId],
        ),
      ).rejects.toThrow(/SIGN_DEPOSIT_QR_FILE_INVALID|SIGN_INVALID_SIGNATURE_PNG|SIGN_CONFIDENTIAL_DEPOSIT_FORBIDDEN/);
      await c.query('ROLLBACK');

      for (const nonQr of [uploadPng, socialPng]) {
        await c.query('BEGIN');
        await c.query('SELECT ludy_kernel.enter_context($1::uuid, $2::uuid)', [ownerUserId, orgId]);
        await expect(
          c.query(
            `UPDATE ludy_sign.deposit_profile
             SET vietqr_file_id = $1, vietqr_storage_key = $2, vietqr_generation = $3, vietqr_sha256 = $4
             WHERE org_id = $5`,
            [nonQr.fileId, nonQr.storageKey, nonQr.generation, nonQr.sha256, orgId],
          ),
        ).rejects.toThrow(/SIGN_DEPOSIT_QR_FILE_INVALID/);
        await c.query('ROLLBACK');
      }
    } finally {
      await c.end();
    }
  }, 60_000);

  it('enforces envelope_deposit system-only guards, GUC bypass defenses, freeze integrity, integer scale, and direct SQL OTP gate', async () => {
    const qr = await ingestQrPng(asOwner(), 'sign_deposit_qr', 'sec-freeze-qr');
    await runtime.execute(
      'sign.deposit_profile.upsert',
      {
        bankCode: 'vcb',
        accountNumber: '0999888777',
        accountHolder: 'CONG TY FREEZE SEC',
        vietqrFileId: qr.fileId,
      },
      { actor: asOwner(), orgId },
    );

    const draftEnvId = await createInspectedDraft(asMember(), { title: 'Freeze Security Env' });
    await runtime.execute(
      'sign.envelope.deposit.set',
      { envelopeId: draftEnvId, amount: '5000000', memoToken: 'CK-SEC001', dueDays: 3 },
      { actor: asMember(), orgId },
    );

    const tenantUrl = (() => {
      const url = new URL(adminUrl);
      url.username = dbIds ? dbIds.roleName('crove_app') : 'ludy_app';
      url.password = 'dep-sec-app-pw';
      return url.toString();
    })();
    const guardClient = createDbClient({ connectionString: tenantUrl }, dbIds);
    await guardClient.connect();
    try {
      // 1. Integer VND CHECK constraint rejects fractional amounts and allows exact integer values
      const scaleEnvId = await createInspectedDraft(asOwner(), { title: 'Scale Check Env' });
      await guardClient.query('BEGIN');
      await guardClient.query('SELECT ludy_kernel.enter_context($1::uuid, $2::uuid)', [ownerUserId, orgId]);
      await expect(
        guardClient.query(
          `INSERT INTO ludy_sign.envelope_deposit (org_id, envelope_id, amount, currency, memo_token, created_by, updated_by)
           VALUES ($1, $2, 100.00001, 'VND', 'CK-SCALE1', $3, $3)`,
          [orgId, scaleEnvId, ownerUserId],
        ),
      ).rejects.toThrow(/envelope_deposit_vnd_integer_ck/);
      await guardClient.query('ROLLBACK');

      await guardClient.query('BEGIN');
      await guardClient.query('SELECT ludy_kernel.enter_context($1::uuid, $2::uuid)', [ownerUserId, orgId]);
      await expect(
        guardClient.query(
          `INSERT INTO ludy_sign.envelope_deposit (org_id, envelope_id, amount, currency, memo_token, created_by, updated_by)
           VALUES ($1, $2, 100.0000, 'VND', 'CK-SCALE2', $3, $3)`,
          [orgId, scaleEnvId, ownerUserId],
        ),
      ).resolves.toBeDefined();
      await guardClient.query('ROLLBACK');

      // 2. Direct tenant SQL cannot spoof snapshot_* or signer_proof_* on draft envelope_deposit
      await guardClient.query('BEGIN');
      await guardClient.query('SELECT ludy_kernel.enter_context($1::uuid, $2::uuid)', [memberUserId, orgId]);
      await expect(
        guardClient.query(
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
          [qr.fileId, qr.generation, qr.sha256, orgId, draftEnvId],
        ),
      ).rejects.toThrow(/SIGN_DEPOSIT_SYSTEM_ONLY/);
      await guardClient.query('ROLLBACK');

      await guardClient.query('BEGIN');
      await guardClient.query('SELECT ludy_kernel.enter_context($1::uuid, $2::uuid)', [memberUserId, orgId]);
      await expect(
        guardClient.query(
          `UPDATE ludy_sign.envelope_deposit
           SET signer_proof_file_id = $1, signer_proof_filename = 'spoof.png', signer_proof_sha256 = $2
           WHERE org_id = $3 AND envelope_id = $4`,
          [qr.fileId, qr.sha256, orgId, draftEnvId],
        ),
      ).rejects.toThrow(/SIGN_DEPOSIT_SYSTEM_ONLY/);
      await guardClient.query('ROLLBACK');

      // 3. Direct freeze_envelope_deposit_snapshot rejects draft envelope and forged non-system EMVCo
      await guardClient.query('BEGIN');
      await guardClient.query('SELECT ludy_kernel.enter_context($1::uuid, $2::uuid)', [memberUserId, orgId]);
      await expect(
        guardClient.query(
          `SELECT ludy_sign.freeze_envelope_deposit_snapshot($1::uuid, $2::uuid, NULL, $3::uuid, now())`,
          [orgId, draftEnvId, memberUserId],
        ),
      ).rejects.toThrow(/SIGN_DEPOSIT_FROZEN/);
      await guardClient.query('ROLLBACK');

      const emvcoProbeEnvId = await createInspectedDraft(asOwner(), { title: 'EMVCo Probe Env' });
      await runtime.execute(
        'sign.envelope.deposit.set',
        { envelopeId: emvcoProbeEnvId, amount: '1500000', memoToken: 'CK-EMV001' },
        { actor: asOwner(), orgId },
      );
      await admin(async (c) => {
        await c.query(`UPDATE ludy_sign.envelope SET status = 'sent', sent_at = now() WHERE org_id = $1 AND id = $2`, [
          orgId,
          emvcoProbeEnvId,
        ]);
      });
      await guardClient.query('BEGIN');
      await guardClient.query('SELECT ludy_kernel.enter_context($1::uuid, $2::uuid)', [memberUserId, orgId]);
      const forgedEmvco =
        '00020101021238540010A00000072701240006970436011001234567890208QRIBFTTA53037045802VN62130809CK-EMV016304ABCD';
      const emvcoRes = await guardClient.query<{ res: { frozen?: boolean; error?: string } }>(
        `SELECT ludy_sign.freeze_envelope_deposit_snapshot($1::uuid, $2::uuid, $3, $4::uuid, now()) AS res`,
        [orgId, emvcoProbeEnvId, forgedEmvco, memberUserId],
      );
      expect(emvcoRes.rows[0]?.res).toEqual({ frozen: false, error: 'SIGN_DEPOSIT_EMVCO_INVALID' });
      await guardClient.query('ROLLBACK');

      // 4. Send draftEnvId -> frozen immutability + GUC bypass blocks + direct SQL OTP gate (#4837 item 17)
      await runtime.execute(
        'sign.signer.add',
        { envelopeId: draftEnvId, signerRole: 'approver', name: 'Nguyen Van A', deliveryMode: 'link', requireEmailOtp: false },
        { actor: asMember(), orgId },
      );
      const sent = await runtime.execute<{ links: Array<{ token: string }> }>(
        'sign.envelope.send',
        { envelopeId: draftEnvId },
        { actor: asMember(), orgId },
      );
      const rawToken = sent.links[0]!.token;
      const tokenHash = sha256Hex(rawToken);

      await guardClient.query('BEGIN');
      await guardClient.query('SELECT ludy_kernel.enter_context($1::uuid, $2::uuid)', [memberUserId, orgId]);
      await expect(
        guardClient.query(
          `UPDATE ludy_sign.envelope_deposit SET amount = 9999999 WHERE org_id = $1 AND envelope_id = $2`,
          [orgId, draftEnvId],
        ),
      ).rejects.toThrow(/SIGN_DEPOSIT_FROZEN/);
      await guardClient.query('ROLLBACK');

      await guardClient.query('BEGIN');
      await guardClient.query('SELECT ludy_kernel.enter_context($1::uuid, $2::uuid)', [memberUserId, orgId]);
      await expect(
        guardClient.query(
          `SELECT ludy_sign.freeze_envelope_deposit_snapshot($1::uuid, $2::uuid, NULL, $3::uuid, now())`,
          [orgId, draftEnvId, memberUserId],
        ),
      ).rejects.toThrow(/SIGN_DEPOSIT_FROZEN/);
      await guardClient.query('ROLLBACK');

      const spoofPdfFileId = await ingestPdf(asMember(), 'spoof-notice-guc');
      await guardClient.query('BEGIN');
      await guardClient.query('SELECT ludy_kernel.enter_context($1::uuid, $2::uuid)', [memberUserId, orgId]);
      await guardClient.query(`SELECT pg_catalog.set_config('ludy.sign_deposit_notice', $1, true)`, [draftEnvId]);
      await expect(
        guardClient.query(
          `UPDATE ludy_sign.envelope_deposit
           SET signer_proof_file_id = $1,
               signer_proof_filename = 'bypass.png',
               signer_proof_sha256 = $2
           WHERE org_id = $3 AND envelope_id = $4`,
          [spoofPdfFileId, 'a'.repeat(64), orgId, draftEnvId],
        ),
      ).rejects.toThrow(/SIGN_DEPOSIT_SYSTEM_ONLY/);
      await guardClient.query('ROLLBACK');

      await guardClient.query('BEGIN');
      await guardClient.query('SELECT ludy_kernel.enter_context($1::uuid, $2::uuid)', [memberUserId, orgId]);
      await guardClient.query(`SELECT pg_catalog.set_config('ludy.sign_meeting_cleanup', $1, true)`, [orgId]);
      await expect(
        guardClient.query(`DELETE FROM ludy_sign.envelope_deposit WHERE org_id = $1 AND envelope_id = $2`, [
          orgId,
          draftEnvId,
        ]),
      ).rejects.toThrow(/SIGN_DEPOSIT_FROZEN/);
      await guardClient.query('ROLLBACK');

      // Sign the envelope, record initial transfer notice (signer_notice_at IS NOT NULL), then enforce require_email_otp = true
      // and verify BOTH public_deposit_notice_preflight AND public_record_deposit_notice fail closed with SIGN_OTP_REQUIRED (#4837 item 17).
      const submitRes = await guardClient.query<{ res: { status: string } }>(
        `SELECT ludy_sign.public_submit($1, true, NULL, NULL, '[]'::jsonb, 'hash', NULL, 'crove.invalid') AS res`,
        [tokenHash],
      );
      expect(submitRes.rows[0]?.res, JSON.stringify(submitRes.rows[0]?.res)).toMatchObject({ status: 'ok' });

      const initialNoticeRes = await guardClient.query<{ res: { status: string } }>(
        `SELECT ludy_sign.public_record_deposit_notice($1, 'Initial noticed', NULL, NULL, NULL, NULL, NULL, NULL, NULL) AS res`,
        [tokenHash],
      );
      expect(initialNoticeRes.rows[0]?.res?.status).toBe('ok');

      await admin(async (adm) => {
        await adm.query('BEGIN');
        await adm.query('SET LOCAL session_replication_role = replica');
        await adm.query(
          `UPDATE ludy_sign.signer
           SET require_email_otp = true,
               email = COALESCE(email, 'otp-sec@example.com')
           WHERE org_id = $1 AND envelope_id = $2`,
          [orgId, draftEnvId],
        );
        await adm.query('COMMIT');
      });

      const otpPreflight = await guardClient.query<{ result: Record<string, unknown> }>(
        `SELECT ludy_sign.public_deposit_notice_preflight($1) AS result`,
        [tokenHash],
      );
      expect(otpPreflight.rows[0]?.result).toEqual({
        status: 'ok',
        orgId,
        otpRequired: true,
      });
      expect('alreadyNoticed' in otpPreflight.rows[0]!.result).toBe(false);
      expect('deposit' in otpPreflight.rows[0]!.result).toBe(false);

      const otpRecordNotice = await guardClient.query<{ result: Record<string, unknown> }>(
        `SELECT ludy_sign.public_record_deposit_notice($1, 'Direct SQL replay probe', NULL, NULL, NULL, NULL, NULL, NULL, NULL) AS result`,
        [tokenHash],
      );
      expect(otpRecordNotice.rows[0]?.result).toMatchObject({
        status: 'error',
        code: 'SIGN_OTP_REQUIRED',
        httpStatus: 403,
      });
    } finally {
      await guardClient.end();
    }
  }, 60_000);
});
