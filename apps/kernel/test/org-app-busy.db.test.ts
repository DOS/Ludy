// SPDX-License-Identifier: AGPL-3.0-only
// Switching an app off is refused while its work is open (ADR-0053 section 4, slice c C3a), on PostgreSQL 17: kernel.org.set_app asks the app's busy probe under the
// tenant row, a recording of the extension keeps Meetings on, an activation begun at the platform keeps Ads on, and turning an app on, or off when it already is,
// is never refused. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { buildKernelCommands, createOrg, kernelQueries, upsertIdentity } from '@crove/kernel';
import { adsBusy } from '@crove/mod-ads';
import { meetingsBusy } from '@crove/mod-meetings';
import { Runtime } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SHIPPED = ['kernel', 'finance', 'social', 'crm', 'ads', 'meetings', 'notes'];

suite('switching an app off while its work is open (ADR-0053, C3a)', () => {
  const dbName = `crove_test_appbusy_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let fake: string[] = [];
  let owner = '';
  let orgId = '';
  const asUser = () => ({ type: 'user' as const, userId: owner, aal: 'aal1' as const });
  const setApp = (module: string, enabled: boolean) => rt.execute('kernel.org.set_app', { module, enabled }, { actor: asUser(), orgId, idempotencyKey: randomUUID() });
  const refused = async (module: string) => {
    try {
      await setApp(module, false);
      return null;
    } catch (error) {
      return error as { code?: string; status?: number; details?: { reasons?: string[]; module?: string } };
    }
  };

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
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
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    pool = createPool({ connectionString: app.toString(), max: 4 });
    db = createDb(pool);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: buildKernelCommands({ shippedModules: SHIPPED, appBusy: { meetings: meetingsBusy, ads: adsBusy, social: async () => fake } }),
      queries: kernelQueries({ inboundDomain: null }),
    });
    owner = await upsertIdentity(db, { issuer: 'test', subject: `appbusy-${randomUUID()}`, email: 'appbusy-owner@example.com', name: null });
    ({ orgId } = await createOrg(rt, asUser(), 'Org App Busy'));
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('refuses to turn an app off while its probe names open work, and says what and which app', async () => {
    fake = ['recording', 'import'];
    const error = await refused('social');
    expect(error).toMatchObject({ code: 'APP_BUSY', status: 409, details: { module: 'social', reasons: ['recording', 'import'] } });
    // Nothing changed: the app is still on.
    const off = await admin(async (c) => (await c.query<{ apps_off: string[] }>('SELECT apps_off FROM crove_kernel.tenant WHERE org_id = $1', [orgId])).rows[0]?.apps_off);
    expect(off).toEqual([]);
    fake = [];
    await expect(setApp('social', false)).resolves.toMatchObject({ module: 'social', enabled: false });
  });

  it('never refuses turning an app on, or off when it already is, and does not ask an app that has no probe', async () => {
    fake = ['recording'];
    // Already off (from the case above): off again changes nothing, so it is not refused; on is never refused.
    await expect(setApp('social', false)).resolves.toMatchObject({ enabled: false });
    await expect(setApp('social', true)).resolves.toMatchObject({ enabled: true });
    // An app with no probe (CRM) goes off whatever fake says.
    await expect(setApp('crm', false)).resolves.toMatchObject({ enabled: false });
    await setApp('crm', true);
    fake = [];
  });

  // Fixtures as staff write them: triggers and foreign keys are off for the insert, as these rows are made by flows this test is not about. The launch ledger's own
  // guards (ENABLE ALWAYS) are switched off for the statement too, and restored.
  const asStaff = <T,>(fn: (c: pg.Client) => Promise<T>) =>
    admin(async (c) => {
      await c.query('SET session_replication_role = replica');
      await c.query('ALTER TABLE crove_ads.ad_launch DISABLE TRIGGER USER');
      try {
        return await fn(c);
      } finally {
        await c.query('ALTER TABLE crove_ads.ad_launch ENABLE TRIGGER USER');
        await c.query('SET session_replication_role = DEFAULT');
      }
    });

  it('keeps Meetings on while any member is recording, even a meeting the switcher cannot read, until the recording ends', async () => {
    expect(await refused('meetings')).toBeNull();
    await setApp('meetings', true);
    // Another member's meeting, visible to its attendees only: the owner who switches cannot read it, and it still counts.
    const recorder = await upsertIdentity(db, { issuer: 'test', subject: `appbusy-rec-${randomUUID()}`, email: 'appbusy-recorder@example.com', name: null });
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [orgId, recorder]));
    const meetingId = randomUUID();
    await admin((c) =>
      c.query(
        `INSERT INTO crove_meetings.meeting (org_id, id, recorder_user_id, title, consent_method, consent_confirmed_by, audio_retention_date, text_retention_date, started_at, visibility)
         VALUES ($1, $2, $3, 'Họp đang ghi', 'told_at_start', $3, current_date + 30, current_date + 365, now(), 'attendees')`,
        [orgId, meetingId, recorder],
      ),
    );
    expect(await refused('meetings')).toMatchObject({ code: 'APP_BUSY', details: { module: 'meetings', reasons: ['recording'] } });
    await admin((c) => c.query('UPDATE crove_meetings.meeting SET ended_at = now() WHERE org_id = $1 AND id = $2', [orgId, meetingId]));
    expect(await refused('meetings')).toBeNull();
    await setApp('meetings', true);
  });

  it('keeps Meetings on while a platform recording is being imported, even one of another member', async () => {
    const member = await upsertIdentity(db, { issuer: 'test', subject: `appbusy-imp-${randomUUID()}`, email: 'appbusy-importer@example.com', name: null });
    const id = randomUUID();
    await asStaff((c) =>
      c.query(
        `INSERT INTO crove_kernel.meeting_platform_recording (org_id, id, connection_id, user_id, external_id, started_at, status, meeting_id, staging_key)
         VALUES ($1, $2, $3, $4, 'ext-1', now(), 'importing', $5, $6)`,
        [orgId, id, randomUUID(), member, randomUUID(), `staging/${'a'.repeat(64)}`],
      ),
    );
    expect(await refused('meetings')).toMatchObject({ code: 'APP_BUSY', details: { reasons: ['import'] } });
    await asStaff((c) => c.query("UPDATE crove_kernel.meeting_platform_recording SET status = 'failed', staging_key = NULL, error_code = 'expired' WHERE org_id = $1 AND id = $2", [orgId, id]));
    expect(await refused('meetings')).toBeNull();
    await setApp('meetings', true);
  });

  it('does not let one org see another: the definer refuses an org other than the context', async () => {
    await expect(
      db.transaction().execute(async (trx) => {
        const { sql } = await import('kysely');
        await sql`SELECT crove_meetings.org_busy_reasons(${randomUUID()}::uuid, 4)`.execute(trx);
      }),
    ).rejects.toBeTruthy();
  });

  // A launch row as the ledger holds it, with the foreign keys and the guards off for the insert.
  const launch = async (state: string) => {
    const id = randomUUID();
    const finished = ['stopped', 'failed', 'cancelled'].includes(state);
    await asStaff((c) =>
      c.query(
        `INSERT INTO crove_ads.ad_launch (org_id, id, ad_account_id, legal_entity_id, draft_id, proposal_id, plan_hash, state, currency, daily_budget, start_on, end_on, amount, commit_until, created_by, started_at, finished_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'VND', 100000, current_date, current_date, 100000, $9, $10, now(), $11)`,
        [orgId, id, randomUUID(), randomUUID(), randomUUID(), randomUUID(), `sha256:${'b'.repeat(64)}`, state, finished ? null : new Date().toISOString().slice(0, 10), owner, finished ? new Date().toISOString() : null],
      ),
    );
    return id;
  };
  const call = async (launchId: string, step: string, state = 'started') => {
    await asStaff((c) =>
      c.query(`INSERT INTO crove_kernel.external_call (org_id, id, key, module, target, step, retry_safety, state) VALUES ($1, $2, $3, 'ads', 'meta', $4, 'idempotent', $5)`, [
        orgId,
        randomUUID(),
        `ads.launch:${launchId}:1:${step}`,
        step,
        state,
      ]),
    );
  };
  const windDown = (id: string) => asStaff((c) => c.query('UPDATE crove_ads.ad_launch SET wound_down_at = now() WHERE org_id = $1 AND id = $2', [orgId, id]));

  it('keeps Ads on while a campaign runs, and says so, until it is stopped and wound down', async () => {
    const id = await launch('live');
    expect(await refused('ads')).toMatchObject({ code: 'APP_BUSY', details: { module: 'ads', reasons: ['campaign_running'] } });
    // Stopped, with its objects not yet paused at the platform: still spend to stop.
    await asStaff((c) => c.query("UPDATE crove_ads.ad_launch SET state = 'stopped', finished_at = now() WHERE org_id = $1 AND id = $2", [orgId, id]));
    expect(await refused('ads')).toMatchObject({ code: 'APP_BUSY', details: { reasons: ['wind_down_open'] } });
    await windDown(id);
    expect(await refused('ads')).toBeNull();
    await setApp('ads', true);
  });

  it('keeps Ads on while an activation of an open launch was begun and not settled, and ignores the rows of a launch that is over', async () => {
    const live = await launch('live');
    await call(live, 'activate_a');
    expect(await refused('ads')).toMatchObject({ code: 'APP_BUSY', details: { reasons: ['campaign_running', 'activation_open'] } });
    // The launch is wound down: its unsettled call is history (some paths leave one for good) and does not keep the app on.
    await asStaff((c) => c.query("UPDATE crove_ads.ad_launch SET state = 'stopped', finished_at = now(), wound_down_at = now() WHERE org_id = $1 AND id = $2", [orgId, live]));
    expect(await refused('ads')).toBeNull();
    await setApp('ads', true);
    // An unsettled call of an open launch counts as another call when it is not an activation.
    const open = await launch('needs_attention');
    await call(open, 'campaign', 'ambiguous');
    expect(await refused('ads')).toMatchObject({ details: { reasons: ['campaign_running', 'call_open'] } });
    await asStaff((c) => c.query("UPDATE crove_ads.ad_launch SET state = 'failed', finished_at = now() WHERE org_id = $1 AND id = $2", [orgId, open]));
    expect(await refused('ads')).toBeNull();
    await setApp('ads', true);
  });
});
