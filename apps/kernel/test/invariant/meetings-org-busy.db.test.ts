// SPDX-License-Identifier: AGPL-3.0-only
// Invariant suite (Decision 7): crove_meetings.org_busy_reasons (ADR-0053 section 4, slice c C3a), the definer behind "Meetings can not be switched off while a
// recording is open". It reads rows the switcher may not read (another member's attendee-only meeting, another member's platform recording), so its security cases
// are pinned here: it answers flags only, it refuses an org other than the sealed context's (42501), a start in the future is no recording, and nothing but the
// tenant role may run it. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@ludy/db';
import { migrate } from '@ludy/db/migrate';
import { buildKernelCommands, createOrg, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { Runtime, defineCommand } from '@ludy/kernel-runtime';
import { z } from 'zod';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { createDbClient, createDbPool, resolveDbIdentifiers, setActiveRolePasswords, type DbIdentifiers } from './fixtures/db-identifiers.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('crove_meetings.org_busy_reasons (ADR-0053, C3a)', () => {
  const dbName = `crove_test_meetingsbusy_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let dbIds: DbIdentifiers | undefined;
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  const people: Record<string, string> = {};
  const orgs: Record<string, string> = {};
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = createDbClient({ connectionString: adminUrl }, dbIds);
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  // A command of the test that asks the definer for any org from inside the sealed context of the org it runs in, and says what came back or the SQLSTATE.
  const probe = defineCommand({
    name: 'kernel.test.meetings_busy',
    input: z.object({ target: z.string() }),
    risk: 'R1',
    sideEffect: 'internal',
    access: ['owner'],
    handler: async (ctx, input) => {
      await sql`SAVEPOINT busy_probe`.execute(ctx.trx);
      try {
        const { rows } = await sql<{ recording: boolean; import: boolean }>`SELECT recording, import FROM crove_meetings.org_busy_reasons(${input.target}::uuid, 4)`.execute(ctx.trx);
        return { ok: true as const, ...rows[0] };
      } catch (error) {
        await sql`ROLLBACK TO SAVEPOINT busy_probe`.execute(ctx.trx);
        return { ok: false as const, code: (error as { code?: string }).code ?? 'unknown' };
      }
    },
  });
  const ask = (as: 'a' | 'b', target: 'a' | 'b') =>
    rt.execute<{ ok: boolean; recording?: boolean; import?: boolean; code?: string }>('kernel.test.meetings_busy', { target: orgs[target] }, { actor: asUser(people[as] as string), orgId: orgs[as] as string, idempotencyKey: randomUUID() });

  const meeting = (org: string, recorder: string, startedAt: string, extra = '') =>
    admin((c) =>
      c.query(
        `INSERT INTO crove_meetings.meeting (org_id, id, recorder_user_id, title, consent_method, consent_confirmed_by, audio_retention_date, text_retention_date, started_at, visibility)
         VALUES ($1, $2, $3, 'Họp', 'told_at_start', $3, current_date + 30, current_date + 365, ${startedAt}, 'attendees')${extra}`,
        [org, randomUUID(), recorder],
      ),
    );

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    dbIds = await resolveDbIdentifiers(adminUrl);
    await setActiveRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' }, dbIds);
    const app = new URL(adminUrl);
    app.username = dbIds ? dbIds.roleName('crove_app') : 'crove_app';
    app.password = 'test-app-pw';
    pool = createDbPool({ connectionString: app.toString(), max: 4 }, dbIds);
    db = createDb(pool);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...buildKernelCommands({}), probe], queries: kernelQueries({ inboundDomain: null }) });
    for (const k of ['a', 'b', 'recorder']) people[k] = await upsertIdentity(db, { issuer: 'test', subject: `mb-${k}-${randomUUID()}`, email: `mb-${k}@example.com`, name: null });
    for (const k of ['a', 'b']) ({ orgId: orgs[k] } = await createOrg(rt, asUser(people[k] as string), `Org ${k}`));
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [orgs.a, people.recorder]));
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('answers flags for the org of the sealed context, counting another member\'s attendee-only meeting the caller could not read', async () => {
    expect(await ask('a', 'a')).toMatchObject({ ok: true, recording: false, import: false });
    await meeting(orgs.a as string, people.recorder as string, 'now()');
    expect(await ask('a', 'a')).toMatchObject({ ok: true, recording: true, import: false });
  });

  it('refuses an org other than the sealed context\'s with 42501, both ways, and tells org B nothing of org A', async () => {
    expect(await ask('a', 'b')).toEqual({ ok: false, code: '42501' });
    expect(await ask('b', 'a')).toEqual({ ok: false, code: '42501' });
    // Org B has no open work whatever org A has.
    expect(await ask('b', 'b')).toMatchObject({ ok: true, recording: false, import: false });
  });

  it('does not count a start in the future, nor a meeting that ended or is old, as a recording', async () => {
    await admin((c) => c.query('DELETE FROM crove_meetings.meeting WHERE org_id = $1', [orgs.a]));
    await meeting(orgs.a as string, people.recorder as string, "now() + interval '2 hours'");
    await meeting(orgs.a as string, people.recorder as string, "now() - interval '5 hours'");
    await meeting(orgs.a as string, people.recorder as string, 'now()', '');
    await admin((c) => c.query('UPDATE crove_meetings.meeting SET ended_at = now() WHERE org_id = $1', [orgs.a]));
    expect(await ask('a', 'a')).toMatchObject({ ok: true, recording: false });
    // A start a minute ahead (clock skew) still counts.
    await meeting(orgs.a as string, people.recorder as string, "now() + interval '1 minute'");
    expect(await ask('a', 'a')).toMatchObject({ ok: true, recording: true });
  });

  it('is granted to the tenant role alone, and returns two flags and no row', async () => {
    const { rows } = await admin((c) =>
      c.query<{ grantees: string[]; ret: string }>(
        `SELECT COALESCE((SELECT array_agg(DISTINCT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE (SELECT r.rolname FROM pg_roles r WHERE r.oid = x.grantee)::text END)
                          FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) x WHERE x.grantee <> p.proowner), '{}'::text[]) AS grantees,
                pg_get_function_result(p.oid) AS ret
         FROM pg_proc p WHERE p.oid = 'crove_meetings.org_busy_reasons(uuid, integer)'::regprocedure`,
      ),
    );
    // Granted to crove_tenant only: no PUBLIC and no login role is named (a login role that is a member of the tenant role runs it as that role, as every tenant command does).
    expect(rows[0]?.grantees).toEqual(['crove_tenant']);
    expect(rows[0]?.ret).toBe('TABLE(recording boolean, import boolean)');
  });
});
