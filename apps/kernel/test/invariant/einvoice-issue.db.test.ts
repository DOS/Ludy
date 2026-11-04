// SPDX-License-Identifier: AGPL-3.0-only
// Issuing a sales e-invoice (#2502, ADR-0044 points 3 to 5, the addendum on who approves): the properties that make it a legal act only an approval can start, each a test here,
// against a real PostgreSQL, in SQL where the claim is about the database and not about a command:
//   1. the definer that moves a draft to `submitting` (crove_finance.einvoice_submit) is owned by the role made for it and is executable by the API's login alone; the approved-execution
//      test (crove_finance.approved_execution) is executable by that role alone;
//   2. that role can log in nowhere, holds no attribute that skips row security, and no login or tenant role can become it;
//   3. the draft guard refuses the move to `submitting` to a person's plain UPDATE and to the system context, and refuses it to the owner role itself when no approved execution
//      names the draft; a member or the worker cannot call the definer;
//   4. a failed draft goes back to a draft only for a code that says nothing was sent AND only when the issue call of its key is absent or failed.
// Keep this directory self-contained: import code under test, not fixtures from outside it. Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own
// database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const ROLE = 'crove_definer_einvoice';

const suite = ADMIN ? describe : describe.skip;

interface Org {
  orgId: string;
  owner: string;
  member: string;
}

suite('the issue of a sales e-invoice is a legal act only an approval starts (#2502)', () => {
  const dbName = `crove_test_einvoiceissue_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  let pool: pg.Pool;
  let runtime: Runtime;

  async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const admin = <T>(fn: (c: pg.Client) => Promise<T>) => withClient(adminUrl, fn);
  const rows = async <T extends pg.QueryResultRow>(text: string, params: unknown[] = []) => admin(async (c) => (await c.query<T>(text, params)).rows);

  async function person(name: string): Promise<string> {
    const tag = randomUUID().slice(0, 8);
    return upsertIdentity(createDb(pool), { issuer: 'test', subject: `${name}-${tag}`, email: `${name}-${tag}@einvoice.test`, name: null });
  }
  async function makeOrg(): Promise<Org> {
    const owner = await person('owner');
    const org = await createOrg(runtime, { type: 'user', userId: owner, aal: 'aal1' }, `Công ty ${randomUUID().slice(0, 8)}`);
    const member = await person('member');
    await admin((c) => c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [org.orgId, member]));
    return { orgId: org.orgId, owner, member };
  }
  // A series and a draft of the org, made as the table's owner outside any context; the draft is a plain draft with a series, ready to be asked for.
  async function draftOf(org: Org): Promise<{ id: string; key: string }> {
    const series = randomUUID();
    await admin((c) => c.query(`INSERT INTO crove_finance.einvoice_series (org_id, id, provider, template_no, symbol) VALUES ($1, $2, 'sandbox', '1', 'C26TAA')`, [org.orgId, series]));
    const id = randomUUID();
    await admin((c) =>
      c.query(`INSERT INTO crove_finance.einvoice_draft (org_id, id, series_id, invoice_date, buyer_kind, subtotal, vat_amount, total) VALUES ($1, $2, $3, current_date, 'consumer', 100000, 10000, 110000)`, [org.orgId, id, series]),
    );
    const key = String((await rows<{ k: string }>('SELECT idempotency_key::text AS k FROM crove_finance.einvoice_draft WHERE org_id = $1 AND id = $2', [org.orgId, id]))[0]?.k);
    return { id, key };
  }
  // SQL in a context of each kind, as the API's login (a person) or the worker's (the system), rolled back.
  async function inContext<T>(org: Org, who: 'owner' | 'member' | 'system', fn: (c: pg.Client) => Promise<T>): Promise<T> {
    return withClient(who === 'system' ? workerUrl : appUrl, async (c) => {
      await c.query('BEGIN');
      try {
        if (who === 'system') await c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [org.orgId]);
        else await c.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [org[who], org.orgId]);
        return await fn(c);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
      }
    });
  }
  const refused = (c: pg.Client, text: string, params: unknown[], message: string) => expect(c.query(text, params)).rejects.toMatchObject({ code: '42501', message: expect.stringContaining(message) });
  const submit = `UPDATE crove_finance.einvoice_draft SET state = 'submitting', submitted_at = pg_catalog.now() WHERE org_id = $1 AND id = $2`;

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
    const loginUrl = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    appUrl = loginUrl('crove_app', 'test-app-pw');
    workerUrl = loginUrl('crove_worker', 'test-worker-pw');
    pool = createPool({ connectionString: appUrl, max: 2 });
    runtime = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('owns the submit definer by the role made for it, runs it for the API login alone, and lets that role alone run the approved-execution test', async () => {
    const submitDef = await rows<{ owner: string; definer: boolean; config: string[] | null; app: boolean; worker: boolean; tenant: boolean; other: boolean; pub: boolean }>(
      `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.proconfig AS config,
              has_function_privilege('crove_app', p.oid, 'EXECUTE') AS app, has_function_privilege('crove_worker', p.oid, 'EXECUTE') AS worker,
              has_function_privilege('crove_tenant', p.oid, 'EXECUTE') AS tenant, has_function_privilege('crove_definer_tenant', p.oid, 'EXECUTE') AS other,
              COALESCE((SELECT bool_or(a.grantee = 0) FROM aclexplode(p.proacl) a), true) AS pub
       FROM pg_proc p WHERE p.oid = 'crove_finance.einvoice_submit(uuid, text)'::regprocedure`,
    );
    expect(submitDef).toEqual([{ owner: ROLE, definer: true, config: ['search_path=pg_catalog, pg_temp'], app: true, worker: false, tenant: false, other: false, pub: false }]);
    const approved = await rows<{ owner: string; definer: boolean; role: boolean; app: boolean; worker: boolean; tenant: boolean; other: boolean; pub: boolean }>(
      `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, has_function_privilege('${ROLE}', p.oid, 'EXECUTE') AS role,
              has_function_privilege('crove_app', p.oid, 'EXECUTE') AS app, has_function_privilege('crove_worker', p.oid, 'EXECUTE') AS worker,
              has_function_privilege('crove_tenant', p.oid, 'EXECUTE') AS tenant, has_function_privilege('crove_definer_tenant', p.oid, 'EXECUTE') AS other,
              COALESCE((SELECT bool_or(a.grantee = 0) FROM aclexplode(p.proacl) a), true) AS pub
       FROM pg_proc p WHERE p.oid = 'crove_finance.approved_execution(text, jsonb, numeric)'::regprocedure`,
    );
    expect(approved[0]).toMatchObject({ definer: true, role: true, app: false, worker: false, tenant: false, other: false, pub: false });
  });

  it('makes the role no one can log in as or become: no attribute that skips row security, no member among the logins and the tenant roles', async () => {
    const [attrs] = await rows<{ login: boolean; super: boolean; bypass: boolean; createrole: boolean; createdb: boolean; replication: boolean; inherit: boolean }>(
      `SELECT rolcanlogin AS login, rolsuper AS super, rolbypassrls AS bypass, rolcreaterole AS createrole, rolcreatedb AS createdb, rolreplication AS replication, rolinherit AS inherit FROM pg_roles WHERE rolname = $1`,
      [ROLE],
    );
    expect(attrs).toEqual({ login: false, super: false, bypass: false, createrole: false, createdb: false, replication: false, inherit: true });
    for (const role of ['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant']) {
      const [can] = await rows<{ member: boolean; set: boolean; usage: boolean }>(`SELECT pg_has_role($1, $2, 'MEMBER') AS member, pg_has_role($1, $2, 'SET') AS set, pg_has_role($1, $2, 'USAGE') AS usage`, [role, ROLE]);
      expect(can, role).toEqual({ member: false, set: false, usage: false });
    }
    // No crove_* login that is not a superuser (the migration runner is one here) is, or can become, the role. The cluster is shared with the runs of the migration tests, whose own
    // non-superuser runners hold it by design while they migrate; they are not Ludy's logins.
    const logins = await rows<{ rolname: string }>(
      `SELECT r.rolname FROM pg_roles r WHERE r.rolcanlogin AND NOT r.rolsuper AND r.rolname ~ '^crove_' AND r.rolname !~ 'test_runner' AND (pg_has_role(r.oid, $1, 'MEMBER') OR pg_has_role(r.oid, $1, 'SET'))`,
      [ROLE],
    );
    expect(logins).toEqual([]);
    // It is a tenant role underneath, so row security still binds it.
    const [tenant] = await rows<{ member: boolean }>(`SELECT pg_has_role($1, 'crove_tenant', 'MEMBER') AS member`, [ROLE]);
    expect(tenant?.member).toBe(true);
  });

  it('refuses the move to submitting to a plain UPDATE, to the system context and to the owner role itself when no approval names the draft; a member and the worker cannot call the definer', async () => {
    const org = await makeOrg();
    const d = await draftOf(org);
    await inContext(org, 'owner', (c) => refused(c, submit, [org.orgId, d.id], 'EINVOICE_FIELD_LOCKED'));
    await inContext(org, 'system', (c) => refused(c, submit, [org.orgId, d.id], 'EINVOICE_STATE'));
    // A member cannot ask the definer; the worker has no EXECUTE on it.
    await inContext(org, 'member', (c) => refused(c, 'SELECT crove_finance.einvoice_submit($1::uuid, $2)', [d.id, 'a'.repeat(64)], 'EINVOICE_ISSUE_FORBIDDEN'));
    await inContext(org, 'system', (c) =>
      expect(c.query('SELECT crove_finance.einvoice_submit($1::uuid, $2)', [d.id, 'a'.repeat(64)])).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('permission denied') }),
    );
    // The identity of the owner role is not the approval: a session that can act as it, in the org's context, still cannot move the draft without an approved execution for it.
    await admin(async (c) => {
      await c.query('BEGIN');
      try {
        await c.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [org.owner, org.orgId]);
        await c.query(`SET LOCAL ROLE ${ROLE}`);
        await refused(c, submit, [org.orgId, d.id], 'EINVOICE_FIELD_LOCKED');
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
      }
    });
    expect((await rows<{ state: string }>('SELECT state FROM crove_finance.einvoice_draft WHERE org_id = $1 AND id = $2', [org.orgId, d.id]))[0]?.state).toBe('draft');
  });

  it('sends a failed draft back to a draft only for a code that says nothing was sent and only when the issue call of its key is absent or failed', async () => {
    const org = await makeOrg();
    const d = await draftOf(org);
    // A draft that was sent and failed: put there as the table's owner with the guard off (a fixture; no command makes it so).
    const setDraft = (set: string) =>
      admin(async (c) => {
        await c.query('BEGIN');
        await c.query('SET LOCAL session_replication_role = replica');
        await c.query(`UPDATE crove_finance.einvoice_draft SET ${set} WHERE org_id = $1 AND id = $2`, [org.orgId, d.id]);
        await c.query('COMMIT');
      });
    await setDraft(`state = 'failed', submitted_at = pg_catalog.now(), error_code = 'CREDENTIALS'`);
    const back = `UPDATE crove_finance.einvoice_draft SET state = 'draft', idempotency_key = pg_catalog.gen_random_uuid(), submitted_at = NULL, next_check_at = NULL, check_attempts = 0 WHERE org_id = $1 AND id = $2`;
    const callKey = `einvoice:issue:${d.key}`;
    const putCall = async (state: 'started' | 'ambiguous' | 'succeeded' | 'failed') => {
      // A call is recorded as started before it is made, then ends as the job's own steps end it (a trigger refuses any other first state).
      await rows(`DELETE FROM crove_kernel.external_call WHERE org_id = $1 AND key = $2`, [org.orgId, callKey]);
      await rows(`INSERT INTO crove_kernel.external_call (org_id, key, module, target, step, retry_safety) VALUES ($1, $2, 'finance', 'einvoice_sandbox', 'issue', 'reconcile_only')`, [org.orgId, callKey]);
      if (state === 'ambiguous') await rows(`UPDATE crove_kernel.external_call SET state = 'ambiguous', error_kind = 'transient', error_code = 'TIMEOUT' WHERE org_id = $1 AND key = $2`, [org.orgId, callKey]);
      if (state === 'succeeded') await rows(`UPDATE crove_kernel.external_call SET state = 'succeeded', finished_at = pg_catalog.now() WHERE org_id = $1 AND key = $2`, [org.orgId, callKey]);
      if (state === 'failed') {
        await rows(`UPDATE crove_kernel.external_call SET state = 'failed', error_kind = 'permission', error_code = 'CREDENTIALS', finished_at = pg_catalog.now() WHERE org_id = $1 AND key = $2`, [org.orgId, callKey]);
      }
    };
    // The ledger has the issue call of this key started, ambiguous or succeeded: the provider may hold the invoice, so the draft does not go back whatever its code says.
    for (const state of ['started', 'ambiguous', 'succeeded'] as const) {
      await putCall(state);
      await inContext(org, 'system', (c) => refused(c, back, [org.orgId, d.id], 'EINVOICE_STATE'));
    }
    // Failed (the send was refused before it was made): it goes back.
    await putCall('failed');
    await inContext(org, 'system', async (c) => {
      await c.query(back, [org.orgId, d.id]);
      expect((await c.query<{ state: string }>('SELECT state FROM crove_finance.einvoice_draft WHERE org_id = $1 AND id = $2', [org.orgId, d.id])).rows[0]?.state).toBe('draft');
    });
    // A code that does not say nothing was sent (the provider may have the invoice) never goes back, whatever the ledger says.
    await setDraft(`state = 'failed', submitted_at = pg_catalog.now(), error_code = 'STATUS_UNKNOWN'`);
    await inContext(org, 'system', (c) => refused(c, back, [org.orgId, d.id], 'EINVOICE_STATE'));
  });
});
