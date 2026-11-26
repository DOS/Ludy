// SPDX-License-Identifier: AGPL-3.0-only
// Personal-data lookup and per-customer erasure for conversations on PostgreSQL 17 (#3669):
// - kernel.conversation.personal_data_find (R1, owners and admins) searches active non-orphan identities directly
//   (email address or WhatsApp wa_id via ludy_kernel.phone_key) or via a linked party (identity.party_id or conversation.party_id),
//   never scans message body text, never matches non-WhatsApp opaque numeric IDs or BSUIDs directly by phone, bounds results at 50
//   with accurate non-double-counted counts, and audits without leaking PII.
// - Passing the returned eraseTarget to kernel.conversation.erase_contact enforces R3 step-up (aal2), erases the customer,
//   and leaves ludy_kernel.conversation_identity.display_name / external_user_id as keep_record under kernel.personal_data.erase.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { PERSONAL_DATA_COLUMNS, createOrg, kernelCommands, kernelQueries, upsertIdentity, type PersonalDataColumn } from '@ludy/kernel';
import type { ConversationErased, ConversationPersonalDataResult, PersonalDataErasure } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('conversation personal-data lookup and erasure (#3669)', () => {
  const dbName = `ludy_test_conv_pd_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;

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

  type OrgCtx = { orgId: string; owner: string; admin: string; member: string; viewer: string };
  async function makeOrg(): Promise<OrgCtx> {
    const user = async (tag: string) =>
      (await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${tag}-${randomUUID().slice(0, 8)}@conv-pd.test`, name: null })) as string;
    const [owner, adm, member, viewer] = [await user('owner'), await user('admin'), await user('member'), await user('viewer')];
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    await admin(async (c) => {
      await c.query(
        "INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')",
        [orgId, adm, member, viewer],
      );
    });
    return { orgId, owner, admin: adm, member, viewer };
  }

  async function seedChannel(orgId: string, connectedBy: string, provider: string, displayName: string): Promise<string> {
    const [ch] = await rows<{ id: string }>(
      `INSERT INTO ludy_kernel.channel_connection (org_id, provider, external_account_id, display_name, status, connected_by)
       VALUES ($1, $2, $3, $4, 'active', $5) RETURNING id`,
      [orgId, provider, `${provider}-${randomUUID().slice(0, 8)}`, displayName, connectedBy],
    );
    return (ch as { id: string }).id;
  }

  async function seedParty(orgId: string, name: string, email: string | null, phone: string | null): Promise<string> {
    const [p] = await rows<{ id: string }>(
      `INSERT INTO ludy_kernel.party (org_id, kind, name, email, phone) VALUES ($1, 'person', $2, $3, $4) RETURNING id`,
      [orgId, name, email, phone],
    );
    return (p as { id: string }).id;
  }

  async function seedIdentity(
    orgId: string,
    provider: string,
    externalUserId: string,
    displayName: string | null,
    opts?: { partyId?: string | null; erased?: boolean },
  ): Promise<string> {
    const [idRow] = await rows<{ id: string }>(
      `INSERT INTO ludy_kernel.conversation_identity (org_id, provider, external_user_id, display_name, party_id, erased_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [orgId, provider, externalUserId, displayName, opts?.partyId ?? null, opts?.erased ? new Date().toISOString() : null],
    );
    return (idRow as { id: string }).id;
  }

  async function seedConversation(
    orgId: string,
    channelId: string,
    kind: 'comment_thread' | 'direct' | 'email',
    identityId: string | null,
    opts?: { partyId?: string | null; lastMessageAt?: Date; externalThreadId?: string },
  ): Promise<string> {
    const at = (opts?.lastMessageAt ?? new Date()).toISOString();
    const [conv] = await rows<{ id: string }>(
      `INSERT INTO ludy_kernel.conversation (org_id, channel_connection_id, kind, external_thread_id, identity_id, party_id, status, last_seq, last_message_at, last_inbound_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'new', 1, $7, $7) RETURNING id`,
      [orgId, channelId, kind, opts?.externalThreadId ?? `thread-${randomUUID().slice(0, 10)}`, identityId, opts?.partyId ?? null, at],
    );
    return (conv as { id: string }).id;
  }

  async function seedMessage(
    orgId: string,
    convId: string,
    channelId: string,
    kind: 'comment_thread' | 'direct' | 'email',
    seq: number,
    direction: 'in' | 'out',
    body: string,
    opts?: { authorIdentityId?: string | null; authorUserId?: string | null; sentAt?: Date },
  ): Promise<string> {
    const at = (opts?.sentAt ?? new Date()).toISOString();
    const [msg] = await rows<{ id: string }>(
      `INSERT INTO ludy_kernel.conversation_message
         (org_id, conversation_id, channel_connection_id, kind, seq, direction, external_message_id, sent_at, author_kind, author_user_id, author_identity_id, body, send_state, tainted)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
      [
        orgId,
        convId,
        channelId,
        kind,
        seq,
        direction,
        `msg-${randomUUID().slice(0, 10)}`,
        at,
        direction === 'in' ? 'contact' : 'member',
        direction === 'out' ? opts?.authorUserId ?? null : null,
        direction === 'in' ? opts?.authorIdentityId ?? null : null,
        body,
        direction === 'out' ? 'sent' : null,
        direction === 'in',
      ],
    );
    return (msg as { id: string }).id;
  }

  async function seedNote(orgId: string, convId: string, authorUserId: string, body: string): Promise<void> {
    await rows(
      `INSERT INTO ludy_kernel.conversation_note (org_id, conversation_id, author_user_id, body) VALUES ($1, $2, $3, $4)`,
      [orgId, convId, authorUserId, body],
    );
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
    const app = new URL(adminUrl);
    app.username = 'ludy_app';
    app.password = 'test-app-pw';
    pool = createPool({ connectionString: app.toString(), max: 4 });
    db = createDb(pool);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' }).register({
      commands: [...kernelCommands],
      queries: [...kernelQueries({ inboundDomain: null })],
    });
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('enforces owner/admin authorization, probe validation, cross-org isolation, and zero-PII audit logs', async () => {
    const orgA = await makeOrg();
    const orgB = await makeOrg();
    const chA = await seedChannel(orgA.orgId, orgA.owner, 'email', 'Email');
    const chB = await seedChannel(orgB.orgId, orgB.owner, 'email', 'Email');
    const idA = await seedIdentity(orgA.orgId, 'email', 'shared@example.test', 'Khách A');
    const idB = await seedIdentity(orgB.orgId, 'email', 'shared@example.test', 'Khách B');
    const convA = await seedConversation(orgA.orgId, chA, 'email', idA);
    const convB = await seedConversation(orgB.orgId, chB, 'email', idB);
    await seedMessage(orgA.orgId, convA, chA, 'email', 1, 'in', 'Xin chào A', { authorIdentityId: idA });
    await seedMessage(orgB.orgId, convB, chB, 'email', 1, 'in', 'Xin chào B', { authorIdentityId: idB });

    // Members, viewers, and non-user actors are refused.
    for (const actor of [asUser(orgA.member), asUser(orgA.viewer), { type: 'system' as const }]) {
      await expect(
        rt.execute('kernel.conversation.personal_data_find', { value: 'shared@example.test' }, { actor, orgId: orgA.orgId }),
      ).rejects.toMatchObject({ status: 403 });
    }

    // Invalid value fails with PERSONAL_DATA_QUERY; unmatched tax code digits return 0 items cleanly.
    await expect(
      rt.execute('kernel.conversation.personal_data_find', { value: 'not-valid-probe' }, { actor: asUser(orgA.owner), orgId: orgA.orgId }),
    ).rejects.toMatchObject({ code: 'PERSONAL_DATA_QUERY', status: 422 });
    const taxRes = await rt.execute<ConversationPersonalDataResult>(
      'kernel.conversation.personal_data_find',
      { value: '0101234564' },
      { actor: asUser(orgA.admin), orgId: orgA.orgId },
    );
    expect(taxRes).toEqual({ kind: 'digits', items: [], truncated: false });

    // Owner and admin both search Org A without seeing Org B.
    const ownerFound = await rt.execute<ConversationPersonalDataResult>(
      'kernel.conversation.personal_data_find',
      { value: '  SHARED@Example.TEST ' },
      { actor: asUser(orgA.owner), orgId: orgA.orgId },
    );
    expect(ownerFound.items).toHaveLength(1);
    expect(ownerFound.items[0]?.identityId).toBe(idA);
    expect(ownerFound.items[0]?.address).toBe('shared@example.test');
    expect(ownerFound.truncated).toBe(false);

    const adminFound = await rt.execute<ConversationPersonalDataResult>(
      'kernel.conversation.personal_data_find',
      { value: 'shared@example.test' },
      { actor: asUser(orgA.admin), orgId: orgA.orgId },
    );
    expect(adminFound.items).toHaveLength(1);
    expect(adminFound.items[0]?.identityId).toBe(idA);

    // Audit row records probe kind, match count, and truncated flag only (zero PII).
    const audits = await rows<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.conversation.personal_data_find' AND outcome = 'ok' ORDER BY id DESC`,
      [orgA.orgId],
    );
    expect(audits.length).toBeGreaterThanOrEqual(2);
    for (const row of audits) {
      const text = JSON.stringify(row.detail);
      expect(text).not.toContain('shared@example.test');
      expect(text).not.toContain('Khách A');
      expect(text).not.toContain('0101234564');
    }
    expect(audits[0]?.detail).toEqual({ kind: 'email', matches: 1, truncated: false });
  });

  it('matches WhatsApp phone_key and linked contacts accurately, avoids non-WhatsApp direct phone matches and message bodies, and computes non-double-counted counts', async () => {
    const o = await makeOrg();
    const waCh = await seedChannel(o.orgId, o.owner, 'whatsapp', 'WhatsApp Shop');
    const zaloCh = await seedChannel(o.orgId, o.owner, 'zalo_oa', 'Zalo Cửa Hàng');
    const fbCh = await seedChannel(o.orgId, o.owner, 'facebook_page', 'Trang FB Chính');
    const tgCh = await seedChannel(o.orgId, o.owner, 'telegram', 'Telegram Bot');

    // Direct WhatsApp match using wa_id 84901234567 with 1 owned thread (3 messages including reply, 1 note) + 1 reply in another customer's comment thread.
    const waId = await seedIdentity(o.orgId, 'whatsapp', '84901234567', 'Chị Hoa WhatsApp');
    const waConv = await seedConversation(o.orgId, waCh, 'direct', waId, { lastMessageAt: new Date('2026-11-25T10:00:00Z') });
    await seedMessage(o.orgId, waConv, waCh, 'direct', 1, 'in', 'Tin 1 của Hoa', { authorIdentityId: waId });
    await seedMessage(o.orgId, waConv, waCh, 'direct', 2, 'in', 'Tin 2 của Hoa', { authorIdentityId: waId });
    await seedMessage(o.orgId, waConv, waCh, 'direct', 3, 'out', 'Shop trả lời Hoa', { authorUserId: o.owner });
    await seedNote(o.orgId, waConv, o.owner, 'Ghi chú nội bộ 1');

    // Other customer's FB comment thread where waId also left a comment (should add +1 to waId.messages without double-counting waConv).
    const otherFbId = await seedIdentity(o.orgId, 'facebook_page', 'fb-other-1', 'Khách Khác');
    const otherFbConv = await seedConversation(o.orgId, fbCh, 'comment_thread', otherFbId);
    await seedMessage(o.orgId, otherFbConv, fbCh, 'comment_thread', 1, 'in', 'Khách khác hỏi bài', { authorIdentityId: otherFbId });
    await seedMessage(o.orgId, otherFbConv, fbCh, 'comment_thread', 2, 'in', 'Hoa bình luận ké', { authorIdentityId: waId });

    // Non-WhatsApp channels carrying digits in external_user_id must NEVER match directly by phone!
    const zaloUnlinked = await seedIdentity(o.orgId, 'zalo_oa', '0901234567', 'Zalo Số Trùng ID');
    const zaloUnlinkedConv = await seedConversation(o.orgId, zaloCh, 'direct', zaloUnlinked);
    await seedMessage(o.orgId, zaloUnlinkedConv, zaloCh, 'direct', 1, 'in', 'Số của tôi 0901234567', { authorIdentityId: zaloUnlinked });

    const tgUnlinked = await seedIdentity(o.orgId, 'telegram', '84901234567', 'Telegram Số Trùng');
    const tgUnlinkedConv = await seedConversation(o.orgId, tgCh, 'direct', tgUnlinked);
    await seedMessage(o.orgId, tgUnlinkedConv, tgCh, 'direct', 1, 'in', '0901234567 trong nội dung', { authorIdentityId: tgUnlinked });

    // WhatsApp BSUID (non-digit external_user_id) must NEVER match by phone directly.
    const waBsuid = await seedIdentity(o.orgId, 'whatsapp', 'US.84901234567', 'BSUID User');
    const waBsuidConv = await seedConversation(o.orgId, waCh, 'direct', waBsuid);
    await seedMessage(o.orgId, waBsuidConv, waCh, 'direct', 1, 'in', 'Tin BSUID', { authorIdentityId: waBsuid });

    // Linked-party Zalo customer (via conversation.party_id) with 2 owned threads across Zalo + FB comments -> inComments: true.
    const partyPhone = await seedParty(o.orgId, 'Công ty Hoa Mai', 'hoamai@example.test', '+84 901 234 567');
    const linkedZaloId = await seedIdentity(o.orgId, 'facebook_page', 'fb-linked-555', null);
    const linkedConvOld = await seedConversation(o.orgId, zaloCh, 'direct', linkedZaloId, {
      partyId: partyPhone,
      lastMessageAt: new Date('2026-11-20T10:00:00Z'),
    });
    await seedMessage(o.orgId, linkedConvOld, zaloCh, 'direct', 1, 'in', 'Zalo cũ', { authorIdentityId: linkedZaloId });
    const linkedConvNew = await seedConversation(o.orgId, fbCh, 'comment_thread', linkedZaloId, {
      partyId: partyPhone,
      lastMessageAt: new Date('2026-11-26T01:00:00Z'),
    });
    await seedMessage(o.orgId, linkedConvNew, fbCh, 'comment_thread', 1, 'in', 'Bình luận mới', { authorIdentityId: linkedZaloId });

    // Commenter-only identity linked via identity.party_id (0 owned threads, 2 authored messages in another comment thread).
    const commenterLinkedId = await seedIdentity(o.orgId, 'facebook_page', 'fb-commenter-777', 'Anh Tùng', { partyId: partyPhone });
    await seedMessage(o.orgId, otherFbConv, fbCh, 'comment_thread', 3, 'in', 'Tùng bình luận 1', {
      authorIdentityId: commenterLinkedId,
      sentAt: new Date('2026-11-25T09:00:00Z'),
    });
    const newestCommentId = await seedMessage(o.orgId, otherFbConv, fbCh, 'comment_thread', 4, 'in', 'Tùng bình luận 2', {
      authorIdentityId: commenterLinkedId,
      sentAt: new Date('2026-11-25T11:00:00Z'),
    });

    // Tombstoned identity and orphan identity matching phone must NEVER appear.
    const erasedWa = await seedIdentity(o.orgId, 'whatsapp', '84901234567', null, { erased: true, partyId: partyPhone });
    const erasedConv = await seedConversation(o.orgId, waCh, 'direct', erasedWa);
    await seedMessage(o.orgId, erasedConv, waCh, 'direct', 1, 'in', 'Old', { authorIdentityId: erasedWa });
    await seedIdentity(o.orgId, 'whatsapp', '0901234567', 'Orphan WA', { partyId: partyPhone });

    const found = await rt.execute<ConversationPersonalDataResult>(
      'kernel.conversation.personal_data_find',
      { value: '0901 234 567' },
      { actor: asUser(o.owner), orgId: o.orgId },
    );
    expect(found.kind).toBe('digits');
    expect(found.truncated).toBe(false);
    expect(found.items.map((x) => x.identityId).sort()).toEqual([waId, linkedZaloId, commenterLinkedId].sort());

    const waItem = found.items.find((x) => x.identityId === waId);
    expect(waItem).toEqual({
      identityId: waId,
      provider: 'whatsapp',
      channelName: 'WhatsApp Shop',
      displayName: 'Chị Hoa WhatsApp',
      idTail: '4567',
      address: null,
      matchSource: 'direct',
      linkedContactNames: [],
      threads: 1,
      messages: 4, // 3 in waConv + 1 in otherFbConv (no double-count)
      notes: 1,
      inComments: false,
      eraseTarget: { conversationId: waConv },
    });

    const linkedItem = found.items.find((x) => x.identityId === linkedZaloId);
    expect(linkedItem).toEqual({
      identityId: linkedZaloId,
      provider: 'facebook_page',
      channelName: 'Trang FB Chính', // newest owned conversation channel
      displayName: null,
      idTail: '-555',
      address: null,
      matchSource: 'linked_contact',
      linkedContactNames: ['Công ty Hoa Mai'],
      threads: 2,
      messages: 2,
      notes: 0,
      inComments: true,
      eraseTarget: { conversationId: linkedConvNew },
    });

    const commenterItem = found.items.find((x) => x.identityId === commenterLinkedId);
    expect(commenterItem).toEqual({
      identityId: commenterLinkedId,
      provider: 'facebook_page',
      channelName: 'Trang FB Chính',
      displayName: 'Anh Tùng',
      idTail: '-777',
      address: null,
      matchSource: 'linked_contact',
      linkedContactNames: ['Công ty Hoa Mai'],
      threads: 0,
      messages: 2,
      notes: 0,
      inComments: false,
      eraseTarget: { conversationId: otherFbConv, messageId: newestCommentId },
    });

    // Step-up R3 enforced by kernel.conversation.erase_contact, then erases commenter-only and owned identities cleanly.
    await expect(
      rt.execute('kernel.conversation.erase_contact', { ...commenterItem!.eraseTarget, confirm: true }, {
        actor: asUser(o.admin),
        orgId: o.orgId,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });

    const erasedCommenter = await rt.execute<ConversationErased>(
      'kernel.conversation.erase_contact',
      { ...commenterItem!.eraseTarget, confirm: true },
      { actor: asMfa(o.admin), orgId: o.orgId, idempotencyKey: randomUUID() },
    );
    expect(erasedCommenter).toEqual({ threads: 0, messages: 2 });

    const erasedWaRes = await rt.execute<ConversationErased>(
      'kernel.conversation.erase_contact',
      { ...waItem!.eraseTarget, confirm: true },
      { actor: asMfa(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() },
    );
    expect(erasedWaRes).toEqual({ threads: 1, messages: 4 });

    // Re-searching no longer includes the erased identities, while linkedZaloId remains until erased.
    const after = await rt.execute<ConversationPersonalDataResult>(
      'kernel.conversation.personal_data_find',
      { value: '+84 901 234 567' },
      { actor: asUser(o.owner), orgId: o.orgId },
    );
    expect(after.items.map((x) => x.identityId)).toEqual([linkedZaloId]);

    // Verify keep_record handling on conversation_identity stays unchanged under kernel.personal_data.erase.
    const cols = PERSONAL_DATA_COLUMNS as Record<string, PersonalDataColumn>;
    expect(cols['ludy_kernel.conversation_identity.display_name']?.handling).toBe('keep_record');
    expect(cols['ludy_kernel.conversation_identity.external_user_id']?.handling).toBe('keep_record');

    // An email identity untouched by kernel.conversation.erase_contact stays intact when kernel.personal_data.erase runs.
    const emailCh = await seedChannel(o.orgId, o.owner, 'email', 'Email');
    const keepEmailId = await seedIdentity(o.orgId, 'email', 'hoamai@example.test', 'Hoa Mai Email');
    const keepEmailConv = await seedConversation(o.orgId, emailCh, 'email', keepEmailId);
    await seedMessage(o.orgId, keepEmailConv, emailCh, 'email', 1, 'in', 'Xin giữ', { authorIdentityId: keepEmailId });
    await rt.execute<PersonalDataErasure>(
      'kernel.personal_data.erase',
      { value: 'hoamai@example.test' },
      { actor: asMfa(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() },
    );
    const emailAfterGenericErase = await rt.execute<ConversationPersonalDataResult>(
      'kernel.conversation.personal_data_find',
      { value: 'hoamai@example.test' },
      { actor: asUser(o.owner), orgId: o.orgId },
    );
    expect(emailAfterGenericErase.items.map((x) => x.identityId)).toEqual([keepEmailId]);
  });

  it('caps results at 50 identities and caps linkedContactNames at 3', async () => {
    const o = await makeOrg();
    const fbCh = await seedChannel(o.orgId, o.owner, 'facebook_page', 'Trang Scale');
    const partyIds: string[] = [];
    for (let i = 1; i <= 5; i++) {
      partyIds.push(await seedParty(o.orgId, `Liên hệ ${i}`, `bulk-${o.orgId.slice(0, 6)}@example.test`, '0908889999'));
    }
    const multiId = await seedIdentity(o.orgId, 'facebook_page', 'fb-multi-party', 'Khách Nhiều Liên Hệ', { partyId: partyIds[0] });
    for (let i = 0; i < 5; i++) {
      const cId = await seedConversation(o.orgId, fbCh, 'direct', multiId, { partyId: partyIds[i] });
      await seedMessage(o.orgId, cId, fbCh, 'direct', 1, 'in', `msg ${i}`, { authorIdentityId: multiId });
    }
    for (let i = 0; i < 51; i++) {
      const id = await seedIdentity(o.orgId, 'facebook_page', `fb-bulk-${i}`, `Khách ${i}`, { partyId: partyIds[0] });
      await seedConversation(o.orgId, fbCh, 'direct', id);
    }

    const res = await rt.execute<ConversationPersonalDataResult>(
      'kernel.conversation.personal_data_find',
      { value: '0908889999' },
      { actor: asUser(o.owner), orgId: o.orgId },
    );
    expect(res.items).toHaveLength(50);
    expect(res.truncated).toBe(true);
    for (const item of res.items) {
      expect(item.linkedContactNames.length).toBeLessThanOrEqual(3);
    }
  });
});
