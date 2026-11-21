// SPDX-License-Identifier: AGPL-3.0-only
// The HTTP edge and the stream trigger of the per-org app switch (ADR-0053, slice c C2b), on PostgreSQL 17: switching an app off sends the org_apps hint on the
// stream channel, the Meetings upload purposes answer as a purpose that is not installed (404) while Meetings is off, and the extension is offered no Meetings
// feature or scope. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { ORG_HEADER } from '@ludy/kernel-contract';
import { createOrg, upsertIdentity } from '@ludy/kernel';
import { Runtime, type BlobStore } from '@ludy/kernel-runtime';
import type { AuthUser } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { moduleDefinitions } from '../src/kernel.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('the HTTP edge and the stream of the per-org app switch (ADR-0053, C2b)', () => {
  const dbName = `crove_test_appedge_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let owner = '';
  let orgId = '';
  let slug = '';
  let current: AuthUser;
  let http: ReturnType<typeof createHttpApp>;
  const asUser = () => ({ type: 'user' as const, userId: owner, aal: 'aal1' as const });
  const setApp = (module: string, enabled: boolean) => rt.execute('kernel.org.set_app', { module, enabled }, { actor: asUser(), orgId, idempotencyKey: randomUUID() });

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
    const config = loadConfig({
      DATABASE_URL: app.toString(),
      AUTH_JWT_SECRET: 'test-only-jwt-secret-for-app-edge-0123456789',
      AUTH_ISSUER: 'crove-auth',
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
      PUBLIC_URL: 'http://localhost:8080/',
    });
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register(moduleDefinitions(config));
    owner = await upsertIdentity(db, { issuer: 'test', subject: `appedge-${randomUUID()}`, email: 'appedge-owner@example.com', name: null });
    ({ orgId, slug } = await createOrg(rt, asUser(), 'Org App Edge'));
    current = { userId: owner, email: 'appedge-owner@example.com', name: null, aal: 'aal1', sessionId: '', mfaAt: null };
    http = createHttpApp({ config, runtime: rt, store: {} as BlobStore, authenticate: async () => current, pool, aiEnabled: false });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('sends the org_apps hint on the stream channel when an app is switched off or on, and for nothing else of the tenant row', async () => {
    const listener = new pg.Client({ connectionString: adminUrl });
    await listener.connect();
    const heard: string[] = [];
    listener.on('notification', (n) => {
      if (n.channel === 'crove_stream' && n.payload?.includes(' org_apps ')) heard.push(n.payload);
    });
    await listener.query('LISTEN crove_stream');
    try {
      await setApp('social', false);
      await setApp('social', true);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(heard).toEqual([`${orgId} org_apps ${orgId}`, `${orgId} org_apps ${orgId}`]);
      // A write to another column of the tenant row sends none.
      const admin = new pg.Client({ connectionString: adminUrl });
      await admin.connect();
      await admin.query("UPDATE crove_kernel.tenant SET name = name || '' WHERE org_id = $1", [orgId]);
      await admin.end();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(heard).toHaveLength(2);
    } finally {
      await listener.end();
    }
  });

  it('answers a Meetings upload purpose as not installed (404) while Meetings is off, and as before once it is on', async () => {
    const post = (purpose: string) =>
      http.request('/api/files', { method: 'POST', headers: { authorization: 'Bearer t', [ORG_HEADER]: slug }, body: (() => { const f = new FormData(); f.set('purpose', purpose); return f; })() });
    // On: the purpose is known, so this route refuses it for another reason (the media goes through the staged upload).
    const on = await post('meeting_audio');
    expect((await on.json()) as { code?: string }).toMatchObject({ code: 'STAGED_UPLOAD_REQUIRED' });
    await setApp('meetings', false);
    const off = await post('meeting_audio');
    expect(off.status).toBe(404);
    expect(await off.json()).toMatchObject({ code: 'NOT_FOUND' });
    expect((await post('meeting_video')).status).toBe(404);
    // The other purposes are the kernel's own and stay.
    expect((await post('document')).status).not.toBe(404);
    await setApp('meetings', true);
    expect(((await (await post('meeting_audio')).json()) as { code?: string }).code).toBe('STAGED_UPLOAD_REQUIRED');
  });

  it('offers the extension no Meetings or Notes feature while that module is off', async () => {
    const extension = { tokenId: randomUUID(), orgId, userId: owner, scopes: ['meetings', 'agenda', 'notes'] as const, expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
    current = { ...current, extension: { ...extension, scopes: [...extension.scopes] } };
    const me = async () => ((await (await http.request('/api/extension/me', { headers: { authorization: 'Bearer t' } })).json()) as { features: { meetings: boolean; agenda: boolean; notes: boolean } }).features;
    try {
      expect(await me()).toEqual({ meetings: true, agenda: true, notes: true });
      await setApp('meetings', false);
      expect(await me()).toEqual({ meetings: false, agenda: false, notes: true });
      await setApp('notes', false);
      expect(await me()).toEqual({ meetings: false, agenda: false, notes: false });
      await setApp('meetings', true);
      await setApp('notes', true);
      expect(await me()).toEqual({ meetings: true, agenda: true, notes: true });
    } finally {
      const { extension: _gone, ...rest } = current;
      current = rest;
    }
  });
});
