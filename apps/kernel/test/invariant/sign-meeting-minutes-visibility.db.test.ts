// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end PostgreSQL 17 security invariants for eSign Slice 3a (#3811, #4531, ADR-0047, ADR-0049, ADR-0053):
//   - Meeting minutes envelopes (source_kind = 'meeting_minutes') may be created ONLY when minutes are explicitly shared
//     (409 SIGN_MINUTES_NOT_SHARED for meeting readers on private drafts; 404 SIGN_SOURCE_NOT_FOUND for non-readers)
//   - On an attendees-only meeting, EVEN workspace owners and admins who are not meeting readers receive identical 404
//     across list, by_source, get, events, verify, ai_analysis, mutations, template.create, and kernel.file.get
//   - Signed vs unsigned lifecycle (Owner Decision A2, #4531): unsigned/in-flight envelopes strictly follow active meeting
//     reader scope even for created_by (404 on reader removal, viewer demotion, or retention expiry) and are voided/erased
//     on meeting deletion/purge; completed envelopes remain retained legal records for creator + active readers.
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
  kernelQueries,
  upsertIdentity,
} from '@ludy/kernel';
import { contentGeneration, fileKey, Runtime, sha256Hex } from '@ludy/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import {
  generateCertificateCode,
  generateRawSigningToken,
  hashSigningToken,
  signAiCommands,
  signAiQueries,
  signCommands,
  signQueries,
  verifyEventChain,
  type SigningEventChainRow,
} from '@ludy/mod-sign';
import { contextToken } from './fixtures/context-token.ts';
import { createDbPool, resolveDbIdentifiers, setActiveRolePasswords } from './fixtures/db-identifiers.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

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

suite('eSign shared meeting minutes reader-scoped confidentiality invariants (#3811, ADR-0047)', () => {
  const dbName = `crove_test_sign_mtg_inv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  let recorderId = '';
  let attendeeId = '';
  let outsiderMemberId = '';
  let entityLimitedMemberId = '';
  let viewerId = '';
  let otherOwnerId = '';
  let branchEntityId = '';

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    sessionId: '7e1c2b4a-5d6f-4a8b-9c0d-1e2f3a4b5c6d',
    mfaAt: Math.floor(Date.now() / 1000),
  });
  const asSystem = (component: string) => ({ type: 'system' as const, component });
  const ipHash = sha256Hex('203.0.113.88');

  async function ingestSignFile(
    actor: { type: 'user'; userId: string; aal: 'aal1' } | { type: 'system'; component: string },
    targetOrgId: string,
    tag: string,
    source: 'sign_document' | 'sign_sealed' | 'sign_certificate' = 'sign_document',
    contentType = 'application/pdf',
  ): Promise<{ fileId: string; sha256: string }> {
    const body =
      source === 'sign_certificate'
        ? JSON.stringify({ tag, issuedAt: '2026-11-19T08:00:00.000Z' })
        : `%PDF-1.4\n% mtg-inv-${tag}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n`;
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
    await setActiveRolePasswords(adminUrl, { crove_app: 'mtg-inv-app-pw', crove_worker: 'mtg-inv-worker-pw' }, ids);

    const loginUrl = (user: string, pw: string) => {
      const u = new URL(adminUrl);
      u.username = user;
      u.password = pw;
      return u.toString();
    };

    adminPool = createDbPool({ connectionString: adminUrl, max: 2 }, ids);
    appPool = createDbPool({ connectionString: loginUrl('crove_app', 'mtg-inv-app-pw'), max: 6 }, ids);
    workerPool = createDbPool({ connectionString: loginUrl('crove_worker', 'mtg-inv-worker-pw'), max: 3 }, ids);

    const appDb = createDb(appPool);
    const workerDb = createDb(workerPool);

    runtime = new Runtime(appDb, { manifests: TEST_MANIFESTS })
      .register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) })
      .register({ commands: meetingsCommands, queries: meetingsQueries })
      .register({ commands: [...signCommands, ...signAiCommands], queries: [...signQueries, ...signAiQueries] });

    workerRuntime = new Runtime(workerDb, { manifests: TEST_MANIFESTS })
      .register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) })
      .register({ commands: meetingsCommands, queries: meetingsQueries })
      .register({ commands: [...signCommands, ...signAiCommands], queries: [...signQueries, ...signAiQueries] });

    ownerId = await upsertIdentity(appDb, { issuer: 'mtg-inv', subject: 'owner', email: 'owner@mtg-inv.test', name: 'Owner' });
    adminId = await upsertIdentity(appDb, { issuer: 'mtg-inv', subject: 'admin', email: 'admin@mtg-inv.test', name: 'Admin' });
    recorderId = await upsertIdentity(appDb, { issuer: 'mtg-inv', subject: 'recorder', email: 'recorder@mtg-inv.test', name: 'Recorder' });
    attendeeId = await upsertIdentity(appDb, { issuer: 'mtg-inv', subject: 'attendee', email: 'attendee@mtg-inv.test', name: 'Attendee' });
    outsiderMemberId = await upsertIdentity(appDb, { issuer: 'mtg-inv', subject: 'outsider', email: 'outsider@mtg-inv.test', name: 'Outsider' });
    entityLimitedMemberId = await upsertIdentity(appDb, { issuer: 'mtg-inv', subject: 'limited', email: 'limited@mtg-inv.test', name: 'Entity Limited' });
    viewerId = await upsertIdentity(appDb, { issuer: 'mtg-inv', subject: 'viewer', email: 'viewer@mtg-inv.test', name: 'Viewer' });
    otherOwnerId = await upsertIdentity(appDb, { issuer: 'mtg-inv', subject: 'other-owner', email: 'other@mtg-inv.test', name: 'Other Owner' });

    orgId = (await createOrg(runtime, asUser(ownerId), 'Cong ty TNHH Cuoc Hop A')).orgId;
    otherOrgId = (await createOrg(runtime, asUser(otherOwnerId), 'Cong ty TNHH Cuoc Hop B')).orgId;

    await adminPool.query(
      `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES
       ($1::uuid, $2::uuid, 'admin'),
       ($1::uuid, $3::uuid, 'member'),
       ($1::uuid, $4::uuid, 'member'),
       ($1::uuid, $5::uuid, 'member'),
       ($1::uuid, $6::uuid, 'member'),
       ($1::uuid, $7::uuid, 'viewer')`,
      [orgId, adminId, recorderId, attendeeId, outsiderMemberId, entityLimitedMemberId, viewerId],
    );

    const branchRes = await adminPool.query<{ id: string }>(
      `INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by)
       VALUES ($1::uuid, 'Chi nhanh Da Nang', 'branch', $2::uuid)
       RETURNING id`,
      [orgId, ownerId],
    );
    branchEntityId = branchRes.rows[0]!.id;

    // Assign entityLimitedMemberId a legal_entity-scoped kernel role so enter_user_context seals le_scope = [branchEntityId] (no '*').
    await runtime.execute(
      'kernel.member.role.assign',
      { userId: entityLimitedMemberId, roleKey: 'external_accountant', legalEntityId: branchEntityId },
      { actor: asMfa(ownerId), orgId },
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

  it('refuses unshared private drafts (409 for readers, 404 for non-readers) and enforces attendees-only confidentiality even against owners and admins', async () => {
    // 1. Recorder creates an attendees-only meeting shared ONLY with attendeeId (NOT ownerId, NOT adminId!).
    const { meetingId: attendeesMeetingId } = await runtime.execute<{ meetingId: string }>(
      'meetings.meeting.create',
      {
        title: 'Hop luong va nhan su cap cao',
        language: 'vi',
        visibility: 'attendees',
        keepVideo: false,
        liveNotes: false,
        summaryTemplate: 'general',
        consentMethod: 'told_at_start',
        readerUserIds: [attendeeId],
      },
      { actor: asUser(recorderId), orgId },
    );

    // Recorder saves a PRIVATE draft summary and action item (stage = 'draft') + private meeting_note; nothing published yet!
    await runtime.execute(
      'meetings.summary.save',
      { meetingId: attendeesMeetingId, summary: 'Ban nhap rieng chua chia se.', decisions: ['Chua chot'] },
      { actor: asUser(recorderId), orgId },
    );
    await runtime.execute(
      'meetings.action_item.create',
      {
        meetingId: attendeesMeetingId,
        title: 'Xem lai phuong an',
        who: 'Attendee',
        whoUserId: attendeeId,
        when: '2026-11-30',
        whenDate: '2026-11-30',
        transcriptSeconds: null,
      },
      { actor: asUser(recorderId), orgId },
    );
    await runtime.execute(
      'meetings.notes.save',
      { meetingId: attendeesMeetingId, body: 'Ghi chu ca nhan cua nguoi ghi' },
      { actor: asUser(recorderId), orgId },
    );

    const { fileId: recPdf, sha256: recPdfSha } = await ingestSignFile(asUser(recorderId), orgId, `rec-minutes-${randomUUID()}`);
    const { fileId: attPdf } = await ingestSignFile(asUser(attendeeId), orgId, `att-minutes-${randomUUID()}`);
    const { fileId: ownerPdf } = await ingestSignFile(asUser(ownerId), orgId, `owner-probe-${randomUUID()}`);
    const { fileId: adminPdf } = await ingestSignFile(asUser(adminId), orgId, `admin-probe-${randomUUID()}`);
    const { fileId: outPdf } = await ingestSignFile(asUser(outsiderMemberId), orgId, `out-probe-${randomUUID()}`);

    // Prepare an active org-wide template as well to test sign.template.instantiate parity.
    const { fileId: tplPdf } = await ingestSignFile(asUser(ownerId), orgId, `org-minutes-tpl-${randomUUID()}`);
    const tpl = await runtime.execute<{ templateId: string }>(
      'sign.template.create',
      { title: 'Mau Xac Nhan Bien Ban', sourceFileId: tplPdf },
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
        roles: [{ roleKey: 'attendee', roleLabel: 'Nguoi tham du', signerRole: 'signer', routingOrder: 1, deliveryMode: 'link' }],
      },
      { actor: asUser(ownerId), orgId },
    );
    await runtime.execute(
      'sign.template.fields_set',
      {
        templateId: tpl.templateId,
        fields: [{ roleKey: 'attendee', fieldType: 'signature', pageNumber: 1, xNorm: 0.1, yNorm: 0.72, wNorm: 0.25, hNorm: 0.08 }],
      },
      { actor: asUser(ownerId), orgId },
    );
    await runtime.execute('sign.template.update', { templateId: tpl.templateId, status: 'active' }, { actor: asUser(ownerId), orgId });

    // Readers (recorder + attendee) get 409 SIGN_MINUTES_NOT_SHARED while minutes are still private drafts!
    for (const [readerUserId, fileId] of [
      [recorderId, recPdf],
      [attendeeId, attPdf],
    ] as const) {
      await expect(
        runtime.execute(
          'sign.envelope.create',
          {
            title: 'Unshared Draft Minutes',
            sourceKind: 'meeting_minutes',
            sourceId: attendeesMeetingId,
            sourceFileId: fileId,
          },
          { actor: asUser(readerUserId), orgId },
        ),
      ).rejects.toMatchObject({ code: 'SIGN_MINUTES_NOT_SHARED', status: 409 });

      await expect(
        runtime.execute(
          'sign.template.instantiate',
          {
            templateId: tpl.templateId,
            sourceKind: 'meeting_minutes',
            sourceId: attendeesMeetingId,
            recipients: [{ roleKey: 'attendee', name: 'Attendee', deliveryMode: 'link' }],
          },
          { actor: asUser(readerUserId), orgId },
        ),
      ).rejects.toMatchObject({ code: 'SIGN_MINUTES_NOT_SHARED', status: 409 });
    }

    // Non-readers (INCLUDING ownerId and adminId!) get opaque 404 SIGN_SOURCE_NOT_FOUND so private meeting existence never leaks!
    for (const [nonReaderId, fileId] of [
      [ownerId, ownerPdf],
      [adminId, adminPdf],
      [outsiderMemberId, outPdf],
    ] as const) {
      await expect(
        runtime.execute(
          'sign.envelope.create',
          {
            title: 'Non-Reader Probe on Unshared Meeting',
            sourceKind: 'meeting_minutes',
            sourceId: attendeesMeetingId,
            sourceFileId: fileId,
          },
          { actor: asUser(nonReaderId), orgId },
        ),
      ).rejects.toMatchObject({ code: 'SIGN_SOURCE_NOT_FOUND', status: 404 });
    }

    // 2. Recorder explicitly shares the minutes (meetings.result.publish)!
    await runtime.execute(
      'meetings.result.publish',
      { meetingId: attendeesMeetingId, confirmed: true },
      { actor: asUser(recorderId), orgId },
    );

    // Even AFTER sharing, non-readers on this attendees-only meeting (ownerId, adminId, outsiderMemberId, otherOwnerId) STILL get 404!
    for (const [nonReaderId, fileId] of [
      [ownerId, ownerPdf],
      [adminId, adminPdf],
      [outsiderMemberId, outPdf],
    ] as const) {
      await expect(
        runtime.execute(
          'sign.envelope.create',
          {
            title: 'Non-Reader Probe After Share',
            sourceKind: 'meeting_minutes',
            sourceId: attendeesMeetingId,
            sourceFileId: fileId,
          },
          { actor: asUser(nonReaderId), orgId },
        ),
      ).rejects.toMatchObject({ code: 'SIGN_SOURCE_NOT_FOUND', status: 404 });

      await expect(
        runtime.execute(
          'sign.template.instantiate',
          {
            templateId: tpl.templateId,
            sourceKind: 'meeting_minutes',
            sourceId: attendeesMeetingId,
            recipients: [{ roleKey: 'attendee', name: 'Probe', deliveryMode: 'link' }],
          },
          { actor: asUser(nonReaderId), orgId },
        ),
      ).rejects.toMatchObject({ code: 'SIGN_SOURCE_NOT_FOUND', status: 404 });
    }

    // Cross-org owner trying to reference attendeesMeetingId in otherOrgId also gets 404 SIGN_SOURCE_NOT_FOUND!
    const { fileId: otherOrgPdf } = await ingestSignFile(asUser(otherOwnerId), otherOrgId, `other-org-${randomUUID()}`);
    await expect(
      runtime.execute(
        'sign.envelope.create',
        {
          title: 'Cross-Org Meeting Minutes Probe',
          sourceKind: 'meeting_minutes',
          sourceId: attendeesMeetingId,
          sourceFileId: otherOrgPdf,
        },
        { actor: asUser(otherOwnerId), orgId: otherOrgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_SOURCE_NOT_FOUND', status: 404 });

    // Create a visible standalone envelope first so list pagination (limit: 1) can prove SQL-level filtering!
    const standaloneEnv = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      {
        title: 'Public Org NDA',
        sourceKind: 'standalone',
        sourceFileId: ownerPdf,
      },
      { actor: asUser(ownerId), orgId },
    );

    // Reverse source_file_id lockout guard (B2): an ordinary member (recorderId) CANNOT lock out an existing
    // standalone envelope's sourceFileId (ownerPdf) or a template's sourceFileId (tplPdf) by attaching it to
    // an attendees-only meeting_minutes envelope via sign.envelope.create OR direct SQL INSERT!
    for (const protectedFileId of [ownerPdf, tplPdf]) {
      await expect(
        runtime.execute(
          'sign.envelope.create',
          {
            title: 'Reverse Lockout Probe',
            sourceKind: 'meeting_minutes',
            sourceId: attendeesMeetingId,
            sourceFileId: protectedFileId,
          },
          { actor: asUser(recorderId), orgId },
        ),
      ).rejects.toMatchObject({ code: 'SIGN_FORBIDDEN', status: 403 });
    }
    const recLockoutClient = await appPool!.connect();
    try {
      await recLockoutClient.query('BEGIN');
      await recLockoutClient.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [
        orgId,
        contextToken(recorderId, orgId),
      ]);
      await expect(
        recLockoutClient.query(
          `INSERT INTO crove_sign.envelope (
             org_id, title, status, routing_mode, source_kind, source_id,
             source_file_id, source_storage_key, source_generation, source_sha256,
             inspect_status, created_by
           )
           SELECT $1::uuid, 'SQL Lockout Probe', 'draft', 'parallel', 'meeting_minutes', $2::uuid,
                  f.id, f.storage_key, f.generation, f.sha256, 'pending', $3::uuid
           FROM crove_kernel.file f WHERE f.org_id = $1::uuid AND f.id = $4::uuid`,
          [orgId, attendeesMeetingId, recorderId, ownerPdf],
        ),
      ).rejects.toThrow(/row-level security policy/);
    } finally {
      await recLockoutClient.query('ROLLBACK').catch(() => {});
      recLockoutClient.release();
    }
    // Verify ownerId can still read ownerPdf after the blocked lockout attempts!
    expect((await runtime.query<{ id: string }>('kernel.file.get', { id: ownerPdf }, { actor: asUser(ownerId), orgId })).id).toBe(
      ownerPdf,
    );

    // Recorder creates the confidential meeting_minutes envelope, and Attendee instantiates one from the template!
    const recEnv = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      {
        title: 'Bien ban cuoc hop luong cap cao',
        sourceKind: 'meeting_minutes',
        sourceId: attendeesMeetingId,
        sourceFileId: recPdf,
      },
      { actor: asUser(recorderId), orgId },
    );

    // An attendee who is not the recorder is a reader of the shared minutes and still cannot start a signature on them (#4532): sign.template.instantiate is refused with SIGN_FORBIDDEN (403), the
    // rule sign.envelope.create follows too (the recorder's own create above succeeds). The rest of the test needs an unsigned envelope whose creator is the attendee (it loses access with the
    // reader scope), such as an earlier version of the rule allowed, so that envelope is inserted directly.
    await expect(
      runtime.execute(
        'sign.template.instantiate',
        {
          templateId: tpl.templateId,
          title: 'Bien ban xac nhan cua Attendee',
          sourceKind: 'meeting_minutes',
          sourceId: attendeesMeetingId,
          recipients: [{ roleKey: 'attendee', name: 'Attendee', email: 'attendee@mtg-inv.test', deliveryMode: 'email' }],
        },
        { actor: asUser(attendeeId), orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_FORBIDDEN', status: 403 });
    const attTplEnvId = randomUUID();
    const inserted = await adminPool!.query(
      `INSERT INTO crove_sign.envelope (
         org_id, id, title, status, routing_mode, source_kind, source_id,
         source_file_id, source_storage_key, source_generation, source_sha256,
         inspect_status, created_by
       )
       SELECT $1::uuid, $2::uuid, 'Bien ban xac nhan cua Attendee', 'draft', 'parallel', 'meeting_minutes', $3::uuid,
              f.id, f.storage_key, f.generation, f.sha256, 'pending', $4::uuid
       FROM crove_kernel.file f WHERE f.org_id = $1::uuid AND f.id = $5::uuid`,
      [orgId, attTplEnvId, attendeesMeetingId, attendeeId, tplPdf],
    );
    expect(inserted.rowCount).toBe(1);
    const attTplEnv = { envelopeId: attTplEnvId };

    const addedSigner = await runtime.execute<{ signerId: string }>(
      'sign.signer.add',
      {
        envelopeId: recEnv.envelopeId,
        routingOrder: 1,
        signerRole: 'signer',
        roleLabel: 'Nguoi tham du',
        name: 'Attendee',
        email: 'attendee@mtg-inv.test',
        deliveryMode: 'link',
      },
      { actor: asUser(recorderId), orgId },
    );

    await workerRuntime.execute(
      'sign.envelope.inspect_complete',
      {
        envelopeId: recEnv.envelopeId,
        outcome: 'passed',
        pageCount: 1,
        pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0 }],
      },
      { actor: asSystem('sign-worker'), orgId },
    );

    const setFields = await runtime.execute<{ fieldIds: string[] }>(
      'sign.field.set',
      {
        envelopeId: recEnv.envelopeId,
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
          {
            signerId: addedSigner.signerId,
            fieldType: 'attachment',
            pageNumber: 1,
            xNorm: 0.12,
            yNorm: 0.55,
            wNorm: 0.28,
            hNorm: 0.06,
            label: 'Phu luc bien ban',
            required: true,
          },
        ],
      },
      { actor: asUser(recorderId), orgId },
    );
    const sigFieldId = setFields.fieldIds[0]!;
    const attFieldId = setFields.fieldIds[1]!;

    await workerRuntime.execute(
      'sign.ai_analysis.record',
      {
        envelopeId: recEnv.envelopeId,
        sourceSha256: recPdfSha,
        status: 'completed',
        extractedPages: [{ page: 1, text: 'Bien ban cuoc hop luong cap cao da chia se' }],
        proposedFields: [],
        riskClauses: [],
        summaryText: 'Bien ban cuoc hop luong cap cao',
      },
      { actor: asSystem('sign-ai-worker'), orgId },
    );

    // 3. Both Recorder AND Attendee can read/list/download recEnv & attTplEnv!
    for (const readerId of [recorderId, attendeeId]) {
      const listRes = await runtime.query<{ items: Array<{ id: string }> }>(
        'sign.envelope.list',
        { sourceKind: 'meeting_minutes', limit: 20 },
        { actor: asUser(readerId), orgId },
      );
      expect(listRes.items.map((x) => x.id)).toEqual(expect.arrayContaining([recEnv.envelopeId, attTplEnv.envelopeId]));

      const bySrc = await runtime.query<{ items: Array<{ envelopeId: string }> }>(
        'sign.envelope.by_source',
        { sourceKind: 'meeting_minutes', sourceIds: [attendeesMeetingId] },
        { actor: asUser(readerId), orgId },
      );
      expect(bySrc.items).toHaveLength(1);

      const got = await runtime.query<{ envelope: { id: string } }>(
        'sign.envelope.get',
        { envelopeId: recEnv.envelopeId },
        { actor: asUser(readerId), orgId },
      );
      expect(got.envelope.id).toBe(recEnv.envelopeId);

      const fileMeta = await runtime.query<{ id: string }>(
        'kernel.file.get',
        { id: recPdf },
        { actor: asUser(readerId), orgId },
      );
      expect(fileMeta.id).toBe(recPdf);
    }

    // 4. Non-readers (INCLUDING ownerId and adminId!) get 0 items in list/by_source and identical 404 across ALL reads/mutations,
    // both with AI enabled AND with AI kill-switched!
    const assertNonReaderBlocked = async (callerId: string, isWriter: boolean) => {
      const page1 = await runtime.query<{ items: Array<{ id: string; sourceKind: string }> }>(
        'sign.envelope.list',
        { limit: 1 },
        { actor: asUser(callerId), orgId },
      );
      expect(page1.items.map((x) => x.id)).toEqual([standaloneEnv.envelopeId]);

      const mtgList = await runtime.query<{ items: Array<{ id: string }> }>(
        'sign.envelope.list',
        { sourceKind: 'meeting_minutes', limit: 20 },
        { actor: asUser(callerId), orgId },
      );
      expect(mtgList.items).toEqual([]);

      const bySrc = await runtime.query<{ items: unknown[] }>(
        'sign.envelope.by_source',
        { sourceKind: 'meeting_minutes', sourceIds: [attendeesMeetingId] },
        { actor: asUser(callerId), orgId },
      );
      expect(bySrc.items).toEqual([]);

      for (const queryName of ['sign.envelope.get', 'sign.envelope.events', 'sign.envelope.verify', 'sign.ai_analysis.get'] as const) {
        await expect(
          runtime.query(queryName, { envelopeId: recEnv.envelopeId }, { actor: asUser(callerId), orgId }),
        ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });
      }

      await expect(
        runtime.query('kernel.file.get', { id: recPdf }, { actor: asUser(callerId), orgId }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });

      if (isWriter) {
        await expect(
          runtime.query('sign.ai_analysis.source', { envelopeId: recEnv.envelopeId }, { actor: asUser(callerId), orgId }),
        ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });

        await expect(
          runtime.execute(
            'sign.envelope.update',
            { envelopeId: recEnv.envelopeId, title: 'Tamper' },
            { actor: asUser(callerId), orgId },
          ),
        ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });

        await expect(
          runtime.execute(
            'sign.signer.add',
            { envelopeId: recEnv.envelopeId, roleLabel: 'Spy', name: 'Spy', deliveryMode: 'link' },
            { actor: asUser(callerId), orgId },
          ),
        ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });

        await expect(
          runtime.execute(
            'sign.field.set',
            { envelopeId: recEnv.envelopeId, fields: [] },
            { actor: asUser(callerId), orgId },
          ),
        ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });

        await expect(
          runtime.execute(
            'sign.envelope.propose_fields',
            { envelopeId: recEnv.envelopeId, sourceSha256: recPdfSha, status: 'failed', errorMessage: 'probe' },
            { actor: asUser(callerId), orgId },
          ),
        ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });

        await expect(
          runtime.execute('sign.envelope.send', { envelopeId: recEnv.envelopeId }, { actor: asUser(callerId), orgId }),
        ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });

        await expect(
          runtime.execute(
            'sign.template.create',
            { title: 'Clone Confidential Minutes', sourceEnvelopeId: recEnv.envelopeId },
            { actor: asUser(callerId), orgId },
          ),
        ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });

        await expect(
          runtime.execute(
            'sign.template.create',
            { title: 'Clone Confidential Minutes File', sourceFileId: recPdf },
            { actor: asUser(callerId), orgId },
          ),
        ).rejects.toMatchObject({ code: 'SIGN_FILE_NOT_FOUND', status: 404 });
      }
    };

    for (const [callerId, isWriter] of [
      [ownerId, true],
      [adminId, true],
      [outsiderMemberId, true],
      [viewerId, false],
    ] as const) {
      await assertNonReaderBlocked(callerId, isWriter);
    }

    // Repeat with sign AI kill switch ON -> identical 404 parity and aiStopped = true for permitted readers!
    await adminPool!.query(
      `INSERT INTO crove_kernel.kill_switch (org_id, scope, target, reason, engaged_by)
       VALUES ($1::uuid, 'module', 'sign', 'AI stopped for invariant test', $2::uuid)`,
      [orgId, ownerId],
    );
    const stoppedAiSource = await runtime.query<{ aiStopped: boolean }>(
      'sign.ai_analysis.source',
      { envelopeId: recEnv.envelopeId },
      { actor: asUser(recorderId), orgId },
    );
    expect(stoppedAiSource.aiStopped).toBe(true);
    await assertNonReaderBlocked(ownerId, true);
    await adminPool!.query('DELETE FROM crove_kernel.kill_switch WHERE org_id = $1::uuid', [orgId]);

    // Even permitted readers cannot clone a confidential meeting_minutes envelope or its dedicated PDF into an org-wide template (403)!
    for (const readerId of [recorderId, attendeeId]) {
      await expect(
        runtime.execute(
          'sign.template.create',
          { title: 'Accidental Org Template', sourceEnvelopeId: recEnv.envelopeId },
          { actor: asUser(readerId), orgId },
        ),
      ).rejects.toMatchObject({ code: 'SIGN_FORBIDDEN', status: 403 });

      await expect(
        runtime.execute(
          'sign.template.create',
          { title: 'Accidental Org Template From File', sourceFileId: recPdf },
          { actor: asUser(readerId), orgId },
        ),
      ).rejects.toMatchObject({ code: 'SIGN_FORBIDDEN', status: 403 });
    }

    // Meanwhile the blank org-wide template PDF (tplPdf) remains readable to all members!
    const tplFileRead = await runtime.query<{ id: string }>(
      'kernel.file.get',
      { id: tplPdf },
      { actor: asUser(outsiderMemberId), orgId },
    );
    expect(tplFileRead.id).toBe(tplPdf);

    // #4530: a permitted attendee READS the recorder's draft but does not change or send it: 403 SIGN_FORBIDDEN (not 404, the attendee reads the envelope), before the draft is checked at all.
    // Only the envelope's creator, an owner or an admin acts on a meeting-minutes envelope, like a standalone one.
    const attendeeDraftAttempts: Array<[string, Record<string, unknown>]> = [
      ['sign.envelope.update', { envelopeId: recEnv.envelopeId, title: 'Tamper by attendee' }],
      ['sign.signer.add', { envelopeId: recEnv.envelopeId, roleLabel: 'Spy', name: 'Spy', deliveryMode: 'link' }],
      ['sign.signer.remove', { envelopeId: recEnv.envelopeId, signerId: addedSigner.signerId }],
      ['sign.signer.reorder', { envelopeId: recEnv.envelopeId, orders: [{ signerId: addedSigner.signerId, routingOrder: 1 }] }],
      ['sign.field.set', { envelopeId: recEnv.envelopeId, fields: [] }],
      ['sign.envelope.send', { envelopeId: recEnv.envelopeId }],
    ];
    for (const [command, input] of attendeeDraftAttempts) {
      await expect(runtime.execute(command, input, { actor: asUser(attendeeId), orgId }), `attendee ${command}`).rejects.toMatchObject({ code: 'SIGN_FORBIDDEN', status: 403 });
    }

    // 5. Send envelope, verify active-envelope mutations (create_link, remind, void) return 404 to non-reader owner/admin,
    // complete public signing ceremony + worker sealing, and verify sealed/certificate file downloads!
    const sent = await runtime.execute<{
      links: Array<{ signerId: string; tokenId: string; token: string }>;
    }>(
      'sign.envelope.send',
      { envelopeId: recEnv.envelopeId },
      { actor: asUser(recorderId), orgId },
    );
    expect(sent.links).toHaveLength(1);
    const rawSigningToken = sent.links[0]!.token;

    for (const nonReaderId of [ownerId, adminId, outsiderMemberId]) {
      await expect(
        runtime.execute(
          'sign.signer.create_link',
          { envelopeId: recEnv.envelopeId, signerId: addedSigner.signerId },
          { actor: asUser(nonReaderId), orgId },
        ),
      ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });

      await expect(
        runtime.execute(
          'sign.envelope.remind',
          { envelopeId: recEnv.envelopeId, signerId: addedSigner.signerId },
          { actor: asUser(nonReaderId), orgId },
        ),
      ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });

      await expect(
        runtime.execute(
          'sign.envelope.void',
          { envelopeId: recEnv.envelopeId, reason: 'Unauthorized owner void attempt' },
          { actor: asUser(nonReaderId), orgId },
        ),
      ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });

      await expect(
        runtime.execute(
          'sign.signer.correct_recipient',
          {
            envelopeId: recEnv.envelopeId,
            signerId: addedSigner.signerId,
            name: 'Hijack Attempt',
            email: 'hijack@example.com',
            deliveryMode: 'email',
          },
          { actor: asUser(nonReaderId), orgId },
        ),
      ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });

      await expect(
        runtime.execute(
          'sign.signer.start_in_person',
          { envelopeId: recEnv.envelopeId, signerId: addedSigner.signerId },
          { actor: asUser(nonReaderId), orgId },
        ),
      ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });
    }

    // Direct SQL SECURITY DEFINER + template RLS probes while recEnv is active ('sent') and addedSigner is live ('pending'),
    // proving non-reader owners are rejected by ADR-0047 guards rather than envelope/signer lifecycle state!
    const activeProbeClient = await appPool!.connect();
    try {
      await activeProbeClient.query('BEGIN');
      await activeProbeClient.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [
        orgId,
        contextToken(ownerId, orgId),
      ]);

      await activeProbeClient.query('SAVEPOINT sp_active_in_person');
      await expect(
        activeProbeClient.query(
          'SELECT crove_sign.mint_in_person_signing_token($1::uuid, $2::uuid, $3::text, now() + interval \'30 minutes\')',
          [recEnv.envelopeId, addedSigner.signerId, hashSigningToken(generateRawSigningToken())],
        ),
      ).rejects.toThrow(/ENVELOPE_NOT_ACTIVE/);
      await activeProbeClient.query('ROLLBACK TO SAVEPOINT sp_active_in_person');

      await activeProbeClient.query('SAVEPOINT sp_active_mint');
      await expect(
        activeProbeClient.query(
          'SELECT crove_sign.mint_signing_token($1::uuid, $2::uuid, $3::text, now() + interval \'1 day\')',
          [recEnv.envelopeId, addedSigner.signerId, hashSigningToken(generateRawSigningToken())],
        ),
      ).rejects.toThrow(/ENVELOPE_NOT_ACTIVE/);
      await activeProbeClient.query('ROLLBACK TO SAVEPOINT sp_active_mint');

      await activeProbeClient.query('SAVEPOINT sp_tpl_confidential_source');
      await expect(
        activeProbeClient.query(
          `INSERT INTO crove_sign.template (
             org_id, title, source_file_id, source_storage_key, source_generation, source_sha256,
             created_by, created_at
           ) VALUES ($1::uuid, 'Exfil Minutes Hub Probe', $2::uuid, $3::text, $4::text, $5::text, $6::uuid, '2020-01-01T00:00:00Z')`,
          [orgId, recPdf, fileKey(orgId, recPdfSha), contentGeneration(recPdfSha), recPdfSha, ownerId],
        ),
      ).rejects.toThrow(/row-level security policy/);
      await activeProbeClient.query('ROLLBACK TO SAVEPOINT sp_tpl_confidential_source');

      const activeCorrectRes = await activeProbeClient.query<{ res: { status: string; target?: string } }>(
        `SELECT crove_sign.correct_signer_recipient($1::uuid, $2::uuid, 'Hijack', 'hijack@example.com', NULL, 'email', false) AS res`,
        [recEnv.envelopeId, addedSigner.signerId],
      );
      expect(activeCorrectRes.rows[0]?.res).toEqual({ status: 'not_found', target: 'envelope' });
    } finally {
      await activeProbeClient.query('ROLLBACK').catch(() => {});
      activeProbeClient.release();
    }

    // #4530: a permitted attendee who is not the creator, an owner or an admin can NOT start an in-person session (it mints a one-time signing token, the same power as create_link), remind the signers
    // (it mails them) or issue or rotate a signing link: 403 SIGN_FORBIDDEN (the attendee reads the envelope, so not 404). The recorder, who created the envelope, can start the session.
    // (This replaces the earlier "permitted attendee CAN start an in-person session" case.)
    await expect(
      runtime.execute('sign.signer.start_in_person', { envelopeId: recEnv.envelopeId, signerId: addedSigner.signerId }, { actor: asUser(attendeeId), orgId }),
    ).rejects.toMatchObject({ code: 'SIGN_FORBIDDEN', status: 403 });
    await expect(
      runtime.execute('sign.envelope.remind', { envelopeId: recEnv.envelopeId, signerId: addedSigner.signerId }, { actor: asUser(attendeeId), orgId }),
    ).rejects.toMatchObject({ code: 'SIGN_FORBIDDEN', status: 403 });
    const inPersonStarted = await runtime.execute<{
      hostUserId: string;
      token: string;
      ceremonyPath: string;
    }>(
      'sign.signer.start_in_person',
      { envelopeId: recEnv.envelopeId, signerId: addedSigner.signerId },
      { actor: asUser(recorderId), orgId },
    );
    expect(inPersonStarted.hostUserId).toBe(recorderId);
    expect(inPersonStarted.ceremonyPath).toContain('?in_person=1#');

    await expect(
      runtime.execute('sign.signer.create_link', { envelopeId: recEnv.envelopeId, signerId: addedSigner.signerId }, { actor: asUser(attendeeId), orgId }),
    ).rejects.toMatchObject({ code: 'SIGN_FORBIDDEN', status: 403 });
    const rotated = await runtime.execute<{ token: string }>(
      'sign.signer.create_link',
      { envelopeId: recEnv.envelopeId, signerId: addedSigner.signerId },
      { actor: asUser(recorderId), orgId },
    );
    const activeToken = rotated.token || rawSigningToken;

    // Public single-use token ceremony succeeds cleanly via crove_app orgless definers.
    const tokenSha = hashSigningToken(activeToken);
    const viewed = await appPool!.query<{ v: Record<string, unknown> }>(
      'SELECT crove_sign.public_record_view($1, $2, $3) AS v',
      [tokenSha, ipHash, 'AttendeeBrowser/1.0'],
    );
    expect(viewed.rows[0]?.v).toMatchObject({ state: 'ready', signerName: 'Attendee' });

    const pdfSource = await appPool!.query<{ v: Record<string, unknown> }>(
      'SELECT crove_sign.public_pdf_source($1) AS v',
      [tokenSha],
    );
    expect(pdfSource.rows[0]?.v).toMatchObject({ orgId, otpRequired: false });

    const supersededAttSha = sha256Hex(Buffer.from(`%PDF-1.4\n% mtg-att-superseded-${randomUUID()}\n%%EOF\n`, 'utf8'));
    const supersededAttRes = await appPool!.query<{ v: { status: string; fileId?: string } }>(
      `SELECT crove_sign.public_record_attachment(
         $1, $2::uuid, 'phu-luc-nhap.pdf', 'application/pdf', 128, $3, $4, $5, $6, 'AttendeeBrowser/1.0'
       ) AS v`,
      [tokenSha, attFieldId, supersededAttSha, fileKey(orgId, supersededAttSha), contentGeneration(supersededAttSha), ipHash],
    );
    expect(supersededAttRes.rows[0]?.v.status).toBe('ok');
    const supersededMtgAttFileId = supersededAttRes.rows[0]!.v.fileId!;

    const finalAttSha = sha256Hex(Buffer.from(`%PDF-1.4\n% mtg-att-final-${randomUUID()}\n%%EOF\n`, 'utf8'));
    const finalAttRes = await appPool!.query<{ v: { status: string; fileId?: string } }>(
      `SELECT crove_sign.public_record_attachment(
         $1, $2::uuid, 'phu-luc-chinh-thuc.pdf', 'application/pdf', 256, $3, $4, $5, $6, 'AttendeeBrowser/1.0'
       ) AS v`,
      [tokenSha, attFieldId, finalAttSha, fileKey(orgId, finalAttSha), contentGeneration(finalAttSha), ipHash],
    );
    expect(finalAttRes.rows[0]?.v.status).toBe('ok');
    const finalMtgAttFileId = finalAttRes.rows[0]!.v.fileId!;

    const submitted = await appPool!.query<{ v: { status: string; completed?: boolean; envelopeStatus?: string } }>(
      `SELECT crove_sign.public_submit($1, true, 'draw', NULL, $2::jsonb, $3, 'AttendeeBrowser/1.0', $4) AS v`,
      [
        tokenSha,
        JSON.stringify([{ fieldId: sigFieldId, signaturePngBase64: VALID_PNG_BASE64 }, { fieldId: attFieldId }]),
        ipHash,
        DEFAULT_MESSAGE_ID_DOMAIN,
      ],
    );
    expect(submitted.rows[0]?.v).toMatchObject({
      status: 'ok',
      completed: true,
      envelopeStatus: 'completed',
    });

    const sealJob = await workerRuntime.query<{
      envelope: { id: string; completedAtIso: string | null };
      events: Array<{ event_hash: string }>;
    } | null>(
      'sign.envelope.seal_job_data',
      { envelopeId: recEnv.envelopeId },
      { actor: asSystem('sign-pdf-seal'), orgId },
    );
    expect(sealJob?.envelope.id).toBe(recEnv.envelopeId);

    const { fileId: sealedFileId, sha256: sealedSha } = await ingestSignFile(
      asSystem('sign-pdf-seal'),
      orgId,
      `sealed-mtg-${randomUUID()}`,
      'sign_sealed',
    );
    const { fileId: certFileId } = await ingestSignFile(
      asSystem('sign-pdf-seal'),
      orgId,
      `cert-mtg-${randomUUID()}`,
      'sign_certificate',
      'application/json',
    );
    const certCode = generateCertificateCode(
      recEnv.envelopeId,
      sealJob!.envelope.completedAtIso ?? new Date().toISOString(),
      sealJob!.events[sealJob!.events.length - 1]!.event_hash,
    );

    await workerRuntime.execute(
      'sign.envelope.seal_complete',
      {
        envelopeId: recEnv.envelopeId,
        outcome: 'sealed',
        certificateCode: certCode,
        sealedFileId,
        certificateFileId: certFileId,
      },
      { actor: asSystem('sign-pdf-seal'), orgId },
    );

    // Post-signature obligations (#3821 + ADR-0047): creator confirms obligations on completed confidential meeting_minutes envelope;
    // permitted readers (recorderId, attendeeId) can read/list/see Today alerts, while non-reader owners/admins/members/viewers get 404 or 0 items.
    await runtime.execute(
      'sign.obligation.upsert',
      {
        envelopeId: recEnv.envelopeId,
        counterpartyName: 'Doi tac bien ban mat',
        effectiveDate: '2026-11-01',
        expiryDate: '2026-12-01',
        renewalNoticeDays: 15,
        autoRenew: true,
        contractValue: '50000000',
        currency: 'VND',
        obligations: [
          {
            id: 'mtg-obl-1',
            title: 'Hoan tat hanh dong bien ban hop',
            dueDate: '2026-11-22',
            status: 'pending',
          },
        ],
      },
      { actor: asUser(recorderId), orgId },
    );

    await runtime.execute(
      'sign.playbook.record_check',
      {
        envelopeId: recEnv.envelopeId,
        sourceSha256: recPdfSha,
        mode: 'deterministic',
        promptVersion: null,
        extractedPages: [{ page: 1, text: 'Dieu 5: Phat vi pham 12% gia tri hop dong.' }],
      },
      { actor: asUser(recorderId), orgId },
    );

    for (const readerId of [recorderId, attendeeId]) {
      const gotObl = await runtime.query<{ obligation: { envelopeId: string; status: string } | null }>(
        'sign.obligation.get',
        { envelopeId: recEnv.envelopeId },
        { actor: asUser(readerId), orgId },
      );
      expect(gotObl.obligation?.envelopeId).toBe(recEnv.envelopeId);
      expect(gotObl.obligation?.status).toBe('confirmed');

      const gotPlaybook = await runtime.query<{ check: { envelopeId: string; mode: string } | null }>(
        'sign.playbook.get',
        { envelopeId: recEnv.envelopeId },
        { actor: asUser(readerId), orgId },
      );
      expect(gotPlaybook.check?.envelopeId).toBe(recEnv.envelopeId);
      expect(gotPlaybook.check?.mode).toBe('deterministic');

      const renewals = await runtime.query<{ items: Array<{ envelope: { id: string } }> }>(
        'sign.obligation.renewals_list',
        { limit: 20 },
        { actor: asUser(readerId), orgId },
      );
      expect(renewals.items.map((x) => x.envelope.id)).toContain(recEnv.envelopeId);

      const todayItems = await runtime.query<Array<{ href?: string }>>(
        'sign.obligations.today',
        { now: '2026-11-21T09:00:00+07:00' },
        { actor: asUser(readerId), orgId },
      );
      expect(todayItems.some((item) => item.href === `/sign/envelopes/${recEnv.envelopeId}`)).toBe(true);

      const vaultMatches = await runtime.query<{ items: Array<{ envelopeId: string }> }>(
        'sign.vault.search',
        { question: 'Doi tac bien ban mat', limit: 20 },
        { actor: asUser(readerId), orgId },
      );
      expect(vaultMatches.items.map((x) => x.envelopeId)).toContain(recEnv.envelopeId);
    }

    for (const nonReaderId of [ownerId, adminId, outsiderMemberId, viewerId]) {
      await expect(
        runtime.query('sign.obligation.get', { envelopeId: recEnv.envelopeId }, { actor: asUser(nonReaderId), orgId }),
      ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });

      await expect(
        runtime.query('sign.playbook.get', { envelopeId: recEnv.envelopeId }, { actor: asUser(nonReaderId), orgId }),
      ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });

      const renewals = await runtime.query<{ items: Array<{ envelope: { id: string } }> }>(
        'sign.obligation.renewals_list',
        { limit: 20 },
        { actor: asUser(nonReaderId), orgId },
      );
      expect(renewals.items.map((x) => x.envelope.id)).not.toContain(recEnv.envelopeId);

      const todayItems = await runtime.query<Array<{ href?: string }>>(
        'sign.obligations.today',
        { now: '2026-11-21T09:00:00+07:00' },
        { actor: asUser(nonReaderId), orgId },
      );
      expect(todayItems.some((item) => item.href === `/sign/envelopes/${recEnv.envelopeId}`)).toBe(false);

      const vaultMatches = await runtime.query<{ items: Array<{ envelopeId: string }> }>(
        'sign.vault.search',
        { question: 'Doi tac bien ban mat', limit: 20 },
        { actor: asUser(nonReaderId), orgId },
      );
      expect(vaultMatches.items.map((x) => x.envelopeId)).not.toContain(recEnv.envelopeId);
    }

    for (const nonReaderWriterId of [ownerId, adminId, outsiderMemberId]) {
      await expect(
        runtime.query('sign.obligation.source', { envelopeId: recEnv.envelopeId }, { actor: asUser(nonReaderWriterId), orgId }),
      ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });
      await expect(
        runtime.execute(
          'sign.obligation.upsert',
          {
            envelopeId: recEnv.envelopeId,
            autoRenew: false,
            currency: 'VND',
            obligations: [],
          },
          { actor: asUser(nonReaderWriterId), orgId },
        ),
      ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });
      await expect(
        runtime.execute(
          'sign.obligation.propose',
          {
            envelopeId: recEnv.envelopeId,
            proposal: { autoRenew: false, currency: 'VND', citations: [], obligations: [] },
          },
          { actor: asUser(nonReaderWriterId), orgId },
        ),
      ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });
      await expect(
        runtime.execute(
          'sign.obligation.dismiss_proposal',
          { envelopeId: recEnv.envelopeId },
          { actor: asUser(nonReaderWriterId), orgId },
        ),
      ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });
      await expect(
        runtime.execute(
          'sign.obligation.complete_item',
          { envelopeId: recEnv.envelopeId, itemId: 'mtg-obl-1', completed: true },
          { actor: asUser(nonReaderWriterId), orgId },
        ),
      ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });
      await expect(
        runtime.query('sign.playbook.source', { envelopeId: recEnv.envelopeId }, { actor: asUser(nonReaderWriterId), orgId }),
      ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });
      await expect(
        runtime.execute(
          'sign.playbook.record_check',
          {
            envelopeId: recEnv.envelopeId,
            sourceSha256: recPdfSha,
            mode: 'deterministic',
            promptVersion: null,
            extractedPages: [{ page: 1, text: 'Probe' }],
          },
          { actor: asUser(nonReaderWriterId), orgId },
        ),
      ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });
      await expect(
        runtime.execute(
          'sign.playbook.override_finding',
          {
            envelopeId: recEnv.envelopeId,
            ruleId: '01900000-0000-4000-8000-000000000001',
            checkRevision: '0'.repeat(64),
            verdict: 'pass',
          },
          { actor: asUser(nonReaderWriterId), orgId },
        ),
      ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });
      await expect(
        runtime.query(
          'sign.kyc.source',
          { envelopeId: recEnv.envelopeId, fieldId: attFieldId },
          { actor: asUser(nonReaderWriterId), orgId },
        ),
      ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });
      await expect(
        runtime.execute(
          'sign.kyc.run_deterministic',
          {
            envelopeId: recEnv.envelopeId,
            fieldId: attFieldId,
            attachmentPages: [{ page: 1, text: 'Phu luc bien ban MST: 0312345678' }],
          },
          { actor: asUser(nonReaderWriterId), orgId },
        ),
      ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });
      await expect(
        runtime.execute(
          'sign.kyc.confirm',
          { envelopeId: recEnv.envelopeId, fieldId: attFieldId, status: 'matched' },
          { actor: asUser(nonReaderWriterId), orgId },
        ),
      ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });
    }

    // Permitted meeting_minutes readers can run KYC checks and read KYC list, while non-readers get 404 (#4443 + ADR-0047).
    await runtime.execute(
      'sign.kyc.run_deterministic',
      {
        envelopeId: recEnv.envelopeId,
        fieldId: attFieldId,
        attachmentPages: [{ page: 1, text: 'Phu luc bien ban MST: 0312345678' }],
      },
      { actor: asUser(recorderId), orgId },
    );
    for (const readerId of [recorderId, attendeeId]) {
      const kycList = await runtime.query<{ items: Array<{ fieldId: string }> }>(
        'sign.kyc.list',
        { envelopeId: recEnv.envelopeId },
        { actor: asUser(readerId), orgId },
      );
      expect(kycList.items.map((x) => x.fieldId)).toContain(attFieldId);
    }
    for (const nonReaderId of [ownerId, adminId, outsiderMemberId, viewerId]) {
      await expect(
        runtime.query('sign.kyc.list', { envelopeId: recEnv.envelopeId }, { actor: asUser(nonReaderId), orgId }),
      ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });
    }

    // System sweep & cleanup commands continue to run cleanly with meeting_minutes rows present.
    await workerRuntime.execute('sign.envelope.expire_sweep', {}, { actor: asSystem('sign-expire-sweep'), orgId });
    await workerRuntime.execute('sign.org.cleanup', {}, { actor: asSystem('sign-cleanup'), orgId });

    // Public verification by certificateCode + sha256 works without leaking text.
    const pubVerify = await appPool!.query<{ res: { matched: boolean; envelopeStatus?: string } }>(
      'SELECT crove_sign.public_verify_certificate($1::text, $2::text) AS res',
      [certCode, sealedSha],
    );
    expect(pubVerify.rows[0]?.res).toMatchObject({ matched: true, envelopeStatus: 'completed' });

    // Recorder and Attendee CAN download sealed PDF, certificate JSON, and active supporting attachment,
    // while non-reader Owner and Admin get 404, and superseded sign_attachment gets 404 for EVERYONE (#3818)!
    for (const readerId of [recorderId, attendeeId]) {
      for (const fid of [recPdf, sealedFileId, certFileId, finalMtgAttFileId]) {
        const meta = await runtime.query<{ id: string }>('kernel.file.get', { id: fid }, { actor: asUser(readerId), orgId });
        expect(meta.id).toBe(fid);
      }
    }
    for (const nonReaderId of [ownerId, adminId, outsiderMemberId, viewerId]) {
      for (const fid of [recPdf, sealedFileId, certFileId, finalMtgAttFileId]) {
        await expect(
          runtime.query('kernel.file.get', { id: fid }, { actor: asUser(nonReaderId), orgId }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
      }
    }
    for (const callerId of [ownerId, adminId, recorderId, attendeeId, outsiderMemberId, viewerId]) {
      await expect(
        runtime.query('kernel.file.get', { id: supersededMtgAttFileId }, { actor: asUser(callerId), orgId }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    }

    // Offboarding snapshot export (B1 + ADR-0047 point 7): tplPdf and ownerPdf stay exported even after
    // attendeesMeetingId instantiated tpl (attTplEnv), while recPdf, sealedFileId, certFileId, finalMtgAttFileId,
    // supersededMtgAttFileId, recEnv, and attTplEnv are excluded from kernel.org.export.snapshot!
    const exportedFileIds: string[] = [];
    await workerRuntime.stream(
      'kernel.org.export.snapshot',
      { table: 'kernel.file' },
      { actor: asSystem('org-export'), orgId },
      async (batch) => {
        for (const line of (batch as { lines: string[] }).lines) {
          exportedFileIds.push((JSON.parse(line) as { id: string }).id);
        }
      },
    );
    expect(exportedFileIds).toEqual(expect.arrayContaining([ownerPdf, tplPdf]));
    expect(exportedFileIds).not.toContain(recPdf);
    expect(exportedFileIds).not.toContain(sealedFileId);
    expect(exportedFileIds).not.toContain(certFileId);
    expect(exportedFileIds).not.toContain(finalMtgAttFileId);
    expect(exportedFileIds).not.toContain(supersededMtgAttFileId);

    const exportedEnvIds: string[] = [];
    await workerRuntime.stream(
      'kernel.org.export.snapshot',
      { table: 'sign.envelope' },
      { actor: asSystem('org-export'), orgId },
      async (batch) => {
        for (const line of (batch as { lines: string[] }).lines) {
          exportedEnvIds.push((JSON.parse(line) as { id: string }).id);
        }
      },
    );
    expect(exportedEnvIds).toContain(standaloneEnv.envelopeId);
    expect(exportedEnvIds).not.toContain(recEnv.envelopeId);
    expect(exportedEnvIds).not.toContain(attTplEnv.envelopeId);

    await adminPool!.query(
      `INSERT INTO crove_sign.envelope_obligation (org_id, envelope_id, status, created_by)
       VALUES ($1::uuid, $2::uuid, 'confirmed', $3::uuid)`,
      [orgId, standaloneEnv.envelopeId, ownerId],
    );
    const exportedObligationEnvIds: string[] = [];
    await workerRuntime.stream(
      'kernel.org.export.snapshot',
      { table: 'sign.envelope_obligation' },
      { actor: asSystem('org-export'), orgId },
      async (batch) => {
        for (const line of (batch as { lines: string[] }).lines) {
          exportedObligationEnvIds.push((JSON.parse(line) as { envelope_id: string }).envelope_id);
        }
      },
    );
    expect(exportedObligationEnvIds).toContain(standaloneEnv.envelopeId);
    expect(exportedObligationEnvIds).not.toContain(recEnv.envelopeId);

    await adminPool!.query(
      `INSERT INTO crove_sign.playbook_check (org_id, envelope_id, source_sha256, mode, created_by)
       VALUES ($1::uuid, $2::uuid, repeat('b', 64), 'deterministic', $3::uuid)`,
      [orgId, standaloneEnv.envelopeId, ownerId],
    );
    const exportedPlaybookCheckEnvIds: string[] = [];
    await workerRuntime.stream(
      'kernel.org.export.snapshot',
      { table: 'sign.playbook_check' },
      { actor: asSystem('org-export'), orgId },
      async (batch) => {
        for (const line of (batch as { lines: string[] }).lines) {
          exportedPlaybookCheckEnvIds.push((JSON.parse(line) as { envelope_id: string }).envelope_id);
        }
      },
    );
    expect(exportedPlaybookCheckEnvIds).toContain(standaloneEnv.envelopeId);
    expect(exportedPlaybookCheckEnvIds).not.toContain(recEnv.envelopeId);

    const standaloneKycSignerRes = await adminPool!.query<{ id: string }>(
      `INSERT INTO crove_sign.signer (org_id, envelope_id, routing_order, signer_role, role_label, name, delivery_mode)
       VALUES ($1::uuid, $2::uuid, 99, 'signer', 'KYC Probe', 'Standalone Signer', 'link')
       RETURNING id`,
      [orgId, standaloneEnv.envelopeId],
    );
    const standaloneKycFieldRes = await adminPool!.query<{ id: string }>(
      `INSERT INTO crove_sign.field (org_id, envelope_id, signer_id, field_type, page_number, x_norm, y_norm, w_norm, h_norm)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'attachment', 1, 0.1, 0.1, 0.3, 0.08)
       RETURNING id`,
      [orgId, standaloneEnv.envelopeId, standaloneKycSignerRes.rows[0]!.id],
    );
    const recKycFieldRes = await adminPool!.query<{ id: string }>(
      `INSERT INTO crove_sign.field (org_id, envelope_id, signer_id, field_type, page_number, x_norm, y_norm, w_norm, h_norm)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'attachment', 1, 0.1, 0.25, 0.3, 0.08)
       RETURNING id`,
      [orgId, recEnv.envelopeId, addedSigner.signerId],
    );
    await adminPool!.query(
      `INSERT INTO crove_sign.kyc_check (org_id, envelope_id, field_id, file_id, file_sha256, status, mode, findings_json)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, 'matched', 'manual', '{}'::jsonb)`,
      [orgId, standaloneEnv.envelopeId, standaloneKycFieldRes.rows[0]!.id, ownerPdf, 'a'.repeat(64)],
    );
    const exportedKycEnvIds: string[] = [];
    await workerRuntime.stream(
      'kernel.org.export.snapshot',
      { table: 'sign.kyc_check' },
      { actor: asSystem('org-export'), orgId },
      async (batch) => {
        for (const line of (batch as { lines: string[] }).lines) {
          exportedKycEnvIds.push((JSON.parse(line) as { envelope_id: string }).envelope_id);
        }
      },
    );
    expect(exportedKycEnvIds).toContain(standaloneEnv.envelopeId);
    expect(exportedKycEnvIds).not.toContain(recEnv.envelopeId);

    // 6. Direct SQL RLS + SECURITY DEFINER checks under crove_app (non-reader owner & agent context)!
    const appClient = await appPool!.connect();
    try {
      await appClient.query('BEGIN');
      await appClient.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [
        orgId,
        contextToken(ownerId, orgId),
      ]);

      for (const table of ['envelope', 'envelope_obligation', 'playbook_check', 'kyc_check', 'signer', 'field', 'ai_analysis', 'signing_event'] as const) {
        const idCol = table === 'envelope' ? 'id' : 'envelope_id';
        const { rowCount } = await appClient.query(
          `SELECT 1 FROM crove_sign.${table} WHERE org_id = $1::uuid AND ${idCol} = $2::uuid`,
          [orgId, recEnv.envelopeId],
        );
        expect(rowCount, `non-reader owner SELECT on crove_sign.${table}`).toBe(0);
      }

      await appClient.query('SAVEPOINT sp_obl_ins');
      await expect(
        appClient.query(
          `INSERT INTO crove_sign.envelope_obligation (org_id, envelope_id, status, created_by)
           VALUES ($1::uuid, $2::uuid, 'confirmed', $3::uuid)`,
          [orgId, attTplEnv.envelopeId, ownerId],
        ),
      ).rejects.toThrow(/row-level security/);
      await appClient.query('ROLLBACK TO SAVEPOINT sp_obl_ins');

      await appClient.query('SAVEPOINT sp_pbk_ins');
      await expect(
        appClient.query(
          `INSERT INTO crove_sign.playbook_check (org_id, envelope_id, source_sha256, mode, created_by)
           VALUES ($1::uuid, $2::uuid, repeat('c', 64), 'deterministic', $3::uuid)`,
          [orgId, attTplEnv.envelopeId, ownerId],
        ),
      ).rejects.toThrow(/row-level security/);
      await appClient.query('ROLLBACK TO SAVEPOINT sp_pbk_ins');

      await appClient.query('SAVEPOINT sp_kyc_direct_ins');
      await expect(
        appClient.query(
          `INSERT INTO crove_sign.kyc_check (org_id, envelope_id, field_id, file_id, file_sha256, status, mode, findings_json)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, 'pending', 'manual', '{}'::jsonb)`,
          [orgId, recEnv.envelopeId, recKycFieldRes.rows[0]!.id, ownerPdf, 'c'.repeat(64)],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await appClient.query('ROLLBACK TO SAVEPOINT sp_kyc_direct_ins');

      await appClient.query('SAVEPOINT sp_kyc_cross_env_ins');
      await expect(
        appClient.query(
          `INSERT INTO crove_sign.kyc_check (org_id, envelope_id, field_id, file_id, file_sha256, status, mode, findings_json)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, 'pending', 'manual', '{}'::jsonb)`,
          [orgId, standaloneEnv.envelopeId, recKycFieldRes.rows[0]!.id, ownerPdf, 'c'.repeat(64)],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await appClient.query('ROLLBACK TO SAVEPOINT sp_kyc_cross_env_ins');

      await appClient.query('SAVEPOINT sp_mint');
      await expect(
        appClient.query(
          'SELECT crove_sign.mint_signing_token($1::uuid, $2::uuid, $3::text, now() + interval \'1 day\')',
          [recEnv.envelopeId, addedSigner.signerId, hashSigningToken(generateRawSigningToken())],
        ),
      ).rejects.toThrow(/ENVELOPE_NOT_ACTIVE/);
      await appClient.query('ROLLBACK TO SAVEPOINT sp_mint');

      const revokeRes = await appClient.query<{ n: number }>(
        'SELECT crove_sign.revoke_envelope_tokens($1::uuid) AS n',
        [recEnv.envelopeId],
      );
      expect(revokeRes.rows[0]?.n).toBe(0);

      const inheritRes = await appClient.query<{ ok: boolean }>(
        'SELECT crove_sign.template_inherit_inspect($1::uuid, $2::uuid) AS ok',
        [tpl.templateId, attTplEnv.envelopeId],
      );
      expect(inheritRes.rows[0]?.ok).toBe(false);

      const correctRes = await appClient.query<{ res: { status: string; target?: string } }>(
        `SELECT crove_sign.correct_signer_recipient($1::uuid, $2::uuid, 'Hijack', 'hijack@example.com', NULL, 'email', false) AS res`,
        [recEnv.envelopeId, addedSigner.signerId],
      );
      expect(correctRes.rows[0]?.res).toEqual({ status: 'not_found', target: 'envelope' });
    } finally {
      await appClient.query('ROLLBACK').catch(() => {});
      appClient.release();
    }

    // Agent context sees zero meeting_minutes rows and gets false from can_read_sign_file!
    const agentRes = await adminPool!.query<{ id: string }>(
      `INSERT INTO crove_kernel.agent (org_id, template_key, display_name, created_by)
       VALUES ($1::uuid, 'finance.chief_accountant', 'Sign Mtg Probe Agent', $2::uuid)
       RETURNING id`,
      [orgId, ownerId],
    );
    const agentId = agentRes.rows[0]!.id;
    const defaultLe = await adminPool!.query<{ id: string }>(
      'SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1::uuid AND is_default LIMIT 1',
      [orgId],
    );
    await adminPool!.query(
      `INSERT INTO crove_kernel.position (org_id, title, module, role_key, holder_agent_id, le_scope)
       VALUES ($1::uuid, 'Probe Seat', 'finance', 'finance.chief_accountant', $2::uuid, ARRAY[$3::text])`,
      [orgId, agentId, defaultLe.rows[0]!.id],
    );
    const runRes = await adminPool!.query<{ id: string }>(
      `INSERT INTO crove_kernel.ai_run (org_id, agent_id, module, status, expires_at)
       VALUES ($1::uuid, $2::uuid, 'finance', 'running', now() + interval '10 minutes')
       RETURNING id`,
      [orgId, agentId],
    );
    const runId = runRes.rows[0]!.id;
    const workerClient = await workerPool!.connect();
    try {
      await workerClient.query('BEGIN');
      await workerClient.query('SELECT crove_kernel.enter_agent_context($1::uuid, $2::uuid, $3::uuid)', [
        orgId,
        agentId,
        runId,
      ]);
      const envRows = await workerClient.query(
        'SELECT id FROM crove_sign.envelope WHERE org_id = $1::uuid AND id = $2::uuid',
        [orgId, recEnv.envelopeId],
      );
      expect(envRows.rowCount).toBe(0);
      const oblRows = await workerClient.query(
        'SELECT id FROM crove_sign.envelope_obligation WHERE org_id = $1::uuid AND envelope_id = $2::uuid',
        [orgId, recEnv.envelopeId],
      );
      expect(oblRows.rowCount).toBe(0);
      const pbkRows = await workerClient.query(
        'SELECT id FROM crove_sign.playbook_check WHERE org_id = $1::uuid AND envelope_id = $2::uuid',
        [orgId, recEnv.envelopeId],
      );
      expect(pbkRows.rowCount).toBe(0);
      const kycRows = await workerClient.query(
        'SELECT id FROM crove_sign.kyc_check WHERE org_id = $1::uuid AND envelope_id = $2::uuid',
        [orgId, recEnv.envelopeId],
      );
      expect(kycRows.rowCount).toBe(0);
      const canRead = await workerClient.query<{ ok: boolean }>(
        'SELECT crove_sign.can_read_sign_file($1::uuid) AS ok',
        [sealedFileId],
      );
      expect(canRead.rows[0]?.ok).toBe(false);
    } finally {
      await workerClient.query('ROLLBACK').catch(() => {});
      workerClient.release();
    }

    // 7. Dynamic reader revocation, creator role demotion, retention expiry, completed legal-record retention, and tenant_member removal (#3811, #4531 Step 2 of 2).
    await runtime.execute(
      'meetings.reader.remove',
      { meetingId: attendeesMeetingId, userId: attendeeId },
      { actor: asUser(recorderId), orgId },
    );
    // Attendee removed from meeting_reader immediately loses access to BOTH completed recEnv AND unsigned attTplEnv (even as created_by!).
    await expect(
      runtime.query('sign.envelope.get', { envelopeId: recEnv.envelopeId }, { actor: asUser(attendeeId), orgId }),
    ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });
    const recStillReadableByCreator = await runtime.query<{ envelope: { id: string; status: string } }>(
      'sign.envelope.get',
      { envelopeId: recEnv.envelopeId },
      { actor: asUser(recorderId), orgId },
    );
    expect(recStillReadableByCreator.envelope.id).toBe(recEnv.envelopeId);
    await expect(
      runtime.query('sign.envelope.get', { envelopeId: attTplEnv.envelopeId }, { actor: asUser(attendeeId), orgId }),
    ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });

    // Re-add attendee, then demote created_by to 'viewer':
    //   - attendeeId loses access to recEnv (404, non-creator viewer cannot read meetings)
    //   - unsigned attTplEnv returns 404 SIGN_ENVELOPE_NOT_FOUND even for its created_by
    //   - completed recEnv stays readable by recorderId
    await runtime.execute(
      'meetings.reader.add',
      { meetingId: attendeesMeetingId, userId: attendeeId },
      { actor: asUser(recorderId), orgId },
    );
    await adminPool!.query(
      `UPDATE crove_kernel.tenant_member
          SET role = 'viewer'
        WHERE org_id = $1::uuid AND user_id = $2::uuid`,
      [orgId, attendeeId],
    );
    await expect(
      runtime.query('sign.envelope.get', { envelopeId: recEnv.envelopeId }, { actor: asUser(attendeeId), orgId }),
    ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });
    await expect(
      runtime.query('sign.envelope.get', { envelopeId: attTplEnv.envelopeId }, { actor: asUser(attendeeId), orgId }),
    ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });
    expect(
      (
        await runtime.query<{ envelope: { id: string } }>(
          'sign.envelope.get',
          { envelopeId: recEnv.envelopeId },
          { actor: asUser(recorderId), orgId },
        )
      ).envelope.id,
    ).toBe(recEnv.envelopeId);
    await adminPool!.query(
      `UPDATE crove_kernel.tenant_member
          SET role = 'member'
        WHERE org_id = $1::uuid AND user_id = $2::uuid`,
      [orgId, attendeeId],
    );

    // Expire text_retention_date: no new meeting_minutes envelope can be created (404 SIGN_SOURCE_NOT_FOUND).
    // Unsigned attTplEnv returns 404 for ALL users including created_by attendeeId and recorderId,
    // while completed legal record recEnv stays readable by BOTH creator recorderId AND active reader attendeeId!
    await adminPool!.query(
      `UPDATE crove_meetings.meeting
          SET text_retention_date = ((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - 1)
        WHERE org_id = $1::uuid AND id = $2::uuid`,
      [orgId, attendeesMeetingId],
    );
    await expect(
      runtime.execute(
        'sign.envelope.create',
        {
          title: 'Expired Retention Minutes',
          sourceKind: 'meeting_minutes',
          sourceId: attendeesMeetingId,
          sourceFileId: recPdf,
        },
        { actor: asUser(recorderId), orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_SOURCE_NOT_FOUND', status: 404 });

    for (const nonReaderId of [ownerId, adminId, outsiderMemberId, viewerId]) {
      await expect(
        runtime.query('sign.envelope.get', { envelopeId: recEnv.envelopeId }, { actor: asUser(nonReaderId), orgId }),
      ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });
      await expect(
        runtime.query('sign.envelope.get', { envelopeId: attTplEnv.envelopeId }, { actor: asUser(nonReaderId), orgId }),
      ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });
    }

    await expect(
      runtime.query('sign.envelope.get', { envelopeId: attTplEnv.envelopeId }, { actor: asUser(recorderId), orgId }),
    ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });
    await expect(
      runtime.query('sign.envelope.get', { envelopeId: attTplEnv.envelopeId }, { actor: asUser(attendeeId), orgId }),
    ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });

    for (const readerId of [recorderId, attendeeId]) {
      const stillReads = await runtime.query<{ envelope: { id: string; status: string } }>(
        'sign.envelope.get',
        { envelopeId: recEnv.envelopeId },
        { actor: asUser(readerId), orgId },
      );
      expect(stillReads.envelope.id).toBe(recEnv.envelopeId);
      expect(stillReads.envelope.status).toBe('completed');

      const sealedMetaAfterRetention = await runtime.query<{ id: string }>(
        'kernel.file.get',
        { id: sealedFileId },
        { actor: asUser(readerId), orgId },
      );
      expect(sealedMetaAfterRetention.id).toBe(sealedFileId);

      const oblAfterRetention = await runtime.query<{ obligation: { envelopeId: string } | null }>(
        'sign.obligation.get',
        { envelopeId: recEnv.envelopeId },
        { actor: asUser(readerId), orgId },
      );
      expect(oblAfterRetention.obligation?.envelopeId).toBe(recEnv.envelopeId);

      const playbookAfterRetention = await runtime.query<{ check: { envelopeId: string } | null }>(
        'sign.playbook.get',
        { envelopeId: recEnv.envelopeId },
        { actor: asUser(readerId), orgId },
      );
      expect(playbookAfterRetention.check?.envelopeId).toBe(recEnv.envelopeId);
    }

    // Removing reader/creator from tenant_member revokes SQL RLS & file access immediately (even for completed records).
    await adminPool!.query(
      'DELETE FROM crove_kernel.tenant_member WHERE org_id = $1::uuid AND user_id = $2::uuid',
      [orgId, attendeeId],
    );
    await expect(
      runtime.query('sign.envelope.get', { envelopeId: recEnv.envelopeId }, { actor: asUser(attendeeId), orgId }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      runtime.query('sign.envelope.get', { envelopeId: attTplEnv.envelopeId }, { actor: asUser(attendeeId), orgId }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('enforces org-visible meeting whole-org scope (blocking entity-limited members and viewers) and meetings MODULE_OFF creation guard', async () => {
    const { meetingId: orgMeetingId } = await runtime.execute<{ meetingId: string }>(
      'meetings.meeting.create',
      {
        title: 'Hop toan cong ty thang 11',
        language: 'vi',
        visibility: 'org',
        keepVideo: false,
        liveNotes: false,
        summaryTemplate: 'general',
        consentMethod: 'told_at_start',
      },
      { actor: asUser(recorderId), orgId },
    );
    await runtime.execute(
      'meetings.summary.save',
      { meetingId: orgMeetingId, summary: 'Ket qua hop toan cong ty.', decisions: ['Trien khai OKR quy 4'] },
      { actor: asUser(recorderId), orgId },
    );
    await runtime.execute(
      'meetings.result.publish',
      { meetingId: orgMeetingId, confirmed: true },
      { actor: asUser(recorderId), orgId },
    );

    const { fileId: adminOrgPdf } = await ingestSignFile(asUser(adminId), orgId, `org-mtg-${randomUUID()}`);
    const { fileId: limitedPdf } = await ingestSignFile(asUser(entityLimitedMemberId), orgId, `lim-mtg-${randomUUID()}`);

    // Entity-limited member (le_scope without '*') cannot create an org-visible meeting_minutes envelope (404)!
    await expect(
      runtime.execute(
        'sign.envelope.create',
        {
          title: 'Entity-Limited Member Probe',
          sourceKind: 'meeting_minutes',
          sourceId: orgMeetingId,
          sourceFileId: limitedPdf,
        },
        { actor: asUser(entityLimitedMemberId), orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_SOURCE_NOT_FOUND', status: 404 });

    // A whole-org admin who is not the recorder is refused with SIGN_FORBIDDEN (403) (#4532: only the recorder starts a signature on the minutes); the recorder creates it. Whole-org outsiderMemberId,
    // ownerId and adminId CAN read it!
    await expect(
      runtime.execute(
        'sign.envelope.create',
        {
          title: 'Bien ban hop toan cong ty thang 11',
          sourceKind: 'meeting_minutes',
          sourceId: orgMeetingId,
          sourceFileId: adminOrgPdf,
        },
        { actor: asUser(adminId), orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_FORBIDDEN', status: 403 });
    const { fileId: recorderOrgPdf } = await ingestSignFile(asUser(recorderId), orgId, `org-mtg-rec-${randomUUID()}`);
    const orgEnvId = (
      await runtime.execute<{ envelopeId: string }>(
        'sign.envelope.create',
        {
          title: 'Bien ban hop toan cong ty thang 11',
          sourceKind: 'meeting_minutes',
          sourceId: orgMeetingId,
          sourceFileId: recorderOrgPdf,
        },
        { actor: asUser(recorderId), orgId },
      )
    ).envelopeId;
    const orgEnv = { envelopeId: orgEnvId };

    for (const wholeOrgReader of [ownerId, adminId, recorderId, outsiderMemberId]) {
      const got = await runtime.query<{ envelope: { id: string } }>(
        'sign.envelope.get',
        { envelopeId: orgEnv.envelopeId },
        { actor: asUser(wholeOrgReader), orgId },
      );
      expect(got.envelope.id).toBe(orgEnv.envelopeId);
    }

    // Entity-limited member and viewer get 404 on orgEnv!
    for (const blockedUser of [entityLimitedMemberId, viewerId]) {
      await expect(
        runtime.query('sign.envelope.get', { envelopeId: orgEnv.envelopeId }, { actor: asUser(blockedUser), orgId }),
      ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });
    }

    // Disabling 'meetings' app for the org blocks creating NEW meeting_minutes envelopes (404 SIGN_SOURCE_NOT_FOUND).
    await runtime.execute(
      'kernel.org.set_app',
      { module: 'meetings', enabled: false },
      { actor: asMfa(ownerId), orgId },
    );
    const { fileId: offPdf } = await ingestSignFile(asUser(ownerId), orgId, `off-mtg-${randomUUID()}`);
    await expect(
      runtime.execute(
        'sign.envelope.create',
        {
          title: 'Meetings App Disabled Probe',
          sourceKind: 'meeting_minutes',
          sourceId: orgMeetingId,
          sourceFileId: offPdf,
        },
        { actor: asUser(ownerId), orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_SOURCE_NOT_FOUND', status: 404 });
    await runtime.execute(
      'kernel.org.set_app',
      { module: 'meetings', enabled: true },
      { actor: asMfa(ownerId), orgId },
    );
  });

  it('voids and erases unsigned meeting_minutes envelopes on meeting deletion/purge while preserving completed legal records across all 4 delete paths (#4531)', async () => {
    const setupMeetingWithPair = async (opts: { visibility: 'attendees' | 'org'; extraReaders?: string[]; titleTag: string }) => {
      const { meetingId } = await runtime.execute<{ meetingId: string }>(
        'meetings.meeting.create',
        {
          title: `Lifecycle ${opts.titleTag}`,
          language: 'vi',
          visibility: opts.visibility,
          keepVideo: false,
          liveNotes: false,
          summaryTemplate: 'general',
          consentMethod: 'told_at_start',
        },
        { actor: asUser(recorderId), orgId },
      );
      for (const extraReaderId of opts.extraReaders ?? []) {
        await runtime.execute(
          'meetings.reader.add',
          { meetingId, userId: extraReaderId },
          { actor: asUser(recorderId), orgId },
        );
      }
      await runtime.execute(
        'meetings.summary.save',
        { meetingId, summary: `Noi dung hop ${opts.titleTag}.`, decisions: [`Quyet dinh ${opts.titleTag}`] },
        { actor: asUser(recorderId), orgId },
      );
      await runtime.execute(
        'meetings.result.publish',
        { meetingId, confirmed: true },
        { actor: asUser(recorderId), orgId },
      );

      // 1. Create, sign, and seal completed legal-record envelope.
      const { fileId: compPdf, sha256: compPdfSha } = await ingestSignFile(asUser(recorderId), orgId, `comp-${opts.titleTag}-${randomUUID()}`);
      const compEnv = await runtime.execute<{ envelopeId: string }>(
        'sign.envelope.create',
        {
          title: `Completed ${opts.titleTag}`,
          subject: `Subject Comp ${opts.titleTag}`,
          sourceKind: 'meeting_minutes',
          sourceId: meetingId,
          sourceFileId: compPdf,
        },
        { actor: asUser(recorderId), orgId },
      );
      await workerRuntime.execute(
        'sign.envelope.inspect_complete',
        {
          envelopeId: compEnv.envelopeId,
          outcome: 'passed',
          pageCount: 1,
          pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0 }],
        },
        { actor: asSystem('sign-pdf-inspect'), orgId },
      );
      const compSigner = await runtime.execute<{ signerId: string }>(
        'sign.signer.add',
        {
          envelopeId: compEnv.envelopeId,
          signerRole: 'signer',
          roleLabel: 'Nguoi ky',
          name: 'Completed Signer',
          email: 'comp-signer@example.com',
          deliveryMode: 'link',
        },
        { actor: asUser(recorderId), orgId },
      );
      const compFieldRes = await runtime.execute<{ fieldIds: string[] }>(
        'sign.field.set',
        {
          envelopeId: compEnv.envelopeId,
          fields: [{ signerId: compSigner.signerId, fieldType: 'signature', pageNumber: 1, xNorm: 0.1, yNorm: 0.7, wNorm: 0.25, hNorm: 0.08, required: true }],
        },
        { actor: asUser(recorderId), orgId },
      );
      const sentComp = await runtime.execute<{ links: Array<{ signerId: string; token: string }> }>(
        'sign.envelope.send',
        { envelopeId: compEnv.envelopeId },
        { actor: asUser(recorderId), orgId },
      );
      const compTokenSha = hashSigningToken(sentComp.links[0]!.token);
      await appPool!.query(
        `SELECT crove_sign.public_submit($1, true, 'draw', NULL, $2::jsonb, $3, 'LifecycleTest/1.0', $4)`,
        [
          compTokenSha,
          JSON.stringify([{ fieldId: compFieldRes.fieldIds[0]!, signaturePngBase64: VALID_PNG_BASE64 }]),
          ipHash,
          DEFAULT_MESSAGE_ID_DOMAIN,
        ],
      );
      const sealJob = await workerRuntime.query<{
        envelope: { completedAtIso: string | null };
        events: Array<{ event_hash: string }>;
      } | null>('sign.envelope.seal_job_data', { envelopeId: compEnv.envelopeId }, { actor: asSystem('sign-pdf-seal'), orgId });
      const { fileId: sealedFileId } = await ingestSignFile(asSystem('sign-pdf-seal'), orgId, `sealed-${opts.titleTag}-${randomUUID()}`, 'sign_sealed');
      const { fileId: certFileId } = await ingestSignFile(asSystem('sign-pdf-seal'), orgId, `cert-${opts.titleTag}-${randomUUID()}`, 'sign_certificate', 'application/json');
      await workerRuntime.execute(
        'sign.envelope.seal_complete',
        {
          envelopeId: compEnv.envelopeId,
          outcome: 'sealed',
          certificateCode: generateCertificateCode(
            compEnv.envelopeId,
            sealJob!.envelope.completedAtIso ?? new Date().toISOString(),
            sealJob!.events[sealJob!.events.length - 1]!.event_hash,
          ),
          sealedFileId,
          certificateFileId: certFileId,
        },
        { actor: asSystem('sign-pdf-seal'), orgId },
      );

      // 2. Create in-flight ('sent') unsigned envelope with signer, field, token, and summary.
      const { fileId: unsignedPdf } = await ingestSignFile(asUser(recorderId), orgId, `uns-${opts.titleTag}-${randomUUID()}`);
      const unsignedEnv = await runtime.execute<{ envelopeId: string }>(
        'sign.envelope.create',
        {
          title: `Unsigned Confidential Secret ${opts.titleTag}`,
          subject: `Unsigned Subject ${opts.titleTag}`,
          message: `Unsigned Message ${opts.titleTag}`,
          sourceKind: 'meeting_minutes',
          sourceId: meetingId,
          sourceFileId: unsignedPdf,
        },
        { actor: asUser(recorderId), orgId },
      );
      await workerRuntime.execute(
        'sign.envelope.inspect_complete',
        {
          envelopeId: unsignedEnv.envelopeId,
          outcome: 'passed',
          pageCount: 1,
          pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0 }],
        },
        { actor: asSystem('sign-pdf-inspect'), orgId },
      );
      const unsignedSigner = await runtime.execute<{ signerId: string }>(
        'sign.signer.add',
        {
          envelopeId: unsignedEnv.envelopeId,
          signerRole: 'signer',
          roleLabel: 'Nguoi ky nhap',
          name: `Secret Signer ${opts.titleTag}`,
          email: `uns-${opts.titleTag}@example.com`,
          deliveryMode: 'link',
          requireEmailOtp: false,
        },
        { actor: asUser(recorderId), orgId },
      );
      await runtime.execute(
        'sign.field.set',
        {
          envelopeId: unsignedEnv.envelopeId,
          fields: [{ signerId: unsignedSigner.signerId, fieldType: 'signature', pageNumber: 1, xNorm: 0.1, yNorm: 0.7, wNorm: 0.25, hNorm: 0.08, required: true }],
        },
        { actor: asUser(recorderId), orgId },
      );
      const sentUnsigned = await runtime.execute<{ links: Array<{ signerId: string; token: string }> }>(
        'sign.envelope.send',
        { envelopeId: unsignedEnv.envelopeId },
        { actor: asUser(recorderId), orgId },
      );
      const unsignedTokenSha = hashSigningToken(sentUnsigned.links[0]!.token);

      return {
        meetingId,
        compEnvId: compEnv.envelopeId,
        compPdf,
        compPdfSha,
        sealedFileId,
        certFileId,
        unsignedEnvId: unsignedEnv.envelopeId,
        unsignedPdf,
        unsignedTokenSha,
      };
    };

    const assertUnsignedErasedAndCompletedPreserved = async (
      fx: Awaited<ReturnType<typeof setupMeetingWithPair>>,
      allowedReaders: string[],
      deniedUsers: string[],
    ) => {
      // Unsigned envelope must be voided & scrubbed in DB, with zero signers/fields/tokens/otps and valid event chain.
      const envRow = await adminPool!.query<{
        status: string;
        void_reason: string | null;
        title: string;
        subject: string | null;
        message: string | null;
        shared_summary_json: unknown;
      }>(
        'SELECT status, void_reason, title, subject, message, shared_summary_json FROM crove_sign.envelope WHERE org_id = $1::uuid AND id = $2::uuid',
        [orgId, fx.unsignedEnvId],
      );
      expect(envRow.rows[0]).toEqual({
        status: 'voided',
        void_reason: 'meeting_deleted',
        title: '[Erased meeting minutes]',
        subject: null,
        message: null,
        shared_summary_json: null,
      });

      const signerCnt = await adminPool!.query<{ n: number }>('SELECT count(*)::int AS n FROM crove_sign.signer WHERE org_id = $1::uuid AND envelope_id = $2::uuid', [orgId, fx.unsignedEnvId]);
      const fieldCnt = await adminPool!.query<{ n: number }>('SELECT count(*)::int AS n FROM crove_sign.field WHERE org_id = $1::uuid AND envelope_id = $2::uuid', [orgId, fx.unsignedEnvId]);
      const tokenCnt = await adminPool!.query<{ n: number }>('SELECT count(*)::int AS n FROM crove_sign.signing_token WHERE org_id = $1::uuid AND envelope_id = $2::uuid', [orgId, fx.unsignedEnvId]);
      expect(signerCnt.rows[0]?.n).toBe(0);
      expect(fieldCnt.rows[0]?.n).toBe(0);
      expect(tokenCnt.rows[0]?.n).toBe(0);

      const unsignedEvents = await adminPool!.query<SigningEventChainRow>(
        'SELECT * FROM crove_sign.signing_event WHERE org_id = $1::uuid AND envelope_id = $2::uuid ORDER BY seq ASC',
        [orgId, fx.unsignedEnvId],
      );
      expect(verifyEventChain(unsignedEvents.rows)).toMatchObject({ valid: true });
      expect(unsignedEvents.rows.at(-1)?.event_type).toBe('envelope_voided');

      const pubRes = await appPool!.query<{ v: { state: string } | null }>(
        'SELECT crove_sign.public_record_view($1, $2, $3) AS v',
        [fx.unsignedTokenSha, ipHash, 'LifecycleTest/1.0'],
      );
      expect(pubRes.rows[0]?.v).toBeNull();

      // Unsigned envelope and its dedicated PDF are unreachable (404) for EVERYONE including creator & owner.
      for (const userId of [...allowedReaders, ...deniedUsers]) {
        await expect(
          runtime.query('sign.envelope.get', { envelopeId: fx.unsignedEnvId }, { actor: asUser(userId), orgId }),
        ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });
        await expect(
          runtime.query('kernel.file.get', { id: fx.unsignedPdf }, { actor: asUser(userId), orgId }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
      }

      // Completed legal-record envelope stays intact ('completed', 'sealed') and readable by allowed readers only!
      const compRow = await adminPool!.query<{ status: string; seal_status: string }>(
        'SELECT status, seal_status FROM crove_sign.envelope WHERE org_id = $1::uuid AND id = $2::uuid',
        [orgId, fx.compEnvId],
      );
      expect(compRow.rows[0]).toEqual({ status: 'completed', seal_status: 'sealed' });

      for (const readerId of allowedReaders) {
        const got = await runtime.query<{ envelope: { id: string; status: string } }>(
          'sign.envelope.get',
          { envelopeId: fx.compEnvId },
          { actor: asUser(readerId), orgId },
        );
        expect(got.envelope).toMatchObject({ id: fx.compEnvId, status: 'completed' });
        const gotSealed = await runtime.query<{ id: string }>(
          'kernel.file.get',
          { id: fx.sealedFileId },
          { actor: asUser(readerId), orgId },
        );
        expect(gotSealed.id).toBe(fx.sealedFileId);
      }

      for (const blockedId of deniedUsers) {
        await expect(
          runtime.query('sign.envelope.get', { envelopeId: fx.compEnvId }, { actor: asUser(blockedId), orgId }),
        ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });
        await expect(
          runtime.query('kernel.file.get', { id: fx.sealedFileId }, { actor: asUser(blockedId), orgId }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
      }
    };

    // Path 1: meetings.meeting.delete (attendees-only, outsiderMemberId shared as reader, owner/admin NOT shared).
    const fxDelete = await setupMeetingWithPair({ visibility: 'attendees', extraReaders: [outsiderMemberId], titleTag: 'del-path' });
    await runtime.execute('meetings.meeting.delete', { meetingId: fxDelete.meetingId }, { actor: asUser(recorderId), orgId });
    await assertUnsignedErasedAndCompletedPreserved(fxDelete, [recorderId, outsiderMemberId], [ownerId, adminId, entityLimitedMemberId, viewerId]);

    // Path 2: meetings.meeting.owner_delete (attendees-only where deleting owner is NOT a meeting reader!).
    const fxOwnerDel = await setupMeetingWithPair({ visibility: 'attendees', extraReaders: [outsiderMemberId], titleTag: 'owner-del-path' });
    await runtime.execute('meetings.meeting.owner_delete', { meetingId: fxOwnerDel.meetingId }, { actor: asMfa(ownerId), orgId });
    await assertUnsignedErasedAndCompletedPreserved(fxOwnerDel, [recorderId, outsiderMemberId], [ownerId, adminId, entityLimitedMemberId, viewerId]);

    // Path 3: meeting_text_purge (via meetings.retention.shred kind = 'text' on due org-visible meeting).
    const fxPurge = await setupMeetingWithPair({ visibility: 'org', titleTag: 'text-purge-path' });
    await adminPool!.query(
      `UPDATE crove_meetings.meeting
          SET text_retention_date = ((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - 1)
        WHERE org_id = $1::uuid AND id = $2::uuid`,
      [orgId, fxPurge.meetingId],
    );
    const purgeOut = await workerRuntime.execute<{ applied: boolean }>(
      'meetings.retention.shred',
      { meetingId: fxPurge.meetingId, kind: 'text' },
      { actor: asSystem('meetings.retention'), orgId },
    );
    expect(purgeOut.applied).toBe(true);
    await assertUnsignedErasedAndCompletedPreserved(fxPurge, [recorderId, ownerId, adminId, outsiderMemberId], [entityLimitedMemberId, viewerId]);

    // Path 4: meeting_replay_shred (via meetings.shred.replay on attendees-only meeting).
    const fxReplay = await setupMeetingWithPair({ visibility: 'attendees', extraReaders: [outsiderMemberId], titleTag: 'replay-shred-path' });
    const replayOut = await workerRuntime.execute<{ deleted: boolean }>(
      'meetings.shred.replay',
      { meetingId: fxReplay.meetingId },
      { actor: asSystem('meetings.retention'), orgId },
    );
    expect(replayOut.deleted).toBe(true);
    await assertUnsignedErasedAndCompletedPreserved(fxReplay, [recorderId, outsiderMemberId], [ownerId, adminId, entityLimitedMemberId, viewerId]);
  }, 120_000);
});
