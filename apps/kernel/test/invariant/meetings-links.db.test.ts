// SPDX-License-Identifier: AGPL-3.0-only
// Links of a meeting (L1, #2587, ADR-0047) on PostgreSQL 17: a link row is read only by the readers of its meeting, through the same helper as the meeting's other
// child tables, and the join the pages run (link to meeting) runs as the caller, under the meeting's own restrictive policies. An attendees-only meeting's links are
// invisible to an owner, an admin, another member, a viewer, a member limited to a branch, an org-chart agent and the worker's system context: no row, no row
// through a count by target, no row through the join; none of them inserts or deletes one either.
// Part of the invariant suite; it imports package code under test, never helpers from outside test/invariant/.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { contextToken } from './fixtures/context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const SYSTEM = { type: 'system' as const, component: 'kernel.agent' };
const suite = ADMIN ? describe : describe.skip;

suite('meeting links readers on PostgreSQL (#2587, ADR-0047)', () => {
  const dbName = `crove_test_meetings_links_inv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let branch = '';
  const users = { owner: '', admin: '', recorder: '', attendee: '', member: '', viewer: '', limited: '' };
  const secret = { meeting: randomUUID(), link: randomUUID(), deal: randomUUID() };
  const shared = { meeting: randomUUID(), link: randomUUID(), deal: randomUUID() };
  let agent = { agentId: '', runId: '' };
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  // Runs fn as a login role in a context, always rolled back.
  async function inContext<T>(url: string, enter: (c: pg.Client) => Promise<unknown>, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      await c.query('BEGIN');
      await enter(c);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  }

  interface Actor {
    name: string;
    url: () => string;
    enter: (c: pg.Client) => Promise<unknown>;
  }
  const member = (name: string, userId: () => string): Actor => ({
    name,
    url: () => appUrl,
    enter: (c) => c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(userId(), orgId)]),
  });
  const system: Actor = { name: 'the system context', url: () => workerUrl, enter: (c) => c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgId]) };
  const agentActor: Actor = {
    name: 'an agent context',
    url: () => workerUrl,
    enter: (c) => c.query('SELECT crove_kernel.enter_agent_context($1::uuid, $2::uuid, $3::uuid)', [orgId, agent.agentId, agent.runId]),
  };
  const recorder = member('the recorder', () => users.recorder);
  const attendee = member('an attendee', () => users.attendee);
  // Read nothing of the attendees-only meeting. Of the org-shared one, an owner, an admin and a member read it; a viewer, a member limited to a branch, an agent and the system do not.
  const nonReaders: Actor[] = [
    member('another member', () => users.member),
    member('an owner', () => users.owner),
    member('an admin', () => users.admin),
    member('a viewer', () => users.viewer),
    member('a member limited to a branch', () => users.limited),
    agentActor,
    system,
  ];
  const run = <T>(actor: Actor, fn: (c: pg.Client) => Promise<T>) => inContext(actor.url(), actor.enter, fn);
  const count = async (actor: Actor, text: string, values: unknown[] = []) => run(actor, async (c) => (await c.query<{ n: number }>(text, values)).rows[0]?.n ?? 0);
  const outcome = <T>(p: Promise<T>) =>
    p.then(
      (value) => ({ ok: true as const, value }),
      (error: { code?: string; message: string }) => ({ ok: false as const, code: error.code ?? '', message: error.message }),
    );

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    appUrl = login('crove_app', 'test-app-pw');
    workerUrl = login('crove_worker', 'test-worker-pw');
    const runtimeFor = (url: string) => {
      const pool = createPool({ connectionString: url, max: 4 });
      pools.push(pool);
      const db = createDb(pool);
      return {
        db,
        runtime: new Runtime(db, { manifests: TEST_MANIFESTS }).register({
          commands: [...kernelCommands, ...financeCommands],
          queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...financeQueries],
        }),
      };
    };
    const api = runtimeFor(appUrl);
    const worker = runtimeFor(workerUrl).runtime;
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(api.db, { issuer: 'meetings-links', subject: key, email: `${key}@meetings-links.test`, name: null });
    }
    orgId = (await createOrg(api.runtime, asUser(users.owner), 'Liên kết cuộc họp')).orgId;
    await admin(async (c) => {
      branch = (await c.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id`, [orgId, users.owner])).rows[0]?.id as string;
      await c.query(
        `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'member'), ($1, $6, 'viewer'), ($1, $7, 'member')`,
        [orgId, users.admin, users.recorder, users.attendee, users.member, users.viewer, users.limited],
      );
      await c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [orgId, users.limited, branch, users.owner]);
    });
    const installed = await api.runtime.execute<{ agentId: string; positionId: string }>(
      'kernel.agent.template.install',
      { templateKey: 'finance.chief_accountant', reportsTo: null },
      { actor: asMfa(users.owner), orgId },
    );
    await api.runtime.execute('kernel.task.create', { title: 'Việc thử', assigneePositionId: installed.positionId }, { actor: asUser(users.owner), orgId });
    const started = await worker.execute<{ runId: string | null }>('kernel.agent.run.start', { agentId: installed.agentId }, { actor: SYSTEM, orgId });
    agent = { agentId: installed.agentId, runId: started.runId as string };
    await admin(async (c) => {
      for (const [meeting, visibility] of [[secret.meeting, 'attendees'], [shared.meeting, 'org']] as const) {
        await c.query(
          `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
           VALUES ($1, $2, $5, 'vi', now(), now() + interval '30 minutes', 1800, $3, $4, 'ready', 'told_at_start', $3, now(), '1.0', current_date + 30, current_date + 365)`,
          [orgId, meeting, users.recorder, visibility, visibility === 'attendees' ? 'Cuộc họp kín' : 'Cuộc họp toàn công ty'],
        );
      }
      await c.query(`INSERT INTO crove_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)`, [orgId, randomUUID(), secret.meeting, users.attendee]);
      // A deal each (a deal has no foreign key: the CRM module is reached by query, not by key).
      await c.query(
        `INSERT INTO crove_meetings.meeting_link (org_id, id, meeting_id, deal_id, created_by) VALUES ($1, $2, $3, $4, $7), ($1, $5, $6, $8, $7)`,
        [orgId, secret.link, secret.meeting, secret.deal, shared.link, shared.meeting, users.recorder, shared.deal],
      );
    });
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('shows the recorder both links and an attendee the links of the meetings they read', async () => {
    expect(await count(recorder, 'SELECT count(*)::int AS n FROM crove_meetings.meeting_link')).toBe(2);
    // An attendee reads the attendees-only meeting (a reader) and, being a member, the org-shared one.
    expect(await count(attendee, 'SELECT count(*)::int AS n FROM crove_meetings.meeting_link')).toBe(2);
    expect(await count(attendee, 'SELECT count(*)::int AS n FROM crove_meetings.meeting_link WHERE meeting_id = $1', [secret.meeting])).toBe(1);
  });

  for (const actor of nonReaders) {
    it(`${actor.name} reads no link of the attendees-only meeting: no row, no count by deal, no row through the join`, async () => {
      expect(await count(actor, 'SELECT count(*)::int AS n FROM crove_meetings.meeting_link WHERE meeting_id = $1', [secret.meeting]), 'by meeting').toBe(0);
      expect(await count(actor, 'SELECT count(*)::int AS n FROM crove_meetings.meeting_link WHERE deal_id = $1', [secret.deal]), 'by deal').toBe(0);
      expect(await count(actor, 'SELECT count(*)::int AS n FROM crove_meetings.meeting_link WHERE id = $1', [secret.link]), 'by id').toBe(0);
      // The join a deal page runs, as the caller: the meeting's policy hides its row, so the link and its title are not in the answer.
      const joined = await run(actor, async (c) =>
        (await c.query<{ title: string }>('SELECT m.title FROM crove_meetings.meeting_link l JOIN crove_meetings.meeting m ON m.org_id = l.org_id AND m.id = l.meeting_id WHERE l.deal_id = $1', [secret.deal])).rows,
      );
      expect(joined, 'through the join').toEqual([]);
    });

    it(`${actor.name} inserts and deletes no link of the attendees-only meeting`, async () => {
      const insert = await outcome(
        run(actor, (c) => c.query(`INSERT INTO crove_meetings.meeting_link (org_id, id, meeting_id, deal_id, created_by) VALUES ($1, $2, $3, $4, $5)`, [orgId, randomUUID(), secret.meeting, randomUUID(), users.recorder])),
      );
      expect(insert.ok, `${actor.name} inserting`).toBe(false);
      const deleted = await outcome(run(actor, (c) => c.query('DELETE FROM crove_meetings.meeting_link WHERE meeting_id = $1', [secret.meeting])));
      if (deleted.ok) expect(deleted.value.rowCount ?? 0, `${actor.name} deleting`).toBe(0);
    });
  }

  it('an attendee, who reads the meeting but did not record it, inserts and deletes no link', async () => {
    const insert = await outcome(run(attendee, (c) => c.query(`INSERT INTO crove_meetings.meeting_link (org_id, id, meeting_id, deal_id, created_by) VALUES ($1, $2, $3, $4, $5)`, [orgId, randomUUID(), secret.meeting, randomUUID(), users.attendee])));
    expect(insert.ok).toBe(false);
    const deleted = await outcome(run(attendee, (c) => c.query('DELETE FROM crove_meetings.meeting_link WHERE meeting_id = $1', [secret.meeting])));
    if (deleted.ok) expect(deleted.value.rowCount ?? 0).toBe(0);
  });

  it('refuses every update of a link, even the recorder\'s', async () => {
    const update = await outcome(run(recorder, (c) => c.query('UPDATE crove_meetings.meeting_link SET deal_id = $1 WHERE id = $2', [randomUUID(), secret.link])));
    expect(update.ok).toBe(false);
    expect(update).toMatchObject({ code: '42501' });
  });

  it('an owner, an admin and another member read the org-shared meeting\'s link, and a viewer, a limited member, an agent and the system do not', async () => {
    for (const actor of nonReaders) {
      const sees = await count(actor, 'SELECT count(*)::int AS n FROM crove_meetings.meeting_link WHERE meeting_id = $1', [shared.meeting]);
      const expected = ['an owner', 'an admin', 'another member'].includes(actor.name) ? 1 : 0;
      expect(sees, actor.name).toBe(expected);
    }
  });
});
