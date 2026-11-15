// SPDX-License-Identifier: AGPL-3.0-only
// The per-org app gate of the runtime (ADR-0053 sections 1, 3 and 4; slice b step 2 of #3307, issue #3309) on a real PostgreSQL 17,
// in its strict form: a command, a query, a stream, a nested command and the command an approved proposal runs, of an app the org
// switched off or does not hold, answer MODULE_OFF 404 naming the app and leave no idempotency key or `ok` audit row; ctx.query answers
// not_installed; a system actor and an AI agent are refused like a user; kernel and a definition that declares runsWhenOff are never
// refused; the billing port's answer is cached for a minute and a failing port fails open to the last answer (full when there is none)
// with a security event; a command that opens busy work and a switch meet on the tenant row; Runtime.effectiveModules gives the set.
// The step 1 file (invariant/org-app-gate.db.test.ts) accepts both behaviors until a tests-only PR makes it strict.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { z } from 'zod';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { buildKernelCommands, createOrg, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, defineCommand, defineQuery, mintContextToken, type AgentActor, type CommandDef, type Lookup } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const MEMBERS = ['owner', 'admin', 'member', 'viewer'] as const;
const SHIPPED = ['kernel', 'finance', 'probe', 'other'] as const;
const SYSTEM = { type: 'system' as const, component: 'kernel.agent' };
const suite = ADMIN ? describe : describe.skip;

// The app under test, `probe`, and its definitions of every kind a gate meets.
const touch = defineCommand({ name: 'probe.touch', input: z.object({}), risk: 'R1', sideEffect: 'none', access: ['owner', 'admin', 'member'], handler: async () => 'ran' });
const read = defineQuery({ name: 'probe.read', input: z.object({}), access: [...MEMBERS], handler: async () => 'read' });
const streamed = defineQuery({
  name: 'probe.stream',
  input: z.object({}),
  access: [...MEMBERS],
  stream: true,
  handler: async (_ctx, _input, sink) => {
    await sink?.(['batch']);
    return 'streamed';
  },
});
const sysTouch = defineCommand({ name: 'probe.sys_touch', input: z.object({}), risk: 'R1', sideEffect: 'none', access: 'system', writes: [], handler: async () => 'ran' });
const agentTouch = defineCommand({ name: 'probe.agent_touch', input: z.object({}), risk: 'R0', sideEffect: 'none', access: [], agent: { roles: 'any' }, writes: [], handler: async () => 'ran' });
// Keeping, not work: runs while the app is off, with the reason.
const keep = defineCommand({
  name: 'probe.keep',
  input: z.object({}),
  risk: 'R1',
  sideEffect: 'none',
  access: ['owner', 'admin', 'member'],
  runsWhenOff: 'keeps a retention duty of the org while the app is off',
  handler: async () => 'kept',
});
const keepRead = defineQuery({ name: 'probe.keep_read', input: z.object({}), access: [...MEMBERS], runsWhenOff: 'reads what a retention duty still has to keep', handler: async () => 'kept' });
// A command that opens busy work (a recording start): the runtime reads the tenant row FOR SHARE to commit.
const busy = defineCommand({ name: 'probe.busy', input: z.object({}), risk: 'R1', sideEffect: 'none', access: ['owner', 'admin', 'member'], opensBusyWork: true, handler: async () => 'busy' });
// Kernel-side callers into the app: a nested command, and a lookup.
const nested = defineCommand({
  name: 'kernel.gate_nested',
  input: z.object({}),
  risk: 'R1',
  sideEffect: 'none',
  access: ['owner', 'admin', 'member'],
  handler: async (ctx) => ctx.run('probe.touch', {}),
});
const lookup = defineQuery({ name: 'kernel.gate_lookup', input: z.object({}), access: [...MEMBERS], handler: (ctx) => ctx.query<string>('probe.read', {}) });
const kernelSysRead = defineQuery({ name: 'kernel.gate_sys_read', input: z.object({}), access: 'system', handler: async () => 'read' });
type Actor = { type: 'user'; userId: string; aal: 'aal1' | 'aal2'; sessionId?: string; mfaAt?: number };

suite('the per-org app gate of the runtime (ADR-0053, slice b)', () => {
  const dbName = `crove_test_orggate2_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let rt: Runtime;
  let worker: Runtime;
  let definitions: { commands: CommandDef<any, any>[]; queries: unknown[] };

  const appUrlOf = () => {
    const u = new URL(adminUrl);
    u.username = 'crove_app';
    u.password = 'test-app-pw';
    return u.toString();
  };
  const asUser = (userId: string): Actor => ({ type: 'user', userId, aal: 'aal1' });
  const asMfa = (userId: string): Actor => ({ type: 'user', userId, aal: 'aal2', sessionId: '7e1c2b4a-5d6f-4a8b-9c0d-1e2f3a4b5c6d', mfaAt: Math.floor(Date.now() / 1000) });

  async function withAdmin<T>(fn: (admin: pg.Client) => Promise<T>): Promise<T> {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      return await fn(admin);
    } finally {
      await admin.end();
    }
  }

  const person = (name: string) => upsertIdentity(createDb(pool), { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@orggate2.test`, name: null });
  const runtimeWith = (options: { entitlements?: (orgId: string) => Promise<readonly string[]> } = {}, db = pool) =>
    new Runtime(createDb(db), { manifests: TEST_MANIFESTS, ...options }).register(definitions as never);

  async function org() {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Gate ${randomUUID().slice(0, 6)}`);
    const [admin, member] = [await person('admin'), await person('member')];
    await withAdmin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')", [orgId, admin, member]));
    const setApp = (module: string, enabled: boolean) => rt.execute('kernel.org.set_app', { module, enabled }, { actor: asUser(owner), orgId, idempotencyKey: randomUUID() });
    const exec = <T = string>(runtime: Runtime, name: string, user: string, input: unknown = {}) => runtime.execute<T>(name, input, { actor: asUser(user), orgId, idempotencyKey: randomUUID() });
    const query = <T = string>(runtime: Runtime, name: string, user: string) => runtime.query<T>(name, {}, { actor: asUser(user), orgId });
    const agent = async (): Promise<AgentActor> => {
      const { agentId, positionId } = await rt.execute<{ agentId: string; positionId: string }>(
        'kernel.agent.template.install',
        { templateKey: 'finance.chief_accountant', reportsTo: null },
        { actor: asMfa(owner), orgId, idempotencyKey: randomUUID() },
      );
      await rt.execute('kernel.task.create', { title: 'Việc thử', assigneePositionId: positionId }, { actor: asUser(owner), orgId, idempotencyKey: randomUUID() });
      const started = await worker.execute<{ runId: string | null }>('kernel.agent.run.start', { agentId }, { actor: SYSTEM, orgId });
      if (!started.runId) throw new Error('no run');
      return { type: 'agent', agentId, runId: started.runId };
    };
    const traces = (command: string) =>
      withAdmin(async (c) => ({
        keys: (await c.query('SELECT 1 FROM crove_kernel.idempotency_key WHERE org_id = $1 AND command = $2', [orgId, command])).rowCount,
        audits: (await c.query("SELECT 1 FROM crove_kernel.audit_event WHERE org_id = $1 AND command = $2 AND outcome = 'ok'", [orgId, command])).rowCount,
      }));
    return { orgId, owner, admin, member, setApp, exec, query, agent, traces };
  }

  const refusal = { code: 'MODULE_OFF', status: 404, details: { module: 'probe' } };

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
    pool = createPool({ connectionString: app.toString(), max: 8 });
    const w = new URL(adminUrl);
    w.username = 'crove_worker';
    w.password = 'test-worker-pw';
    workerPool = createPool({ connectionString: w.toString(), max: 2 });
    definitions = {
      commands: [...buildKernelCommands({ shippedModules: SHIPPED }), ...financeCommands, touch, sysTouch, agentTouch, keep, busy, nested],
      queries: [
        ...kernelQueries({ inboundDomain: null, apps: { shipped: SHIPPED, deployment: SHIPPED, entitlements: async () => ['full'] } }),
        ...financeQueries,
        read,
        streamed,
        keepRead,
        lookup,
        kernelSysRead,
      ],
    };
    rt = runtimeWith();
    worker = runtimeWith({}, workerPool);
  }, 120_000);

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('refuses a command, a query, a stream and a lookup of an app the org switched off, leaving no trace, and runs them again when it is back on', async () => {
    const o = await org();
    await expect(o.exec(rt, 'probe.touch', o.member)).resolves.toBe('ran');
    await o.setApp('probe', false);
    const before = await o.traces('probe.touch');
    await expect(o.exec(rt, 'probe.touch', o.member)).rejects.toMatchObject(refusal);
    await expect(o.exec(rt, 'probe.touch', o.owner)).rejects.toMatchObject(refusal);
    await expect(o.query(rt, 'probe.read', o.member)).rejects.toMatchObject(refusal);
    await expect(rt.stream('probe.stream', {}, { actor: asUser(o.member), orgId: o.orgId }, async () => {})).rejects.toMatchObject(refusal);
    // The refused call wrote no idempotency key and no 'ok' audit row (the earlier successful run left one of each).
    expect(await o.traces('probe.touch')).toEqual(before);
    // A role that could not run the command anyway gets the same answer: the gate comes before the role check.
    await expect(o.exec(rt, 'probe.touch', o.owner)).rejects.toMatchObject({ message: expect.stringContaining('probe') });
    // ctx.query answers the typed not_installed, as for an app the deployment leaves out.
    await expect(o.query<Lookup<string>>(rt, 'kernel.gate_lookup', o.member)).resolves.toEqual({ status: 'not_installed', module: 'probe' });
    // Back on: everything as before, the data and the registry untouched.
    await o.setApp('probe', true);
    await expect(o.exec(rt, 'probe.touch', o.member)).resolves.toBe('ran');
    await expect(o.query(rt, 'probe.read', o.member)).resolves.toBe('read');
    await expect(o.query<Lookup<string>>(rt, 'kernel.gate_lookup', o.member)).resolves.toEqual({ status: 'ok', value: 'read' });
    const streamedBatches: unknown[] = [];
    await expect(rt.stream('probe.stream', {}, { actor: asUser(o.member), orgId: o.orgId }, async (b) => void streamedBatches.push(b))).resolves.toBe('streamed');
    expect(streamedBatches).toEqual([['batch']]);
  });

  it('refuses a nested command, rolling the caller back', async () => {
    const o = await org();
    await expect(o.exec(rt, 'kernel.gate_nested', o.member)).resolves.toBe('ran');
    await o.setApp('probe', false);
    await expect(o.exec(rt, 'kernel.gate_nested', o.member)).rejects.toMatchObject(refusal);
    await o.setApp('probe', true);
    await expect(o.exec(rt, 'kernel.gate_nested', o.member)).resolves.toBe('ran');
  });

  it('refuses the command an approved proposal runs, and the proposal waits', async () => {
    const o = await org();
    // A posted entry (as the API login in the owner's context), and a proposal of the member to reverse it.
    const entryId = await withAdmin(async () => {
      const c = new pg.Client({ connectionString: appUrlOf() });
      await c.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [o.orgId, mintContextToken(process.env.CROVE_CONTEXT_TOKEN_KEY ?? '', { userId: o.owner, orgId: o.orgId, sessionId: null, aal: 'aal1', mfaAt: null })]);
        const { rows } = await c.query<{ id: string }>(
          `SELECT crove_finance.post_journal_entry('2026-10-01'::date, 'test', 'test', $1::uuid, $2::jsonb) AS id`,
          [
            randomUUID(),
            JSON.stringify([
              { line_no: 1, account_code: '6422', debit: '1000', credit: '0' },
              { line_no: 2, account_code: '1111', debit: '0', credit: '1000' },
            ]),
          ],
        );
        await c.query('COMMIT');
        return rows[0]?.id as string;
      } finally {
        await c.end();
      }
    });
    const requested = await o.exec<{ proposalId: string }>(rt, 'kernel.proposal.request', o.member, { command: 'finance.journal.reverse', input: { entryId, entryDate: '2026-10-15', reason: 'Ghi nhầm' } });
    await o.setApp('finance', false);
    const approve = () => rt.execute('kernel.proposal.approve', { id: requested.proposalId, revision: 1 }, { actor: asMfa(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() });
    await expect(approve()).rejects.toMatchObject({ code: 'MODULE_OFF', status: 404, details: { module: 'finance' } });
    const state = async () => withAdmin(async (c) => (await c.query<{ status: string }>('SELECT status FROM crove_kernel.proposal WHERE id = $1', [requested.proposalId])).rows[0]?.status);
    expect(await state()).toBe('pending');
    await o.setApp('finance', true);
    await expect(approve()).resolves.toMatchObject({ journalEntryId: expect.any(String) });
    expect(await state()).toBe('executed');
  });

  it('refuses a system actor and an AI agent like a user, and never refuses them in kernel', async () => {
    const o = await org();
    const agent = await o.agent();
    await expect(worker.execute('probe.sys_touch', {}, { actor: SYSTEM, orgId: o.orgId, idempotencyKey: randomUUID() })).resolves.toBe('ran');
    await expect(worker.execute('probe.agent_touch', {}, { actor: agent, orgId: o.orgId, idempotencyKey: randomUUID() })).resolves.toBe('ran');
    await o.setApp('probe', false);
    await expect(worker.execute('probe.sys_touch', {}, { actor: SYSTEM, orgId: o.orgId, idempotencyKey: randomUUID() })).rejects.toMatchObject(refusal);
    await expect(worker.execute('probe.agent_touch', {}, { actor: agent, orgId: o.orgId, idempotencyKey: randomUUID() })).rejects.toMatchObject(refusal);
    await expect(worker.query('kernel.gate_sys_read', {}, { actor: SYSTEM, orgId: o.orgId })).resolves.toBe('read');
  });

  it('puts the gate after the membership: a stranger gets the same refusal whether the app is on or off', async () => {
    const o = await org();
    const other = await org();
    const answer = async (user: string) => {
      try {
        await o.exec(rt, 'probe.touch', user);
        return 'ran';
      } catch (error) {
        const e = error as { code: string; status: number; message: string; details?: unknown };
        return JSON.stringify({ code: e.code, status: e.status, message: e.message, details: e.details ?? null });
      }
    };
    const on = await answer(other.owner);
    await o.setApp('probe', false);
    expect(await answer(other.owner)).toBe(on);
    expect(on).not.toContain('MODULE_OFF');
  });

  it('keeps kernel and what declares runsWhenOff running while the app is off', async () => {
    const o = await org();
    await o.setApp('probe', false);
    await expect(o.exec(rt, 'probe.keep', o.member)).resolves.toBe('kept');
    await expect(o.query(rt, 'probe.keep_read', o.member)).resolves.toBe('kept');
    await expect(rt.query('kernel.org.get', {}, { actor: asUser(o.member), orgId: o.orgId })).resolves.toMatchObject({ orgId: o.orgId });
    await expect(o.setApp('probe', true)).resolves.toMatchObject({ enabled: true });
  });

  it('refuses a definition that declares runsWhenOff or opensBusyWork wrongly', () => {
    const base = { input: z.object({}), risk: 'R1' as const, sideEffect: 'none' as const, access: ['owner' as const], handler: async () => 'x' };
    const registry = () => new Runtime(createDb(pool), { manifests: TEST_MANIFESTS });
    expect(() => registry().register({ commands: [defineCommand({ ...base, name: 'probe.a', runsWhenOff: 'short' })] })).toThrow(/one-line reason of at least 10/);
    expect(() => registry().register({ commands: [defineCommand({ ...base, name: 'probe.b', runsWhenOff: 'a reason\nover two lines' })] })).toThrow(/one-line reason/);
    expect(() => registry().register({ commands: [defineCommand({ ...base, name: 'kernel.c', runsWhenOff: 'a reason long enough' })] })).toThrow(/never refused by the app gate/);
    expect(() => registry().register({ queries: [defineQuery({ name: 'kernel.d', input: z.object({}), access: ['owner'], runsWhenOff: 'a reason long enough', handler: async () => 1 })] })).toThrow(/never refused/);
    expect(() => registry().register({ commands: [defineCommand({ ...base, name: 'kernel.e', opensBusyWork: true })] })).toThrow(/opensBusyWork/);
    expect(() => registry().register({ commands: [defineCommand({ ...base, name: 'probe.f', opensBusyWork: true, runsWhenOff: 'a reason long enough' })] })).toThrow(/opensBusyWork/);
    expect(() => registry().register({ commands: [defineCommand({ ...base, name: 'probe.g', runsWhenOff: 'a reason long enough' }), defineCommand({ ...base, name: 'probe.h', opensBusyWork: true })] })).not.toThrow();
  });

  it('refuses an app the org does not hold, asks the billing port once a minute, and lets a switch back on change nothing it lacks', async () => {
    const o = await org();
    const asked: string[] = [];
    let held: readonly string[] = ['finance'];
    const holding = runtimeWith({
      entitlements: async (orgId) => {
        asked.push(orgId);
        return held;
      },
    });
    await expect(o.exec(holding, 'probe.touch', o.member)).rejects.toMatchObject(refusal);
    await expect(o.query(holding, 'probe.read', o.member)).rejects.toMatchObject(refusal);
    await expect(o.query<Lookup<string>>(holding, 'kernel.gate_lookup', o.member)).resolves.toEqual({ status: 'not_installed', module: 'probe' });
    // One question to the port for the three calls: the answer is cached for 60 seconds.
    expect(asked).toEqual([o.orgId]);
    // kernel is never refused for want of an entitlement.
    await expect(holding.query('kernel.org.get', {}, { actor: asUser(o.member), orgId: o.orgId })).resolves.toMatchObject({ orgId: o.orgId });
    expect(await holding.effectiveModules(o.orgId)).toEqual(['finance', 'kernel']);
    // The org's choice does not give it what it lacks.
    await o.setApp('probe', false);
    await o.setApp('probe', true);
    await expect(o.exec(holding, 'probe.touch', o.member)).rejects.toMatchObject(refusal);
    // `full`, or the key of the app, holds it (a fresh runtime has its own cache).
    for (held of [['full'], ['probe'], ['probe', 'other']]) {
      await expect(o.exec(runtimeWith({ entitlements: async () => held }), 'probe.touch', o.member)).resolves.toBe('ran');
    }
    // An answer that is not a list of keys is a failure of the port.
    await expect(o.exec(runtimeWith({ entitlements: (async () => 'full') as never }), 'probe.touch', o.member)).resolves.toBe('ran');
  });

  it('fails open when the billing port fails: the last answer, else full, with a security event', async () => {
    const o = await org();
    vi.useFakeTimers({ toFake: ['Date'], now: new Date() });
    let mode: 'none' | 'throw' = 'none';
    const port = runtimeWith({
      entitlements: async () => {
        if (mode === 'throw') throw new Error('billing is down');
        return [];
      },
    });
    const flaky = runtimeWith({
      entitlements: async () => {
        throw new Error('billing is down');
      },
    });
    // No answer ever known: the app runs (fail open to full), and a security event says the port failed.
    const before = await withAdmin(async (c) => (await c.query("SELECT 1 FROM crove_kernel.security_event WHERE code = 'ENTITLEMENTS_UNAVAILABLE'")).rowCount);
    await expect(o.exec(flaky, 'probe.touch', o.member)).resolves.toBe('ran');
    const after = await withAdmin(async (c) => (await c.query("SELECT 1 FROM crove_kernel.security_event WHERE code = 'ENTITLEMENTS_UNAVAILABLE'")).rowCount);
    expect(after).toBe((before ?? 0) + 1);
    // A known answer is kept after the cache expires: [] holds nothing, so the app stays off while the port is down.
    await expect(o.exec(port, 'probe.touch', o.member)).rejects.toMatchObject(refusal);
    mode = 'throw';
    vi.setSystemTime(Date.now() + 61_000);
    await expect(o.exec(port, 'probe.touch', o.member)).rejects.toMatchObject(refusal);
    // The org's own choice never depends on billing: switched off, it is off whatever the port says.
    await o.setApp('probe', false);
    await expect(o.exec(flaky, 'probe.touch', o.member)).rejects.toMatchObject(refusal);
  });

  it('makes a command that opens busy work wait for a switch on the tenant row, whichever commits first', async () => {
    const o = await org();
    // A switch holds the row FOR UPDATE and commits the app off: the command that opens work then reads the new choice.
    const holder = new pg.Client({ connectionString: adminUrl });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM crove_kernel.tenant WHERE org_id = $1 FOR UPDATE', [o.orgId]);
      const started = o.exec(rt, 'probe.busy', o.member).then(
        (v) => ({ ok: v }),
        (e: unknown) => ({ refused: e as { code?: string } }),
      );
      // It waits on the row (a lock wait of its own), it does not run past the switch.
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i++) {
        waiting = (await withAdmin(async (c) => (await c.query("SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%tenant%for share%'")).rowCount)) === 1;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(true);
      await holder.query("UPDATE crove_kernel.tenant SET apps_off = '{probe}', apps_version = 2 WHERE org_id = $1", [o.orgId]);
      await holder.query('COMMIT');
      expect(await started).toMatchObject({ refused: { code: 'MODULE_OFF' } });
    } finally {
      await holder.query('ROLLBACK').catch(() => {});
      await holder.end();
    }
    // Opposite order: shared holders do not block each other, and a switch waits for a command that is running.
    const o2 = await org();
    await expect(o2.exec(rt, 'probe.busy', o2.member)).resolves.toBe('busy');
  });

  it('lists the apps an org has, without a context: deployment, choice and entitlement together', async () => {
    const o = await org();
    // The modules this runtime registered ('other' has no definition, so it is not one of them).
    expect(await rt.effectiveModules(o.orgId)).toEqual(['finance', 'kernel', 'probe']);
    await o.setApp('probe', false);
    expect(await rt.effectiveModules(o.orgId)).toEqual(['finance', 'kernel']);
    // kernel is always there, and another org is untouched.
    const p = await org();
    expect(await rt.effectiveModules(p.orgId)).toEqual(['finance', 'kernel', 'probe']);
    // An org with no tenant row has only kernel.
    expect(await rt.effectiveModules(randomUUID())).toEqual(['kernel']);
  });
});
