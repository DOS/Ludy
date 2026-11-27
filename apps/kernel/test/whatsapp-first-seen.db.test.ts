// SPDX-License-Identifier: AGPL-3.0-only
// Durable cross-process first-seen tracking of WhatsApp webhook events on PostgreSQL 17 (issue #5085, follow-up of #5047): a Meta retry that reaches another API
// process (an empty replay cache) or follows a restart, inside WHATSAPP_CLOCK_SKEW_MS and across a number handover, is parked with the event's first arrival
// time, never a later one, so it cannot be taken by the new holder of the number; the table keeps only hashed keys, the API login cannot read it, the worker
// login purges it after 8 days (7 days of event age plus the clock skew), and a refused backlog keeps the keys. Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run makes
// its own database.
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { CredentialVault, Runtime, parseVaultKey } from '@ludy/kernel-runtime';
import { purgeInboundFirstSeen, runConversationIntake } from '../src/conversations-worker.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { WhatsAppReplayCache, acceptWhatsAppWebhook, durableEventKey } from '../src/whatsapp-webhook.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const APP_SECRET = 'whatsapp-app-secret-not-real-first-seen-01';
const ACCESS_TOKEN = `EAAG${'f'.repeat(48)}`;
const WABA = '206000000000077';

const signed = (body: string) => ({
  signature: `sha256=${createHmac('sha256', APP_SECRET).update(Buffer.from(body, 'utf8')).digest('hex')}`,
  body: new Uint8Array(Buffer.from(body, 'utf8')),
});

suite('WhatsApp durable first-seen tracking (#5085)', () => {
  const dbName = `ludy_test_wa_first_seen_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  const pools: pg.Pool[] = [];
  let appDb: Db;
  let workerDb: Db;
  let api: Runtime;
  let worker: Runtime;
  const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const, sessionId: randomUUID() });
  const config = { appSecret: APP_SECRET };

  async function rows<T extends pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return (await client.query<T>(text, params)).rows;
    } finally {
      await client.end();
    }
  }

  let phoneCounter = 0;
  async function connect(orgId: string, owner: string, phoneId: string): Promise<string> {
    const sealed = vault.seal(JSON.stringify({ accessToken: ACCESS_TOKEN, wabaId: WABA }), { orgId, provider: 'whatsapp', externalAccountId: phoneId });
    const connected = await api.execute<{ connectionId: string }>(
      'kernel.channel.connect',
      {
        provider: 'whatsapp',
        externalAccountId: phoneId,
        displayName: 'Cửa hàng First Seen',
        scopes: ['whatsapp_business_messaging'],
        expiresAt: null,
        credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') },
      },
      { actor: asUser(owner), orgId },
    );
    return connected.connectionId;
  }
  async function makeOrg(name: string): Promise<{ orgId: string; owner: string }> {
    const owner = (await upsertIdentity(appDb, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@wa-first-seen.test`, name: null })) as string;
    const { orgId } = await createOrg(api, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    return { orgId, owner };
  }

  function notice(phoneId: string, waId: string, wamid: string, timestamp: string): string {
    return JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: WABA,
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '84000000098', phone_number_id: phoneId },
                contacts: [{ profile: { name: 'Khách' }, wa_id: waId }],
                messages: [{ from: waId, id: wamid, timestamp, type: 'text', text: { body: 'Xin chào first-seen' } }],
              },
            },
          ],
        },
      ],
    });
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
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });
    const login = (user: string, password: string) => {
      const u = new URL(adminUrl);
      u.username = user;
      u.password = password;
      return u.toString();
    };
    appUrl = login('ludy_app', 'test-app-pw');
    workerUrl = login('ludy_worker', 'test-worker-pw');
    const appPool = createPool({ connectionString: appUrl, max: 4 });
    pools.push(appPool);
    appDb = createDb(appPool);
    const workerPool = createPool({ connectionString: workerUrl, max: 2 });
    pools.push(workerPool);
    workerDb = createDb(workerPool);
    const defs = { commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: null })] };
    api = new Runtime(appDb, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' }).register(defs);
    worker = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register(defs);
  });

  afterAll(async () => {
    for (const p of pools) await p.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('dates a retry parked by another process (empty replay cache) with the first arrival, so a handover in between never takes the notice', async () => {
    const a = await makeOrg('seen-a');
    const b = await makeOrg('seen-b');
    const phoneId = `1070000000${String(1000 + phoneCounter++)}`;
    const aConnection = await connect(a.orgId, a.owner, phoneId);
    const wamid = `wamid.first-seen-${randomUUID().slice(0, 12)}`;
    // Meta's clock runs 5 minutes ahead: inside WHATSAPP_CLOCK_SKEW_MS, so the notice is accepted while Org A holds the number.
    const body = notice(phoneId, '84000000301', wamid, String(Math.floor((Date.now() + 5 * 60_000) / 1000)));

    // Process 1 parks it.
    expect(await acceptWhatsAppWebhook(api, config, signed(body), new WhatsAppReplayCache())).toEqual({ status: 200, parked: true });

    // The number is handed over to Org B.
    await new Promise((r) => setTimeout(r, 40));
    await api.execute('kernel.channel.disconnect', { connectionId: aConnection }, { actor: asUser(a.owner), orgId: a.orgId });
    await connect(b.orgId, b.owner, phoneId);

    // Meta retries; process 2 (or a restarted process 1) has an empty cache and parks it again.
    expect(await acceptWhatsAppWebhook(api, config, signed(body), new WhatsAppReplayCache())).toEqual({ status: 200, parked: true });
    // A process that still has the key in its cache answers without parking again.
    const warm = new WhatsAppReplayCache();
    expect(await acceptWhatsAppWebhook(api, config, signed(body), warm)).toEqual({ status: 200, parked: true });
    expect(await acceptWhatsAppWebhook(api, config, signed(body), warm)).toEqual({ status: 200, parked: false });

    // Every parked copy carries the first arrival: none is dated after the handover.
    const pending = await rows<{ distinct_times: string; total: string }>(
      `SELECT count(DISTINCT received_at)::text AS distinct_times, count(*)::text AS total FROM ludy_kernel.conversation_inbound_pending WHERE provider = 'whatsapp'`,
    );
    expect(pending[0]).toEqual({ distinct_times: '1', total: '3' });

    // The worker takes none of them into Org B's inbox: received_at is before B's connected_at.
    expect(await runConversationIntake({ workerDb, runtime: worker, log: () => undefined })).toMatchObject({ stored: 0 });
    expect(await rows('SELECT 1 FROM ludy_kernel.conversation WHERE org_id = ANY($1::uuid[])', [[a.orgId, b.orgId]])).toHaveLength(0);

    // The key is a hash: no wamid, phone number id or customer id is stored.
    const keys = await rows<{ key: Buffer; first_seen_at: Date }>('SELECT key, first_seen_at FROM ludy_kernel.conversation_inbound_first_seen');
    const expected = createHash('sha256').update(`ludy.whatsapp.first_seen.v1:${phoneId}:in:m:${wamid}`).digest();
    expect(keys.map((k) => k.key.toString('hex'))).toContain(expected.toString('hex'));
    expect(durableEventKey(`${phoneId}:in:m:${wamid}`)).toBe(expected.toString('hex'));
    const table = await rows<{ dump: string }>('SELECT row_to_json(f)::text AS dump FROM ludy_kernel.conversation_inbound_first_seen f');
    expect(table.map((t) => t.dump).join('')).not.toContain(wamid);
  });

  async function asLogin<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  it('dates a parked notice the earliest first-seen of its keys, never later than now, and a refused backlog keeps the keys', async () => {
    const key = randomBytes(32).toString('hex');
    const enqueue = (provider: string, keys: string[]) =>
      asLogin(appUrl, async (c) => (await c.query<{ seq: string | null }>('SELECT ludy_kernel.conversation_inbound_enqueue_seen($1, $2, $3::text[]) AS seq', [provider, Buffer.from('{}'), keys])).rows[0]?.seq ?? null);

    // First arrival: dated now (the key's own first-seen).
    const first = await enqueue('whatsapp', [key]);
    expect(first).not.toBeNull();
    // The key's first arrival was ten minutes ago (a retry inside the 10 minute skew window): the next copy is dated then, not now.
    await rows(`UPDATE ludy_kernel.conversation_inbound_first_seen SET first_seen_at = now() - interval '10 minutes' WHERE key = decode($1, 'hex')`, [key]);
    const retry = await enqueue('whatsapp', [key, randomBytes(32).toString('hex')]);
    const times = await rows<{ seq: string; age_seconds: number }>(
      `SELECT seq::text AS seq, extract(epoch FROM now() - received_at)::float8 AS age_seconds FROM ludy_kernel.conversation_inbound_pending WHERE seq = ANY($1::bigint[])`,
      [[first, retry]],
    );
    const age = (seq: string | null) => times.find((t) => t.seq === seq)?.age_seconds ?? Number.NaN;
    expect(age(first)).toBeLessThan(60);
    expect(age(retry)).toBeGreaterThan(9 * 60);

    // A full backlog (1000 waiting notices for the sandbox provider) refuses with NULL, and the key this call recorded stays.
    await rows(`INSERT INTO ludy_kernel.conversation_inbound_pending (provider, body) SELECT 'sandbox', '\\x7b7d'::bytea FROM generate_series(1, 1000)`);
    const refusedKey = randomBytes(32).toString('hex');
    expect(await enqueue('sandbox', [refusedKey])).toBeNull();
    expect(await rows(`SELECT 1 FROM ludy_kernel.conversation_inbound_first_seen WHERE key = decode($1, 'hex')`, [refusedKey])).toHaveLength(1);
    await rows(`DELETE FROM ludy_kernel.conversation_inbound_pending WHERE provider = 'sandbox'`);
  });

  it('rejects malformed keys, keeps the table closed to both logins and the purge to the worker login', async () => {
    await asLogin(appUrl, async (c) => {
      await expect(c.query(`SELECT ludy_kernel.conversation_inbound_enqueue_seen('whatsapp', '\\x7b7d'::bytea, ARRAY['nothex']::text[])`)).rejects.toMatchObject({ code: '22023' });
      await expect(c.query(`SELECT ludy_kernel.conversation_inbound_enqueue_seen('whatsapp', '\\x7b7d'::bytea, NULL)`)).rejects.toMatchObject({ code: '22023' });
      await expect(c.query('SELECT * FROM ludy_kernel.conversation_inbound_first_seen')).rejects.toMatchObject({ code: '42501' });
      await expect(c.query('SELECT ludy_kernel.conversation_inbound_first_seen_purge(10)')).rejects.toMatchObject({ code: '42501' });
    });
    await asLogin(workerUrl, async (c) => {
      await expect(c.query('SELECT * FROM ludy_kernel.conversation_inbound_first_seen')).rejects.toMatchObject({ code: '42501' });
      await expect(c.query(`SELECT ludy_kernel.conversation_inbound_enqueue_seen('whatsapp', '\\x7b7d'::bytea, ARRAY[]::text[])`)).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('the worker purge drops keys older than 8 days (7 days plus the clock skew) and keeps the rest', async () => {
    const oldKey = randomBytes(32);
    const freshKey = randomBytes(32);
    await rows(
      `INSERT INTO ludy_kernel.conversation_inbound_first_seen (key, first_seen_at) VALUES ($1, now() - interval '9 days'), ($2, now() - interval '7 days 12 hours')`,
      [oldKey, freshKey],
    );
    expect(await purgeInboundFirstSeen({ workerDb, force: true })).toBeGreaterThanOrEqual(1);
    const left = await rows<{ key: Buffer }>('SELECT key FROM ludy_kernel.conversation_inbound_first_seen WHERE key = ANY($1::bytea[])', [[oldKey, freshKey]]);
    expect(left.map((r) => r.key.toString('hex'))).toEqual([freshKey.toString('hex')]);
  });
});
