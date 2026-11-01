// SPDX-License-Identifier: AGPL-3.0-only
// The conversation core's worker side on PostgreSQL 17 (#2303): a notice the webhook parked is stored under the org of its
// connection and deleted at once (an unreadable one too, a poison one after five claims), a reply is sent once with the
// credential the API sealed, a worker killed after the platform's answer never sends it twice, a refused token expires the
// connection, and a hide is repeated safely. The sandbox platform stands in for a real one. Set CROVE_TEST_ADMIN_URL to a
// superuser URL; each run makes its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SandboxPublisher, sandboxNoticeBody, type ConversationAdapter } from '@crove/channel';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { ConversationDetail, ConversationEvent } from '@crove/kernel-contract';
import { CredentialVault, parseVaultKey, Runtime } from '@crove/kernel-runtime';
import { failUnsendable, runConversationIntake, runConversationJob, sweepStaleReplies } from '../src/conversations-worker.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('conversations, the worker side, on PostgreSQL (#2303)', () => {
  const dbName = `crove_test_conversations_worker_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let workerDb: Db;
  let rt: Runtime;
  let worker: Runtime;
  let vault: CredentialVault;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const rows = <T extends pg.QueryResultRow>(text: string, params: unknown[] = []) => admin(async (c) => (await c.query<T>(text, params)).rows);
  // Parks a body as the API's login does.
  async function park(body: Buffer, provider = 'sandbox'): Promise<void> {
    const client = new pg.Client({ connectionString: appUrl });
    await client.connect();
    try {
      await client.query('SELECT crove_kernel.conversation_inbound_enqueue($1, $2)', [provider, body]);
    } finally {
      await client.end();
    }
  }
  const waiting = async () => (await rows('SELECT 1 FROM crove_kernel.conversation_inbound_pending')).length;
  const intake = () => runConversationIntake({ workerDb, runtime: worker, log: () => {} });

  type Org = { orgId: string; owner: string; lan: string; connectionId: string; accountId: string };
  async function org(sharedAccount?: string): Promise<Org> {
    const owner = (await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `owner-${randomUUID().slice(0, 8)}@cw.test`, name: null })) as string;
    const lan = (await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `lan-${randomUUID().slice(0, 8)}@cw.test`, name: null })) as string;
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [orgId, lan]));
    // The owner connects a sandbox channel through the command, the secret sealed as the API seals it.
    const accountId = sharedAccount ?? `sandbox-${randomUUID().slice(0, 8)}`;
    const sealed = vault.seal(JSON.stringify({ accessToken: `sbx_${randomBytes(24).toString('base64url')}` }), { orgId, provider: 'sandbox', externalAccountId: accountId });
    const { connectionId } = await rt.execute<{ connectionId: string }>(
      'kernel.channel.connect',
      { provider: 'sandbox', externalAccountId: accountId, displayName: 'Kênh thử', scopes: [], expiresAt: null, credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') } },
      { actor: asUser(owner), orgId },
    );
    return { orgId, owner, lan, connectionId, accountId };
  }

  const event = (threadId: string, text: string, extra: Partial<ConversationEvent> = {}): ConversationEvent => ({
    kind: 'comment_thread',
    threadId,
    postId: 'post-1',
    messageId: `m-${randomUUID().slice(0, 8)}`,
    direction: 'in',
    contact: { id: 'u-5', name: 'Khách' },
    text,
    at: new Date().toISOString(),
    ...extra,
  });
  const detail = (o: Org, id: string) => rt.query<ConversationDetail>('kernel.conversation.get', { conversationId: id }, { actor: asUser(o.owner), orgId: o.orgId });
  const threadOf = async (o: Org, threadId: string) => (await rows<{ id: string }>('SELECT id FROM crove_kernel.conversation WHERE org_id = $1 AND external_thread_id = $2', [o.orgId, threadId]))[0]?.id as string;
  const jobDeps = (adapter: ConversationAdapter) => ({ runtime: worker, broker: vault, adapter: (provider: string) => (provider === 'sandbox' ? adapter : undefined) });

  // A thread with one comment and a queued reply.
  async function queuedReply(o: Org, text = 'Dạ có ạ'): Promise<{ id: string; messageId: string }> {
    await park(sandboxNoticeBody({ accountId: o.accountId, events: [event('c-1', 'Còn hàng không?')] }));
    await intake();
    const id = await threadOf(o, 'c-1');
    const { messageId } = await rt.execute<{ messageId: string }>('kernel.conversation.reply', { conversationId: id, body: text, lastSeenSeq: 1 }, { actor: asUser(o.lan), orgId: o.orgId });
    return { id, messageId };
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
    appUrl = app.toString();
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

  it('fails a queued reply visibly when this worker has no channel to send it through, so a person can send it again', async () => {
    const o = await org();
    const { id, messageId } = await queuedReply(o);
    await failUnsendable(worker, { orgId: o.orgId, messageId, connectionId: o.connectionId, action: 'reply' });
    const [row] = await rows<{ send_state: string; send_error_code: string | null }>('SELECT send_state, send_error_code FROM crove_kernel.conversation_message WHERE org_id = $1 AND id = $2', [o.orgId, messageId]);
    expect(row).toEqual({ send_state: 'failed', send_error_code: 'CHANNEL_NOT_CONFIGURED' });
    // A person may send it again (a new attempt), which a message left queued could never be.
    await expect(rt.execute('kernel.conversation.reply_settle', { messageId, action: 'retry' }, { actor: asUser(o.lan), orgId: o.orgId })).resolves.toMatchObject({ state: 'queued' });
    expect((await detail(o, id)).conversation.id).toBe(id);
  });

  it('stores a parked notice under the org of its connection and deletes it at once', async () => {
    const o = await org();
    const other = await org();
    await park(sandboxNoticeBody({ accountId: o.accountId, events: [event('c-1', 'Xin chào'), event('c-2', 'Giá?', { contact: { id: 'u-6', name: 'Khác' } })] }));
    expect(await waiting()).toBe(1);
    expect(await intake()).toEqual({ stored: 2, dropped: 0 });
    expect(await waiting()).toBe(0);
    expect(await rows('SELECT 1 FROM crove_kernel.conversation WHERE org_id = $1', [o.orgId])).toHaveLength(2);
    // The notice named no org and no other org's connection: nothing of it landed there.
    expect(await rows('SELECT 1 FROM crove_kernel.conversation WHERE org_id = $1', [other.orgId])).toHaveLength(0);
    // An account no connection holds: parked, claimed, found nowhere, deleted.
    await park(sandboxNoticeBody({ accountId: 'sandbox-nobody', events: [event('c-9', 'Ai đó')] }));
    expect(await intake()).toEqual({ stored: 0, dropped: 0 });
    expect(await waiting()).toBe(0);
    // Not a notice at all: dropped with nothing kept, and the rest of the queue goes on.
    await park(Buffer.from('not json'));
    await park(sandboxNoticeBody({ accountId: o.accountId, events: [event('c-3', 'Sau đó')] }));
    expect(await intake()).toEqual({ stored: 1, dropped: 1 });
    expect(await waiting()).toBe(0);
    // A provider with no parser here: dropped too. An event the command refuses (a thread of no length) is the notice's own fault.
    await park(Buffer.from('{}'), 'facebook_page');
    await park(sandboxNoticeBody({ accountId: o.accountId, events: [event('', 'x')] }));
    expect(await intake()).toEqual({ stored: 0, dropped: 1 });
    expect(await waiting()).toBe(0);
  });

  it('takes a sandbox notice to the connection it names and no other, even when two orgs chose the same sandbox key', async () => {
    const key = `sandbox-shared-${randomUUID().slice(0, 8)}`;
    const a = await org(key);
    const b = await org(key);
    await park(sandboxNoticeBody({ accountId: key, connectionId: a.connectionId, events: [event('c-1', 'Chỉ cho tổ chức A')] }));
    expect(await intake()).toEqual({ stored: 1, dropped: 0 });
    expect(await rows('SELECT 1 FROM crove_kernel.conversation WHERE org_id = $1', [a.orgId])).toHaveLength(1);
    expect(await rows('SELECT 1 FROM crove_kernel.conversation WHERE org_id = $1', [b.orgId])).toHaveLength(0);
    // A platform's notice names no connection: both orgs that connected the same page get it.
    await park(sandboxNoticeBody({ accountId: key, events: [event('c-2', 'Cho cả hai')] }));
    expect(await intake()).toEqual({ stored: 2, dropped: 0 });
  });

  it('drops a notice that waited seven days, and counts it', async () => {
    const o = await org();
    await park(sandboxNoticeBody({ accountId: o.accountId, events: [event('c-1', 'Quá cũ')] }));
    await rows("UPDATE crove_kernel.conversation_inbound_pending SET received_at = now() - interval '8 days'");
    const lines: string[] = [];
    expect(await runConversationIntake({ workerDb, runtime: worker, log: (m) => lines.push(m) })).toEqual({ stored: 0, dropped: 1 });
    expect(await rows('SELECT 1 FROM crove_kernel.conversation WHERE org_id = $1', [o.orgId])).toHaveLength(0);
    expect(await waiting()).toBe(0);
    // The log names its id, provider and why, never its text.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^dropped notice \d+ \(sandbox, expired\)/);
    expect(lines[0]).not.toContain('Quá cũ');
  });

  it('sends a reply once with the sealed credential, and a second job does nothing', async () => {
    const o = await org();
    const platform = new SandboxPublisher().conversations;
    const { id, messageId } = await queuedReply(o);
    const job = { orgId: o.orgId, messageId, connectionId: o.connectionId, action: 'reply' as const };
    expect(await runConversationJob(jobDeps(platform), job)).toBe('accepted');
    expect(platform.replies).toHaveLength(1);
    expect(platform.replies[0]).toMatchObject({ text: 'Dạ có ạ', externalAccountId: o.accountId });
    expect((await detail(o, id)).messages[1]).toMatchObject({ sendState: 'sent' });
    // The queue delivers the job again (or the relay sent a second one): the message is settled, so no second call.
    expect(await runConversationJob(jobDeps(platform), job)).toBe('settled');
    expect(platform.replies).toHaveLength(1);
  });

  it('never sends twice after a worker died: an adapter that throws after the platform took the reply leaves it unclear for a person', async () => {
    const o = await org();
    const platform = new SandboxPublisher().conversations;
    const { id, messageId } = await queuedReply(o);
    // The call goes out and the answer is lost (the process is killed, the connection drops).
    const dying: ConversationAdapter = {
      provider: 'sandbox',
      reply: async (input) => {
        await platform.reply(input);
        throw new Error('connection reset');
      },
    };
    const job = { orgId: o.orgId, messageId, connectionId: o.connectionId, action: 'reply' as const };
    expect(await runConversationJob(jobDeps(dying), job)).toBe('unknown');
    expect(platform.replies).toHaveLength(1);
    expect((await detail(o, id)).messages[1]).toMatchObject({ sendState: 'unknown', sendErrorCode: 'ADAPTER_ERROR' });
    // The job comes round again: nothing is sent.
    expect(await runConversationJob(jobDeps(platform), job)).toBe('settled');
    expect(platform.replies).toHaveLength(1);
    // A person sees it on the platform and sends it again as a new attempt: a second call under a new key.
    await rt.execute('kernel.conversation.reply_settle', { messageId, action: 'retry' }, { actor: asUser(o.lan), orgId: o.orgId });
    expect(await runConversationJob(jobDeps(platform), job)).toBe('accepted');
    expect(platform.replies.map((r) => r.callKey)).toEqual([`conversation.reply:${messageId}:1`, `conversation.reply:${messageId}:2`]);
  });

  it('expires the connection when the platform refuses its token, and fails the reply when the owner is gone', async () => {
    const o = await org();
    const { id, messageId } = await queuedReply(o);
    const refusing: ConversationAdapter = { provider: 'sandbox', reply: async () => ({ kind: 'rejected', error: 'token_expired', code: 'SANDBOX_TOKEN' }) };
    const job = { orgId: o.orgId, messageId, connectionId: o.connectionId, action: 'reply' as const };
    expect(await runConversationJob(jobDeps(refusing), job)).toBe('rejected');
    expect((await detail(o, id)).messages[1]).toMatchObject({ sendState: 'failed', sendErrorCode: 'SANDBOX_TOKEN' });
    expect(await rows('SELECT status FROM crove_kernel.channel_connection WHERE id = $1', [o.connectionId])).toEqual([{ status: 'expired' }]);
    // A reply on an expired connection is refused up front.
    await expect(rt.execute('kernel.conversation.reply', { conversationId: id, body: 'nữa', lastSeenSeq: 2 }, { actor: asUser(o.lan), orgId: o.orgId })).rejects.toMatchObject({ code: 'CHANNEL_NOT_ACTIVE' });
    // The member who connected it leaves the org: the credential is refused, nothing is sent, the connection is expired.
    const p = await org();
    const second = await queuedReply(p, 'Chào');
    await admin(async (c) => {
      await c.query("UPDATE crove_kernel.tenant_member SET role = 'owner' WHERE org_id = $1 AND user_id = $2", [p.orgId, p.lan]);
      await c.query('DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [p.orgId, p.owner]);
    });
    const platform = new SandboxPublisher().conversations;
    expect(await runConversationJob(jobDeps(platform), { orgId: p.orgId, messageId: second.messageId, connectionId: p.connectionId, action: 'reply' })).toBe('refused');
    expect(platform.replies).toHaveLength(0);
    expect((await detail({ ...p, owner: p.lan }, second.id)).messages[1]).toMatchObject({ sendState: 'failed', sendErrorCode: 'CHANNEL_OWNER_LEFT' });
  });

  it('settles a send nobody finished: a worker that died after begin leaves it unclear within the minute, and a late answer still counts', async () => {
    const o = await org();
    const { id, messageId } = await queuedReply(o);
    const begun = await worker.execute<{ callKey: string }>('kernel.conversation.reply_begin', { messageId }, { actor: { type: 'system', component: 'conversations' }, orgId: o.orgId });
    // Not stale yet: the sweep leaves it.
    expect(await sweepStaleReplies({ workerDb, runtime: worker, now: () => Date.now() + 120_000 })).toBe(0);
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query("SET LOCAL session_replication_role = 'replica'");
      await c.query("UPDATE crove_kernel.external_call SET started_at = now() - interval '11 minutes' WHERE org_id = $1 AND step = 'reply'", [o.orgId]);
      await c.query('COMMIT');
    });
    expect(await sweepStaleReplies({ workerDb, runtime: worker, now: () => Date.now() + 240_000 })).toBeGreaterThanOrEqual(1);
    expect((await detail(o, id)).messages[1]).toMatchObject({ sendState: 'unknown', sendErrorCode: 'WORKER_LOST' });
    // The slow worker's answer arrives after all: the platform took it, so a person is not asked to send it again.
    await worker.execute('kernel.conversation.reply_record', { messageId, callKey: begun.callKey, result: { kind: 'accepted', externalId: 'late-1' } }, { actor: { type: 'system', component: 'conversations' }, orgId: o.orgId });
    expect((await detail(o, id)).messages[1]).toMatchObject({ sendState: 'sent', sendErrorCode: null });
  });

  it('fails the reply, not leaves it sending, when the credential cannot be opened after the call was begun', async () => {
    const o = await org();
    const { id, messageId } = await queuedReply(o);
    const broken = { ...jobDeps(new SandboxPublisher().conversations), broker: { open: () => { throw new Error('vault down'); } } as never };
    expect(await runConversationJob(broken, { orgId: o.orgId, messageId, connectionId: o.connectionId, action: 'reply' })).toBe('credential_error');
    expect((await detail(o, id)).messages[1]).toMatchObject({ sendState: 'failed', sendErrorCode: 'CREDENTIAL_ERROR' });
  });

  it('hides a comment on the platform, and repeats an unclear hide', async () => {
    const o = await org();
    const platform = new SandboxPublisher().conversations;
    await park(sandboxNoticeBody({ accountId: o.accountId, events: [event('c-1', 'Spam', { messageId: 'm-spam' })] }));
    await intake();
    const id = await threadOf(o, 'c-1');
    const messageId = (await detail(o, id)).messages[0]?.id as string;
    await rt.execute('kernel.conversation.hide', { messageId, hidden: true }, { actor: asUser(o.lan), orgId: o.orgId });
    const job = { orgId: o.orgId, messageId, connectionId: o.connectionId, action: 'hide' as const };
    // The first answer is lost: the job fails and is repeated; hiding twice is one hide.
    const flaky: ConversationAdapter = { provider: 'sandbox', reply: platform.reply.bind(platform), hide: async () => ({ kind: 'unknown', code: 'TIMEOUT' }) };
    await expect(runConversationJob(jobDeps(flaky), job)).rejects.toThrow();
    expect((await detail(o, id)).messages[0]).toMatchObject({ hidden: false, hideRequest: 'hide' });
    expect(await runConversationJob(jobDeps(platform), job)).toBe('done');
    expect(platform.hidden.has('m-spam')).toBe(true);
    expect((await detail(o, id)).messages[0]).toMatchObject({ hidden: true, hideRequest: null });
    expect(await rows("SELECT calls, state FROM crove_kernel.external_call WHERE org_id = $1 AND step = 'hide'", [o.orgId])).toEqual([{ calls: 2, state: 'succeeded' }]);
  });
});
