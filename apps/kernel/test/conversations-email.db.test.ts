// SPDX-License-Identifier: AGPL-3.0-only
// Customer email as conversations in Hộp thư on PostgreSQL 17 (#2439, plan docs/plan/conversations.md section 6.7), driven by real MIME messages
// through the real parser: a mail to the org's conversation address (`<token>+hopthu@domain`) opens a New email conversation and never reaches
// the invoice reader; a customer's reply joins the thread by the Message-IDs it names and by nothing else (a forged id, a matching subject
// open a thread of their own); automated mail and mail from the deployment's own domain open nothing; a member's reply is a mail of the kernel
// pipeline, threaded, whose outcome settles the message; the thread is read as a private message; no mail text reaches an audit row.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import type { ExtractClient } from '@crove/extract-contract';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { ConversationDetail, ConversationListed, OrgDetail } from '@crove/kernel-contract';
import { Runtime, inboundKey, newInboundBlobId, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { processInboundEmail } from '../src/inbound.ts';
import { inProcessExtract } from './extract-service.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const DOMAIN = 'in.test';
const suite = ADMIN ? describe : describe.skip;
const SYSTEM = { type: 'system' as const, component: 'conversations-email-test' };
// Text no audit row, event or log may hold.
const SECRET = 'khách hàng Nguyễn Văn Mẫu số 0912345678';

class MemoryStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array) {
    this.blobs.set(key, bytes);
    return `content:${sha256Hex(bytes)}`;
  }
  async get(key: string) {
    const bytes = this.blobs.get(key);
    if (!bytes) throw new Error(`missing ${key}`);
    return bytes;
  }
  async delete(key: string) {
    this.blobs.delete(key);
  }
}

interface MailParts {
  from?: string;
  to: string;
  subject?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  body?: string;
  html?: string;
  headers?: Record<string, string>;
  date?: string;
}
// A raw message as a customer's mail server would deliver it.
function raw(parts: MailParts): Uint8Array {
  const lines = [
    `From: ${parts.from ?? 'Khách Mẫu <khach@mau.test>'}`,
    `To: ${parts.to}`,
    `Subject: ${parts.subject ?? 'Hỏi giá gạo'}`,
    `Message-ID: ${parts.messageId ?? `<${randomUUID()}@mau.test>`}`,
    `Date: ${parts.date ?? new Date().toUTCString()}`,
    ...(parts.inReplyTo ? [`In-Reply-To: ${parts.inReplyTo}`] : []),
    ...(parts.references ? [`References: ${parts.references}`] : []),
    ...Object.entries(parts.headers ?? {}).map(([k, v]) => `${k}: ${v}`),
    'MIME-Version: 1.0',
  ];
  if (parts.html !== undefined) {
    lines.push('Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', parts.html);
  } else {
    lines.push('Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', parts.body ?? 'Cho tôi hỏi giá gạo ST25.');
  }
  return new TextEncoder().encode(lines.join('\r\n'));
}

suite('customer email in the Inbox on PostgreSQL (#2439)', () => {
  const dbName = `crove_test_conversations_email_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let worker: Runtime;
  let extract: ExtractClient;
  const store = new MemoryStore();
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
  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@conversations.test`, name: null });

  interface Org {
    orgId: string;
    owner: string;
    member: string;
    address: string;
    document: string;
  }
  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Công ty ${randomUUID().slice(0, 6)}`);
    const member = await person('member');
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [orgId, member]));
    const detail = await rt.query<OrgDetail>('kernel.org.get', {}, { actor: asUser(owner), orgId });
    return { orgId, owner, member, address: detail.conversationAddress as string, document: detail.inboundAddress as string };
  }
  const exec = <O>(o: Org, user: string, name: string, input: unknown) => rt.execute<O>(name, input, { actor: asUser(user), orgId: o.orgId });
  const query = <O>(o: Org, user: string, name: string, input: unknown) => rt.query<O>(name, input, { actor: asUser(user), orgId: o.orgId });
  const sys = <O>(o: Org, name: string, input: unknown) => worker.execute<O>(name, input, { actor: SYSTEM, orgId: o.orgId });

  // Delivers a raw message to the address, as the mail worker would.
  async function deliver(to: string, message: Uint8Array) {
    const blobId = newInboundBlobId();
    await store.put(inboundKey(blobId), message);
    return processInboundEmail({ runtime: worker, store, domain: DOMAIN, extract }, { blobId, sha256: sha256Hex(message), sizeBytes: message.byteLength, recipient: to });
  }
  const threads = (o: Org) =>
    rows<{ id: string; status: string; subject: string | null; last_seq: number; external_thread_id: string; kind: string }>(
      'SELECT id, status, subject, last_seq, external_thread_id, kind FROM crove_kernel.conversation WHERE org_id = $1 ORDER BY created_at, id',
      [o.orgId],
    );
  const messagesOf = (conversationId: string) =>
    rows<{ seq: number; direction: string; external_message_id: string | null; body: string; send_state: string | null; send_error_code: string | null; email_refs: string[]; tainted: boolean }>(
      'SELECT seq, direction, external_message_id, body, send_state, send_error_code, email_refs, tainted FROM crove_kernel.conversation_message WHERE conversation_id = $1 ORDER BY seq',
      [conversationId],
    );
  const detail = (o: Org, user: string, id: string) => query<ConversationDetail>(o, user, 'kernel.conversation.get', { conversationId: id });

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
    const login = (user: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = user;
      url.password = password;
      return url.toString();
    };
    pool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 4 });
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 2 });
    db = createDb(pool);
    const registered = { commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: DOMAIN })] };
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register(registered);
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(registered);
    extract = inProcessExtract();
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

  it('gives the org a conversation address on its token, with the tag, to the owner and admins only', async () => {
    const o = await org();
    expect(o.address).toBe(o.document.replace('@', '+hopthu@'));
    const seen = await query<OrgDetail>(o, o.member, 'kernel.org.get', {});
    expect(seen.conversationAddress).toBeNull();
  });

  it('opens a New email conversation from a mail to the conversation address, made once, and a redelivery is a duplicate', async () => {
    const o = await org();
    const message = raw({ to: o.address, subject: 'Hỏi giá gạo ST25', messageId: '<first@mau.test>', body: SECRET });
    expect(await deliver(o.address, message)).toMatchObject({ conversation: 'stored' });
    const [thread] = await threads(o);
    expect(thread).toMatchObject({ kind: 'email', status: 'new', subject: 'Hỏi giá gạo ST25', external_thread_id: '<first@mau.test>', last_seq: 1 });
    const [first] = await messagesOf(thread?.id as string);
    expect(first).toMatchObject({ direction: 'in', external_message_id: '<first@mau.test>', tainted: true, email_refs: [] });
    expect(first?.body).toContain('0912345678');
    // The org's email connection is one, with no credential.
    const connections = await rows<{ provider: string; display_name: string }>("SELECT provider, display_name FROM crove_kernel.channel_connection WHERE org_id = $1 AND provider = 'email'", [o.orgId]);
    expect(connections).toEqual([{ provider: 'email', display_name: 'Email' }]);
    // The same Message-ID again changes nothing.
    expect(await deliver(o.address, message)).toMatchObject({ conversation: 'duplicate' });
    expect((await threads(o)).length).toBe(1);
    expect((await messagesOf(thread?.id as string)).length).toBe(1);
    // It never reached the invoice reader.
    expect(await rows('SELECT 1 FROM crove_kernel.inbound_message WHERE org_id = $1', [o.orgId])).toEqual([]);
  });

  it('puts a mail to the document address with no tag where it went before, not in the Inbox', async () => {
    const o = await org();
    await deliver(o.document, raw({ to: o.document, subject: 'Hoá đơn tháng 11', body: 'Gửi anh chị hoá đơn.' }));
    expect(await threads(o)).toEqual([]);
    expect((await rows('SELECT 1 FROM crove_kernel.inbound_message WHERE org_id = $1', [o.orgId])).length).toBe(1);
  });

  it('joins a reply to its thread by In-Reply-To or by References, and reopens a resolved thread as New', async () => {
    const o = await org();
    await deliver(o.address, raw({ to: o.address, messageId: '<a1@mau.test>' }));
    const [thread] = await threads(o);
    await deliver(o.address, raw({ to: o.address, messageId: '<a2@mau.test>', inReplyTo: '<a1@mau.test>', subject: 'Re: Hỏi giá gạo', body: 'Còn hàng không?' }));
    await deliver(o.address, raw({ to: o.address, messageId: '<a3@mau.test>', references: '<zzz@elsewhere.test> <a2@mau.test>', body: 'Cảm ơn.' }));
    expect((await threads(o)).length).toBe(1);
    const stored = await messagesOf(thread?.id as string);
    expect(stored.map((m) => m.external_message_id)).toEqual(['<a1@mau.test>', '<a2@mau.test>', '<a3@mau.test>']);
    expect(stored[1]?.email_refs).toEqual(['<a1@mau.test>']);
    expect(stored[2]?.email_refs).toEqual(['<zzz@elsewhere.test>', '<a2@mau.test>']);
    await exec(o, o.owner, 'kernel.conversation.resolve', { conversationId: thread?.id });
    expect((await threads(o))[0]?.status).toBe('resolved');
    await deliver(o.address, raw({ to: o.address, messageId: '<a4@mau.test>', inReplyTo: '<a3@mau.test>', body: 'Một câu hỏi nữa.', date: new Date(Date.now() + 60_000).toUTCString() }));
    expect((await threads(o))[0]).toMatchObject({ status: 'new', last_seq: 4 });
  });

  it('never joins a thread by its subject, and never by an id that is not this org\'s: a forged In-Reply-To opens a thread of its own', async () => {
    const o = await org();
    const other = await org();
    await deliver(other.address, raw({ to: other.address, messageId: '<theirs@mau.test>', subject: 'Báo giá' }));
    await deliver(o.address, raw({ to: o.address, messageId: '<mine@mau.test>', subject: 'Báo giá' }));
    // Same subject, no header link: a new thread.
    await deliver(o.address, raw({ to: o.address, messageId: '<mine2@mau.test>', subject: 'Báo giá' }));
    expect((await threads(o)).length).toBe(2);
    // An id of another org's conversation: a new thread here, and nothing is added to the other org's.
    await deliver(o.address, raw({ to: o.address, messageId: '<forged@mau.test>', inReplyTo: '<theirs@mau.test>', subject: 'Re: Báo giá', body: 'Tôi trả lời thư của người khác.' }));
    expect((await threads(o)).length).toBe(3);
    const theirs = await threads(other);
    expect(theirs.length).toBe(1);
    expect(theirs[0]?.last_seq).toBe(1);
  });

  it('opens nothing for automated mail, bulk mail, or mail from the deployment\'s own domain, and shows HTML as safe text', async () => {
    const o = await org();
    for (const headers of [{ 'Auto-Submitted': 'auto-replied' }, { Precedence: 'bulk' }, { 'List-Unsubscribe': '<mailto:x@y.test>' }]) {
      expect(await deliver(o.address, raw({ to: o.address, headers }))).toMatchObject({ conversation: 'ignored', reason: 'automated' });
    }
    expect(await deliver(o.address, raw({ to: o.address, from: `noreply@${DOMAIN}` }))).toMatchObject({ conversation: 'ignored', reason: 'own_address' });
    expect(await threads(o)).toEqual([]);
    // HTML with a script, a remote image and a tracking pixel is reduced to its text; nothing remote is loaded or kept.
    await deliver(
      o.address,
      raw({
        to: o.address,
        messageId: '<html@mau.test>',
        html: '<html><body><p>Xin chào, tôi cần <b>10 tấn</b> gạo.</p><script>fetch("https://evil.test/x")</script><img src="https://track.test/p.gif" width="1" height="1"><img src="https://evil.test/big.png"></body></html>',
      }),
    );
    const [thread] = await threads(o);
    const [message] = await messagesOf(thread?.id as string);
    expect(message?.body).toContain('Xin chào, tôi cần 10 tấn gạo.');
    expect(message?.body).not.toMatch(/evil\.test|track\.test|<|script|fetch/);
  });

  it('is read as a private message: the owner reads it, a member with no permission does not, and the contact is offered by the sender\'s address', async () => {
    const o = await org();
    await deliver(o.address, raw({ to: o.address, from: 'Chị Hoa <hoa@khach.test>', messageId: '<priv@mau.test>' }));
    const [thread] = await threads(o);
    expect((await query<ConversationListed>(o, o.owner, 'kernel.conversation.list', {})).conversations.map((c) => c.id)).toEqual([thread?.id]);
    expect((await query<ConversationListed>(o, o.member, 'kernel.conversation.list', {})).conversations).toEqual([]);
    const seen = await detail(o, o.owner, thread?.id as string);
    expect(seen.conversation).toMatchObject({ kind: 'email', subject: 'Hỏi giá gạo', channel: { provider: 'email' } });
    expect(seen.reply).toEqual({ allowed: true, reason: null });
    expect(seen.conversation.contact.displayName).toBe('Chị Hoa');
    // A contact that carries the sender's address (any case) is the first candidate, by the deterministic key.
    await admin((c) => c.query("INSERT INTO crove_kernel.party (org_id, kind, name, email) VALUES ($1, 'organization', 'Cửa hàng Hoa', 'HOA@khach.test')", [o.orgId]));
    const matched = await query<{ email: Array<{ name: string }> }>(o, o.owner, 'kernel.conversation.contact_candidates', { conversationId: thread?.id });
    expect(matched.email.map((c) => c.name)).toEqual(['Cửa hàng Hoa']);
  });

  it('answers by a mail of the kernel pipeline: threaded, under the org\'s name, its outcome settling the message, and the customer\'s next mail joins the thread', async () => {
    const o = await org();
    await deliver(o.address, raw({ to: o.address, messageId: '<q1@mau.test>', references: '<q0@mau.test>', subject: 'Hỏi giá gạo', body: 'Giá gạo ST25 bao nhiêu?' }));
    const [thread] = await threads(o);
    const reply = await exec<{ messageId: string; seq: number }>(o, o.owner, 'kernel.conversation.reply', { conversationId: thread?.id, lastSeenSeq: 1, body: 'Dạ giá 25.000 đồng một ký ạ.' });
    // The reply is a queued mail of the pipeline, to the customer, with the threading ids, and no platform call was asked for.
    const [mail] = await rows<{ id: string; status: string; to_address: string; template_key: string; subject: string; payload: Record<string, unknown>; message_id_header: string; source: string }>(
      'SELECT id, status, to_address, template_key, subject, payload, message_id_header, source FROM crove_kernel.mail_message WHERE org_id = $1 AND source_id = $2',
      [o.orgId, reply.messageId],
    );
    expect(mail).toMatchObject({ status: 'queued', to_address: 'khach@mau.test', template_key: 'kernel.conversation_reply', subject: 'Re: Hỏi giá gạo', source: 'kernel.conversation.reply' });
    expect(mail?.payload).toMatchObject({ text: 'Dạ giá 25.000 đồng một ký ạ.', inReplyTo: '<q1@mau.test>', references: ['<q0@mau.test>', '<q1@mau.test>'] });
    expect(await rows("SELECT 1 FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'kernel.conversation.reply_queued'", [o.orgId])).toEqual([]);
    const [out] = (await messagesOf(thread?.id as string)).slice(-1);
    expect(out).toMatchObject({ direction: 'out', send_state: 'queued', external_message_id: mail?.message_id_header, tainted: false });
    expect((await threads(o))[0]?.status).toBe('pending');
    // The queue sends it once and records the outcome: the message is sent.
    const begun = await sys<{ action: string; attempt: number }>(o, 'kernel.mail.queue.begin', { messageId: mail?.id, provider: 'smtp', safety: 'never' });
    expect(begun.action).toBe('send');
    await sys(o, 'kernel.mail.queue.record', { messageId: mail?.id, attempt: begun.attempt, outcome: 'sent' });
    expect((await messagesOf(thread?.id as string)).slice(-1)[0]?.send_state).toBe('sent');
    // A hard bounce afterwards fails it.
    await sys(o, 'kernel.mail.event.record', { messageId: mail?.id, provider: 'smtp', providerEventId: `dsn:${randomUUID()}`, kind: 'bounce_hard', occurredAt: new Date().toISOString(), detail: {} });
    expect((await messagesOf(thread?.id as string)).slice(-1)[0]?.send_state).toBe('failed');
    // The customer answers the org's mail: its Message-ID is the one the reply carries, so the thread is found.
    await deliver(o.address, raw({ to: o.address, messageId: '<q2@mau.test>', inReplyTo: mail?.message_id_header, subject: 'Re: Hỏi giá gạo', body: 'Cảm ơn, tôi lấy 10 ký.' }));
    expect((await threads(o)).length).toBe(1);
    expect((await threads(o))[0]).toMatchObject({ status: 'new', last_seq: 3 });
  });

  it('settles a failed or unknown send on the message, and a stopped address fails it at once', async () => {
    const o = await org();
    await deliver(o.address, raw({ to: o.address, messageId: '<s1@mau.test>', from: 'bounce@mau.test' }));
    const [thread] = await threads(o);
    const send = async (seen: number) => {
      const reply = await exec<{ messageId: string }>(o, o.owner, 'kernel.conversation.reply', { conversationId: thread?.id, lastSeenSeq: seen, body: 'Dạ.' });
      const [mail] = await rows<{ id: string }>('SELECT id FROM crove_kernel.mail_message WHERE org_id = $1 AND source_id = $2', [o.orgId, reply.messageId]);
      return { reply, mailId: mail?.id as string };
    };
    const one = await send(1);
    const begun = await sys<{ attempt: number }>(o, 'kernel.mail.queue.begin', { messageId: one.mailId, provider: 'smtp', safety: 'never' });
    await sys(o, 'kernel.mail.queue.record', { messageId: one.mailId, attempt: begun.attempt, outcome: 'ambiguous', errorCode: 'SEND_TIMEOUT' });
    expect((await messagesOf(thread?.id as string)).slice(-1)[0]).toMatchObject({ send_state: 'unknown' });
    // A hard bounce stops mail to the address: the next reply is refused by the suppression list when the queue begins it.
    await sys(o, 'kernel.mail.event.record', { messageId: one.mailId, provider: 'smtp', providerEventId: `dsn:${randomUUID()}`, kind: 'bounce_hard', occurredAt: new Date().toISOString(), detail: {} });
    const two = await send(2);
    expect((await messagesOf(thread?.id as string)).slice(-1)[0]).toMatchObject({ send_state: 'failed', send_error_code: 'SUPPRESSED' });
    expect(two.mailId).toBeTruthy();
  });

  it('is deleted like any conversation: when the customer is erased (the reply mail loses its address), by the retention purge, and with the org', async () => {
    const o = await org();
    const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });
    await deliver(o.address, raw({ to: o.address, messageId: '<e1@mau.test>', from: 'Khách Xoá <xoa@khach.test>' }));
    await deliver(o.address, raw({ to: o.address, messageId: '<e2@mau.test>', from: 'Khách Giữ <giu@khach.test>' }));
    const [erased, kept] = await threads(o);
    await exec(o, o.owner, 'kernel.conversation.reply', { conversationId: erased?.id, lastSeenSeq: 1, body: 'Dạ.' });
    expect(await rows("SELECT to_address FROM crove_kernel.mail_message WHERE org_id = $1 AND source = 'kernel.conversation.reply'", [o.orgId])).toEqual([{ to_address: 'xoa@khach.test' }]);
    await rt.execute('kernel.conversation.erase_contact', { conversationId: erased?.id, confirm: true }, { actor: asMfa(o.owner), orgId: o.orgId });
    expect((await threads(o)).map((t) => t.id)).toEqual([kept?.id]);
    // The mail the org sent that customer keeps no address; the other customer's thread is untouched.
    expect(await rows("SELECT to_address FROM crove_kernel.mail_message WHERE org_id = $1 AND source = 'kernel.conversation.reply'", [o.orgId])).toEqual([{ to_address: null }]);
    expect((await rows<{ n: string }>('SELECT count(*)::text AS n FROM crove_kernel.conversation_message WHERE org_id = $1', [o.orgId]))[0]?.n).toBe('1');
    // The retention purge deletes an old email thread by its last message.
    await exec(o, o.owner, 'kernel.conversation.retention_set', { retentionMonths: 6 });
    await admin((c) => c.query("UPDATE crove_kernel.conversation SET last_message_at = now() - interval '8 months' WHERE org_id = $1", [o.orgId]));
    const purged = await sys<{ threads: number }>(o, 'kernel.conversation.purge_expired', { limit: 100 });
    expect(purged.threads).toBe(1);
    expect(await threads(o)).toEqual([]);
    // Mail that arrives again for the erased customer within the tombstone's days and dated before the erasure is not stored.
    expect(await deliver(o.address, raw({ to: o.address, messageId: '<e3@mau.test>', from: 'Khách Xoá <xoa@khach.test>', date: new Date(Date.now() - 3_600_000).toUTCString() }))).toMatchObject({ conversation: 'ignored' });
    expect(await threads(o)).toEqual([]);
  });

  it('leaves no mail text, subject or address in an audit row or an event', async () => {
    const o = await org();
    await deliver(o.address, raw({ to: o.address, messageId: '<audit@mau.test>', from: 'Bí Mật <bimat@khach.test>', subject: 'Tiêu đề bí mật 123', body: SECRET }));
    const [thread] = await threads(o);
    await exec(o, o.owner, 'kernel.conversation.reply', { conversationId: thread?.id, lastSeenSeq: 1, body: 'Trả lời bí mật 456' });
    const audits = JSON.stringify(await rows('SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1', [o.orgId]));
    const events = JSON.stringify(await rows('SELECT payload FROM crove_kernel.outbox_event WHERE org_id = $1', [o.orgId]));
    for (const text of [audits, events]) {
      expect(text).not.toMatch(/bí mật|0912345678|bimat@khach|Nguyễn Văn Mẫu/i);
    }
  });
});
