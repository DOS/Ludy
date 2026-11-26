// SPDX-License-Identifier: AGPL-3.0-only
// Security and isolation invariants for Telegram bot webhooks, cross-org bot displacement, shared inbound backlog fairness,
// non-admin chatBusiness redaction, and definer/machinery isolation (#5028, #4998, #3150, #3191).
// Self-contained under apps/kernel/test/invariant/ (fixtures from ./fixtures only):
//   - crove_kernel.telegram_webhook_lock has RLS enabled and zero direct role privileges; Telegram worker/intake definers pin search_path and EXECUTE grants;
//   - cross-org bot takeover cleanly displaces the prior org off with BOT_TAKEN_OVER, notifies only owners/admins with zero cross-org leak,
//     honors takenAt ordering, skips deleteWebhook during concurrent disable when live URL belongs to another org, and restricts null chat_bot_id displacement to chat_state='on';
//   - cross-column chat_hook / chat_hook_next uniqueness trigger refuses duplicate hooks (23505), intake fails closed on ambiguous hooks, and per-org backlog shares cap at 1,000;
//   - kernel.channel.list redacts chatBusiness for members/viewers, business messages require owner/admin approval (never allow+dismiss), and chat_business_order enforces object+8KiB CHECK.
// Part of the invariant suite: set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a PostgreSQL 17 superuser URL.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TELEGRAM_HOOK_KEY_INFO,
  TelegramConversations,
  TelegramPublisher,
  telegramHookSecret,
  wrapTelegramChatNotice,
  type Fetch,
} from '@ludy/channel';
import { createDb, type Db } from '@ludy/db';
import { migrate } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { CredentialVault, Runtime, parseVaultKey, sha256Hex, type BlobStore } from '@ludy/kernel-runtime';
import { createAuthenticator } from '../../src/auth.ts';
import { loadConfig } from '../../src/config.ts';
import { runConversationIntake, runTelegramChatHook } from '../../src/conversations-worker.ts';
import { createHttpApp } from '../../src/http.ts';
import { createSessionStatusSource } from '../../src/sessions.ts';
import {
  auditRoleFunctionExecute,
  auditRoleTablePrivileges,
  createDbClient,
  createDbPool,
  resolveDbIdentifiers,
  setActiveRolePasswords,
  type DbIdentifiers,
} from './fixtures/db-identifiers.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const SYSTEM = { type: 'system' as const, component: 'telegram-inbox-invariant' };
const JWT_SECRET = 'invariant-jwt-secret-telegram-0123456789-abcdef';
const APP_URL = 'https://ludy.example.com';
const BASE = '/api/channels/telegram/webhook';
const SEARCH_PATH = 'search_path=pg_catalog, pg_temp';

class MemoryStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array) {
    this.blobs.set(key, bytes);
    return `content:${sha256Hex(bytes)}`;
  }
  async get(key: string) {
    const found = this.blobs.get(key);
    if (!found) throw new Error('missing blob');
    return found;
  }
  async delete(key: string) {
    this.blobs.delete(key);
  }
}

interface BotOrg {
  orgId: string;
  ownerId: string;
  connectionId: string;
  token: string;
}

const canonical = (role: string): string => role.replace(/^(crove|ludy)_/, 'crove_');

suite('Telegram inbox, cross-org displacement, hook uniqueness, and redaction invariants (#5028)', () => {
  const dbName = `crove_test_tg_inv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let dbIds: DbIdentifiers;
  const pools: pg.Pool[] = [];
  let appDb: Db;
  let workerDb: Db;
  let api: Runtime;
  let worker: Runtime;
  let app: ReturnType<typeof createHttpApp>;
  const vaultKey = parseVaultKey(randomBytes(32).toString('base64'));
  const vault = new CredentialVault([vaultKey]);
  const liveUrls = new Map<string, string>();
  let updateId = 10_000;

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const, sessionId: randomUUID() });
  const derived = () => vault.deriveKeys(TELEGRAM_HOOK_KEY_INFO).map((k) => k.key);
  const secretOf = (hook: string) => telegramHookSecret(derived()[0] as Buffer, hook);
  const signed = (hook: string) => ({ 'x-telegram-bot-api-secret-token': secretOf(hook) });
  const post = (hook: string, body: string) =>
    app.request(`${BASE}/${hook}`, { method: 'POST', headers: { 'content-type': 'application/json', ...signed(hook) }, body });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = createDbClient({ connectionString: adminUrl }, dbIds);
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const rows = <T extends pg.QueryResultRow>(text: string, params: unknown[] = []) =>
    admin(async (c) => (await c.query<T>(text, params)).rows);

  function telegram() {
    const calls: Array<{ method: string; token: string; json: Record<string, unknown> }> = [];
    const fetchImpl: Fetch = async (input, init) => {
      const [, tokenPart, method] = new URL(input).pathname.split('/') as [string, string, string];
      const token = tokenPart.replace(/^bot/, '');
      const json = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      calls.push({ method, token, json });
      if (method === 'setWebhook') liveUrls.set(token, String(json.url ?? ''));
      if (method === 'deleteWebhook') liveUrls.delete(token);
      const result = method === 'sendMessage' ? { message_id: 9001 } : method === 'getWebhookInfo' ? { url: liveUrls.get(token) ?? '' } : true;
      return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    return { calls, fetchImpl };
  }

  async function connectBot(name: string, token: string, channel: string): Promise<BotOrg> {
    const ownerId = (await upsertIdentity(appDb, {
      issuer: 'test',
      subject: randomUUID(),
      email: `owner-${randomUUID().slice(0, 8)}@tg-inv.test`,
      name: null,
    })) as string;
    const { orgId } = await createOrg(api, asUser(ownerId), name);
    const sealed = vault.seal(JSON.stringify({ botToken: token, username: null }), {
      orgId,
      provider: 'telegram',
      externalAccountId: channel,
    });
    const { connectionId } = await api.execute<{ connectionId: string }>(
      'kernel.channel.connect',
      {
        provider: 'telegram',
        externalAccountId: channel,
        displayName: name,
        scopes: [],
        expiresAt: null,
        credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') },
      },
      { actor: asUser(ownerId), orgId },
    );
    return { orgId, ownerId, connectionId, token };
  }

  async function turnOn(o: BotOrg): Promise<string> {
    await api.execute('kernel.channel.telegram_chat_set', { connectionId: o.connectionId, on: true }, { actor: asUser(o.ownerId), orgId: o.orgId });
    const t = telegram();
    const adapter = new TelegramPublisher(undefined, new TelegramConversations({ fetch: t.fetchImpl })).conversations;
    expect(
      await runTelegramChatHook(
        { runtime: worker, broker: vault, adapter: (p) => (p === 'telegram' ? adapter : undefined), baseUrl: APP_URL, workerDb },
        { orgId: o.orgId, connectionId: o.connectionId, action: 'chat', on: true },
      ),
    ).toBe('on');
    const [row] = await rows<{ chat_hook: string }>(
      'SELECT chat_hook FROM crove_kernel.channel_connection WHERE org_id = $1 AND id = $2',
      [o.orgId, o.connectionId],
    );
    return row?.chat_hook as string;
  }

  const update = (text: string, chat: number, messageId: number) =>
    JSON.stringify({
      update_id: updateId++,
      message: {
        message_id: messageId,
        from: { id: chat, is_bot: false, first_name: 'Khách' },
        chat: { id: chat, first_name: 'Khách', type: 'private' },
        date: Math.floor(Date.now() / 1000) - 60,
        text,
      },
    });

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

    const login = (user: string, password: string) => {
      const u = new URL(adminUrl);
      u.username = dbIds.roleName(user);
      u.password = password;
      return u.toString();
    };
    const appUrl = login('crove_app', 'test-app-pw');
    const appPool = createDbPool({ connectionString: appUrl, max: 4 }, dbIds);
    pools.push(appPool);
    appDb = createDb(appPool);
    const workerPool = createDbPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 2 }, dbIds);
    pools.push(workerPool);
    workerDb = createDb(workerPool);

    const defs = { commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: null })] };
    api = new Runtime(appDb, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' }).register(defs);
    worker = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register(defs);
    const config = loadConfig({
      DATABASE_URL: appUrl,
      AUTH_JWT_SECRET: JWT_SECRET,
      AUTH_ISSUER: 'ludy-auth',
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    app = createHttpApp({
      config,
      runtime: api,
      store: new MemoryStore(),
      authenticate: createAuthenticator(config, appDb),
      pool: appPool,
      aiEnabled: false,
      telegramWebhook: { keys: derived },
    });
  }, 120_000);

  afterAll(async () => {
    for (const p of pools) await p.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('locks telegram_webhook_lock and pins SECURITY DEFINER, search_path, and EXECUTE grants on Telegram helpers', async () => {
    await admin(async (c) => {
      const lockRls = await c.query<{ rls: boolean }>(
        `SELECT relrowsecurity AS rls FROM pg_catalog.pg_class WHERE oid = pg_catalog.to_regclass($1)`,
        [dbIds.table('crove_kernel.telegram_webhook_lock')],
      );
      expect(lockRls.rows).toEqual([{ rls: true }]);

      const tableAcl = await c.query<{ grantee: string; privilege_type: string }>(
        `SELECT COALESCE(r.rolname, 'PUBLIC') AS grantee, a.privilege_type
           FROM pg_catalog.pg_class c
           CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) a
           LEFT JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
          WHERE c.oid = pg_catalog.to_regclass($1)
            AND a.grantee <> c.relowner
          ORDER BY 1, 2`,
        [dbIds.table('crove_kernel.telegram_webhook_lock')],
      );
      expect(tableAcl.rows).toEqual([]);

      const tablePrivs = await auditRoleTablePrivileges(
        c,
        dbIds,
        'crove_kernel.telegram_webhook_lock',
        ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'],
        'non_system',
      );
      expect(tablePrivs.length).toBeGreaterThan(0);
      expect(tablePrivs.filter((r) => r.ok)).toEqual([]);

      const colAcl = await c.query<{ attname: string; grantee: string; privilege_type: string }>(
        `SELECT a.attname, COALESCE(r.rolname, 'PUBLIC') AS grantee, acl.privilege_type
           FROM pg_catalog.pg_class c
           JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
           CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) acl
           LEFT JOIN pg_catalog.pg_roles r ON r.oid = acl.grantee
          WHERE c.oid = pg_catalog.to_regclass($1)
            AND a.attnum > 0
            AND NOT a.attisdropped
            AND a.attacl IS NOT NULL
            AND acl.grantee <> c.relowner
          ORDER BY 1, 2, 3`,
        [dbIds.table('crove_kernel.telegram_webhook_lock')],
      );
      expect(colAcl.rows).toEqual([]);

      const colPrivs = await c.query<{ rolname: string; privilege: string }>(
        `SELECT r.rolname, p AS privilege
           FROM pg_catalog.pg_roles r
           CROSS JOIN pg_catalog.unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) AS p
          WHERE r.rolname !~ '^pg_'
            AND NOT r.rolsuper
            AND pg_catalog.has_any_column_privilege(r.oid, $1::regclass, p)
          ORDER BY 1, 2`,
        [dbIds.table('crove_kernel.telegram_webhook_lock')],
      );
      expect(colPrivs.rows).toEqual([]);

      const publicPrivs = await c.query<{ privilege: string }>(
        `SELECT p AS privilege
           FROM pg_catalog.unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) AS p
          WHERE pg_catalog.has_table_privilege('public', $1::regclass, p)
             OR (p IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES') AND pg_catalog.has_any_column_privilege('public', $1::regclass, p))
          ORDER BY 1`,
        [dbIds.table('crove_kernel.telegram_webhook_lock')],
      );
      expect(publicPrivs.rows).toEqual([]);

      const expectedGrants: Array<[string, readonly string[]]> = [
        ['crove_kernel.conversation_chat_hook_connections(text)', ['crove_worker']],
        ['crove_kernel.telegram_chat_hook_rekey_due(text,integer,timestamptz,uuid,uuid)', ['crove_worker']],
        ['crove_kernel.telegram_chat_displace_due(integer)', ['crove_worker']],
        ['crove_kernel.telegram_webhook_lock_acquire(text,uuid,integer)', ['crove_worker']],
        ['crove_kernel.telegram_webhook_lock_release(text,uuid)', ['crove_worker']],
        ['crove_kernel.telegram_chat_hook_rekey_counts()', ['crove_worker']],
        ['crove_kernel.telegram_chat_other_orgs_with_bot(text,uuid)', ['crove_worker']],
        ['crove_kernel.telegram_chat_other_org_holds_bot(text,uuid)', ['crove_worker']],
        ['crove_kernel.telegram_inbound_enqueue(text,bytea)', ['crove_app']],
        ['crove_kernel.channel_connection_chat_hook_unique()', []],
      ];

      for (const [signature, allowed] of expectedGrants) {
        const proc = await c.query<{ secdef: boolean; config: string[] | null }>(
          `SELECT p.prosecdef AS secdef, p.proconfig AS config FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure($1::text)::oid`,
          [dbIds.rewriteSql(signature)],
        );
        expect(proc.rows, `${signature} exists`).toHaveLength(1);
        expect(proc.rows[0]?.secdef).toBe(true);
        expect(proc.rows[0]?.config ?? []).toContain(SEARCH_PATH);

        const acl = await c.query<{ grantee: string }>(
          `SELECT COALESCE(r.rolname, 'PUBLIC') AS grantee
             FROM pg_catalog.pg_proc p
             CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
             LEFT JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
            WHERE p.oid = pg_catalog.to_regprocedure($1::text)::oid
              AND a.privilege_type = 'EXECUTE'
              AND a.grantee <> p.proowner
            ORDER BY 1`,
          [dbIds.rewriteSql(signature)],
        );
        expect(acl.rows.map((r) => canonical(r.grantee))).toEqual([...allowed]);

        const audit = await auditRoleFunctionExecute(c, dbIds, signature, allowed, 'non_system');
        expect(audit.rows.filter((r) => r.ok !== r.expected), signature).toEqual([]);
      }
    });
  });

  it('enforces cross-org bot displacement without oracle leaks, honors takenAt/disable/null-botId guards, and retires displaced hooks', async () => {
    const sharedToken = '811111111:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw8';
    const first = await connectBot('Công ty Thứ Nhất', sharedToken, '-1008111111111');
    const second = await connectBot('Công ty Thứ Hai', sharedToken, '-1008111111112');
    const admin1 = (await upsertIdentity(appDb, {
      issuer: 'test',
      subject: randomUUID(),
      email: `admin1-${randomUUID().slice(0, 8)}@tg-inv.test`,
      name: null,
    })) as string;
    const member1 = (await upsertIdentity(appDb, {
      issuer: 'test',
      subject: randomUUID(),
      email: `member1-${randomUUID().slice(0, 8)}@tg-inv.test`,
      name: null,
    })) as string;
    await rows("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')", [
      first.orgId,
      admin1,
      member1,
    ]);

    const firstHook = await turnOn(first);
    const secondHook = await turnOn(second);

    // Second org carries zero cross-org details in audit events.
    const secondAudit = JSON.stringify(await rows('SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1', [second.orgId]));
    expect(secondAudit).not.toContain(first.orgId);
    expect(secondAudit).not.toContain(first.connectionId);

    // First org is cleanly off with BOT_TAKEN_OVER and owners/admins notified once (never members).
    expect(
      (
        await rows(
          'SELECT chat_state, chat_hook, chat_hook_next, chat_bot_id, chat_hook_key_id, chat_displace_pending, chat_error FROM crove_kernel.channel_connection WHERE org_id = $1 AND id = $2',
          [first.orgId, first.connectionId],
        )
      )[0],
    ).toEqual({
      chat_state: 'off',
      chat_hook: null,
      chat_hook_next: null,
      chat_bot_id: null,
      chat_hook_key_id: null,
      chat_displace_pending: false,
      chat_error: 'BOT_TAKEN_OVER',
    });

    const notifs = await rows<{ user_id: string; subject_id: string; detail: unknown }>(
      "SELECT user_id, subject_id, detail FROM crove_kernel.notification WHERE org_id = $1 AND kind = 'kernel.telegram_chat_displaced' ORDER BY user_id",
      [first.orgId],
    );
    expect(notifs.map((n) => n.user_id).sort()).toEqual([first.ownerId, admin1].sort());
    expect(notifs.every((n) => n.subject_id === first.connectionId)).toBe(true);
    expect(JSON.stringify(notifs)).not.toContain(second.orgId);
    expect(JSON.stringify(notifs)).not.toContain(second.connectionId);
    expect(JSON.stringify(notifs)).not.toContain(sharedToken);

    // Retired hook drops parked notices without creating any thread.
    expect((await post(firstHook, update('Tin tới hook bị chiếm', 4101, 1))).status).toBe(200);
    expect(await runConversationIntake({ workerDb, runtime: worker })).toEqual({ stored: 0, dropped: 0 });
    expect(await rows('SELECT 1 FROM crove_kernel.conversation WHERE org_id = $1', [first.orgId])).toHaveLength(0);

    // Stale takenAt guard keeps newer holder active.
    const staleRes = await worker.execute<{ displaced: boolean }>(
      'kernel.channel.telegram_chat_displaced',
      { connectionId: second.connectionId, botId: '811111111', takenAt: new Date(Date.now() - 120_000).toISOString() },
      { actor: SYSTEM, orgId: second.orgId },
    );
    expect(staleRes.displaced).toBe(false);
    expect((await rows<{ chat_state: string }>('SELECT chat_state FROM crove_kernel.channel_connection WHERE org_id = $1 AND id = $2', [second.orgId, second.connectionId]))[0]?.chat_state).toBe('on');

    // Null chat_bot_id displacement guard (#5028): refuses 'enabling'/'disabling', allows legacy 'on'.
    await rows("UPDATE crove_kernel.channel_connection SET chat_state = 'enabling', chat_hook_next = $3, chat_bot_id = NULL WHERE org_id = $1 AND id = $2", [
      second.orgId,
      second.connectionId,
      randomBytes(32).toString('base64url'),
    ]);
    expect(
      (
        await worker.execute<{ displaced: boolean }>(
          'kernel.channel.telegram_chat_displaced',
          { connectionId: second.connectionId, botId: '811111111' },
          { actor: SYSTEM, orgId: second.orgId },
        )
      ).displaced,
    ).toBe(false);
    await rows("UPDATE crove_kernel.channel_connection SET chat_state = 'disabling', chat_hook_next = NULL, chat_bot_id = NULL WHERE org_id = $1 AND id = $2", [
      second.orgId,
      second.connectionId,
    ]);
    expect(
      (
        await worker.execute<{ displaced: boolean }>(
          'kernel.channel.telegram_chat_displaced',
          { connectionId: second.connectionId, botId: '811111111' },
          { actor: SYSTEM, orgId: second.orgId },
        )
      ).displaced,
    ).toBe(false);
    await rows("UPDATE crove_kernel.channel_connection SET chat_state = 'on', chat_hook_next = NULL, chat_bot_id = NULL WHERE org_id = $1 AND id = $2", [
      second.orgId,
      second.connectionId,
    ]);
    expect(
      (
        await worker.execute<{ displaced: boolean }>(
          'kernel.channel.telegram_chat_displaced',
          { connectionId: second.connectionId, botId: '811111111' },
          { actor: SYSTEM, orgId: second.orgId },
        )
      ).displaced,
    ).toBe(true);

    // Concurrent disable skips deleteWebhook when another org already holds live URL on Telegram.
    const nextFirstHook = await turnOn(first);
    expect(liveUrls.get(sharedToken)).toBe(`${APP_URL}${BASE}/${nextFirstHook}`);
    await rows("UPDATE crove_kernel.channel_connection SET chat_state = 'on', chat_hook = $3, chat_hook_next = NULL, chat_bot_id = '811111111', chat_error = NULL WHERE org_id = $1 AND id = $2", [
      second.orgId,
      second.connectionId,
      secondHook,
    ]);
    await api.execute('kernel.channel.telegram_chat_set', { connectionId: second.connectionId, on: false }, { actor: asUser(second.ownerId), orgId: second.orgId });
    const tDisable = telegram();
    const disableAdapter = new TelegramPublisher(undefined, new TelegramConversations({ fetch: tDisable.fetchImpl })).conversations;
    expect(
      await runTelegramChatHook(
        { runtime: worker, broker: vault, adapter: (p) => (p === 'telegram' ? disableAdapter : undefined), baseUrl: APP_URL, workerDb },
        { orgId: second.orgId, connectionId: second.connectionId, action: 'chat', on: false },
      ),
    ).toBe('off');
    expect(tDisable.calls.map((c) => c.method)).toEqual(['getWebhookInfo']);
    expect(liveUrls.get(sharedToken)).toBe(`${APP_URL}${BASE}/${nextFirstHook}`);
  });

  it('enforces cross-column webhook uniqueness, fail-closed intake, and per-org 1,000 backlog share', async () => {
    const o1 = await connectBot('Công ty Hook 1', '822222221:BBHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1', '-1008222222221');
    const o2 = await connectBot('Công ty Hook 2', '822222222:BBHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw2', '-1008222222222');
    const h1 = await turnOn(o1);
    await turnOn(o2);

    // Cross-column uniqueness trigger blocks collision between chat_hook and chat_hook_next across orgs.
    await expect(
      rows("UPDATE crove_kernel.channel_connection SET chat_hook_next = $1, chat_state = 'enabling' WHERE org_id = $2 AND id = $3", [
        h1,
        o2.orgId,
        o2.connectionId,
      ]),
    ).rejects.toMatchObject({ code: '23505' });

    // Intake fails closed on ambiguous hook match without writing into either org.
    await rows('ALTER TABLE crove_kernel.channel_connection DISABLE TRIGGER channel_connection_chat_hook_unique');
    try {
      await rows("UPDATE crove_kernel.channel_connection SET chat_hook_next = $1, chat_state = 'enabling' WHERE org_id = $2 AND id = $3", [
        h1,
        o2.orgId,
        o2.connectionId,
      ]);
      const notice = wrapTelegramChatNotice(h1, Buffer.from(update('Trùng hook bất biến', 4201, 1), 'utf8'));
      await rows('INSERT INTO crove_kernel.conversation_inbound_pending (provider, body) VALUES ($1, $2)', ['telegram_chat', notice]);
      const logs: string[] = [];
      expect(await runConversationIntake({ workerDb, runtime: worker, log: (m) => logs.push(m) })).toEqual({ stored: 0, dropped: 1 });
      expect(logs.some((m) => m.includes('refused ambiguous hook match'))).toBe(true);
      expect(await rows('SELECT 1 FROM crove_kernel.conversation WHERE org_id = ANY($1::uuid[])', [[o1.orgId, o2.orgId]])).toHaveLength(0);
    } finally {
      await rows("UPDATE crove_kernel.channel_connection SET chat_hook_next = NULL, chat_state = 'on' WHERE org_id = $1 AND id = $2", [
        o2.orgId,
        o2.connectionId,
      ]);
      await rows('ALTER TABLE crove_kernel.channel_connection ENABLE TRIGGER channel_connection_chat_hook_unique');
      await rows('DELETE FROM crove_kernel.conversation_inbound_pending');
    }

    // Per-org backlog fairness: 1,000 cap per org using SHA-256 hashed bucket_key while peer org still passes.
    const h2 = (await rows<{ chat_hook: string }>('SELECT chat_hook FROM crove_kernel.channel_connection WHERE org_id = $1 AND id = $2', [o2.orgId, o2.connectionId]))[0]?.chat_hook as string;
    await rows(
      "INSERT INTO crove_kernel.conversation_inbound_pending (provider, bucket_key, body) SELECT 'telegram_chat', pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to($1, 'UTF8')), 'hex'), 'x'::bytea FROM generate_series(1, 999)",
      [o1.orgId],
    );
    expect((await post(h1, update('Tin 1000', 4301, 1))).status).toBe(200);
    const over = await post(h1, update('Tin 1001', 4301, 2));
    expect([over.status, await over.text()]).toEqual([503, '{"code":"BACKLOG"}']);
    expect((await post(h2, update('Tin org 2', 4302, 1))).status).toBe(200);
    const buckets = await rows<{ bucket_key: string }>('SELECT DISTINCT bucket_key FROM crove_kernel.conversation_inbound_pending WHERE bucket_key IS NOT NULL');
    expect(buckets).toHaveLength(2);
    expect(buckets.every((b) => /^[0-9a-f]{64}$/.test(b.bucket_key) && b.bucket_key !== o1.orgId && b.bucket_key !== o2.orgId)).toBe(true);
    await rows('DELETE FROM crove_kernel.conversation_inbound_pending');
  });

  it('redacts chatBusiness from non-admins, isolates unapproved business messages, and enforces chat_business_order CHECK', async () => {
    const bizToken = '833333333:CCHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw3';
    const bizConnId = 'InvBiz-123_conn=';
    const bizUserId = 99887766;
    const org = await connectBot('Công ty Business Invariant', bizToken, '-1008333333333');
    const hook = await turnOn(org);

    const adminId = (await upsertIdentity(appDb, { issuer: 'test', subject: randomUUID(), email: `adm-${randomUUID().slice(0, 8)}@tg-inv.test`, name: null })) as string;
    const memberId = (await upsertIdentity(appDb, { issuer: 'test', subject: randomUUID(), email: `mem-${randomUUID().slice(0, 8)}@tg-inv.test`, name: null })) as string;
    const viewerId = (await upsertIdentity(appDb, { issuer: 'test', subject: randomUUID(), email: `viw-${randomUUID().slice(0, 8)}@tg-inv.test`, name: null })) as string;
    await rows("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')", [
      org.orgId,
      adminId,
      memberId,
      viewerId,
    ]);

    const bcUpdate = JSON.stringify({
      update_id: updateId++,
      business_connection: {
        id: bizConnId,
        user: { id: bizUserId, first_name: 'Lan', last_name: 'Trần', username: 'lan_invariant' },
        user_chat_id: bizUserId,
        date: Math.floor(Date.now() / 1000),
        rights: { can_reply: true },
        is_enabled: true,
      },
    });
    expect((await post(hook, bcUpdate)).status).toBe(200);
    await runConversationIntake({ workerDb, runtime: worker });

    // Unapproved business account messages never enter conversation tables.
    const bizMessage = JSON.stringify({
      update_id: updateId++,
      business_message: {
        message_id: 1,
        business_connection_id: bizConnId,
        from: { id: 5501, is_bot: false, first_name: 'Khách' },
        chat: { id: 5501, first_name: 'Khách', type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: 'Tin chưa duyệt',
      },
    });
    expect((await post(hook, bizMessage)).status).toBe(200);
    expect(await runConversationIntake({ workerDb, runtime: worker })).toEqual({ stored: 0, dropped: 0 });
    expect(await rows('SELECT 1 FROM crove_kernel.conversation WHERE org_id = $1', [org.orgId])).toHaveLength(0);

    // Owner and admin see masked ref/username only; member and viewer receive empty chatBusiness and zero username/id strings.
    let businessRef = '';
    for (const actorId of [org.ownerId, adminId]) {
      const list = await api.query<Array<{ id: string; chatBusiness: Array<{ ref: string; username: string | null }> }>>(
        'kernel.channel.list',
        {},
        { actor: asUser(actorId), orgId: org.orgId },
      );
      const entry = list.find((c) => c.id === org.connectionId);
      expect(entry?.chatBusiness).toEqual([
        { ref: expect.stringMatching(/^[0-9a-f]{12}$/), name: 'Lan Trần', username: 'lan_invariant', enabled: true, canReply: true, approved: false },
      ]);
      expect(JSON.stringify(list)).not.toContain(bizConnId);
      expect(JSON.stringify(list)).not.toContain(String(bizUserId));
      businessRef = entry?.chatBusiness[0]?.ref as string;
    }

    for (const nonAdminId of [memberId, viewerId]) {
      const list = await api.query<Array<{ id: string; chatBusiness: unknown[] }>>(
        'kernel.channel.list',
        {},
        { actor: asUser(nonAdminId), orgId: org.orgId },
      );
      expect(list.find((c) => c.id === org.connectionId)?.chatBusiness).toEqual([]);
      const raw = JSON.stringify(list);
      expect(raw).not.toContain('lan_invariant');
      expect(raw).not.toContain(bizConnId);
      expect(raw).not.toContain(String(bizUserId));
      await expect(
        api.execute('kernel.channel.telegram_business_allow', { connectionId: org.connectionId, ref: businessRef, allow: true }, { actor: asUser(nonAdminId), orgId: org.orgId }),
      ).rejects.toMatchObject({ status: 403 });
    }

    // Mutually exclusive allow and dismiss flags rejected cleanly; chat_business_order CHECK enforced at DB boundary.
    await expect(
      api.execute('kernel.channel.telegram_business_allow', { connectionId: org.connectionId, ref: businessRef, allow: true, dismiss: true }, { actor: asUser(org.ownerId), orgId: org.orgId }),
    ).rejects.toMatchObject({ status: 422 });
    const checkRows = await rows<{ convalidated: boolean }>(
      "SELECT convalidated FROM pg_catalog.pg_constraint WHERE conrelid = 'crove_kernel.channel_connection'::regclass AND conname = 'channel_connection_chat_business_order_check'",
    );
    expect(checkRows).toEqual([{ convalidated: true }]);
    await expect(
      rows("UPDATE crove_kernel.channel_connection SET chat_business_order = '[]'::jsonb WHERE org_id = $1 AND id = $2", [org.orgId, org.connectionId]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      rows('UPDATE crove_kernel.channel_connection SET chat_business_order = $1::jsonb WHERE org_id = $2 AND id = $3', [
        JSON.stringify({ overflow: 'x'.repeat(9000) }),
        org.orgId,
        org.connectionId,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
