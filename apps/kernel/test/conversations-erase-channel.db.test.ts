// SPDX-License-Identifier: AGPL-3.0-only
// Deleting a disconnected channel's conversations too (#3299, plan docs/plan/conversations.md section 10) on PostgreSQL 17:
// `kernel.conversation.erase_channel` (R3, owners and admins, never the system or an agent), which runs the erase path Meta's data deletion
// callback uses; the counts the confirmation names; what it keeps (another channel, another org, the identities still named); the image rows
// and their blob keys; an erase that is run again; and a notice in flight at the same time as the disconnect.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sandboxNoticeBody } from '@crove/channel';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { ConversationEvent } from '@crove/kernel-contract';
import { CredentialVault, parseVaultKey, Runtime } from '@crove/kernel-runtime';
import { runConversationIntake } from '../src/conversations-worker.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('deleting a disconnected channel\'s conversations too on PostgreSQL (#3299)', () => {
  const dbName = `crove_test_conversations_erase_channel_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let workerDb: Db;
  let rt: Runtime;
  let worker: Runtime;
  let vault: CredentialVault;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const, sessionId: randomUUID() });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });

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
  async function park(body: Buffer): Promise<void> {
    const client = new pg.Client({ connectionString: appUrl });
    await client.connect();
    try {
      await client.query('SELECT crove_kernel.conversation_inbound_enqueue($1, $2)', ['sandbox', body]);
    } finally {
      await client.end();
    }
  }
  const intake = () => runConversationIntake({ workerDb, runtime: worker, log: () => {} });

  type Org = { orgId: string; owner: string; admin: string; lan: string; viewer: string; connectionId: string; accountId: string };
  async function org(): Promise<Org> {
    const user = async (tag: string) => (await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${tag}-${randomUUID().slice(0, 8)}@cv6.test`, name: null })) as string;
    const [owner, adm, lan, viewer] = [await user('owner'), await user('admin'), await user('lan'), await user('viewer')];
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    await admin(async (c) => {
      await c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')", [orgId, adm, lan, viewer]);
    });
    const accountId = `sandbox-${randomUUID().slice(0, 8)}`;
    const sealed = vault.seal(JSON.stringify({ accessToken: `sbx_${randomBytes(24).toString('base64url')}` }), { orgId, provider: 'sandbox', externalAccountId: accountId });
    const { connectionId } = await rt.execute<{ connectionId: string }>(
      'kernel.channel.connect',
      { provider: 'sandbox', externalAccountId: accountId, displayName: 'Kênh thử', scopes: [], expiresAt: null, credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') } },
      { actor: asUser(owner), orgId },
    );
    return { orgId, owner, admin: adm, lan, viewer, connectionId, accountId };
  }

  // A thread from a customer, taken in through the intake, on the org's first channel or on the account given.
  async function thread(o: Org, threadId: string, text: string, customer = 'u-1', accountId = o.accountId): Promise<string> {
    const ev: ConversationEvent = { kind: 'comment_thread', threadId, postId: 'post-1', messageId: `m-${randomUUID().slice(0, 8)}`, direction: 'in', contact: { id: customer, name: `Khách ${customer}` }, text, at: new Date().toISOString() };
    await park(sandboxNoticeBody({ accountId, events: [ev] }));
    await intake();
    const [row] = await rows<{ id: string }>('SELECT id FROM crove_kernel.conversation WHERE org_id = $1 AND external_thread_id = $2', [o.orgId, threadId]);
    return (row as { id: string }).id;
  }
  // A second channel of the org.
  async function secondChannel(o: Org): Promise<{ connectionId: string; accountId: string }> {
    const accountId = `sandbox-${randomUUID().slice(0, 8)}`;
    const sealed = vault.seal(JSON.stringify({ accessToken: `sbx_${randomBytes(24).toString('base64url')}` }), { orgId: o.orgId, provider: 'sandbox', externalAccountId: accountId });
    const { connectionId } = await rt.execute<{ connectionId: string }>(
      'kernel.channel.connect',
      { provider: 'sandbox', externalAccountId: accountId, displayName: 'Kênh thứ hai', scopes: [], expiresAt: null, credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') } },
      { actor: asUser(o.owner), orgId: o.orgId },
    );
    return { connectionId, accountId };
  }
  const threads = async (o: Org, connectionId?: string) => (await rows<{ external_thread_id: string }>('SELECT external_thread_id FROM crove_kernel.conversation WHERE org_id = $1 AND ($2::uuid IS NULL OR channel_connection_id = $2::uuid) ORDER BY external_thread_id', [o.orgId, connectionId ?? null])).map((r) => r.external_thread_id);
  const count = async (table: string, o: Org) => Number((await rows<{ n: string }>(`SELECT count(*)::text AS n FROM crove_kernel.${table} WHERE org_id = $1`, [o.orgId]))[0]?.n);

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
    pool = createPool({ connectionString: appUrl, max: 4 });
    db = createDb(pool);
    const w = new URL(adminUrl);
    w.username = 'crove_worker';
    w.password = 'test-worker-pw';
    workerPool = createPool({ connectionString: w.toString(), max: 2 });
    workerDb = createDb(workerPool);
    vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
    const registered = { commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: null })] };
    rt = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' }).register(registered);
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


  const disconnect = (o: Org, connectionId: string) => rt.execute('kernel.channel.disconnect', { connectionId }, { actor: asUser(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() });
  const eraseAs = (o: Org, connectionId: string, actor: Parameters<Runtime['execute']>[2]['actor'], key: string = randomUUID()) =>
    rt.execute<{ threads: number; messages: number; identities: number }>('kernel.conversation.erase_channel', { connectionId, confirm: true }, { actor, orgId: o.orgId, idempotencyKey: key });
  const counts = (o: Org, connectionId: string, who: string) => rt.query<{ threads: number; messages: number }>('kernel.conversation.channel_counts', { connectionId }, { actor: asUser(who), orgId: o.orgId });

  describe('the confirmation and the erasure', () => {
    it('names the counts to owners and admins only, and counts only the channel asked for', async () => {
      const o = await org();
      const two = await secondChannel(o);
      await thread(o, 'c-1', 'Một', 'u-c1');
      await thread(o, 'c-1', 'Hai', 'u-c2');
      await thread(o, 'c-2', 'Ba', 'u-c3');
      await thread(o, 'c-other', 'Kênh khác', 'u-c4', two.accountId);
      for (const who of [o.owner, o.admin]) expect(await counts(o, o.connectionId, who)).toEqual({ threads: 2, messages: 3 });
      expect(await counts(o, two.connectionId, o.owner)).toEqual({ threads: 1, messages: 1 });
      for (const who of [o.lan, o.viewer]) await expect(counts(o, o.connectionId, who)).rejects.toMatchObject({ status: 403 });
      // Another org's channel counts as nothing.
      const stranger = await org();
      expect(await counts(stranger, o.connectionId, stranger.owner)).toEqual({ threads: 0, messages: 0 });
    });

    it('keeps everything when the option is off: a disconnect alone keeps the conversations', async () => {
      const o = await org();
      await thread(o, 'k-1', 'Giữ lại', 'u-k1');
      await disconnect(o, o.connectionId);
      expect((await rows<{ status: string }>('SELECT status FROM crove_kernel.channel_connection WHERE id = $1', [o.connectionId]))[0]?.status).toBe('revoked');
      expect(await threads(o)).toEqual(['k-1']);
      expect(await count('conversation_message', o)).toBe(1);
      expect(await count('conversation_identity', o)).toBe(1);
    });

    it('lets an owner and an admin erase a channel in one step (disconnecting it first), with a fresh second factor, and leaves another channel, another org and a shared identity alone', async () => {
      const o = await org();
      const two = await secondChannel(o);
      const other = await org();
      // The channel to erase: two threads (one a note on it) and an identity that only it names, and one that the other channel names too.
      const first = await thread(o, 'a-1', 'Số điện thoại 0912345678', 'u-only');
      await thread(o, 'a-1', 'Trả lời của người khác', 'u-shared');
      await thread(o, 'a-2', 'Bình luận thứ hai', 'u-shared');
      await rt.execute('kernel.conversation.note', { conversationId: first, body: 'Ghi chú nội bộ' }, { actor: asUser(o.lan), orgId: o.orgId });
      await thread(o, 'b-1', 'Của kênh khác', 'u-shared', two.accountId);
      await thread(other, 'x-1', 'Của org khác', 'u-x');
      // An image row on the first message and a mail's answer is not needed here: the image goes with its message and its blob is queued.
      const [msg] = await rows<{ id: string; kind: string }>('SELECT id, kind FROM crove_kernel.conversation_message WHERE org_id = $1 AND conversation_id = $2 ORDER BY seq LIMIT 1', [o.orgId, first]);
      const key = `conversation/${o.orgId}/${'c'.repeat(64)}`;
      await rows("INSERT INTO crove_kernel.conversation_attachment (org_id, message_id, channel_connection_id, kind, source_url, storage_key) VALUES ($1, $2, $3, $4, 'https://x.test/a.png', $5)", [o.orgId, msg?.id, o.connectionId, msg?.kind, key]);
      expect(await count('conversation_attachment', o)).toBe(1);
      const before = { otherThreads: await threads(other), twoThreads: await threads(o, two.connectionId), otherMessages: await count('conversation_message', other) };
      // A member, a viewer, an agent and the system are refused; an admin without a fresh second factor is asked for one before anything changes.
      const untouched = async () => {
        expect((await rows<{ status: string }>('SELECT status FROM crove_kernel.channel_connection WHERE id = $1', [o.connectionId]))[0]?.status).toBe('active');
        expect(await threads(o, o.connectionId)).toEqual(['a-1', 'a-2']);
      };
      for (const who of [o.lan, o.viewer]) await expect(eraseAs(o, o.connectionId, asMfa(who))).rejects.toMatchObject({ status: 403 });
      await expect(eraseAs(o, o.connectionId, { type: 'agent', agentId: randomUUID(), runId: randomUUID() })).rejects.toMatchObject({ status: 403 });
      await expect(worker.execute('kernel.conversation.erase_channel', { connectionId: o.connectionId, confirm: true }, { actor: { type: 'system', component: 'conversations' }, orgId: o.orgId, idempotencyKey: randomUUID() })).rejects.toMatchObject({ status: 403 });
      await expect(eraseAs(o, o.connectionId, asUser(o.admin))).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
      await untouched();
      // The admin with a fresh second factor erases: two threads, three messages, and the identity only this channel named.
      expect(await eraseAs(o, o.connectionId, asMfa(o.admin))).toEqual({ threads: 2, messages: 3, identities: 1 });
      expect(await threads(o, o.connectionId)).toEqual([]);
      // The same transaction disconnected the channel (its own command, its own audit row) and dropped its token.
      expect((await rows<{ status: string; status_reason: string }>('SELECT status, status_reason FROM crove_kernel.channel_connection WHERE id = $1', [o.connectionId]))[0]).toEqual({ status: 'revoked', status_reason: 'disconnected' });
      expect(await rows("SELECT 1 FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.channel.disconnect' AND outcome = 'ok'", [o.orgId])).toHaveLength(1);
      expect(await count('conversation_note', o)).toBe(0);
      expect(await count('conversation_attachment', o)).toBe(0);
      // The image's blob is queued for the worker to delete, in the same transaction as its row.
      expect((await rows<{ storage_key: string }>('SELECT storage_key FROM crove_kernel.conversation_blob_doomed WHERE storage_key = $1', [key])).map((r) => r.storage_key)).toEqual([key]);
      // The other channel, its customer and the other org are as they were.
      expect(await threads(o, two.connectionId)).toEqual(before.twoThreads);
      expect(await threads(other)).toEqual(before.otherThreads);
      expect(await count('conversation_message', other)).toBe(before.otherMessages);
      expect((await rows<{ external_user_id: string }>('SELECT external_user_id FROM crove_kernel.conversation_identity WHERE org_id = $1 ORDER BY 1', [o.orgId])).map((r) => r.external_user_id)).toEqual(['u-shared']);
      // The audit row holds the connection id and counts, no word a customer wrote, no name, no key.
      const [audit] = await rows<{ detail: unknown; actor_type: string }>("SELECT detail, actor_type FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.conversation.erase_channel' AND outcome = 'ok'", [o.orgId]);
      const text = JSON.stringify(audit?.detail);
      expect(text).toContain(o.connectionId);
      expect(text).toContain('"threads":2');
      for (const word of ['0912345678', 'Ghi chú nội bộ', 'u-only', 'Khách u-only', 'https://x.test', 'conversation/']) expect(text).not.toContain(word);
      expect(audit?.actor_type).toBe('user');
      // An owner may erase too (the same call finds nothing left), and the owner of another org cannot reach this channel at all.
      expect(await eraseAs(o, o.connectionId, asMfa(o.owner))).toEqual({ threads: 0, messages: 0, identities: 0 });
      await expect(eraseAs(other, o.connectionId, asMfa(other.owner))).rejects.toMatchObject({ status: 404 });
      expect(await threads(o, two.connectionId)).toEqual(before.twoThreads);
    });

    it('is safe to run again: the same key returns the first answer, a new key finds nothing, and a notice that arrives afterwards is ignored', async () => {
      const o = await org();
      await thread(o, 'r-1', 'Một', 'u-r1');
      await thread(o, 'r-2', 'Hai', 'u-r2');
      await disconnect(o, o.connectionId);
      const key = randomUUID();
      const first = await eraseAs(o, o.connectionId, asMfa(o.owner), key);
      expect(first).toEqual({ threads: 2, messages: 2, identities: 2 });
      expect(await eraseAs(o, o.connectionId, asMfa(o.owner), key)).toEqual(first);
      expect(await eraseAs(o, o.connectionId, asMfa(o.owner))).toEqual({ threads: 0, messages: 0, identities: 0 });
      // The disconnected channel takes in nothing more: a notice for it is ignored, so no thread comes back.
      await thread(o, 'r-3', 'Đến sau', 'u-r3').catch(() => undefined);
      expect(await threads(o)).toEqual([]);
    });

    it('makes a notice that starts while the disconnect is in progress wait for it, and then ignore it', async () => {
      const o = await org();
      const holder = new pg.Client({ connectionString: adminUrl });
      await holder.connect();
      try {
        // The disconnect has taken the connection's row and not committed yet: the intake reads it under its share lock, so it waits.
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM crove_kernel.channel_connection WHERE org_id = $1 AND id = $2 FOR UPDATE', [o.orgId, o.connectionId]);
        await holder.query("UPDATE crove_kernel.channel_connection SET status = 'revoked', status_reason = 'disconnected' WHERE org_id = $1 AND id = $2", [o.orgId, o.connectionId]);
        const ev: ConversationEvent = { kind: 'comment_thread', threadId: 'wait-1', postId: 'post-1', messageId: `m-${randomUUID().slice(0, 8)}`, direction: 'in', contact: { id: 'u-wait', name: 'Khách chờ' }, text: 'Đến đúng lúc ngắt kết nối', at: new Date().toISOString() };
        await park(sandboxNoticeBody({ accountId: o.accountId, events: [ev] }));
        let done = false;
        const taking = intake().then(() => {
          done = true;
        });
        await new Promise((r) => setTimeout(r, 800));
        expect(done).toBe(false);
        await holder.query('COMMIT');
        await taking;
        expect(done).toBe(true);
        // It read the connection as revoked: nothing was stored.
        expect(await threads(o)).toEqual([]);
      } finally {
        await holder.end();
      }
    });

    it('takes turns with a notice in flight: the erase waits for the intake that holds the channel and then erases what that intake stored', async () => {
      const o = await org();
      const holder = new pg.Client({ connectionString: adminUrl });
      await holder.connect();
      try {
        // An intake in flight reads the connection under a key-share lock and keeps it until it commits.
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM crove_kernel.channel_connection WHERE org_id = $1 AND id = $2 FOR KEY SHARE', [o.orgId, o.connectionId]);
        let done = false;
        const pending = eraseAs(o, o.connectionId, asMfa(o.owner)).then((r) => {
          done = true;
          return r;
        });
        await new Promise((r) => setTimeout(r, 600));
        expect(done).toBe(false);
        // The intake commits its thread, then the erase goes through and removes it.
        await holder.query(`INSERT INTO crove_kernel.conversation_identity (org_id, provider, external_user_id, display_name) VALUES ($1, 'sandbox', 'u-late', 'Khách muộn')`, [o.orgId]);
        await holder.query(
          `INSERT INTO crove_kernel.conversation (org_id, channel_connection_id, kind, external_thread_id, identity_id, status, opened_at, created_at, updated_at)
           SELECT $1, $2, 'comment_thread', 'late-1', i.id, 'new', now(), now(), now() FROM crove_kernel.conversation_identity i WHERE i.org_id = $1 AND i.external_user_id = 'u-late'`,
          [o.orgId, o.connectionId],
        );
        await holder.query('COMMIT');
        expect(await pending).toMatchObject({ threads: 1, identities: 1 });
        expect(await threads(o)).toEqual([]);
      } finally {
        await holder.end();
      }
    });

    it('changes nothing when the channel cannot be disconnected (a Telegram bot that still receives chats), and erases an expired channel', async () => {
      const o = await org();
      await thread(o, 'p-1', 'Một', 'u-p1');
      await rows("UPDATE crove_kernel.channel_connection SET chat_state = 'on', chat_hook = repeat('a', 43) WHERE id = $1", [o.connectionId]);
      await expect(eraseAs(o, o.connectionId, asMfa(o.owner))).rejects.toMatchObject({ status: 409, code: 'CHAT_IS_ON' });
      expect(await threads(o)).toEqual(['p-1']);
      expect((await rows<{ status: string }>('SELECT status FROM crove_kernel.channel_connection WHERE id = $1', [o.connectionId]))[0]?.status).toBe('active');
      // A channel whose token was refused (expired) is disconnected and erased like any other.
      await rows("UPDATE crove_kernel.channel_connection SET chat_state = 'off', chat_hook = NULL, chat_hook_next = NULL, status = 'expired', status_reason = 'token_refused' WHERE id = $1", [o.connectionId]);
      expect(await eraseAs(o, o.connectionId, asMfa(o.owner))).toMatchObject({ threads: 1 });
      expect((await rows<{ status: string }>('SELECT status FROM crove_kernel.channel_connection WHERE id = $1', [o.connectionId]))[0]?.status).toBe('revoked');
    });
  });
});
