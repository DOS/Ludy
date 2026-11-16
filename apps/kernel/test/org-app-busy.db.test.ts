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

  it('keeps Meetings on while the extension is recording, until the recording ends', async () => {
    expect(await refused('meetings')).toBeNull();
    await setApp('meetings', true);
    const meetingId = randomUUID();
    await admin((c) =>
      c.query(
        `INSERT INTO crove_meetings.meeting (org_id, id, recorder_user_id, title, consent_method, consent_confirmed_by, audio_retention_date, text_retention_date, extension_token_id, started_at)
         VALUES ($1, $2, $3, 'Họp đang ghi', 'told_at_start', $3, current_date + 30, current_date + 365, $4, now())`,
        [orgId, meetingId, owner, randomUUID()],
      ),
    );
    expect(await refused('meetings')).toMatchObject({ code: 'APP_BUSY', details: { module: 'meetings', reasons: ['recording'] } });
    await admin((c) => c.query('UPDATE crove_meetings.meeting SET ended_at = now() WHERE org_id = $1 AND id = $2', [orgId, meetingId]));
    expect(await refused('meetings')).toBeNull();
    await setApp('meetings', true);
  });

  it('keeps Ads on while an activation was begun at the platform and not settled, until it is', async () => {
    const callId = randomUUID();
    const insert = (key: string) =>
      admin((c) =>
        c.query(
          `INSERT INTO crove_kernel.external_call (org_id, id, key, module, target, step, retry_safety, state) VALUES ($1, $2, $3, 'ads', 'meta', 'activate_a', 'idempotent', 'started')`,
          [orgId, callId, key],
        ),
      );
    await insert(`ads.launch:${randomUUID()}:1:activate_a`);
    expect(await refused('ads')).toMatchObject({ code: 'APP_BUSY', details: { module: 'ads', reasons: ['activation_open'] } });
    await admin((c) => c.query("UPDATE crove_kernel.external_call SET state = 'succeeded', finished_at = now() WHERE org_id = $1 AND id = $2", [orgId, callId]));
    expect(await refused('ads')).toBeNull();
    await setApp('ads', true);
  });
});
