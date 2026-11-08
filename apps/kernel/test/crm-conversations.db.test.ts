// SPDX-License-Identifier: AGPL-3.0-only
// A contact's conversations on its timeline and on its deals (#2333, docs/plan/conversations.md section 9):
// - crm.party.conversations returns the conversations linked to the contact (or to a person who works at the company, or to a
//   duplicate merged into it), with channel, kind, status and last message time, and never a message body;
// - crm.deal.conversations returns the conversations of the deal's contact since the deal opened (opened_at >= deal.created_at
//   or last_message_at >= deal.created_at);
// - both queries read crove_kernel.conversation under its RLS (conversation_access), so a member limited to another channel
//   sees no comment thread from the restricted channel, and a member or viewer without desk.agent (kernel.conversation.direct.read)
//   sees no direct or email conversation entry;
// - erasing a customer (kernel.conversation.erase_contact, CV6) removes the conversation entries on the next read.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { ConversationEvent, ConversationOther, Deal } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { crmCommands, crmQueries } from '@crove/mod-crm';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SYSTEM = { type: 'system' as const, component: 'conversations' };

suite("a contact's conversations on its timeline and on its deals (#2333)", () => {
  const dbName = `crove_test_crm_conv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let worker: Runtime;
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

  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@crm-conv.test`, name: null });

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
    const wrk = new URL(adminUrl);
    wrk.username = 'crove_worker';
    wrk.password = 'test-worker-pw';
    pool = createPool({ connectionString: app.toString(), max: 4 });
    workerPool = createPool({ connectionString: wrk.toString(), max: 2 });
    db = createDb(pool);
    const registered = { commands: [...kernelCommands, ...crmCommands], queries: [...kernelQueries({ inboundDomain: null }), ...crmQueries] };
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register(registered);
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(registered);
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

  it('lists linked conversations on the contact and deal timelines, respects channel and direct-message RLS, never includes message bodies, and removes entries on customer erasure', async () => {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Công ty ${randomUUID().slice(0, 6)}`);
    const [desk, member, scopedMember, viewer] = [await person('desk'), await person('member'), await person('scoped'), await person('viewer')];
    await admin((c) =>
      c.query(
        "INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'viewer')",
        [orgId, desk, member, scopedMember, viewer],
      ),
    );
    // desk holds desk.agent (kernel.conversation.direct.read); member, scopedMember and viewer do not.
    await admin((c) =>
      c.query("INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, granted_by) VALUES ($1, $2, 'desk.agent', $3)", [orgId, desk, owner]),
    );

    const [channelA, channelB] = [randomUUID(), randomUUID()];
    await admin((c) =>
      c.query(
        "INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'sandbox', $3, 'Trang Chính', $5), ($1, $4, 'sandbox', $6, 'Trang Phụ', $5)",
        [orgId, channelA, `acct-a-${randomUUID().slice(0, 6)}`, channelB, owner, `acct-b-${randomUUID().slice(0, 6)}`],
      ),
    );
    // scopedMember is limited to channelB only.
    await admin((c) =>
      c.query('INSERT INTO crove_kernel.channel_access (org_id, channel_connection_id, user_id, created_by) VALUES ($1, $2, $3, $4)', [orgId, channelB, scopedMember, owner]),
    );

    const exec = <T>(user: string, command: string, input: unknown, mfa = false) =>
      rt.execute<T>(command, input, { actor: mfa ? asMfa(user) : asUser(user), orgId });
    const query = <T>(user: string, command: string, input: unknown) => rt.query<T>(command, input, { actor: asUser(user), orgId });

    const { partyId: companyId } = await exec<{ partyId: string }>(owner, 'kernel.party.create', { kind: 'organization', name: 'Công ty Ánh Dương' });
    const { partyId: employeeId } = await exec<{ partyId: string }>(owner, 'kernel.party.create', { kind: 'person', name: 'Chị Mai Hương' });
    const { partyId: duplicateId } = await exec<{ partyId: string }>(owner, 'kernel.party.create', { kind: 'organization', name: 'Ánh Dương (trùng)' });
    await exec(owner, 'kernel.party.set_company', { partyId: employeeId, companyId, version: 1 });
    await exec(owner, 'kernel.party.mark_duplicate', { partyId: duplicateId, keepId: companyId });

    let seq = 0;
    const ingest = async (connectionId: string, kind: ConversationEvent['kind'], threadId: string, text: string, at: string, customerId = 'cust-1') => {
      const ev: ConversationEvent = {
        kind,
        threadId,
        ...(kind === 'comment_thread' ? { postId: 'post-1' } : {}),
        messageId: `msg-${threadId}-${++seq}`,
        direction: 'in',
        contact: { id: customerId, name: 'Khách thử' },
        text,
        at,
      };
      await worker.execute('kernel.conversation.ingest', { connectionId, events: [ev] }, { actor: SYSTEM, orgId });
      const { rows } = await admin((c) =>
        c.query<{ id: string }>('SELECT id FROM crove_kernel.conversation WHERE org_id = $1 AND channel_connection_id = $2 AND external_thread_id = $3', [orgId, connectionId, threadId]),
      );
      return rows[0]!.id;
    };

    const oldAt = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const recentAt = new Date(Date.now() + 60_000).toISOString();
    const secretBody = 'Nội dung tin nhắn riêng tuyệt mật không bao giờ sang CRM';

    // 1. An older comment thread on channelA, linked to the duplicate party and closed before the deal is created.
    const oldCommentId = await ingest(channelA, 'comment_thread', 't-old', 'Bình luận tuần trước', oldAt, 'cust-old');
    await admin((c) =>
      c.query('UPDATE crove_kernel.conversation SET opened_at = $3, last_message_at = $3, party_id = $4 WHERE org_id = $1 AND id = $2', [orgId, oldCommentId, oldAt, duplicateId]),
    );

    // Create a deal for the company now.
    await exec(owner, 'crm.pipeline.setup', {});
    const deal = await exec<Deal>(owner, 'crm.deal.create', { partyId: companyId, title: 'Hợp đồng phần mềm', amount: '25000000', expectedClose: '2026-12-31' });

    // 2. A comment thread on channelA linked to the employee who works at the company, with activity after the deal opened.
    const commentAId = await ingest(channelA, 'comment_thread', 't-comment-a', 'Cho mình hỏi báo giá gói năm', recentAt, 'cust-main');
    await exec(owner, 'kernel.conversation.link_contact', { conversationId: commentAId, partyId: employeeId });

    // 3. A direct message on channelA linked to the company, with a sensitive body.
    const directAId = await ingest(channelA, 'direct', 't-direct-a', secretBody, recentAt, 'cust-main');
    await exec(owner, 'kernel.conversation.link_contact', { conversationId: directAId, partyId: companyId });

    // 4. A comment thread on channelB linked to the company.
    const commentBId = await ingest(channelB, 'comment_thread', 't-comment-b', 'Bình luận ở Trang Phụ', recentAt, 'cust-b');
    await exec(owner, 'kernel.conversation.link_contact', { conversationId: commentBId, partyId: companyId });

    // Contact conversations for the company include the company's own threads AND the employee's thread.
    const ownerCompanyConvs = await query<ConversationOther[]>(owner, 'crm.party.conversations', { partyId: companyId });
    expect(ownerCompanyConvs.map((c) => c.id).sort()).toEqual([commentAId, commentBId, directAId, oldCommentId].sort());

    // Contact conversations for the employee include only the employee's thread.
    const ownerEmployeeConvs = await query<ConversationOther[]>(owner, 'crm.party.conversations', { partyId: employeeId });
    expect(ownerEmployeeConvs.map((c) => c.id)).toEqual([commentAId]);

    // Never return message bodies or customer text in the entries or in activity.
    const serialized = JSON.stringify(ownerCompanyConvs);
    expect(serialized).not.toContain(secretBody);
    expect(serialized).not.toContain('Cho mình hỏi báo giá gói năm');
    for (const c of ownerCompanyConvs) {
      expect(Object.keys(c).sort()).toEqual(['channel', 'id', 'kind', 'lastMessageAt', 'status']);
    }

    // Deal conversations include only conversations since the deal opened (excluding oldCommentId).
    const ownerDealConvs = await query<ConversationOther[]>(owner, 'crm.deal.conversations', { dealId: deal.id });
    expect(ownerDealConvs.map((c) => c.id).sort()).toEqual([commentAId, commentBId, directAId].sort());

    // desk has desk.agent and unrestricted channels -> sees all 3 on the deal.
    const deskDealConvs = await query<ConversationOther[]>(desk, 'crm.deal.conversations', { dealId: deal.id });
    expect(deskDealConvs.map((c) => c.id).sort()).toEqual([commentAId, commentBId, directAId].sort());

    // member and viewer do NOT have desk.agent -> RLS hides directAId on both contact and deal reads.
    const memberCompanyConvs = await query<ConversationOther[]>(member, 'crm.party.conversations', { partyId: companyId });
    expect(memberCompanyConvs.map((c) => c.id).sort()).toEqual([commentAId, commentBId, oldCommentId].sort());
    const viewerDealConvs = await query<ConversationOther[]>(viewer, 'crm.deal.conversations', { dealId: deal.id });
    expect(viewerDealConvs.map((c) => c.id).sort()).toEqual([commentAId, commentBId].sort());

    // scopedMember is limited to channelB and lacks desk.agent -> sees only commentBId.
    const scopedCompanyConvs = await query<ConversationOther[]>(scopedMember, 'crm.party.conversations', { partyId: companyId });
    expect(scopedCompanyConvs.map((c) => c.id)).toEqual([commentBId]);
    const scopedDealConvs = await query<ConversationOther[]>(scopedMember, 'crm.deal.conversations', { dealId: deal.id });
    expect(scopedDealConvs.map((c) => c.id)).toEqual([commentBId]);

    // Erasing cust-main on channelA (CV6) removes commentAId and directAId on the next read.
    await exec(owner, 'kernel.conversation.erase_contact', { conversationId: commentAId, confirm: true }, true);
    const afterEraseCompany = await query<ConversationOther[]>(owner, 'crm.party.conversations', { partyId: companyId });
    expect(afterEraseCompany.map((c) => c.id).sort()).toEqual([commentBId, oldCommentId].sort());
    const afterEraseDeal = await query<ConversationOther[]>(owner, 'crm.deal.conversations', { dealId: deal.id });
    expect(afterEraseDeal.map((c) => c.id)).toEqual([commentBId]);
  });
});
