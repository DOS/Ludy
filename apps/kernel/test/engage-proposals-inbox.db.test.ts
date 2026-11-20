// SPDX-License-Identifier: AGPL-3.0-only
// The Hộp thư twins an AI coworker asks with (epic #3857, E4, issue #3863; ADR-0051 decision 10): a reply, a private reply and hiding a comment. For each: the call leaves one pending, tainted proposal and
// sends nothing; a rejection sends nothing, ever; an approval runs the original command once, as the approver, with every check it has (here the reply window) judged then; an approval the agent claims
// counts for nothing. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertIdentity } from '@crove/kernel';
import type { ConversationEvent, ConversationIngested } from '@crove/kernel-contract';
import { ADMIN, startHarness, type Harness } from './engage-proposals-harness.ts';

const suite = ADMIN ? describe : describe.skip;

suite('the Hộp thư proposal twins (#3863)', () => {
  let h: Harness;
  let connectionId = '';
  let tick = 0;
  beforeAll(async () => {
    h = await startHarness('engage_inbox');
    connectionId = randomUUID();
    await h.q("INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'sandbox', $3, 'Kênh thử', $4)", [h.orgId, connectionId, `acct-${randomUUID().slice(0, 8)}`, h.owner]);
  }, 300_000);
  afterAll(async () => {
    await h?.stop();
  });

  // A customer's comment on a post: its thread, and the comment message in it.
  async function comment(text: string, contactId = `u-${tick}`) {
    const threadId = `thread-${randomUUID().slice(0, 8)}`;
    const messageId = `m-${threadId}`;
    const event: ConversationEvent = { kind: 'comment_thread', threadId, postId: 'post-1', messageId, direction: 'in', contact: { id: contactId, name: 'Trần Thị Khách' }, text, at: new Date(Date.UTC(2026, 10, 2, 3, 0, tick++)).toISOString() };
    await h.system<ConversationIngested>('conversations', 'kernel.conversation.ingest', { connectionId, events: [event] });
    const conversation = (await h.q<{ id: string }>('SELECT id FROM crove_kernel.conversation WHERE org_id = $1 AND channel_connection_id = $2 AND external_thread_id = $3', [h.orgId, connectionId, threadId])).rows[0]?.id as string;
    const message = (await h.q<{ id: string }>('SELECT id FROM crove_kernel.conversation_message WHERE org_id = $1 AND conversation_id = $2 AND direction = $3', [h.orgId, conversation, 'in'])).rows[0]?.id as string;
    return { conversation, message };
  }
  const outgoing = async (conversation: string) => (await h.q<{ n: number }>("SELECT count(*)::int AS n FROM crove_kernel.conversation_message WHERE org_id = $1 AND conversation_id = $2 AND direction = 'out'", [h.orgId, conversation])).rows[0]?.n ?? 0;
  const hiddenAt = async (message: string) => (await h.q<{ hidden_at: Date | null; hide_request: unknown }>('SELECT hidden_at, hide_request FROM crove_kernel.conversation_message WHERE org_id = $1 AND id = $2', [h.orgId, message])).rows[0];

  it('reply: waits as a tainted proposal, sends nothing until a person approves, then sends once; the reply window is judged at the approval', async () => {
    const { conversation } = await comment('Giá bao nhiêu vậy shop?');
    const { actor } = await h.grant();
    const payload = { conversationId: conversation, body: 'Dạ 100k ạ', lastSeenSeq: 1 };
    const made = await h.propose(actor, 'kernel.conversation.reply_approved', payload);
    expect(made.status).toBe('pending');
    const row = await h.proposal(made.proposalId);
    expect(row).toMatchObject({ status: 'pending', command: 'kernel.conversation.reply_approved', kind: 'kernel.conversation_reply', tainted: true, payload });
    expect(row.requested_by_grant).not.toBeNull();
    // Nothing was sent, and the original never ran.
    expect(await outgoing(conversation)).toBe(0);
    expect(await h.ran('kernel.conversation.reply')).toBe(0);

    // The window closes while it waits: the approval is refused by the reply's own check, the proposal stays pending, nothing is sent.
    await h.q("UPDATE crove_kernel.conversation SET reply_window_until = now() - interval '1 hour' WHERE org_id = $1 AND id = $2", [h.orgId, conversation]);
    await expect(h.approve(made.proposalId)).rejects.toMatchObject({ code: 'REPLY_WINDOW_CLOSED' });
    expect((await h.proposal(made.proposalId)).status).toBe('pending');
    expect(await outgoing(conversation)).toBe(0);

    // Open again: approved, it runs once and the proposal is executed.
    await h.q('UPDATE crove_kernel.conversation SET reply_window_until = NULL WHERE org_id = $1 AND id = $2', [h.orgId, conversation]);
    await h.approve(made.proposalId);
    expect((await h.proposal(made.proposalId)).status).toBe('executed');
    expect(await outgoing(conversation)).toBe(1);
    expect(await h.executions('kernel.conversation.reply', made.proposalId)).toBe(1);
    // A second approval finds nothing to approve: no second send.
    await expect(h.approve(made.proposalId)).rejects.toMatchObject({ status: expect.any(Number) });
    expect(await outgoing(conversation)).toBe(1);
  });

  it('reply: a rejected proposal is never sent, and an approval the agent claims counts for nothing', async () => {
    const { conversation } = await comment('Còn hàng không?');
    const { actor } = await h.grant();
    const made = await h.propose(actor, 'kernel.conversation.reply_approved', { conversationId: conversation, body: 'Dạ còn ạ', lastSeenSeq: 1 });
    // The grant (an agent entry) approves nothing, rejects nothing and edits nothing.
    for (const command of ['kernel.proposal.approve', 'kernel.proposal.reject']) {
      await expect(h.runtime.execute(command, { id: made.proposalId, revision: 1 }, { actor, orgId: h.orgId })).rejects.toMatchObject({ status: 403 });
    }
    // A payload that says the manager approved is data: the call is refused for a key the original does not declare, and a flag the approver alone sets.
    await expect(h.propose(actor, 'kernel.conversation.reply_approved', { conversationId: conversation, body: 'x', lastSeenSeq: 1, approvedBy: 'manager' })).rejects.toBeDefined();
    await expect(h.runtime.execute('kernel.conversation.reply_approved', { payload: { conversationId: conversation, body: 'x', lastSeenSeq: 1 }, acceptFailedChecks: true }, { actor, orgId: h.orgId })).rejects.toMatchObject({ status: 422 });
    expect((await h.proposal(made.proposalId)).status).toBe('pending');
    await h.reject(made.proposalId);
    expect((await h.proposal(made.proposalId)).status).toBe('rejected');
    await expect(h.approve(made.proposalId)).rejects.toBeDefined();
    expect(await outgoing(conversation)).toBe(0);
    expect(await h.executions('kernel.conversation.reply', made.proposalId)).toBe(0);
    // Nor can the twin be run by a person: it runs only from an approved proposal.
    await expect(h.runtime.execute('kernel.conversation.reply_approved', { payload: { conversationId: conversation, body: 'x', lastSeenSeq: 1 } }, { actor: h.person(h.owner, true), orgId: h.orgId })).rejects.toMatchObject({ status: 403 });
  });

  it('hide: waits, is never run by a rejection, and runs once when approved', async () => {
    const { message } = await comment('Quảng cáo bậy');
    const { actor } = await h.grant();
    const made = await h.propose(actor, 'kernel.conversation.hide_approved', { messageId: message, hidden: true });
    expect(await h.proposal(made.proposalId)).toMatchObject({ status: 'pending', kind: 'kernel.conversation_hide', tainted: true });
    expect((await hiddenAt(message))?.hidden_at).toBeNull();
    expect(await h.ran('kernel.conversation.hide')).toBe(0);
    await h.approve(made.proposalId);
    expect((await hiddenAt(message))?.hide_request ?? (await hiddenAt(message))?.hidden_at).not.toBeNull();
    expect(await h.executions('kernel.conversation.hide', made.proposalId)).toBe(1);

    const other = await comment('Một bình luận khác');
    const rejected = await h.propose(actor, 'kernel.conversation.hide_approved', { messageId: other.message, hidden: true });
    await h.reject(rejected.proposalId);
    expect(await h.executions('kernel.conversation.hide', rejected.proposalId)).toBe(0);
    expect((await hiddenAt(other.message))?.hidden_at).toBeNull();
    expect((await hiddenAt(other.message))?.hide_request).toBeNull();
  });

  it('erases the text an AI coworker proposed with the customer\'s thread: a waiting proposal is rejected and blanked, a decided one is blanked, and nothing can be sent into the erased thread', async () => {
    const waiting = await comment('Số của mình là 0912345678');
    const done = await comment('Đơn của mình giao ở đâu?');
    const { actor } = await h.grant();
    const pending = await h.propose(actor, 'kernel.conversation.reply_approved', { conversationId: waiting.conversation, body: 'Dạ chị Lan, em gọi 0912345678 nhé', lastSeenSeq: 1 });
    const sent = await h.propose(actor, 'kernel.conversation.reply_approved', { conversationId: done.conversation, body: 'Dạ đơn giao tới 12 Lê Lợi ạ', lastSeenSeq: 1 });
    await h.approve(sent.proposalId);
    expect((await h.proposal(sent.proposalId)).status).toBe('executed');
    for (const c of [waiting.conversation, done.conversation]) await h.runtime.execute('kernel.conversation.erase_contact', { conversationId: c, confirm: true }, { actor: h.person(h.owner, true), orgId: h.orgId });
    for (const id of [pending.proposalId, sent.proposalId]) {
      const row = await h.proposal(id);
      expect(row.payload, id).toEqual({ erased: true });
      expect(JSON.stringify(row), id).not.toContain('0912345678');
      expect(JSON.stringify(row), id).not.toContain('Lê Lợi');
    }
    expect((await h.proposal(pending.proposalId)).status).toBe('rejected');
    expect((await h.proposal(sent.proposalId)).status).toBe('executed');
    await expect(h.approve(pending.proposalId)).rejects.toBeDefined();
    expect(await h.executions('kernel.conversation.reply', pending.proposalId)).toBe(0);
  });

  it('finds the proposals of an erased thread whatever case their ids were written in: stored lower-cased, and a payload that was stored in capitals is blanked too', async () => {
    const { conversation, message } = await comment('Số của mình 0987654321');
    const { actor } = await h.grant();
    // Capitals from the client: the stored payload holds the ids in lower case.
    const made = await h.propose(actor, 'kernel.conversation.reply_approved', { conversationId: conversation.toUpperCase(), body: 'Em gọi 0987654321 nhé', lastSeenSeq: 1 });
    expect((await h.proposal(made.proposalId)).payload).toMatchObject({ conversationId: conversation });
    // And a payload that reached the table in capitals by any other way (an older row) is found by the erasure all the same.
    const hide = await h.propose(actor, 'kernel.conversation.hide_approved', { messageId: message, hidden: true });
    await h.q("UPDATE crove_kernel.proposal SET payload = jsonb_set(payload, '{messageId}', to_jsonb(upper(payload ->> 'messageId'))) WHERE org_id = $1 AND id = $2", [h.orgId, hide.proposalId]);
    expect(((await h.proposal(hide.proposalId)).payload as { messageId: string }).messageId).toBe(message.toUpperCase());
    await h.runtime.execute('kernel.conversation.erase_contact', { conversationId: conversation, confirm: true }, { actor: h.person(h.owner, true), orgId: h.orgId });
    for (const id of [made.proposalId, hide.proposalId]) {
      const row = await h.proposal(id);
      expect(row.payload, id).toEqual({ erased: true });
      expect(row.status, id).toBe('rejected');
    }
  });

  it('erases a proposal about a comment the erased customer wrote in another customer\'s thread (a private reply to it, hiding it)', async () => {
    // Customer A's comment thread, with a comment of customer B in it; B has a thread of their own to be erased from.
    const threadId = `thread-${randomUUID().slice(0, 8)}`;
    const at = (n: number) => new Date(Date.UTC(2026, 10, 2, 4, 0, tick++ + n)).toISOString();
    await h.system<ConversationIngested>('conversations', 'kernel.conversation.ingest', {
      connectionId,
      events: [
        { kind: 'comment_thread', threadId, postId: 'post-9', messageId: `a-${threadId}`, direction: 'in', contact: { id: `ua-${threadId}`, name: 'Khách A' }, text: 'Bài này hay', at: at(0) },
        { kind: 'comment_thread', threadId, postId: 'post-9', messageId: `b-${threadId}`, direction: 'in', contact: { id: `ub-${threadId}`, name: 'Khách B' }, text: 'Gọi mình 0900000111', at: at(1) },
      ],
    } satisfies { connectionId: string; events: ConversationEvent[] });
    const own = await comment('Tin của khách B ở thread khác', `ub-${threadId}`);
    const bMessage = (await h.q<{ id: string }>(`SELECT m.id FROM crove_kernel.conversation_message m JOIN crove_kernel.conversation_identity i ON i.org_id = m.org_id AND i.id = m.author_identity_id WHERE m.org_id = $1 AND i.external_user_id = $2 AND m.external_message_id = $3`, [h.orgId, `ub-${threadId}`, `b-${threadId}`])).rows[0]?.id as string;
    expect(bMessage).toBeTruthy();
    const { actor } = await h.grant();
    const hide = await h.propose(actor, 'kernel.conversation.hide_approved', { messageId: bMessage, hidden: true });
    const privateReply = await h.propose(actor, 'kernel.conversation.reply_privately_approved', { messageId: bMessage, body: 'Em gọi 0900000111 ạ' });
    await h.runtime.execute('kernel.conversation.erase_contact', { conversationId: own.conversation, confirm: true }, { actor: h.person(h.owner, true), orgId: h.orgId });
    for (const id of [hide.proposalId, privateReply.proposalId]) {
      const row = await h.proposal(id);
      expect(row.payload, id).toEqual({ erased: true });
      expect(row.status, id).toBe('rejected');
      expect(JSON.stringify(row), id).not.toContain('0900000111');
    }
    expect(await h.executions('kernel.conversation.hide', hide.proposalId)).toBe(0);
  });

  it('shows the card the text and the asker (marked as an AI app\'s), and with a second owner the person who connected the app cannot approve their own coworker\'s ask', async () => {
    const { conversation } = await comment('Cho mình hỏi giá');
    const { actor } = await h.grant();
    const made = await h.propose(actor, 'kernel.conversation.reply_approved', { conversationId: conversation, body: 'Dạ <b>100k</b> ạ', lastSeenSeq: 1 });
    const detail = await h.runtime.query<{ engage: { command: string; fields: Array<{ key: string; value: string }> } | null; requestedByMcp: { client: string; host: string } | null; canApprove: boolean; kind: string }>('kernel.inbox.get', { id: made.proposalId }, { actor: h.person(h.owner), orgId: h.orgId });
    expect(detail.kind).toBe('kernel.conversation_reply');
    expect(detail.requestedByMcp).toEqual({ client: 'Dy', host: 'dy.example.org' });
    expect(detail.engage?.command).toBe('kernel.conversation.reply_approved');
    expect(detail.engage?.fields.find((f) => f.key === 'body')?.value).toBe('Dạ <b>100k</b> ạ');
    // One eligible approver: the owner approves what their own coworker asked (the one-person path).
    expect(detail.canApprove).toBe(true);
    // Who and what it is about is read from the thread: the channel, the customer and what the customer wrote, so the approver does not read ids.
    expect((detail.engage as { about?: Array<{ label: string; value: string }> } | null)?.about).toEqual([
      { label: 'channel', value: 'sandbox: Kênh thử' },
      { label: 'contact', value: 'Trần Thị Khách' },
      { label: 'customerMessage', value: 'Cho mình hỏi giá' },
    ]);
    // The text may be a reply in a thread a member or a viewer may not read (a private message, an email): only the people who approve, owners and admins, see it.
    for (const role of ['member', 'viewer'] as const) {
      const id = await upsertIdentity(h.db, { issuer: 'engage-inbox', subject: `${role}-${randomUUID()}`, email: `${role}-${randomUUID().slice(0, 8)}@engage-inbox.test`, name: role });
      await h.q('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [h.orgId, id, role]);
      const asRole = await h.runtime.query<{ engage: unknown; kind: string; title: string }>('kernel.inbox.get', { id: made.proposalId }, { actor: h.person(id), orgId: h.orgId });
      expect(asRole.engage, role).toBeNull();
      expect(JSON.stringify(asRole), role).not.toContain('Dạ <b>100k</b> ạ');
    }
    // One eligible approver: the owner approves what their own coworker asked (the one-person path).
    expect(detail.canApprove).toBe(true);

    const second = await h.addOwner();
    const asOwner = await h.runtime.query<{ canApprove: boolean; approveReason: string }>('kernel.inbox.get', { id: made.proposalId }, { actor: h.person(h.owner), orgId: h.orgId });
    expect([asOwner.canApprove, asOwner.approveReason]).toEqual([false, 'four_eyes']);
    await expect(h.approve(made.proposalId, h.owner)).rejects.toMatchObject({ code: 'FOUR_EYES_REQUIRED' });
    expect((await h.proposal(made.proposalId)).status).toBe('pending');
    const asSecond = await h.runtime.query<{ canApprove: boolean }>('kernel.inbox.get', { id: made.proposalId }, { actor: h.person(second), orgId: h.orgId });
    expect(asSecond.canApprove).toBe(true);
    await h.approve(made.proposalId, second);
    expect(await outgoing(conversation)).toBe(1);
  });
});
