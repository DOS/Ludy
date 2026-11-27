// SPDX-License-Identifier: AGPL-3.0-only
// Integration tests for Runtime.runAsMemberBriefing and memberBriefingRuntime on real PostgreSQL (#5080 Slice A1).
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createDb, createPool, type MemberRole } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, upsertIdentity } from '@ludy/kernel';
import { Runtime, defineQuery, memberBriefingRuntime, type QueryDef } from '@ludy/kernel-runtime';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const ALL_BRIEFING_ROLES: readonly MemberRole[] = ['owner', 'admin', 'member'];

function testQuery(name: string, extra: Partial<QueryDef<unknown, unknown>> = {}): QueryDef<unknown, unknown> {
  return defineQuery({
    name,
    access: ALL_BRIEFING_ROLES,
    input: z.object({}),
    handler: async (ctx) => ({ memberBriefing: ctx.memberBriefing ?? null }),
    ...extra,
  });
}

const QUERIES: QueryDef<unknown, unknown>[] = [
  testQuery('meetings.t_briefing_undeclared'),
  testQuery('meetings.t_briefing_system', { access: 'system' }),
  testQuery('meetings.t_briefing_owner_only', { access: ['owner'], memberBriefing: {} }),
  testQuery('meetings.t_briefing_nested_leaf', { memberBriefing: {} }),
  testQuery('meetings.t_briefing_nested_undeclared'),
  testQuery('meetings.t_briefing_nested_mid', {
    memberBriefing: { reads: ['meetings.t_briefing_nested_leaf'] },
    handler: async (ctx) => {
      const ok = await ctx.query('meetings.t_briefing_nested_leaf', {});
      const blocked = await ctx.query('meetings.t_briefing_nested_undeclared', {});
      return { ok, blocked };
    },
  }),
  testQuery('meetings.t_briefing_nested_unlisted', {
    memberBriefing: { reads: [] },
    handler: async (ctx) => ctx.query('meetings.t_briefing_nested_leaf', {}),
  }),
  testQuery('meetings.t_briefing_nested_chain', {
    memberBriefing: { reads: ['meetings.t_briefing_nested_mid'] },
    handler: async (ctx) => ctx.query('meetings.t_briefing_nested_mid', {}),
  }),
  testQuery('meetings.t_briefing_nested_depth_escape', {
    memberBriefing: { reads: ['meetings.t_briefing_nested_unlisted', 'meetings.t_briefing_nested_leaf'] },
    handler: async (ctx) => ctx.query('meetings.t_briefing_nested_unlisted', {}),
  }),
  testQuery('meetings.t_briefing_snapshot', {
    memberBriefing: { reads: ['meetings.t_briefing_nested_leaf'] },
    handler: async (ctx) => {
      const iso = await sql<{ isolation: string; read_only: string }>`
        SELECT current_setting('transaction_isolation') AS isolation,
               current_setting('transaction_read_only') AS read_only`.execute(ctx.trx);
      const lines = await sql<{ meeting_id: string; lines: unknown }>`
        SELECT meeting_id, lines FROM ludy_meetings.morning_brief_lines ORDER BY meeting_id`.execute(ctx.trx);
      const directory = await sql<{ user_id: string; display_name: string | null }>`
        SELECT user_id, display_name FROM ludy_kernel.member_briefing_directory ORDER BY user_id`.execute(ctx.trx);
      const nested = await ctx.query<{ memberBriefing: unknown }>('meetings.t_briefing_nested_leaf', {});
      return {
        isolation: iso.rows[0]?.isolation,
        readOnly: iso.rows[0]?.read_only,
        role: ctx.role,
        agent: ctx.agent,
        memberVy: ctx.memberVy,
        memberBriefing: ctx.memberBriefing ?? null,
        lines: lines.rows,
        directory: directory.rows,
        nested,
      };
    },
  }),
  testQuery('meetings.t_briefing_write', {
    memberBriefing: {},
    handler: async (ctx) => {
      await sql`UPDATE ludy_meetings.morning_notice SET send_minute = 500 WHERE org_id = ${ctx.orgId}::uuid`.execute(
        ctx.trx,
      );
      return { wrote: true };
    },
  }),
];

suite('member_briefing runtime execution (#5080 Slice A1)', () => {
  const dbName = `ludy_test_briefing_rt_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appConnUrl = '';
  let workerConnUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let worker: Runtime;
  let meetingId = '';
  let memberMailId = '';
  let viewerMailId = '';
  const users: Record<string, string> = {};

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();

    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, {
      ludy_app: 'test-app-pw',
      ludy_worker: 'test-worker-pw',
    });

    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    appConnUrl = login('ludy_app', 'test-app-pw');
    workerConnUrl = login('ludy_worker', 'test-worker-pw');
    const appPool = createPool({ connectionString: appConnUrl, max: 2 });
    const workerPool = createPool({ connectionString: workerConnUrl, max: 4 });
    pools.push(appPool, workerPool);

    const appDb = createDb(appPool);
    const app = new Runtime(appDb, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands],
      queries: [],
    });
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register({
      commands: [],
      queries: QUERIES,
    });

    for (const key of ['owner', 'member', 'viewer']) {
      users[key] = await upsertIdentity(appDb, {
        issuer: 'member-briefing-rt',
        subject: key,
        email: `${key}@briefing-rt.test`,
        name: `User ${key}`,
      });
    }
    orgId = (
      await createOrg(app, { type: 'user', userId: users.owner as string, aal: 'aal1' }, 'Briefing Runtime Org')
    ).orgId;

    await admin(async (c) => {
      await c.query(
        `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'viewer')`,
        [orgId, users.member, users.viewer],
      );
      await c.query(
        `INSERT INTO ludy_meetings.morning_notice (org_id, user_id, send_minute, time_zone, language, enabled, content, vy_lines)
         VALUES ($1, $2, 420, 'Asia/Ho_Chi_Minh', 'vi', true, 'full', true),
                ($1, $3, 420, 'Asia/Ho_Chi_Minh', 'vi', true, 'full', false)`,
        [orgId, users.member, users.viewer],
      );
      meetingId = randomUUID();
      await c.query(
        `INSERT INTO ludy_meetings.meeting (
           org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id,
           visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at,
           consent_notice_version, audio_retention_date, text_retention_date
         ) VALUES (
           $1, $2, 'Hop sang nhom san pham', 'vi', now() - interval '2 hours', now() - interval '1 hour', 3600, $3,
           'attendees', 'ready', 'told_at_start', $3, now(), '1.0', current_date + 30, current_date + 365
         )`,
        [orgId, meetingId, users.owner],
      );
      await c.query(
        `INSERT INTO ludy_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)`,
        [orgId, randomUUID(), meetingId, users.member],
      );
      memberMailId = randomUUID();
      viewerMailId = randomUUID();
      await c.query(
        `INSERT INTO ludy_kernel.mail_message (org_id, id, stream, source, source_id, template_key, to_address, to_hash, message_id_header, status)
         VALUES ($1, $2, 'transactional', 'meetings.morning', $3, 'meetings.morning', 'member@briefing-rt.test', $4, $5, 'queued'),
                ($1, $6, 'transactional', 'meetings.morning', $7, 'meetings.morning', 'viewer@briefing-rt.test', $8, $9, 'queued')`,
        [
          orgId,
          memberMailId,
          users.member,
          'a'.repeat(63) + '1',
          `<brief-m-${randomUUID()}@test>`,
          viewerMailId,
          users.viewer,
          'b'.repeat(63) + '2',
          `<brief-v-${randomUUID()}@test>`,
        ],
      );
    });

    const workerClient = new pg.Client({ connectionString: login('ludy_worker', 'test-worker-pw') });
    await workerClient.connect();
    try {
      await workerClient.query('BEGIN');
      await workerClient.query('SELECT ludy_kernel.enter_system_context($1::uuid)', [orgId]);
      await workerClient.query(
        `SELECT ludy_meetings.morning_brief_lines_upsert($1::uuid, $2::uuid, $3::uuid, $4::jsonb, now() + interval '12 hours')`,
        [orgId, users.member, meetingId, JSON.stringify(['Chot muc tieu quy nay'])],
      );
      await workerClient.query('COMMIT');
    } finally {
      await workerClient.end();
    }
  }, 300_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('executes allowlisted queries inside REPEATABLE READ READ ONLY snapshot with memberBriefing grant and narrow lookups', async () => {
    const facade = memberBriefingRuntime(worker, orgId, {
      memberUserId: users.member as string,
      mailId: memberMailId,
    });
    expect(Object.isFrozen(facade)).toBe(true);
    expect(Object.keys(facade).sort()).toEqual(['mailId', 'memberUserId', 'orgId', 'query']);

    const out = await facade.query<{
      isolation: string;
      readOnly: string;
      role: unknown;
      agent: unknown;
      memberVy: unknown;
      memberBriefing: unknown;
      lines: Array<{ meeting_id: string; lines: string[] }>;
      directory: Array<{ user_id: string; display_name: string | null }>;
      nested: { status: string; value?: unknown };
    }>('meetings.t_briefing_snapshot', {});

    expect(out.isolation).toBe('repeatable read');
    expect(out.readOnly).toBe('on');
    expect(out.role).toBeNull();
    expect(out.agent).toBeNull();
    expect(out.memberVy).toBeNull();
    expect(out.memberBriefing).toEqual({
      memberUserId: users.member,
      mailId: memberMailId,
      role: 'member',
      maxRisk: 'R0',
      tainted: true,
    });
    expect(out.lines).toEqual([{ meeting_id: meetingId, lines: ['Chot muc tieu quy nay'] }]);
    expect(out.directory.map((d) => d.user_id).sort()).toEqual(
      [users.owner, users.member, users.viewer].sort(),
    );

    const viewCols = await admin(async (c) =>
      (
        await c.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = 'ludy_kernel' AND table_name = 'member_briefing_directory' ORDER BY column_name`,
        )
      ).rows.map((r) => r.column_name),
    );
    expect(viewCols).toEqual(['display_name', 'user_id']);

    // vy_lines = false hides morning_brief_lines while content = 'full' briefing queries keep working.
    await admin((c) =>
      c.query(`UPDATE ludy_meetings.morning_notice SET vy_lines = false WHERE org_id = $1 AND user_id = $2`, [
        orgId,
        users.member,
      ]),
    );
    const withoutVy = await facade.query<{
      lines: Array<{ meeting_id: string; lines: string[] }>;
      directory: Array<{ user_id: string; display_name: string | null }>;
    }>('meetings.t_briefing_snapshot', {});
    expect(withoutVy.lines).toEqual([]);
    expect(withoutVy.directory.length).toBe(3);
    await admin((c) =>
      c.query(`UPDATE ludy_meetings.morning_notice SET vy_lines = true WHERE org_id = $1 AND user_id = $2`, [
        orgId,
        users.member,
      ]),
    );
    expect(out.nested).toEqual({
      status: 'ok',
      value: {
        memberBriefing: {
          memberUserId: users.member,
          mailId: memberMailId,
          role: 'member',
          maxRisk: 'R0',
          tainted: true,
        },
      },
    });
  });

  it('enforces nested ctx.query reads allowlist without transitive inheritance', async () => {
    const facade = memberBriefingRuntime(worker, orgId, {
      memberUserId: users.member as string,
      mailId: memberMailId,
    });

    await expect(facade.query('meetings.t_briefing_nested_unlisted', {})).rejects.toMatchObject({
      code: 'FORBIDDEN',
      details: { rule: 'member_briefing_access' },
    });
    await expect(facade.query('meetings.t_briefing_nested_chain', {})).rejects.toMatchObject({
      code: 'FORBIDDEN',
      details: { rule: 'member_briefing_access' },
    });
    await expect(facade.query('meetings.t_briefing_nested_depth_escape', {})).rejects.toMatchObject({
      code: 'FORBIDDEN',
      details: { rule: 'member_briefing_access' },
    });
  });

  it('refuses undeclared, system, role-excluded, viewer, disabled opt-in, sent-mail, and write queries', async () => {
    const facade = memberBriefingRuntime(worker, orgId, {
      memberUserId: users.member as string,
      mailId: memberMailId,
    });

    await expect(facade.query('meetings.t_briefing_undeclared', {})).rejects.toMatchObject({
      code: 'FORBIDDEN',
      details: { rule: 'member_briefing_access' },
    });
    await expect(facade.query('meetings.t_briefing_system', {})).rejects.toMatchObject({
      code: 'FORBIDDEN',
      details: { rule: 'member_briefing_access' },
    });
    await expect(facade.query('meetings.t_briefing_owner_only', {})).rejects.toMatchObject({
      code: 'FORBIDDEN',
      details: { rule: 'member_briefing_access' },
    });

    const viewerFacade = memberBriefingRuntime(worker, orgId, {
      memberUserId: users.viewer as string,
      mailId: viewerMailId,
    });
    await expect(viewerFacade.query('meetings.t_briefing_nested_leaf', {})).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    await expect(facade.query('meetings.t_briefing_write', {})).rejects.toThrow();
    const minuteAfter = await admin(async (c) =>
      (
        await c.query<{ send_minute: number }>(
          'SELECT send_minute FROM ludy_meetings.morning_notice WHERE org_id = $1 AND user_id = $2',
          [orgId, users.member],
        )
      ).rows[0]?.send_minute,
    );
    expect(minuteAfter).toBe(420);

    await admin((c) =>
      c.query(`UPDATE ludy_meetings.morning_notice SET content = 'count' WHERE org_id = $1 AND user_id = $2`, [
        orgId,
        users.member,
      ]),
    );
    await expect(facade.query('meetings.t_briefing_nested_leaf', {})).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await admin((c) =>
      c.query(`UPDATE ludy_meetings.morning_notice SET content = 'full' WHERE org_id = $1 AND user_id = $2`, [
        orgId,
        users.member,
      ]),
    );

    await admin(async (c) => {
      await c.query(`UPDATE ludy_kernel.mail_message SET status = 'sending' WHERE id = $1`, [memberMailId]);
      await c.query(`UPDATE ludy_kernel.mail_message SET status = 'sent', sent_at = now() WHERE id = $1`, [
        memberMailId,
      ]);
    });
    await expect(facade.query('meetings.t_briefing_nested_leaf', {})).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    // Helper functions refuse non-worker callers and worker calls outside an active morning mail context (no oracle).
    for (const [label, connStr, useSystem] of [
      ['ludy_app', appConnUrl, false],
      ['ludy_worker_system', workerConnUrl, true],
    ] as const) {
      const probe = new pg.Client({ connectionString: connStr });
      await probe.connect();
      try {
        await probe.query('BEGIN');
        if (useSystem) {
          await probe.query('SELECT ludy_kernel.enter_system_context($1::uuid)', [orgId]);
        }
        const res = await probe.query<{ reader: boolean; vy_lines: boolean }>(
          `SELECT ludy_meetings.is_briefing_meeting_reader($1::uuid, $2::uuid, $3::uuid) AS reader,
                  ludy_meetings.is_briefing_vy_lines_enabled($1::uuid, $3::uuid) AS vy_lines`,
          [orgId, meetingId, users.member],
        );
        expect(res.rows[0], label).toEqual({ reader: false, vy_lines: false });
        await probe.query('ROLLBACK');
      } finally {
        await probe.end();
      }
    }
  });
});
