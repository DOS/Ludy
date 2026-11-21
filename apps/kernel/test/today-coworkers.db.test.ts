// SPDX-License-Identifier: AGPL-3.0-only
// The AI coworkers' names on Home's list (#3265, Vy plan C1a), on PostgreSQL 17 through the runtime as each member:
// kernel.today answers with the name of the coworker of each app (Ly finance, Dy crm and conversations, Uy social and ads,
// Vy for the summary line), the name being the display name of the org's own agent now, so a rename shows at once. With no
// agent of a coworker the roster's name stands; a retired agent, a member's own Vy and another org's agent never name one.
// Nothing here calls a model. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { COWORKER_ROSTER, zTodayList, type TodayList } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('kernel.today names the AI coworkers (#3265)', () => {
  const dbName = `crove_test_today_coworkers_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let rt: Runtime;
  let db: ReturnType<typeof createDb>;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@today-coworkers.test`, name: null });

  interface Org {
    orgId: string;
    owner: string;
    viewer: string;
  }
  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const viewer = await person('viewer');
    await admin((c) => c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'viewer')`, [orgId, viewer]));
    return { orgId, owner, viewer };
  }

  // An agent of a template, named by `name`; `ageSeconds` backdates it so "the oldest" is deterministic.
  async function agent(o: Org, template: string, name: string, over: { status?: string; ageSeconds?: number } = {}) {
    const id = randomUUID();
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.agent (org_id, id, template_key, display_name, status, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, now() - make_interval(secs => $7))`,
        [o.orgId, id, template, name, over.status ?? 'active', o.owner, over.ageSeconds ?? 0],
      ),
    );
    return id;
  }

  const today = (o: Org, user = o.owner) => rt.query<TodayList>('kernel.today', {}, { actor: asUser(user), orgId: o.orgId });

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
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    pool = createPool({ connectionString: app.toString(), max: 4 });
    db = createDb(pool);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: null })] });
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('answers with the roster names for an org with no AI coworker installed, to every role', async () => {
    const o = await org();
    for (const user of [o.owner, o.viewer]) {
      const answer = await today(o, user);
      expect(zTodayList.safeParse(answer).success).toBe(true);
      expect(answer.coworkers).toEqual({ gm: 'Vy', finance: 'Ly', sales: 'Dy', marketing: 'Uy' });
    }
  });

  it('takes each coworker\'s name from the org\'s agent of its modules: finance Ly, crm Dy, social Uy', async () => {
    const o = await org();
    await agent(o, 'finance.chief_accountant', 'Ly');
    await agent(o, 'crm.scheduler', 'Dy');
    await agent(o, 'social.content_manager', 'Uy');
    expect((await today(o)).coworkers).toEqual({ gm: 'Vy', finance: 'Ly', sales: 'Dy', marketing: 'Uy' });
  });

  it('shows the new name once an owner renames the coworker, through the real command', async () => {
    const o = await org();
    const id = await agent(o, 'finance.chief_accountant', 'Ly');
    expect((await today(o)).coworkers.finance).toBe('Ly');
    await rt.execute('kernel.agent.update', { id, displayName: 'Lan' }, { actor: asMfa(o.owner), orgId: o.orgId });
    const renamed = await today(o);
    expect(renamed.coworkers.finance).toBe('Lan');
    // The other coworkers keep theirs.
    expect(renamed.coworkers).toEqual({ gm: 'Vy', finance: 'Lan', sales: 'Dy', marketing: 'Uy' });
    // A viewer sees the same name.
    expect((await today(o, o.viewer)).coworkers.finance).toBe('Lan');
  });

  it('lets the oldest agent that is not retired speak for the coworker, and falls back to the roster when none is left', async () => {
    const o = await org();
    const first = await agent(o, 'finance.chief_accountant', 'Ly cũ', { ageSeconds: 300 });
    await agent(o, 'finance.chief_accountant', 'Ly (Kế toán trưởng)', { ageSeconds: 100 });
    expect((await today(o)).coworkers.finance).toBe('Ly cũ');
    await admin((c) => c.query(`UPDATE crove_kernel.agent SET status = 'paused' WHERE org_id = $1 AND id = $2`, [o.orgId, first]));
    expect((await today(o)).coworkers.finance).toBe('Ly cũ');
    await admin((c) => c.query(`UPDATE crove_kernel.agent SET status = 'retired' WHERE org_id = $1 AND id = $2`, [o.orgId, first]));
    expect((await today(o)).coworkers.finance).toBe('Ly (Kế toán trưởng)');
    await admin((c) => c.query(`UPDATE crove_kernel.agent SET status = 'retired' WHERE org_id = $1`, [o.orgId]));
    expect((await today(o)).coworkers.finance).toBe(COWORKER_ROSTER.finance);
  });

  it('never takes a name from a member\'s own Vy or from another org\'s agent', async () => {
    const a = await org();
    const b = await org();
    await agent(b, 'finance.chief_accountant', 'Tên của org khác');
    // A member's own Vy is made only in that member's own context (a trigger); the seed is the owner of the database, and plain triggers stay silent in replica mode.
    await admin(async (c) => {
      await c.query('SET session_replication_role = replica');
      await c.query(`INSERT INTO crove_kernel.agent (org_id, id, template_key, display_name, kind, member_user_id, created_by) VALUES ($1, $2, 'kernel.member_vy', 'Vy của riêng tôi', 'member_vy', $3, $3)`, [a.orgId, randomUUID(), a.owner]);
    });
    expect((await today(a)).coworkers).toEqual({ gm: 'Vy', finance: 'Ly', sales: 'Dy', marketing: 'Uy' });
    expect((await today(b)).coworkers.finance).toBe('Tên của org khác');
  });
});
