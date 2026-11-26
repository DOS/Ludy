// SPDX-License-Identifier: AGPL-3.0-only
// Product-flow integration tests for customer conversation personal-data lookup and step-up erasure on PostgreSQL 17 (#3669):
// - Validates probe parsing (422 PERSONAL_DATA_QUERY on invalid text, 0 items for unmatched tax code digits).
// - Verifies direct email + WhatsApp phone_key matching, non-WhatsApp and BSUID exclusion, zero message-body scanning,
//   linked-party matching, non-orphan/tombstone exclusion, deduplicated totalMessages, 50-row cap, 3-linked-name cap,
//   step-up R3 enforcement via kernel.conversation.erase_contact, and keep_record unchanged under kernel.personal_data.erase.
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

suite('conversation personal-data lookup and erasure flows (#3669)', () => {
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

  type OrgCtx = { orgId: string; owner: string; admin: string };
  async function makeOrg(): Promise<OrgCtx> {
    const user = async (tag: string) =>
      (await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${tag}-${randomUUID().slice(0, 8)}@conv-pd.test`, name: null })) as string;
    const [owner, adm] = [await user('owner'), await user('admin')];
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    await admin(async (c) => {
      await c.query("INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin')", [orgId, adm]);
    });
    return { orgId, owner, admin: adm };
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

  it('rejects unparseable probes with 422 PERSONAL_DATA_QUERY and returns empty for unmatched tax codes', async () => {
    const o = await makeOrg();
    await expect(
      rt.execute('kernel.conversation.personal_data_find', { value: 'not-valid-probe' }, { actor: asUser(o.owner), orgId: o.orgId }),
    ).rejects.toMatchObject({ code: 'PERSONAL_DATA_QUERY', status: 422 });
    const taxRes = await rt.execute<ConversationPersonalDataResult>(
      'kernel.conversation.personal_data_find',
      { value: '0101234564' },
      { actor: asUser(o.admin), orgId: o.orgId },
    );
    expect(taxRes).toEqual({ kind: 'digits', items: [], totalMessages: 0, truncated: false });
  });

  it('matches WhatsApp phone_key and linked contacts accurately, deduplicates totalMessages, and erases behind R3 step-up', async () => {
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

    // Linked-party customer (via conversation.party_id) with 2 owned threads (Zalo + FB comments) -> inComments: true.
    // Also includes a comment left by waId inside linkedConvNew to test cross-identity totalMessages deduplication!
    const partyPhone = await seedParty(o.orgId, 'Công ty Hoa Mai', 'hoamai@example.test', '+84 901 234 567');
    const linkedFbId = await seedIdentity(o.orgId, 'facebook_page', 'fb-linked-555', null);
    const linkedConvOld = await seedConversation(o.orgId, zaloCh, 'direct', linkedFbId, {
      partyId: partyPhone,
      lastMessageAt: new Date('2026-11-20T10:00:00Z'),
    });
    await seedMessage(o.orgId, linkedConvOld, zaloCh, 'direct', 1, 'in', 'Zalo cũ', { authorIdentityId: linkedFbId });
    const linkedConvNew = await seedConversation(o.orgId, fbCh, 'comment_thread', linkedFbId, {
      partyId: partyPhone,
      lastMessageAt: new Date('2026-11-26T01:00:00Z'),
    });
    await seedMessage(o.orgId, linkedConvNew, fbCh, 'comment_thread', 1, 'in', 'Bình luận mới', { authorIdentityId: linkedFbId });
    await seedMessage(o.orgId, linkedConvNew, fbCh, 'comment_thread', 2, 'in', 'Hoa bình luận trong luồng liên kết', { authorIdentityId: waId });

    // Unmatched customer's comment thread where commenterLinkedId left 2 replies (commenter-only -> threads: 0).
    const otherFbId = await seedIdentity(o.orgId, 'facebook_page', 'fb-other-1', 'Khách Khác');
    const otherFbConv = await seedConversation(o.orgId, fbCh, 'comment_thread', otherFbId);
    await seedMessage(o.orgId, otherFbConv, fbCh, 'comment_thread', 1, 'in', 'Khách khác hỏi bài', { authorIdentityId: otherFbId });

    const commenterLinkedId = await seedIdentity(o.orgId, 'facebook_page', 'fb-commenter-777', 'Anh Tùng', { partyId: partyPhone });
    await seedMessage(o.orgId, otherFbConv, fbCh, 'comment_thread', 2, 'in', 'Tùng bình luận 1', {
      authorIdentityId: commenterLinkedId,
      sentAt: new Date('2026-11-25T09:00:00Z'),
    });
    const newestCommentId = await seedMessage(o.orgId, otherFbConv, fbCh, 'comment_thread', 3, 'in', 'Tùng bình luận 2', {
      authorIdentityId: commenterLinkedId,
      sentAt: new Date('2026-11-25T11:00:00Z'),
    });

    // Tombstoned identity (hash key) and orphan identity matching partyPhone must NEVER appear.
    const erasedWa = await seedIdentity(o.orgId, 'whatsapp', `erased:k1:${'0'.repeat(64)}`, null, { erased: true, partyId: partyPhone });
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
    expect(found.items.map((x) => x.identityId).sort()).toEqual([waId, linkedFbId, commenterLinkedId].sort());
    // Unique messages across matched identities: 3 in waConv + 3 in linkedConvOld/New + 2 by commenterLinkedId = 8
    // (waId's comment in linkedConvNew is counted on both waItem.messages=4 and linkedItem.messages=3 -> sum=9, totalMessages=8!).
    expect(found.totalMessages).toBe(8);

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
      messages: 4, // 3 in waConv + 1 comment in linkedConvNew
      notes: 1,
      inComments: false,
      eraseTarget: { conversationId: waConv },
    });

    const linkedItem = found.items.find((x) => x.identityId === linkedFbId);
    expect(linkedItem).toEqual({
      identityId: linkedFbId,
      provider: 'facebook_page',
      channelName: 'Trang FB Chính',
      displayName: null,
      idTail: '-555',
      address: null,
      matchSource: 'linked_contact',
      linkedContactNames: ['Công ty Hoa Mai'],
      threads: 2,
      messages: 3, // 1 in linkedConvOld + 2 in linkedConvNew (including waId's comment)
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

    // Re-searching no longer includes the erased identities, while linkedFbId remains with its remaining 2 messages.
    const after = await rt.execute<ConversationPersonalDataResult>(
      'kernel.conversation.personal_data_find',
      { value: '+84 901 234 567' },
      { actor: asUser(o.owner), orgId: o.orgId },
    );
    expect(after.items.map((x) => x.identityId)).toEqual([linkedFbId]);
    expect(after.totalMessages).toBe(2);

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

  it('caps results at 50 identities and caps linkedContactNames at 3 on an identity in the returned page', async () => {
    const o = await makeOrg();
    const fbCh = await seedChannel(o.orgId, o.owner, 'facebook_page', 'Trang Scale');
    const p1 = await seedParty(o.orgId, 'Liên hệ 1', `bulk1-${o.orgId.slice(0, 6)}@example.test`, '0908889999');
    const p2 = await seedParty(o.orgId, 'Liên hệ 2', `bulk2-${o.orgId.slice(0, 6)}@example.test`, '0908889999');
    const p3 = await seedParty(o.orgId, 'Liên hệ 3', `bulk3-${o.orgId.slice(0, 6)}@example.test`, '0908889999');
    const p4 = await seedParty(o.orgId, 'Liên hệ 4', `bulk4-${o.orgId.slice(0, 6)}@example.test`, '0908889999');
    const p5 = await seedParty(o.orgId, 'Liên hệ 5', `bulk5-${o.orgId.slice(0, 6)}@example.test`, '0908889999');
    const parties = [p1, p2, p3, p4, p5];

    for (let i = 0; i < 51; i++) {
      const id = await seedIdentity(o.orgId, 'facebook_page', `fb-bulk-${i}`, `Khách ${i}`, { partyId: p1 });
      await seedConversation(o.orgId, fbCh, 'direct', id);
    }
    // Seed multiId AFTER the 51 bulk rows and backdate bulk rows slightly so multiId is guaranteed in the top 50 newest.
    await rows(`UPDATE ludy_kernel.conversation_identity SET updated_at = now() - interval '1 hour' WHERE org_id = $1`, [o.orgId]);
    const multiId = await seedIdentity(o.orgId, 'facebook_page', 'fb-multi-party', 'Khách Nhiều Liên Hệ', { partyId: p1 });
    for (const pid of parties) {
      const cId = await seedConversation(o.orgId, fbCh, 'direct', multiId, { partyId: pid });
      await seedMessage(o.orgId, cId, fbCh, 'direct', 1, 'in', 'tin', { authorIdentityId: multiId });
    }

    const res = await rt.execute<ConversationPersonalDataResult>(
      'kernel.conversation.personal_data_find',
      { value: '0908889999' },
      { actor: asUser(o.owner), orgId: o.orgId },
    );
    expect(res.items).toHaveLength(50);
    expect(res.truncated).toBe(true);
    const multiItem = res.items.find((x) => x.identityId === multiId);
    expect(multiItem).toBeDefined();
    expect(multiItem?.linkedContactNames).toEqual(['Liên hệ 1', 'Liên hệ 2', 'Liên hệ 3']);
  });
});
