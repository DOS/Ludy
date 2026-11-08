// SPDX-License-Identifier: AGPL-3.0-only
// The built-in memory port of Vy (ADR-0049 decision 9, issue #2783) runs the same feature as the fake provider of packages/agent/test: a member's
// own rows through the member's own commands, nobody else's, and forget deletes them. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run
// makes its own database.
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bindPorts, noKnowledge, privateText, revealPrivateText, runFeature, type ModelPort, type Ports } from '@crove/agent/member-vy';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { builtInMemory } from '../src/member-vy-ports.ts';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('the built-in memory port of member Vy', () => {
  const dbName = `crove_test_member_vy_ports_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let runtime: Runtime;
  const users = { owner: '', alice: '', bob: '' };
  const actor = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const memoryOf = (userId: string) => builtInMemory(runtime, actor(userId), orgId);
  const ref = (userId: string) => ({ orgId, memberUserId: userId });

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
    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    const pool = createPool({ connectionString: url.toString(), max: 4 });
    pools.push(pool);
    const db = createDb(pool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: 'in.test' })] });
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(db, { issuer: 'member-vy-ports', subject: key, email: `${key}@member-vy-ports.test`, name: null });
    }
    orgId = (await createOrg(runtime, actor(users.owner), 'Vy cổng')).orgId;
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')`, [orgId, users.alice, users.bob]);
    await c.end();
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('gives a run the member\'s own memory and never another member\'s, and forgets it on request', async () => {
    await memoryOf(users.alice).write(ref(users.alice), 'gọi khách là anh');
    await memoryOf(users.bob).write(ref(users.bob), 'BÍ MẬT CỦA BOB');
    const prompts: string[] = [];
    const model: ModelPort = {
      generate: async (_who, prompt) => {
        prompts.push(prompt.user);
        return { text: 'Tóm tắt', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const ports: Ports = { model, memory: memoryOf(users.alice), knowledge: noKnowledge };
    const out = await runFeature({ instruction: 'Tóm tắt', subject: privateText('ghi chú'), usesMemory: true, maxSubjectChars: 1000 }, bindPorts(ref(users.alice), ports));
    expect(out.readPrivateSources).toBe(true);
    expect(prompts[0]).toContain('gọi khách là anh');
    expect(prompts[0], 'another member\'s memory never reaches the model').not.toContain('BÍ MẬT CỦA BOB');
    // The port refuses to answer about anyone else, before a command runs.
    await expect(memoryOf(users.alice).read(ref(users.bob))).rejects.toThrow('only about the member');
    await expect(memoryOf(users.alice).forget({ member: ref(users.bob) })).rejects.toThrow('only about the member');
    await memoryOf(users.alice).forget({ member: ref(users.alice) });
    expect(await memoryOf(users.alice).read(ref(users.alice))).toEqual([]);
    expect((await memoryOf(users.bob).read(ref(users.bob))).map((e) => revealPrivateText(e.text)), 'forgetting one member leaves the other\'s').toEqual(['BÍ MẬT CỦA BOB']);
    // A source has nothing in the built-in memory: forgetting one is a no-op.
    await expect(memoryOf(users.bob).forget({ source: { orgId, type: 'note', id: 'x' } })).resolves.toBeUndefined();
  });
});
