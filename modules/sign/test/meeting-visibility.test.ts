// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for strict meeting-minutes envelope confidentiality helpers and query/command guards (#3811, Slice 3a).
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
  type Transaction,
} from 'kysely';
import { describe, expect, it } from 'vitest';
import type { Database, MemberRole } from '@ludy/db';
import type { CommandContext, QueryContext } from '@ludy/kernel-runtime';
import { envelopeCreate } from '../src/commands.ts';
import {
  applyMeetingMinutesVisibilityFilter,
  assertCanAccessMeetingMinutesEnvelopeRow,
  assertCanCreateMeetingMinutesEnvelope,
  assertMeetingMinutesCurrent,
  canAccessMeetingMinutesEnvelopeRow,
  isMinutesEnvelopeStale,
} from '../src/meeting-visibility.ts';
import {
  envelopeBySource,
  envelopeEvents,
  envelopeGet,
  envelopeList,
  envelopeVerify,
  selectLatestEnvelopesBySource,
  type SourceEnvelopeCandidate,
} from '../src/queries.ts';
import { templateCreate, templateInstantiate } from '../src/templates.ts';

const ORG_ID = '01900000-0000-7000-8000-000000000010';
const OWNER_ID = '01900000-0000-7000-8000-000000000011';
const ADMIN_ID = '01900000-0000-7000-8000-000000000012';
const RECORDER_ID = '01900000-0000-7000-8000-000000000013';
const ATTENDEE_ID = '01900000-0000-7000-8000-000000000014';
const ENV_MTG = '01900000-0000-7000-8000-000000000101';
const MEETING_ID = '01900000-0000-7000-8000-000000000201';
const FILE_ID = '01900000-0000-7000-8000-000000000301';
const TPL_ID = '01900000-0000-7000-8000-000000000401';

function createFakeTrx(
  onQuery: (compiled: CompiledQuery) => QueryResult<Record<string, unknown>>,
): { trx: Transaction<Database>; queries: CompiledQuery[] } {
  const queries: CompiledQuery[] = [];
  const conn: DatabaseConnection = {
    executeQuery: async <R>(compiled: CompiledQuery): Promise<QueryResult<R>> => {
      queries.push(compiled);
      return onQuery(compiled) as QueryResult<R>;
    },
    streamQuery: (() => {
      throw new Error('streamQuery not implemented');
    }) as DatabaseConnection['streamQuery'],
  };
  const driver: Driver = {
    init: async () => {},
    acquireConnection: async () => conn,
    beginTransaction: async () => {},
    commitTransaction: async () => {},
    rollbackTransaction: async () => {},
    releaseConnection: async () => {},
    destroy: async () => {},
  };
  const db = new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (inst) => new PostgresIntrospector(inst),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { trx: db as unknown as Transaction<Database>, queries };
}

function makeUserQueryCtx(trx: Transaction<Database>, userId: string, role: MemberRole): QueryContext {
  return {
    trx,
    orgId: ORG_ID,
    actor: { type: 'user', userId, aal: 'aal1', sessionId: 'sess-mtg' },
    role,
    query: async () => ({ status: 'not_installed', module: 'sign' }),
    reviserOf: () => null,
    agent: null,
    memberVy: null,
    installed: () => true,
    command: () => null,
    open: async () => '',
    openMany: async (items) => items.map(() => ''),
  };
}

function makeUserCommandCtx(trx: Transaction<Database>, userId: string, role: MemberRole): CommandContext {
  return {
    ...makeUserQueryCtx(trx, userId, role),
    commandId: '01900000-0000-7000-8000-000000000900',
    proposalId: null,
    now: new Date('2026-11-19T08:00:00.000Z'),
    build: 'test',
    emit: async () => '01900000-0000-7000-8000-000000000901',
    activity: async () => {},
    audit: () => {},
    permissionEntity: () => {},
    seal: async () => '',
    run: async () => ({}),
    tryRun: async () => ({ status: 'ok', result: {} }),
    defer: () => {},
  } as unknown as CommandContext;
}

describe('meeting-visibility helpers and @ludy/mod-sign meeting minutes guards (#3811)', () => {
  it('enforces check_meeting_minutes_source states (0 -> 404, 1 -> 409, 2 -> ok) and can_access_meeting_minutes_envelope', async () => {
    let sourceState = 0;
    let accessAllowed = false;
    let recorderAllowed = true;
    const { trx } = createFakeTrx((compiled) => {
      if (compiled.sql.includes('check_meeting_minutes_source')) {
        return { rows: [{ state: sourceState }] };
      }
      if (compiled.sql.includes('can_access_meeting_minutes_envelope')) {
        return { rows: [{ allowed: accessAllowed }] };
      }
      if (compiled.sql.includes('can_create_meeting_minutes_envelope')) {
        return { rows: [{ allowed: recorderAllowed }] };
      }
      return { rows: [] };
    });

    const ownerCtx = makeUserCommandCtx(trx, OWNER_ID, 'owner');
    await expect(
      assertCanCreateMeetingMinutesEnvelope(ownerCtx, 'meeting_minutes', MEETING_ID),
    ).rejects.toMatchObject({ code: 'SIGN_SOURCE_NOT_FOUND', status: 404 });

    sourceState = 1;
    await expect(
      assertCanCreateMeetingMinutesEnvelope(ownerCtx, 'meeting_minutes', MEETING_ID),
    ).rejects.toMatchObject({ code: 'SIGN_MINUTES_NOT_SHARED', status: 409 });

    sourceState = 2;
    await expect(assertCanCreateMeetingMinutesEnvelope(ownerCtx, 'meeting_minutes', MEETING_ID)).resolves.toBeUndefined();

    // Only the recorder creates it (#4532): a reader of shared minutes who is not the recorder, an owner and an admin included, is refused with 403.
    recorderAllowed = false;
    await expect(assertCanCreateMeetingMinutesEnvelope(ownerCtx, 'meeting_minutes', MEETING_ID)).rejects.toMatchObject({ code: 'SIGN_FORBIDDEN', status: 403 });
    await expect(
      assertCanCreateMeetingMinutesEnvelope(makeUserCommandCtx(trx, ATTENDEE_ID, 'member'), 'meeting_minutes', MEETING_ID),
    ).rejects.toMatchObject({ code: 'SIGN_FORBIDDEN', status: 403 });
    recorderAllowed = true;

    const draftMtgRow = {
      source_kind: 'meeting_minutes' as const,
      source_id: MEETING_ID,
      created_by: RECORDER_ID,
      status: 'draft' as const,
    };

    // System actors short-circuit true; agent actors always get false.
    expect(
      await canAccessMeetingMinutesEnvelopeRow(
        { trx, orgId: ORG_ID, actor: { type: 'system', component: 'seal' } },
        draftMtgRow,
      ),
    ).toBe(true);
    expect(
      await canAccessMeetingMinutesEnvelopeRow(
        { trx, orgId: ORG_ID, actor: { type: 'agent', agentId: OWNER_ID } as QueryContext['actor'] },
        draftMtgRow,
      ),
    ).toBe(false);

    // Unsigned envelopes NEVER short-circuit for created_by: SQL helper decides active reader scope!
    accessAllowed = false;
    expect(await canAccessMeetingMinutesEnvelopeRow(makeUserQueryCtx(trx, RECORDER_ID, 'member'), draftMtgRow)).toBe(false);

    // Non-reader owner gets false / 404 when SQL helper returns false!
    await expect(
      assertCanAccessMeetingMinutesEnvelopeRow(makeUserQueryCtx(trx, OWNER_ID, 'owner'), draftMtgRow),
    ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });

    // Permitted attendee (or completed record when SQL helper allows) gets true when SQL helper returns true.
    accessAllowed = true;
    await expect(
      assertCanAccessMeetingMinutesEnvelopeRow(makeUserQueryCtx(trx, ATTENDEE_ID, 'member'), draftMtgRow),
    ).resolves.toBeUndefined();
    expect(
      await canAccessMeetingMinutesEnvelopeRow(makeUserQueryCtx(trx, RECORDER_ID, 'member'), {
        ...draftMtgRow,
        status: 'completed',
      }),
    ).toBe(true);
  });

  it('adds SQL visibility predicates for list and by_source even for owners and admins, and excludes agents', async () => {
    const { trx, queries } = createFakeTrx(() => ({ rows: [] }));

    await envelopeList.handler(makeUserQueryCtx(trx, OWNER_ID, 'owner'), { limit: 20 });
    expect(queries[0]!.sql).toContain('can_access_meeting_minutes_envelope_row');
    expect(queries[0]!.parameters).toContain('meeting_minutes');

    queries.length = 0;
    await envelopeBySource.handler(makeUserQueryCtx(trx, ADMIN_ID, 'admin'), {
      sourceKind: 'meeting_minutes',
      sourceIds: [MEETING_ID],
    });
    expect(queries[0]!.sql).toContain('can_access_meeting_minutes_envelope_row');

    const agentQuery = applyMeetingMinutesVisibilityFilter(
      trx.selectFrom('ludy_sign.envelope').select('id'),
      { actor: { type: 'agent', agentId: OWNER_ID } as QueryContext['actor'] },
    ).compile();
    expect(agentQuery.sql).toContain('"source_kind" != $1');
    expect(agentQuery.parameters).toEqual(['meeting_minutes']);
  });

  it('returns identical 404 to non-reader owners on get/events/verify/template.create and blocks reader template cloning with 403', async () => {
    let sourceState = 1;
    let accessAllowed = false;
    const { trx } = createFakeTrx((compiled) => {
      if (compiled.sql.includes('check_meeting_minutes_source')) {
        return { rows: [{ state: sourceState }] };
      }
      if (compiled.sql.includes('can_access_meeting_minutes_envelope')) {
        return { rows: [{ allowed: accessAllowed }] };
      }
      if (compiled.sql.includes('"ludy_sign"."envelope"')) {
        return {
          rows: [
            {
              id: ENV_MTG,
              org_id: ORG_ID,
              title: 'Confidential Meeting Minutes',
              status: 'draft',
              routing_mode: 'parallel',
              source_kind: 'meeting_minutes',
              source_id: MEETING_ID,
              source_file_id: FILE_ID,
              source_storage_key: 'k',
              source_generation: 'content:1',
              source_sha256: 'a'.repeat(64),
              inspect_status: 'passed',
              page_count: 1,
              page_dimensions_json: [],
              seal_status: null,
              sealed_file_id: null,
              sealed_storage_key: null,
              sealed_generation: null,
              sealed_sha256: null,
              certificate_file_id: null,
              certificate_storage_key: null,
              certificate_generation: null,
              certificate_sha256: null,
              certificate_code: null,
              created_by: RECORDER_ID,
              created_at: new Date('2026-11-19T08:00:00.000Z'),
              updated_at: new Date('2026-11-19T08:00:00.000Z'),
              version: 1,
            },
          ],
        };
      }
      return { rows: [] };
    });

    const nonReaderOwnerQ = makeUserQueryCtx(trx, OWNER_ID, 'owner');
    await expect(envelopeGet.handler(nonReaderOwnerQ, { envelopeId: ENV_MTG })).rejects.toMatchObject({
      code: 'SIGN_ENVELOPE_NOT_FOUND',
      status: 404,
    });
    await expect(envelopeEvents.handler(nonReaderOwnerQ, { envelopeId: ENV_MTG })).rejects.toMatchObject({
      code: 'SIGN_ENVELOPE_NOT_FOUND',
      status: 404,
    });
    await expect(envelopeVerify.handler(nonReaderOwnerQ, { envelopeId: ENV_MTG })).rejects.toMatchObject({
      code: 'SIGN_ENVELOPE_NOT_FOUND',
      status: 404,
    });

    const recorderCmd = makeUserCommandCtx(trx, RECORDER_ID, 'member');
    await expect(
      envelopeCreate.handler(recorderCmd, {
        title: 'Unshared Draft Minutes',
        routingMode: 'parallel',
        sourceKind: 'meeting_minutes',
        sourceId: MEETING_ID,
        sourceFileId: FILE_ID,
      }),
    ).rejects.toMatchObject({ code: 'SIGN_MINUTES_NOT_SHARED', status: 409 });

    sourceState = 0;
    const nonReaderOwnerCmd = makeUserCommandCtx(trx, OWNER_ID, 'owner');
    await expect(
      templateInstantiate.handler(nonReaderOwnerCmd, {
        templateId: TPL_ID,
        sourceKind: 'meeting_minutes',
        sourceId: MEETING_ID,
        autoSend: false,
        recipients: [],
      }),
    ).rejects.toMatchObject({ code: 'SIGN_SOURCE_NOT_FOUND', status: 404 });

    await expect(
      templateCreate.handler(nonReaderOwnerCmd, {
        title: 'Owner Clone Attendees-Only Minutes',
        sourceEnvelopeId: ENV_MTG,
        copyRolesAndFields: true,
      }),
    ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });

    accessAllowed = true;
    await expect(
      templateCreate.handler(recorderCmd, {
        title: 'Recorder Clone Minutes Into Org Template',
        sourceEnvelopeId: ENV_MTG,
        copyRolesAndFields: true,
      }),
    ).rejects.toMatchObject({ code: 'SIGN_FORBIDDEN', status: 403 });
  });
});

// The minutes revision (#4532): the database stores a sha256 of the published minutes when it creates the envelope; the server compares it, the client's title hash is not read.
const REV_A = 'a'.repeat(64);
const REV_B = 'b'.repeat(64);

describe('a meeting-minutes envelope is tied to the minutes it was made for (#4532)', () => {
  it('is stale when it predates the revision or the minutes changed, and not when there is nothing to compare', () => {
    expect(isMinutesEnvelopeStale(REV_A, REV_A)).toBe(false);
    expect(isMinutesEnvelopeStale(REV_A, REV_B)).toBe(true);
    expect(isMinutesEnvelopeStale('legacy', REV_A)).toBe(true);
    expect(isMinutesEnvelopeStale(null, REV_A)).toBe(true);
    // The caller cannot read the minutes now (or none are shared): no current revision, so not reported stale.
    expect(isMinutesEnvelopeStale(REV_A, null)).toBe(false);
    expect(isMinutesEnvelopeStale('legacy', null)).toBe(false);
  });

  it('refuses to send an envelope for older, legacy or unshared minutes, and lets the current one and any other source through', async () => {
    let revision: string | null = REV_A;
    const { trx } = createFakeTrx((compiled) => {
      if (compiled.sql.includes('meeting_minutes_revision')) return { rows: [{ revision }] };
      return { rows: [] };
    });
    const row = (source_revision: string | null) => ({ source_kind: 'meeting_minutes', source_id: MEETING_ID, source_revision });
    await expect(assertMeetingMinutesCurrent({ trx }, row(REV_A))).resolves.toBeUndefined();
    await expect(assertMeetingMinutesCurrent({ trx }, row(REV_B))).rejects.toMatchObject({ code: 'SIGN_MINUTES_CHANGED', status: 409 });
    await expect(assertMeetingMinutesCurrent({ trx }, row('legacy'))).rejects.toMatchObject({ code: 'SIGN_MINUTES_CHANGED', status: 409 });
    revision = null;
    await expect(assertMeetingMinutesCurrent({ trx }, row(REV_A))).rejects.toMatchObject({ code: 'SIGN_MINUTES_CHANGED', status: 409 });
    await expect(assertMeetingMinutesCurrent({ trx }, { source_kind: 'meeting_minutes', source_id: null, source_revision: REV_A })).rejects.toMatchObject({ code: 'SIGN_MINUTES_CHANGED' });
    await expect(assertMeetingMinutesCurrent({ trx }, { source_kind: 'crm_quote', source_id: MEETING_ID, source_revision: null })).resolves.toBeUndefined();
  });

  const candidate = (id: string, status: SourceEnvelopeCandidate['status'], source_revision: string, createdAt: string): SourceEnvelopeCandidate => ({
    id,
    title: id,
    status,
    source_id: MEETING_ID,
    seal_status: null,
    certificate_code: null,
    completed_at: null,
    source_revision,
    created_at: createdAt,
    updated_at: createdAt,
  });
  const minutes = (current: string | null) => ({ currentRevisions: new Map([[MEETING_ID, current]]) });

  it('does not let a newer draft push a signed envelope of the current minutes off the meeting screen', () => {
    const signed = candidate('signed', 'completed', REV_A, '2026-11-19T08:00:00.000Z');
    const inFlight = candidate('in-flight', 'in_progress', REV_A, '2026-11-19T09:00:00.000Z');
    const newerDraft = candidate('draft', 'draft', REV_A, '2026-11-19T10:00:00.000Z');
    const voided = candidate('voided', 'voided', REV_A, '2026-11-19T11:00:00.000Z');
    const pick = (rows: SourceEnvelopeCandidate[]) => selectLatestEnvelopesBySource(rows, [MEETING_ID], minutes(REV_A)).map((r) => r.id);
    expect(pick([signed, newerDraft, voided])).toEqual(['signed']);
    expect(pick([newerDraft, inFlight, voided])).toEqual(['in-flight']);
    expect(pick([newerDraft, voided])).toEqual(['draft']);
    expect(pick([voided])).toEqual(['voided']);
    // Without the ranking (every other source kind) the newest non-voided wins as before.
    expect(selectLatestEnvelopesBySource([signed, newerDraft, voided], [MEETING_ID]).map((r) => r.id)).toEqual(['draft']);
  });

  it('shows an envelope for the current minutes before a replaced one for older minutes', () => {
    const oldSigned = candidate('old-signed', 'completed', REV_A, '2026-11-19T08:00:00.000Z');
    const freshDraft = candidate('fresh-draft', 'draft', REV_B, '2026-11-20T08:00:00.000Z');
    expect(selectLatestEnvelopesBySource([oldSigned, freshDraft], [MEETING_ID], minutes(REV_B)).map((r) => r.id)).toEqual(['fresh-draft']);
    // Nothing newer: the old signed one is still shown (as stale).
    expect(selectLatestEnvelopesBySource([oldSigned], [MEETING_ID], minutes(REV_B)).map((r) => r.id)).toEqual(['old-signed']);
    // A caller who cannot read the minutes has no current revision: nothing is stale, signed first.
    expect(selectLatestEnvelopesBySource([oldSigned, freshDraft], [MEETING_ID], minutes(null)).map((r) => r.id)).toEqual(['old-signed']);
  });

  it('keeps a signed envelope from before the revision (legacy) in view, as a legal record, and replaces an unsigned legacy one', () => {
    const legacySigned = candidate('legacy-signed', 'completed', 'legacy', '2026-11-19T08:00:00.000Z');
    const legacyDraft = candidate('legacy-draft', 'draft', 'legacy', '2026-11-19T08:00:00.000Z');
    const freshDraft = candidate('fresh-draft', 'draft', REV_B, '2026-11-20T08:00:00.000Z');
    expect(selectLatestEnvelopesBySource([legacySigned, freshDraft], [MEETING_ID], minutes(REV_B)).map((r) => r.id)).toEqual(['legacy-signed']);
    expect(selectLatestEnvelopesBySource([legacyDraft, freshDraft], [MEETING_ID], minutes(REV_B)).map((r) => r.id)).toEqual(['fresh-draft']);
  });
});
