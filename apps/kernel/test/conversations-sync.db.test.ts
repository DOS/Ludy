// SPDX-License-Identifier: AGPL-3.0-only
// What the worker reads beyond the webhook (CV5b, #2329) on PostgreSQL 17: a customer's name asked once, an account's recent history stored
// once through the same ingest with a gap recorded when it could not reach back, the due list for the worker login alone, and a read
// that cannot bring back an erased customer. A fake adapter stands in for Zalo. Set CROVE_TEST_ADMIN_URL to a superuser URL.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConversationAdapter, ConversationHistoryResult, ConversationProfileResult, InboundConversationEvent } from '@crove/channel';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { ConversationDetail } from '@crove/kernel-contract';
import { CredentialVault, parseVaultKey, Runtime } from '@crove/kernel-runtime';
import { dueConversationSync, requestConversationSync, runConversationSync, type ConversationSyncJob } from '../src/conversations-worker.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('conversation sync (name and history) on PostgreSQL (CV5b, #2329)', () => {
  const dbName = `crove_test_conversations_sync_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let rt: Runtime;
  let worker: Runtime;
  let workerDb: Db;
  let db: Db;
  let vault: CredentialVault;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const, sessionId: randomUUID() });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });
  const SYSTEM = { type: 'system' as const, component: 'conversations' };
  const MIN = 60_000;

  const rows = async <T extends pg.QueryResultRow>(text: string, params: unknown[] = []) => {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return (await c.query<T>(text, params)).rows;
    } finally {
      await c.end();
    }
  };

  type Org = { orgId: string; owner: string; connectionId: string; accountId: string };
  async function org(): Promise<Org> {
    const owner = (await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `o-${randomUUID().slice(0, 8)}@sync.test`, name: null })) as string;
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const accountId = `oa-${randomUUID().slice(0, 8)}`;
    const sealed = vault.seal(JSON.stringify({ accessToken: 'a', refreshToken: 'r' }), { orgId, provider: 'zalo_oa', externalAccountId: accountId });
    const { connectionId } = await rt.execute<{ connectionId: string }>(
      'kernel.channel.connect',
      { provider: 'zalo_oa', externalAccountId: accountId, displayName: 'OA thử', scopes: [], expiresAt: null, credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') } },
      { actor: asUser(owner), orgId },
    );
    return { orgId, owner, connectionId, accountId };
  }
  const ev = (customer: string, id: string, text: string, at: Date, direction: 'in' | 'out' = 'in', name?: string): InboundConversationEvent => ({
    kind: 'direct',
    threadId: customer,
    messageId: id,
    direction,
    contact: name ? { id: customer, name } : { id: customer },
    text,
    at: at.toISOString(),
  });
  const ingest = (o: Org, events: InboundConversationEvent[]) => worker.execute('kernel.conversation.ingest', { connectionId: o.connectionId, events }, { actor: SYSTEM, orgId: o.orgId });
  const adapter = (impl: Partial<ConversationAdapter>) => ({
    runtime: worker,
    broker: vault,
    adapter: (provider: string) => (provider === 'zalo_oa' ? ({ provider: 'zalo_oa', reply: async () => ({ kind: 'unknown' as const }), ...impl } as ConversationAdapter) : undefined),
  });
  const threadOf = async (o: Org, customer: string) => (await rows<{ id: string }>('SELECT id FROM crove_kernel.conversation WHERE org_id = $1 AND external_thread_id = $2', [o.orgId, customer]))[0]?.id as string;
  const detail = (o: Org, id: string) => rt.query<ConversationDetail>('kernel.conversation.get', { conversationId: id }, { actor: asUser(o.owner), orgId: o.orgId });
  const due = async (o: Org, history = true) => (await dueConversationSync(workerDb, { history: history ? ['zalo_oa'] : [], profile: ['zalo_oa'] })).filter((j) => j.orgId === o.orgId);
  const profileJobs = async (o: Org) => (await due(o, false)).filter((j) => j.action === 'profile');
  const historyJobs = async (o: Org) => (await due(o)).filter((j) => j.action === 'history');

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
    const w = new URL(adminUrl);
    w.username = 'crove_worker';
    w.password = 'test-worker-pw';
    workerPool = createPool({ connectionString: w.toString(), max: 2 });
    workerDb = createDb(workerPool);
    vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
    const registered = { commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: null })] };
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register(registered);
    worker = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register(registered);
  });

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it("asks for a customer's name once, keeps the one it has, and asks again only after a failure worth retrying", async () => {
    const o = await org();
    await ingest(o, [ev('u-1', 'm-1', 'Xin chào', new Date())]);
    const [job] = await profileJobs(o);
    expect(job).toMatchObject({ action: 'profile', connectionId: o.connectionId });
    const asked: string[] = [];
    const named = (displayName: string | null): Partial<ConversationAdapter> => ({
      profile: async (input) => {
        asked.push(input.contactId);
        return { kind: 'ok', displayName } satisfies ConversationProfileResult;
      },
    });
    // A failure worth retrying leaves the customer to be asked again; a final refusal marks it checked.
    const flaky: Partial<ConversationAdapter> = { profile: async () => ({ kind: 'failed', retry: true, code: 'ZALO_RATE_LIMIT' }) };
    expect(await runConversationSync(adapter(flaky), job as ConversationSyncJob)).toBe('retry');
    expect(await profileJobs(o)).toHaveLength(1);
    expect(await runConversationSync(adapter(named('Trần Thị Khách')), job as ConversationSyncJob)).toBe('named');
    expect(asked).toEqual(['u-1']);
    const id = await threadOf(o, 'u-1');
    expect((await detail(o, id)).conversation.contact.displayName).toBe('Trần Thị Khách');
    expect(await profileJobs(o)).toHaveLength(0);
    // The name is kept: a second answer changes nothing, and nobody is asked again.
    expect(await runConversationSync(adapter(named('Tên khác')), job as ConversationSyncJob)).toBe('none');
    expect((await detail(o, id)).conversation.contact.displayName).toBe('Trần Thị Khách');
    // No name from the platform, and a refusal that will not change: both are final.
    await ingest(o, [ev('u-2', 'm-2', 'Alo', new Date()), ev('u-3', 'm-3', 'Alo', new Date())]);
    const jobs = await profileJobs(o);
    expect(jobs).toHaveLength(2);
    expect(await runConversationSync(adapter(named(null)), jobs[0] as ConversationSyncJob)).toBe('no_name');
    expect(await runConversationSync(adapter({ profile: async () => ({ kind: 'failed', retry: false, code: 'ZALO_OA_ACCESS' }) }), jobs[1] as ConversationSyncJob)).toBe('failed');
    expect(await profileJobs(o)).toHaveLength(0);
    // Nothing of a name reaches an audit row.
    const audit = JSON.stringify(await rows("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.conversation.profile_apply'", [o.orgId]));
    expect(audit).not.toContain('Trần Thị Khách');
  });

  it('does not ask for the name of an erased customer', async () => {
    const o = await org();
    await ingest(o, [ev('u-9', 'm-9', 'Xin chào', new Date())]);
    const [job] = await profileJobs(o);
    await rt.execute('kernel.conversation.erase_contact', { conversationId: await threadOf(o, 'u-9'), confirm: true }, { actor: asMfa(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() });
    expect(await profileJobs(o)).toHaveLength(0);
    let asked = false;
    const spy: Partial<ConversationAdapter> = {
      profile: async () => {
        asked = true;
        return { kind: 'ok', displayName: 'X' };
      },
    };
    expect(await runConversationSync(adapter(spy), job as ConversationSyncJob)).toBe('none');
    expect(asked).toBe(false);
  });

  it('reads the history of a new account once, stores it in order without doubling, and marks the account read', async () => {
    const o = await org();
    const now = Date.now();
    const events = [ev('u-5', 'h-2', 'Trả lời của shop', new Date(now - 4 * MIN), 'out'), ev('u-5', 'h-1', 'Shop còn hàng không?', new Date(now - 5 * MIN))];
    let sinceSeen = '';
    const full = (list: InboundConversationEvent[]): Partial<ConversationAdapter> => ({
      history: async (input) => {
        sinceSeen = input.since.toISOString();
        return { kind: 'ok', events: list, complete: true, oldest: list.at(-1)?.at ?? null } satisfies ConversationHistoryResult;
      },
    });
    // A new connection is due at once; the flag keeps the history off where the deployment has not turned it on.
    expect((await due(o, false)).filter((j) => j.action === 'history')).toHaveLength(0);
    const [job] = await historyJobs(o);
    expect(job).toMatchObject({ action: 'history', connectionId: o.connectionId });
    expect(await runConversationSync(adapter(full(events)), job as ConversationSyncJob)).toBe('complete');
    const id = await threadOf(o, 'u-5');
    expect((await detail(o, id)).messages.map((m) => [m.seq, m.direction, m.body])).toEqual([
      [1, 'in', 'Shop còn hàng không?'],
      [2, 'out', 'Trả lời của shop'],
    ]);
    // The read reaches back to where the connection began, never past the seven-day window.
    expect(Date.parse(sinceSeen)).toBeGreaterThan(now - 7 * 86_400_000 - MIN);
    // Read; not due again for an hour; the same answer again changes nothing.
    expect(await historyJobs(o)).toHaveLength(0);
    expect(await runConversationSync(adapter(full(events)), job as ConversationSyncJob)).toBe('complete');
    expect((await detail(o, id)).messages).toHaveLength(2);
    expect((await detail(o, id)).gap).toBeNull();
    // After an hour it is due again; a reconnect makes it due at once.
    await rows("UPDATE crove_kernel.channel_connection SET history_synced_at = now() - interval '61 minutes' WHERE org_id = $1", [o.orgId]);
    expect(await historyJobs(o)).toHaveLength(1);
    await rows('UPDATE crove_kernel.channel_connection SET history_synced_at = now() WHERE org_id = $1', [o.orgId]);
    expect(await historyJobs(o)).toHaveLength(0);
    const sealed = vault.seal(JSON.stringify({ accessToken: 'b', refreshToken: 'r2' }), { orgId: o.orgId, provider: 'zalo_oa', externalAccountId: o.accountId });
    await rt.execute(
      'kernel.channel.connect',
      { provider: 'zalo_oa', externalAccountId: o.accountId, displayName: 'OA thử', scopes: [], expiresAt: null, credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') } },
      { actor: asUser(o.owner), orgId: o.orgId },
    );
    expect(await historyJobs(o)).toHaveLength(1);
  });

  it('records a gap when the history could not be read back far enough, shows it on the threads that were alive after it, and clears it once a read is whole', async () => {
    const o = await org();
    const now = Date.now();
    await ingest(o, [ev('u-old', 'o-1', 'Tin rất cũ', new Date(now - 6 * 86_400_000))]);
    await ingest(o, [ev('u-new', 'n-1', 'Tin gần đây', new Date(now - 2 * 3_600_000))]);
    // The account has been connected for three days: the read goes back to then.
    await rows("UPDATE crove_kernel.channel_connection SET connected_at = now() - interval '3 days' WHERE org_id = $1", [o.orgId]);
    const [job] = await historyJobs(o);
    const partial: Partial<ConversationAdapter> = {
      history: async () => ({ kind: 'ok', events: [ev('u-new', 'n-2', 'Tin bù', new Date(now - MIN))], complete: false, oldest: new Date(now - MIN).toISOString() }),
    };
    expect(await runConversationSync(adapter(partial), job as ConversationSyncJob)).toBe('gap');
    const fresh = await detail(o, await threadOf(o, 'u-new'));
    expect(fresh.gap).toMatchObject({ from: expect.any(String), to: new Date(now - MIN).toISOString() });
    // A thread whose last message came before the gap began shows no gap.
    expect((await detail(o, await threadOf(o, 'u-old'))).gap).toBeNull();
    // A whole read clears it.
    const whole: Partial<ConversationAdapter> = { history: async () => ({ kind: 'ok', events: [], complete: true, oldest: null }) };
    expect(await runConversationSync(adapter(whole), job as ConversationSyncJob)).toBe('complete');
    expect((await detail(o, await threadOf(o, 'u-new'))).gap).toBeNull();
  });

  it('leaves the account due after a refused read, retries one worth retrying, and never lets history bring back an erased customer', async () => {
    const o = await org();
    const now = Date.now();
    const [job] = await historyJobs(o);
    expect(await runConversationSync(adapter({ history: async () => ({ kind: 'failed', retry: false, code: 'ZALO_TOKEN' }) }), job as ConversationSyncJob)).toBe('failed');
    expect(await historyJobs(o)).toHaveLength(1);
    await expect(runConversationSync(adapter({ history: async () => ({ kind: 'failed', retry: true, code: 'ZALO_RATE_LIMIT' }) }), job as ConversationSyncJob)).rejects.toThrow('history read failed');
    // An erased customer's earlier message, returned by the platform's history, is refused by the tombstone.
    await ingest(o, [ev('u-gone', 'g-1', 'Số điện thoại 0912345678', new Date(now - 10 * MIN))]);
    await rt.execute('kernel.conversation.erase_contact', { conversationId: await threadOf(o, 'u-gone'), confirm: true }, { actor: asMfa(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() });
    const replay: Partial<ConversationAdapter> = {
      history: async () => ({
        kind: 'ok',
        events: [ev('u-gone', 'g-1', 'Số điện thoại 0912345678', new Date(now - 10 * MIN)), ev('u-ok', 'k-1', 'Khách khác', new Date(now - 9 * MIN))],
        complete: true,
        oldest: null,
      }),
    };
    expect(await runConversationSync(adapter(replay), job as ConversationSyncJob)).toBe('complete');
    expect(await rows("SELECT 1 FROM crove_kernel.conversation WHERE org_id = $1 AND external_thread_id = 'u-gone'", [o.orgId])).toHaveLength(0);
    expect(await rows("SELECT 1 FROM crove_kernel.conversation WHERE org_id = $1 AND external_thread_id = 'u-ok'", [o.orgId])).toHaveLength(1);
  });

  it('hands each due read to the worker once through a command that emits its event, so the relay does not hand it out every pass', async () => {
    const o = await org();
    await ingest(o, [ev('u-r', 'r-1', 'Xin chào', new Date())]);
    const jobs = await due(o);
    expect(jobs.map((j) => j.action).sort()).toEqual(['history', 'profile']);
    expect(await requestConversationSync(worker, jobs)).toBe(2);
    expect(await due(o)).toHaveLength(0);
    expect(await rows("SELECT 1 FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.conversation.sync_request' AND outcome = 'ok'", [o.orgId])).toHaveLength(2);
    // The event the worker's queue takes: ids only.
    const events = await rows<{ payload: Record<string, unknown> }>("SELECT payload FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'kernel.conversation.sync_queued'", [o.orgId]);
    expect(events).toHaveLength(2);
    for (const e of events) expect(Object.keys(e.payload).sort().every((k) => ['action', 'connectionId', 'identityId'].includes(k))).toBe(true);
    // A request for a connection that is no longer active queues nothing.
    await rt.execute('kernel.channel.disconnect', { connectionId: o.connectionId }, { actor: asUser(o.owner), orgId: o.orgId });
    expect(await requestConversationSync(worker, jobs)).toBe(0);
  });

  it('lists the work for the worker login alone, only for the providers asked, and only for active connections', async () => {
    await expect(pool.query("SELECT * FROM crove_kernel.conversation_sync_due(ARRAY['zalo_oa'], ARRAY['zalo_oa'], 60, 10)")).rejects.toMatchObject({ code: '42501' });
    const o = await org();
    expect((await dueConversationSync(workerDb, { history: ['facebook_page'], profile: [] })).filter((j) => j.orgId === o.orgId)).toHaveLength(0);
    expect(await dueConversationSync(workerDb, { history: [], profile: [] })).toEqual([]);
    await rt.execute('kernel.channel.disconnect', { connectionId: o.connectionId }, { actor: asUser(o.owner), orgId: o.orgId });
    expect(await historyJobs(o)).toHaveLength(0);
  });
});
