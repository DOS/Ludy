// SPDX-License-Identifier: AGPL-3.0-only
// The team task an AI coworker asks for, linked to a thread (epic #3857, issue #4148; ADR-0051 decision 10): the call leaves one pending, tainted proposal and creates nothing, no event and no wake-up
// (the sealed write context allows neither); a rejection creates nothing, ever; an approval runs kernel.conversation.follow_up once, as the approver, outside that context: the task is made tainted with the title
// as stored, its event is written and the assignee's agent is woken, tainted too. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConversationEvent, ConversationIngested } from '@ludy/kernel-contract';
import { ADMIN, startHarness, type Harness } from './engage-proposals-harness.ts';

const suite = ADMIN ? describe : describe.skip;
const COMMAND = 'kernel.conversation.follow_up_approved';

suite('the follow-up task proposal twin (#4148)', () => {
  let h: Harness;
  let connectionId = '';
  let tick = 0;
  beforeAll(async () => {
    h = await startHarness('engage_follow_up');
    connectionId = randomUUID();
    await h.q("INSERT INTO ludy_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'sandbox', $3, 'Kênh thử', $4)", [h.orgId, connectionId, `acct-${randomUUID().slice(0, 8)}`, h.owner]);
  }, 300_000);
  afterAll(async () => {
    await h?.stop();
  });

  async function thread(text: string) {
    const threadId = `thread-${randomUUID().slice(0, 8)}`;
    const event: ConversationEvent = { kind: 'comment_thread', threadId, postId: 'post-1', messageId: `m-${threadId}`, direction: 'in', contact: { id: `u-${tick}`, name: 'Trần Thị Khách' }, text, at: new Date(Date.UTC(2026, 10, 2, 3, 0, tick++)).toISOString() };
    await h.system<ConversationIngested>('conversations', 'kernel.conversation.ingest', { connectionId, events: [event] });
    return (await h.q<{ id: string }>('SELECT id FROM ludy_kernel.conversation WHERE org_id = $1 AND channel_connection_id = $2 AND external_thread_id = $3', [h.orgId, connectionId, threadId])).rows[0]?.id as string;
  }
  const tasksOf = async (conversation: string) =>
    (await h.q<{ id: string; title: string; tainted: boolean; source: string; source_ref: { type: string; id: string }; assignee_position_id: string | null; due: Date | null }>(
      "SELECT id, title, tainted, source, source_ref, assignee_position_id, due FROM ludy_kernel.task WHERE org_id = $1 AND source_ref @> $2::jsonb ORDER BY created_at",
      [h.orgId, JSON.stringify({ type: 'kernel.conversation', id: conversation })],
    )).rows;
  const taskEvents = async (taskId: string) => (await h.q<{ n: number }>("SELECT count(*)::int AS n FROM ludy_kernel.outbox_event WHERE org_id = $1 AND type = 'kernel.task.created' AND payload ->> 'taskId' = $2", [h.orgId, taskId])).rows[0]?.n ?? 0;
  const wakeups = async (agentId: string) => (await h.q<{ tainted: boolean; status: string }>('SELECT tainted, status FROM ludy_kernel.agent_wakeup WHERE org_id = $1 AND agent_id = $2', [h.orgId, agentId])).rows;
  const wakeCount = async () => (await h.q<{ n: number }>('SELECT count(*)::int AS n FROM ludy_kernel.agent_wakeup WHERE org_id = $1', [h.orgId])).rows[0]?.n ?? 0;

  it('waits as a tainted proposal: no task, no event and no wake-up until a person approves; then one tainted task, its event and the agent\'s wake-up', async () => {
    const conversation = await thread('Cho mình xin báo giá 20 hộp');
    const seat = await h.runtime.execute<{ agentId: string; positionId: string }>('kernel.agent.template.install', { templateKey: 'crm.scheduler' }, { actor: h.person(h.owner, true), orgId: h.orgId });
    const { actor } = await h.grant();
    const due = '2030-01-15T16:59:00.000Z';
    const payload = { conversationId: conversation, title: 'Gửi báo giá 20 hộp cho chị Lan', assigneePositionId: seat.positionId, due };
    const made = await h.propose(actor, COMMAND, payload);
    expect(made.status).toBe('pending');
    expect(await h.proposal(made.proposalId)).toMatchObject({ status: 'pending', command: COMMAND, kind: 'kernel.conversation_follow_up', tainted: true, payload });
    // Nothing was created and nobody was told: the original never ran.
    expect(await tasksOf(conversation)).toEqual([]);
    expect(await h.ran('kernel.conversation.follow_up')).toBe(0);
    expect(await wakeups(seat.agentId)).toEqual([]);

    await h.approve(made.proposalId);
    expect((await h.proposal(made.proposalId)).status).toBe('executed');
    expect(await h.executions('kernel.conversation.follow_up', made.proposalId)).toBe(1);
    const tasks = await tasksOf(conversation);
    expect(tasks).toHaveLength(1);
    const [task] = tasks;
    // The title exactly as stored, the seat and the day as asked, and the task marked as an AI's.
    expect(task).toMatchObject({ title: 'Gửi báo giá 20 hộp cho chị Lan', tainted: true, source: 'human', source_ref: { type: 'kernel.conversation', id: conversation }, assignee_position_id: seat.positionId });
    expect(task?.due?.toISOString()).toBe(due);
    // The event and the wake-up happened (outside the sealed context), and the wake-up is tainted like the task.
    expect(await taskEvents(task?.id as string)).toBe(1);
    expect(await wakeups(seat.agentId)).toEqual([expect.objectContaining({ tainted: true, status: 'pending' })]);
    // A second approval finds nothing to approve: still one task.
    await expect(h.approve(made.proposalId)).rejects.toBeDefined();
    expect(await tasksOf(conversation)).toHaveLength(1);
  });

  it('a task with no seat goes to the owner at the root of the chart and still comes from the proposal, tainted', async () => {
    const conversation = await thread('Hỏi giao hàng');
    const { actor } = await h.grant();
    const before = await wakeCount();
    const made = await h.propose(actor, COMMAND, { conversationId: conversation, title: 'Gọi lại cho khách', assigneePositionId: null });
    await h.approve(made.proposalId);
    expect(await tasksOf(conversation)).toEqual([expect.objectContaining({ title: 'Gọi lại cho khách', tainted: true, assignee_position_id: null, due: null })]);
    // No agent holds the root: nobody was woken by this one.
    expect(await wakeCount()).toBe(before);
  });

  it('a person\'s own follow-up is not tainted and needs no proposal: the proposal is what marks an AI\'s text', async () => {
    const conversation = await thread('Một hội thoại nữa');
    const made = await h.runtime.execute<{ taskId: string }>('kernel.conversation.follow_up', { conversationId: conversation, title: 'Việc tôi tự tạo', assigneePositionId: null }, { actor: h.person(h.owner, true), orgId: h.orgId });
    expect(await tasksOf(conversation)).toEqual([expect.objectContaining({ id: made.taskId, tainted: false })]);
    // The thread's task list says which tasks are an AI's (the panel marks them): a person's is not, an approved ask's is.
    const listed = await h.runtime.query<{ tasks: Array<{ id: string; tainted: boolean }> }>('kernel.conversation.tasks', { conversationId: conversation }, { actor: h.person(h.owner), orgId: h.orgId });
    expect(listed.tasks).toEqual([expect.objectContaining({ id: made.taskId, tainted: false })]);
    const asked = await thread('Một hội thoại có việc do AI đề nghị');
    const proposal = await h.propose((await h.grant()).actor, COMMAND, { conversationId: asked, title: 'Việc AI đề nghị', assigneePositionId: null });
    await h.approve(proposal.proposalId);
    const taskId = (await tasksOf(asked))[0]?.id;
    const marked = await h.runtime.query<{ tasks: Array<{ id: string; tainted: boolean }> }>('kernel.conversation.tasks', { conversationId: asked }, { actor: h.person(h.owner), orgId: h.orgId });
    expect(marked.tasks).toEqual([expect.objectContaining({ id: taskId, tainted: true })]);
  });

  it('a rejected proposal creates nothing, an approval the agent claims counts for nothing, and the twin runs only from an approved proposal', async () => {
    const conversation = await thread('Tư vấn thêm giúp mình');
    const { actor } = await h.grant();
    const made = await h.propose(actor, COMMAND, { conversationId: conversation, title: 'Việc không được duyệt', assigneePositionId: null });
    for (const command of ['kernel.proposal.approve', 'kernel.proposal.reject']) {
      await expect(h.runtime.execute(command, { id: made.proposalId, revision: 1 }, { actor, orgId: h.orgId })).rejects.toMatchObject({ status: 403 });
    }
    // A key the original does not declare, and a flag the approver alone sets, are refused before anything is stored.
    await expect(h.propose(actor, COMMAND, { conversationId: conversation, title: 'x', assigneePositionId: null, tainted: false })).rejects.toBeDefined();
    await expect(h.runtime.execute(COMMAND, { payload: { conversationId: conversation, title: 'x', assigneePositionId: null }, acceptFailedChecks: true }, { actor, orgId: h.orgId })).rejects.toMatchObject({ status: 422 });
    await h.reject(made.proposalId);
    expect((await h.proposal(made.proposalId)).status).toBe('rejected');
    await expect(h.approve(made.proposalId)).rejects.toBeDefined();
    expect(await tasksOf(conversation)).toEqual([]);
    expect(await h.executions('kernel.conversation.follow_up', made.proposalId)).toBe(0);
    // Not even a person runs the twin by itself.
    await expect(h.runtime.execute(COMMAND, { payload: { conversationId: conversation, title: 'x', assigneePositionId: null } }, { actor: h.person(h.owner, true), orgId: h.orgId })).rejects.toMatchObject({ status: 403 });
    expect(await tasksOf(conversation)).toEqual([]);
  });

  it('is judged on what stands at the approval: a thread erased while the ask waited makes the approval fail and the proposal is blanked, with nothing created', async () => {
    const conversation = await thread('Số của mình là 0912345678');
    const { actor } = await h.grant();
    const made = await h.propose(actor, COMMAND, { conversationId: conversation, title: 'Gọi 0912345678 hỏi đơn', assigneePositionId: null });
    await h.runtime.execute('kernel.conversation.erase_contact', { conversationId: conversation, confirm: true }, { actor: h.person(h.owner, true), orgId: h.orgId });
    const row = await h.proposal(made.proposalId);
    expect(row.status).toBe('rejected');
    expect(row.payload).toEqual({ erased: true });
    expect(JSON.stringify(row)).not.toContain('0912345678');
    await expect(h.approve(made.proposalId)).rejects.toBeDefined();
    expect(await tasksOf(conversation)).toEqual([]);
  });
});
