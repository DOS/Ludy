// SPDX-License-Identifier: AGPL-3.0-only
// The migration that moves browser push to the kernel (#3736) on PostgreSQL 17: a subscription a member made through Social before it ran is in the kernel's table afterwards with the same id,
// endpoint, keys and dates and the old table is left in place (the contract step drops it later). Set CROVE_TEST_ADMIN_URL to a superuser URL; the run makes its
// own database and its own migrations folder (every file but the one under test first, then that one).
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { Runtime } from '@ludy/kernel-runtime';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const SOURCE = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const MIGRATION = readdirSync(SOURCE).find((f) => f.endsWith('_ludy_kernel_push_subscription.sql')) as string;
const suite = ADMIN ? describe : describe.skip;

suite('push subscription migration (#3736)', () => {
  const dbName = `crove_test_push_move_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const dir = mkdtempSync(join(tmpdir(), 'push-move-'));
  let adminUrl = '';

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    mkdirSync(dir, { recursive: true });
    for (const f of readdirSync(SOURCE)) if (f.endsWith('.sql') && f !== MIGRATION) copyFileSync(join(SOURCE, f), join(dir, f));
  });

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('copies Social subscriptions into the kernel table and keeps the old table', async () => {
    await migrate({ adminUrl, dir });
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw' });
      const app = new URL(adminUrl);
      app.username = 'ludy_app';
      app.password = 'test-app-pw';
      const pool = createPool({ connectionString: app.toString(), max: 2 });
      const db = createDb(pool);
      const rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: null })] });
      const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@push.test`, name: null });
      const owner = await person('owner');
      const gone = await person('member');
      const { orgId } = await createOrg(rt, { type: 'user', userId: owner, aal: 'aal1' }, 'Push move');
      await pool.end();
      await c.query("INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [orgId, gone]);
      const key = Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString('base64url');
      const auth = randomBytes(16).toString('base64url');
      const id = randomUUID();
      await c.query(
        "INSERT INTO ludy_social.push_subscription (org_id, id, user_id, endpoint, p256dh, auth, user_agent, failure_count, created_at, last_used_at) VALUES ($1, $2, $3, 'https://push.example.com/old-1', $4, $5, 'Chrome', 2, '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z')",
        [orgId, id, owner, key, auth],
      );
      await c.query("INSERT INTO ludy_social.push_subscription (org_id, user_id, endpoint, p256dh, auth) VALUES ($1, $2, 'https://push.example.com/old-2', $3, $4)", [orgId, gone, key, auth]);
      copyFileSync(join(SOURCE, MIGRATION), join(dir, MIGRATION));
      await migrate({ adminUrl, dir });
      const moved = await c.query('SELECT id, user_id, endpoint, p256dh, auth, user_agent, failure_count, created_at, last_used_at FROM ludy_kernel.push_subscription WHERE org_id = $1 ORDER BY endpoint', [orgId]);
      expect(moved.rows).toHaveLength(2);
      expect(moved.rows[0]).toMatchObject({ id, user_id: owner, endpoint: 'https://push.example.com/old-1', p256dh: key, auth, user_agent: 'Chrome', failure_count: 2 });
      expect(moved.rows[0].created_at.toISOString()).toBe('2026-10-01T00:00:00.000Z');
      expect(moved.rows[0].last_used_at.toISOString()).toBe('2026-10-02T00:00:00.000Z');
      // The old table stays, unread, for the contract step.
      expect((await c.query('SELECT 1 FROM ludy_social.push_subscription WHERE org_id = $1', [orgId])).rowCount).toBe(2);
      // Applied again, nothing doubles.
      expect((await c.query("SELECT count(*)::int AS n FROM ludy_kernel.push_subscription WHERE org_id = $1", [orgId])).rows[0].n).toBe(2);
      // The queue exists and the purge names the new table.
      expect((await c.query("SELECT 1 FROM ludy_jobs.queue WHERE name = 'kernel-push'")).rowCount).toBe(1);
      expect((await c.query("SELECT pg_get_functiondef('ludy_kernel.org_purge(integer)'::regprocedure) AS def")).rows[0].def).toContain('ludy_kernel.push_subscription');
    } finally {
      await c.end();
    }
  });
});
