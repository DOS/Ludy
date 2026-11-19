// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end PostgreSQL 17 security invariants for eSign Slice 3a (#3811, ADR-0047, ADR-0049, ADR-0053):
//   - Meeting minutes envelopes (source_kind = 'meeting_minutes') may be created ONLY when minutes are explicitly shared
//     (409 SIGN_MINUTES_NOT_SHARED for meeting readers on private drafts; 404 SIGN_SOURCE_NOT_FOUND for non-readers)
//   - On an attendees-only meeting, EVEN workspace owners and admins who are not meeting readers receive identical 404
//     across list, by_source, get, events, verify, ai_analysis, mutations, template.create, and kernel.file.get
//   - Identical enforcement whether AI is enabled or stopped, zero visibility to agent contexts, full public signing
//     ceremony + worker sealing compatibility, dynamic reader revocation, creator retention, and org-visible / le_scope rules
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import {
  DEFAULT_MESSAGE_ID_DOMAIN,
  createOrg,
  kernelCommands,
  kernelQueries,
  upsertIdentity,
} from '@crove/kernel';
import { contentGeneration, fileKey, Runtime, sha256Hex } from '@crove/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@crove/mod-meetings';
import {
  generateCertificateCode,
  generateRawSigningToken,
  hashSigningToken,
  signAiCommands,
  signAiQueries,
  signCommands,
  signQueries,
} from '@crove/mod-sign';
import { contextToken } from './fixtures/context-token.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

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
    await setRolePasswords(adminUrl, { crove_app: 'mtg-inv-app-pw', crove_worker: 'mtg-inv-worker-pw' });

    const loginUrl = (user: string, pw: string) => {
      const u = new URL(adminUrl);
      u.username = user;
      u.password = pw;
      return u.toString();
    };

    adminPool = createPool({ connectionString: adminUrl, max: 2 });
    appPool = createPool({ connectionString: loginUrl('crove_app', 'mtg-inv-app-pw'), max: 6 });
    workerPool = createPool({ connectionString: loginUrl('crove_worker', 'mtg-inv-worker-pw'), max: 3 });

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

    const attTplEnv = await runtime.execute<{ envelopeId: string }>(
      'sign.template.instantiate',
      {
        templateId: tpl.templateId,
        title: 'Bien ban xac nhan cua Attendee',
        sourceKind: 'meeting_minutes',
        sourceId: attendeesMeetingId,
        recipients: [{ roleKey: 'attendee', name: 'Attendee', email: 'attendee@mtg-inv.test', deliveryMode: 'email' }],
      },
      { actor: asUser(attendeeId), orgId },
    );

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
        ],
      },
      { actor: asUser(recorderId), orgId },
    );
    const sigFieldId = setFields.fieldIds[0]!;

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
    }

    // Permitted attendee CAN rotate link on active meeting_minutes envelope.
    const rotated = await runtime.execute<{ token: string }>(
      'sign.signer.create_link',
      { envelopeId: recEnv.envelopeId, signerId: addedSigner.signerId },
      { actor: asUser(attendeeId), orgId },
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

    const submitted = await appPool!.query<{ v: { status: string; completed?: boolean; envelopeStatus?: string } }>(
      `SELECT crove_sign.public_submit($1, true, 'draw', NULL, $2::jsonb, $3, 'AttendeeBrowser/1.0', $4) AS v`,
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

    // System sweep & cleanup commands continue to run cleanly with meeting_minutes rows present.
    await workerRuntime.execute('sign.envelope.expire_sweep', {}, { actor: asSystem('sign-expire-sweep'), orgId });
    await workerRuntime.execute('sign.org.cleanup', {}, { actor: asSystem('sign-cleanup'), orgId });

    // Public verification by certificateCode + sha256 works without leaking text.
    const pubVerify = await appPool!.query<{ res: { matched: boolean; envelopeStatus?: string } }>(
      'SELECT crove_sign.public_verify_certificate($1::text, $2::text) AS res',
      [certCode, sealedSha],
    );
    expect(pubVerify.rows[0]?.res).toMatchObject({ matched: true, envelopeStatus: 'completed' });

    // Recorder and Attendee CAN download sealed PDF and certificate JSON, while non-reader Owner and Admin get 404!
    for (const readerId of [recorderId, attendeeId]) {
      for (const fid of [recPdf, sealedFileId, certFileId]) {
        const meta = await runtime.query<{ id: string }>('kernel.file.get', { id: fid }, { actor: asUser(readerId), orgId });
        expect(meta.id).toBe(fid);
      }
    }
    for (const nonReaderId of [ownerId, adminId, outsiderMemberId, viewerId]) {
      for (const fid of [recPdf, sealedFileId, certFileId]) {
        await expect(
          runtime.query('kernel.file.get', { id: fid }, { actor: asUser(nonReaderId), orgId }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
      }
    }

    // 6. Direct SQL RLS + SECURITY DEFINER checks under crove_app (non-reader owner & agent context)!
    const appClient = await appPool!.connect();
    try {
      await appClient.query('BEGIN');
      await appClient.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [
        orgId,
        contextToken(ownerId, orgId),
      ]);

      for (const table of ['envelope', 'signer', 'field', 'ai_analysis', 'signing_event'] as const) {
        const idCol = table === 'envelope' ? 'id' : 'envelope_id';
        const { rowCount } = await appClient.query(
          `SELECT 1 FROM crove_sign.${table} WHERE org_id = $1::uuid AND ${idCol} = $2::uuid`,
          [orgId, recEnv.envelopeId],
        );
        expect(rowCount, `non-reader owner SELECT on crove_sign.${table}`).toBe(0);
      }

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
      const canRead = await workerClient.query<{ ok: boolean }>(
        'SELECT crove_sign.can_read_sign_file($1::uuid) AS ok',
        [sealedFileId],
      );
      expect(canRead.rows[0]?.ok).toBe(false);
    } finally {
      await workerClient.query('ROLLBACK').catch(() => {});
      workerClient.release();
    }

    // 7. Dynamic reader revocation, retention expiry, creator retention, and tenant_member removal!
    await runtime.execute(
      'meetings.reader.remove',
      { meetingId: attendeesMeetingId, userId: attendeeId },
      { actor: asUser(recorderId), orgId },
    );
    // Attendee removed from meeting_reader immediately loses access to recEnv (created by recorderId),
    // while retaining access to attTplEnv (where attendeeId IS created_by)!
    await expect(
      runtime.query('sign.envelope.get', { envelopeId: recEnv.envelopeId }, { actor: asUser(attendeeId), orgId }),
    ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });
    const ownAttEnv = await runtime.query<{ envelope: { id: string } }>(
      'sign.envelope.get',
      { envelopeId: attTplEnv.envelopeId },
      { actor: asUser(attendeeId), orgId },
    );
    expect(ownAttEnv.envelope.id).toBe(attTplEnv.envelopeId);

    // Re-add attendee, then expire text_retention_date: attendee loses access via meeting reader check and no new envelope can be created,
    // while recorder (created_by) STILL retains access to recEnv until removed from tenant_member!
    await runtime.execute(
      'meetings.reader.add',
      { meetingId: attendeesMeetingId, userId: attendeeId },
      { actor: asUser(recorderId), orgId },
    );
    await adminPool!.query(
      `UPDATE crove_meetings.meeting
          SET text_retention_date = ((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - 1)
        WHERE org_id = $1::uuid AND id = $2::uuid`,
      [orgId, attendeesMeetingId],
    );
    await expect(
      runtime.query('sign.envelope.get', { envelopeId: recEnv.envelopeId }, { actor: asUser(attendeeId), orgId }),
    ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });
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

    const creatorStillReads = await runtime.query<{ envelope: { id: string } }>(
      'sign.envelope.get',
      { envelopeId: recEnv.envelopeId },
      { actor: asUser(recorderId), orgId },
    );
    expect(creatorStillReads.envelope.id).toBe(recEnv.envelopeId);

    // Removing creator from tenant_member revokes SQL RLS & file access immediately.
    await adminPool!.query(
      'DELETE FROM crove_kernel.tenant_member WHERE org_id = $1::uuid AND user_id = $2::uuid',
      [orgId, attendeeId],
    );
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

    // Whole-org admin CAN create and whole-org outsiderMemberId + ownerId CAN read!
    const orgEnv = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      {
        title: 'Bien ban hop toan cong ty thang 11',
        sourceKind: 'meeting_minutes',
        sourceId: orgMeetingId,
        sourceFileId: adminOrgPdf,
      },
      { actor: asUser(adminId), orgId },
    );

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
});
