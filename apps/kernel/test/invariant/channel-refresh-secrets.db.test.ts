// SPDX-License-Identifier: AGPL-3.0-only
// Security properties of channel refresh failure tracking and backoff (#4251) on PostgreSQL 17:
// - refresher failure codes and unexpected errors never leak tokens, secrets, or raw platform text into logs,
//   channel_connection rows, audit rows, outbox events, idempotency records, or kernel.channel.list;
// - the database CHECK constraint rejects raw platform text, whitespace, URLs, JSON, or long strings in refresh_last_error;
// - kernel.channel.refresh_fail is system-only (403 for API/user actors) and cross-org isolated (404 CHANNEL_NOT_FOUND).
// Part of the invariant suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md).
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Refresher } from '@ludy/channel';
import { createDb, type Db } from '@ludy/db';
import { migrate } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { CredentialVault, Runtime, parseVaultKey } from '@ludy/kernel-runtime';
import { refreshChannels } from '../../src/channel-refresh.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { createDbClient, createDbPool, resolveDbIdentifiers, setActiveRolePasswords, type DbIdentifiers } from './fixtures/db-identifiers.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('channel refresh failure secrets invariant (#4251)', () => {
  const dbName = `ludy_test_refresh_sec_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let dbIds: DbIdentifiers | undefined;
  let appPool: pg.Pool;
  let workerPool: pg.Pool;
  let appDb: Db;
  let workerDb: Db;
  let api: Runtime;
  let worker: Runtime;
  const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const system = { type: 'system' as const, component: 'refresh-sec-test' };

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = createDbClient({ connectionString: adminUrl }, dbIds);
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function orgWithConnection(provider: string, secret: string) {
    const owner = await upsertIdentity(appDb, { issuer: 'test', subject: randomUUID(), email: `owner-${randomUUID().slice(0, 8)}@refresh-sec.test`, name: null });
    const { orgId } = await createOrg(api, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const account = `acct-${randomUUID().slice(0, 8)}`;
    const sealed = vault.seal(secret, { orgId, provider, externalAccountId: account });
    const { connectionId } = await api.execute<{ connectionId: string }>(
      'kernel.channel.connect',
      {
        provider,
        externalAccountId: account,
        displayName: 'Test Channel',
        scopes: ['oa'],
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') },
      },
      { actor: asUser(owner), orgId },
    );
    return { orgId, owner, connectionId };
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
    dbIds = await resolveDbIdentifiers(adminUrl);
    await setActiveRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' }, dbIds);
    const url = (user: string, password: string) => {
      const u = new URL(adminUrl);
      u.username = dbIds ? dbIds.roleName(user) : user;
      u.password = password;
      return u.toString();
    };
    appPool = createDbPool({ connectionString: url('crove_app', 'test-app-pw'), max: 4 }, dbIds);
    workerPool = createDbPool({ connectionString: url('crove_worker', 'test-worker-pw'), max: 4 }, dbIds);
    appDb = createDb(appPool);
    workerDb = createDb(workerPool);
    const defs = { commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) };
    api = new Runtime(appDb, { manifests: TEST_MANIFESTS }).register(defs);
    worker = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register(defs);
  });

  afterAll(async () => {
    await appPool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('keeps tokens, secrets, and raw platform text out of logs, stored rows, audit events, and query answers', async () => {
    const accessSecret = `tok_access_${randomBytes(16).toString('hex')}`;
    const refreshSecret = `tok_refresh_${randomBytes(16).toString('hex')}`;
    const numericSecret = '987654321';
    const appSecret = `app_sec_${randomBytes(12).toString('hex')}`;
    const rawPlatformPhrase = `Bearer ${refreshSecret} {"access_token":"${accessSecret}","app_secret":"${appSecret}"}`;
    const secretPayload = JSON.stringify({ accessToken: accessSecret, refreshToken: refreshSecret, appSecret });

    const { orgId, owner, connectionId } = await orgWithConnection('zalo_oa', secretPayload);
    const { orgId: otherOrgId, owner: otherOwner, connectionId: otherConnId } = await orgWithConnection('threads', secretPayload);
    const { orgId: bareOrgId, owner: bareOwner, connectionId: bareConnId } = await orgWithConnection('x', secretPayload);
    const { orgId: numOrgId, owner: numOwner, connectionId: numConnId } = await orgWithConnection('pinterest', secretPayload);

    const logs: string[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args) => logs.push(args.map(String).join(' ')));
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...args) => logs.push(args.map(String).join(' ')));
    try {
      // 1) Refresher returns raw platform text containing secrets 3 times -> sanitized to UNKNOWN, logged once without any secret.
      const dirtyFailer: Refresher = {
        provider: 'zalo_oa',
        refresh: async () => ({ failed: rawPlatformPhrase }),
      };
      for (let i = 0; i < 3; i += 1) {
        const res = await refreshChannels({ runtime: worker, broker: vault, workerDb, refreshers: { zalo_oa: dirtyFailer } });
        expect(res.failed).toBeGreaterThanOrEqual(1);
      }

      // 2) Refresher throws an Error whose message embeds secrets -> caught and sanitized, no secret in logs or DB.
      const throwingRefresher: Refresher = {
        provider: 'threads',
        refresh: async () => {
          throw new Error(`HTTP 500 upstream rejected ${rawPlatformPhrase}`);
        },
      };
      const thrown = await refreshChannels({ runtime: worker, broker: vault, workerDb, refreshers: { threads: throwingRefresher } });
      expect(thrown.failed).toBeGreaterThanOrEqual(1);

      // 3) Provider echoes a bare alphanumeric token (e.g., X error field holding a short token) 3 times -> collapsed to UNKNOWN, never stored or logged.
      const bareTokenFailer: Refresher = {
        provider: 'x',
        refresh: async () => ({ failed: accessSecret }),
      };
      for (let i = 0; i < 3; i += 1) {
        const res = await refreshChannels({ runtime: worker, broker: vault, workerDb, refreshers: { x: bareTokenFailer } });
        expect(res.failed).toBeGreaterThanOrEqual(1);
      }

      // 4) Provider echoes a numeric-only secret/OTP 3 times -> collapsed to UNKNOWN, never stored or logged.
      const numericFailer: Refresher = {
        provider: 'pinterest',
        refresh: async () => ({ failed: numericSecret }),
      };
      for (let i = 0; i < 3; i += 1) {
        const res = await refreshChannels({ runtime: worker, broker: vault, workerDb, refreshers: { pinterest: numericFailer } });
        expect(res.failed).toBeGreaterThanOrEqual(1);
      }

      const allLogs = logs.join('\n');
      expect(allLogs).toContain(connectionId);
      expect(allLogs).toContain(bareConnId);
      expect(allLogs).toContain(numConnId);
      expect(allLogs).toContain('code=UNKNOWN');
      expect(allLogs).toContain('code=UNEXPECTED_ERROR');
      for (const secret of [accessSecret, refreshSecret, numericSecret, appSecret, 'Bearer', 'access_token', 'upstream rejected']) {
        expect(allLogs).not.toContain(secret);
      }

      for (const o of [
        { orgId, owner, connectionId },
        { orgId: otherOrgId, owner: otherOwner, connectionId: otherConnId },
        { orgId: bareOrgId, owner: bareOwner, connectionId: bareConnId },
        { orgId: numOrgId, owner: numOwner, connectionId: numConnId },
      ]) {
        const listed = await api.query('kernel.channel.list', { includeRevoked: true }, { actor: asUser(o.owner), orgId: o.orgId });
        const serializedList = JSON.stringify(listed);
        for (const secret of [accessSecret, refreshSecret, numericSecret, appSecret, 'Bearer', 'upstream rejected']) {
          expect(serializedList).not.toContain(secret);
        }

        const dump = await admin(async (c) => {
          const parts: string[] = [];
          for (const q of [
            'SELECT detail::text AS t FROM crove_kernel.audit_event WHERE org_id = $1',
            'SELECT payload::text AS t FROM crove_kernel.outbox_event WHERE org_id = $1',
            "SELECT coalesce(response::text, '') AS t FROM crove_kernel.idempotency_key WHERE org_id = $1",
            'SELECT row_to_json(c)::text AS t FROM crove_kernel.channel_connection c WHERE org_id = $1',
          ]) {
            const { rows } = await c.query<{ t: string }>(q, [o.orgId]);
            parts.push(...rows.map((r) => r.t));
          }
          return parts.join('\n');
        });
        expect(dump.length).toBeGreaterThan(0);
        for (const secret of [accessSecret, refreshSecret, numericSecret, appSecret, 'Bearer', 'upstream rejected']) {
          expect(dump).not.toContain(secret);
        }
      }
    } finally {
      warnSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it('enforces sanitized refresh_last_error in SQL, system-only access, and cross-org isolation', async () => {
    const a = await orgWithConnection('zalo_oa', JSON.stringify({ accessToken: 'a-1', refreshToken: 'r-1' }));
    const b = await orgWithConnection('zalo_oa', JSON.stringify({ accessToken: 'b-1', refreshToken: 'r-2' }));

    // API / user runtime cannot call kernel.channel.refresh_fail.
    await expect(
      api.execute(
        'kernel.channel.refresh_fail',
        { connectionId: a.connectionId, ifVersion: new Date().toISOString(), code: '503' },
        { actor: asUser(a.owner), orgId: a.orgId },
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      api.execute(
        'kernel.channel.refresh_fail',
        { connectionId: a.connectionId, ifVersion: new Date().toISOString(), code: '503' },
        { actor: system, orgId: a.orgId },
      ),
    ).rejects.toMatchObject({ status: 403 });

    // Cross-org call fails closed with CHANNEL_NOT_FOUND.
    await expect(
      worker.execute(
        'kernel.channel.refresh_fail',
        { connectionId: a.connectionId, ifVersion: new Date().toISOString(), code: '503' },
        { actor: system, orgId: b.orgId },
      ),
    ).rejects.toMatchObject({ code: 'CHANNEL_NOT_FOUND' });

    // Command input rejects raw platform text, whitespace, un-allowlisted bare strings/tokens, numeric secrets, and overly long values.
    for (const badCode of ['Bearer secret', 'https://x.test?a=1', '{"a":1}', 'tok_short_secret', '987654321', 'x'.repeat(65), '']) {
      await expect(
        worker.execute(
          'kernel.channel.refresh_fail',
          { connectionId: a.connectionId, ifVersion: new Date().toISOString(), code: badCode },
          { actor: system, orgId: a.orgId },
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
    }

    // DB CHECK constraint also rejects raw platform text / whitespace / overly long values on direct SQL.
    for (const badCode of ['Bearer secret', 'https://x.test?a=1', '{"a":1}', 'x'.repeat(65), '']) {
      await expect(
        admin((c) => c.query('UPDATE crove_kernel.channel_connection SET refresh_last_error = $1 WHERE id = $2', [badCode, a.connectionId])),
      ).rejects.toThrow(/channel_connection_refresh_last_error_check/);
    }
  });
});
