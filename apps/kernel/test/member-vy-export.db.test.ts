// SPDX-License-Identifier: AGPL-3.0-only
// The org export carries each member's Vy as counts only (#2822, ADR-0049): per member the number of private results and memory entries, never a body, in the export table
// kernel.member_vy_private_count, which the worker's system context reads through crove_kernel.member_vy_private_counts(). No other export table carries a Vy body either.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, EXPORT_TABLES, EXPORT_TABLE_NAMES, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SYSTEM = { type: 'system' as const, component: 'test.member-vy-export' };

const RESULT_BODY = 'Tóm tắt riêng: khách A đòi giảm giá 12 phần trăm';
const MEMORY_BODY = 'Luôn gọi khách B là chị Lan';

suite('the org export carries Vy as counts only (#2822)', () => {
  const dbName = `crove_test_member_vy_export_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let worker: Runtime;
  const users = { owner: '', alice: '', bob: '', carol: '' };

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  // A member's Vy agent, one run per result and a memory entry, seeded as the superuser with the binding set aside.
  async function seed(userId: string, results: number, memories: number) {
    await admin(async (c) => {
      await c.query('SET session_replication_role = replica');
      const agentId = randomUUID();
      await c.query(`INSERT INTO crove_kernel.agent (org_id, id, template_key, display_name, kind, member_user_id, created_by) VALUES ($1, $2, 'kernel.member_vy', 'Vy', 'member_vy', $3, $3)`, [orgId, agentId, userId]);
      for (let i = 0; i < results; i += 1) {
        const runId = randomUUID();
        await c.query(`INSERT INTO crove_kernel.ai_run (org_id, id, agent_id, module, status, tainted, started_at, expires_at, finished_at) VALUES ($1, $2, $3, 'notes', 'succeeded', true, now() - interval '2 hours', now() + interval '1 hour', now() - interval '90 minutes')`, [orgId, runId, agentId]);
        await c.query(
          `INSERT INTO crove_kernel.member_vy_result (org_id, id, member_user_id, run_id, feature, subject_type, subject_id, status, body, created_at, expires_at)
           VALUES ($1, $2, $3, $4, 'notes.summary', 'note', $5, 'ready', $6, now(), now() + interval '30 days')`,
          [orgId, randomUUID(), userId, runId, randomUUID(), RESULT_BODY],
        );
      }
      for (let i = 0; i < memories; i += 1) await c.query(`INSERT INTO crove_kernel.member_vy_memory (org_id, id, member_user_id, body) VALUES ($1, $2, $3, $4)`, [orgId, randomUUID(), userId, MEMORY_BODY]);
    });
  }
  async function exported(table: string): Promise<string[]> {
    const lines: string[] = [];
    await worker.stream('kernel.org.export.snapshot', { table }, { actor: SYSTEM, orgId }, async (batch) => {
      lines.push(...(batch as { table: string; lines: string[] }).lines);
    });
    return lines;
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
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    const appPool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 4 });
    const workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 4 });
    pools.push(appPool, workerPool);
    const app = new Runtime(createDb(appPool), { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: 'in.test' })] });
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: 'in.test' })] });
    for (const key of Object.keys(users) as Array<keyof typeof users>) users[key] = await upsertIdentity(createDb(appPool), { issuer: 'member-vy-export', subject: key, email: `${key}@member-vy-export.test`, name: null });
    orgId = (await createOrg(app, { type: 'user', userId: users.owner, aal: 'aal1' }, 'Xuất Vy')).orgId;
    await admin((c) => c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member')`, [orgId, users.alice, users.bob, users.carol]));
    await seed(users.alice, 2, 1);
    await seed(users.bob, 1, 0);
    // A member with memory entries only.
    await seed(users.carol, 0, 2);
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('lists the table in the export and holds, per member, how many results and memory entries they have', async () => {
    expect(EXPORT_TABLE_NAMES).toContain('kernel.member_vy_private_count');
    const lines = (await exported('kernel.member_vy_private_count')).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => [l.member_user_id, Number(l.results), Number(l.memories)]).sort()).toEqual(
      [
        [users.alice, 2, 1],
        [users.bob, 1, 0],
        [users.carol, 0, 2],
      ].sort(),
    );
    expect(lines.every((l) => l.org_id === orgId)).toBe(true);
    // Numbers and ids only.
    expect(new Set(lines.flatMap((l) => Object.keys(l)))).toEqual(new Set(['org_id', 'member_user_id', 'results', 'memories']));
  });

  it('carries no Vy body in any table of the export', async () => {
    // The system context cannot read the sealed tables anyway; this pins that no export source names them, so a base table is never added by accident.
    expect(Object.values(EXPORT_TABLES).map((spec) => spec.from).filter((from) => /member_vy_(result|memory)\b/.test(from))).toEqual([]);
    for (const table of EXPORT_TABLE_NAMES) {
      const text = (await exported(table)).join('\n');
      expect(text, `${table} holds a Vy result body`).not.toContain(RESULT_BODY);
      expect(text, `${table} holds a Vy memory entry`).not.toContain(MEMORY_BODY);
    }
  });
});
