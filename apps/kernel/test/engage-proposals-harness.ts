// SPDX-License-Identifier: AGPL-3.0-only
// What the database tests of the Engage proposal-only twins share (epic #3857, E4, issue #3863): a database with every migration, a runtime with the real commands of the kernel, CRM, Social and Ads, an org with
// one owner (the person who connected the AI app, who approves what their coworker asked: the one-person path of P10) and a second owner on demand, an MCP company grant, and the three steps of a proposal:
// the AI app asks (the twin through a grant), a person approves (kernel.proposal.approve with a fresh second factor) or rejects.
// `executions(command, proposalId)` counts how many times the ORIGINAL command ran to success under that proposal, from the org log: the proof of "never" and of "exactly once".
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, type UserActor } from '@crove/kernel-runtime';
import { adsCommands, adsQueries } from '@crove/mod-ads';
import { crmCommands, crmQueries } from '@crove/mod-crm';
import { socialCommands, socialQueries } from '@crove/mod-social';
import { TEST_MANIFESTS } from './manifests.ts';

export const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
export const ENGAGE_SCOPE = 'ludy.engage.write';
export const ADS_SCOPE = 'ludy.ads.draft';

export interface Harness {
  runtime: Runtime;
  db: Db;
  adminUrl: string;
  orgId: string;
  owner: string;
  // A system command as the worker's login runs it (the conversation ingest, a job's record step): the fixtures of a test that the screens never create.
  system: <O = unknown>(component: string, command: string, input: unknown) => Promise<O>;
  q: <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: unknown[]) => Promise<pg.QueryResult<R>>;
  // A person at the browser: the owner, with a second factor from a moment ago when `mfa` (what an approval needs).
  person: (userId: string, mfa?: boolean) => UserActor;
  // A second owner of the org (a second eligible approver: four-eyes then holds the grantor back).
  addOwner: () => Promise<string>;
  // A company grant of the owner holding `scopes` (with the read scope) and the actor an AI app calls with.
  grant: (scopes?: readonly string[]) => Promise<{ grantId: string; actor: UserActor }>;
  // The AI app asks for `command` (a twin) with `payload`: the pending proposal's id, or the refusal.
  propose: (actor: UserActor, command: string, payload: unknown) => Promise<{ proposalId: string; status: string }>;
  approve: (proposalId: string, who?: string) => Promise<unknown>;
  reject: (proposalId: string, who?: string) => Promise<unknown>;
  proposal: (proposalId: string) => Promise<{ status: string; command: string; kind: string; tainted: boolean; payload: Record<string, unknown>; requested_by_grant: string | null; revision: number; result: unknown }>;
  // How many times `command` (the original) ran to success under the proposal.
  executions: (command: string, proposalId: string) => Promise<number>;
  // How many times `command` ran to success at all in this org (a call outside any proposal included).
  ran: (command: string) => Promise<number>;
  stop: () => Promise<void>;
}

export async function startHarness(prefix: string): Promise<Harness> {
  if (!ADMIN) throw new Error('CROVE_TEST_ADMIN_URL is not set');
  const dbName = `crove_test_${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const root = new pg.Client({ connectionString: ADMIN });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);
  await root.end();
  const base = new URL(ADMIN);
  base.pathname = `/${dbName}`;
  const adminUrl = base.toString();
  await migrate({ adminUrl, dir: MIGRATIONS });
  await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
  const app = new URL(adminUrl);
  app.username = 'crove_app';
  app.password = 'test-app-pw';
  const pool = createPool({ connectionString: app.toString(), max: 6 });
  const db = createDb(pool);
  const w = new URL(adminUrl);
  w.username = 'crove_worker';
  w.password = 'test-worker-pw';
  const workerPool = createPool({ connectionString: w.toString(), max: 2 });
  const registered = {
    commands: [...kernelCommands, ...socialCommands, ...crmCommands, ...adsCommands],
    queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries, ...crmQueries, ...adsQueries],
  };
  const worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(registered);
  const runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register(registered);
  async function q<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<pg.QueryResult<R>> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await c.query<R>(text, params);
    } finally {
      await c.end();
    }
  }
  const person = (userId: string, mfa = false): UserActor => ({ type: 'user', userId, aal: mfa ? 'aal2' : 'aal1', ...(mfa ? { mfaAt: Math.floor(Date.now() / 1000) } : {}) });
  const owner = await upsertIdentity(db, { issuer: 'engage-proposals', subject: `owner-${randomUUID()}`, email: `owner-${randomUUID().slice(0, 8)}@engage-proposals.test`, name: 'owner' });
  const { orgId } = await createOrg(runtime, person(owner), 'Engage proposals');
  const h: Harness = {
    runtime,
    db,
    system: <O>(component: string, command: string, input: unknown) => worker.execute<O>(command, input, { actor: { type: 'system', component }, orgId }),
    adminUrl,
    orgId,
    owner,
    q,
    person,
    addOwner: async () => {
      const id = await upsertIdentity(db, { issuer: 'engage-proposals', subject: `owner-${randomUUID()}`, email: `owner-${randomUUID().slice(0, 8)}@engage-proposals.test`, name: 'second owner' });
      await q(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'owner')`, [orgId, id]);
      return id;
    },
    grant: async (scopes = [ENGAGE_SCOPE, ADS_SCOPE]) => {
      const grantId = randomUUID();
      const all = ['ludy.read', ...scopes];
      await q(
        `INSERT INTO crove_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by, kind, member_id)
         VALUES ($1, $2, $3, $4, 'Dy', 'dy.example.org', $5::text[], $6, now(), now() + interval '30 days', $3, 'company', NULL)`,
        [orgId, grantId, owner, `client-${grantId}`, all, `oauth-${grantId}`],
      );
      return { grantId, actor: { type: 'user', userId: owner, aal: 'aal1', mcp: { grantId, clientId: `client-${grantId}`, clientName: 'Dy', scopes: all, kind: 'company' } } };
    },
    propose: (actor, command, payload) => runtime.execute<{ proposalId: string; status: string }>(command, { payload }, { actor, orgId }),
    approve: async (proposalId, who = owner) => {
      const row = (await q<{ revision: number }>(`SELECT revision FROM crove_kernel.proposal WHERE org_id = $1 AND id = $2`, [orgId, proposalId])).rows[0];
      return runtime.execute('kernel.proposal.approve', { id: proposalId, revision: row?.revision ?? 1 }, { actor: person(who, true), orgId });
    },
    reject: (proposalId, who = owner) => runtime.execute('kernel.proposal.reject', { id: proposalId, reason: 'no' }, { actor: person(who), orgId }),
    proposal: async (proposalId) => (await q(`SELECT status, command, kind, tainted, payload, requested_by_grant, revision, result FROM crove_kernel.proposal WHERE org_id = $1 AND id = $2`, [orgId, proposalId])).rows[0] as never,
    executions: async (command, proposalId) =>
      (await q<{ n: number }>(`SELECT count(*)::int AS n FROM crove_kernel.audit_event WHERE org_id = $1 AND command = $2 AND outcome = 'ok' AND detail ->> 'under_proposal' = $3`, [orgId, command, proposalId])).rows[0]?.n ?? 0,
    ran: async (command) => (await q<{ n: number }>(`SELECT count(*)::int AS n FROM crove_kernel.audit_event WHERE org_id = $1 AND command = $2 AND outcome = 'ok'`, [orgId, command])).rows[0]?.n ?? 0,
    stop: async () => {
      await pool.end();
      await workerPool.end();
      const r = new pg.Client({ connectionString: ADMIN });
      await r.connect();
      await r.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await r.end();
    },
  };
  return h;
}
