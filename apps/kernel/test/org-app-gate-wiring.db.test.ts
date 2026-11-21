// SPDX-License-Identifier: AGPL-3.0-only
// The wiring of the per-org app gate in the server (ADR-0053 section 3, slice b step 2): createKernel hands the runtime the billing port's
// entitlements, always, so a Cloud billing port that holds an org to some apps keeps it out of the others through the real HTTP edge, and
// the self-host default (`full`) holds every app. A runtime built without the option would hold every app for every org, so this is the test
// that a wiring mistake cannot quietly grant them. Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { createServer, type AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { ORG_HEADER } from '@ludy/kernel-contract';
import { createOrg, upsertIdentity } from '@ludy/kernel';
import { Runtime, sha256Hex, type BlobStore } from '@ludy/kernel-runtime';
import type { AuthUser } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createKernel, defaultAdapters, moduleDefinitions, type Billing, type IdentityPort } from '../src/kernel.ts';
import { startExtractService } from './extract-service.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SESSION = '5b2e1d7a-3c4f-4a9b-8d60-7e1f2a3b4c5d';

class MemoryStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array) {
    this.blobs.set(key, bytes);
    return `content:${sha256Hex(bytes)}`;
  }
  async get(key: string) {
    const b = this.blobs.get(key);
    if (!b) throw new Error('missing blob');
    return b;
  }
  async delete(key: string) {
    this.blobs.delete(key);
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const suite = ADMIN ? describe : describe.skip;

suite('the per-org app gate through createKernel (ADR-0053)', () => {
  const dbName = `crove_test_gatewire_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let stopExtract: (() => Promise<void>) | undefined;
  let extractUrl = '';
  let owner = '';
  let slug = '';

  const configFor = (port: number) =>
    loadConfig({
      DATABASE_URL: appUrl,
      WORKER_DATABASE_URL: workerUrl,
      EXTRACT_URL: extractUrl,
      AUTH_JWT_SECRET: 'test-only-jwt-secret-for-app-gate-wiring',
      AUTH_ISSUER: 'test-auth',
      WEB_DIST: '/nonexistent',
      HOST: '127.0.0.1',
      PORT: String(port),
    });

  // Boots the API with the given billing port (none: the self-host default), asks for the screens of two apps, and stops.
  async function bootAndAsk(billing: Billing | undefined): Promise<{ finance: { status: number; code?: string }; crm: { status: number; code?: string }; kernel: number }> {
    const port = await freePort();
    const config = configFor(port);
    const identity: IdentityPort = {
      sessions: { mode: 'off', liveCheckForR3: false, check: async () => {} },
      revoker: null,
      authenticator: () => async () => ({ userId: owner, email: 'gatewire-owner@example.com', name: null, aal: 'aal1', sessionId: SESSION, mfaAt: null }) satisfies AuthUser,
    };
    const kernel = createKernel(config, { ...defaultAdapters(config), identity, ai: null, storage: new MemoryStore(), ...(billing ? { billing } : {}) });
    const stop = await kernel.start('api');
    try {
      const origin = `http://127.0.0.1:${port}`;
      const rpc = async (path: string) => {
        const res = await fetch(`${origin}/api/rpc/${path}`, {
          method: 'POST',
          headers: { authorization: 'Bearer fake-token', [ORG_HEADER]: slug, 'content-type': 'application/json' },
          body: JSON.stringify({ json: {} }),
        });
        const body = (await res.json().catch(() => ({}))) as { code?: string; json?: { code?: string } };
        return { status: res.status, ...(body.code ?? body.json?.code ? { code: (body.code ?? body.json?.code) as string } : {}) };
      };
      return { finance: await rpc('accounts/list'), crm: await rpc('crm/pipeline/stages'), kernel: (await rpc('org/get')).status };
    } finally {
      await stop();
    }
  }

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const url = new URL(ADMIN as string);
    url.pathname = `/${dbName}`;
    adminUrl = url.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const loginUrl = (username: string, password: string) => {
      const u = new URL(adminUrl);
      u.username = username;
      u.password = password;
      return u.toString();
    };
    appUrl = loginUrl('crove_app', 'test-app-pw');
    workerUrl = loginUrl('crove_worker', 'test-worker-pw');
    const service = await startExtractService();
    stopExtract = service.stop;
    extractUrl = service.url;
    pool = createPool({ connectionString: appUrl, max: 2 });
    db = createDb(pool);
    const registered = new Runtime(db, { manifests: TEST_MANIFESTS }).register(moduleDefinitions(configFor(8080)));
    owner = await upsertIdentity(db, { issuer: 'test', subject: `gatewire-${randomUUID()}`, email: 'gatewire-owner@example.com', name: null });
    ({ slug } = await createOrg(registered, { type: 'user', userId: owner, aal: 'aal1' }, 'Org Gate Wiring'));
  }, 120_000);

  afterAll(async () => {
    await stopExtract?.();
    await pool?.end();
    if (!ADMIN) return;
    const admin = new pg.Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  it('holds every app with the self-host billing port, and only the held ones with a port that holds some', { timeout: 120_000 }, async () => {
    // Self-host default (no port given): every app answers.
    const selfHost = await bootAndAsk(undefined);
    expect(selfHost.finance.status).toBe(200);
    expect(selfHost.crm.status).toBe(200);
    expect(selfHost.kernel).toBe(200);
    // A port that holds the org to finance alone: CRM answers MODULE_OFF 404 at the edge, finance and kernel still answer.
    const financeOnly = await bootAndAsk({ entitlements: async () => ['finance'] });
    expect(financeOnly.finance.status).toBe(200);
    expect(financeOnly.crm).toEqual({ status: 404, code: 'MODULE_OFF' });
    expect(financeOnly.kernel).toBe(200);
    // A port that holds the org to nothing: both apps are off, kernel is not.
    const nothing = await bootAndAsk({ entitlements: async () => [] });
    expect(nothing.finance).toEqual({ status: 404, code: 'MODULE_OFF' });
    expect(nothing.crm).toEqual({ status: 404, code: 'MODULE_OFF' });
    expect(nothing.kernel).toBe(200);
  });
});
