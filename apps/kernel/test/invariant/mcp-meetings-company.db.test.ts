// SPDX-License-Identifier: AGPL-3.0-only
// What a company MCP grant may read of Meetings, pinned before the read exists (#3731, ADR-0051; Meetings PO design review on the issue, 2026-11-18). Every case holds now (when a company grant
// reads no meeting at all) and keeps holding when the read lands, which opens exactly three tables to the sealed company context and only the published results of meetings whose visibility is 'org':
// - in a sealed company context (the kind `mcp_company`) every row of every table of crove_meetings is out of reach, except the rows of `meeting`, `meeting_result` and `action_item` that belong
//   to a meeting of visibility 'org', and of the last two only the published ones: a meeting of attendees only is not read even when the grantor recorded it, nor are drafts, transcripts, notes,
//   translations, readers, consent records or anything else of the module;
// - the legal-entity scope is kept: a company context that does not hold '*' (a context scoped to one entity) reads no org meeting, as a person limited to an entity reads none (the policy and
//   `is_meeting_reader` ask for '*'); the read must not widen that;
// - a member grant (kind `mcp_member`) reads no row of crove_meetings at all (the hold of 2026-11-13 on member-private tools stays), and `mcp_member_table` names no table of it;
// - another org's rows are never read, whatever their visibility;
// - the policies of crove_meetings that name `mcp_company` are read policies (FOR SELECT) of the three tables above and no others; no write policy and no function of the schema names the kind
//   (the kind is read inline in policies, and the one function that names it is the sealing core, pinned in mcp-company-context.db.test.ts); no policy or function of the schema names the member kind.
// The sealed contexts are written here by the superuser (ctx_write) in the exact shape the entries write, then read as crove_tenant; no entry or tool of the feature is needed.
// Part of the invariant suite: its fixtures are its own, and it imports package code under test, never helpers from outside test/invariant/.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, type UserActor } from '@crove/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@crove/mod-meetings';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

// The only three tables a company grant may read rows of, once the read exists.
const OPEN_TABLES = ['action_item', 'meeting', 'meeting_result'];
// Words in the rows that must never be read.
const CANARY = 'BÍ MẬT-3731';

suite('what a company MCP grant reads of Meetings (#3731, invariants first)', () => {
  const dbName = `crove_test_mcp_meetings_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let runtime: Runtime;
  let orgA = '';
  let orgB = '';
  const users: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const asUser = (who: string): UserActor => ({ type: 'user', userId: users[who] as string, aal: 'aal1' });
  const exec = (who: string, name: string, input: unknown, org = orgA) => runtime.execute(name, input, { actor: asUser(who), orgId: org });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const sqlAdmin = <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []) => admin((c) => c.query<R>(text, params));

  // The context a sealed entry writes (the shape of enter_mcp_company_context, enter_mcp_member_context and enter_user_context), written by the superuser, then the session reads as crove_tenant.
  type Sealed = Record<string, unknown>;
  const company = (org: string, grantor: string, leScope: string[] = ['*']): Sealed => ({
    v: 1, org, actor: 'agent', user: null, role: 'admin', agent: randomUUID(), run: null, position: null, module: 'kernel', max_risk: 'R0', tainted: true, le_scope: leScope, flags: [], kind: 'mcp_company', grantor,
  });
  const member = (org: string, who: string, leScope: string[] = ['*']): Sealed => ({
    v: 1, org, actor: 'agent', user: null, role: 'member', agent: randomUUID(), run: null, position: null, module: 'kernel', max_risk: 'R0', tainted: true, le_scope: leScope, flags: [], kind: 'mcp_member', member: who,
  });
  const person = (org: string, who: string): Sealed => ({ v: 1, org, actor: 'user', user: who, role: 'admin', le_scope: ['*'], flags: [] });
  async function asSealed<T>(ctx: Sealed, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT crove_kernel.ctx_write($1::jsonb)', [JSON.stringify(ctx)]);
      await c.query('SET LOCAL ROLE crove_tenant');
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  }
  // The rows of one table the context reads: their org and id, and for the three open tables what decides (visibility of the meeting, stage of the row). A table the login cannot read answers nothing.
  async function visible(ctx: Sealed, table: string): Promise<Array<{ org_id: string; id: string }>> {
    return asSealed(ctx, async (c) => {
      try {
        return (await c.query<{ org_id: string; id: string }>(`SELECT org_id, id FROM crove_meetings.${table}`)).rows;
      } catch (error) {
        if ((error as { code?: string }).code === '42501') return [];
        throw error;
      }
    });
  }
  let tables: string[] = [];
  const idsOf = (rows: Array<{ id: string }>) => rows.map((r) => r.id).sort();

  async function seedMeeting(org: string, key: string, recorder: string, visibility: 'org' | 'attendees', publish: boolean): Promise<string> {
    const meetingId = randomUUID();
    ids[key] = meetingId;
    await sqlAdmin(
      `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       VALUES ($1, $2, $5, 'vi', now(), now() + interval '30 minutes', 1800, $3, $4, 'ready', 'told_at_start', $3, now(), '1.0', current_date + 30, current_date + 365)`,
      [org, meetingId, users[recorder], visibility, `${CANARY} ${key}`],
    );
    await sqlAdmin('INSERT INTO crove_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)', [org, randomUUID(), meetingId, users.attendee]);
    await sqlAdmin(`INSERT INTO crove_meetings.transcript_segment (org_id, id, meeting_id, start_seconds, end_seconds, speaker_label, text, stage) VALUES ($1, $2, $3, 0, 5, 'Người nói 1', $4, 'draft')`, [org, randomUUID(), meetingId, `${CANARY} bản ghi`]);
    await exec(recorder, 'meetings.summary.save', { meetingId, summary: `${CANARY} tóm tắt`, decisions: [`${CANARY} quyết định`] }, org);
    await exec(recorder, 'meetings.action_item.create', { meetingId, title: `${CANARY} việc`, who: 'An', whoUserId: null, when: 'thứ sáu', whenDate: null, transcriptSeconds: 5 }, org);
    await exec(recorder, 'meetings.notes.save', { meetingId, body: `${CANARY} ghi chú` }, org);
    if (publish) await exec(recorder, 'meetings.result.publish', { meetingId, confirmed: true }, org);
    return meetingId;
  }

  beforeAll(async () => {
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    const pool = createPool({ connectionString: url.toString(), max: 4 });
    pools.push(pool);
    const db = createDb(pool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...meetingsCommands], queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries] });
    for (const key of ['owner', 'admin', 'recorder', 'attendee', 'foreign']) users[key] = await upsertIdentity(db, { issuer: 'mcp-meetings', subject: key, email: `${key}@mcp-meetings.test`, name: key });
    orgA = (await createOrg(runtime, asUser('owner'), 'Org A')).orgId;
    orgB = (await createOrg(runtime, asUser('foreign'), 'Org B')).orgId;
    await sqlAdmin(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member')`, [orgA, users.admin, users.recorder, users.attendee]);
    // Org A: an org-visible published meeting; an org-visible one with only a draft; an attendees-only published one recorded by the grantor (an admin); one recorded by a member.
    await seedMeeting(orgA, 'orgPublished', 'recorder', 'org', true);
    await seedMeeting(orgA, 'orgDraft', 'recorder', 'org', false);
    await seedMeeting(orgA, 'attendeesByAdmin', 'admin', 'attendees', true);
    await seedMeeting(orgA, 'attendeesByMember', 'recorder', 'attendees', true);
    // Org B: an org-visible published meeting, which no grant of org A may read.
    await sqlAdmin(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgB, users.attendee]);
    await seedMeeting(orgB, 'otherOrg', 'foreign', 'org', true);
    tables = (await sqlAdmin<{ table_name: string }>(`SELECT table_name FROM information_schema.columns WHERE table_schema = 'crove_meetings' AND column_name = 'org_id' AND table_name IN (SELECT tablename FROM pg_tables WHERE schemaname = 'crove_meetings') ORDER BY 1`)).rows.map((r) => r.table_name);
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('has rows in the tables of the module to guard (the fixtures are not vacuous), and a person reads their own meetings', async () => {
    for (const t of ['meeting', 'meeting_reader', 'transcript_segment', 'meeting_result', 'action_item']) {
      expect(tables, t).toContain(t);
      expect(Number((await sqlAdmin<{ n: string }>(`SELECT count(*)::text AS n FROM crove_meetings.${t} WHERE org_id = $1`, [orgA])).rows[0]?.n), t).toBeGreaterThan(0);
    }
    // The control: the admin (a person, not a grant) reads the org's org-visible meetings and the ones they recorded; the policies are live.
    const own = idsOf(await visible(person(orgA, users.admin as string), 'meeting'));
    expect(own).toEqual([ids.orgPublished, ids.orgDraft, ids.attendeesByAdmin].sort());
  });

  it('reads, in a company context, no row of any table of the module but the org-visible meetings and their published results and items', async () => {
    const ctx = company(orgA, users.admin as string);
    for (const t of tables.filter((x) => !OPEN_TABLES.includes(x))) expect(await visible(ctx, t), t).toEqual([]);
    // The three open tables: what is visible is a subset of the org-visible meeting and its published rows, never another meeting, a draft, or another org.
    const meetings = await visible(ctx, 'meeting');
    expect(meetings.every((m) => m.org_id === orgA)).toBe(true);
    expect(idsOf(meetings).every((id) => [ids.orgPublished, ids.orgDraft].includes(id))).toBe(true);
    expect(idsOf(meetings)).not.toContain(ids.attendeesByAdmin);
    expect(idsOf(meetings)).not.toContain(ids.attendeesByMember);
    expect(idsOf(meetings)).not.toContain(ids.otherOrg);
    for (const t of ['meeting_result', 'action_item']) {
      const rows = await visible(ctx, t);
      const allowed = (
        await sqlAdmin<{ id: string }>(
          `SELECT r.id FROM crove_meetings.${t} r JOIN crove_meetings.meeting m ON m.org_id = r.org_id AND m.id = r.meeting_id WHERE r.org_id = $1 AND r.stage = 'published' AND m.visibility = 'org'`,
          [orgA],
        )
      ).rows.map((r) => r.id);
      expect(rows.every((r) => r.org_id === orgA), t).toBe(true);
      for (const row of rows) expect(allowed, `${t} ${row.id}`).toContain(row.id);
    }
  });

  it('keeps the legal-entity scope: a company context without the whole-org scope reads no org meeting and nothing else of the module', async () => {
    // A context scoped to one entity (no '*'), as an entity-limited person would hold: an org meeting is not theirs (the meeting policy and is_meeting_reader ask for '*').
    const scoped = company(orgA, users.admin as string, [randomUUID()]);
    for (const t of tables) expect(await visible(scoped, t), t).toEqual([]);
    // The same grantor with the whole-org scope is the case above: the scope is what differs.
  });

  it('reads no row of the module in a member context, org-visible published meetings included, and names no table of it in the member catalog', async () => {
    for (const who of ['admin', 'recorder', 'attendee']) {
      const ctx = member(orgA, users[who] as string);
      for (const t of tables) expect(await visible(ctx, t), `${who} ${t}`).toEqual([]);
    }
    const catalog = (await sqlAdmin<{ table_name: string }>(`SELECT table_name FROM crove_kernel.mcp_member_table`).catch(() => ({ rows: [] as Array<{ table_name: string }> }))).rows;
    expect(catalog.filter((r) => r.table_name.startsWith('crove_meetings.'))).toEqual([]);
  });

  it('reads no row of another org in a company context, whatever its visibility', async () => {
    const ctx = company(orgA, users.admin as string);
    for (const t of tables) for (const row of await visible(ctx, t)) expect(row.org_id, t).toBe(orgA);
    // And a company context of org B reads none of org A.
    const other = company(orgB, users.foreign as string);
    for (const t of tables) for (const row of await visible(other, t)) expect(row.org_id, t).toBe(orgB);
  });

  it('names the company kind only in read policies of the three open tables, in no write policy and no function of the module, and never names the member kind', async () => {
    const policies = (
      await sqlAdmin<{ tablename: string; policyname: string; cmd: string; permissive: string; text: string }>(
        `SELECT tablename, policyname, cmd, permissive, coalesce(qual, '') || ' ' || coalesce(with_check, '') AS text FROM pg_policies WHERE schemaname = 'crove_meetings' ORDER BY 1, 2`,
      )
    ).rows;
    const naming = policies.filter((p) => p.text.includes('mcp_company'));
    for (const p of naming) {
      expect(OPEN_TABLES, `${p.tablename}.${p.policyname}`).toContain(p.tablename);
      expect(p.cmd, `${p.tablename}.${p.policyname}`).toBe('SELECT');
      expect(p.permissive, `${p.tablename}.${p.policyname}`).toBe('RESTRICTIVE');
    }
    // Each such policy keeps the module's own gates: the whole-org scope and (for results and items) a published row.
    for (const p of naming) expect(p.text, `${p.tablename}.${p.policyname}`).toMatch(/ctx_le_scope/);
    for (const p of policies.filter((x) => x.cmd !== 'SELECT')) expect(p.text, `${p.tablename}.${p.policyname}`).not.toMatch(/mcp_company|mcp_member|ctx_mcp_member_id/);
    for (const p of policies) expect(p.text, `${p.tablename}.${p.policyname}`).not.toMatch(/mcp_member|ctx_mcp_member_id/);
    const functions = (
      await sqlAdmin<{ n: string }>(
        `SELECT p.oid::regprocedure::text AS n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
         WHERE s.nspname = 'crove_meetings' AND p.prokind IN ('f', 'p') AND pg_get_functiondef(p.oid) ~ '(mcp_company|mcp_member|ctx_mcp_member_id)' ORDER BY 1`,
      )
    ).rows;
    expect(functions.map((f) => f.n)).toEqual([]);
  });
});
