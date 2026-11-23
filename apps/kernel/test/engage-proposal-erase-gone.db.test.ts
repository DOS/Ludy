// SPDX-License-Identifier: AGPL-3.0-only
// What erasing a thread does to the proposals an AI coworker made about it (#4160 L3, L5 and the review note on the definer; #4168 item 1 for the taint keys of an org purge):
// - ludy_kernel.engage_proposal_erase_gone() runs after the delete and takes no ids: it blanks only a proposal whose thread or message is gone, so a live thread's proposals are out of its reach;
// - one audit row per proposal blanked, with ids and the state before and nothing of the text, and the note a person typed when rejecting is replaced;
// - only an owner, an admin or the system may call it;
// - the taint keys of deleted quote lines are recorded for a person's save and not at all in the system context (the org purge).
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ConversationEvent, ConversationIngested, Deal, Quote } from '@ludy/kernel-contract';
import { kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { Runtime, defineCommand } from '@ludy/kernel-runtime';
import { crmCommands, crmQueries } from '@ludy/mod-crm';
import { ADMIN, ENGAGE_SCOPE, startHarness, type Harness } from './engage-proposals-harness.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const suite = ADMIN ? describe : describe.skip;

// Test-only commands: the definer as a person's command runs it (any role may reach the command, the definer decides), and the quote-line delete of a purge, as a person and as the system, answering the
// transaction-local setting that carries the taint keys.
const eraseGone = defineCommand({
  name: 'kernel.erase_gone_test.run',
  input: z.strictObject({}),
  risk: 'R1',
  sideEffect: 'internal',
  access: ['owner', 'admin', 'member', 'viewer'],
  handler: async (ctx) => {
    const { sql } = await import('kysely');
    const { rows } = await sql<{ n: number }>`SELECT ludy_kernel.engage_proposal_erase_gone() AS n`.execute(ctx.trx);
    return { n: rows[0]?.n ?? 0 };
  },
});
// The old function with ids stays as a stub that refuses, so a process of the previous release fails its erasure instead of blanking on the ids it passes.
const eraseOld = defineCommand({
  name: 'kernel.erase_gone_test.old',
  input: z.strictObject({}),
  risk: 'R1',
  sideEffect: 'internal',
  access: ['owner', 'admin'],
  handler: async (ctx) => {
    const { sql } = await import('kysely');
    await sql`SELECT ludy_kernel.engage_proposal_erase(ARRAY[]::uuid[], ARRAY[]::uuid[])`.execute(ctx.trx);
    return {};
  },
});
const dropLines = async (ctx: { trx: never; orgId: string }, quoteId: string) => {
  const { sql } = await import('kysely');
  await sql`DELETE FROM ludy_crm.quote_line WHERE org_id = ${ctx.orgId}::uuid AND quote_id = ${quoteId}::uuid`.execute(ctx.trx);
  const { rows } = await sql<{ k: string }>`SELECT COALESCE(pg_catalog.current_setting('ludy.tainted_line_keys', true), '') AS k`.execute(ctx.trx);
  return { keys: rows[0]?.k ?? '' };
};
const input = z.strictObject({ quoteId: z.string().uuid() });
const dropAsPerson = defineCommand({ name: 'kernel.taint_keys_test.person', input, risk: 'R1', sideEffect: 'internal', access: ['owner'], handler: (ctx, i) => dropLines(ctx as never, i.quoteId) });
const dropAsSystem = defineCommand({ name: 'kernel.taint_keys_test.system', input, risk: 'R1', sideEffect: 'internal', access: 'system', handler: (ctx, i) => dropLines(ctx as never, i.quoteId) });

suite('the erasure of an AI coworker\'s proposals, and the taint keys of the org purge (#4160, #4168)', () => {
  let h: Harness;
  let app: Runtime;
  let worker: Runtime;
  let connectionId = '';
  let tick = 0;
  beforeAll(async () => {
    h = await startHarness('engage_erase_gone');
    const make = (db: typeof h.db) =>
      new Runtime(db, { manifests: TEST_MANIFESTS }).register({
        commands: [...kernelCommands, ...crmCommands, eraseGone, eraseOld, dropAsPerson, dropAsSystem],
        queries: [...kernelQueries({ inboundDomain: null }), ...crmQueries],
      });
    app = make(h.db);
    worker = make(h.workerDb);
    connectionId = randomUUID();
    await h.q("INSERT INTO ludy_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'sandbox', $3, 'Kênh thử', $4)", [h.orgId, connectionId, `acct-${connectionId.slice(0, 8)}`, h.owner]);
  }, 300_000);
  afterAll(async () => {
    await h?.stop();
  });

  async function comment(text: string) {
    tick += 1;
    const threadId = `thread-${randomUUID().slice(0, 8)}`;
    const event: ConversationEvent = { kind: 'comment_thread', threadId, postId: 'post-1', messageId: `m-${threadId}`, direction: 'in', contact: { id: `u-${tick}-${threadId}`, name: 'Trần Thị Khách' }, text, at: new Date(Date.UTC(2026, 10, 1, 10, tick)).toISOString() };
    await h.system<ConversationIngested>('conversations', 'kernel.conversation.ingest', { connectionId, events: [event] });
    return (await h.q<{ id: string }>('SELECT id FROM ludy_kernel.conversation WHERE org_id = $1 AND channel_connection_id = $2 AND external_thread_id = $3', [h.orgId, connectionId, threadId])).rows[0]?.id as string;
  }
  const erase = (conversationId: string) => h.runtime.execute('kernel.conversation.erase_contact', { conversationId, confirm: true }, { actor: h.person(h.owner, true), orgId: h.orgId });
  const audits = async () => (await h.q<{ target_id: string; detail: Record<string, unknown>; outcome: string }>(`SELECT target_id, detail, outcome FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.engage.proposal_erased'`, [h.orgId])).rows;

  it('writes one audit row per proposal it blanks, with ids and the state before and none of the text, and replaces the note a person typed', async () => {
    const waitingThread = await comment('Số của mình là 0912345678');
    const decidedThread = await comment('Đơn giao ở 12 Lê Lợi nhé');
    const { actor } = await h.grant();
    const waiting = await h.propose(actor, 'kernel.conversation.reply_approved', { conversationId: waitingThread, body: 'Em gọi 0912345678 nhé', lastSeenSeq: 1 });
    const decided = await h.propose(actor, 'kernel.conversation.reply_approved', { conversationId: decidedThread, body: 'Giao tới 12 Lê Lợi ạ', lastSeenSeq: 1 });
    await h.reject(decided.proposalId);
    // The note a person typed when rejecting may quote the text.
    await h.q("UPDATE ludy_kernel.proposal SET decision_note = 'đừng gửi 12 Lê Lợi' WHERE org_id = $1 AND id = $2", [h.orgId, decided.proposalId]);
    const before = (await audits()).length;
    await erase(waitingThread);
    await erase(decidedThread);
    const rows = (await audits()).slice(before);
    expect(rows.map((r) => r.target_id).sort()).toEqual([waiting.proposalId, decided.proposalId].sort());
    expect(rows.every((r) => r.outcome === 'ok')).toBe(true);
    expect(rows.find((r) => r.target_id === waiting.proposalId)?.detail).toEqual({ proposalId: waiting.proposalId, was: 'pending' });
    expect(rows.find((r) => r.target_id === decided.proposalId)?.detail).toEqual({ proposalId: decided.proposalId, was: 'rejected' });
    expect(JSON.stringify(rows)).not.toMatch(/0912345678|Lê Lợi/);
    const note = async (id: string) => (await h.q<{ decision_note: string | null }>('SELECT decision_note FROM ludy_kernel.proposal WHERE org_id = $1 AND id = $2', [h.orgId, id])).rows[0]?.decision_note;
    expect(await note(decided.proposalId)).toBe('erased');
    expect(await note(waiting.proposalId)).toBe('conversation erased');
    // Run again: nothing is left to blank, so nothing more is written.
    const result = await app.execute<{ n: number }>('kernel.erase_gone_test.run', {}, { actor: h.person(h.owner), orgId: h.orgId });
    expect(result.n).toBe(0);
    expect((await audits()).length).toBe(before + 2);
  });

  it('cannot reach the proposals of a thread that is still there: a person who calls it blanks nothing of a live thread', async () => {
    const thread = await comment('Cho mình hỏi giá 250k đúng không?');
    const { actor } = await h.grant();
    const made = await h.propose(actor, 'kernel.conversation.reply_approved', { conversationId: thread, body: 'Dạ đúng 250k ạ', lastSeenSeq: 1 });
    const result = await app.execute<{ n: number }>('kernel.erase_gone_test.run', {}, { actor: h.person(h.owner), orgId: h.orgId });
    expect(result.n).toBe(0);
    const row = await h.proposal(made.proposalId);
    expect(row.status).toBe('pending');
    expect(row.payload).toMatchObject({ conversationId: thread, body: 'Dạ đúng 250k ạ' });
  });

  it('keeps the old id-taking function as a stub that refuses', async () => {
    await expect(app.execute('kernel.erase_gone_test.old', {}, { actor: h.person(h.owner), orgId: h.orgId })).rejects.toBeDefined();
  });

  it('is for an owner, an admin or the system: a member and a viewer are refused', async () => {
    for (const role of ['member', 'viewer'] as const) {
      const user = await upsertIdentity(h.db, { issuer: 'engage-erase-gone', subject: `${role}-${randomUUID()}`, email: `${role}-${randomUUID().slice(0, 8)}@engage-erase-gone.test`, name: role });
      await h.q('INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [h.orgId, user, role]);
      // The command lets every role reach it; the 403 is the definer's own refusal (42501), mapped by the runtime.
      await expect(app.execute('kernel.erase_gone_test.run', {}, { actor: h.person(user), orgId: h.orgId }), role).rejects.toMatchObject({ status: 403 });
    }
  });

  describe('the taint keys of deleted quote lines', () => {
    async function taintedQuote(label: string) {
      const dy = (await h.grant([ENGAGE_SCOPE])).actor;
      const party = await h.runtime.execute<{ partyId: string }>('kernel.mcp.party_create', { kind: 'organization', name: `Công ty ${label}` }, { actor: dy, orgId: h.orgId });
      const deal = await h.runtime.execute<Deal>('crm.deal.create', { partyId: party.partyId, title: `Cơ hội ${label}`, amount: '1000000', expectedClose: null }, { actor: h.person(h.owner), orgId: h.orgId });
      const made = await h.runtime.execute<Quote>('crm.mcp.quote_save', { dealId: deal.id, lines: [] }, { actor: dy, orgId: h.orgId });
      const lines = [1, 2, 3].map((n) => ({ kind: 'item' as const, description: `Dòng ${label} ${n}`, quantity: '1', unitPrice: '100000', vatRate: '10' }));
      return h.runtime.execute<Quote>('crm.mcp.quote_save', { quoteId: made.id, version: made.version, lines }, { actor: dy, orgId: h.orgId });
    }

    it('are recorded when a person deletes tainted lines, so a replacement in the same transaction stays tainted (the control)', async () => {
      const quote = await taintedQuote('người');
      const out = await app.execute<{ keys: string }>('kernel.taint_keys_test.person', { quoteId: quote.id }, { actor: h.person(h.owner), orgId: h.orgId });
      expect(out.keys.split(',').filter(Boolean)).toHaveLength(3);
    });

    it('are not recorded at all in the system context: an org purge deleting many tainted lines does no per-row work on them', async () => {
      const quote = await taintedQuote('hệ thống');
      const out = await worker.execute<{ keys: string }>('kernel.taint_keys_test.system', { quoteId: quote.id }, { actor: { type: 'system', component: 'taint-keys-test' }, orgId: h.orgId });
      expect(out.keys).toBe('');
    });
  });
});
