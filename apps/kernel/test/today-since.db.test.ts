// SPDX-License-Identifier: AGPL-3.0-only
// kernel.since_yesterday (#3256, Vy plan C1c), Home's "Since yesterday", on PostgreSQL 17 through the runtime as each member:
// the count per AI coworker of the activity rows its commands left over the last day, for the rows the member can open (the
// activity table's own policies: the org, minus legal entities outside the member's scope); a viewer's follows their access, a
// row of another org never counts, a renamed coworker shows its new name, and the answer holds only counts, the coworker and a
// link. Nothing in the read calls a model. Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, sinceYesterdayQuery, upsertIdentity } from '@ludy/kernel';
import { zSinceYesterday, type SinceYesterday } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const NOW = new Date('2026-11-15T03:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const TEMPLATE = 'finance.chief_accountant';

suite('kernel.since_yesterday: what the AI coworkers prepared (#3256)', () => {
  const dbName = `ludy_test_today_since_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let rt: Runtime;
  let db: ReturnType<typeof createDb>;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@today-since.test`, name: null });

  interface Org {
    orgId: string;
    owner: string;
    member: string;
    // Limited by an external_accountant assignment to the default entity, and to the branch.
    limitedDefault: string;
    limitedBranch: string;
    viewer: string;
    defaultEntity: string;
    branch: string;
  }
  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const member = await person('member');
    const limitedDefault = await person('limited-default');
    const limitedBranch = await person('limited-branch');
    const viewer = await person('viewer');
    return admin(async (c) => {
      const defaultEntity = (await c.query<{ id: string }>('SELECT id FROM ludy_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId])).rows[0]?.id as string;
      const branch = (await c.query<{ id: string }>(`INSERT INTO ludy_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id`, [orgId, owner])).rows[0]
        ?.id as string;
      for (const [user, role] of [
        [member, 'member'],
        [limitedDefault, 'member'],
        [limitedBranch, 'member'],
        [viewer, 'viewer'],
      ] as const) {
        await c.query('INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, user, role]);
      }
      for (const [user, entity] of [
        [limitedDefault, defaultEntity],
        [limitedBranch, branch],
      ] as const) {
        await c.query(`INSERT INTO ludy_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [orgId, user, entity, owner]);
      }
      return { orgId, owner, member, limitedDefault, limitedBranch, viewer, defaultEntity, branch };
    });
  }

  async function agent(o: Org, name: string, kind: 'org_chart' | 'member_vy' = 'org_chart') {
    const id = randomUUID();
    await admin(async (c) => {
      if (kind === 'org_chart') {
        await c.query(`INSERT INTO ludy_kernel.agent (org_id, id, template_key, display_name, created_by) VALUES ($1, $2, $3, $4, $5)`, [o.orgId, id, TEMPLATE, name, o.owner]);
        return;
      }
      // A member's own Vy is made only in that member's own context (a trigger); the seed is the owner of the database, and
      // plain triggers stay silent in replica mode.
      await c.query('SET session_replication_role = replica');
      await c.query(`INSERT INTO ludy_kernel.agent (org_id, id, template_key, display_name, kind, member_user_id, created_by) VALUES ($1, $2, 'kernel.member_vy', $3, 'member_vy', $4, $4)`, [o.orgId, id, name, o.member]);
    });
    return id;
  }

  // `n` activity rows an agent's command left, `hours` before NOW, with the text a row carries (which the answer must never show), in an entity or org-level.
  async function rows(o: Org, agentId: string, n: number, hours = 1, entity: string | null = null) {
    await admin(async (c) => {
      for (let i = 0; i < n; i += 1) {
        await c.query(
          `INSERT INTO ludy_kernel.activity (org_id, record_type, record_id, kind, summary, agent_id, occurred_at, legal_entity_id) VALUES ($1, 'test.prepared', $2, 'prepared', $3, $4, $5, $6)`,
          [o.orgId, randomUUID(), 'Soạn thư cho khách Nguyễn Văn Bí Mật', agentId, hoursAgo(hours), entity],
        );
      }
    });
  }

  const since = (o: Org, user: string) => rt.query<SinceYesterday>('kernel.since_yesterday', {}, { actor: asUser(user), orgId: o.orgId });
  const counts = (answer: SinceYesterday) => Object.fromEntries(answer.items.map((i) => [i.name, i.count]));

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });
    const app = new URL(adminUrl);
    app.username = 'ludy_app';
    app.password = 'test-app-pw';
    pool = createPool({ connectionString: app.toString(), max: 4 });
    db = createDb(pool);
    // The query as the server registers it, with the clock fixed.
    const queries = [...kernelQueries({ inboundDomain: null }).filter((q) => q.name !== 'kernel.since_yesterday'), sinceYesterdayQuery({ now: () => NOW })];
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands], queries });
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('counts the rows of each coworker over the last day for every role, biggest first, and lists nobody with no rows', async () => {
    const o = await org();
    const ly = await agent(o, 'Ly');
    const dy = await agent(o, 'Dy');
    await agent(o, 'Uy');
    await rows(o, ly, 5);
    await rows(o, dy, 2);
    for (const user of [o.owner, o.member, o.viewer]) {
      const answer = await since(o, user);
      expect(zSinceYesterday.safeParse(answer).success).toBe(true);
      expect(answer.items.map((i) => [i.name, i.count])).toEqual([
        ['Ly', 5],
        ['Dy', 2],
      ]);
      expect(answer.items.every((i) => i.href === '/inbox')).toBe(true);
    }
  });

  it('counts only the last day: a row from before it is not in it', async () => {
    const o = await org();
    const ly = await agent(o, 'Ly');
    await rows(o, ly, 1, 1);
    await rows(o, ly, 2, 23);
    await rows(o, ly, 4, 25);
    await rows(o, ly, 8, 30 * 24);
    expect(counts(await since(o, o.owner))).toEqual({ Ly: 3 });
  });

  it('counts only what the member can open: a member limited to one legal entity gets the counts of its rows and the org-level ones', async () => {
    const o = await org();
    const ly = await agent(o, 'Ly');
    const dy = await agent(o, 'Dy');
    await rows(o, ly, 3, 1, o.defaultEntity);
    await rows(o, ly, 4, 1, o.branch);
    await rows(o, ly, 1, 1, null);
    await rows(o, dy, 2, 1, o.branch);
    expect(counts(await since(o, o.owner))).toEqual({ Ly: 8, Dy: 2 });
    expect(counts(await since(o, o.member))).toEqual({ Ly: 8, Dy: 2 });
    expect(counts(await since(o, o.viewer))).toEqual({ Ly: 8, Dy: 2 });
    expect(counts(await since(o, o.limitedDefault))).toEqual({ Ly: 4 });
    // The branch's accountant sees the branch's rows (and the org-level ones) and Dy, who prepared only for the branch.
    expect(counts(await since(o, o.limitedBranch))).toEqual({ Ly: 5, Dy: 2 });
  });

  it("never counts another org's rows, and a coworker of another org is not listed", async () => {
    const a = await org();
    const b = await org();
    const lyA = await agent(a, 'Ly');
    const lyB = await agent(b, 'Ly');
    await rows(a, lyA, 2);
    await rows(b, lyB, 9);
    expect(counts(await since(a, a.owner))).toEqual({ Ly: 2 });
    expect(counts(await since(b, b.owner))).toEqual({ Ly: 9 });
    // An org with no coworker rows lists nothing.
    const c = await org();
    expect((await since(c, c.owner)).items).toEqual([]);
  });

  it('shows the coworker under its current name after a rename', async () => {
    const o = await org();
    const id = await agent(o, 'Ly');
    await rows(o, id, 2);
    expect(counts(await since(o, o.owner))).toEqual({ Ly: 2 });
    await admin((c) => c.query('UPDATE ludy_kernel.agent SET display_name = $3 WHERE org_id = $1 AND id = $2', [o.orgId, id, 'Lan']));
    expect(counts(await since(o, o.owner))).toEqual({ Lan: 2 });
  });

  it("does not count a member's own Vy, whose work is private to that member", async () => {
    const o = await org();
    const ly = await agent(o, 'Ly');
    const vy = await agent(o, 'Vy', 'member_vy');
    await rows(o, ly, 1);
    await rows(o, vy, 6);
    expect(counts(await since(o, o.member))).toEqual({ Ly: 1 });
    expect(counts(await since(o, o.owner))).toEqual({ Ly: 1 });
  });

  it('answers with counts, the coworker and a link only: no row text, no record, no actor, whatever the rows say', async () => {
    const o = await org();
    const ly = await agent(o, 'Ly');
    await rows(o, ly, 2);
    const answer = await since(o, o.owner);
    expect(answer.items).toHaveLength(1);
    expect(Object.keys(answer.items[0] ?? {}).sort()).toEqual(['agentId', 'count', 'href', 'name']);
    const text = JSON.stringify(answer);
    expect(text).not.toContain('Nguyễn');
    expect(text).not.toContain('Bí Mật');
    expect(text).not.toContain('test.prepared');
    expect(text).not.toContain('prepared');
  });

  it('is a plain read that needs no AI: it runs with no model configured and writes nothing', async () => {
    const o = await org();
    const ly = await agent(o, 'Ly');
    await rows(o, ly, 1);
    const before = await admin(async (c) => Number((await c.query('SELECT count(*) AS n FROM ludy_kernel.activity WHERE org_id = $1', [o.orgId])).rows[0].n));
    await since(o, o.owner);
    await since(o, o.viewer);
    const after = await admin(async (c) => Number((await c.query('SELECT count(*) AS n FROM ludy_kernel.activity WHERE org_id = $1', [o.orgId])).rows[0].n));
    expect(after).toBe(before);
  });
});
