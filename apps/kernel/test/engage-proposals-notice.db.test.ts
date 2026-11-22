// SPDX-License-Identifier: AGPL-3.0-only
// The notice of an AI coworker's proposal (epic #3857, E5, issue #4180; ADR-0051 decision 10, owner decision 2026-11-19, "Cho làm, việc lớn chờ duyệt"): the worker's pass tells the people who may approve a pending
// proposal of an MCP grant, once, with the notification the Inbox and the bell already use. Who is told (owners and admins, the person who connected the app held back by four-eyes where another approver
// exists, nobody who is a member or a viewer), one per proposal whatever the passes, none for a refused call (the cap), none left over for a decided proposal, and no text of the call in it.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sweepMcpProposalNotices, upsertIdentity, type NotificationItem } from '@ludy/kernel';
import { ADMIN, startHarness, type Harness } from './engage-proposals-harness.ts';

const suite = ADMIN ? describe : describe.skip;
const REPLY = 'kernel.conversation.reply_approved';
// A line only this customer-facing text has; it must reach no notification.
const SECRET = 'Dạ giá riêng cho chị Lan là 99k ạ';

suite('the notice of an AI coworker\'s proposal (#4180)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness('engage_notice');
  }, 300_000);
  afterAll(async () => {
    await h?.stop();
  });

  const reply = (text = SECRET) => ({ conversationId: randomUUID(), body: text, lastSeenSeq: 1 });
  const pass = () => sweepMcpProposalNotices({ runtime: h.worker, workerDb: h.workerDb });
  const rows = async (proposalId?: string) =>
    (await h.q<{ user_id: string; kind: string; subject_id: string; detail: Record<string, unknown>; org_id: string }>(
      `SELECT user_id, kind, subject_id, detail, org_id FROM crove_kernel.notification WHERE org_id = $1 AND kind = 'kernel.approval_waiting' AND ($2::uuid IS NULL OR subject_id = $2) ORDER BY user_id`,
      [h.orgId, proposalId ?? null],
    )).rows;
  const told = async (proposalId: string) => (await h.q<{ at: Date | null }>('SELECT approvers_told_at AS at FROM crove_kernel.proposal WHERE org_id = $1 AND id = $2', [h.orgId, proposalId])).rows[0]?.at ?? null;
  const person = async (role: 'admin' | 'member' | 'viewer') => {
    const id = await upsertIdentity(h.db, { issuer: 'engage-notice', subject: `${role}-${randomUUID()}`, email: `${role}-${randomUUID().slice(0, 8)}@engage-notice.test`, name: role });
    await h.q('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [h.orgId, id, role]);
    return id;
  };
  const listFor = (userId: string) => h.runtime.query<{ items: NotificationItem[]; unread: number }>('kernel.notification.list', {}, { actor: h.person(userId), orgId: h.orgId });

  it('tells a sole owner who connected the app, once: the one-person path of four-eyes, the same notification a proposal of a person makes', async () => {
    const { actor } = await h.grant();
    const made = await h.propose(actor, REPLY, reply());
    // The proposal is made in the sealed context: no notification yet, and not stamped.
    expect(await rows(made.proposalId)).toEqual([]);
    expect(await told(made.proposalId)).toBeNull();
    expect(await pass()).toBe(1);
    const got = await rows(made.proposalId);
    expect(got.map((r) => [r.user_id, r.kind, r.subject_id])).toEqual([[h.owner, 'kernel.approval_waiting', made.proposalId]]);
    expect(await told(made.proposalId)).not.toBeNull();
    // Another pass, a replay of the command and a second sweep write nothing more.
    expect(await pass()).toBe(0);
    expect(await h.system('kernel.mcp.proposal_notify', 'kernel.mcp.proposal_notify', { proposalId: made.proposalId })).toEqual({ sent: 0 });
    expect(await rows(made.proposalId)).toHaveLength(1);
  });

  it('tells each owner and admin and nobody else, the person who connected the app held back once another approver exists; a second proposal is a second notice', async () => {
    const owner2 = await h.addOwner();
    const admin = await person('admin');
    const member = await person('member');
    const viewer = await person('viewer');
    const { actor } = await h.grant();
    const first = await h.propose(actor, REPLY, reply());
    expect(await pass()).toBe(1);
    // The grantor (h.owner) is an author, and two others may approve: they are told, the grantor is not.
    expect((await rows(first.proposalId)).map((r) => r.user_id).sort()).toEqual([owner2, admin].sort());
    for (const nobody of [member, viewer, h.owner]) expect((await rows(first.proposalId)).map((r) => r.user_id), nobody).not.toContain(nobody);
    const second = await h.propose(actor, REPLY, reply('Dạ vâng'));
    expect(await pass()).toBe(1);
    expect((await rows(second.proposalId)).map((r) => r.user_id).sort()).toEqual([owner2, admin].sort());
    expect(await rows(first.proposalId)).toHaveLength(2);
    // Only members of this org, whatever else exists.
    const members = new Set((await h.q<{ user_id: string }>('SELECT user_id FROM crove_kernel.tenant_member WHERE org_id = $1', [h.orgId])).rows.map((r) => r.user_id));
    for (const r of await rows()) {
      expect(r.org_id).toBe(h.orgId);
      expect(members.has(r.user_id)).toBe(true);
    }
    // The person told sees it in the bell, unread, with the card's title (an AI app's, as the database built it) and none of what the call wrote.
    const seen = await listFor(admin);
    const item = seen.items.find((i) => i.subjectId === first.proposalId);
    expect(item).toMatchObject({ kind: 'kernel.approval_waiting', subjectType: 'kernel.proposal', read: false });
    expect(item?.detail.title).toMatch(/^Ứng dụng AI “Dy” đề xuất: /);
    expect(JSON.stringify(item)).not.toContain('99k');
    // A member and a viewer see nothing of it.
    expect((await listFor(member)).items).toEqual([]);
    expect((await listFor(viewer)).items).toEqual([]);
  });

  it('puts no text of the call in the notification: the row holds ids and an empty detail, and the proposal\'s own text is nowhere in what a person is told', async () => {
    const { actor } = await h.grant();
    const made = await h.propose(actor, REPLY, reply());
    await pass();
    const all = await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM crove_kernel.notification WHERE org_id = $1 AND (detail::text LIKE '%99k%' OR detail::text LIKE '%Lan%')`, [h.orgId]);
    expect(all.rows[0]?.n).toBe(0);
    for (const r of await rows(made.proposalId)) expect(r.detail).toEqual({});
  });

  it('settles it with the decision: an approved or rejected proposal leaves no unread notice', async () => {
    const admin = await person('admin');
    const { actor } = await h.grant();
    const made = await h.propose(actor, REPLY, reply());
    await pass();
    const before = (await listFor(admin)).items.find((i) => i.subjectId === made.proposalId);
    expect(before?.read).toBe(false);
    await h.reject(made.proposalId, admin);
    const after = (await listFor(admin)).items.find((i) => i.subjectId === made.proposalId);
    expect(after?.read).toBe(true);
    // A proposal decided before the pass got to it is never told: the scan does not even offer it.
    const quick = await h.propose(actor, REPLY, reply());
    await h.reject(quick.proposalId, admin);
    expect(await pass()).toBe(0);
    expect(await rows(quick.proposalId)).toEqual([]);
  });

  it('never keeps a stamp a sealed insert brought: the database starts every row of a grant not told, so a row cannot silence its own notice', async () => {
    const { actor } = await h.grant();
    const made = await h.propose(actor, REPLY, reply());
    // The same row inserted again with the stamp set, as a writer that could set it would (the test's own login, so only the trigger is in the way).
    const copy = randomUUID();
    const c = new pg.Client({ connectionString: h.adminUrl });
    await c.connect();
    try {
      await c.query('CREATE TEMP TABLE one AS SELECT * FROM crove_kernel.proposal WHERE org_id = $1 AND id = $2', [h.orgId, made.proposalId]);
      await c.query('UPDATE one SET id = $1, approvers_told_at = now()', [copy]);
      await c.query('INSERT INTO crove_kernel.proposal SELECT * FROM one');
    } finally {
      await c.end();
    }
    expect(await told(copy)).toBeNull();
    expect(await pass()).toBe(2);
    expect(await told(copy)).not.toBeNull();
    expect((await rows(copy)).length).toBeGreaterThan(0);
  });

  it('honours the kind the person turned off, and a refused call (the cap) makes no notification', async () => {
    // Its own people, so the test stands alone: a second owner and an admin who are told, and an admin who turned the kind off.
    const owner2 = await h.addOwner();
    const quiet = await person('admin');
    await h.runtime.execute('kernel.notification.mute', { kind: 'kernel.approval_waiting', muted: true }, { actor: h.person(quiet), orgId: h.orgId });
    const { grantId, actor } = await h.grant();
    // 20 pending proposals of a grant is the cap; the 21st is refused and leaves nothing.
    const made: string[] = [];
    for (let i = 0; i < 20; i++) made.push((await h.propose(actor, REPLY, reply(`Dạ ${i}`))).proposalId);
    await expect(h.propose(actor, REPLY, reply('thứ 21'))).rejects.toMatchObject({ code: 'MCP_PROPOSAL_CAP' });
    const pending = (await h.q<{ n: number }>("SELECT count(*)::int AS n FROM crove_kernel.proposal WHERE org_id = $1 AND requested_by_grant = $2 AND status = 'pending'", [h.orgId, grantId])).rows[0]?.n;
    expect(pending).toBe(20);
    expect(await pass()).toBe(20);
    expect((await rows()).filter((r) => r.user_id === quiet)).toEqual([]);
    // Everyone who may approve and is not the grantor (held back) and did not turn the kind off: the same people for each of the 20.
    const told = (await h.q<{ user_id: string }>("SELECT user_id FROM crove_kernel.tenant_member WHERE org_id = $1 AND role IN ('owner', 'admin') AND user_id NOT IN ($2, $3)", [h.orgId, h.owner, quiet])).rows.map((r) => r.user_id);
    expect(told).toContain(owner2);
    for (const id of made) expect((await rows(id)).map((r) => r.user_id).sort(), id).toEqual([...told].sort());
    expect((await rows()).filter((r) => made.includes(r.subject_id))).toHaveLength(20 * told.length);
    // Nothing is left for the next pass.
    expect(await pass()).toBe(0);
  }, 120_000);
});
