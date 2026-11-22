// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for strict HR contract envelope confidentiality helpers and query/command guards (#3553, A4).
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
  applyEnvelopeVisibilityFilter,
  assertCanAccessEnvelopeRow,
  assertCanCreateEnvelopeForSource,
  canAccessEnvelopeRow,
} from '../src/hr-visibility.ts';
import { envelopeBySource, envelopeEvents, envelopeGet, envelopeList, envelopeVerify } from '../src/queries.ts';
import { templateCreate, templateInstantiate } from '../src/templates.ts';

const ORG_ID = '01900000-0000-7000-8000-000000000010';
const OWNER_ID = '01900000-0000-7000-8000-000000000011';
const ADMIN_ID = '01900000-0000-7000-8000-000000000012';
const CREATOR_ID = '01900000-0000-7000-8000-000000000013';
const MEMBER_ID = '01900000-0000-7000-8000-000000000014';
const VIEWER_ID = '01900000-0000-7000-8000-000000000015';
const ENV_HR = '01900000-0000-7000-8000-000000000101';
const CONTRACT_ID = '01900000-0000-7000-8000-000000000201';
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
    actor: { type: 'user', userId, aal: 'aal1', sessionId: 'sess-hr' },
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
    now: new Date('2026-11-17T08:00:00.000Z'),
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

describe('hr-visibility helpers and @ludy/mod-sign HR contract guards (#3553)', () => {
  it('allows owner, admin, creator, and system for hr_contract rows while rejecting other members, viewers, and agents', () => {
    const hrRow = { source_kind: 'hr_contract' as const, created_by: CREATOR_ID };
    const quoteRow = { source_kind: 'crm_quote' as const, created_by: OWNER_ID };

    expect(canAccessEnvelopeRow({ actor: { type: 'system', component: 'seal' }, role: null }, hrRow)).toBe(true);
    expect(canAccessEnvelopeRow({ actor: { type: 'user', userId: OWNER_ID, aal: 'aal1' }, role: 'owner' }, hrRow)).toBe(true);
    expect(canAccessEnvelopeRow({ actor: { type: 'user', userId: ADMIN_ID, aal: 'aal1' }, role: 'admin' }, hrRow)).toBe(true);
    expect(canAccessEnvelopeRow({ actor: { type: 'user', userId: CREATOR_ID, aal: 'aal1' }, role: 'member' }, hrRow)).toBe(true);

    expect(canAccessEnvelopeRow({ actor: { type: 'user', userId: MEMBER_ID, aal: 'aal1' }, role: 'member' }, hrRow)).toBe(false);
    expect(canAccessEnvelopeRow({ actor: { type: 'user', userId: VIEWER_ID, aal: 'aal1' }, role: 'viewer' }, hrRow)).toBe(false);
    expect(
      canAccessEnvelopeRow(
        { actor: { type: 'agent', agentId: '01900000-0000-7000-8000-000000000099' } as QueryContext['actor'], role: null },
        hrRow,
      ),
    ).toBe(false);

    // Non-HR rows remain visible to ordinary members and viewers.
    expect(canAccessEnvelopeRow({ actor: { type: 'user', userId: MEMBER_ID, aal: 'aal1' }, role: 'member' }, quoteRow)).toBe(true);
    expect(canAccessEnvelopeRow({ actor: { type: 'user', userId: VIEWER_ID, aal: 'aal1' }, role: 'viewer' }, quoteRow)).toBe(true);

    expect(() =>
      assertCanAccessEnvelopeRow({ actor: { type: 'user', userId: MEMBER_ID, aal: 'aal1' }, role: 'member' }, hrRow),
    ).toThrowError(/Envelope not found/);

    expect(() =>
      assertCanCreateEnvelopeForSource({ actor: { type: 'user', userId: MEMBER_ID, aal: 'aal1' }, role: 'member' }, 'hr_contract'),
    ).toThrowError(/owners and admins/);
    expect(() =>
      assertCanCreateEnvelopeForSource({ actor: { type: 'user', userId: ADMIN_ID, aal: 'aal1' }, role: 'admin' }, 'hr_contract'),
    ).not.toThrow();
  });

  it('adds SQL visibility predicates for member/viewer list and by_source queries while leaving owner/admin unfiltered', async () => {
    const { trx, queries } = createFakeTrx(() => ({ rows: [] }));

    await envelopeList.handler(makeUserQueryCtx(trx, MEMBER_ID, 'member'), { limit: 20 });
    expect(queries[0]!.sql).toContain('"source_kind" != $');
    expect(queries[0]!.sql).toContain('"created_by" = $');
    expect(queries[0]!.parameters).toContain('hr_contract');
    expect(queries[0]!.parameters).toContain(MEMBER_ID);

    queries.length = 0;
    await envelopeList.handler(makeUserQueryCtx(trx, ADMIN_ID, 'admin'), { limit: 20 });
    expect(queries[0]!.parameters).not.toContain('hr_contract');

    queries.length = 0;
    await envelopeBySource.handler(makeUserQueryCtx(trx, MEMBER_ID, 'member'), {
      sourceKind: 'hr_contract',
      sourceIds: [CONTRACT_ID],
    });
    expect(queries[0]!.sql).toContain('"created_by" = $');
    expect(queries[0]!.parameters).toContain(MEMBER_ID);

    // Pure query builder filter for agent actor excludes hr_contract entirely.
    const agentQuery = applyEnvelopeVisibilityFilter(
      trx.selectFrom('crove_sign.envelope').select('id'),
      { actor: { type: 'agent', agentId: MEMBER_ID } as QueryContext['actor'], role: null },
    ).compile();
    expect(agentQuery.sql).toContain('"source_kind" != $1');
    expect(agentQuery.parameters).toEqual(['hr_contract']);
  });

  it('returns identical 404 SIGN_ENVELOPE_NOT_FOUND on get/events/verify and blocks member creation or HR template cloning', async () => {
    const { trx } = createFakeTrx((compiled) => {
      if (compiled.sql.includes('"crove_sign"."envelope"')) {
        return {
          rows: [
            {
              id: ENV_HR,
              org_id: ORG_ID,
              title: 'Confidential HR Contract',
              status: 'draft',
              routing_mode: 'parallel',
              source_kind: 'hr_contract',
              source_id: CONTRACT_ID,
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
              created_by: OWNER_ID,
              created_at: new Date('2026-11-17T08:00:00.000Z'),
              updated_at: new Date('2026-11-17T08:00:00.000Z'),
              version: 1,
            },
          ],
        };
      }
      return { rows: [] };
    });

    const memberQ = makeUserQueryCtx(trx, MEMBER_ID, 'member');
    await expect(envelopeGet.handler(memberQ, { envelopeId: ENV_HR })).rejects.toMatchObject({
      code: 'SIGN_ENVELOPE_NOT_FOUND',
      status: 404,
    });
    await expect(envelopeEvents.handler(memberQ, { envelopeId: ENV_HR })).rejects.toMatchObject({
      code: 'SIGN_ENVELOPE_NOT_FOUND',
      status: 404,
    });
    await expect(envelopeVerify.handler(memberQ, { envelopeId: ENV_HR })).rejects.toMatchObject({
      code: 'SIGN_ENVELOPE_NOT_FOUND',
      status: 404,
    });

    const memberCmd = makeUserCommandCtx(trx, MEMBER_ID, 'member');
    await expect(
      envelopeCreate.handler(memberCmd, {
        title: 'Blocked HR Contract',
        routingMode: 'parallel',
        sourceKind: 'hr_contract',
        sourceId: CONTRACT_ID,
        sourceFileId: FILE_ID,
      }),
    ).rejects.toMatchObject({ code: 'SIGN_FORBIDDEN', status: 403 });

    await expect(
      templateInstantiate.handler(memberCmd, {
        templateId: TPL_ID,
        sourceKind: 'hr_contract',
        sourceId: CONTRACT_ID,
        autoSend: false,
        recipients: [],
      }),
    ).rejects.toMatchObject({ code: 'SIGN_FORBIDDEN', status: 403 });

    await expect(
      templateCreate.handler(memberCmd, {
        title: 'Unauthorized Clone',
        sourceEnvelopeId: ENV_HR,
        copyRolesAndFields: true,
      }),
    ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });

    const ownerCmd = makeUserCommandCtx(trx, OWNER_ID, 'owner');
    await expect(
      templateCreate.handler(ownerCmd, {
        title: 'Accidental Org Template from HR Contract',
        sourceEnvelopeId: ENV_HR,
        copyRolesAndFields: true,
      }),
    ).rejects.toMatchObject({ code: 'SIGN_FORBIDDEN', status: 403 });
  });
});
