// SPDX-License-Identifier: AGPL-3.0-only
// PostgreSQL 17 invariants for the server-side binding of a meeting-minutes eSign envelope to the minutes (#4532, review-followup of #4157; docs/plan/esign.md Slice 3a, ADR-0047):
//   - Only the meeting's recorder, an org owner or an admin creates a meeting-minutes envelope (sign.envelope.create, sign.template.instantiate and the RLS insert path; owner decision on #4530):
//     a plain reader of the shared minutes is refused (403) and a direct INSERT of one is refused by the meeting_minutes_insert policy.
//   - source_revision (a sha256 of the published minutes) is the database's: whatever an insert says is replaced, a non-minutes envelope never has one, it cannot change afterwards.
//   - sign.envelope.by_source says `stale` from that revision (the title is not read) and sign.envelope.send refuses a stale envelope with 409 SIGN_MINUTES_CHANGED.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { contentGeneration, fileKey, Runtime, sha256Hex } from '@ludy/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import { signAiCommands, signAiQueries, signCommands, signQueries } from '@ludy/mod-sign';
import { contextToken } from './fixtures/context-token.ts';
import { createDbPool, resolveDbIdentifiers, setActiveRolePasswords } from './fixtures/db-identifiers.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

type Pool = ReturnType<typeof createPool>;

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('eSign meeting minutes are bound to the minutes by the server (#4532)', () => {
  const dbName = `crove_test_sign_mtg_rev_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminPool: Pool | undefined;
  let appPool: Pool | undefined;
  let runtime: Runtime;

  let orgId = '';
  let ownerId = '';
  let recorderId = '';
  let attendeeId = '';

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function ingestPdf(userId: string, tag: string): Promise<string> {
    const bytes = Uint8Array.from(Buffer.from(`%PDF-1.4\n% mtg-rev-${tag}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n`, 'utf8'));
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
      { actor: asUser(userId), orgId },
    );
    return fileId;
  }

  // The recorder's meeting with its minutes shared: an org-visible meeting, so the owner and the attendee read it too.
  async function sharedMeeting(summary: string): Promise<string> {
    const { meetingId } = await runtime.execute<{ meetingId: string }>(
      'meetings.meeting.create',
      {
        title: `Hop ${randomUUID().slice(0, 8)}`,
        language: 'vi',
        visibility: 'org',
        keepVideo: false,
        liveNotes: false,
        summaryTemplate: 'general',
        consentMethod: 'told_at_start',
        readerUserIds: [attendeeId],
      },
      { actor: asUser(recorderId), orgId },
    );
    await publishSummary(meetingId, summary);
    return meetingId;
  }

  async function publishSummary(meetingId: string, summary: string): Promise<void> {
    await runtime.execute('meetings.summary.save', { meetingId, summary, decisions: ['Da chot'] }, { actor: asUser(recorderId), orgId });
    await runtime.execute('meetings.result.publish', { meetingId, confirmed: true }, { actor: asUser(recorderId), orgId });
  }

  const create = (userId: string, meetingId: string, fileId: string) =>
    runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      { title: 'Bien ban', sourceKind: 'meeting_minutes', sourceId: meetingId, sourceFileId: fileId },
      { actor: asUser(userId), orgId },
    );

  const bySource = async (userId: string, meetingId: string) =>
    (
      await runtime.query<{ items: Array<{ envelopeId: string; stale?: boolean }> }>(
        'sign.envelope.by_source',
        { sourceKind: 'meeting_minutes', sourceIds: [meetingId] },
        { actor: asUser(userId), orgId },
      )
    ).items;

  const storedRevision = async (envelopeId: string): Promise<string | null> =>
    (await adminPool!.query<{ r: string | null }>('SELECT source_revision AS r FROM crove_sign.envelope WHERE org_id = $1::uuid AND id = $2::uuid', [orgId, envelopeId])).rows[0]!.r;

  const currentRevision = async (meetingId: string): Promise<string | null> =>
    (await adminPool!.query<{ r: string | null }>('SELECT crove_sign.meeting_minutes_revision_raw($1::uuid, $2::uuid) AS r', [orgId, meetingId])).rows[0]!.r;

  beforeAll(async () => {
    const rootPool = createPool({ connectionString: ADMIN as string, max: 1 });
    await rootPool.query(`CREATE DATABASE ${dbName}`);
    await rootPool.end();

    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    const adminUrl = base.toString();

    await migrate({ adminUrl, dir: MIGRATIONS });
    const ids = await resolveDbIdentifiers(adminUrl);
    await setActiveRolePasswords(adminUrl, { crove_app: 'mtg-rev-app-pw' }, ids);

    const loginUrl = new URL(adminUrl);
    loginUrl.username = 'crove_app';
    loginUrl.password = 'mtg-rev-app-pw';

    adminPool = createDbPool({ connectionString: adminUrl, max: 2 }, ids);
    appPool = createDbPool({ connectionString: loginUrl.toString(), max: 4 }, ids);
    const appDb = createDb(appPool);

    runtime = new Runtime(appDb, { manifests: TEST_MANIFESTS })
      .register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) })
      .register({ commands: meetingsCommands, queries: meetingsQueries })
      .register({ commands: [...signCommands, ...signAiCommands], queries: [...signQueries, ...signAiQueries] });

    ownerId = await upsertIdentity(appDb, { issuer: 'mtg-rev', subject: 'owner', email: 'owner@mtg-rev.test', name: 'Owner' });
    recorderId = await upsertIdentity(appDb, { issuer: 'mtg-rev', subject: 'recorder', email: 'recorder@mtg-rev.test', name: 'Recorder' });
    attendeeId = await upsertIdentity(appDb, { issuer: 'mtg-rev', subject: 'attendee', email: 'attendee@mtg-rev.test', name: 'Attendee' });
    orgId = (await createOrg(runtime, asUser(ownerId), 'Cong ty TNHH Bien Ban')).orgId;
    await adminPool.query(
      `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1::uuid, $2::uuid, 'member'), ($1::uuid, $3::uuid, 'member')`,
      [orgId, recorderId, attendeeId],
    );
  }, 120_000);

  afterAll(async () => {
    await appPool?.end();
    await adminPool?.end();
    if (!ADMIN) return;
    const rootPool = createPool({ connectionString: ADMIN, max: 1 });
    await rootPool.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await rootPool.end();
  });

  it('lets only the recorder, an owner or an admin create it: a plain reader of the shared minutes is refused by the command and by the insert policy', async () => {
    const meetingId = await sharedMeeting('Noi dung hop chinh thuc.');
    const attendeeFile = await ingestPdf(attendeeId, `att-${randomUUID()}`);
    const ownerFile = await ingestPdf(ownerId, `own-${randomUUID()}`);

    // The attendee reads the shared minutes (not refused as a stranger, 404) and is refused as a creator (403); the org owner, who reads the org-visible meeting, may create one.
    await expect(create(attendeeId, meetingId, attendeeFile)).rejects.toMatchObject({ code: 'SIGN_FORBIDDEN', status: 403 });
    const ownerMade = await create(ownerId, meetingId, ownerFile);
    expect(await storedRevision(ownerMade.envelopeId)).toBe(await currentRevision(meetingId));

    // The same refusal on the direct INSERT path (RLS): an attendee's own row for the shared minutes is not allowed.
    const client = await appPool!.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(attendeeId, orgId)]);
      await expect(
        client.query(
          `INSERT INTO crove_sign.envelope (
             org_id, title, status, routing_mode, source_kind, source_id,
             source_file_id, source_storage_key, source_generation, source_sha256,
             inspect_status, created_by
           )
           SELECT $1::uuid, 'SQL Probe', 'draft', 'parallel', 'meeting_minutes', $2::uuid,
                  f.id, f.storage_key, f.generation, f.sha256, 'pending', $3::uuid
           FROM crove_kernel.file f WHERE f.org_id = $1::uuid AND f.id = $4::uuid`,
          [orgId, meetingId, attendeeId, attendeeFile],
        ),
      ).rejects.toThrow(/row-level security policy/);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }

    // The recorder creates it, and it carries the revision of the minutes as published.
    const recorderFile = await ingestPdf(recorderId, `rec-${randomUUID()}`);
    const made = await create(recorderId, meetingId, recorderFile);
    const revision = await currentRevision(meetingId);
    expect(revision).toMatch(/^[0-9a-f]{64}$/);
    expect(await storedRevision(made.envelopeId)).toBe(revision);
  });

  it('keeps the revision the database computed whatever the insert says, gives none to another source kind, and lets it never change', async () => {
    const meetingId = await sharedMeeting('Noi dung hop de kiem tra.');
    const fileId = await ingestPdf(recorderId, `forged-${randomUUID()}`);
    const revision = await currentRevision(meetingId);

    const insert = async (kind: string, sourceId: string | null) => {
      const id = randomUUID();
      const res = await adminPool!.query(
        `INSERT INTO crove_sign.envelope (
           org_id, id, title, status, routing_mode, source_kind, source_id,
           source_file_id, source_storage_key, source_generation, source_sha256,
           inspect_status, created_by, source_revision
         )
         SELECT $1::uuid, $2::uuid, 'Forged', 'draft', 'parallel', $3, $4::uuid,
                f.id, f.storage_key, f.generation, f.sha256, 'pending', $5::uuid, repeat('f', 64)
         FROM crove_kernel.file f WHERE f.org_id = $1::uuid AND f.id = $6::uuid`,
        [orgId, id, kind, sourceId, recorderId, fileId],
      );
      expect(res.rowCount).toBe(1);
      return id;
    };
    // A client-supplied value is replaced for a meeting-minutes row and dropped for any other row.
    expect(await storedRevision(await insert('meeting_minutes', meetingId))).toBe(revision);
    expect(await storedRevision(await insert('standalone', null))).toBeNull();

    const made = await create(recorderId, meetingId, await ingestPdf(recorderId, `mine-${randomUUID()}`));
    await expect(
      adminPool!.query(`UPDATE crove_sign.envelope SET source_revision = repeat('0', 64) WHERE org_id = $1::uuid AND id = $2::uuid`, [orgId, made.envelopeId]),
    ).rejects.toThrow(/ENVELOPE_IMMUTABLE/);
    expect(await storedRevision(made.envelopeId)).toBe(revision);
  });

  it('says stale from the stored revision once the minutes change, shows the new envelope first, and refuses to send the stale one', async () => {
    const meetingId = await sharedMeeting('Phien ban dau tien cua bien ban.');
    const first = await create(recorderId, meetingId, await ingestPdf(recorderId, `first-${randomUUID()}`));
    expect((await bySource(attendeeId, meetingId)).map((i) => [i.envelopeId, i.stale])).toEqual([[first.envelopeId, false]]);

    // The current envelope passes the revision gate (it stops later, at the checks of a draft that is not ready), the changed minutes do not.
    await expect(runtime.execute('sign.envelope.send', { envelopeId: first.envelopeId }, { actor: asUser(recorderId), orgId })).rejects.not.toMatchObject({ code: 'SIGN_MINUTES_CHANGED' });

    await publishSummary(meetingId, 'Phien ban da sua cua bien ban.');
    expect(await currentRevision(meetingId)).not.toBe(await storedRevision(first.envelopeId));
    expect((await bySource(recorderId, meetingId)).map((i) => [i.envelopeId, i.stale])).toEqual([[first.envelopeId, true]]);
    await expect(runtime.execute('sign.envelope.send', { envelopeId: first.envelopeId }, { actor: asUser(recorderId), orgId })).rejects.toMatchObject({ code: 'SIGN_MINUTES_CHANGED', status: 409 });

    // A new envelope for the changed minutes is current and is the one shown; the stale one is no longer offered over it.
    const second = await create(recorderId, meetingId, await ingestPdf(recorderId, `second-${randomUUID()}`));
    expect((await bySource(attendeeId, meetingId)).map((i) => [i.envelopeId, i.stale])).toEqual([[second.envelopeId, false]]);
    expect(await storedRevision(second.envelopeId)).toBe(await currentRevision(meetingId));
  });
});
