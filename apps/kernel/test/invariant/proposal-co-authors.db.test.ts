// SPDX-License-Identifier: AGPL-3.0-only
// The co-authors of a proposal (#2736, finding F3 of the security review of #2731; plan §4.7 P10) on PostgreSQL 17, as the real login roles:
// - a proposal's preparer may declare people it rests on besides the requester (the approver of the pay run a posting proposal posts); the column is `crove_kernel.proposal.co_authors`, and
//   only a user's new pending proposal of a command in the list (finance.payroll_posting.record) may carry any: one to ten ids, none null. The system context, an agent, every other command,
//   an approved proposal and an empty or null-holding list are refused, and nobody changes the column of a row that exists. The "no other author" rule of `authors` is untouched;
// - the database gate (`crove_kernel.proposal_approve`) holds them back like authors, but they never grant: none of them approves while another eligible approver exists who is neither an author
//   nor a co-author (FOUR_EYES_REQUIRED), and never under the accountant preset; the one-person path and the owner override are judged on the written authors alone, so a co-author list
//   forged in raw SQL cannot let the requester approve their own posting; without co-authors the same person approves;
// - the database and approval.ts decide every such case alike;
// - the list in the trigger is the list in approval.ts (PROPOSAL_CO_AUTHOR_COMMANDS).
// Staff (the database owner) are not checked. Part of the invariant suite: keep it self-contained (package code under test, no helpers from outside test/invariant/). Set CROVE_TEST_ADMIN_URL to
// a superuser URL; the run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { sql } from 'kysely';
import { PROPOSAL_CO_AUTHOR_COMMANDS, createOrg, decideApproval, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { contextToken } from './fixtures/context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const SYSTEM = { type: 'system' as const, component: 'kernel.agent' };
const COMMAND = 'finance.payroll_posting.record';
const REFUSED = { code: '23514', message: 'PROPOSAL_STATUS_TRANSITION' };
const suite = ADMIN ? describe : describe.skip;

suite('the co-authors of a proposal on PostgreSQL (#2736)', () => {
  const dbName = `crove_test_co_authors_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  const pools: pg.Pool[] = [];
  let app: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  interface Org {
    orgId: string;
    owner: string;
    admin: string;
    admin2: string;
    chief: string;
  }
  let big: Org; // an owner and two admins
  let solo: Org; // an owner alone

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  type Outcome<T> = { ok: true; value: T } | { ok: false; code: string | undefined; message: string };
  // One statement block in its own transaction, rolled back: a login role and the context it enters.
  async function inContext<T>(url: string, enter: (c: pg.Client) => Promise<unknown>, fn: (c: pg.Client) => Promise<T>): Promise<Outcome<T>> {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      await c.query('BEGIN');
      await enter(c);
      return { ok: true, value: await fn(c) };
    } catch (error) {
      const e = error as { code?: string; message: string };
      return { ok: false, code: e.code, message: e.message };
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  }
  // A second chief accountant of the big org (a member holding the approval permission org-wide), for the recovery case.
  async function person2(): Promise<string> {
    const db = createDb(pools[0] as pg.Pool);
    const id = await upsertIdentity(db, { issuer: 't2736', subject: randomUUID(), email: `chief2-${randomUUID().slice(0, 6)}@t2736.test`, name: null });
    await admin(async (c) => {
      await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [big.orgId, id]);
      await c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'finance.chief_accountant', NULL, $3)`, [big.orgId, id, big.owner]);
    });
    return id;
  }
  const asUserIn = <T>(o: Org, userId: string, fn: (c: pg.Client) => Promise<T>) =>
    inContext(appUrl, (c) => c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [o.orgId, contextToken(userId, o.orgId)]), fn);
  const asSystemIn = <T>(o: Org, fn: (c: pg.Client) => Promise<T>) => inContext(workerUrl, (c) => c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [o.orgId]), fn);

  // The insert a requester's command makes: the requester alone among the authors, the co-authors beside them.
  const insertSql = `INSERT INTO crove_kernel.proposal (org_id, kind, command, status, title, payload, authors, co_authors, request_input)
                     VALUES ($1, 'journal_voucher', $2, 'pending', 'T2736', '{}', $3::jsonb, $4::uuid[], '{}') RETURNING id`;
  const authorsOf = (userId: string) => JSON.stringify([{ type: 'user', id: userId }]);

  // A pending proposal written by the database owner (staff are not checked), with the snapshot given.
  async function pending(o: Org, author: string, coAuthors: string[] | null, snapshot: string[], command = COMMAND): Promise<{ id: string; revision: number }> {
    return admin(async (c) => {
      const r = await c.query<{ id: string; revision: number }>(
        `INSERT INTO crove_kernel.proposal (org_id, kind, command, status, title, payload, eligible_approvers, authors, co_authors)
         VALUES ($1, 'journal_voucher', $2, 'pending', 'T2736', '{}', $3::uuid[], $4::jsonb, $5::uuid[]) RETURNING id, revision`,
        [o.orgId, command, snapshot, authorsOf(author), coAuthors],
      );
      return r.rows[0] as { id: string; revision: number };
    });
  }
  // The approval gate as the API's login role runs it; rolled back, so one proposal serves every approver.
  const approveAs = (o: Org, userId: string, p: { id: string; revision: number }) =>
    asUserIn(o, userId, async (c) => (await c.query<{ r: Record<string, unknown> }>('SELECT crove_kernel.proposal_approve($1::uuid, $2::integer, gen_random_uuid()) AS r', [p.id, p.revision])).rows[0]?.r);

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
    const login = (user: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = user;
      url.password = password;
      return url.toString();
    };
    appUrl = login('crove_app', 'test-app-pw');
    workerUrl = login('crove_worker', 'test-worker-pw');
    const pool = createPool({ connectionString: appUrl, max: 4 });
    pools.push(pool);
    app = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
    const db = createDb(pool);
    const person = (name: string) => upsertIdentity(db, { issuer: 't2736', subject: randomUUID(), email: `${name}@t2736.test`, name: null });
    const make = async (name: string, admins: number): Promise<Org> => {
      const owner = await person(`${name}-owner`);
      const { orgId } = await createOrg(app, asUser(owner), `T2736 ${name}`);
      const ids: string[] = [];
      for (let i = 0; i < 2; i++) ids.push(await person(`${name}-admin${i}`));
      await admin(async (c) => {
        for (const id of ids.slice(0, admins)) await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin')`, [orgId, id]);
      });
      // A chief accountant who is a plain member holding the ledger's approval permission org-wide.
      const chief = await person(`${name}-chief`);
      await admin(async (c) => {
        await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgId, chief]);
        await c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'finance.chief_accountant', NULL, $3)`, [orgId, chief, owner]);
      });
      return { orgId, owner, admin: ids[0] as string, admin2: ids[1] as string, chief };
    };
    big = await make('big', 2);
    solo = await make('solo', 0);
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('lets a user ask for a proposal of a listed command with one to ten co-authors, and refuses every other way of carrying them', async () => {
    const ok = await asUserIn(big, big.admin, (c) => c.query(insertSql, [big.orgId, COMMAND, authorsOf(big.admin), [big.owner]]));
    expect(ok).toMatchObject({ ok: true });
    // The same request without co-authors is as it always was.
    expect(await asUserIn(big, big.admin, (c) => c.query(insertSql, [big.orgId, COMMAND, authorsOf(big.admin), null]))).toMatchObject({ ok: true });
    // A command that is not in the list, an empty list, a null in it, more than ten.
    expect(await asUserIn(big, big.admin, (c) => c.query(insertSql, [big.orgId, 't2736.other', authorsOf(big.admin), [big.owner]]))).toMatchObject({ ok: false, ...REFUSED });
    expect(await asUserIn(big, big.admin, (c) => c.query(insertSql, [big.orgId, COMMAND, authorsOf(big.admin), []]))).toMatchObject({ ok: false, ...REFUSED });
    expect(await asUserIn(big, big.admin, (c) => c.query(`${insertSql.replace('$4::uuid[]', 'ARRAY[$4::uuid, NULL]::uuid[]')}`, [big.orgId, COMMAND, authorsOf(big.admin), big.owner]))).toMatchObject({ ok: false, ...REFUSED });
    // An id that is no RFC 9562 uuid (as the gate reads authors), and a two-dimensional array.
    expect(await asUserIn(big, big.admin, (c) => c.query(insertSql, [big.orgId, COMMAND, authorsOf(big.admin), ['00000000-0000-0000-0000-000000000001']]))).toMatchObject({ ok: false, ...REFUSED });
    expect(await asUserIn(big, big.admin, (c) => c.query(insertSql, [big.orgId, COMMAND, authorsOf(big.admin), `{{${big.owner}},{${big.admin2}}}`]))).toMatchObject({ ok: false, ...REFUSED });
    const eleven = Array.from({ length: 11 }, () => randomUUID());
    expect(await asUserIn(big, big.admin, (c) => c.query(insertSql, [big.orgId, COMMAND, authorsOf(big.admin), eleven]))).toMatchObject({ ok: false, ...REFUSED });
    // The "no other author" rule of `authors` stays: another user among the authors is refused, with or without co-authors.
    const two = JSON.stringify([{ type: 'user', id: big.admin }, { type: 'user', id: big.owner }]);
    expect(await asUserIn(big, big.admin, (c) => c.query(insertSql, [big.orgId, COMMAND, two, [big.owner]]))).toMatchObject({ ok: false, ...REFUSED });
    // Not in an approved proposal, and not from the system context (the worker reading a file, an agent's proposal).
    expect(
      await asUserIn(big, big.admin, (c) =>
        c.query(`INSERT INTO crove_kernel.proposal (org_id, kind, command, status, title, payload, authors, co_authors) VALUES ($1, 'journal_voucher', $2, 'approved', 'T2736', '{}', $3::jsonb, $4::uuid[])`, [
          big.orgId,
          COMMAND,
          authorsOf(big.admin),
          [big.owner],
        ]),
      ),
    ).toMatchObject({ ok: false, ...REFUSED });
    expect(await asSystemIn(big, (c) => c.query(insertSql, [big.orgId, COMMAND, JSON.stringify([SYSTEM]), [big.owner]]))).toMatchObject({ ok: false, ...REFUSED });
  });

  it('freezes the co-authors of a proposal that exists, for every writer', async () => {
    const p = await pending(big, big.admin, [big.owner], [big.owner, big.admin, big.admin2]);
    const change = (set: string) => `UPDATE crove_kernel.proposal SET co_authors = ${set} WHERE org_id = $1 AND id = $2`;
    for (const set of ['NULL', `ARRAY['${big.admin2}'::uuid]`, `ARRAY['${big.owner}'::uuid, '${big.admin2}'::uuid]`]) {
      expect(await asUserIn(big, big.admin, (c) => c.query(change(set), [big.orgId, p.id])), `admin: ${set}`).toMatchObject({ ok: false, ...REFUSED });
      expect(await asUserIn(big, big.owner, (c) => c.query(change(set), [big.orgId, p.id])), `owner: ${set}`).toMatchObject({ ok: false, ...REFUSED });
      expect(await asSystemIn(big, (c) => c.query(change(set), [big.orgId, p.id])), `system: ${set}`).toMatchObject({ ok: false, ...REFUSED });
    }
    // A proposal that has none cannot be given any.
    const none = await pending(big, big.admin, null, [big.owner, big.admin, big.admin2]);
    expect(await asUserIn(big, big.admin, (c) => c.query(change(`ARRAY['${big.owner}'::uuid]`), [big.orgId, none.id]))).toMatchObject({ ok: false, ...REFUSED });
  });

  it('counts the co-authors as authors in the approval gate: none of them approves while another eligible approver exists', async () => {
    const all = [big.owner, big.admin, big.admin2];
    const p = await pending(big, big.admin, [big.owner], all);
    // The co-author (the owner) and the requester (an admin) are refused; the other admin approves.
    expect(await approveAs(big, big.owner, p)).toMatchObject({ ok: false, message: 'FOUR_EYES_REQUIRED' });
    expect(await approveAs(big, big.admin, p)).toMatchObject({ ok: false, message: 'FOUR_EYES_REQUIRED' });
    const approved = await approveAs(big, big.admin2, p);
    expect(approved).toMatchObject({ ok: true });
    expect(approved.ok && approved.value).toMatchObject({ selfApproved: false, fourEyes: 'pass' });
    // Without the co-author the owner approves: the refusal above is the co-author's.
    const plain = await pending(big, big.admin, null, all);
    expect(await approveAs(big, big.owner, plain)).toMatchObject({ ok: true });
  });

  it('judges the one-person path and the owner override on the written authors alone: co-authors never grant', async () => {
    // Alone: the owner is requester and co-author, and the only person who may approve, flagged self-approved (written author).
    const alone = await pending(solo, solo.owner, [solo.owner], [solo.owner]);
    const own = await approveAs(solo, solo.owner, alone);
    expect(own).toMatchObject({ ok: true });
    expect(own.ok && own.value).toMatchObject({ selfApproved: true, fourEyes: 'self_approved' });
    // Two eligible (an owner and an admin), the admin asked and the owner is a co-author: no other eligible approver exists, so the owner approves (as before co-authors existed), not flagged
    // as an override; the admin, who wrote it, may not.
    const both = await pending(big, big.admin, [big.owner], [big.owner, big.admin]);
    const owner1 = await approveAs(big, big.owner, both);
    expect(owner1).toMatchObject({ ok: true });
    expect(owner1.ok && owner1.value).toMatchObject({ selfApproved: false, fourEyes: 'pass' });
    expect(await approveAs(big, big.admin, both)).toMatchObject({ ok: false, message: 'FOUR_EYES_REQUIRED' });
  });

  it('refuses the forged case: an owner who asked, with every other approver listed as a co-author, does not approve alone', async () => {
    // Raw SQL in the owner's own context can write any co_authors a guard-passing insert accepts; they must not unlock the owner override for the requester.
    const forged = await pending(big, big.owner, [big.admin, big.admin2], [big.owner, big.admin, big.admin2]);
    expect(await approveAs(big, big.owner, forged)).toMatchObject({ ok: false, message: 'FOUR_EYES_REQUIRED' });
    // The people listed are not unlocked either beyond what they could do without the list: no one else is eligible, so they approve (a second person decides, as it should be).
    expect(await approveAs(big, big.admin, forged)).toMatchObject({ ok: true });
    // The same through the guard: the owner's own insert of such a proposal passes the guard (it cannot know), and the gate still refuses the owner.
    const viaGuard = await asUserIn(big, big.owner, (c) => c.query(insertSql, [big.orgId, COMMAND, authorsOf(big.owner), [big.admin, big.admin2]]));
    expect(viaGuard).toMatchObject({ ok: true });
  });

  it('holds a co-author back under the accountant preset, as an author: if the only approver froze the run, nobody approves its posting', async () => {
    await admin((c) => c.query(`UPDATE crove_kernel.tenant SET approval_preset = 'accountant' WHERE org_id = $1`, [big.orgId]));
    try {
      // The chief accountant is the only eligible approver; the requester is an admin (who holds no approval right under this preset), and the chief froze the run (co-author).
      const withCo = await pending(big, big.admin, [big.chief], [big.chief]);
      expect(await approveAs(big, big.chief, withCo)).toMatchObject({ ok: false, message: 'FOUR_EYES_REQUIRED' });
      // Recovery: a second approver exists (here a second chief), the posting is asked for again; the first chief is still held back, the second approves.
      const second = await person2();
      const asked = await pending(big, big.admin, [big.chief], [big.chief, second]);
      expect(await approveAs(big, second, asked)).toMatchObject({ ok: true });
      expect(await approveAs(big, big.chief, asked)).toMatchObject({ ok: false, message: 'FOUR_EYES_REQUIRED' });
      // Without co-authors the chief approves as usual.
      expect(await approveAs(big, big.chief, await pending(big, big.admin, null, [big.chief]))).toMatchObject({ ok: true });
    } finally {
      await admin((c) => c.query(`UPDATE crove_kernel.tenant SET approval_preset = 'founder' WHERE org_id = $1`, [big.orgId]));
    }
  });

  it('decides every co-author case in the database exactly as decideApproval does', { timeout: 300_000 }, async () => {
    const db = createDb(pools[0] as pg.Pool);
    const everyone = [big.owner, big.admin, big.admin2, big.chief];
    const snapshots = [everyone, [big.owner, big.admin], [big.owner], [big.chief], [big.admin, big.admin2]];
    const written: string[][] = [[], [big.owner], [big.admin], [big.admin, big.owner], [big.admin, big.admin2], [big.chief]];
    const co: string[][] = [[], [big.owner], [big.admin2], [big.owner, big.admin], [big.admin, big.admin2], [big.chief], [big.owner, big.admin, big.admin2, big.chief]];
    const user = (id: string) => ({ type: 'user' as const, id });
    const a = new pg.Client({ connectionString: adminUrl });
    await a.connect();
    try {
      let checked = 0;
      for (const preset of ['founder', 'accountant']) {
        await a.query('UPDATE crove_kernel.tenant SET approval_preset = $2 WHERE org_id = $1', [big.orgId, preset]);
        for (const snapshot of snapshots) {
          for (const w of written) {
            for (const c of co) {
              for (const actor of everyone) {
                const ts = await db.transaction().execute(async (trx) => {
                  await sql`SELECT crove_kernel.enter_user_context(${big.orgId}::uuid, ${contextToken(actor, big.orgId)}::text)`.execute(trx);
                  return decideApproval(trx, big.orgId, asUser(actor), { command: COMMAND, status: 'pending', eligible_approvers: snapshot, authors: w.map(user), co_authors: c.length ? c : null }, { lock: false });
                });
                const entries = [...w.map(user), ...c.map((id) => ({ type: 'co_author', id }))];
                const inDb = (
                  await a.query<{ d: { reason: string; eligibleCount: number; selfApproved: boolean; fourEyes: string; preset: string; version: number } }>(
                    'SELECT crove_kernel.proposal_approval_decide($1::uuid, $2, $3, $4::uuid[], $5::jsonb, $6::uuid, false) AS d',
                    [big.orgId, COMMAND, 'pending', snapshot, JSON.stringify(entries), actor],
                  )
                ).rows[0]?.d;
                expect(
                  { reason: inDb?.reason, eligibleCount: inDb?.eligibleCount, selfApproved: inDb?.selfApproved, fourEyes: inDb?.fourEyes, orgPolicy: { preset: inDb?.preset, version: inDb?.version } },
                  JSON.stringify({ preset, snapshot, written: w, co: c, actor }),
                ).toEqual({ reason: ts.reason, eligibleCount: ts.eligibleCount, selfApproved: ts.selfApproved, fourEyes: ts.fourEyes, orgPolicy: ts.orgPolicy });
                checked += 1;
              }
            }
          }
        }
      }
      expect(checked).toBe(2 * snapshots.length * written.length * co.length * everyone.length);
    } finally {
      await a.query(`UPDATE crove_kernel.tenant SET approval_preset = 'founder' WHERE org_id = $1`, [big.orgId]);
      await a.end();
    }
  });

  it('lists in the trigger the commands approval.ts lists', async () => {
    const [row] = (await admin((c) => c.query<{ def: string }>(`SELECT pg_get_functiondef('crove_kernel.proposal_co_authors_guard()'::regprocedure) AS def`))).rows;
    const listed = /NEW\.command <> ALL \(ARRAY\[([^\]]*)\]\)/.exec(row?.def ?? '')?.[1] ?? '';
    const inDatabase = [...listed.matchAll(/'([^']+)'/g)].map((m) => m[1] as string).sort();
    expect(inDatabase).toEqual([...PROPOSAL_CO_AUTHOR_COMMANDS].sort());
  });
});
