// SPDX-License-Identifier: AGPL-3.0-only
// PostgreSQL integration tests for eSign retention & unsealed signer erasure (#3427, #3428 L4):
//   - M1: untouched draft envelopes are never deleted by sign.org.cleanup or cleanup_org_stale; signing_event stays append-only
//   - M2(b): expired/invalidated/verified signing_otp rows >24h are pruned while <24h remain;
//            expired/used/revoked signing_token rows >30d are pruned while <30d remain
//   - M2(a): findPersonalData and personal_data.erase cover all unsealed envelopes (draft, voided, expired, declined)
//            and both email + phone lookups, preserve completed/sealed and active envelopes and co-signers,
//            preserve signing_event hash-chain integrity, and keep owner-only + guard trigger isolation intact
//   - #3428 L4: expire_sweep_due_orgs, cleanup_due_orgs, and cleanup_due_orgs_secrets order due orgs deterministically
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
import type { PersonalDataErasure, PersonalDataResult } from '@ludy/kernel-contract';
import { mintContextToken, Runtime, contentGeneration, fileKey, sha256Hex } from '@ludy/kernel-runtime';
import {
  DEFAULT_OTP_RETENTION_HOURS,
  DEFAULT_RETENTION_DAYS,
  generateCertificateCode,
  generateRawSigningToken,
  hashSigningToken,
  signCommands,
  signManifest,
  signQueries,
  verifyEventChain,
  type SigningEventChainRow,
} from '../src/index.ts';

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

function makePngBase64(width = 120, height = 40): string {
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
  const idat = chunk('IDAT', deflateSync(rawBytes));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    idat,
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

const VALID_PNG_BASE64 = makePngBase64();

suite('eSign retention & unsealed signer erasure (#3427, #3428 L4)', () => {
  const dbName = `crove_test_sign_ret_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  let ownerB = '';

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, mfaAt: Math.floor(Date.now() / 1000) });
  const asSystem = (component: string) => ({ type: 'system' as const, component });
  const ipHash = sha256Hex('203.0.113.42');

  async function ingestPdf(
    actorUserId: string,
    orgId: string,
    tag: string,
    source: 'sign_document' | 'sign_sealed' | 'sign_certificate' = 'sign_document',
  ): Promise<{ fileId: string; sha256: string }> {
    const bytes = Uint8Array.from(
      Buffer.from(`%PDF-1.4\n% sign-ret-${tag}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n`, 'utf8'),
    );
    const sha256 = sha256Hex(bytes);
    const useWorker = source !== 'sign_document';
    const targetRuntime = useWorker ? workerRuntime : runtime;
    const actor = useWorker ? asSystem('sign-worker') : asUser(actorUserId);
    const { fileId } = await targetRuntime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      {
        filename: `${tag}.pdf`,
        contentType: 'application/pdf',
        sizeBytes: bytes.byteLength,
        sha256,
        storageKey: fileKey(orgId, sha256),
        generation: contentGeneration(sha256),
        source,
      },
      { actor, orgId },
    );
    return { fileId, sha256 };
  }

  async function createPassedDraft(opts: {
    actorUserId: string;
    orgId: string;
    title: string;
    routingMode: 'sequential' | 'parallel';
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
      fieldType: 'signature';
      pageNumber: number;
      xNorm: number;
      yNorm: number;
      wNorm: number;
      hNorm: number;
      required: boolean;
    }> = [];

    for (let i = 0; i < opts.signers.length; i++) {
      const s = opts.signers[i]!;
      const added = await runtime.execute<{ signerId: string }>(
        'sign.signer.add',
        {
          envelopeId: created.envelopeId,
          routingOrder: s.routingOrder,
          signerRole: s.signerRole,
          roleLabel: 'Signer',
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
      const list = fieldIdsBySigner.get(f.signer_id) ?? [];
      list.push(f.id);
      fieldIdsBySigner.set(f.signer_id, list);
    }

    return { envelopeId: created.envelopeId, signerIds, fieldIdsBySigner };
  }

  async function setupActiveEnvelope(opts: Parameters<typeof createPassedDraft>[0]): Promise<{
    envelopeId: string;
    signerIds: string[];
    fieldIdsBySigner: Map<string, string[]>;
    links: Array<{ signerId: string; tokenId: string; token: string }>;
  }> {
    const draft = await createPassedDraft(opts);
    const sent = await runtime.execute<{
      links: Array<{ signerId: string; tokenId: string; token: string }>;
    }>(
      'sign.envelope.send',
      { envelopeId: draft.envelopeId },
      { actor: asUser(opts.actorUserId), orgId: opts.orgId },
    );
    return { ...draft, links: sent.links };
  }

  beforeAll(async () => {
    const rootPool = createPool({ connectionString: ADMIN as string, max: 1 });
    await rootPool.query(`CREATE DATABASE ${dbName}`);
    await rootPool.end();

    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();

    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'ret-app-pw', crove_worker: 'ret-worker-pw' });

    const loginUrl = (user: string, pw: string) => {
      const u = new URL(adminUrl);
      u.username = user;
      u.password = pw;
      return u.toString();
    };

    adminPool = createPool({ connectionString: adminUrl, max: 3 });
    appPool = createPool({ connectionString: loginUrl('crove_app', 'ret-app-pw'), max: 6 });
    workerPool = createPool({ connectionString: loginUrl('crove_worker', 'ret-worker-pw'), max: 3 });

    const manifests = [kernelManifest.tables, signManifest.tables];
    const appDb = createDb(appPool);
    const workerDb = createDb(workerPool);

    runtime = new Runtime(appDb, { manifests })
      .register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) })
      .register({ commands: signCommands, queries: signQueries });

    workerRuntime = new Runtime(workerDb, { manifests })
      .register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) })
      .register({ commands: signCommands, queries: signQueries });

    ownerA = await upsertIdentity(appDb, { issuer: 'sign-ret', subject: 'owner-a', email: 'ownera@sign-ret.test', name: 'Owner A' });
    adminA = await upsertIdentity(appDb, { issuer: 'sign-ret', subject: 'admin-a', email: 'admina@sign-ret.test', name: 'Admin A' });
    ownerB = await upsertIdentity(appDb, { issuer: 'sign-ret', subject: 'owner-b', email: 'ownerb@sign-ret.test', name: 'Owner B' });

    orgA = (await createOrg(runtime, asUser(ownerA), 'Sign Retention Org A')).orgId;
    orgB = (await createOrg(runtime, asUser(ownerB), 'Sign Retention Org B')).orgId;

    const inv = await runtime.execute<{ acceptPath: string }>(
      'kernel.member.invite.create',
      { email: 'admina@sign-ret.test', role: 'admin' },
      { actor: asMfa(ownerA), orgId: orgA },
    );
    await runtime.executeOrgless(
      'kernel.member.invite.accept',
      { token: inv.acceptPath.slice(inv.acceptPath.indexOf('#') + 1) },
      { actor: asMfa(adminA) },
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

  it('exports plan retention defaults (30d tokens, 24h OTPs) and keeps untouched draft envelopes forever', async () => {
    expect(DEFAULT_RETENTION_DAYS).toBe(30);
    expect(DEFAULT_OTP_RETENTION_HOURS).toBe(24);

    const oldDraft45 = await createPassedDraft({
      actorUserId: ownerA,
      orgId: orgA,
      title: 'Old Draft 45d',
      routingMode: 'parallel',
      signers: [{ routingOrder: 1, signerRole: 'signer', name: 'Draft Keeper', email: 'draft45@sign-ret.test' }],
    });
    const oldDraft400 = await createPassedDraft({
      actorUserId: ownerA,
      orgId: orgA,
      title: 'Old Draft 400d',
      routingMode: 'parallel',
      signers: [{ routingOrder: 1, signerRole: 'signer', name: 'Draft Ancient', email: 'draft400@sign-ret.test' }],
    });

    await adminPool!.query(
      "UPDATE crove_sign.envelope SET created_at = now() - interval '45 days', updated_at = now() - interval '45 days' WHERE id = $1",
      [oldDraft45.envelopeId],
    );
    await adminPool!.query(
      "UPDATE crove_sign.envelope SET created_at = now() - interval '400 days', updated_at = now() - interval '400 days' WHERE id = $1",
      [oldDraft400.envelopeId],
    );

    const dueWithOnlyDrafts = await workerPool!.query<{ org_id: string }>(
      "SELECT org_id FROM crove_sign.cleanup_due_orgs(now() - interval '1 day', now() - interval '1 day', 100)",
    );
    expect(dueWithOnlyDrafts.rows).toEqual([]);

    const cleanupRes = await workerRuntime.execute<{ otps: number; tokens: number; drafts: number; draftEvents: number }>(
      'sign.org.cleanup',
      {},
      { actor: asSystem('sign-worker'), orgId: orgA },
    );
    expect(cleanupRes).toEqual({ otps: 0, tokens: 0, drafts: 0, draftEvents: 0 });

    const workerClient = await workerPool!.connect();
    try {
      await workerClient.query('BEGIN');
      await workerClient.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgA]);
      const directStale = await workerClient.query<{ res: Record<string, number> }>(
        "SELECT crove_sign.cleanup_org_stale(now() - interval '1 day', now() - interval '30 days') AS res",
      );
      expect(directStale.rows[0]?.res).toEqual({ otps: 0, tokens: 0, drafts: 0, draftEvents: 0 });

      // Worker has no DELETE privilege on signing_event, and the append-only trigger rejects deletes even if GUC is set.
      await workerClient.query('SAVEPOINT sp_append_only');
      await workerClient.query(`SET LOCAL crove.sign_cleanup = '${orgA}'`);
      await expect(
        workerClient.query('DELETE FROM crove_sign.signing_event WHERE org_id = $1 AND envelope_id = $2', [
          orgA,
          oldDraft45.envelopeId,
        ]),
      ).rejects.toThrow(/permission denied/);
      await workerClient.query('ROLLBACK TO SAVEPOINT sp_append_only');
      await workerClient.query('ROLLBACK');
    } finally {
      workerClient.release();
    }

    const adminClient = await adminPool!.connect();
    try {
      await adminClient.query('BEGIN');
      await adminClient.query(`SET LOCAL crove.sign_cleanup = '${orgA}'`);
      await expect(
        adminClient.query('DELETE FROM crove_sign.signing_event WHERE org_id = $1 AND envelope_id = $2', [
          orgA,
          oldDraft45.envelopeId,
        ]),
      ).rejects.toThrow(/append-only/);
      await adminClient.query('ROLLBACK');
    } finally {
      adminClient.release();
    }

    const remainingDrafts = await adminPool!.query<{ id: string }>(
      'SELECT id FROM crove_sign.envelope WHERE id = ANY($1::uuid[]) ORDER BY id',
      [[oldDraft45.envelopeId, oldDraft400.envelopeId]],
    );
    expect(remainingDrafts.rows).toHaveLength(2);
    const remainingDraftSigners = await adminPool!.query<{ id: string }>(
      'SELECT id FROM crove_sign.signer WHERE envelope_id = ANY($1::uuid[])',
      [[oldDraft45.envelopeId, oldDraft400.envelopeId]],
    );
    expect(remainingDraftSigners.rows).toHaveLength(2);
  });

  it('prunes OTPs older than 24 hours and dead tokens older than 30 days while keeping newer secrets', async () => {
    const env = await setupActiveEnvelope({
      actorUserId: ownerA,
      orgId: orgA,
      title: 'Secret Retention Envelope',
      routingMode: 'sequential',
      signers: [
        { routingOrder: 1, signerRole: 'signer', name: 'Secret Tester 1', email: 'secret.tester1@sign-ret.test', requireEmailOtp: true },
        { routingOrder: 2, signerRole: 'signer', name: 'Secret Tester 2', email: 'secret.tester2@sign-ret.test', requireEmailOtp: true },
        { routingOrder: 3, signerRole: 'signer', name: 'Secret Tester 3', email: 'secret.tester3@sign-ret.test', requireEmailOtp: true },
      ],
    });
    const signerId = env.signerIds[0]!;
    const signer2Id = env.signerIds[1]!;
    const signer3Id = env.signerIds[2]!;
    const activeTokenId = env.links[0]!.tokenId;

    const insertToken = async (opts: {
      signerId: string;
      expiresAtSql: string;
      usedAtSql?: string;
      revokedAtSql?: string;
    }): Promise<string> => {
      const hash = hashSigningToken(generateRawSigningToken());
      const res = await adminPool!.query<{ id: string }>(
        `INSERT INTO crove_sign.signing_token
           (org_id, envelope_id, signer_id, token_sha256, expires_at, used_at, revoked_at, revoked_by, created_by)
         VALUES ($1, $2, $3, $4, ${opts.expiresAtSql}, ${opts.usedAtSql ?? 'NULL'}, ${opts.revokedAtSql ?? 'NULL'}, ${
           opts.revokedAtSql ? '$5' : 'NULL'
         }, $5)
         RETURNING id`,
        [orgA, env.envelopeId, opts.signerId, hash, ownerA],
      );
      return res.rows[0]!.id;
    };

    const insertOtp = async (opts: { expiresAtSql: string; createdAtSql: string; verifiedAtSql?: string; invalidatedAtSql?: string }): Promise<string> => {
      const res = await adminPool!.query<{ id: string }>(
        `INSERT INTO crove_sign.signing_otp
           (org_id, signer_id, signing_token_id, email, otp_sha256, expires_at, verified_at, invalidated_at, created_at)
         VALUES ($1, $2, $3, $4, $5, ${opts.expiresAtSql}, ${opts.verifiedAtSql ?? 'NULL'}, ${opts.invalidatedAtSql ?? 'NULL'}, ${opts.createdAtSql})
         RETURNING id`,
        [orgA, signerId, activeTokenId, 'secret.tester1@sign-ret.test', sha256Hex(`otp-${randomUUID()}`)],
      );
      return res.rows[0]!.id;
    };

    // Tokens: >30d dead -> pruned; <30d dead & active -> kept. Unrevoked/unused tokens sit on waiting signers 2 and 3.
    const tokExpired31d = await insertToken({ signerId: signer2Id, expiresAtSql: "now() - interval '31 days'" });
    const tokExpired31dVoided1h = await insertToken({
      signerId,
      expiresAtSql: "now() - interval '31 days'",
      revokedAtSql: "now() - interval '1 hour'",
    });
    const tokUsed31d = await insertToken({ signerId, expiresAtSql: "now() + interval '5 days'", usedAtSql: "now() - interval '31 days'" });
    const tokRevoked31d = await insertToken({ signerId, expiresAtSql: "now() + interval '5 days'", revokedAtSql: "now() - interval '31 days'" });
    const tokExpired29d = await insertToken({ signerId: signer3Id, expiresAtSql: "now() - interval '29 days'" });
    const tokUsed15d = await insertToken({ signerId, expiresAtSql: "now() + interval '5 days'", usedAtSql: "now() - interval '15 days'" });
    const tokRevoked15d = await insertToken({ signerId, expiresAtSql: "now() + interval '5 days'", revokedAtSql: "now() - interval '15 days'" });

    // OTPs: >24h dead -> pruned; <24h dead & active -> kept.
    const otpExpired25h = await insertOtp({ expiresAtSql: "now() - interval '25 hours'", createdAtSql: "now() - interval '26 hours'" });
    const otpInvalid25h = await insertOtp({
      expiresAtSql: "now() + interval '1 day'",
      createdAtSql: "now() - interval '26 hours'",
      invalidatedAtSql: "now() - interval '25 hours'",
    });
    const otpVerified25h = await insertOtp({
      expiresAtSql: "now() + interval '1 day'",
      createdAtSql: "now() - interval '26 hours'",
      verifiedAtSql: "now() - interval '25 hours'",
    });
    const otpExpired23h = await insertOtp({ expiresAtSql: "now() - interval '23 hours'", createdAtSql: "now() - interval '24 hours'" });
    const otpVerified23h = await insertOtp({
      expiresAtSql: "now() + interval '1 day'",
      createdAtSql: "now() - interval '24 hours'",
      verifiedAtSql: "now() - interval '23 hours'",
    });
    const otpActive = await insertOtp({ expiresAtSql: "now() + interval '10 minutes'", createdAtSql: 'now()' });

    const cleanupRes = await workerRuntime.execute<{ otps: number; tokens: number; drafts: number; draftEvents: number }>(
      'sign.org.cleanup',
      {},
      { actor: asSystem('sign-worker'), orgId: orgA },
    );
    expect(cleanupRes).toEqual({ otps: 3, tokens: 4, drafts: 0, draftEvents: 0 });

    const tokensAfter = await adminPool!.query<{ id: string }>(
      'SELECT id FROM crove_sign.signing_token WHERE org_id = $1 AND envelope_id = $2',
      [orgA, env.envelopeId],
    );
    const tokenSet = new Set(tokensAfter.rows.map((r) => r.id));
    expect(tokenSet.has(tokExpired31d)).toBe(false);
    expect(tokenSet.has(tokExpired31dVoided1h)).toBe(false);
    expect(tokenSet.has(tokUsed31d)).toBe(false);
    expect(tokenSet.has(tokRevoked31d)).toBe(false);
    expect(tokenSet.has(tokExpired29d)).toBe(true);
    expect(tokenSet.has(tokUsed15d)).toBe(true);
    expect(tokenSet.has(tokRevoked15d)).toBe(true);
    expect(tokenSet.has(activeTokenId)).toBe(true);

    const otpsAfter = await adminPool!.query<{ id: string }>(
      'SELECT id FROM crove_sign.signing_otp WHERE org_id = $1 AND signer_id = $2',
      [orgA, signerId],
    );
    const otpSet = new Set(otpsAfter.rows.map((r) => r.id));
    expect(otpSet.has(otpExpired25h)).toBe(false);
    expect(otpSet.has(otpInvalid25h)).toBe(false);
    expect(otpSet.has(otpVerified25h)).toBe(false);
    expect(otpSet.has(otpExpired23h)).toBe(true);
    expect(otpSet.has(otpVerified23h)).toBe(true);
    expect(otpSet.has(otpActive)).toBe(true);
  });

  it('erases signers across all unsealed envelope statuses (draft, voided, expired, declined) while keeping sealed/active signers and audit chain', async () => {
    const targetEmail = 'target.signer@sign-ret.test';
    const targetPhone = '+84909123456';
    const targetPhoneLocal = '0909123456';
    const coSignerEmail = 'cosigner@sign-ret.test';

    // E1: draft (unsealed)
    const e1Draft = await createPassedDraft({
      actorUserId: ownerA,
      orgId: orgA,
      title: 'E1 Draft Unsealed',
      routingMode: 'parallel',
      signers: [
        { routingOrder: 1, signerRole: 'signer', name: 'Target Draft', email: targetEmail, phone: targetPhone },
        { routingOrder: 1, signerRole: 'signer', name: 'CoSigner Draft', email: coSignerEmail },
      ],
    });

    // E2: voided after target signer completed OTP + typed signature + PNG field (still unsealed)
    const e2Voided = await setupActiveEnvelope({
      actorUserId: ownerA,
      orgId: orgA,
      title: 'E2 Voided Unsealed',
      routingMode: 'sequential',
      signers: [
        { routingOrder: 1, signerRole: 'signer', name: 'Target Voided', email: targetEmail, phone: targetPhone, requireEmailOtp: true },
        { routingOrder: 2, signerRole: 'signer', name: 'CoSigner Voided', email: coSignerEmail },
      ],
    });
    const e2TargetSignerId = e2Voided.signerIds[0]!;
    const e2TargetFieldId = e2Voided.fieldIdsBySigner.get(e2TargetSignerId)![0]!;
    const e2TargetHash = hashSigningToken(e2Voided.links[0]!.token);

    await appPool!.query('SELECT crove_sign.public_request_otp($1, $2)', [e2TargetHash, DEFAULT_MESSAGE_ID_DOMAIN]);
    const e2OtpRow = await adminPool!.query<{ id: string }>(
      'SELECT id FROM crove_sign.signing_otp WHERE org_id = $1 AND signer_id = $2 ORDER BY created_at DESC LIMIT 1',
      [orgA, e2TargetSignerId],
    );
    const e2OtpMail = await workerRuntime.execute<{ code: string }>(
      'sign.public.otp_mail_data',
      { signerId: e2TargetSignerId, otpId: e2OtpRow.rows[0]!.id },
      { actor: asSystem('mail-worker'), orgId: orgA },
    );
    const otpVerified = await appPool!.query<{ v: { ok: boolean } }>('SELECT crove_sign.public_verify_otp($1, $2, $3, $4) AS v', [
      e2TargetHash,
      e2OtpMail.code,
      ipHash,
      'RetTest/1.0',
    ]);
    expect(otpVerified.rows[0]?.v.ok).toBe(true);

    const e2Submit = await appPool!.query<{ v: { status: string } }>(
      "SELECT crove_sign.public_submit($1, true, 'type', 'Target Typed Signature', $2::jsonb, $3, 'RetTest/1.0', $4) AS v",
      [e2TargetHash, JSON.stringify([{ fieldId: e2TargetFieldId, signaturePngBase64: VALID_PNG_BASE64 }]), ipHash, DEFAULT_MESSAGE_ID_DOMAIN],
    );
    expect(e2Submit.rows[0]?.v).toMatchObject({ status: 'ok' });

    await runtime.execute(
      'sign.envelope.void',
      { envelopeId: e2Voided.envelopeId, reason: 'Void before second signer' },
      { actor: asUser(ownerA), orgId: orgA },
    );

    // E3: expired via expire_sweep (unsealed)
    const e3Expired = await setupActiveEnvelope({
      actorUserId: ownerA,
      orgId: orgA,
      title: 'E3 Expired Unsealed',
      routingMode: 'parallel',
      signers: [
        { routingOrder: 1, signerRole: 'signer', name: 'Target Expired', email: targetEmail, phone: targetPhone },
        { routingOrder: 1, signerRole: 'signer', name: 'CoSigner Expired', email: coSignerEmail },
      ],
    });
    await adminPool!.query("UPDATE crove_sign.envelope SET expires_at = now() - interval '2 hours' WHERE id = $1", [e3Expired.envelopeId]);
    await workerRuntime.execute('sign.envelope.expire_sweep', {}, { actor: asSystem('sign-worker'), orgId: orgA });

    // E4: declined via public_decline (unsealed)
    const e4Declined = await setupActiveEnvelope({
      actorUserId: ownerA,
      orgId: orgA,
      title: 'E4 Declined Unsealed',
      routingMode: 'parallel',
      signers: [
        { routingOrder: 1, signerRole: 'signer', name: 'Target Declined', email: targetEmail, phone: targetPhone },
        { routingOrder: 1, signerRole: 'signer', name: 'CoSigner Declined', email: coSignerEmail },
      ],
    });
    const e4TargetHash = hashSigningToken(e4Declined.links.find((l) => l.signerId === e4Declined.signerIds[0])!.token);
    const e4DeclineRes = await appPool!.query<{ v: { status: string } }>(
      "SELECT crove_sign.public_decline($1, 'Declined in test', $2, 'RetTest/1.0') AS v",
      [e4TargetHash, ipHash],
    );
    expect(e4DeclineRes.rows[0]?.v).toMatchObject({ status: 'ok' });

    // E5: completed AND sealed (must stay keep_record)
    const e5Sealed = await setupActiveEnvelope({
      actorUserId: ownerA,
      orgId: orgA,
      title: 'E5 Completed Sealed',
      routingMode: 'parallel',
      signers: [{ routingOrder: 1, signerRole: 'signer', name: 'Target Sealed', email: targetEmail, phone: targetPhone }],
    });
    const e5TargetHash = hashSigningToken(e5Sealed.links[0]!.token);
    const e5FieldId = e5Sealed.fieldIdsBySigner.get(e5Sealed.signerIds[0]!)![0]!;
    const e5Submit = await appPool!.query<{ v: { status: string } }>(
      "SELECT crove_sign.public_submit($1, true, 'type', 'Target Sealed Name', $2::jsonb, $3, 'RetTest/1.0', $4) AS v",
      [e5TargetHash, JSON.stringify([{ fieldId: e5FieldId, signaturePngBase64: VALID_PNG_BASE64 }]), ipHash, DEFAULT_MESSAGE_ID_DOMAIN],
    );
    expect(e5Submit.rows[0]?.v).toMatchObject({ status: 'ok' });

    const sealedPdf = await ingestPdf(ownerA, orgA, `sealed-${randomUUID()}`, 'sign_sealed');
    const certPdf = await ingestPdf(ownerA, orgA, `cert-${randomUUID()}`, 'sign_certificate');
    await workerRuntime.execute(
      'sign.envelope.seal_complete',
      {
        envelopeId: e5Sealed.envelopeId,
        outcome: 'sealed',
        certificateCode: generateCertificateCode(e5Sealed.envelopeId, new Date().toISOString(), 'a'.repeat(64)),
        sealedFileId: sealedPdf.fileId,
        certificateFileId: certPdf.fileId,
      },
      { actor: asSystem('sign-worker'), orgId: orgA },
    );

    // E6: active 'sent' envelope (must stay keep_record)
    const e6Active = await setupActiveEnvelope({
      actorUserId: ownerA,
      orgId: orgA,
      title: 'E6 Active Sent',
      routingMode: 'parallel',
      signers: [{ routingOrder: 1, signerRole: 'signer', name: 'Target Active', email: targetEmail, phone: targetPhone }],
    });

    const eventCountBefore = await adminPool!.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM crove_sign.signing_event WHERE org_id = $1',
      [orgA],
    );

    // 1) findPersonalData classifies E1..E4 as erase and E5..E6 as keep_record for both email and phone.
    const foundByEmail = await runtime.execute<PersonalDataResult>(
      'kernel.personal_data.find',
      { value: targetEmail },
      { actor: asMfa(ownerA), orgId: orgA },
    );
    const unsealedSignerIds = new Set([
      e1Draft.signerIds[0]!,
      e2Voided.signerIds[0]!,
      e3Expired.signerIds[0]!,
      e4Declined.signerIds[0]!,
    ]);
    const unsealedFieldIds = new Set([
      ...e1Draft.fieldIdsBySigner.get(e1Draft.signerIds[0]!)!,
      ...e2Voided.fieldIdsBySigner.get(e2Voided.signerIds[0]!)!,
      ...e3Expired.fieldIdsBySigner.get(e3Expired.signerIds[0]!)!,
      ...e4Declined.fieldIdsBySigner.get(e4Declined.signerIds[0]!)!,
    ]);
    const preservedSignerIds = new Set([e5Sealed.signerIds[0]!, e6Active.signerIds[0]!]);

    const emailSignerMatches = foundByEmail.matches.filter((m) => m.column === 'crove_sign.signer.email');
    expect(emailSignerMatches).toHaveLength(6);
    for (const m of emailSignerMatches) {
      if (unsealedSignerIds.has(m.rowId!)) {
        expect(m.handling).toBe('erase');
      } else {
        expect(preservedSignerIds.has(m.rowId!)).toBe(true);
        expect(m.handling).toBe('keep_record');
      }
    }

    const foundByPhone = await runtime.execute<PersonalDataResult>(
      'kernel.personal_data.find',
      { value: targetPhoneLocal },
      { actor: asMfa(ownerA), orgId: orgA },
    );
    const phoneSignerMatches = foundByPhone.matches.filter((m) => m.column === 'crove_sign.signer.phone');
    expect(phoneSignerMatches).toHaveLength(6);
    for (const m of phoneSignerMatches) {
      expect(m.handling).toBe(unsealedSignerIds.has(m.rowId!) ? 'erase' : 'keep_record');
    }

    // 2) RBAC and direct SQL trigger protection: admin cannot erase, and crove_app cannot forge the internal GUC.
    await expect(
      runtime.execute('kernel.personal_data.erase', { value: targetEmail }, { actor: asMfa(adminA), orgId: orgA }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const appClient = await appPool!.connect();
    try {
      const adminToken = mintContextToken(process.env.CROVE_CONTEXT_TOKEN_KEY ?? '', {
        userId: adminA,
        orgId: orgA,
        sessionId: null,
        aal: 'aal2',
        mfaAt: Math.floor(Date.now() / 1000),
      });
      await appClient.query('BEGIN');
      await appClient.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgA, adminToken]);
      await appClient.query('SAVEPOINT sp_non_owner');
      await expect(
        appClient.query("SELECT crove_sign.personal_erase_unsealed_signers('email', $1)", [targetEmail]),
      ).rejects.toThrow(/SIGN_FORBIDDEN/);
      await appClient.query('ROLLBACK TO SAVEPOINT sp_non_owner');
      await appClient.query('ROLLBACK');

      const ownerToken = mintContextToken(process.env.CROVE_CONTEXT_TOKEN_KEY ?? '', {
        userId: ownerA,
        orgId: orgA,
        sessionId: null,
        aal: 'aal2',
        mfaAt: Math.floor(Date.now() / 1000),
      });
      await appClient.query('BEGIN');
      await appClient.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgA, ownerToken]);
      await appClient.query('SAVEPOINT sp_forged_guc');
      await appClient.query(`SET LOCAL crove.sign_personal_erase = '${orgA}'`);
      await expect(
        appClient.query('DELETE FROM crove_sign.signer WHERE org_id = $1 AND id = $2', [orgA, e2TargetSignerId]),
      ).rejects.toThrow(/ENVELOPE_FROZEN/);
      await appClient.query('ROLLBACK TO SAVEPOINT sp_forged_guc');
      await appClient.query('ROLLBACK');
    } finally {
      appClient.release();
    }

    // 3) Owner erases by email: E1..E4 target signers, fields, tokens, and OTPs vanish; co-signers and E5..E6 stay intact.
    const eraseByEmail = await runtime.execute<PersonalDataErasure>(
      'kernel.personal_data.erase',
      { value: targetEmail },
      { actor: asMfa(ownerA), orgId: orgA },
    );
    expect(eraseByEmail.erased).toEqual(
      expect.arrayContaining([
        { column: 'crove_sign.signer.email', rows: 4 },
        { column: 'crove_sign.signer.phone', rows: 4 },
        { column: 'crove_sign.signer.signature_typed_text', rows: 1 },
        { column: 'crove_sign.signer.signer_user_agent', rows: 2 },
        { column: 'crove_sign.field.signature_png_base64', rows: 1 },
        { column: 'crove_sign.signing_otp.email', rows: 1 },
      ]),
    );
    expect(eraseByEmail.kept).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ column: 'crove_sign.signer.email', rows: 2 }),
      ]),
    );

    const remainingPhoneMatches = await runtime.execute<PersonalDataResult>(
      'kernel.personal_data.find',
      { value: targetPhoneLocal },
      { actor: asMfa(ownerA), orgId: orgA },
    );
    const remainingPhones = remainingPhoneMatches.matches.filter((m) => m.column === 'crove_sign.signer.phone');
    expect(remainingPhones).toHaveLength(2);
    expect(remainingPhones.every((m) => preservedSignerIds.has(m.rowId!) && m.handling === 'keep_record')).toBe(true);

    const deletedSignersCheck = await adminPool!.query<{ id: string }>(
      'SELECT id FROM crove_sign.signer WHERE id = ANY($1::uuid[])',
      [[...unsealedSignerIds]],
    );
    expect(deletedSignersCheck.rows).toEqual([]);

    const deletedFieldsCheck = await adminPool!.query<{ id: string }>(
      'SELECT id FROM crove_sign.field WHERE id = ANY($1::uuid[])',
      [[...unsealedFieldIds]],
    );
    expect(deletedFieldsCheck.rows).toEqual([]);

    const deletedTokensCheck = await adminPool!.query<{ id: string }>(
      'SELECT id FROM crove_sign.signing_token WHERE signer_id = ANY($1::uuid[])',
      [[...unsealedSignerIds]],
    );
    expect(deletedTokensCheck.rows).toEqual([]);

    const deletedOtpsCheck = await adminPool!.query<{ id: string }>(
      'SELECT id FROM crove_sign.signing_otp WHERE signer_id = ANY($1::uuid[])',
      [[...unsealedSignerIds]],
    );
    expect(deletedOtpsCheck.rows).toEqual([]);

    // Non-matching co-signers on E1..E4 and target signers on E5..E6 remain untouched.
    const intactSignerIds = [
      e1Draft.signerIds[1]!,
      e2Voided.signerIds[1]!,
      e3Expired.signerIds[1]!,
      e4Declined.signerIds[1]!,
      e5Sealed.signerIds[0]!,
      e6Active.signerIds[0]!,
    ];
    const intactCheck = await adminPool!.query<{ id: string }>(
      'SELECT id FROM crove_sign.signer WHERE id = ANY($1::uuid[])',
      [intactSignerIds],
    );
    expect(intactCheck.rows).toHaveLength(6);

    // Event log and hash chain are strictly untouched and valid.
    const eventCountAfter = await adminPool!.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM crove_sign.signing_event WHERE org_id = $1',
      [orgA],
    );
    expect(eventCountAfter.rows[0]?.n).toBe(eventCountBefore.rows[0]?.n);

    for (const envId of [e1Draft.envelopeId, e2Voided.envelopeId, e3Expired.envelopeId, e4Declined.envelopeId, e5Sealed.envelopeId, e6Active.envelopeId]) {
      const chainRows = await adminPool!.query<SigningEventChainRow>(
        `SELECT id, org_id, envelope_id, signer_id, seq, event_type, actor_type, actor_id, actor_label,
                ip_hash, user_agent, document_sha256, prev_event_hash, event_hash, payload_json, occurred_at
         FROM crove_sign.signing_event
         WHERE org_id = $1 AND envelope_id = $2
         ORDER BY seq ASC`,
        [orgA, envId],
      );
      expect(verifyEventChain(chainRows.rows)).toMatchObject({ valid: true, brokenSeq: null, reason: null });
    }

    // 4) Phone lookup also erases unsealed signers across phone-only matches.
    const e7PhoneVoid = await setupActiveEnvelope({
      actorUserId: ownerA,
      orgId: orgA,
      title: 'E7 Phone Only Void',
      routingMode: 'parallel',
      signers: [
        {
          routingOrder: 1,
          signerRole: 'signer',
          name: 'Phone Match Signer',
          email: 'phone.only.erasure@sign-ret.test',
          phone: '+84908765432',
        },
      ],
    });
    await runtime.execute('sign.envelope.void', { envelopeId: e7PhoneVoid.envelopeId }, { actor: asUser(ownerA), orgId: orgA });

    const eraseByPhone = await runtime.execute<PersonalDataErasure>(
      'kernel.personal_data.erase',
      { value: '0908765432' },
      { actor: asMfa(ownerA), orgId: orgA },
    );
    expect(eraseByPhone.erased).toEqual(
      expect.arrayContaining([
        { column: 'crove_sign.signer.email', rows: 1 },
        { column: 'crove_sign.signer.phone', rows: 1 },
      ]),
    );
    const e7Remaining = await adminPool!.query<{ id: string }>(
      'SELECT id FROM crove_sign.signer WHERE envelope_id = $1',
      [e7PhoneVoid.envelopeId],
    );
    expect(e7Remaining.rows).toEqual([]);
  });

  it('orders expire_sweep_due_orgs, cleanup_due_orgs, and cleanup_due_orgs_secrets deterministically by org_id ASC (#3428 L4)', async () => {
    const setupDueOrg = async (actorUserId: string, orgId: string, title: string) => {
      const env = await setupActiveEnvelope({
        actorUserId,
        orgId,
        title,
        routingMode: 'parallel',
        signers: [{ routingOrder: 1, signerRole: 'signer', name: 'Order Signer', email: `order-${orgId.slice(0, 6)}@sign-ret.test` }],
      });
      await adminPool!.query("UPDATE crove_sign.envelope SET expires_at = now() - interval '1 hour' WHERE id = $1", [env.envelopeId]);
      await adminPool!.query(
        `INSERT INTO crove_sign.signing_otp (org_id, signer_id, signing_token_id, email, otp_sha256, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5, now() - interval '30 hours', now() - interval '31 hours')`,
        [orgId, env.signerIds[0]!, env.links[0]!.tokenId, `order-${orgId.slice(0, 6)}@sign-ret.test`, sha256Hex(`ord-${orgId}`)],
      );
      await adminPool!.query(
        `INSERT INTO crove_sign.signing_token (org_id, envelope_id, signer_id, token_sha256, expires_at, revoked_at, revoked_by, created_by)
         VALUES ($1, $2, $3, $4, now() - interval '35 days', now() - interval '35 days', $5, $5)`,
        [orgId, env.envelopeId, env.signerIds[0]!, hashSigningToken(generateRawSigningToken()), actorUserId],
      );
    };

    // Insert orgB before orgA so heap scan order would disagree with ASC when orgB > orgA.
    await setupDueOrg(ownerB, orgB, 'Order B');
    await setupDueOrg(ownerA, orgA, 'Order A');

    const expectedOrder = [orgA, orgB].sort();

    const expireDue = await workerPool!.query<{ org_id: string }>('SELECT org_id FROM crove_sign.expire_sweep_due_orgs(100)');
    expect(expireDue.rows.map((r) => r.org_id)).toEqual(expectedOrder);

    const cleanupSecretsDue = await workerPool!.query<{ org_id: string }>(
      "SELECT org_id FROM crove_sign.cleanup_due_orgs_secrets(now() - interval '24 hours', now() - interval '30 days', 100)",
    );
    expect(cleanupSecretsDue.rows.map((r) => r.org_id)).toEqual(expectedOrder);

    const cleanupCompatDue = await workerPool!.query<{ org_id: string }>(
      "SELECT org_id FROM crove_sign.cleanup_due_orgs(now() - interval '90 days', now() - interval '30 days', 100)",
    );
    expect(cleanupCompatDue.rows.map((r) => r.org_id)).toEqual(expectedOrder);
  });

  it('preserves completed-unsealed (pending seal) signers and runs personal_data.erase concurrently with sign.org.cleanup without deadlock', async () => {
    const pendingSealEmail = 'pending.seal@sign-ret.test';
    const pendingSeal = await setupActiveEnvelope({
      actorUserId: ownerA,
      orgId: orgA,
      title: 'Completed Pending Seal',
      routingMode: 'parallel',
      signers: [{ routingOrder: 1, signerRole: 'signer', name: 'Pending Seal Signer', email: pendingSealEmail }],
    });
    const pendingHash = hashSigningToken(pendingSeal.links[0]!.token);
    const pendingFieldId = pendingSeal.fieldIdsBySigner.get(pendingSeal.signerIds[0]!)![0]!;
    const pendingSubmit = await appPool!.query<{ v: { status: string } }>(
      "SELECT crove_sign.public_submit($1, true, 'type', 'Pending Seal Name', $2::jsonb, $3, 'RetTest/1.0', $4) AS v",
      [pendingHash, JSON.stringify([{ fieldId: pendingFieldId, signaturePngBase64: VALID_PNG_BASE64 }]), ipHash, DEFAULT_MESSAGE_ID_DOMAIN],
    );
    expect(pendingSubmit.rows[0]?.v).toMatchObject({ status: 'ok' });

    const pendingFound = await runtime.execute<PersonalDataResult>(
      'kernel.personal_data.find',
      { value: pendingSealEmail },
      { actor: asMfa(ownerA), orgId: orgA },
    );
    expect(pendingFound.matches.filter((m) => m.column === 'crove_sign.signer.email')).toHaveLength(1);
    expect(pendingFound.matches.find((m) => m.column === 'crove_sign.signer.email')?.handling).toBe('keep_record');

    const pendingErased = await runtime.execute<PersonalDataErasure>(
      'kernel.personal_data.erase',
      { value: pendingSealEmail },
      { actor: asMfa(ownerA), orgId: orgA },
    );
    expect(pendingErased.kept).toEqual(
      expect.arrayContaining([expect.objectContaining({ column: 'crove_sign.signer.email', rows: 1 })]),
    );
    const pendingSignerRows = await adminPool!.query<{ id: string }>(
      'SELECT id FROM crove_sign.signer WHERE org_id = $1 AND envelope_id = $2',
      [orgA, pendingSeal.envelopeId],
    );
    expect(pendingSignerRows.rows).toHaveLength(1);

    // Concurrent cleanup + PDPL erasure (phone and email) sharing overdue OTPs and dead tokens on unsealed signers.
    for (let round = 0; round < 5; round++) {
      const email = `concurrent.${round}.${randomUUID().slice(0, 8)}@sign-ret.test`;
      const phoneDigits = `09123456${String(10 + round)}`;
      const phoneIntl = `+84${phoneDigits.slice(1)}`;
      const env = await setupActiveEnvelope({
        actorUserId: ownerA,
        orgId: orgA,
        title: `Concurrent Lock Order ${round}`,
        routingMode: 'parallel',
        signers: [{ routingOrder: 1, signerRole: 'signer', name: `Concurrent ${round}`, email, phone: phoneIntl }],
      });
      await runtime.execute('sign.envelope.void', { envelopeId: env.envelopeId }, { actor: asUser(ownerA), orgId: orgA });

      const signerId = env.signerIds[0]!;
      const deadTokenRes = await adminPool!.query<{ id: string }>(
        `INSERT INTO crove_sign.signing_token (org_id, envelope_id, signer_id, token_sha256, expires_at, revoked_at, revoked_by, created_by)
         VALUES ($1, $2, $3, $4, now() - interval '35 days', now() - interval '35 days', $5, $5)
         RETURNING id`,
        [orgA, env.envelopeId, signerId, hashSigningToken(generateRawSigningToken()), ownerA],
      );
      const deadTokenId = deadTokenRes.rows[0]!.id;
      await adminPool!.query(
        `INSERT INTO crove_sign.signing_otp (org_id, signer_id, signing_token_id, email, otp_sha256, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5, now() - interval '30 hours', now() - interval '31 hours')`,
        [orgA, signerId, deadTokenId, email, sha256Hex(`conc-${round}`)],
      );

      await Promise.all([
        workerRuntime.execute('sign.org.cleanup', {}, { actor: asSystem('sign-worker'), orgId: orgA }),
        runtime.execute('kernel.personal_data.erase', { value: phoneDigits }, { actor: asMfa(ownerA), orgId: orgA }),
        runtime.execute('kernel.personal_data.erase', { value: email }, { actor: asMfa(ownerA), orgId: orgA }),
      ]);

      const remaining = await adminPool!.query<{ n: string }>(
        `SELECT (
           (SELECT count(*) FROM crove_sign.signer WHERE org_id = $1 AND envelope_id = $2)
           + (SELECT count(*) FROM crove_sign.signing_token WHERE org_id = $1 AND envelope_id = $2)
           + (SELECT count(*) FROM crove_sign.signing_otp WHERE org_id = $1 AND signer_id = $3)
         )::text AS n`,
        [orgA, env.envelopeId, signerId],
      );
      expect(remaining.rows[0]?.n).toBe('0');
    }
  });
});
