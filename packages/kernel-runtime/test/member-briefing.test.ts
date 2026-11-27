// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for QueryDef.memberBriefing registration guards, facade shape, and pre-DB dispatch checks (#5080).
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Database, Db } from '@ludy/db';
import { Runtime, defineCommand, defineQuery, memberBriefingRuntime, type QueryDef } from '../src/runtime.ts';

const ORG = '01900000-0000-7000-8000-000000000001';
const USER = '01900000-0000-7000-8000-0000000000aa';
const MAIL = '01900000-0000-7000-8000-0000000000bb';

function fakeDb(): Db {
  const connection: DatabaseConnection = {
    async executeQuery<R>(_query: CompiledQuery): Promise<QueryResult<R>> {
      return { rows: [] };
    },
    // oxlint-disable-next-line require-yield
    async *streamQuery() {
      throw new Error('not supported');
    },
  };
  const driver: Driver = {
    init: async () => {},
    acquireConnection: async () => connection,
    beginTransaction: async () => {},
    commitTransaction: async () => {},
    rollbackTransaction: async () => {},
    releaseConnection: async () => {},
    destroy: async () => {},
  };
  return new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
}

function makeRuntime() {
  return new Runtime(fakeDb(), { manifests: [] });
}

function baseQuery(name: string, extra: Partial<QueryDef<unknown, unknown>> = {}): QueryDef<unknown, unknown> {
  return defineQuery({
    name,
    access: ['owner', 'admin', 'member'] as const,
    input: z.object({}),
    handler: async (ctx) => ({ briefing: ctx.memberBriefing ?? null }),
    ...extra,
  });
}

describe('QueryDef.memberBriefing registration and facade (#5080)', () => {
  it('accepts valid memberBriefing query declarations and freezes the runtime facade', () => {
    const rt = makeRuntime().register({
      queries: [
        baseQuery('meetings.brief.helper', { memberBriefing: {} }),
        baseQuery('meetings.brief.mail_content', { memberBriefing: { reads: ['meetings.brief.helper'] } }),
      ],
    });

    const facade = memberBriefingRuntime(rt, ORG, { memberUserId: USER, mailId: MAIL });
    expect(Object.isFrozen(facade)).toBe(true);
    expect(Object.keys(facade).sort()).toEqual(['mailId', 'memberUserId', 'orgId', 'query']);
    expect(facade.orgId).toBe(ORG);
    expect(facade.memberUserId).toBe(USER);
    expect(facade.mailId).toBe(MAIL);
    expect('execute' in facade).toBe(false);
  });

  it('refuses memberBriefing on commands', () => {
    const cmd = defineCommand({
      name: 'kernel.brief_write',
      access: ['owner'],
      risk: 'R0',
      sideEffect: 'none',
      writes: [],
      input: z.object({}),
      handler: async () => ({}),
    });
    Object.assign(cmd, { memberBriefing: {} });

    expect(() => makeRuntime().register({ commands: [cmd] })).toThrow(/strictly read-only/);
  });

  it('refuses invalid QueryDef.memberBriefing configurations at registration', () => {
    expect(() =>
      makeRuntime().register({
        queries: [baseQuery('meetings.brief.sys', { access: 'system', memberBriefing: {} })],
      }),
    ).toThrow(/role list/);

    expect(() =>
      makeRuntime().register({
        queries: [baseQuery('meetings.brief.stream', { stream: true, memberBriefing: {} })],
      }),
    ).toThrow(/streamed/);

    expect(() =>
      makeRuntime().register({
        queries: [baseQuery('meetings.brief.sensitive', { sensitive: true, memberBriefing: {} })],
      }),
    ).toThrow(/sensitive/);

    expect(() =>
      makeRuntime().register({
        queries: [baseQuery('meetings.brief.mcp', { mcp: { scope: 'ludy.read' }, memberBriefing: {} })],
      }),
    ).toThrow(/MCP grant/);

    expect(() =>
      makeRuntime().register({
        queries: [baseQuery('meetings.brief.extension', { extension: { scope: 'meetings' }, memberBriefing: {} })],
      }),
    ).toThrow(/cannot combine extension with memberBriefing/);

    expect(() =>
      makeRuntime().register({
        queries: [baseQuery('meetings.brief.empty_read', { memberBriefing: { reads: [''] } })],
      }),
    ).toThrow(/registered query names/);
  });

  it('rejects unknown, streamed, sensitive, or malformed-UUID calls before reaching the database', async () => {
    const rt = makeRuntime().register({
      queries: [
        baseQuery('meetings.brief.stream', { stream: true }),
        baseQuery('meetings.brief.sensitive', { sensitive: true }),
        baseQuery('meetings.brief.ok', { memberBriefing: {} }),
      ],
    });

    await expect(
      rt.runAsMemberBriefing('meetings.brief.missing', {}, { orgId: ORG, memberUserId: USER, mailId: MAIL }),
    ).rejects.toMatchObject({ code: 'QUERY_NOT_FOUND', status: 404 });

    await expect(
      rt.runAsMemberBriefing('meetings.brief.sensitive', {}, { orgId: 'not-a-uuid', memberUserId: USER, mailId: MAIL }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', details: { rule: 'member_briefing_context' } });

    await expect(
      rt.runAsMemberBriefing('meetings.brief.stream', {}, { orgId: ORG, memberUserId: USER, mailId: MAIL }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', details: { rule: 'member_briefing_access' } });

    await expect(
      rt.runAsMemberBriefing('meetings.brief.sensitive', {}, { orgId: ORG, memberUserId: USER, mailId: MAIL }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', details: { rule: 'sensitive_user_only' } });

    await expect(
      rt.runAsMemberBriefing('meetings.brief.ok', {}, { orgId: 'not-a-uuid', memberUserId: USER, mailId: MAIL }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', details: { rule: 'member_briefing_context' } });
  });
});
