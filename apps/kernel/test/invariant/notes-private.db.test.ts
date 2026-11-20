// SPDX-License-Identifier: AGPL-3.0-only
// Private notes on PostgreSQL 17 (issue #1671, #3559, ADR-0037 §2, notes plan exit criterion 1): a private note is read and
// changed only in a context whose user is its author. Another member, an owner, an admin, a viewer, a member limited to
// some legal entities, an agent context and the system context read none of it and change none of it, through raw SQL
// in their own context; a shared note is read by the org's owners, admins and whole-org members and by the system
// context, and by no viewer, entity-limited member or agent. The author still reads their own notes after losing the
// whole-org scope. The definers the worker and owners use return counts, never text, and refuse every other caller; a
// forged context reaches nothing. Part of the invariant suite; it imports package code under test, never helpers from
// outside test/invariant/. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
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
import { aiRunFeature } from './fixtures/ai-run-feature.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const SYSTEM = { type: 'system' as const, component: 'kernel.agent' };
const SECRET = 'Mật khẩu cổng ngân hàng của khách';
const suite = ADMIN ? describe : describe.skip;

suite('private notes on PostgreSQL (#1671, ADR-0037)', () => {
  const dbName = `crove_test_notes_private_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let branch = '';
  const users = { owner: '', admin: '', author: '', member: '', viewer: '', limited: '' };
  // The author's private note and shared note, each linked to the org's party.
  const notes = { private: randomUUID(), shared: randomUUID(), party: randomUUID(), privateLink: randomUUID(), sharedLink: randomUUID() };
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
  const author = member('the author', () => users.author);
  // Everyone but the author, with whether they read the shared note.
  const others: Array<{ actor: Actor; readsShared: boolean }> = [
    { actor: member('another member', () => users.member), readsShared: true },
    { actor: member('an owner', () => users.owner), readsShared: true },
    { actor: member('an admin', () => users.admin), readsShared: true },
    { actor: member('a viewer', () => users.viewer), readsShared: false },
    { actor: member('a member limited to a branch', () => users.limited), readsShared: false },
    { actor: agentActor, readsShared: false },
    { actor: system, readsShared: true },
  ];
  // The owner and the admin, who may change a shared note.
  const managers = () => others.slice(1, 3).map((o) => o.actor);
  const run = <T>(actor: Actor, fn: (c: pg.Client) => Promise<T>) => inContext(actor.url(), actor.enter, fn);
  const outcome = <T>(p: Promise<T>) => p.then((value) => ({ ok: true as const, value }), (error: { code?: string; message: string }) => ({ ok: false as const, code: error.code ?? '', message: error.message }));

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
      return { db, runtime: new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...financeQueries] }) };
    };
    const api = runtimeFor(appUrl);
    const worker = runtimeFor(workerUrl).runtime;
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(api.db, { issuer: 'notes-private', subject: key, email: `${key}@notes-private.test`, name: null });
    }
    orgId = (await createOrg(api.runtime, asUser(users.owner), 'Ghi chú riêng')).orgId;
    await admin(async (c) => {
      branch = (await c.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id`, [orgId, users.owner]))
        .rows[0]?.id as string;
      await c.query(
        `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'viewer'), ($1, $6, 'member')`,
        [orgId, users.admin, users.author, users.member, users.viewer, users.limited],
      );
      await c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [
        orgId,
        users.limited,
        branch,
        users.owner,
      ]);
      await c.query(`INSERT INTO crove_kernel.party (org_id, id, name) VALUES ($1, $2, 'Công ty Khách')`, [orgId, notes.party]);
      await c.query(
        `INSERT INTO crove_notes.note (org_id, id, author_user_id, visibility, title, body, tags) VALUES
           ($1, $2, $4, 'private', $5, $5, ARRAY['riêng']), ($1, $3, $4, 'org', 'Giám đốc nghe máy sau 15h', '', ARRAY['khách'])`,
        [orgId, notes.private, notes.shared, users.author, SECRET],
      );
      await c.query(
        `INSERT INTO crove_notes.link (org_id, id, note_id, target_type, target_id, party_id, created_by) VALUES
           ($1, $2, $3, 'kernel.party', $6, $6, $7), ($1, $4, $5, 'kernel.party', $6, $6, $7)`,
        [orgId, notes.privateLink, notes.private, notes.sharedLink, notes.shared, notes.party, users.author],
      );
    });
    const installed = await api.runtime.execute<{ agentId: string; positionId: string }>(
      'kernel.agent.template.install',
      { templateKey: 'finance.chief_accountant', reportsTo: null },
      { actor: asMfa(users.owner), orgId },
    );
    await api.runtime.execute('kernel.task.create', { title: 'Việc thử', assigneePositionId: installed.positionId }, { actor: asUser(users.owner), orgId });
    const started = await worker.execute<{ runId: string | null }>('kernel.agent.run.start', { agentId: installed.agentId }, { actor: SYSTEM, orgId });
    agent = { agentId: installed.agentId, runId: started.runId as string };
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('shows the author both notes and their links', async () => {
    const seen = await run(author, async (c) => ({
      notes: (await c.query<{ id: string }>('SELECT id FROM crove_notes.note ORDER BY id')).rows.map((r) => r.id),
      links: (await c.query<{ id: string }>('SELECT id FROM crove_notes.link ORDER BY id')).rows.map((r) => r.id),
    }));
    expect(seen.notes).toEqual([notes.private, notes.shared].sort());
    expect(seen.links).toEqual([notes.privateLink, notes.sharedLink].sort());
  });

  it('lets no one but the author read the private note or its link, and the shared one only to whole-org members and the system', async () => {
    for (const { actor, readsShared } of others) {
      const seen = await run(actor, async (c) => ({
        notes: (await c.query<{ id: string }>('SELECT id FROM crove_notes.note')).rows.map((r) => r.id),
        byId: (await c.query('SELECT title, body, tags, search FROM crove_notes.note WHERE id = $1', [notes.private])).rowCount,
        // The link's own read policy goes through its note: asked for by id, the private note's link is not there.
        linkById: (await c.query('SELECT target_id FROM crove_notes.link WHERE id = $1', [notes.privateLink])).rowCount,
        searched: (await c.query(`SELECT id FROM crove_notes.note WHERE search @@ crove_kernel.search_query('mat khau')`)).rowCount,
        links: (await c.query<{ id: string }>('SELECT id FROM crove_notes.link')).rows.map((r) => r.id),
      }));
      expect(seen.byId, `${actor.name} reading the private note by id`).toBe(0);
      expect(seen.linkById, `${actor.name} reading the private note's link by id`).toBe(0);
      expect(seen.searched, `${actor.name} searching the private note's words`).toBe(0);
      expect(seen.notes, `${actor.name}'s notes`).toEqual(readsShared ? [notes.shared] : []);
      expect(seen.links, `${actor.name}'s links`).toEqual(readsShared ? [notes.sharedLink] : []);
    }
  });

  it('lets no one but the author change the private note, write one for the author, or touch its links', async () => {
    for (const { actor } of others) {
      const where = actor.name;
      const updated = await outcome(run(actor, (c) => c.query(`UPDATE crove_notes.note SET title = 'đổi', visibility = 'org' WHERE id = $1`, [notes.private])));
      if (updated.ok) expect(updated.value.rowCount, `${where} updating the private note`).toBe(0);
      else expect(updated, `${where} updating the private note`).toMatchObject({ code: '42501' });
      // A sweep with no WHERE clause reads no column, so no SELECT policy hides the private row from it: owners and admins
      // change the shared note alone, everyone else nothing.
      const swept = await outcome(run(actor, (c) => c.query(`UPDATE crove_notes.note SET pinned = true`)));
      if (swept.ok) expect(swept.value.rowCount, `${where} updating every note`).toBe(managers().includes(actor) ? 1 : 0);
      else expect(swept, `${where} updating every note`).toMatchObject({ code: '42501' });
      expect(await outcome(run(actor, (c) => c.query('DELETE FROM crove_notes.note WHERE id = $1', [notes.private]))), `${where} deleting the private note`).toMatchObject({ ok: false, code: '42501' });
      const forged = await outcome(
        run(actor, (c) => c.query(`INSERT INTO crove_notes.note (org_id, author_user_id, visibility, title) VALUES ($1, $2, 'private', 'giả')`, [orgId, users.author])),
      );
      expect(forged, `${where} writing a note as the author`).toMatchObject({ ok: false, code: '42501' });
      const linked = await outcome(
        run(actor, (c) =>
          c.query(`INSERT INTO crove_notes.link (org_id, note_id, target_type, target_id, party_id, created_by) VALUES ($1, $2, 'kernel.party', $3, $3, $4)`, [
            orgId,
            notes.private,
            notes.party,
            users.author,
          ]),
        ),
      );
      expect(linked, `${where} linking the private note`).toMatchObject({ ok: false, code: '42501' });
      const unlinked = await outcome(run(actor, (c) => c.query('DELETE FROM crove_notes.link')));
      if (unlinked.ok) expect(unlinked.value.rowCount, `${where} deleting every link`).toBe(0);
      else expect(unlinked, `${where} deleting every link`).toMatchObject({ code: '42501' });
    }
    const after = await admin((c) =>
      c.query<{ title: string; visibility: string; pinned: boolean }>('SELECT title, visibility, pinned FROM crove_notes.note WHERE id = $1', [notes.private]),
    );
    expect(after.rows).toEqual([{ title: SECRET, visibility: 'private', pinned: false }]);
  });

  it('lets owners and admins change a shared note but no other member, and the system context none', async () => {
    const pin = (c: pg.Client) => c.query('UPDATE crove_notes.note SET pinned = true WHERE id = $1', [notes.shared]);
    for (const { actor } of others) {
      const result = await outcome(run(actor, pin));
      const allowed = managers().includes(actor);
      if (result.ok) expect(result.value.rowCount, `${actor.name} pinning the shared note`).toBe(allowed ? 1 : 0);
      else expect(allowed, `${actor.name} pinning the shared note: ${result.message}`).toBe(false);
    }
    // An owner or admin keeps a shared note shared: the update policy's check refuses the new row.
    for (const actor of managers()) {
      expect(await outcome(run(actor, (c) => c.query(`UPDATE crove_notes.note SET visibility = 'private' WHERE id = $1`, [notes.shared]))), actor.name).toMatchObject({
        ok: false,
        code: '42501',
      });
    }
    // Only the author links the shared note, though others read it.
    for (const { actor } of others) {
      const linked = await outcome(
        run(actor, (c) =>
          c.query(`INSERT INTO crove_notes.link (org_id, note_id, target_type, target_id, party_id, created_by) VALUES ($1, $2, 'kernel.party', $3, $3, $4)`, [
            orgId,
            notes.shared,
            notes.party,
            users.author,
          ]),
        ),
      );
      expect(linked, `${actor.name} linking the shared note`).toMatchObject({ ok: false, code: '42501' });
    }
    // Nobody changes who wrote a note, not even the author.
    expect(await outcome(run(author, (c) => c.query('UPDATE crove_notes.note SET author_user_id = $2 WHERE id = $1', [notes.shared, users.member])))).toMatchObject({
      ok: false,
      code: '42501',
    });
  });

  it('keeps the author reading their own notes after their scope narrows to one entity', async () => {
    const seen = await admin(async (c) => {
      await c.query('BEGIN');
      try {
        await c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [
          orgId,
          users.author,
          branch,
          users.owner,
        ]);
        await c.query('COMMIT');
      } catch (error) {
        await c.query('ROLLBACK');
        throw error;
      }
      try {
        return await run(author, async (a) => (await a.query<{ id: string }>('SELECT id FROM crove_notes.note ORDER BY id')).rows.map((r) => r.id));
      } finally {
        await c.query(`DELETE FROM crove_kernel.role_assignment WHERE org_id = $1 AND user_id = $2`, [orgId, users.author]);
      }
    });
    expect(seen).toEqual([notes.private, notes.shared].sort());
  });

  it('reaches nothing through a forged context', async () => {
    const forged = await outcome(
      run(member('another member, forging the author', () => users.member), async (c) => {
        await c.query(`SELECT set_config('crove.ctx', (current_setting('crove.ctx')::jsonb || $1::jsonb)::text, true)`, [JSON.stringify({ user: users.author })]);
        return (await c.query('SELECT id FROM crove_notes.note WHERE id = $1', [notes.private])).rowCount;
      }),
    );
    // Refused outright, or the context no longer names a user: either way the note stays out of reach.
    expect(forged.ok ? forged.value : 0).toBe(0);
  });

  it('counts private notes for owners and admins and the system context only, with no text', async () => {
    const counts = (actor: Actor) => outcome(run(actor, (c) => c.query('SELECT * FROM crove_notes.private_counts()')));
    for (const actor of [member('an owner', () => users.owner), member('an admin', () => users.admin), system]) {
      const result = await counts(actor);
      expect(result, actor.name).toMatchObject({ ok: true });
      if (!result.ok) continue;
      expect(result.value.fields.map((f) => f.name), actor.name).toEqual(['org_id', 'author_user_id', 'notes']);
      expect(result.value.rows, actor.name).toEqual([{ org_id: orgId, author_user_id: users.author, notes: '1' }]);
    }
    for (const actor of [author, member('another member', () => users.member), member('a viewer', () => users.viewer), agentActor]) {
      expect(await counts(actor), actor.name).toMatchObject({ ok: false, code: '42501' });
    }
  });

  // The personal-data finder (#1678, ADR-0037 section 5): per author, how many private notes and to-dos mention a value,
  // for owners in their own context only (#1972); never which ones or their text.
  it('counts the private items that mention a value for owners only, with no text (#1678, #1972)', async () => {
    const mention = randomUUID();
    await admin((c) =>
      c.query(`INSERT INTO crove_notes.note (org_id, id, author_user_id, visibility, title, body) VALUES ($1, $2, $3, 'private', 'Gọi lại', 'Giam.Doc@khach.example')`, [
        orgId,
        mention,
        users.author,
      ]),
    );
    try {
      const matches = (actor: Actor) => outcome(run(actor, (c) => c.query(`SELECT * FROM crove_notes.private_matches('email', 'giam.doc@khach.example')`)));
      const owner = await matches(member('an owner', () => users.owner));
      expect(owner).toMatchObject({ ok: true });
      if (owner.ok) {
        expect(owner.value.fields.map((f) => f.name)).toEqual(['author_user_id', 'notes', 'todos']);
        expect(owner.value.rows).toEqual([{ author_user_id: users.author, notes: '1', todos: '0' }]);
      }
      // An admin too is refused (#1972): the counts are an oracle for a guessed value, so only owners, who send the
      // notice and erase, get them.
      for (const actor of [member('an admin', () => users.admin), author, member('another member', () => users.member), member('a viewer', () => users.viewer), agentActor, system]) {
        expect(await matches(actor), actor.name).toMatchObject({ ok: false, code: '42501' });
      }
    } finally {
      await admin((c) => c.query('DELETE FROM crove_notes.note WHERE org_id = $1 AND id = $2', [orgId, mention]));
    }
  });

  it('names and deletes private items that mention a value for owners only, deleting only what an earlier notice named and told (#1678)', async () => {
    const [named, unnamed] = [randomUUID(), randomUUID()];
    await admin((c) =>
      c.query(
        `INSERT INTO crove_notes.note (org_id, id, author_user_id, visibility, title, body) VALUES
           ($1, $2, $4, 'private', 'Gọi lại', 'Thu.Ky@khach.example'), ($1, $3, $4, 'private', 'Hẹn', 'thu.ky@khach.example')`,
        [orgId, named, unnamed, users.author],
      ),
    );
    // A notice's audit row names each item as '<id>:<revision>' and its event; the dispatch's notification proves the
    // author was told.
    const event = randomUUID();
    const notice = (command: string, ids: string[], key: string) =>
      admin((c) =>
        c.query(
          `INSERT INTO crove_kernel.audit_event (org_id, actor_type, actor_id, command, command_id, outcome, input_sha256, detail)
           VALUES ($1, 'user', $2, $3, $4, 'ok', $5, $6)`,
          [orgId, users.owner, command, randomUUID(), 'k1:' + '0'.repeat(64), JSON.stringify({ kind: 'email', key, notes: ids, todos: [], authors: 1, event })],
        ),
      );
    // The value's notice key: an owner's only, keyed, and different for another value.
    const keyOf = (actor: Actor, value: string) => outcome(run(actor, async (c) => (await c.query<{ key: string }>(`SELECT crove_notes.private_notice_key('email', $1) AS key`, [value])).rows[0]?.key));
    try {
      const keyed = await keyOf(member('an owner', () => users.owner), 'thu.ky@khach.example');
      const other = await keyOf(member('an owner', () => users.owner), 'khac@khach.example');
      expect(keyed).toMatchObject({ ok: true, value: expect.stringMatching(/^k1:[0-9a-f]{64}$/) });
      expect(other).toMatchObject({ ok: true });
      const key = keyed.ok ? String(keyed.value) : '';
      expect(other.ok && other.value).not.toBe(key);
      const items = (actor: Actor) => outcome(run(actor, (c) => c.query(`SELECT * FROM crove_notes.private_notice_items('email', 'thu.ky@khach.example')`)));
      const owned = await items(member('an owner', () => users.owner));
      expect(owned).toMatchObject({ ok: true });
      if (owned.ok) {
        // Ids, authors and revisions, never text.
        expect(owned.value.fields.map((f) => f.name)).toEqual(['item_type', 'item_id', 'author_user_id', 'revision']);
        expect(owned.value.rows).toEqual(
          [named, unnamed].sort().map((id) => ({ item_type: 'note', item_id: id, author_user_id: users.author, revision: 1 })),
        );
      }
      const erase = (actor: Actor) => outcome(run(actor, (c) => c.query(`SELECT * FROM crove_notes.private_erase('email', 'thu.ky@khach.example')`)));
      const owner = member('an owner', () => users.owner);
      // No notice yet: nothing is deleted, and both are counted as not told.
      expect(await erase(owner)).toMatchObject({ ok: true, value: { rows: [{ author_user_id: users.author, notes: '0', todos: '0', untold_notes: '2', untold_todos: '0' }] } });
      // A row of another command naming an item is no notice, nor is a notice of an earlier revision.
      await notice('kernel.personal_data.erase', [`${unnamed}:1`], key);
      // Nor is a notice sent for another value, which names both.
      await notice('kernel.personal_data.notify', [`${named}:1`, `${unnamed}:1`], other.ok ? String(other.value) : '');
      await notice('kernel.personal_data.notify', [`${named}:1`, `${unnamed}:7`], key);
      const untold = { ok: true, value: { rows: [{ author_user_id: users.author, notes: '0', todos: '0', untold_notes: '2', untold_todos: '0' }] } };
      // Named, but the author has no notification of that notice yet (the worker has not dispatched it): kept.
      expect(await erase(owner)).toMatchObject(untold);
      await admin((c) =>
        c.query(`INSERT INTO crove_kernel.notification (org_id, user_id, kind, dedupe_key) VALUES ($1, $2, 'kernel.personal_data_notice', $3)`, [
          orgId,
          users.author,
          `personal_data_notice:${event}`,
        ]),
      );
      // Told, but less than 24 hours ago: still kept, so the author can read the notice and take their items.
      expect(await erase(owner)).toMatchObject(untold);
      // Moves this org's rows of one table back 25 hours, its append-only trigger set aside for that transaction.
      const age = (sql: string) =>
        admin(async (c) => {
          await c.query('BEGIN');
          await c.query('SET LOCAL session_replication_role = replica');
          await c.query(sql, [orgId]);
          await c.query('COMMIT');
        });
      // The notice a day old, its notification still fresh: kept.
      await age(`UPDATE crove_kernel.audit_event SET occurred_at = occurred_at - interval '25 hours' WHERE org_id = $1 AND command LIKE 'kernel.personal_data.%'`);
      expect(await erase(owner)).toMatchObject(untold);
      // Both a day old: the named item goes, by id.
      await age(`UPDATE crove_kernel.notification SET created_at = created_at - interval '25 hours' WHERE org_id = $1 AND kind = 'kernel.personal_data_notice'`);
      expect(await erase(owner)).toMatchObject({
        ok: true,
        value: { rows: [{ author_user_id: users.author, notes: '1', todos: '0', untold_notes: '1', untold_todos: '0', note_ids: [named], todo_ids: [] }] },
      });
      for (const actor of [member('an admin', () => users.admin), author, member('another member', () => users.member), member('a viewer', () => users.viewer), agentActor, system]) {
        expect(await items(actor), actor.name).toMatchObject({ ok: false, code: '42501' });
        expect(await erase(actor), actor.name).toMatchObject({ ok: false, code: '42501' });
        expect(await keyOf(actor, 'thu.ky@khach.example'), actor.name).toMatchObject({ ok: false, code: '42501' });
      }
      // run() rolled the owner's erasure back: both notes are still there.
      expect((await admin((c) => c.query('SELECT count(*)::int AS n FROM crove_notes.note WHERE org_id = $1 AND id = ANY($2)', [orgId, [named, unnamed]]))).rows[0]).toEqual({ n: 2 });
    } finally {
      await admin((c) => c.query('DELETE FROM crove_notes.note WHERE org_id = $1 AND id = ANY($2)', [orgId, [named, unnamed]]));
      await admin((c) => c.query(`DELETE FROM crove_kernel.notification WHERE org_id = $1 AND kind = 'kernel.personal_data_notice'`, [orgId]));
    }
  });

  it('keeps the worker definers to the worker login in the system context', async () => {
    const sampleAttachmentId = randomUUID();
    const calls: Array<[string, unknown[]]> = [
      ['SELECT * FROM crove_notes.trash_due(now(), 10)', []],
      ['SELECT crove_notes.trash_empty(now())', []],
      ['SELECT crove_notes.member_items_purge($1::uuid)', [users.author]],
      ['SELECT * FROM crove_notes.attachment_for_extract($1::uuid)', [sampleAttachmentId]],
      ['SELECT crove_notes.attachment_record_extract($1::uuid, $2::text, $3::text)', [sampleAttachmentId, 'done', 'ok']],
      ['SELECT * FROM crove_notes.attachment_blob_claim(10)', []],
      ['SELECT crove_notes.attachment_blob_done(ARRAY[]::text[])', []],
      ['SELECT * FROM crove_notes.attachment_extract_due(10)', []],
    ];
    for (const [text, values] of calls) {
      for (const actor of [author, member('an owner', () => users.owner), agentActor]) {
        expect(await outcome(run(actor, (c) => c.query(text, values))), `${actor.name}: ${text}`).toMatchObject({ ok: false, code: '42501' });
      }
    }
    // The worker login outside the system context: the org-scoped definers refuse.
    for (const [text, values] of calls.slice(1, 5)) {
      expect(await outcome(inContext(workerUrl, async () => {}, (c) => c.query(text, values))), `no context: ${text}`).toMatchObject({ ok: false, code: '42501' });
    }
  });

  it('isolates private note attachments across every non-author role, Member Vy, agents and system context, without touching crove_kernel.file (#3561)', async () => {
    const privAtt = randomUUID();
    const sharedAtt = randomUUID();
    const privSha = '1'.repeat(64);
    const sharedSha = '2'.repeat(64);
    const vyOtherAgent = randomUUID();
    const vyOtherRun = randomUUID();
    const vyAuthorAgent = randomUUID();
    const vyAuthorRun = randomUUID();
    const filesBefore = (await admin((c) => c.query<{ n: number }>('SELECT count(*)::int AS n FROM crove_kernel.file WHERE org_id = $1', [orgId]))).rows[0]?.n ?? 0;

    await admin(async (c) => {
      const feat = await aiRunFeature(c);
      const featSqlCols = feat.cols;
      const featValsClause = feat.vals;
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(
        `INSERT INTO crove_kernel.agent (org_id, id, template_key, display_name, kind, member_user_id, created_by)
         VALUES ($1, $2, 'kernel.member_vy', 'Vy member', 'member_vy', $3, $3),
                ($1, $4, 'kernel.member_vy', 'Vy author', 'member_vy', $5, $5)`,
        [orgId, vyOtherAgent, users.member, vyAuthorAgent, users.author],
      );
      await c.query(
        `INSERT INTO crove_kernel.ai_run (org_id, id, agent_id, module, status, started_at, expires_at${featSqlCols})
         VALUES ($1, $2, $3, 'notes', 'running', now(), now() + interval '1 hour'${featValsClause}),
                ($1, $4, $5, 'notes', 'running', now(), now() + interval '1 hour'${featValsClause})`,
        [orgId, vyOtherRun, vyOtherAgent, vyAuthorRun, vyAuthorAgent],
      );
      await c.query('COMMIT');
      await c.query(
        `INSERT INTO crove_notes.attachment (org_id, id, note_id, author_user_id, filename, content_type, size_bytes, sha256, storage_key, extracted_text, extract_status)
         VALUES ($1, $2, $3, $4, 'hop-dong-rieng.pdf', 'application/pdf', 512, $5, $6, 'Biên bản đối soát ngân quỹ nội bộ', 'done'),
                ($1, $7, $8, $4, 'tai-lieu-chung.pdf', 'application/pdf', 256, $9, $10, 'Lịch họp chung toàn công ty', 'done')`,
        [
          orgId,
          privAtt,
          notes.private,
          users.author,
          privSha,
          `notes/${orgId}/${privAtt}`,
          sharedAtt,
          notes.shared,
          sharedSha,
          `notes/${orgId}/${sharedAtt}`,
        ],
      );
    });

    // The note search of notes.note.search: a note by its own words or by one of its attachments' (#3561).
    const noteSearchSql = (q: string) =>
      `SELECT n.id FROM crove_notes.note n WHERE n.search @@ crove_kernel.search_query('${q}')
          OR EXISTS (SELECT 1 FROM crove_notes.attachment a WHERE a.org_id = n.org_id AND a.note_id = n.id AND a.search @@ crove_kernel.search_query('${q}'))`;
    const memberVyOther: Actor = {
      name: 'Member Vy of another member',
      url: () => workerUrl,
      enter: (c) => c.query('SELECT crove_kernel.enter_member_vy_context($1::uuid, $2::uuid, $3::uuid)', [orgId, vyOtherAgent, vyOtherRun]),
    };
    const memberVyAuthor: Actor = {
      name: 'Member Vy of the author',
      url: () => workerUrl,
      enter: (c) => c.query('SELECT crove_kernel.enter_member_vy_context($1::uuid, $2::uuid, $3::uuid)', [orgId, vyAuthorAgent, vyAuthorRun]),
    };

    try {
      const filesAfter = (await admin((c) => c.query<{ n: number }>('SELECT count(*)::int AS n FROM crove_kernel.file WHERE org_id = $1', [orgId]))).rows[0]?.n ?? 0;
      expect(filesAfter, 'crove_kernel.file must stay untouched').toBe(filesBefore);

      // Author reads both attachments and finds the private note via unaccented attachment extracted_text search.
      const authorSeen = await run(author, async (c) => ({
        ids: (await c.query<{ id: string }>('SELECT id FROM crove_notes.attachment ORDER BY id')).rows.map((r) => r.id),
        bySearch: (await c.query<{ id: string }>(noteSearchSql('ngan quy noi bo'))).rows.map((r) => r.id),
        byFilename: (await c.query<{ id: string }>(noteSearchSql('hop dong rieng'))).rows.map((r) => r.id),
        // The note's own vector holds none of its attachments' words, so a Member Vy that reads the note learns none of them.
        byNoteVector: (await c.query(`SELECT id FROM crove_notes.note WHERE search @@ crove_kernel.search_query('ngan quy noi bo')`)).rowCount,
      }));
      expect(authorSeen.ids).toEqual([privAtt, sharedAtt].sort());
      expect(authorSeen.bySearch).toEqual([notes.private]);
      expect(authorSeen.byFilename).toEqual([notes.private]);
      expect(authorSeen.byNoteVector).toBe(0);

      // Every non-author actor (and both Member Vy contexts) cannot read, probe by sha256, search, update or delete the private attachment.
      const probes: Array<{ actor: Actor; readsSharedAttachment: boolean; canDeleteShared: boolean }> = [
        ...others.map((o) => ({
          actor: o.actor,
          readsSharedAttachment: o.readsShared,
          canDeleteShared: managers().includes(o.actor),
        })),
        { actor: memberVyOther, readsSharedAttachment: false, canDeleteShared: false },
        { actor: memberVyAuthor, readsSharedAttachment: false, canDeleteShared: false },
      ];

      for (const { actor, readsSharedAttachment, canDeleteShared } of probes) {
        const seen = await run(actor, async (c) => ({
          ids: (await c.query<{ id: string }>('SELECT id FROM crove_notes.attachment')).rows.map((r) => r.id),
          byId: (await c.query('SELECT id FROM crove_notes.attachment WHERE id = $1', [privAtt])).rowCount,
          bySha: (await c.query('SELECT id FROM crove_notes.attachment WHERE sha256 = $1', [privSha])).rowCount,
          byExtractedSearch: (await c.query(noteSearchSql('ngan quy noi bo'))).rowCount,
          byFilenameSearch: (await c.query(noteSearchSql('hop dong rieng'))).rowCount,
        }));
        expect(seen.byId, `${actor.name} reading private attachment by id`).toBe(0);
        expect(seen.bySha, `${actor.name} probing private attachment by sha256`).toBe(0);
        expect(seen.byExtractedSearch, `${actor.name} searching private attachment extracted_text`).toBe(0);
        expect(seen.byFilenameSearch, `${actor.name} searching private attachment filename`).toBe(0);
        expect(seen.ids, `${actor.name} visible attachments`).toEqual(readsSharedAttachment ? [sharedAtt] : []);

        // UPDATE privilege is revoked from crove_tenant and crove_worker.
        const updated = await outcome(run(actor, (c) => c.query(`UPDATE crove_notes.attachment SET filename = 'hack.pdf' WHERE id = $1`, [privAtt])));
        expect(updated.ok, `${actor.name} updating private attachment`).toBe(false);

        const deletedPriv = await outcome(run(actor, (c) => c.query('DELETE FROM crove_notes.attachment WHERE id = $1', [privAtt])));
        if (deletedPriv.ok) expect(deletedPriv.value.rowCount, `${actor.name} deleting private attachment`).toBe(0);
        else expect(deletedPriv, `${actor.name} deleting private attachment`).toMatchObject({ code: '42501' });

        const sweptDelete = await outcome(run(actor, (c) => c.query('DELETE FROM crove_notes.attachment')));
        if (sweptDelete.ok) expect(sweptDelete.value.rowCount, `${actor.name} sweeping attachment delete`).toBe(canDeleteShared ? 1 : 0);
        else expect(sweptDelete, `${actor.name} sweeping attachment delete`).toMatchObject({ code: '42501' });

        const forgedInsert = await outcome(
          run(actor, (c) =>
            c.query(
              `INSERT INTO crove_notes.attachment (org_id, id, note_id, author_user_id, filename, content_type, size_bytes, sha256, storage_key)
               VALUES ($1, $2, $3, $4, 'gia.pdf', 'application/pdf', 10, $5, $6)`,
              [orgId, randomUUID(), notes.private, users.author, '3'.repeat(64), `notes/${orgId}/${randomUUID()}`],
            ),
          ),
        );
        expect(forgedInsert, `${actor.name} inserting into private note`).toMatchObject({ ok: false, code: '42501' });
      }
    } finally {
      await admin(async (c) => {
        await c.query('DELETE FROM crove_notes.attachment WHERE org_id = $1 AND id = ANY($2)', [orgId, [privAtt, sharedAtt]]);
        await c.query('DELETE FROM crove_notes.attachment_blob_doomed WHERE storage_key = ANY($1)', [
          [`notes/${orgId}/${privAtt}`, `notes/${orgId}/${sharedAtt}`],
        ]);
        await c.query('BEGIN');
        await c.query('SET LOCAL session_replication_role = replica');
        await c.query('DELETE FROM crove_kernel.ai_run WHERE org_id = $1 AND id = ANY($2)', [orgId, [vyOtherRun, vyAuthorRun]]);
        await c.query('DELETE FROM crove_kernel.agent WHERE org_id = $1 AND id = ANY($2)', [orgId, [vyOtherAgent, vyAuthorAgent]]);
        await c.query('COMMIT');
      });
    }
  });

  it('isolates private and shared notebooks across every actor, including Member Vy, and counts private notebooks without text (#3559)', async () => {
    const [privNb, sharedNb] = [randomUUID(), randomUUID()];
    const [vyAgent, vyRun] = [randomUUID(), randomUUID()];
    await admin(async (c) => {
      await c.query(
        `INSERT INTO crove_notes.notebook (org_id, id, author_user_id, visibility, name, stack_name, sort_key) VALUES
           ($1, $2, $4, 'private', 'Sổ lương bí mật', 'Nhân sự riêng', 'a0'),
           ($1, $3, $4, 'org', 'Sổ khách hàng chung', 'Kinh doanh', 'a1')`,
        [orgId, privNb, sharedNb, users.author],
      );
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(
        `INSERT INTO crove_kernel.agent (org_id, id, template_key, display_name, kind, member_user_id, created_by)
         VALUES ($1, $2, 'kernel.member_vy', 'Vy', 'member_vy', $3, $3)`,
        [orgId, vyAgent, users.author],
      );
      await c.query(
        `INSERT INTO crove_kernel.ai_run (org_id, id, agent_id, module, feature, status, started_at, expires_at)
         VALUES ($1, $2, $3, 'notes', 'notes.summary', 'running', now(), now() + interval '2 hours')`,
        [orgId, vyRun, vyAgent],
      );
      await c.query('COMMIT');
    });
    const memberVy: Actor = {
      name: 'Member Vy of the author',
      url: () => workerUrl,
      enter: (c) => c.query('SELECT crove_kernel.enter_member_vy_context($1::uuid, $2::uuid, $3::uuid)', [orgId, vyAgent, vyRun]),
    };

    try {
      const authorSeen = await run(author, async (c) =>
        (await c.query<{ id: string }>('SELECT id FROM crove_notes.notebook ORDER BY id')).rows.map((r) => r.id),
      );
      expect(authorSeen).toEqual([privNb, sharedNb].sort());

      for (const { actor, readsShared } of [...others, { actor: memberVy, readsShared: false }]) {
        const seen = await run(actor, async (c) => ({
          ids: (await c.query<{ id: string }>('SELECT id FROM crove_notes.notebook ORDER BY id')).rows.map((r) => r.id),
          privById: (await c.query('SELECT name, stack_name FROM crove_notes.notebook WHERE id = $1', [privNb])).rowCount,
        }));
        expect(seen.privById, `${actor.name} reading private notebook by id`).toBe(0);
        expect(seen.ids, `${actor.name} reading notebooks`).toEqual(readsShared ? [sharedNb] : []);

        const updPriv = await outcome(run(actor, (c) => c.query(`UPDATE crove_notes.notebook SET name = 'Đổi' WHERE id = $1`, [privNb])));
        if (updPriv.ok) expect(updPriv.value.rowCount, `${actor.name} updating private notebook`).toBe(0);
        else expect(updPriv, `${actor.name} updating private notebook`).toMatchObject({ code: '42501' });

        const delPriv = await outcome(run(actor, (c) => c.query('DELETE FROM crove_notes.notebook WHERE id = $1', [privNb])));
        if (delPriv.ok) expect(delPriv.value.rowCount, `${actor.name} deleting private notebook`).toBe(0);
        else expect(delPriv, `${actor.name} deleting private notebook`).toMatchObject({ code: '42501' });

        const forgedInsert = await outcome(
          run(actor, (c) =>
            c.query(`INSERT INTO crove_notes.notebook (org_id, author_user_id, visibility, name) VALUES ($1, $2, 'private', 'Giả')`, [
              orgId,
              users.author,
            ]),
          ),
        );
        expect(forgedInsert, `${actor.name} forging author notebook`).toMatchObject({ ok: false, code: '42501' });
      }

      // Owners and admins may rename/pin a shared notebook, but cannot flip another author's shared notebook to private.
      for (const actor of managers()) {
        const pinned = await outcome(run(actor, (c) => c.query('UPDATE crove_notes.notebook SET pinned = true WHERE id = $1', [sharedNb])));
        expect(pinned, `${actor.name} pinning shared notebook`).toMatchObject({ ok: true, value: { rowCount: 1 } });

        const flipped = await outcome(
          run(actor, (c) => c.query(`UPDATE crove_notes.notebook SET visibility = 'private' WHERE id = $1`, [sharedNb])),
        );
        expect(flipped, `${actor.name} making author's shared notebook private`).toMatchObject({ ok: false, code: '42501' });
      }

      // Narrowing the author's scope to one branch still keeps their own private notebook readable, and blocks creating shared ones.
      await admin(async (c) => {
        await c.query(
          `INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by)
           VALUES ($1, $2, 'external_accountant', $3, $4)`,
          [orgId, users.author, branch, users.owner],
        );
        try {
          const seenNarrowed = await run(author, async (a) =>
            (await a.query<{ id: string }>('SELECT id FROM crove_notes.notebook ORDER BY id')).rows.map((r) => r.id),
          );
          expect(seenNarrowed).toEqual([privNb, sharedNb].sort());
          const createSharedNarrowed = await outcome(
            run(author, (a) =>
              a.query(`INSERT INTO crove_notes.notebook (org_id, author_user_id, visibility, name) VALUES ($1, $2, 'org', 'Chung')`, [
                orgId,
                users.author,
              ]),
            ),
          );
          expect(createSharedNarrowed).toMatchObject({ ok: false, code: '42501' });
        } finally {
          await c.query('DELETE FROM crove_kernel.role_assignment WHERE org_id = $1 AND user_id = $2', [orgId, users.author]);
        }
      });

      // private_notebook_counts(): owners, admins and worker system context only, counts only, zero text.
      const nbCounts = (actor: Actor) => outcome(run(actor, (c) => c.query('SELECT * FROM crove_notes.private_notebook_counts()')));
      for (const actor of [member('an owner', () => users.owner), member('an admin', () => users.admin), system]) {
        const res = await nbCounts(actor);
        expect(res, actor.name).toMatchObject({ ok: true });
        if (!res.ok) continue;
        expect(res.value.fields.map((f) => f.name), actor.name).toEqual(['org_id', 'author_user_id', 'notebooks']);
        expect(res.value.rows, actor.name).toEqual([{ org_id: orgId, author_user_id: users.author, notebooks: '1' }]);
      }
      for (const actor of [author, member('another member', () => users.member), member('a viewer', () => users.viewer), agentActor, memberVy]) {
        expect(await nbCounts(actor), actor.name).toMatchObject({ ok: false, code: '42501' });
      }
    } finally {
      await admin(async (c) => {
        await c.query('DELETE FROM crove_notes.notebook WHERE org_id = $1 AND id = ANY($2)', [orgId, [privNb, sharedNb]]);
        await c.query('BEGIN');
        await c.query('SET LOCAL session_replication_role = replica');
        await c.query('DELETE FROM crove_kernel.ai_run WHERE org_id = $1 AND id = $2', [orgId, vyRun]);
        await c.query('DELETE FROM crove_kernel.agent WHERE org_id = $1 AND id = $2', [orgId, vyAgent]);
        await c.query('COMMIT');
      });
    }
  });

  it('enforces note.notebook_id visibility invariants, detaches other private notes on privatization, and leaks zero existence oracle (#3559)', async () => {
    const [privNb, sharedNb, missingNb, otherPrivNote] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await admin(async (c) => {
      await c.query(
        `INSERT INTO crove_notes.notebook (org_id, id, author_user_id, visibility, name, sort_key) VALUES
           ($1, $2, $4, 'private', 'Sổ riêng của tác giả', 'a0'),
           ($1, $3, $4, 'org', 'Sổ dùng chung của tác giả', 'a1')`,
        [orgId, privNb, sharedNb, users.author],
      );
      await c.query(
        `INSERT INTO crove_notes.note (org_id, id, author_user_id, visibility, notebook_id, title, body)
         VALUES ($1, $2, $3, 'private', $4, 'Ghi chú riêng của thành viên khác trong sổ chung', '')`,
        [orgId, otherPrivNote, users.member, sharedNb],
      );
    });

    try {
      // 1) Shared ('org') note CANNOT point to a 'private' notebook (even for the notebook's own author).
      const sharedInPriv = await outcome(
        run(author, (c) => c.query('UPDATE crove_notes.note SET notebook_id = $2 WHERE id = $1', [notes.shared, privNb])),
      );
      expect(sharedInPriv).toMatchObject({ ok: false, code: '23514' });

      const insertSharedInPriv = await outcome(
        run(author, (c) =>
          c.query(
            `INSERT INTO crove_notes.note (org_id, author_user_id, visibility, notebook_id, title) VALUES ($1, $2, 'org', $3, 'Chung sai')`,
            [orgId, users.author, privNb],
          ),
        ),
      );
      expect(insertSharedInPriv).toMatchObject({ ok: false, code: '23514' });

      // 2) While a shared note belongs to sharedNb, turning sharedNb 'private' is refused with 23514.
      await admin((c) => c.query('UPDATE crove_notes.note SET notebook_id = $2 WHERE org_id = $1 AND id = $3', [orgId, sharedNb, notes.shared]));
      const privatizeWithSharedNote = await outcome(
        run(author, (c) => c.query(`UPDATE crove_notes.notebook SET visibility = 'private' WHERE id = $1`, [sharedNb])),
      );
      expect(privatizeWithSharedNote).toMatchObject({ ok: false, code: '23514' });
      await admin((c) => c.query('UPDATE crove_notes.note SET notebook_id = NULL WHERE org_id = $1 AND id = $2', [orgId, notes.shared]));

      // 3) Zero existence oracle: probing author's private notebook vs a non-existent UUID returns identical 42501 for both
      // another member writing their own note AND an owner updating the author's shared note.
      const otherMember = member('another member', () => users.member);
      const probeMemberReal = await outcome(
        run(otherMember, (c) => c.query('UPDATE crove_notes.note SET notebook_id = $2 WHERE id = $1', [otherPrivNote, privNb])),
      );
      const probeMemberFake = await outcome(
        run(otherMember, (c) => c.query('UPDATE crove_notes.note SET notebook_id = $2 WHERE id = $1', [otherPrivNote, missingNb])),
      );
      expect(probeMemberReal).toMatchObject({ ok: false, code: '42501' });
      expect(probeMemberFake).toMatchObject({ ok: false, code: '42501' });
      expect(probeMemberReal.ok ? '' : probeMemberReal.code).toBe(probeMemberFake.ok ? '' : probeMemberFake.code);

      const ownerActor = member('an owner', () => users.owner);
      const probeOwnerReal = await outcome(
        run(ownerActor, (c) => c.query('UPDATE crove_notes.note SET notebook_id = $2 WHERE id = $1', [notes.shared, privNb])),
      );
      const probeOwnerFake = await outcome(
        run(ownerActor, (c) => c.query('UPDATE crove_notes.note SET notebook_id = $2 WHERE id = $1', [notes.shared, missingNb])),
      );
      expect(probeOwnerReal).toMatchObject({ ok: false, code: '42501' });
      expect(probeOwnerFake).toMatchObject({ ok: false, code: '42501' });
      expect(probeOwnerReal.ok ? '' : probeOwnerReal.code).toBe(probeOwnerFake.ok ? '' : probeOwnerFake.code);

      // 4) Turning sharedNb 'private' when no 'org' note references it detaches another member's private note cleanly.
      const c = new pg.Client({ connectionString: appUrl });
      await c.connect();
      try {
        await c.query('BEGIN');
        await author.enter(c);
        await c.query(`UPDATE crove_notes.notebook SET visibility = 'private' WHERE id = $1`, [sharedNb]);
        await c.query('COMMIT');
      } finally {
        await c.end();
      }
      const detached = await admin((a) =>
        a.query<{ notebook_id: string | null }>('SELECT notebook_id FROM crove_notes.note WHERE org_id = $1 AND id = $2', [orgId, otherPrivNote]),
      );
      expect(detached.rows).toEqual([{ notebook_id: null }]);

      // 5) PDPL private_matches & private_notice_items include private notebooks (name and stack_name) for owners only.
      await admin((a) =>
        a.query(`UPDATE crove_notes.notebook SET stack_name = 'lien.he@khach.example' WHERE org_id = $1 AND id = $2`, [orgId, privNb]),
      );
      const pdplCount = await outcome(
        run(ownerActor, (a) => a.query(`SELECT * FROM crove_notes.private_matches('email', 'lien.he@khach.example')`)),
      );
      expect(pdplCount).toMatchObject({
        ok: true,
        value: { rows: [{ author_user_id: users.author, notes: '1', todos: '0' }] },
      });
      const pdplItems = await outcome(
        run(ownerActor, (a) => a.query(`SELECT * FROM crove_notes.private_notice_items('email', 'lien.he@khach.example')`)),
      );
      expect(pdplItems).toMatchObject({
        ok: true,
        value: { rows: [{ item_type: 'notebook', item_id: privNb, author_user_id: users.author, revision: 1 }] },
      });
    } finally {
      await admin(async (c) => {
        await c.query('DELETE FROM crove_notes.note WHERE org_id = $1 AND id = $2', [orgId, otherPrivNote]);
        await c.query('UPDATE crove_notes.note SET notebook_id = NULL WHERE org_id = $1 AND id = $2', [orgId, notes.shared]);
        await c.query('DELETE FROM crove_notes.notebook WHERE org_id = $1 AND id = ANY($2)', [orgId, [privNb, sharedNb]]);
      });
    }
  });

  // Last: it removes the author from the org.
  it("removes a former member's private notes only once they are no longer a member, and keeps their shared ones", async () => {
    const purge = () => run(system, async (c) => (await c.query<{ n: string }>('SELECT crove_notes.member_items_purge($1::uuid) AS n', [users.author])).rows[0]?.n);
    expect(await purge()).toBe('0');
    await admin((c) => c.query('DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [orgId, users.author]));
    // run() rolls back, so the purge is committed here as the worker would.
    const c = new pg.Client({ connectionString: workerUrl });
    await c.connect();
    let purged: string | undefined;
    try {
      await c.query('BEGIN');
      await system.enter(c);
      purged = (await c.query<{ n: string }>('SELECT crove_notes.member_items_purge($1::uuid) AS n', [users.author])).rows[0]?.n;
      await c.query('COMMIT');
    } finally {
      await c.end();
    }
    expect(purged).toBe('1');
    // A second run finds nothing more to remove.
    expect(await purge()).toBe('0');
    const remaining = await admin((a) => a.query<{ id: string }>('SELECT id FROM crove_notes.note WHERE org_id = $1 ORDER BY id', [orgId]));
    expect(remaining.rows.map((r) => r.id)).toEqual([notes.shared]);
  });

  it("lists and purges a former member's private notebooks while keeping their shared notebooks (#3559)", async () => {
    const [privNb, sharedNb] = [randomUUID(), randomUUID()];
    await admin((c) =>
      c.query(
        `INSERT INTO crove_notes.notebook (org_id, id, author_user_id, visibility, name, sort_key) VALUES
           ($1, $2, $4, 'private', 'Sổ riêng cũ', 'a0'),
           ($1, $3, $4, 'org', 'Sổ chung giữ lại', 'a1')`,
        [orgId, privNb, sharedNb, users.author],
      ),
    );
    const due = await inContext(
      workerUrl,
      async () => {},
      async (c) => (await c.query<{ org_id: string; user_id: string }>('SELECT org_id, user_id FROM crove_notes.former_members_due(100)')).rows,
    );
    expect(due).toContainEqual({ org_id: orgId, user_id: users.author });

    const c = new pg.Client({ connectionString: workerUrl });
    await c.connect();
    let purged: string | undefined;
    try {
      await c.query('BEGIN');
      await system.enter(c);
      purged = (await c.query<{ n: string }>('SELECT crove_notes.member_items_purge($1::uuid) AS n', [users.author])).rows[0]?.n;
      await c.query('COMMIT');
    } finally {
      await c.end();
    }
    expect(purged).toBe('1');
    const left = await admin((a) => a.query<{ id: string }>('SELECT id FROM crove_notes.notebook WHERE org_id = $1 ORDER BY id', [orgId]));
    expect(left.rows.map((r) => r.id)).toEqual([sharedNb]);
  });
});
