// SPDX-License-Identifier: AGPL-3.0-only
// The chain grant -> proposal -> approver -> action of an Engage twin, and the authority it runs under (epic #3857, E4, issue #3863; Platform PO conditions of 2026-11-19): the catalog holds exactly the 16 twins
// with their scope and kind; a grant's call runs nothing of the twin; the nested original's audit row names the approver as its actor and the proposal as its cause, never the grant; and a person who may not approve
// (a member, a viewer, an owner demoted after the ask) is refused and nothing runs. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENGAGE_PROPOSALS, type ConversationEvent } from '@ludy/kernel-contract';
import { upsertIdentity } from '@ludy/kernel';
import { ADMIN, startHarness, type Harness } from './engage-proposals-harness.ts';

const suite = ADMIN ? describe : describe.skip;

suite('the chain of an Engage twin (#3863)', () => {
  let h: Harness;
  let connectionId = '';
  let tick = 0;
  beforeAll(async () => {
    h = await startHarness('engage_chain');
    connectionId = randomUUID();
    await h.q("INSERT INTO ludy_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'sandbox', $3, 'Kênh thử', $4)", [h.orgId, connectionId, `acct-${randomUUID().slice(0, 8)}`, h.owner]);
  }, 300_000);
  afterAll(async () => {
    await h?.stop();
  });

  async function thread(): Promise<string> {
    const threadId = `thread-${randomUUID().slice(0, 8)}`;
    const event: ConversationEvent = { kind: 'comment_thread', threadId, postId: 'post-1', messageId: `m-${threadId}`, direction: 'in', contact: { id: `u-${tick}`, name: 'Khách' }, text: 'Giá bao nhiêu?', at: new Date(Date.UTC(2026, 10, 2, 3, 0, tick++)).toISOString() };
    await h.system('conversations', 'kernel.conversation.ingest', { connectionId, events: [event] });
    return (await h.q<{ id: string }>('SELECT id FROM ludy_kernel.conversation WHERE org_id = $1 AND external_thread_id = $2', [h.orgId, threadId])).rows[0]?.id as string;
  }
  const audit = async (command: string, proposalId?: string) =>
    (await h.q<{ actor_type: string; actor_id: string | null; outcome: string; proposal_id: string | null; detail: Record<string, unknown> }>(
      `SELECT actor_type, actor_id, outcome, proposal_id, detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = $2 AND ($3::text IS NULL OR proposal_id::text = $3 OR detail ->> 'proposal_id' = $3 OR detail ->> 'under_proposal' = $3) ORDER BY occurred_at, id`,
      [h.orgId, command, proposalId ?? null],
    )).rows;
  const member = async (role: 'member' | 'viewer') => {
    const id = await upsertIdentity(h.db, { issuer: 'engage-chain', subject: `${role}-${randomUUID()}`, email: `${role}-${randomUUID().slice(0, 8)}@engage-chain.test`, name: role });
    await h.q('INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [h.orgId, id, role]);
    return id;
  };

  it('holds exactly the 14 twins in the catalog, each with its scope and kind, and no other row', async () => {
    const rows = (await h.q<{ command: string; scope: string; kind: string; adr: string }>('SELECT command, scope, kind, adr FROM ludy_kernel.mcp_proposal_command ORDER BY command')).rows;
    expect(rows).toEqual(ENGAGE_PROPOSALS.map((p) => ({ command: p.command, scope: p.scope, kind: p.kind, adr: 'ADR-0051' })).sort((a, b) => (a.command < b.command ? -1 : 1)));
  });

  it('reads back grant -> proposal -> approver -> action: the original runs as the approver, under the proposal, and never as the grant', async () => {
    const conversation = await thread();
    const { grantId, actor } = await h.grant();
    const made = await h.propose(actor, 'kernel.conversation.reply_approved', { conversationId: conversation, body: 'Dạ 100k ạ', lastSeenSeq: 1 });
    // The call ran nothing of the twin, nor the original: only the proposer's row exists, and it is the grant's.
    expect(await h.ran('kernel.conversation.reply_approved')).toBe(0);
    expect(await h.ran('kernel.conversation.reply')).toBe(0);
    const asked = await audit('kernel.mcp.propose', made.proposalId);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.detail).toMatchObject({ mcpCall: true, mcpGrant: grantId, proposal_command: 'kernel.conversation.reply_approved' });
    expect((await h.proposal(made.proposalId)).requested_by_grant).toBe(grantId);

    await h.approve(made.proposalId);
    // The twin and the original ran once each, as the person who approved (a user entry), under the proposal, and neither row names the grant or the client: the nested run holds the approver's authority alone.
    for (const command of ['kernel.conversation.reply_approved', 'kernel.conversation.reply']) {
      const rows = await audit(command, made.proposalId);
      expect(rows, command).toHaveLength(1);
      expect([rows[0]?.actor_type, rows[0]?.actor_id, rows[0]?.outcome], command).toEqual(['user', h.owner, 'ok']);
      expect(rows[0]?.detail, command).not.toHaveProperty('mcpCall');
      expect(rows[0]?.detail, command).not.toHaveProperty('mcpGrant');
      expect(rows[0]?.detail, command).not.toHaveProperty('mcpClient');
    }
    // The twin's row is the one the proposal names as its own; the original's row names it as its cause.
    expect((await audit('kernel.conversation.reply_approved', made.proposalId))[0]?.proposal_id).toBe(made.proposalId);
    expect((await audit('kernel.conversation.reply', made.proposalId))[0]?.detail).toMatchObject({ under_proposal: made.proposalId });
    // And the approval itself is the person's, with the policy it ran under.
    const approval = await audit('kernel.proposal.approve');
    expect(approval.at(-1)?.detail).toMatchObject({ policy_version: 20, aal: 'aal2' });
  });

  it('refuses an approval by a person who may not approve (a member, a viewer, an owner demoted after the ask): nothing runs and the proposal stays pending', async () => {
    const conversation = await thread();
    const { actor } = await h.grant();
    const made = await h.propose(actor, 'kernel.conversation.reply_approved', { conversationId: conversation, body: 'Dạ vâng', lastSeenSeq: 1 });
    for (const role of ['member', 'viewer'] as const) {
      const who = await member(role);
      await expect(h.approve(made.proposalId, who), role).rejects.toMatchObject({ status: 403 });
    }
    // An owner who stops being one while it waits holds the authority of the role they have now.
    const later = await h.addOwner();
    await h.q("UPDATE ludy_kernel.tenant_member SET role = 'member' WHERE org_id = $1 AND user_id = $2", [h.orgId, later]);
    await expect(h.approve(made.proposalId, later)).rejects.toMatchObject({ status: 403 });
    expect((await h.proposal(made.proposalId)).status).toBe('pending');
    expect(await h.executions('kernel.conversation.reply', made.proposalId)).toBe(0);
    expect(await h.executions('kernel.conversation.reply_approved', made.proposalId)).toBe(0);
  });
});
