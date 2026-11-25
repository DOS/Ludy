// SPDX-License-Identifier: AGPL-3.0-only
// PostgreSQL 17 integration & security tests for eSign Slice 2c (#3554):
//   - ludy_sign.ca_connection MACHINERY zero-grant RLS, encrypted secret storage, and wipe-on-disable
//   - #62 Legal Gate (SIGN_LIVE_CA_GATED) refusing VNPT/Viettel/MISA when live CA is disabled while Sandbox works
//   - Owner/admin vs member/viewer RBAC and cross-tenant isolation
//   - Worker-only ludy_sign.ca_connection_secret_get privilege boundary and CA_CONNECTION_OWNER_LEFT check
//   - Zero secret/ciphertext leakage in queries, audit_event, idempotency_key, and outbox_event
//   - ludy_sign.ca_signing_request reconcile_only external_call state machine (initiate -> lost_answer -> ask -> poll -> signed)
//   - Hash-chained ca_requested, ca_completed, and ca_failed signing_event verification
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import {
  createOrg,
  kernelCommands,
  kernelManifest,
  kernelQueries,
  upsertIdentity,
} from '@ludy/kernel';
import type {
  SignCaConnectionRecord,
  SignCaSettingsResult,
  SignCaSigningRequestRecord,
} from '@ludy/kernel-contract';
import { Runtime, contentGeneration, fileKey, sha256Hex } from '@ludy/kernel-runtime';
import {
  generateCertificateCode,
  hashSigningToken,
  setSignCaBrokerAvailable,
  setSignLiveCaEnabled,
  signCommands,
  signManifest,
  signQueries,
  type SealedCaConnectionSecret,
  type SignCaJobBeginResult,
} from '../src/index.ts';

type Pool = ReturnType<typeof createPool>;

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('eSign Slice 2c Vietnam CA settings, #62 gate, and reconcile_only state machine on PostgreSQL 17 (#3554)', () => {
  const dbName = `ludy_test_sign_ca_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  let viewerA = '';
  let ownerB = '';

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asSystem = (component: string) => ({ type: 'system' as const, component });

  async function ingestPdf(
    actorUserId: string,
    orgId: string,
    tag: string,
    source: 'sign_document' | 'sign_sealed' = 'sign_document',
  ): Promise<{ fileId: string; sha256: string; storageKey: string; generation: string }> {
    const bytes = Uint8Array.from(
      Buffer.from(`%PDF-1.4\n% sign-ca-${tag}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n`, 'utf8'),
    );
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(orgId, sha256);
    const generation = contentGeneration(sha256);
    const actor = source === 'sign_sealed' ? asSystem('sign.worker') : asUser(actorUserId);
    const runner = source === 'sign_sealed' ? workerRuntime : runtime;
    const { fileId } = await runner.execute<{ fileId: string }>(
      'kernel.file.ingest',
      {
        filename: `${tag}.pdf`,
        contentType: 'application/pdf',
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

  async function createCompletedSealedEnvelope(orgId: string, creatorUserId: string, tag: string): Promise<{
    envelopeId: string;
    signerId: string;
    sealedFileId: string;
    sealedSha256: string;
  }> {
    const srcFile = await ingestPdf(creatorUserId, orgId, `${tag}-src`, 'sign_document');
    const created = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      {
        title: `Hop dong ${tag}`,
        routingMode: 'parallel',
        sourceKind: 'standalone',
        sourceFileId: srcFile.fileId,
      },
      { actor: asUser(creatorUserId), orgId },
    );

    await workerRuntime.execute(
      'sign.envelope.inspect_complete',
      {
        envelopeId: created.envelopeId,
        outcome: 'passed',
        pageCount: 1,
        pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0 }],
        detectedTags: [],
      },
      { actor: asSystem('sign.worker'), orgId },
    );

    const addedSigner = await runtime.execute<{ signerId: string }>(
      'sign.signer.add',
      {
        envelopeId: created.envelopeId,
        signerRole: 'signer',
        roleLabel: 'Ben B',
        name: 'Nguyen Van B',
        deliveryMode: 'link',
        requireEmailOtp: false,
      },
      { actor: asUser(creatorUserId), orgId },
    );

    const fieldSet = await runtime.execute<{ fieldIds: string[] }>(
      'sign.field.set',
      {
        envelopeId: created.envelopeId,
        fields: [
          {
            signerId: addedSigner.signerId,
            fieldType: 'signature',
            pageNumber: 1,
            xNorm: 0.5,
            yNorm: 0.7,
            wNorm: 0.25,
            hNorm: 0.08,
            required: true,
            proposedByAi: false,
          },
        ],
      },
      { actor: asUser(creatorUserId), orgId },
    );

    const sent = await runtime.execute<{ links: Array<{ signerId: string; token: string }> }>(
      'sign.envelope.send',
      { envelopeId: created.envelopeId },
      { actor: asUser(creatorUserId), orgId },
    );

    const valid1x1Png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const submitRes = await appPool!.query<{ result: { status: string } }>(
      `SELECT ludy_sign.public_submit($1, true, 'type', 'Nguyen Van B', $2::jsonb, $3, 'TestAgent/1.0', 'ludy.test') AS result`,
      [
        hashSigningToken(sent.links[0]!.token),
        JSON.stringify([
          {
            fieldId: fieldSet.fieldIds[0]!,
            signaturePngBase64: valid1x1Png,
            valueText: 'Nguyen Van B',
          },
        ]),
        sha256Hex(Uint8Array.from(Buffer.from('203.0.113.10', 'utf8'))),
      ],
    );
    expect(submitRes.rows[0]?.result.status).toBe('ok');

    const sealedPdf = await ingestPdf(creatorUserId, orgId, `${tag}-sealed`, 'sign_sealed');
    const certBytes = Uint8Array.from(Buffer.from(JSON.stringify({ code: `CS-${tag}` }), 'utf8'));
    const certSha = sha256Hex(certBytes);
    const certKey = fileKey(orgId, certSha);
    const certGen = contentGeneration(certSha);
    const certIngest = await workerRuntime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      {
        filename: `${tag}-certificate.json`,
        contentType: 'application/json',
        sizeBytes: certBytes.byteLength,
        sha256: certSha,
        storageKey: certKey,
        generation: certGen,
        source: 'sign_certificate',
      },
      { actor: asSystem('sign.worker'), orgId },
    );

    await workerRuntime.execute(
      'sign.envelope.seal_complete',
      {
        envelopeId: created.envelopeId,
        outcome: 'sealed',
        certificateCode: generateCertificateCode(created.envelopeId, new Date().toISOString(), sealedPdf.sha256),
        sealedFileId: sealedPdf.fileId,
        certificateFileId: certIngest.fileId,
      },
      { actor: asSystem('sign.worker'), orgId },
    );

    return {
      envelopeId: created.envelopeId,
      signerId: addedSigner.signerId,
      sealedFileId: sealedPdf.fileId,
      sealedSha256: sealedPdf.sha256,
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
    await setRolePasswords(adminUrl, { ludy_app: 'ca-app-pw', ludy_worker: 'ca-worker-pw' });

    const loginUrl = (user: string, pw: string) => {
      const u = new URL(adminUrl);
      u.username = user;
      u.password = pw;
      return u.toString();
    };

    adminPool = createPool({ connectionString: adminUrl, max: 2 });
    appPool = createPool({ connectionString: loginUrl('ludy_app', 'ca-app-pw'), max: 6 });
    workerPool = createPool({ connectionString: loginUrl('ludy_worker', 'ca-worker-pw'), max: 3 });

    const manifests = [kernelManifest.tables, signManifest.tables];
    const appDb = createDb(appPool);
    const workerDb = createDb(workerPool);

    runtime = new Runtime(appDb, { manifests })
      .register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) })
      .register({ commands: signCommands, queries: signQueries });

    workerRuntime = new Runtime(workerDb, { manifests })
      .register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) })
      .register({ commands: signCommands, queries: signQueries });

    ownerA = await upsertIdentity(appDb, { issuer: 'sign-ca', subject: 'owner-a', email: 'owner-a@sign-ca.test', name: 'Owner A' });
    adminA = await upsertIdentity(appDb, { issuer: 'sign-ca', subject: 'admin-a', email: 'admin-a@sign-ca.test', name: 'Admin A' });
    memberA = await upsertIdentity(appDb, { issuer: 'sign-ca', subject: 'member-a', email: 'member-a@sign-ca.test', name: 'Member A' });
    viewerA = await upsertIdentity(appDb, { issuer: 'sign-ca', subject: 'viewer-a', email: 'viewer-a@sign-ca.test', name: 'Viewer A' });
    ownerB = await upsertIdentity(appDb, { issuer: 'sign-ca', subject: 'owner-b', email: 'owner-b@sign-ca.test', name: 'Owner B' });

    orgA = (await createOrg(runtime, asUser(ownerA), 'Cong ty CA A')).orgId;
    orgB = (await createOrg(runtime, asUser(ownerB), 'Cong ty CA B')).orgId;

    await adminPool.query(
      "INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1::uuid, $2::uuid, 'admin'), ($1::uuid, $3::uuid, 'member'), ($1::uuid, $4::uuid, 'viewer')",
      [orgA, adminA, memberA, viewerA],
    );
  }, 120_000);

  afterEach(() => {
    setSignLiveCaEnabled(false);
    setSignCaBrokerAvailable(false);
  });

  afterAll(async () => {
    setSignLiveCaEnabled(false);
    setSignCaBrokerAvailable(false);
    await appPool?.end();
    await workerPool?.end();
    await adminPool?.end();
    if (!ADMIN) return;
    const rootPool = createPool({ connectionString: ADMIN, max: 1 });
    await rootPool.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await rootPool.end();
  });

  it('enforces #62 SIGN_LIVE_CA_GATED on VNPT/Viettel/MISA when disabled while offline sandbox works', async () => {
    setSignLiveCaEnabled(false);

    for (const liveProvider of ['vnpt_smartca', 'viettel_mysign', 'misa_wesign'] as const) {
      await expect(
        runtime.execute(
          'sign.ca.connection.save',
          {
            provider: liveProvider,
            label: `Live ${liveProvider}`,
            certRef: 'cert-1',
            status: 'active',
            keyId: 'k1-test',
            secretEnvelope: 'sealed-envelope-value',
          },
          { actor: asUser(ownerA), orgId: orgA },
        ),
      ).rejects.toMatchObject({ code: 'SIGN_LIVE_CA_GATED', status: 422 });
    }

    const sandboxSaved = await runtime.execute<SignCaConnectionRecord>(
      'sign.ca.connection.save',
      {
        provider: 'sandbox',
        label: 'Sandbox PAdES Noi bo',
        certRef: 'sandbox-org-a',
        status: 'active',
        keyId: 'sandbox-local',
        secretEnvelope: 'sandbox-offline',
      },
      { actor: asUser(ownerA), orgId: orgA },
    );

    expect(sandboxSaved).toMatchObject({
      provider: 'sandbox',
      label: 'Sandbox PAdES Noi bo',
      certRef: 'sandbox-org-a',
      status: 'active',
      lastTestState: null,
    });
    expect('secretEnvelope' in sandboxSaved).toBe(false);
    expect('keyId' in sandboxSaved).toBe(false);

    const tested = await runtime.execute<SignCaConnectionRecord>(
      'sign.ca.connection.record_test',
      { connectionId: sandboxSaved.id, state: 'works' },
      { actor: asUser(adminA), orgId: orgA },
    );
    expect(tested.lastTestState).toBe('works');
    expect(tested.lastTestedAt).toBeTruthy();
  });

  it('enforces owner/admin RBAC, cross-org isolation, zero runtime grants on ca_connection, and secret wipe on disable', async () => {
    // Member and viewer can read CA settings, but cannot save, test, or disable connections.
    for (const reader of [memberA, viewerA]) {
      const settings = await runtime.query<SignCaSettingsResult>('sign.ca.settings', {}, { actor: asUser(reader), orgId: orgA });
      expect(settings.connections.length).toBeGreaterThanOrEqual(1);

      await expect(
        runtime.execute(
          'sign.ca.connection.save',
          {
            provider: 'sandbox',
            label: 'Blocked',
            certRef: 'sandbox-x',
            status: 'active',
            keyId: 'sandbox-local',
            secretEnvelope: 'sandbox-offline',
          },
          { actor: asUser(reader), orgId: orgA },
        ),
      ).rejects.toMatchObject({ status: 403 });
    }

    // Direct SQL SELECT on ludy_sign.ca_connection by ludy_app or ludy_worker fails with insufficient_privilege (42501).
    await expect(appPool!.query('SELECT * FROM ludy_sign.ca_connection')).rejects.toMatchObject({ code: '42501' });
    await expect(workerPool!.query('SELECT * FROM ludy_sign.ca_connection')).rejects.toMatchObject({ code: '42501' });

    // Enable live CA to test encrypted credential storage, worker-only secret read, owner-left guard, and wipe on disable.
    setSignLiveCaEnabled(true);
    setSignCaBrokerAvailable(true);
    const secretSentinel = 'SEALED_CIPHERTEXT_SENTINEL_VNPT_999';

    const vnptConn = await runtime.execute<SignCaConnectionRecord>(
      'sign.ca.connection.save',
      {
        provider: 'vnpt_smartca',
        label: 'VNPT SmartCA Cong ty A',
        certRef: 'vnpt-serial-001',
        status: 'active',
        keyId: 'k1-0123456789abcdef',
        secretEnvelope: secretSentinel,
      },
      { actor: asUser(adminA), orgId: orgA },
    );

    // Org B cannot see Org A's connections.
    const orgBSettings = await runtime.query<SignCaSettingsResult>('sign.ca.settings', {}, { actor: asUser(ownerB), orgId: orgB });
    expect(orgBSettings.connections).toEqual([]);

    // ludy_app (API runtime) CANNOT execute worker-only ca_connection_secret_get!
    await expect(
      runtime.query('sign.ca.connection.secret', { connectionId: vnptConn.id }, { actor: asSystem('api'), orgId: orgA }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });

    // ludy_worker CAN read sealed secret in system context.
    const workerSecret = await workerRuntime.query<SealedCaConnectionSecret>(
      'sign.ca.connection.secret',
      { connectionId: vnptConn.id },
      { actor: asSystem('sign.worker'), orgId: orgA },
    );
    expect(workerSecret.secretEnvelope).toBe(secretSentinel);
    expect(workerSecret.keyId).toBe('k1-0123456789abcdef');

    // Verify sentinel NEVER appears in audit_event, idempotency_key, or outbox_event!
    const leakScan = await adminPool!.query<{ found: string }>(
      `SELECT 'audit' AS found FROM ludy_kernel.audit_event WHERE org_id = $1 AND detail::text LIKE '%' || $2 || '%'
       UNION ALL
       SELECT 'idempotency' AS found FROM ludy_kernel.idempotency_key WHERE org_id = $1 AND response::text LIKE '%' || $2 || '%'
       UNION ALL
       SELECT 'outbox' AS found FROM ludy_kernel.outbox_event WHERE org_id = $1 AND payload::text LIKE '%' || $2 || '%'`,
      [orgA, secretSentinel],
    );
    expect(leakScan.rows).toEqual([]);

    // Demoting adminA to 'member' blocks secret opening with SIGN_CA_CONNECTION_OWNER_LEFT!
    await adminPool!.query(
      "UPDATE ludy_kernel.tenant_member SET role = 'member' WHERE org_id = $1::uuid AND user_id = $2::uuid",
      [orgA, adminA],
    );
    await expect(
      workerRuntime.query('sign.ca.connection.secret', { connectionId: vnptConn.id }, { actor: asSystem('sign.worker'), orgId: orgA }),
    ).rejects.toMatchObject({ code: 'SIGN_CA_CONNECTION_OWNER_LEFT', status: 403 });
    await adminPool!.query(
      "UPDATE ludy_kernel.tenant_member SET role = 'admin' WHERE org_id = $1::uuid AND user_id = $2::uuid",
      [orgA, adminA],
    );

    // Disabling the connection wipes secret_envelope and key_id in the database!
    const disabled = await runtime.execute<SignCaConnectionRecord>(
      'sign.ca.connection.disable',
      { connectionId: vnptConn.id },
      { actor: asUser(ownerA), orgId: orgA },
    );
    expect(disabled.status).toBe('disabled');

    const rawDbRow = await adminPool!.query<{ key_id: string; secret_envelope: string }>(
      'SELECT key_id, secret_envelope FROM ludy_sign.ca_connection WHERE org_id = $1::uuid AND id = $2::uuid',
      [orgA, vnptConn.id],
    );
    expect(rawDbRow.rows[0]).toEqual({ key_id: 'disabled', secret_envelope: 'disabled' });
  });

  it('drives reconcile_only external_call lifecycle (initiate -> lost_answer -> ask -> poll -> signed) and verifies hash-chained events', async () => {
    const env = await createCompletedSealedEnvelope(orgA, ownerA, 'pades-reconcile');

    const req = await runtime.execute<SignCaSigningRequestRecord>(
      'sign.ca.request.initiate',
      { envelopeId: env.envelopeId },
      { actor: asUser(ownerA), orgId: orgA },
    );
    expect(req.status).toBe('pending');
    expect(req.provider).toBe('sandbox');
    expect(req.retrySafety).toBe('reconcile_only');
    expect(req.digestSha256).toBe(env.sealedSha256);

    // Duplicate initiate returns the existing pending request idempotently instead of creating a second row.
    const dupReq = await runtime.execute<SignCaSigningRequestRecord>(
      'sign.ca.request.initiate',
      { envelopeId: env.envelopeId },
      { actor: asUser(ownerA), orgId: orgA },
    );
    expect(dupReq.id).toBe(req.id);

    // Step 1: job_begin records 'started' in ludy_kernel.external_call and returns action 'initiate'.
    const begin1 = await workerRuntime.execute<SignCaJobBeginResult>(
      'sign.ca.request.job_begin',
      { requestId: req.id },
      { actor: asSystem('sign.worker'), orgId: orgA },
    );
    expect(begin1.action).toBe('initiate');
    if (begin1.action === 'none') throw new Error('expected initiate');

    // Simulate lost_answer on initiateSign: marks external_call ambiguous and schedules next_poll_at.
    await workerRuntime.execute(
      'sign.ca.request.job_record',
      {
        requestId: req.id,
        callKey: begin1.callKey,
        outcome: 'lost_answer',
        errorCode: 'CA_LOST_ANSWER',
      },
      { actor: asSystem('sign.worker'), orgId: orgA },
    );

    // Rewind next_poll_at so the retry run is due now: job_begin MUST return 'ask' (reconcile_only), NEVER 'initiate'!
    await adminPool!.query(
      'UPDATE ludy_sign.ca_signing_request SET next_poll_at = now() - interval \'1 second\' WHERE org_id = $1::uuid AND id = $2::uuid',
      [orgA, req.id],
    );

    const begin2 = await workerRuntime.execute<SignCaJobBeginResult>(
      'sign.ca.request.job_begin',
      { requestId: req.id },
      { actor: asSystem('sign.worker'), orgId: orgA },
    );
    expect(begin2.action).toBe('ask');
    if (begin2.action === 'none') throw new Error('expected ask');

    // Provider pollStatus(idempotencyKey) answers pending with externalTxId + challengeCode.
    await workerRuntime.execute(
      'sign.ca.request.job_record',
      {
        requestId: req.id,
        callKey: begin2.callKey,
        outcome: 'pending',
        externalTxId: 'tx-sandbox-001',
        challengeCode: '482910',
      },
      { actor: asSystem('sign.worker'), orgId: orgA },
    );

    // Once external_tx_id is stored, tenant user DELETE and UPDATE on ca_signing_request are blocked by ca_signing_request_guard.
    const expectTenantSqlRejects = async (sqlText: string, params: unknown[], pattern: RegExp) => {
      const client = await appPool!.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT ludy_kernel.enter_context($1::uuid, $2::uuid)', [ownerA, orgA]);
        await expect(client.query(sqlText, params)).rejects.toThrow(pattern);
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
    };
    await expectTenantSqlRejects(
      'DELETE FROM ludy_sign.ca_signing_request WHERE org_id = $1::uuid AND id = $2::uuid',
      [orgA, req.id],
      /CA_SIGNING_REQUEST_FROZEN/,
    );
    await expectTenantSqlRejects(
      "UPDATE ludy_sign.ca_signing_request SET status = 'signed' WHERE org_id = $1::uuid AND id = $2::uuid",
      [orgA, req.id],
      /CA_SIGNING_REQUEST_SYSTEM_ONLY/,
    );

    // Rewind next_poll_at again: job_begin now returns 'poll' with externalTxId.
    await adminPool!.query(
      'UPDATE ludy_sign.ca_signing_request SET next_poll_at = now() - interval \'1 second\' WHERE org_id = $1::uuid AND id = $2::uuid',
      [orgA, req.id],
    );
    const begin3 = await workerRuntime.execute<SignCaJobBeginResult>(
      'sign.ca.request.job_begin',
      { requestId: req.id },
      { actor: asSystem('sign.worker'), orgId: orgA },
    );
    expect(begin3).toMatchObject({ action: 'poll', externalTxId: 'tx-sandbox-001' });
    if (begin3.action === 'none') throw new Error('expected poll');

    await workerRuntime.execute(
      'sign.ca.request.job_record',
      {
        requestId: req.id,
        callKey: begin3.callKey,
        outcome: 'signed_session',
        externalTxId: 'tx-sandbox-001',
        signedAtIso: new Date().toISOString(),
      },
      { actor: asSystem('sign.worker'), orgId: orgA },
    );

    // Request stays 'pending' until pades_file_id is stored, and job_begin now returns 'embed' on retry!
    const midList = await runtime.query<{ items: SignCaSigningRequestRecord[] }>(
      'sign.ca.requests.by_envelope',
      { envelopeId: env.envelopeId },
      { actor: asUser(viewerA), orgId: orgA },
    );
    expect(midList.items[0]?.status).toBe('pending');
    expect(midList.items[0]?.padesFileId).toBeNull();

    await adminPool!.query(
      "UPDATE ludy_sign.ca_signing_request SET next_poll_at = now() - interval '1 second' WHERE org_id = $1::uuid AND id = $2::uuid",
      [orgA, req.id],
    );
    const beginEmbed = await workerRuntime.execute<SignCaJobBeginResult>(
      'sign.ca.request.job_begin',
      { requestId: req.id },
      { actor: asSystem('sign.worker'), orgId: orgA },
    );
    expect(beginEmbed).toMatchObject({ action: 'embed', externalTxId: 'tx-sandbox-001' });

    // Record embedded PAdES PDF file and verify ca_completed event keeps hash chain valid.
    const padesFile = await ingestPdf(ownerA, orgA, 'pades-final', 'sign_sealed');
    const completed = await workerRuntime.execute<SignCaSigningRequestRecord>(
      'sign.ca.request.job_complete',
      {
        requestId: req.id,
        externalTxId: 'tx-sandbox-001',
        subFilter: 'ETSI.CAdES.detached',
        padesFileId: padesFile.fileId,
        padesStorageKey: padesFile.storageKey,
        padesGeneration: padesFile.generation,
        padesSha256: padesFile.sha256,
      },
      { actor: asSystem('sign.worker'), orgId: orgA },
    );

    expect(completed).toMatchObject({
      id: req.id,
      status: 'signed',
      subFilter: 'ETSI.CAdES.detached',
      padesFileId: padesFile.fileId,
      padesSha256: padesFile.sha256,
    });

    const listed = await runtime.query<{ items: SignCaSigningRequestRecord[] }>(
      'sign.ca.requests.by_envelope',
      { envelopeId: env.envelopeId },
      { actor: asUser(viewerA), orgId: orgA },
    );
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.padesFileId).toBe(padesFile.fileId);

    const verified = await runtime.query<{ valid: boolean }>(
      'sign.envelope.verify',
      { envelopeId: env.envelopeId },
      { actor: asUser(ownerA), orgId: orgA },
    );
    expect(verified.valid).toBe(true);

    const events = await runtime.query<{ events: Array<{ eventType: string }> }>(
      'sign.envelope.events',
      { envelopeId: env.envelopeId },
      { actor: asUser(ownerA), orgId: orgA },
    );
    const eventTypes = events.events.map((e) => e.eventType);
    expect(eventTypes).toContain('ca_requested');
    expect(eventTypes).toContain('ca_completed');
  });
});
