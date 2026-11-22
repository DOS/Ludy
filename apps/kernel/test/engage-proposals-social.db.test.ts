// SPDX-License-Identifier: AGPL-3.0-only
// The Social twins an AI coworker asks with (epic #3857, E4, issue #3863; ADR-0051 decision 10): sending a post's variants to review and scheduling approved ones. For each: the call leaves one pending, tainted
// proposal and changes nothing; a rejection changes nothing, ever; an approval runs the original command once, as the approver, with every check it has (a variant that does not fit its channel, an approval that
// no longer covers the content) judged then and leaving the proposal pending when it refuses. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PostView } from '@ludy/mod-social';
import { ADMIN, startHarness, type Harness } from './engage-proposals-harness.ts';

const suite = ADMIN ? describe : describe.skip;
const HOUR = 3_600_000;

suite('the Social proposal twins (#3863)', () => {
  let h: Harness;
  let connectionId = '';
  beforeAll(async () => {
    h = await startHarness('engage_social');
    connectionId = randomUUID();
    await h.q("INSERT INTO ludy_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'sandbox', $3, 'Kênh thử', $4)", [h.orgId, connectionId, `acct-${randomUUID().slice(0, 8)}`, h.owner]);
  }, 300_000);
  afterAll(async () => {
    await h?.stop();
  });

  const owner = () => h.person(h.owner);
  const exec = <O = unknown>(command: string, input: unknown) => h.runtime.execute<O>(command, input, { actor: owner(), orgId: h.orgId });
  const view = (postId: string) => h.runtime.query<PostView>('social.post.get', { postId }, { actor: owner(), orgId: h.orgId });
  const seen = (p: PostView) => p.variants.map((v) => ({ variantId: v.id, revision: v.revision, contentHash: v.contentHash }));
  // A draft post with one variant on the channel.
  async function draft(body = 'Khuyến mãi tháng 12') {
    const { postId } = await exec<{ postId: string }>('social.post.create', { body, channels: [{ connectionId }] });
    const post = await view(postId);
    return { postId, variantId: post.variants[0]?.id as string };
  }
  // A post whose variant a reviewer approved, as the screens do it: submit, then decide on what the reviewer saw.
  async function approved() {
    const made = await draft();
    await exec('social.post.submit', { postId: made.postId });
    await exec('social.variant.decide', { postId: made.postId, decision: 'approved', variants: seen(await view(made.postId)) });
    return made;
  }
  const status = async (variantId: string) => (await h.q<{ status: string; scheduled_at: Date | null }>('SELECT status, scheduled_at FROM crove_social.post_variant WHERE org_id = $1 AND id = $2', [h.orgId, variantId])).rows[0];

  it('submit: waits as a tainted proposal, nothing goes to review until a person approves, then it goes once', async () => {
    const { postId, variantId } = await draft();
    const { actor } = await h.grant();
    const payload = { postId, variantIds: [variantId] };
    const made = await h.propose(actor, 'social.post.submit_approved', payload);
    expect(made.status).toBe('pending');
    expect(await h.proposal(made.proposalId)).toMatchObject({ status: 'pending', command: 'social.post.submit_approved', kind: 'social.post_submit', tainted: true, payload });
    expect((await h.proposal(made.proposalId)).requested_by_grant).not.toBeNull();
    // The original never ran: the variant is still a draft.
    expect(await h.ran('social.post.submit')).toBe(0);
    expect((await status(variantId))?.status).toBe('draft');

    await h.approve(made.proposalId);
    expect((await h.proposal(made.proposalId)).status).toBe('executed');
    expect(await h.executions('social.post.submit', made.proposalId)).toBe(1);
    expect((await status(variantId))?.status).toBe('in_review');
    // A second approval finds nothing to approve: no second submit.
    await expect(h.approve(made.proposalId)).rejects.toMatchObject({ status: expect.any(Number) });
    expect(await h.executions('social.post.submit', made.proposalId)).toBe(1);
    expect(await h.ran('social.post.submit')).toBe(1);
    expect((await status(variantId))?.status).toBe('in_review');
  });

  it('submit: a rejected proposal never goes to review, and a post that stopped fitting its channel is refused at the approval', async () => {
    const rejected = await draft('Bài bị từ chối');
    const { actor } = await h.grant();
    const first = await h.propose(actor, 'social.post.submit_approved', { postId: rejected.postId });
    await h.reject(first.proposalId);
    expect((await h.proposal(first.proposalId)).status).toBe('rejected');
    await expect(h.approve(first.proposalId)).rejects.toBeDefined();
    expect(await h.executions('social.post.submit', first.proposalId)).toBe(0);
    expect((await status(rejected.variantId))?.status).toBe('draft');

    // The post is emptied while the proposal waits: the platform's own rule (the original's check) refuses at the approval, the proposal stays pending, and nothing goes to review.
    const { postId, variantId } = await draft('Bài sẽ bị xóa nội dung');
    const second = await h.propose(actor, 'social.post.submit_approved', { postId });
    await h.q("UPDATE crove_social.post SET body = '   ' WHERE org_id = $1 AND id = $2", [h.orgId, postId]);
    await expect(h.approve(second.proposalId)).rejects.toMatchObject({ code: 'VARIANT_INVALID' });
    expect((await h.proposal(second.proposalId)).status).toBe('pending');
    expect(await h.executions('social.post.submit', second.proposalId)).toBe(0);
    expect((await status(variantId))?.status).toBe('draft');

    // A key the original does not declare is refused, and so is a person calling the twin: it runs only from an approved proposal.
    await expect(h.propose(actor, 'social.post.submit_approved', { postId, approvedBy: 'manager' })).rejects.toBeDefined();
    await expect(exec('social.post.submit_approved', { payload: { postId } })).rejects.toMatchObject({ status: 403 });
  });

  it('schedule: waits as a tainted proposal, schedules nothing until a person approves, then schedules once at the time asked', async () => {
    const { postId, variantId } = await approved();
    const { actor } = await h.grant();
    const at = new Date(Date.now() + 3 * HOUR).toISOString();
    const payload = { postId, variantIds: [variantId], at };
    const made = await h.propose(actor, 'social.variant.schedule_approved', payload);
    expect(made.status).toBe('pending');
    expect(await h.proposal(made.proposalId)).toMatchObject({ status: 'pending', command: 'social.variant.schedule_approved', kind: 'social.variant_schedule', tainted: true, payload });
    expect((await h.proposal(made.proposalId)).requested_by_grant).not.toBeNull();
    expect(await h.ran('social.variant.schedule')).toBe(0);
    expect(await status(variantId)).toMatchObject({ status: 'approved', scheduled_at: null });

    await h.approve(made.proposalId);
    expect((await h.proposal(made.proposalId)).status).toBe('executed');
    expect(await h.executions('social.variant.schedule', made.proposalId)).toBe(1);
    const after = await status(variantId);
    expect(after?.status).toBe('scheduled');
    expect(after?.scheduled_at?.toISOString()).toBe(at);
    // A second approval finds nothing to approve: no second schedule.
    await expect(h.approve(made.proposalId)).rejects.toMatchObject({ status: expect.any(Number) });
    expect(await h.executions('social.variant.schedule', made.proposalId)).toBe(1);
    expect((await status(variantId))?.status).toBe('scheduled');
  });

  it('schedule: a rejected proposal never schedules, and an approval that no longer covers the content is refused at the approval', async () => {
    const rejected = await approved();
    const { actor } = await h.grant();
    const at = new Date(Date.now() + 4 * HOUR).toISOString();
    const first = await h.propose(actor, 'social.variant.schedule_approved', { postId: rejected.postId, variantIds: [rejected.variantId], at });
    await h.reject(first.proposalId);
    expect((await h.proposal(first.proposalId)).status).toBe('rejected');
    await expect(h.approve(first.proposalId)).rejects.toBeDefined();
    expect(await h.executions('social.variant.schedule', first.proposalId)).toBe(0);
    expect((await status(rejected.variantId))?.status).toBe('approved');

    // The post is edited after it was proposed: the reviewer's approval no longer covers what stands, so the original refuses at the approval and the proposal stays pending.
    const { postId, variantId } = await approved();
    const second = await h.propose(actor, 'social.variant.schedule_approved', { postId, variantIds: [variantId], at });
    const post = await view(postId);
    await exec('social.post.update', { postId, revision: post.revision, body: 'Đổi sau khi duyệt' });
    await expect(h.approve(second.proposalId)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect((await h.proposal(second.proposalId)).status).toBe('pending');
    expect(await h.executions('social.variant.schedule', second.proposalId)).toBe(0);
    expect((await status(variantId))?.status).toBe('draft');

    // Reviewed again, the same proposal now goes through, once.
    await exec('social.post.submit', { postId });
    await exec('social.variant.decide', { postId, decision: 'approved', variants: seen(await view(postId)) });
    await h.approve(second.proposalId);
    expect((await h.proposal(second.proposalId)).status).toBe('executed');
    expect(await h.executions('social.variant.schedule', second.proposalId)).toBe(1);
    expect((await status(variantId))?.status).toBe('scheduled');

    // A key the original does not declare is refused, a choice of time and queue together is the original's own refusal, and a person calling the twin is refused.
    await expect(h.propose(actor, 'social.variant.schedule_approved', { postId, at, approvedBy: 'manager' })).rejects.toBeDefined();
    await expect(h.propose(actor, 'social.variant.schedule_approved', { postId, at, queue: true })).rejects.toBeDefined();
    await expect(exec('social.variant.schedule_approved', { payload: { postId, at } })).rejects.toMatchObject({ status: 403 });
  });
});
