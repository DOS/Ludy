// SPDX-License-Identifier: AGPL-3.0-only
// PostgreSQL 17 integration tests for eSign meeting_minutes hardening follow-ups (#4641, Refs #4639):
//   1. Offboarding export (kernel.org.export.snapshot) includes completed org-visible meeting_minutes legal records
//      and their files after text_retention_date expiry or meeting deletion/purge (retained_org_visible = true),
//      while excluding erased unsigned envelopes, expired unsigned envelopes, and attendees-only records, and
//      preserving 3-arg ludy_sign.is_exportable_envelope(uuid, text, uuid) semantics.
//   2. cleanup_meeting_minutes_envelopes acquires child locks in canonical order (signing_token before field)
//      and scrubs pre-existing free-text void_reason on already-voided / expired / declined unsigned envelopes.
//   3. envelope_guard enforces OLD.retained_reader_ids IS NULL before snapshot assignment and rejects invalid
//      unsigned cleanup state/reason mutations.
//   4. Zero runtime role EXECUTE grants on ludy_meetings.cleanup_sign_minutes_on_meeting_delete() and
//      ludy_sign.cleanup_meeting_minutes_envelopes / envelope_guard, pinned search_path, and clean hardeningViolations.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { hardeningViolations, migrate, setRolePasswords } from '@ludy/db/migrate';
import {
  DEFAULT_MESSAGE_ID_DOMAIN,
  createOrg,
  kernelCommands,
  kernelQueries,
  upsertIdentity,
} from '@ludy/kernel';
import { contentGeneration, fileKey, mintContextToken, Runtime, sha256Hex } from '@ludy/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import {
  generateCertificateCode,
  hashSigningToken,
  signCommands,
  signQueries,
  verifyEventChain,
  type SigningEventChainRow,
} from '@ludy/mod-sign';
import { TEST_MANIFESTS } from './manifests.ts';

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

suite('eSign meeting_minutes hardening & offboarding export follow-ups (#4641)', () => {
  const dbName = `ludy_test_sign_mtg_hardening_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let adminPool: pg.Pool | undefined;
  let appPool: pg.Pool | undefined;
  let workerPool: pg.Pool | undefined;
  let runtime: Runtime;
  let workerRuntime: Runtime;

  let orgId = '';
  let ownerId = '';
  let recorderId = '';
  let attendeeId = '';

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    mfaAt: Math.floor(Date.now() / 1000),
  });
  const asSystem = (component: string) => ({ type: 'system' as const, component });
  const ipHash = sha256Hex('203.0.113.77');

  function makeContextToken(userId: string, targetOrgId = orgId): string {
    const key = process.env.LUDY_CONTEXT_TOKEN_KEY ?? process.env.CROVE_CONTEXT_TOKEN_KEY ?? '';
    return mintContextToken(key, {
      userId,
      orgId: targetOrgId,
      sessionId: null,
      aal: 'aal1',
      mfaAt: null,
    });
  }

  async function ingestSignFile(
    actor: ReturnType<typeof asUser> | ReturnType<typeof asSystem>,
    tag: string,
    source: 'sign_document' | 'sign_sealed' | 'sign_certificate' = 'sign_document',
    contentType = 'application/pdf',
  ): Promise<{ fileId: string; sha256: string }> {
    const body =
      contentType === 'application/pdf'
        ? `%PDF-1.4\n% mtg-hardening-${tag}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n`
        : JSON.stringify({ tag });
    const bytes = Uint8Array.from(Buffer.from(body, 'utf8'));
    const sha256 = sha256Hex(bytes);
    const r = actor.type === 'system' ? workerRuntime : runtime;
    const { fileId } = await r.execute<{ fileId: string }>(
      'kernel.file.ingest',
      {
        filename: `${tag}.${contentType === 'application/pdf' ? 'pdf' : 'json'}`,
        contentType,
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

  async function createSharedMeeting(opts: { visibility: 'org' | 'attendees'; tag: string }): Promise<string> {
    const { meetingId } = await runtime.execute<{ meetingId: string }>(
      'meetings.meeting.create',
      {
        title: `Bien ban ${opts.tag}`,
        language: 'vi',
        visibility: opts.visibility,
        keepVideo: false,
        liveNotes: false,
        summaryTemplate: 'general',
        consentMethod: 'told_at_start',
        ...(opts.visibility === 'attendees' ? { readerUserIds: [attendeeId] } : {}),
      },
      { actor: asUser(recorderId), orgId },
    );
    await runtime.execute(
      'meetings.summary.save',
      { meetingId, summary: `Tom tat ${opts.tag}`, decisions: [`Quyet dinh ${opts.tag}`] },
      { actor: asUser(recorderId), orgId },
    );
    await runtime.execute(
      'meetings.result.publish',
      { meetingId, confirmed: true },
      { actor: asUser(recorderId), orgId },
    );
    return meetingId;
  }

  async function createCompletedMinutesEnvelope(
    meetingId: string,
    tag: string,
    options: { withAttachment?: boolean; sourceFileId?: string } = {},
  ) {
    const sourceFileId = options.sourceFileId ?? (await ingestSignFile(asUser(recorderId), `comp-src-${tag}`)).fileId;
    const { envelopeId } = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      {
        title: `Completed ${tag}`,
        subject: `Subject ${tag}`,
        sourceKind: 'meeting_minutes',
        sourceId: meetingId,
        sourceFileId,
      },
      { actor: asUser(recorderId), orgId },
    );
    await workerRuntime.execute(
      'sign.envelope.inspect_complete',
      {
        envelopeId,
        outcome: 'passed',
        pageCount: 1,
        pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0 }],
      },
      { actor: asSystem('sign-pdf-inspect'), orgId },
    );
    const { signerId } = await runtime.execute<{ signerId: string }>(
      'sign.signer.add',
      {
        envelopeId,
        signerRole: 'signer',
        roleLabel: 'Nguoi ky',
        name: `Signer ${tag}`,
        email: `signer-${tag}@example.com`,
        deliveryMode: 'link',
      },
      { actor: asUser(recorderId), orgId },
    );
    const fieldsInput: Array<{
      signerId: string;
      fieldType: 'signature' | 'attachment';
      pageNumber: number;
      xNorm: number;
      yNorm: number;
      wNorm: number;
      hNorm: number;
      label?: string;
      required: boolean;
    }> = [{ signerId, fieldType: 'signature', pageNumber: 1, xNorm: 0.1, yNorm: 0.7, wNorm: 0.25, hNorm: 0.08, required: true }];
    if (options.withAttachment) {
      fieldsInput.push({
        signerId,
        fieldType: 'attachment',
        pageNumber: 1,
        xNorm: 0.4,
        yNorm: 0.7,
        wNorm: 0.25,
        hNorm: 0.08,
        label: 'Phu luc bien ban',
        required: true,
      });
    }
    const { fieldIds } = await runtime.execute<{ fieldIds: string[] }>(
      'sign.field.set',
      { envelopeId, fields: fieldsInput },
      { actor: asUser(recorderId), orgId },
    );
    const sent = await runtime.execute<{ links: Array<{ signerId: string; token: string }> }>(
      'sign.envelope.send',
      { envelopeId },
      { actor: asUser(recorderId), orgId },
    );
    const tokenSha = hashSigningToken(sent.links[0]!.token);

    let attachmentFileId: string | null = null;
    const submitFields: Array<{ fieldId: string; signaturePngBase64?: string }> = [
      { fieldId: fieldIds[0]!, signaturePngBase64: VALID_PNG_BASE64 },
    ];
    if (options.withAttachment) {
      const attBytes = Uint8Array.from(
        Buffer.from(`%PDF-1.4\n% att-${tag}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n`, 'utf8'),
      );
      const attSha = sha256Hex(attBytes);
      const attRes = await appPool!.query<{ v: { status: string; fileId?: string } }>(
        `SELECT ludy_sign.public_record_attachment(
           $1, $2::uuid, $3, 'application/pdf', $4, $5, $6, $7, $8, 'HardeningTest/1.0'
         ) AS v`,
        [
          tokenSha,
          fieldIds[1]!,
          `att-${tag}.pdf`,
          attBytes.byteLength,
          attSha,
          fileKey(orgId, attSha),
          contentGeneration(attSha),
          ipHash,
        ],
      );
      expect(attRes.rows[0]?.v.status).toBe('ok');
      attachmentFileId = attRes.rows[0]!.v.fileId!;
      submitFields.push({ fieldId: fieldIds[1]! });
    }

    await appPool!.query(
      `SELECT ludy_sign.public_submit($1, true, 'draw', NULL, $2::jsonb, $3, 'HardeningTest/1.0', $4)`,
      [tokenSha, JSON.stringify(submitFields), ipHash, DEFAULT_MESSAGE_ID_DOMAIN],
    );
    const sealJob = await workerRuntime.query<{
      envelope: { completedAtIso: string | null };
      events: Array<{ event_hash: string }>;
    } | null>('sign.envelope.seal_job_data', { envelopeId }, { actor: asSystem('sign-pdf-seal'), orgId });
    const { fileId: sealedFileId } = await ingestSignFile(asSystem('sign-pdf-seal'), `sealed-${tag}`, 'sign_sealed');
    const { fileId: certFileId } = await ingestSignFile(
      asSystem('sign-pdf-seal'),
      `cert-${tag}`,
      'sign_certificate',
      'application/json',
    );
    await workerRuntime.execute(
      'sign.envelope.seal_complete',
      {
        envelopeId,
        outcome: 'sealed',
        certificateCode: generateCertificateCode(
          envelopeId,
          sealJob!.envelope.completedAtIso ?? new Date().toISOString(),
          sealJob!.events[sealJob!.events.length - 1]!.event_hash,
        ),
        sealedFileId,
        certificateFileId: certFileId,
      },
      { actor: asSystem('sign-pdf-seal'), orgId },
    );

    return { envelopeId, sourceFileId, sealedFileId, certFileId, attachmentFileId };
  }

  async function createUnsignedMinutesEnvelope(
    meetingId: string,
    tag: string,
    opts: { send?: boolean; sourceFileId?: string } = {},
  ) {
    const sourceFileId = opts.sourceFileId ?? (await ingestSignFile(asUser(recorderId), `uns-src-${tag}`)).fileId;
    const { envelopeId } = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      {
        title: `Unsigned Confidential ${tag}`,
        subject: `Unsigned Subject ${tag}`,
        message: `Unsigned Message ${tag}`,
        sourceKind: 'meeting_minutes',
        sourceId: meetingId,
        sourceFileId,
      },
      { actor: asUser(recorderId), orgId },
    );
    if (opts.send) {
      await workerRuntime.execute(
        'sign.envelope.inspect_complete',
        {
          envelopeId,
          outcome: 'passed',
          pageCount: 1,
          pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0 }],
        },
        { actor: asSystem('sign-pdf-inspect'), orgId },
      );
      const { signerId } = await runtime.execute<{ signerId: string }>(
        'sign.signer.add',
        {
          envelopeId,
          signerRole: 'signer',
          roleLabel: 'Nguoi ky',
          name: `Unsigned Signer ${tag}`,
          email: `uns-${tag}@example.com`,
          deliveryMode: 'link',
        },
        { actor: asUser(recorderId), orgId },
      );
      await runtime.execute(
        'sign.field.set',
        {
          envelopeId,
          fields: [{ signerId, fieldType: 'signature', pageNumber: 1, xNorm: 0.1, yNorm: 0.7, wNorm: 0.25, hNorm: 0.08, required: true }],
        },
        { actor: asUser(recorderId), orgId },
      );
      await runtime.execute('sign.envelope.send', { envelopeId }, { actor: asUser(recorderId), orgId });
    }
    return { envelopeId, sourceFileId };
  }

  async function collectExportTable(
    table: 'sign.envelope' | 'sign.signer' | 'sign.field' | 'sign.signing_event' | 'sign.envelope_obligation' | 'kernel.file',
  ) {
    const items: Array<Record<string, unknown>> = [];
    await workerRuntime.stream(
      'kernel.org.export.snapshot',
      { table },
      { actor: asSystem('org-export'), orgId },
      async (batch) => {
        for (const line of (batch as { lines: string[] }).lines) {
          items.push(JSON.parse(line) as Record<string, unknown>);
        }
      },
    );
    return items;
  }

  async function isExportableSignFileAsOwner(fileId: string, source: 'sign_document' | 'sign_sealed' | 'sign_certificate' = 'sign_document') {
    const ownerClient = await appPool!.connect();
    try {
      await ownerClient.query('BEGIN');
      await ownerClient.query('SELECT ludy_kernel.enter_user_context($1::uuid, $2::text)', [
        orgId,
        makeContextToken(ownerId),
      ]);
      const res = await ownerClient.query<{ ok: boolean }>(
        'SELECT ludy_sign.is_exportable_sign_file($1::uuid, $2::uuid, $3::text) AS ok',
        [orgId, fileId, source],
      );
      await ownerClient.query('ROLLBACK');
      return res.rows[0]?.ok ?? false;
    } finally {
      ownerClient.release();
    }
  }

  beforeAll(async () => {
    const rootPool = createPool({ connectionString: ADMIN as string, max: 1 });
    await rootPool.query(`CREATE DATABASE ${dbName}`);
    await rootPool.end();

    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();

    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'mtg-hard-app-pw', ludy_worker: 'mtg-hard-worker-pw' });

    const loginUrl = (user: string, pw: string) => {
      const u = new URL(adminUrl);
      u.username = user;
      u.password = pw;
      return u.toString();
    };

    adminPool = createPool({ connectionString: adminUrl, max: 2 });
    appPool = createPool({ connectionString: loginUrl('ludy_app', 'mtg-hard-app-pw'), max: 6 });
    workerPool = createPool({ connectionString: loginUrl('ludy_worker', 'mtg-hard-worker-pw'), max: 3 });

    const appDb = createDb(appPool);
    const workerDb = createDb(workerPool);

    runtime = new Runtime(appDb, { manifests: TEST_MANIFESTS })
      .register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) })
      .register({ commands: meetingsCommands, queries: meetingsQueries })
      .register({ commands: signCommands, queries: signQueries });

    workerRuntime = new Runtime(workerDb, { manifests: TEST_MANIFESTS })
      .register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) })
      .register({ commands: meetingsCommands, queries: meetingsQueries })
      .register({ commands: signCommands, queries: signQueries });

    ownerId = await upsertIdentity(appDb, { issuer: 'mtg-hard', subject: 'owner', email: 'owner@mtg-hard.test', name: 'Owner' });
    recorderId = await upsertIdentity(appDb, {
      issuer: 'mtg-hard',
      subject: 'recorder',
      email: 'recorder@mtg-hard.test',
      name: 'Recorder',
    });
    attendeeId = await upsertIdentity(appDb, {
      issuer: 'mtg-hard',
      subject: 'attendee',
      email: 'attendee@mtg-hard.test',
      name: 'Attendee',
    });

    orgId = (await createOrg(runtime, asUser(ownerId), 'Cong ty Bien ban Hardening')).orgId;
    // The org setting "Ký biên bản họp" is off by default (#4703); these cases make minutes envelopes, so the org turns it on.
    await adminPool.query('UPDATE ludy_kernel.tenant SET meeting_minutes_esign = true WHERE org_id = $1::uuid', [orgId]);

    await adminPool.query(
      `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES
       ($1::uuid, $2::uuid, 'member'),
       ($1::uuid, $3::uuid, 'member')`,
      [orgId, recorderId, attendeeId],
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

  it('refuses to create a minutes envelope while the org setting "Ký biên bản họp" is off, and turning it off leaves the envelopes already made as they are (#4703)', async () => {
    const setSetting = (on: boolean) => adminPool!.query('UPDATE ludy_kernel.tenant SET meeting_minutes_esign = $2 WHERE org_id = $1::uuid', [orgId, on]);
    const meetingId = await createSharedMeeting({ visibility: 'org', tag: 'esign-setting' });
    // A file belongs to one envelope, so each call brings its own.
    const create = async (title: string, kind: 'meeting_minutes' | 'standalone' = 'meeting_minutes') => {
      const { fileId: sourceFileId } = await ingestSignFile(asUser(recorderId), `esign-setting-${randomUUID()}`);
      return runtime.execute<{ envelopeId: string }>(
        'sign.envelope.create',
        { title, sourceFileId, ...(kind === 'meeting_minutes' ? { sourceKind: kind, sourceId: meetingId } : {}) },
        { actor: asUser(recorderId), orgId },
      );
    };

    // Off (the default of an org that never turned it on): refused with its own code, even for the recorder of a shared meeting.
    await setSetting(false);
    await expect(create('Refused while off')).rejects.toMatchObject({ code: 'SIGN_MINUTES_SIGNING_OFF', status: 409 });
    // A standalone envelope is not affected by the setting.
    const standalone = await create('Standalone while off', 'standalone');
    expect(standalone.envelopeId).toMatch(/^[0-9a-f-]{36}$/);

    // On: the same call goes through.
    await setSetting(true);
    const made = await create('Made while on');

    // Off again: no new envelope, and the one already made is still read by its recorder.
    await setSetting(false);
    await expect(create('Refused again')).rejects.toMatchObject({ code: 'SIGN_MINUTES_SIGNING_OFF', status: 409 });
    const read = await runtime.query<{ envelope: { id: string } }>('sign.envelope.get', { envelopeId: made.envelopeId }, { actor: asUser(recorderId), orgId });
    expect(JSON.stringify(read)).toContain(made.envelopeId);
    await setSetting(true);
  });

  it('pins search_path, passes hardeningViolations, enforces zero runtime EXECUTE on cleanup triggers/definers, and locks signing_token before field', async () => {
    const adminClient = await adminPool!.connect();
    try {
      expect(await hardeningViolations(adminClient)).toEqual([]);
    } finally {
      adminClient.release();
    }

    const fnSpecs = [
      { sig: 'ludy_meetings.cleanup_sign_minutes_on_meeting_delete()', definer: true, tenantCallable: false },
      { sig: 'ludy_sign.cleanup_meeting_minutes_envelopes(uuid,uuid,boolean,uuid[])', definer: true, tenantCallable: false },
      { sig: 'ludy_sign.envelope_guard()', definer: false, tenantCallable: false },
      { sig: 'ludy_sign.is_exportable_envelope(uuid,text,uuid)', definer: true, tenantCallable: true },
      { sig: 'ludy_sign.is_exportable_envelope_id(uuid,uuid)', definer: true, tenantCallable: true },
      { sig: 'ludy_sign.is_exportable_sign_file(uuid,uuid,text)', definer: true, tenantCallable: true },
    ] as const;

    const { rows: fnRows } = await adminPool!.query<{
      fn: string;
      definer: boolean;
      config: string[] | null;
      public_exec: boolean;
    }>(
      `SELECT p.oid::regprocedure::text AS fn,
              p.prosecdef AS definer,
              p.proconfig AS config,
              pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
         FROM pg_catalog.pg_proc p
        WHERE p.oid IN (${fnSpecs.map((f) => `'${f.sig}'::regprocedure`).join(', ')})
        ORDER BY 1`,
    );

    expect(fnRows).toHaveLength(fnSpecs.length);
    for (const spec of fnSpecs) {
      const row = fnRows.find((r) => r.fn === spec.sig);
      expect(row, spec.sig).toBeDefined();
      expect(row!.definer, `${spec.sig} prosecdef`).toBe(spec.definer);
      expect(row!.config, `${spec.sig} search_path`).toEqual(['search_path=pg_catalog, pg_temp']);
      expect(row!.public_exec, `${spec.sig} PUBLIC EXECUTE`).toBe(false);
    }

    const candidateRoles = [
      'ludy_app',
      'ludy_worker',
      'ludy_tenant',
      'ludy_definer_tenant',
      'ludy_auth_reader',
      'crove_app',
      'crove_worker',
      'crove_tenant',
      'crove_definer_tenant',
      'crove_auth_reader',
    ];
    const { rows: presentRoleRows } = await adminPool!.query<{ rolname: string }>(
      `SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname`,
      [candidateRoles],
    );
    const activeRoles = presentRoleRows.map((r) => r.rolname);
    expect(activeRoles).toEqual(
      expect.arrayContaining(['ludy_app', 'ludy_worker', 'ludy_tenant', 'ludy_definer_tenant', 'ludy_auth_reader']),
    );

    const tenantAllowed = new Set(['ludy_app', 'ludy_worker', 'ludy_tenant', 'ludy_definer_tenant', 'crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant']);
    for (const spec of fnSpecs) {
      const { rows: privRows } = await adminPool!.query<{ rolname: string; can_exec: boolean }>(
        `SELECT r.rolname,
                pg_catalog.has_function_privilege(r.rolname, $1::regprocedure, 'EXECUTE') AS can_exec
           FROM pg_catalog.pg_roles r
          WHERE r.rolname = ANY($2::text[])
          ORDER BY r.rolname`,
        [spec.sig, activeRoles],
      );
      expect(privRows).toHaveLength(activeRoles.length);
      for (const priv of privRows) {
        const expected = spec.tenantCallable && tenantAllowed.has(priv.rolname);
        expect(priv.can_exec, `${priv.rolname} EXECUTE on ${spec.sig}`).toBe(expected);
      }
    }

    const { rows: defRows } = await adminPool!.query<{ def: string }>(
      `SELECT pg_catalog.pg_get_functiondef('ludy_sign.cleanup_meeting_minutes_envelopes(uuid,uuid,boolean,uuid[])'::regprocedure) AS def`,
    );
    const cleanupDef = defRows[0]!.def;
    const signerLockIdx = cleanupDef.indexOf('FROM ludy_sign.signer s');
    const tokenLockIdx = cleanupDef.indexOf('FROM ludy_sign.signing_token t');
    const fieldLockIdx = cleanupDef.indexOf('FROM ludy_sign.field f');
    expect(signerLockIdx).toBeGreaterThan(-1);
    expect(tokenLockIdx).toBeGreaterThan(signerLockIdx);
    expect(fieldLockIdx).toBeGreaterThan(tokenLockIdx);
  });

  it('exports completed org-visible meeting_minutes envelopes and files after deletion/purge or retention expiry while keeping unsigned/attendees excluded', async () => {
    // 1. Deleted org-visible meeting (meetings.meeting.delete): completed + attachment exported; unsigned excluded.
    const mtgOrgDel = await createSharedMeeting({ visibility: 'org', tag: 'org-del' });
    const orgDelComp = await createCompletedMinutesEnvelope(mtgOrgDel, 'org-del', { withAttachment: true });
    const orgDelUns = await createUnsignedMinutesEnvelope(mtgOrgDel, 'org-del', { send: true });
    await runtime.execute('meetings.meeting.delete', { meetingId: mtgOrgDel }, { actor: asUser(recorderId), orgId });

    // 2. Org-visible meeting with expired text_retention_date (still in table before text_purge): completed exported; unsigned excluded.
    const mtgOrgExp = await createSharedMeeting({ visibility: 'org', tag: 'org-exp' });
    const orgExpComp = await createCompletedMinutesEnvelope(mtgOrgExp, 'org-exp');
    const orgExpUns = await createUnsignedMinutesEnvelope(mtgOrgExp, 'org-exp', { send: false });
    await adminPool!.query(
      `UPDATE ludy_meetings.meeting
          SET text_retention_date = ((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - 1)
        WHERE org_id = $1::uuid AND id = $2::uuid`,
      [orgId, mtgOrgExp],
    );

    // 3. Org-visible meeting purged via meetings.retention.shred (kind = 'text'): completed + files exported; unsigned excluded.
    const mtgOrgPurge = await createSharedMeeting({ visibility: 'org', tag: 'org-purge' });
    const orgPurgeComp = await createCompletedMinutesEnvelope(mtgOrgPurge, 'org-purge');
    const orgPurgeUns = await createUnsignedMinutesEnvelope(mtgOrgPurge, 'org-purge', { send: true });
    await adminPool!.query(
      `UPDATE ludy_meetings.meeting
          SET text_retention_date = ((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - 1)
        WHERE org_id = $1::uuid AND id = $2::uuid`,
      [orgId, mtgOrgPurge],
    );
    const shredRes = await workerRuntime.execute<{ applied: boolean }>(
      'meetings.retention.shred',
      { meetingId: mtgOrgPurge, kind: 'text' },
      { actor: asSystem('meetings.retention'), orgId },
    );
    expect(shredRes.applied).toBe(true);

    // 4. Deleted attendees-only meeting (owner_delete): BOTH completed (retained_org_visible = false) and unsigned excluded.
    const mtgAttDel = await createSharedMeeting({ visibility: 'attendees', tag: 'att-del' });
    const attDelComp = await createCompletedMinutesEnvelope(mtgAttDel, 'att-del', { withAttachment: true });
    const attDelUns = await createUnsignedMinutesEnvelope(mtgAttDel, 'att-del', { send: true });
    await runtime.execute('meetings.meeting.owner_delete', { meetingId: mtgAttDel }, { actor: asMfa(ownerId), orgId });

    // 5. Live unexpired org-visible meeting: unsigned envelope still exportable while live.
    const mtgOrgLive = await createSharedMeeting({ visibility: 'org', tag: 'org-live' });
    const orgLiveUns = await createUnsignedMinutesEnvelope(mtgOrgLive, 'org-live', { send: false });

    // Seed obligation rows across deleted org completed, deleted org unsigned, and deleted attendees completed.
    await adminPool!.query(
      `INSERT INTO ludy_sign.envelope_obligation (org_id, envelope_id, status, created_by) VALUES
       ($1::uuid, $2::uuid, 'confirmed', $5::uuid),
       ($1::uuid, $3::uuid, 'confirmed', $5::uuid),
       ($1::uuid, $4::uuid, 'confirmed', $5::uuid)`,
      [orgId, orgDelComp.envelopeId, orgDelUns.envelopeId, attDelComp.envelopeId, ownerId],
    );

    // 3-arg legacy helper stays fail-closed on deleted meetings for Invariant suite compatibility, while status-aware 2-arg helper exports retained org records.
    const ownerClient = await appPool!.connect();
    try {
      await ownerClient.query('BEGIN');
      await ownerClient.query('SELECT ludy_kernel.enter_user_context($1::uuid, $2::text)', [
        orgId,
        makeContextToken(ownerId),
      ]);
      const compatCheck = await ownerClient.query<{ legacy_del: boolean; status_del: boolean; status_att: boolean }>(
        `SELECT ludy_sign.is_exportable_envelope($1::uuid, 'meeting_minutes', $2::uuid) AS legacy_del,
                ludy_sign.is_exportable_envelope_id($1::uuid, $3::uuid) AS status_del,
                ludy_sign.is_exportable_envelope_id($1::uuid, $4::uuid) AS status_att`,
        [orgId, mtgOrgDel, orgDelComp.envelopeId, attDelComp.envelopeId],
      );
      expect(compatCheck.rows[0]).toEqual({ legacy_del: false, status_del: true, status_att: false });
      await ownerClient.query('ROLLBACK');
    } finally {
      ownerClient.release();
    }

    // Non-owner members must always get false from is_exportable_envelope_id and is_exportable_sign_file.
    const memberClient = await appPool!.connect();
    try {
      await memberClient.query('BEGIN');
      await memberClient.query('SELECT ludy_kernel.enter_user_context($1::uuid, $2::text)', [
        orgId,
        makeContextToken(recorderId),
      ]);
      const nonOwnerRes = await memberClient.query<{ env_ok: boolean; file_ok: boolean }>(
        `SELECT ludy_sign.is_exportable_envelope_id($1::uuid, $2::uuid) AS env_ok,
                ludy_sign.is_exportable_sign_file($1::uuid, $3::uuid, 'sign_sealed') AS file_ok`,
        [orgId, orgDelComp.envelopeId, orgDelComp.sealedFileId],
      );
      expect(nonOwnerRes.rows[0]).toEqual({ env_ok: false, file_ok: false });
      await memberClient.query('ROLLBACK');
    } finally {
      memberClient.release();
    }

    const collectTable = collectExportTable;

    const exportedEnvIds = (await collectTable('sign.envelope')).map((r) => r.id as string);
    expect(exportedEnvIds).toEqual(
      expect.arrayContaining([
        orgDelComp.envelopeId,
        orgExpComp.envelopeId,
        orgPurgeComp.envelopeId,
        orgLiveUns.envelopeId,
      ]),
    );
    expect(exportedEnvIds).not.toContain(orgDelUns.envelopeId);
    expect(exportedEnvIds).not.toContain(orgExpUns.envelopeId);
    expect(exportedEnvIds).not.toContain(orgPurgeUns.envelopeId);
    expect(exportedEnvIds).not.toContain(attDelComp.envelopeId);
    expect(exportedEnvIds).not.toContain(attDelUns.envelopeId);

    for (const table of ['sign.signer', 'sign.field', 'sign.signing_event'] as const) {
      const childEnvIds = (await collectTable(table)).map((r) => r.envelope_id as string);
      expect(childEnvIds, `${table} includes completed`).toEqual(
        expect.arrayContaining([orgDelComp.envelopeId, orgExpComp.envelopeId, orgPurgeComp.envelopeId]),
      );
      expect(childEnvIds, `${table} excludes attendees-only & erased`).not.toContain(attDelComp.envelopeId);
      expect(childEnvIds, `${table} excludes deleted unsigned`).not.toContain(orgDelUns.envelopeId);
      expect(childEnvIds, `${table} excludes expired unsigned`).not.toContain(orgExpUns.envelopeId);
    }

    const exportedOblEnvIds = (await collectTable('sign.envelope_obligation')).map((r) => r.envelope_id as string);
    expect(exportedOblEnvIds).toContain(orgDelComp.envelopeId);
    expect(exportedOblEnvIds).not.toContain(orgDelUns.envelopeId);
    expect(exportedOblEnvIds).not.toContain(attDelComp.envelopeId);

    const exportedFileIds = (await collectTable('kernel.file')).map((r) => r.id as string);
    expect(exportedFileIds).toEqual(
      expect.arrayContaining([
        orgDelComp.sourceFileId,
        orgDelComp.sealedFileId,
        orgDelComp.certFileId,
        orgDelComp.attachmentFileId!,
        orgExpComp.sourceFileId,
        orgExpComp.sealedFileId,
        orgExpComp.certFileId,
        orgPurgeComp.sourceFileId,
        orgPurgeComp.sealedFileId,
        orgPurgeComp.certFileId,
        orgLiveUns.sourceFileId,
      ]),
    );
    expect(exportedFileIds).not.toContain(orgDelUns.sourceFileId);
    expect(exportedFileIds).not.toContain(orgExpUns.sourceFileId);
    expect(exportedFileIds).not.toContain(orgPurgeUns.sourceFileId);
    expect(exportedFileIds).not.toContain(attDelComp.sourceFileId);
    expect(exportedFileIds).not.toContain(attDelComp.sealedFileId);
    expect(exportedFileIds).not.toContain(attDelComp.certFileId);
    expect(exportedFileIds).not.toContain(attDelComp.attachmentFileId!);
    expect(exportedFileIds).not.toContain(attDelUns.sourceFileId);
  });

  it('scrubs pre-existing void_reason on already-voided unsigned envelopes and enforces tightened envelope_guard checks', async () => {
    const mtgId = await createSharedMeeting({ visibility: 'org', tag: 'void-scrub' });
    const envAlreadyVoided = await createUnsignedMinutesEnvelope(mtgId, 'already-voided', { send: true });
    const envDraft = await createUnsignedMinutesEnvelope(mtgId, 'draft-scrub', { send: false });
    const compEnv = await createCompletedMinutesEnvelope(mtgId, 'comp-guard');

    const sensitiveReason = 'Canceled after CEO Nguyen Van A raised confidential pricing dispute';
    await runtime.execute(
      'sign.envelope.void',
      { envelopeId: envAlreadyVoided.envelopeId, reason: sensitiveReason },
      { actor: asUser(recorderId), orgId },
    );

    await runtime.execute('meetings.meeting.delete', { meetingId: mtgId }, { actor: asUser(recorderId), orgId });

    const { rows: scrubRows } = await adminPool!.query<{
      id: string;
      status: string;
      void_reason: string | null;
      title: string;
      subject: string | null;
      message: string | null;
      shared_summary_json: unknown;
    }>(
      `SELECT id, status, void_reason, title, subject, message, shared_summary_json
         FROM ludy_sign.envelope
        WHERE org_id = $1::uuid AND id = ANY($2::uuid[])`,
      [orgId, [envAlreadyVoided.envelopeId, envDraft.envelopeId]],
    );

    const alreadyVoidedRow = scrubRows.find((r) => r.id === envAlreadyVoided.envelopeId)!;
    expect(alreadyVoidedRow).toEqual({
      id: envAlreadyVoided.envelopeId,
      status: 'voided',
      void_reason: null,
      title: '[Erased meeting minutes]',
      subject: null,
      message: null,
      shared_summary_json: null,
    });

    const draftRow = scrubRows.find((r) => r.id === envDraft.envelopeId)!;
    expect(draftRow).toEqual({
      id: envDraft.envelopeId,
      status: 'voided',
      void_reason: 'meeting_deleted',
      title: '[Erased meeting minutes]',
      subject: null,
      message: null,
      shared_summary_json: null,
    });

    for (const id of [envAlreadyVoided.envelopeId, envDraft.envelopeId]) {
      const { rows: events } = await adminPool!.query<SigningEventChainRow>(
        'SELECT * FROM ludy_sign.signing_event WHERE org_id = $1::uuid AND envelope_id = $2::uuid ORDER BY seq ASC',
        [orgId, id],
      );
      expect(verifyEventChain(events), `event chain valid for ${id}`).toMatchObject({ valid: true });
    }

    // Tenant user cannot touch retained_* metadata directly.
    const appClient = await appPool!.connect();
    try {
      await appClient.query('BEGIN');
      await appClient.query('SELECT ludy_kernel.enter_user_context($1::uuid, $2::text)', [
        orgId,
        makeContextToken(ownerId),
      ]);
      await expect(
        appClient.query(
          `UPDATE ludy_sign.envelope SET retained_org_visible = false WHERE org_id = $1::uuid AND id = $2::uuid`,
          [orgId, compEnv.envelopeId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await appClient.query('ROLLBACK');
    } finally {
      appClient.release();
    }

    const mtgExpired = await createSharedMeeting({ visibility: 'attendees', tag: 'expired-guard' });
    const envExp = await createUnsignedMinutesEnvelope(mtgExpired, 'expired-guard', { send: true });
    const envPreVoided = await createUnsignedMinutesEnvelope(mtgExpired, 'prevoided-guard', { send: true });
    await runtime.execute(
      'sign.envelope.void',
      { envelopeId: envPreVoided.envelopeId, reason: 'Pre-existing secret reason' },
      { actor: asUser(recorderId), orgId },
    );

    // Even when executed as the cleanup owner with the cleanup GUC set, envelope_guard blocks:
    //   a) overwriting an already-populated retained_reader_ids snapshot (OLD.retained_reader_ids IS NULL guard),
    //   b) leaving a pre-existing void_reason un-scrubbed on an already-voided envelope during cleanup,
    //   c) forcing an expired envelope's status to 'voided' during cleanup.
    const adminClient = await adminPool!.connect();
    try {
      await adminClient.query('BEGIN');
      await adminClient.query('SELECT ludy_kernel.enter_user_context($1::uuid, $2::text)', [
        orgId,
        makeContextToken(ownerId),
      ]);
      await adminClient.query(`SELECT pg_catalog.set_config('ludy.sign_meeting_cleanup', $1::text, true)`, [orgId]);

      await adminClient.query('SAVEPOINT sp_snapshot_overwrite');
      await expect(
        adminClient.query(
          `UPDATE ludy_sign.envelope
              SET retained_reader_ids = ARRAY[]::uuid[]
            WHERE org_id = $1::uuid AND id = $2::uuid`,
          [orgId, compEnv.envelopeId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await adminClient.query('ROLLBACK TO SAVEPOINT sp_snapshot_overwrite');

      await adminClient.query('SAVEPOINT sp_void_reason_preserve');
      await expect(
        adminClient.query(
          `UPDATE ludy_sign.envelope
              SET title = '[Erased meeting minutes]',
                  subject = NULL,
                  message = NULL,
                  inspect_error = NULL,
                  detected_tags_json = NULL,
                  share_summary_with_signers = false,
                  shared_summary_json = NULL,
                  version = version + 1
            WHERE org_id = $1::uuid AND id = $2::uuid`,
          [orgId, envPreVoided.envelopeId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await adminClient.query('ROLLBACK TO SAVEPOINT sp_void_reason_preserve');

      await adminClient.query('SET LOCAL session_replication_role = replica');
      await adminClient.query(
        `UPDATE ludy_sign.envelope SET status = 'expired', expired_at = now() WHERE org_id = $1::uuid AND id = $2::uuid`,
        [orgId, envExp.envelopeId],
      );
      await adminClient.query('SET LOCAL session_replication_role = origin');

      await adminClient.query('SAVEPOINT sp_expired_status_flip');
      await expect(
        adminClient.query(
          `UPDATE ludy_sign.envelope
              SET status = 'voided',
                  voided_at = now(),
                  void_reason = 'meeting_deleted',
                  title = '[Erased meeting minutes]',
                  subject = NULL,
                  message = NULL,
                  inspect_error = NULL,
                  detected_tags_json = NULL,
                  share_summary_with_signers = false,
                  shared_summary_json = NULL,
                  version = version + 1
            WHERE org_id = $1::uuid AND id = $2::uuid`,
          [orgId, envExp.envelopeId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await adminClient.query('ROLLBACK TO SAVEPOINT sp_expired_status_flip');

      await adminClient.query('ROLLBACK');
    } finally {
      adminClient.release();
    }
  });

  it('exports shared source_file_id only when an exportable completed envelope shares the same source (#4692)', async () => {
    // 1. Same-meeting coexistence (org-visible deleted meeting): completed + erased unsigned share one source_file_id -> exported.
    const mtgOrgShared = await createSharedMeeting({ visibility: 'org', tag: 'shared-org' });
    const sharedOrgSrc = await ingestSignFile(asUser(recorderId), 'shared-org-src');
    const orgSharedComp = await createCompletedMinutesEnvelope(mtgOrgShared, 'shared-org-comp', {
      sourceFileId: sharedOrgSrc.fileId,
    });
    const orgSharedUns = await createUnsignedMinutesEnvelope(mtgOrgShared, 'shared-org-uns', {
      send: true,
      sourceFileId: sharedOrgSrc.fileId,
    });
    await runtime.execute('meetings.meeting.delete', { meetingId: mtgOrgShared }, { actor: asUser(recorderId), orgId });

    // 2. Same-meeting attendees-only exclusion: completed (retained_org_visible = false) + erased unsigned share one source_file_id -> excluded.
    const mtgAttShared = await createSharedMeeting({ visibility: 'attendees', tag: 'shared-att' });
    const sharedAttSrc = await ingestSignFile(asUser(recorderId), 'shared-att-src');
    const attSharedComp = await createCompletedMinutesEnvelope(mtgAttShared, 'shared-att-comp', {
      sourceFileId: sharedAttSrc.fileId,
    });
    const attSharedUns = await createUnsignedMinutesEnvelope(mtgAttShared, 'shared-att-uns', {
      send: true,
      sourceFileId: sharedAttSrc.fileId,
    });
    await runtime.execute('meetings.meeting.owner_delete', { meetingId: mtgAttShared }, { actor: asMfa(ownerId), orgId });

    // 3. Cross-source exclusion: meeting A's erased unsigned row sharing meeting B's completed source_file_id stays denied.
    const mtgCrossA = await createSharedMeeting({ visibility: 'org', tag: 'cross-a' });
    const mtgCrossB = await createSharedMeeting({ visibility: 'org', tag: 'cross-b' });
    const crossSrc = await ingestSignFile(asUser(recorderId), 'shared-cross-src');
    const crossBComp = await createCompletedMinutesEnvelope(mtgCrossB, 'cross-b-comp', {
      sourceFileId: crossSrc.fileId,
    });

    await expect(
      runtime.execute(
        'sign.envelope.create',
        {
          title: 'Cross-source reuse denied',
          sourceKind: 'meeting_minutes',
          sourceId: mtgCrossA,
          sourceFileId: crossSrc.fileId,
        },
        { actor: asUser(recorderId), orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_FORBIDDEN', status: 403 });

    const crossAUns = await createUnsignedMinutesEnvelope(mtgCrossA, 'cross-a-uns', { send: true });
    await runtime.execute('meetings.meeting.delete', { meetingId: mtgCrossA }, { actor: asUser(recorderId), orgId });
    await runtime.execute('meetings.meeting.delete', { meetingId: mtgCrossB }, { actor: asUser(recorderId), orgId });

    expect(await isExportableSignFileAsOwner(crossSrc.fileId)).toBe(true);

    // Simulate a legacy cross-source source_file_id reference on erased meeting A without touching meeting B.
    await adminPool!.query(
      `UPDATE ludy_sign.envelope
          SET source_file_id = $3::uuid
        WHERE org_id = $1::uuid AND id = $2::uuid`,
      [orgId, crossAUns.envelopeId, crossSrc.fileId],
    );

    expect(await isExportableSignFileAsOwner(sharedOrgSrc.fileId)).toBe(true);
    expect(await isExportableSignFileAsOwner(sharedAttSrc.fileId)).toBe(false);
    expect(await isExportableSignFileAsOwner(crossSrc.fileId)).toBe(false);
    expect(await isExportableSignFileAsOwner(crossBComp.sealedFileId, 'sign_sealed')).toBe(true);

    const exportedEnvIds = (await collectExportTable('sign.envelope')).map((r) => r.id as string);
    expect(exportedEnvIds).toEqual(expect.arrayContaining([orgSharedComp.envelopeId, crossBComp.envelopeId]));
    expect(exportedEnvIds).not.toContain(orgSharedUns.envelopeId);
    expect(exportedEnvIds).not.toContain(attSharedComp.envelopeId);
    expect(exportedEnvIds).not.toContain(attSharedUns.envelopeId);
    expect(exportedEnvIds).not.toContain(crossAUns.envelopeId);

    const exportedFileIds = (await collectExportTable('kernel.file')).map((r) => r.id as string);
    expect(exportedFileIds).toEqual(
      expect.arrayContaining([
        sharedOrgSrc.fileId,
        orgSharedComp.sealedFileId,
        orgSharedComp.certFileId,
        crossBComp.sealedFileId,
        crossBComp.certFileId,
      ]),
    );
    expect(exportedFileIds).not.toContain(sharedAttSrc.fileId);
    expect(exportedFileIds).not.toContain(attSharedComp.sealedFileId);
    expect(exportedFileIds).not.toContain(attSharedComp.certFileId);
    expect(exportedFileIds).not.toContain(crossSrc.fileId);
  });
});
