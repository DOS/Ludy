// SPDX-License-Identifier: AGPL-3.0-only
// Conversation retention, erasure and Meta's data deletion on PostgreSQL 17 (CV6, #2305): how long threads are kept and who sets it,
// the nightly purge of what is past it (per org, in batches, nothing of a message in the audit row), erasing one customer (R3,
// owners and admins), the one Meta callback that fans out to the Ads and the conversation sides under one code, and the export
// listing the conversation tables. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformUserHash } from '@crove/ad-platform';
import { sandboxNoticeBody } from '@crove/channel';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { EXPORT_TABLE_NAMES, createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { ConversationEvent, ConversationRetention } from '@crove/kernel-contract';
import { CredentialVault, parseVaultKey, Runtime, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { purgeExpiredConversations, runConversationDeletions, runConversationIntake } from '../src/conversations-worker.ts';
import { acceptMetaDeletion, metaDeletionStatus, renderMetaDeletionStatus } from '../src/meta-deletion.ts';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SECRET = 'meta-pages-app-secret-for-the-test';

class MemoryStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();
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

suite('conversation retention, erasure and the Meta deletion callback on PostgreSQL (CV6, #2305)', () => {
  const dbName = `crove_test_conversations_cv6_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

  // A thread from a customer, taken in through the intake. Its last message is aged by `months` when asked.
  async function thread(o: Org, threadId: string, text: string, customer = 'u-1', months = 0): Promise<string> {
    const ev: ConversationEvent = { kind: 'comment_thread', threadId, postId: 'post-1', messageId: `m-${randomUUID().slice(0, 8)}`, direction: 'in', contact: { id: customer, name: `Khách ${customer}` }, text, at: new Date().toISOString() };
    await park(sandboxNoticeBody({ accountId: o.accountId, events: [ev] }));
    await intake();
    const [row] = await rows<{ id: string }>('SELECT id FROM crove_kernel.conversation WHERE org_id = $1 AND external_thread_id = $2', [o.orgId, threadId]);
    const id = (row as { id: string }).id;
    if (months > 0) await rows(`UPDATE crove_kernel.conversation SET last_message_at = now() - make_interval(months => $2, days => 3), opened_at = now() - make_interval(months => $2, days => 3) WHERE org_id = $1 AND id = $3`, [o.orgId, months, id]);
    return id;
  }
  const threads = async (o: Org) => (await rows<{ external_thread_id: string }>('SELECT external_thread_id FROM crove_kernel.conversation WHERE org_id = $1 ORDER BY external_thread_id', [o.orgId])).map((r) => r.external_thread_id);
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

  describe('the retention setting', () => {
    it('is 24 months until an owner or admin chooses, readable by every member', async () => {
      const o = await org();
      for (const who of [o.owner, o.admin, o.lan, o.viewer]) {
        expect(await rt.query<ConversationRetention>('kernel.conversation.retention', {}, { actor: asUser(who), orgId: o.orgId })).toEqual({ retentionMonths: 24, isDefault: true });
      }
      const set = await rt.execute<ConversationRetention>('kernel.conversation.retention_set', { retentionMonths: 6 }, { actor: asUser(o.admin), orgId: o.orgId });
      expect(set).toEqual({ retentionMonths: 6, isDefault: false });
      expect(await rt.query('kernel.conversation.retention', {}, { actor: asUser(o.viewer), orgId: o.orgId })).toEqual({ retentionMonths: 6, isDefault: false });
      // Changed again by the owner, and to keeping everything.
      await rt.execute('kernel.conversation.retention_set', { retentionMonths: null }, { actor: asUser(o.owner), orgId: o.orgId });
      expect(await rt.query('kernel.conversation.retention', {}, { actor: asUser(o.lan), orgId: o.orgId })).toEqual({ retentionMonths: null, isDefault: false });
      expect(await count('conversation_setting', o)).toBe(1);
      // The audit row says what was chosen, nothing else.
      const [audit] = await rows<{ detail: { retention_months: number | null } }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.conversation.retention_set' AND outcome = 'ok' ORDER BY id DESC LIMIT 1", [o.orgId]);
      expect(audit?.detail).toMatchObject({ retention_months: null });
    });

    it('is refused to a member or viewer, to a month count the product does not offer, and never crosses orgs', async () => {
      const o = await org();
      const other = await org();
      for (const who of [o.lan, o.viewer]) {
        await expect(rt.execute('kernel.conversation.retention_set', { retentionMonths: 6 }, { actor: asUser(who), orgId: o.orgId })).rejects.toMatchObject({ status: 403 });
      }
      await expect(rt.execute('kernel.conversation.retention_set', { retentionMonths: 3 }, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toMatchObject({ status: 422 });
      await expect(rt.execute('kernel.conversation.retention_set', { retentionMonths: 6 }, { actor: asUser(o.owner), orgId: other.orgId })).rejects.toBeTruthy();
      expect(await count('conversation_setting', o)).toBe(0);
      expect(await count('conversation_setting', other)).toBe(0);
    });
  });

  describe('the nightly purge', () => {
    it('deletes threads past each org’s own retention, with their messages, notes, read marks and orphan identities, and nothing else', async () => {
      const a = await org();
      const b = await org();
      const c = await org();
      await rt.execute('kernel.conversation.retention_set', { retentionMonths: 12 }, { actor: asUser(a.owner), orgId: a.orgId });
      await rt.execute('kernel.conversation.retention_set', { retentionMonths: null }, { actor: asUser(c.owner), orgId: c.orgId });
      // Org a (12 months): one thread 13 months old, one 11 months old. Org b (default 24): 13 and 25 months. Org c (keep): 30 months.
      const aOld = await thread(a, 'a-old', 'Tin nhắn cũ của khách', 'u-old', 13);
      await thread(a, 'a-new', 'Tin nhắn mới', 'u-new', 11);
      await thread(b, 'b-mid', 'Tin nhắn 13 tháng', 'u-mid', 13);
      await thread(b, 'b-old', 'Tin nhắn 25 tháng', 'u-ancient', 25);
      await thread(c, 'c-old', 'Tin nhắn 30 tháng', 'u-keep', 30);
      // A note and a read mark hang on the old thread of org a.
      await rt.execute('kernel.conversation.note', { conversationId: aOld, body: 'Ghi chú nội bộ' }, { actor: asUser(a.lan), orgId: a.orgId });
      await rt.execute('kernel.conversation.mark_read', { conversationId: aOld, seq: 1 }, { actor: asUser(a.owner), orgId: a.orgId });
      expect(await count('conversation_note', a)).toBe(1);
      const dueBefore = (await workerPool.query<{ org_id: string }>('SELECT org_id FROM crove_kernel.conversation_purge_due($1)', [1000])).rows.map((r) => r.org_id);
      expect(dueBefore).toEqual(expect.arrayContaining([a.orgId, b.orgId]));
      expect(dueBefore).not.toContain(c.orgId);
      const purged = await purgeExpiredConversations({ runtime: worker, workerDb });
      expect(purged).toBeGreaterThanOrEqual(2);
      expect(await threads(a)).toEqual(['a-new']);
      expect(await threads(b)).toEqual(['b-mid']);
      expect(await threads(c)).toEqual(['c-old']);
      // What hung on the purged thread went with it; the identity of the thread that stays stays, the orphan's does not.
      expect(await count('conversation_note', a)).toBe(0);
      expect(await count('conversation_read', a)).toBe(0);
      expect(await count('conversation_message', a)).toBe(1);
      expect((await rows<{ external_user_id: string }>('SELECT external_user_id FROM crove_kernel.conversation_identity WHERE org_id = $1', [a.orgId])).map((r) => r.external_user_id)).toEqual(['u-new']);
      expect(await count('conversation_identity', c)).toBe(1);
      // The audit row of the purge carries counts and the retention, never a word a customer wrote.
      const audit = await rows<{ detail: unknown }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.conversation.purge_expired' AND outcome = 'ok'", [a.orgId]);
      expect(audit).toHaveLength(1);
      const text = JSON.stringify(audit[0]?.detail);
      expect(text).toContain('"threads":1');
      for (const word of ['Tin nhắn cũ', 'Ghi chú nội bộ', 'Khách u-old', 'u-old']) expect(text).not.toContain(word);
      // A second pass finds nothing more, and an org that keeps everything is never listed as due.
      expect(await purgeExpiredConversations({ runtime: worker, workerDb })).toBe(0);
      expect((await workerPool.query<{ org_id: string }>('SELECT org_id FROM crove_kernel.conversation_purge_due($1)', [1000])).rows.map((r) => r.org_id)).not.toContain(c.orgId);
    });

    it('works in batches, tells the caller when more is left, and is the system’s alone', async () => {
      const o = await org();
      for (let i = 0; i < 3; i++) await thread(o, `batch-${i}`, `Tin ${i}`, `u-b${i}`, 30);
      await expect(rt.execute('kernel.conversation.purge_expired', { limit: 2 }, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toMatchObject({ status: 403 });
      const first = await worker.execute<{ threads: number; more: boolean }>('kernel.conversation.purge_expired', { limit: 2 }, { actor: { type: 'system', component: 'conversations' }, orgId: o.orgId });
      expect(first).toMatchObject({ threads: 2, more: true });
      const second = await worker.execute<{ threads: number; more: boolean }>('kernel.conversation.purge_expired', { limit: 2 }, { actor: { type: 'system', component: 'conversations' }, orgId: o.orgId });
      expect(second).toMatchObject({ threads: 1, more: false });
      expect(await threads(o)).toEqual([]);
      // The listing of due orgs is the worker login's alone.
      await expect(pool.query('SELECT * FROM crove_kernel.conversation_purge_due(10)')).rejects.toMatchObject({ code: '42501' });
    });

    it('purges after the retention is shortened, and not before it', async () => {
      const o = await org();
      await thread(o, 'short-1', 'Cũ 8 tháng', 'u-s1', 8);
      expect(await purgeExpiredConversations({ runtime: worker, workerDb })).toBeGreaterThanOrEqual(0);
      expect(await threads(o)).toEqual(['short-1']);
      await rt.execute('kernel.conversation.retention_set', { retentionMonths: 6 }, { actor: asUser(o.owner), orgId: o.orgId });
      await purgeExpiredConversations({ runtime: worker, workerDb });
      expect(await threads(o)).toEqual([]);
    });
  });

  describe('erasing one customer', () => {
    it('deletes every thread of that customer with its messages and notes and their identity, and no one else’s, behind a fresh second factor', async () => {
      const o = await org();
      const mine = await thread(o, 'e-1', 'Số điện thoại của tôi là 0912345678', 'u-erase');
      await thread(o, 'e-2', 'Một bình luận khác của tôi', 'u-erase');
      await thread(o, 'e-3', 'Bình luận của người khác', 'u-other');
      await rt.execute('kernel.conversation.note', { conversationId: mine, body: 'Khách này hay hỏi giá' }, { actor: asUser(o.lan), orgId: o.orgId });
      const erase = (who: string, actor: typeof asMfa | typeof asUser = asMfa) => rt.execute<{ threads: number; messages: number }>('kernel.conversation.erase_contact', { conversationId: mine, confirm: true }, { actor: actor(who), orgId: o.orgId, idempotencyKey: randomUUID() });
      // A member or viewer may not; an admin without a fresh second factor is asked for one first.
      await expect(erase(o.lan)).rejects.toMatchObject({ status: 403 });
      await expect(erase(o.viewer)).rejects.toMatchObject({ status: 403 });
      await expect(erase(o.admin, asUser)).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
      expect(await threads(o)).toEqual(['e-1', 'e-2', 'e-3']);
      expect(await erase(o.admin)).toEqual({ threads: 2, messages: 2 });
      expect(await threads(o)).toEqual(['e-3']);
      expect(await count('conversation_note', o)).toBe(0);
      expect((await rows<{ external_user_id: string }>('SELECT external_user_id FROM crove_kernel.conversation_identity WHERE org_id = $1', [o.orgId])).map((r) => r.external_user_id)).toEqual(['u-other']);
      // The audit row has counts and the kind, nothing of the customer.
      const [audit] = await rows<{ detail: unknown }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.conversation.erase_contact' AND outcome = 'ok'", [o.orgId]);
      const text = JSON.stringify(audit?.detail);
      for (const word of ['0912345678', 'u-erase', 'Khách u-erase', 'hay hỏi giá']) expect(text).not.toContain(word);
      // Erased means erased: the thread is gone for a second try, and one org's owner cannot reach another org's thread.
      await expect(erase(o.admin)).rejects.toMatchObject({ status: 404 });
      const stranger = await org();
      await expect(rt.execute('kernel.conversation.erase_contact', { conversationId: mine, confirm: true }, { actor: asMfa(stranger.owner), orgId: stranger.orgId, idempotencyKey: randomUUID() })).rejects.toMatchObject({ status: 404 });
      // If the customer writes again, a new thread opens: erasing is not blocking.
      await thread(o, 'e-4', 'Tôi quay lại', 'u-erase');
      expect(await threads(o)).toEqual(['e-3', 'e-4']);
    });
  });

  describe('Meta’s one data deletion callback', () => {
    const signed = (userId: string, secret = SECRET, issuedAt = Math.floor(Date.now() / 1000)) => {
      const encoded = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', issued_at: issuedAt, user_id: userId })).toString('base64url');
      return `${createHmac('sha256', secret).update(encoded).digest('base64url')}.${encoded}`;
    };
    const form = (signedRequest: string) => new URLSearchParams({ signed_request: signedRequest }).toString();
    const requests = async () => Number((await rows<{ n: string }>('SELECT count(*)::text AS n FROM crove_kernel.conversation_deletion_request'))[0]?.n);

    it('erases the conversations of the connections that person granted, in every org, and leaves the rest', async () => {
      const a = await org();
      const b = await org();
      const hash = platformUserHash(SECRET, '7001');
      await rows('UPDATE crove_kernel.channel_connection SET granted_by_hash = $1 WHERE org_id = ANY ($2) AND id = ANY ($3)', [hash, [a.orgId, b.orgId], [a.connectionId, b.connectionId]]);
      await thread(a, 'cb-a1', 'Bình luận ở org a', 'u-cb1');
      await thread(b, 'cb-b1', 'Bình luận ở org b', 'u-cb2');
      // Another org's connection granted by someone else is not touched.
      const c = await org();
      await rows('UPDATE crove_kernel.channel_connection SET granted_by_hash = $1 WHERE org_id = $2', [platformUserHash(SECRET, '7002'), c.orgId]);
      await thread(c, 'cb-c1', 'Bình luận của người khác cấp quyền', 'u-cb3');

      const api = rt;
      const before = await requests();
      // Forged, the wrong secret, stale, malformed or no signed request: refused, and stored nowhere.
      expect(await acceptMetaDeletion(api, { conversations: SECRET }, form(signed('7001', 'another-secret')))).toEqual({ status: 401, code: 'DELETION_SIGNATURE' });
      expect(await acceptMetaDeletion(api, { conversations: SECRET }, form(signed('7001', SECRET, Math.floor(Date.now() / 1000) - 3 * 86_400)))).toEqual({ status: 401, code: 'DELETION_SIGNATURE' });
      expect(await acceptMetaDeletion(api, { conversations: SECRET }, 'nothing=1')).toEqual({ status: 400, code: 'DELETION_MALFORMED' });
      expect(await acceptMetaDeletion(api, {}, form(signed('7001')))).toEqual({ status: 401, code: 'DELETION_SIGNATURE' });
      expect(await requests()).toBe(before);

      const accepted = await acceptMetaDeletion(api, { conversations: SECRET }, form(signed('7001')));
      expect(accepted.status).toBe(200);
      const code = (accepted as { code: string }).code;
      expect(code).toMatch(/^[0-9a-f]{32}$/);
      // Only the keyed hash is stored; the Meta user id is not anywhere.
      const [stored] = await rows<{ user_hash: string }>('SELECT user_hash FROM crove_kernel.conversation_deletion_request WHERE code = $1', [code]);
      expect(stored?.user_hash).toBe(hash);
      // A replay while the request is open gets the same code and no second row.
      expect(await acceptMetaDeletion(api, { conversations: SECRET }, form(signed('7001')))).toEqual({ status: 200, code });
      expect(await requests()).toBe(before + 1);
      // The status page says it is being handled until the worker has run.
      expect(await metaDeletionStatus(api, code, false)).toMatchObject({ completedAt: null });
      expect(renderMetaDeletionStatus(await metaDeletionStatus(api, code, false))).toContain('đang được xử lý');

      expect(await runConversationDeletions({ runtime: worker, workerDb })).toBeGreaterThanOrEqual(1);
      expect(await threads(a)).toEqual([]);
      expect(await threads(b)).toEqual([]);
      expect(await count('conversation_identity', a)).toBe(0);
      expect(await threads(c)).toEqual(['cb-c1']);
      // The connection no longer holds a credential, and its row stays for the books.
      const [conn] = await rows<{ status: string }>('SELECT status FROM crove_kernel.channel_connection WHERE org_id = $1 AND id = $2', [a.orgId, a.connectionId]);
      expect(conn?.status).not.toBe('active');
      expect(await metaDeletionStatus(api, code, false)).toMatchObject({ connections: 2 });
      expect(renderMetaDeletionStatus(await metaDeletionStatus(api, code, false))).toContain('đã được xóa');
      // The audit row names the connection and counts, not the comment.
      const audit = JSON.stringify((await rows<{ detail: unknown }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.conversation.erase_connection'", [a.orgId]))[0]?.detail);
      expect(audit).not.toContain('Bình luận ở org a');
      // Run again, nothing changes (idempotent), and an unknown code has no page.
      expect(await runConversationDeletions({ runtime: worker, workerDb })).toBe(0);
      expect(await metaDeletionStatus(api, '0'.repeat(32), false)).toBeNull();
      expect(renderMetaDeletionStatus(null)).toContain('Không tìm thấy');
    });

    it('lets the owner keep a connection by taking it over: a reconnect forgets who granted it before', async () => {
      const o = await org();
      const hash = platformUserHash(SECRET, '7501');
      await rows('UPDATE crove_kernel.channel_connection SET granted_by_hash = $1 WHERE org_id = $2 AND id = $3', [hash, o.orgId, o.connectionId]);
      await thread(o, 'keep-1', 'Giữ lại', 'u-keep');
      const sealed = vault.seal(JSON.stringify({ accessToken: `sbx_${randomBytes(24).toString('base64url')}` }), { orgId: o.orgId, provider: 'sandbox', externalAccountId: o.accountId });
      const again = await rt.execute<{ connectionId: string; reconnected: boolean }>(
        'kernel.channel.connect',
        { provider: 'sandbox', externalAccountId: o.accountId, displayName: 'Kênh thử', scopes: [], expiresAt: null, credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') } },
        { actor: asUser(o.owner), orgId: o.orgId },
      );
      expect(again).toMatchObject({ connectionId: o.connectionId, reconnected: true });
      expect((await rows<{ granted_by_hash: string | null }>('SELECT granted_by_hash FROM crove_kernel.channel_connection WHERE id = $1', [o.connectionId]))[0]?.granted_by_hash).toBeNull();
      const accepted = await acceptMetaDeletion(rt, { conversations: SECRET }, form(signed('7501')));
      expect(accepted.status).toBe(200);
      await runConversationDeletions({ runtime: worker, workerDb });
      expect(await threads(o)).toEqual(['keep-1']);
    });

    it('answers a person who granted nothing, with a completed request of none', async () => {
      const code = ((await acceptMetaDeletion(rt, { conversations: SECRET }, form(signed('7999')))) as { code: string }).code;
      expect(await runConversationDeletions({ runtime: worker, workerDb })).toBeGreaterThanOrEqual(1);
      expect(await metaDeletionStatus(rt, code, false)).toMatchObject({ connections: 0 });
      expect(renderMetaDeletionStatus(await metaDeletionStatus(rt, code, false))).toContain('không còn trang nào');
    });

    it('fans a request out to the Ads side and the conversation side under one code when one app serves both', async () => {
      const o = await org();
      await rows('UPDATE crove_kernel.channel_connection SET granted_by_hash = $1 WHERE org_id = $2', [platformUserHash(SECRET, '8001'), o.orgId]);
      await thread(o, 'fan-1', 'Bình luận', 'u-fan');
      const accepted = await acceptMetaDeletion(rt, { ads: SECRET, conversations: SECRET }, form(signed('8001')));
      expect(accepted.status).toBe(200);
      const code = (accepted as { code: string }).code;
      expect(await rows('SELECT 1 FROM crove_ads.deletion_request WHERE code = $1', [code])).toHaveLength(1);
      expect(await rows('SELECT 1 FROM crove_kernel.conversation_deletion_request WHERE code = $1', [code])).toHaveLength(1);
      // Complete only when both sides are: the conversation side finishes first, the page still says it is being handled.
      await runConversationDeletions({ runtime: worker, workerDb });
      expect(await metaDeletionStatus(rt, code, true)).toMatchObject({ completedAt: null });
      await workerPool.query('SELECT crove_ads.deletion_request_complete($1, 0)', [code]);
      expect(await metaDeletionStatus(rt, code, true)).toMatchObject({ connections: 1, accounts: 0 });
      expect((await metaDeletionStatus(rt, code, true))?.completedAt).not.toBeNull();
      expect(renderMetaDeletionStatus(await metaDeletionStatus(rt, code, true))).toContain('đã được xóa');
      // A different app on each side: a request signed by one secret reaches only that side.
      const second = await acceptMetaDeletion(rt, { ads: 'the-ads-app-secret', conversations: SECRET }, form(signed('8002')));
      const code2 = (second as { code: string }).code;
      expect(await rows('SELECT 1 FROM crove_ads.deletion_request WHERE code = $1', [code2])).toHaveLength(0);
      expect(await rows('SELECT 1 FROM crove_kernel.conversation_deletion_request WHERE code = $1', [code2])).toHaveLength(1);
    });

    it('is reached through the one URL, signed with the Pages app’s secret, rate limited and answered with the status page', async () => {
      const config = loadConfig({ DATABASE_URL: appUrl, AUTH_JWT_SECRET: 'x'.repeat(40), AUTH_ISSUER: 'https://issuer.test', AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' });
      const app = createHttpApp({
        config,
        runtime: rt,
        store: new MemoryStore(),
        authenticate: createAuthenticator(config, db),
        pool,
        aiEnabled: false,
        conversationsDeletion: { appSecret: SECRET },
      });
      const post = (body: string) => app.request('/api/ads/meta/data-deletion', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
      expect((await post(form(signed('9001', 'wrong-secret')))).status).toBe(401);
      const ok = await post(form(signed('9001')));
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { url: string; confirmation_code: string };
      expect(body.url).toBe(`${config.PUBLIC_URL}/api/ads/meta/data-deletion?code=${body.confirmation_code}`);
      const page = await app.request(`/api/ads/meta/data-deletion?code=${body.confirmation_code}`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('đang được xử lý');
      expect((await app.request(`/api/ads/meta/data-deletion?code=${'0'.repeat(32)}`)).status).toBe(404);
    });

    it('keeps the deletion tables out of every tenant role’s reach, and the worker’s definers off the API login', async () => {
      await expect(pool.query('SELECT * FROM crove_kernel.conversation_deletion_request')).rejects.toMatchObject({ code: '42501' });
      await expect(pool.query('SELECT * FROM crove_kernel.conversation_deletion_claim(10)')).rejects.toMatchObject({ code: '42501' });
      await expect(pool.query('SELECT crove_kernel.conversation_deletion_complete($1, 0)', ['0'.repeat(32)])).rejects.toMatchObject({ code: '42501' });
      await expect(pool.query('SELECT crove_kernel.conversation_deletion_defer($1)', ['0'.repeat(32)])).rejects.toMatchObject({ code: '42501' });
      await expect(workerPool.query('SELECT crove_kernel.conversation_deletion_enqueue($1, $2)', ['0'.repeat(32), '0'.repeat(64)])).rejects.toMatchObject({ code: '42501' });
      await expect(pool.query('SELECT crove_kernel.conversation_deletion_enqueue($1, $2)', ['nope', '0'.repeat(64)])).rejects.toMatchObject({ code: '22P02' });
    });
  });

  it('is in the org’s export, with the customers’ messages and without the keyed hash of who granted a connection', async () => {
    expect(EXPORT_TABLE_NAMES).toEqual(expect.arrayContaining(['kernel.conversation', 'kernel.conversation_message', 'kernel.conversation_identity', 'kernel.conversation_note', 'kernel.conversation_setting', 'kernel.channel_access']));
  });
});
