// SPDX-License-Identifier: AGPL-3.0-only
// The runtime gate of per-org app enablement (ADR-0053 sections 3 and 5, slice b of #3307, issue #3309), step 1 of its two
// protected steps: this file accepts BOTH behaviors for what the runtime does not do yet. A command, a query and a lookup
// into an app the org switched off either still run (today) or answer the typed refusal (MODULE_OFF 404 for a command and
// a query, not_installed for ctx.query: step 2, the runtime change). What it pins from today, and must keep after step 2:
// a person who is not a member of the org learns nothing about its apps (the same refusal whether the app is on or off, never
// MODULE_OFF); kernel is never refused, so the owner can always switch an app back on; another org is unaffected; the
// owner's choice shows in kernel.org.apps at once and an app switched back on runs again; and a billing port that fails never takes a command
// down (it fails open). A third tests-only PR makes the "either" cases strict once step 2 is on main (the runtime PR cannot
// edit this base file, protected.yml). Two things step 2 must keep for this file to pass: a module that is registered but
// listed in no deployment setting (`probe`) counts as on for the runtime, and the billing option is named `entitlements`
// (the strict PR checks it, since an unknown name would leave the failing-port case passing for no reason). Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
// Part of the invariant suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md).
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { buildKernelCommands, createOrg, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, defineCommand, defineQuery, type Lookup } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const MEMBERS = ['owner', 'admin', 'member', 'viewer'] as const;
const suite = ADMIN ? describe : describe.skip;

// The app under test: a module id the build "ships" for this file, with a command, a query, and a kernel query that looks it up.
const touch = defineCommand({ name: 'probe.touch', input: z.object({}), risk: 'R1', sideEffect: 'none', access: ['owner', 'admin', 'member'], handler: async () => 'ran' });
const read = defineQuery({ name: 'probe.read', input: z.object({}), access: [...MEMBERS], handler: async () => 'read' });
const lookup = defineQuery({ name: 'kernel.gate_lookup', input: z.object({}), access: [...MEMBERS], handler: (ctx) => ctx.query<string>('probe.read', {}) });
const SHIPPED = ['kernel', 'probe', 'other'] as const;

type Actor = { type: 'user'; userId: string; aal: 'aal1' | 'aal2' };

suite('the per-org app gate of the runtime (ADR-0053, slice b step 1)', () => {
  const dbName = `crove_test_orggate_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let rt: Runtime;
  let failing: Runtime;

  const asUser = (userId: string): Actor => ({ type: 'user', userId, aal: 'aal1' });

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
    return { orgId, owner, admin, member, viewer, setApp, run, readIt, viaLookup };
  }

  // What a call answered: its value, or its refusal as { code, status, module }.
  async function outcome<T>(call: Promise<T>): Promise<{ ok: T } | { refused: { code: string; status: number; module?: unknown } }> {
    try {
      return { ok: await call };
    } catch (error) {
      const e = error as { code?: string; status?: number; details?: { module?: unknown } };
      return { refused: { code: String(e.code), status: Number(e.status), ...(e.details?.module !== undefined ? { module: e.details.module } : {}) } };
    }
  }

  // Step 1: a call into an app the org switched off either still runs (the runtime does not gate yet) or is refused with
  // MODULE_OFF 404 naming the app (step 2). Anything else is a defect either way.
  function expectRunsOrModuleOff<T>(answer: Awaited<ReturnType<typeof outcome<T>>>, ran: T): void {
    if ('ok' in answer) {
      expect(answer.ok).toEqual(ran);
    } else {
      expect(answer.refused).toEqual({ code: 'MODULE_OFF', status: 404, module: 'probe' });
    }
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
      commands: [...buildKernelCommands({ shippedModules: SHIPPED }), touch],
      queries: [...kernelQueries({ inboundDomain: null, apps: { shipped: SHIPPED, deployment: SHIPPED, entitlements: async () => ['full'] } }), read, lookup],
    };
    rt = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register(definitions);
    // A runtime whose billing port throws. Step 2 adds the option (`entitlements`, the billing port's function) and then
    // fails open to the last answer, `full` when it has none; until then the option is ignored. Either way a command runs.
    failing = new Runtime(createDb(pool), {
      manifests: TEST_MANIFESTS,
      entitlements: async () => {
        throw new Error('billing is down');
      },
    } as ConstructorParameters<typeof Runtime>[1]).register(definitions);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
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

  it('answers a call into an app the org switched off by running it or by the typed refusal, and runs it again when switched back on', async () => {
    const o = await org();
    await o.setApp('probe', false);
    expectRunsOrModuleOff(await outcome(o.run(rt, o.member)), 'ran');
    expectRunsOrModuleOff(await outcome(o.readIt(o.member)), 'read');
    // ctx.query answers the lookup, or not_installed (never a thrown refusal).
    const looked = await o.viaLookup(o.member);
    expect([{ status: 'ok', value: 'read' }, { status: 'not_installed', module: 'probe' }]).toContainEqual(looked);
    // Switched back on: everything runs as before.
    await o.setApp('probe', true);
    await expect(o.run(rt, o.member)).resolves.toBe('ran');
    await expect(o.readIt(o.member)).resolves.toBe('read');
    await expect(o.viaLookup(o.member)).resolves.toEqual({ status: 'ok', value: 'read' });
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

  it('does not let a failing billing port take a command down', async () => {
    const o = await org();
    await expect(o.run(failing, o.member)).resolves.toBe('ran');
    await o.setApp('probe', false);
    // Off by the org's own choice: the same answers as with a working port (the choice does not depend on billing).
    expectRunsOrModuleOff(await outcome(o.run(failing, o.member)), 'ran');
  });
});
