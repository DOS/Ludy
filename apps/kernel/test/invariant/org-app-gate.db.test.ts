// SPDX-License-Identifier: AGPL-3.0-only
// The runtime gate of per-org app enablement (ADR-0053 sections 3 and 5, slice b of #3307, issue #3309), step 3: strict. Step 1
// (#3326) accepted both behaviors until the runtime change landed (step 2, #3357); this file now requires it. A command, a query, a
// stream, a nested command and a lookup into an app the org switched off, or does not hold, answer MODULE_OFF 404 naming the app
// (not_installed for ctx.query), for a user, the system actor and an AI agent, and leave no idempotency key and no 'ok' audit row; the
// gate comes before the role check; a person who is not a member of the org learns nothing about its apps (the same whole refusal
// whether the app is on or off, never MODULE_OFF); kernel is never refused, so the owner can always switch an app back on; another org
// is unaffected; an app switched back on runs again; and the billing option is named `entitlements`: a port that answers [] holds
// no app, so a refused call proves the runtime reads it, and a port that throws never takes a command down (it fails open).
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
// Part of the invariant suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md).
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { buildKernelCommands, createOrg, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, defineCommand, defineQuery, type AgentActor, type Lookup } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const MEMBERS = ['owner', 'admin', 'member', 'viewer'] as const;
const suite = ADMIN ? describe : describe.skip;

// The app under test: a module id the build "ships" for this file, with a command, a query, and a kernel query that looks it up.
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
const nested = defineCommand({ name: 'kernel.gate_nested', input: z.object({}), risk: 'R1', sideEffect: 'none', access: ['owner', 'admin', 'member'], handler: async (ctx) => ctx.run('probe.touch', {}) });
const lookup = defineQuery({ name: 'kernel.gate_lookup', input: z.object({}), access: [...MEMBERS], handler: (ctx) => ctx.query<string>('probe.read', {}) });
// The same for the other two kinds of actor: a system command and query (the worker's), and an agent's. Each declares its writes (none).
const sysTouch = defineCommand({ name: 'probe.sys_touch', input: z.object({}), risk: 'R1', sideEffect: 'none', access: 'system', writes: [], handler: async () => 'ran' });
const sysRead = defineQuery({ name: 'probe.sys_read', input: z.object({}), access: 'system', handler: async () => 'read' });
const agentTouch = defineCommand({ name: 'probe.agent_touch', input: z.object({}), risk: 'R0', sideEffect: 'none', access: [], agent: { roles: 'any' }, writes: [], handler: async () => 'ran' });
const agentRead = defineQuery({ name: 'probe.agent_read', input: z.object({}), access: [], agent: { roles: 'any' }, handler: async () => 'read' });
// Kernel's own probes for the same actors: never refused, whatever apps are off.
const kernelSysRead = defineQuery({ name: 'kernel.gate_sys_read', input: z.object({}), access: 'system', handler: async () => 'read' });
const kernelAgentRead = defineQuery({ name: 'kernel.gate_agent_read', input: z.object({}), access: [], agent: { roles: 'any' }, handler: async () => 'read' });
const SHIPPED = ['kernel', 'probe', 'other'] as const;
const SYSTEM = { type: 'system' as const, component: 'kernel.agent' };

type Actor = { type: 'user'; userId: string; aal: 'aal1' | 'aal2'; sessionId?: string; mfaAt?: number };

suite('the per-org app gate of the runtime (ADR-0053, slice b step 1)', () => {
  const dbName = `crove_test_orggate_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let rt: Runtime;
  let definitionsOf: { commands: any[]; queries: any[] };
  // A runtime whose billing port is the given function (the option is named `entitlements`).
  const withPort = (port: (orgId: string) => Promise<readonly string[]>) => new Runtime(createDb(pool), { manifests: TEST_MANIFESTS, entitlements: port }).register(definitionsOf);
  // The worker login role's runtime, where agents and the system actor run.
  let worker: Runtime;
  let workerPool: pg.Pool;

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

  const person = (name: string) => upsertIdentity(createDb(pool), { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@orggate.test`, name: null });

  async function org() {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Gate ${randomUUID().slice(0, 6)}`);
    const [admin, member, viewer] = [await person('admin'), await person('member'), await person('viewer')];
    await withAdmin((c) =>
      c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')", [orgId, admin, member, viewer]),
    );
    const setApp = (module: string, enabled: boolean) => rt.execute('kernel.org.set_app', { module, enabled }, { actor: asUser(owner), orgId, idempotencyKey: randomUUID() });
    const run = (runtime: Runtime, user: string) => runtime.execute<string>('probe.touch', {}, { actor: asUser(user), orgId, idempotencyKey: randomUUID() });
    const readIt = (user: string) => rt.query<string>('probe.read', {}, { actor: asUser(user), orgId });
    const viaLookup = (user: string) => rt.query<Lookup<string>>('kernel.gate_lookup', {}, { actor: asUser(user), orgId });
    // An AI agent of the org with a live run (the worker starts it, as the agent runtime does).
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
    // The rows a run of probe.touch leaves: an idempotency key and an 'ok' audit row.
    const traces = () =>
      withAdmin(async (c) => ({
        keys: (await c.query("SELECT 1 FROM crove_kernel.idempotency_key WHERE org_id = $1 AND command = 'probe.touch'", [orgId])).rowCount,
        audits: (await c.query("SELECT 1 FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'probe.touch' AND outcome = 'ok'", [orgId])).rowCount,
      }));
    return { orgId, owner, admin, member, viewer, setApp, run, readIt, viaLookup, agent, traces };
  }

  // What a call answered: its value, or its whole refusal (code, status, message and details), so a comparison of two refusals
  // sees a leak through any of them.
  async function outcome<T>(call: Promise<T>): Promise<{ ok: T } | { refused: { code: string; status: number; message: string; details: unknown } }> {
    try {
      return { ok: await call };
    } catch (error) {
      const e = error as { code?: string; status?: number; message?: string; details?: unknown };
      return { refused: { code: String(e.code), status: Number(e.status), message: String(e.message), details: e.details ?? null } };
    }
  }

  // A call into an app the org switched off, or does not hold, is refused with MODULE_OFF 404 naming the app (any message, any further details).
  function expectModuleOff<T>(answer: Awaited<ReturnType<typeof outcome<T>>>): void {
    expect('refused' in answer, JSON.stringify(answer)).toBe(true);
    expect((answer as { refused: unknown }).refused).toMatchObject({ code: 'MODULE_OFF', status: 404, details: { module: 'probe' } });
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
    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    pool = createPool({ connectionString: url.toString(), max: 6 });
    const definitions = {
      commands: [...buildKernelCommands({ shippedModules: SHIPPED }), ...financeCommands, touch, sysTouch, agentTouch, nested],
      queries: [
        ...kernelQueries({ inboundDomain: null, apps: { shipped: SHIPPED, deployment: SHIPPED, entitlements: async () => ['full'] } }),
        ...financeQueries,
        read,
        streamed,
        lookup,
        sysRead,
        agentRead,
        kernelSysRead,
        kernelAgentRead,
      ],
    };
    rt = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register(definitions);
    const wurl = new URL(adminUrl);
    wurl.username = 'crove_worker';
    wurl.password = 'test-worker-pw';
    workerPool = createPool({ connectionString: wurl.toString(), max: 2 });
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(definitions);
    definitionsOf = definitions;
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('runs a command, a query and a lookup of an app that is on, for every role that may', async () => {
    const o = await org();
    await expect(o.run(rt, o.owner)).resolves.toBe('ran');
    await expect(o.run(rt, o.admin)).resolves.toBe('ran');
    await expect(o.run(rt, o.member)).resolves.toBe('ran');
    await expect(o.run(rt, o.viewer)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    for (const user of [o.owner, o.admin, o.member, o.viewer]) {
      await expect(o.readIt(user)).resolves.toBe('read');
      await expect(o.viaLookup(user)).resolves.toEqual({ status: 'ok', value: 'read' });
    }
  });

  it('refuses a command, a query, a stream, a nested command and a lookup of an app the org switched off, leaving no trace, and runs them again when it is back on', async () => {
    const o = await org();
    await o.setApp('probe', false);
    expectModuleOff(await outcome(o.run(rt, o.member)));
    expectModuleOff(await outcome(o.run(rt, o.owner)));
    // A role that could not run the command anyway (a viewer) gets MODULE_OFF: the gate comes before the role check.
    expectModuleOff(await outcome(o.run(rt, o.viewer)));
    expectModuleOff(await outcome(o.readIt(o.member)));
    expectModuleOff(await outcome(rt.stream('probe.stream', {}, { actor: asUser(o.member), orgId: o.orgId }, async () => {})));
    expectModuleOff(await outcome(rt.execute('kernel.gate_nested', {}, { actor: asUser(o.member), orgId: o.orgId, idempotencyKey: randomUUID() })));
    // A refused call leaves no trace: no idempotency key and no 'ok' audit row for it.
    expect(await o.traces()).toEqual({ keys: 0, audits: 0 });
    // ctx.query answers the typed not_installed, as for an app the deployment leaves out.
    await expect(o.viaLookup(o.member)).resolves.toEqual({ status: 'not_installed', module: 'probe' });
    // Switched back on: everything runs as before.
    await o.setApp('probe', true);
    await expect(o.run(rt, o.member)).resolves.toBe('ran');
    await expect(o.readIt(o.member)).resolves.toBe('read');
    await expect(o.viaLookup(o.member)).resolves.toEqual({ status: 'ok', value: 'read' });
    await expect(rt.execute('kernel.gate_nested', {}, { actor: asUser(o.member), orgId: o.orgId, idempotencyKey: randomUUID() })).resolves.toBe('ran');
  });

  it('leaves the other apps of the org, and the kernel, running while one is off', async () => {
    const o = await org();
    await o.setApp('probe', false);
    await o.setApp('other', false);
    // kernel is never refused: a member still reads the org and the apps, and the owner can switch an app back on.
    await expect(rt.query('kernel.org.get', {}, { actor: asUser(o.member), orgId: o.orgId })).resolves.toMatchObject({ orgId: o.orgId });
    const apps = await rt.query<{ apps: Array<{ id: string; enabled: boolean }> }>('kernel.org.apps', {}, { actor: asUser(o.member), orgId: o.orgId });
    expect(apps.apps.filter((a) => !a.enabled).map((a) => a.id).sort()).toEqual(['other', 'probe']);
    await expect(o.setApp('probe', true)).resolves.toMatchObject({ module: 'probe', enabled: true });
    await expect(o.run(rt, o.member)).resolves.toBe('ran');
  });

  it('answers a system actor and an AI agent like a user, and never refuses them in kernel', async () => {
    const o = await org();
    const agent = await o.agent();
    const asSystem = { actor: SYSTEM, orgId: o.orgId, idempotencyKey: randomUUID() };
    const asAgent = { actor: agent, orgId: o.orgId, idempotencyKey: randomUUID() };
    // With the app on, both run what they may.
    await expect(worker.execute('probe.sys_touch', {}, asSystem)).resolves.toBe('ran');
    await expect(worker.query('probe.sys_read', {}, { actor: SYSTEM, orgId: o.orgId })).resolves.toBe('read');
    await expect(worker.execute('probe.agent_touch', {}, asAgent)).resolves.toBe('ran');
    await expect(worker.query('probe.agent_read', {}, { actor: agent, orgId: o.orgId })).resolves.toBe('read');
    await o.setApp('probe', false);
    // Off: refused with MODULE_OFF, for the system actor and for the agent alike.
    expectModuleOff(await outcome(worker.execute('probe.sys_touch', {}, { ...asSystem, idempotencyKey: randomUUID() })));
    expectModuleOff(await outcome(worker.query('probe.sys_read', {}, { actor: SYSTEM, orgId: o.orgId })));
    expectModuleOff(await outcome(worker.execute('probe.agent_touch', {}, { ...asAgent, idempotencyKey: randomUUID() })));
    expectModuleOff(await outcome(worker.query('probe.agent_read', {}, { actor: agent, orgId: o.orgId })));
    // kernel is never refused, for either, with the app off.
    await expect(worker.query('kernel.gate_sys_read', {}, { actor: SYSTEM, orgId: o.orgId })).resolves.toBe('read');
    await expect(worker.query('kernel.gate_agent_read', {}, { actor: agent, orgId: o.orgId })).resolves.toBe('read');
  });

  it('touches no other org: an app one org switched off still runs for the next', async () => {
    const a = await org();
    const b = await org();
    await a.setApp('probe', false);
    await expect(b.run(rt, b.member)).resolves.toBe('ran');
    await expect(b.readIt(b.member)).resolves.toBe('read');
    await expect(b.viaLookup(b.member)).resolves.toEqual({ status: 'ok', value: 'read' });
  });

  it('tells a person who is not a member nothing about the org\'s apps: the same refusal whether the app is on or off', async () => {
    const o = await org();
    const outsider = await person('outsider');
    const other = await org();
    // A member of another org is as much a stranger here as someone in no org.
    for (const stranger of [outsider, other.owner]) {
      const refusals = async () => ({
        command: await outcome(o.run(rt, stranger)),
        query: await outcome(o.readIt(stranger)),
        lookup: await outcome(o.viaLookup(stranger)),
      });
      const on = await refusals();
      await o.setApp('probe', false);
      const off = await refusals();
      await o.setApp('probe', true);
      for (const answer of [on.command, on.query, on.lookup, off.command, off.query, off.lookup]) {
        expect('refused' in answer, JSON.stringify(answer)).toBe(true);
        expect((answer as { refused: { code: string } }).refused.code).not.toBe('MODULE_OFF');
      }
      expect(off).toEqual(on);
    }
  });

  it('reads the billing option `entitlements`: a port that holds the org to nothing refuses its apps, one that holds the app does not', async () => {
    const o = await org();
    // A port answering [] holds no app but kernel: the app is refused though the org never switched it off.
    const nothing = withPort(async () => []);
    expectModuleOff(await outcome(o.run(nothing, o.member)));
    expectModuleOff(await outcome(nothing.query<string>('probe.read', {}, { actor: asUser(o.member), orgId: o.orgId })));
    await expect(nothing.query<Lookup<string>>('kernel.gate_lookup', {}, { actor: asUser(o.member), orgId: o.orgId })).resolves.toEqual({ status: 'not_installed', module: 'probe' });
    // kernel is never refused for want of an entitlement.
    await expect(nothing.query('kernel.org.get', {}, { actor: asUser(o.member), orgId: o.orgId })).resolves.toMatchObject({ orgId: o.orgId });
    // The key of the app, or `full`, holds it; the key of another app does not.
    await expect(o.run(withPort(async () => ['probe']), o.member)).resolves.toBe('ran');
    await expect(o.run(withPort(async () => ['full']), o.member)).resolves.toBe('ran');
    expectModuleOff(await outcome(o.run(withPort(async () => ['other']), o.member)));
    // Another org is asked for by its own id.
    const other = await org();
    const askedFor: string[] = [];
    await other.run(
      withPort(async (orgId) => {
        askedFor.push(orgId);
        return ['full'];
      }),
      other.member,
    );
    expect(askedFor).toEqual([other.orgId]);
  });

  it('does not let a failing billing port take a command down', async () => {
    const o = await org();
    const failing = withPort(async () => {
      throw new Error('billing is down');
    });
    await expect(o.run(failing, o.member)).resolves.toBe('ran');
    await o.setApp('probe', false);
    // Off by the org's own choice: refused whatever the port says (the choice does not depend on billing).
    expectModuleOff(await outcome(o.run(failing, o.member)));
  });
});
