// SPDX-License-Identifier: AGPL-3.0-only
// Issuing a sales e-invoice, the job's half (#2502, ADR-0044 points 3 to 5, plan einvoice-issue.md). The worker runs these as the system for a draft a person's approved issue
// moved to `submitting` (einvoice-issue.ts); the provider calls themselves are the worker's (apps/kernel/src/einvoice-issue-job.ts), with the credential opened there and
// nowhere else.
// - finance.einvoice.job_begin (system; R2 external): locks the draft, decides what the job does next (send, ask the provider by the key, or poll) and commits the call to the
//   external_call ledger BEFORE it is made. A call found `started` or `ambiguous` is never sent again: the job asks the provider by the key first. The seller's tax code on the
//   connection must be the entity's CURRENT one, and the draft's stored amounts must equal what its stored lines compute to; otherwise the draft is `failed` with a code and
//   nothing is sent, and the draft goes back to a draft with the code on screen (it was never sent). A problem on our side with an invoice the provider has or may have (the
//   credential, the connection) never ends it: the draft keeps its state and is asked about again later, until the day is over. A call started a moment ago is in flight and
//   is left alone, and one asked about before its time has come is too.
// - finance.einvoice.job_record (system; R1): writes what came back (issued, pending, still pending, rejected, lost answer, nothing found under the key, failed) into the draft and
//   the call. A rejection sends the draft back to `draft` with a new key (a rejected invoice's key is never reused) and the code on screen. A pending invoice not answered within
//   a day is `failed` with STATUS_UNKNOWN.
// - finance.einvoice.job_files (system; R1): the calls that fetch the signed XML and the PDF, and the two files stored as evidence, linked once to the draft.
// No audit fact, ledger row or error carries a credential, the buyer's data or a provider's own text: ids, codes and counts only.
import { sql } from 'kysely';
import { z } from 'zod';
import type { Db } from '@crove/db';
import type { EInvoiceRequest } from '@crove/einvoice';
import { zId } from '@crove/kernel-contract';
import { defineCommand, type CommandContext } from '@crove/kernel-runtime';
import { money } from '@crove/l10n-vn';
import { AMBIGUOUS_RETRY_SECONDS, EINVOICE_ERROR_CODES, IN_FLIGHT_SECONDS, nextCheckDelaySeconds, rejectionCode, statusDeadlinePassed } from './domain/einvoice-job.ts';
import { computeDraft } from './domain/einvoice-draft.ts';

const plain = (value: string): string => money(value).toFixed();

// A page of the drafts whose time has come (crove_finance.einvoice_due, the worker login's alone), for the worker's sweep, which pages through them all in key order.
export const EINVOICE_DUE_PAGE = 1000;
export async function einvoiceDue(workerDb: Db, after: { orgId: string; draftId: string } | null): Promise<Array<{ orgId: string; draftId: string }>> {
  const { rows } = await sql<{ org_id: string; draft_id: string }>`
    SELECT org_id, draft_id FROM crove_finance.einvoice_due(${after?.orgId ?? null}::uuid, ${after?.draftId ?? null}::uuid, ${EINVOICE_DUE_PAGE}::int)`.execute(workerDb);
  return rows.map((r) => ({ orgId: r.org_id, draftId: r.draft_id }));
}

const issueKey = (draftKey: string) => `einvoice:issue:${draftKey}`;
const statusKey = (draftKey: string, tail: string) => `einvoice:status:${draftKey}:${tail}`;
const filesKey = (draftKey: string) => `einvoice:files:${draftKey}`;

type Safety = 'safe' | 'idempotent' | 'reconcile_only';
type ErrorKind = 'token_expired' | 'permission' | 'bad_request' | 'rate_limited' | 'transient' | 'unknown';

// Records a call as started before it is made: a new row, or, for the same key, the same call made again (only while it has not ended).
async function startCall(ctx: CommandContext, call: { key: string; target: string; step: string; safety: Safety }): Promise<'new' | 'again' | 'closed'> {
  const inserted = await ctx.trx
    .insertInto('crove_kernel.external_call')
    .values({ org_id: ctx.orgId, key: call.key, module: 'finance', target: call.target, step: call.step, retry_safety: call.safety, started_at: ctx.now })
    .onConflict((oc) => oc.columns(['org_id', 'key']).doNothing())
    .returning('id')
    .executeTakeFirst();
  if (inserted) return 'new';
  const again = await ctx.trx
    .updateTable('crove_kernel.external_call')
    .set({ state: 'started', calls: sql<number>`calls + 1`, updated_at: ctx.now })
    .where('org_id', '=', ctx.orgId)
    .where('key', '=', call.key)
    .where('state', 'in', ['started', 'ambiguous'])
    .where('calls', '<', 1000)
    .returning('id')
    .executeTakeFirst();
  return again ? 'again' : 'closed';
}

type CallEnd = { state: 'succeeded'; ref?: string | null } | { state: 'failed'; kind: ErrorKind; code: string } | { state: 'ambiguous'; kind: ErrorKind; code: string };
async function endCall(ctx: CommandContext, key: string, end: CallEnd): Promise<void> {
  const set =
    end.state === 'succeeded'
      ? { state: 'succeeded' as const, external_ref: end.ref ?? null, finished_at: ctx.now, updated_at: ctx.now }
      : end.state === 'failed'
        ? { state: 'failed' as const, error_kind: end.kind, error_code: end.code, finished_at: ctx.now, updated_at: ctx.now }
        : { state: 'ambiguous' as const, error_kind: end.kind, error_code: end.code, updated_at: ctx.now };
  await ctx.trx.updateTable('crove_kernel.external_call').set(set).where('org_id', '=', ctx.orgId).where('key', '=', key).where('state', 'in', ['started', 'ambiguous']).execute();
}

const selectCall = (ctx: CommandContext, key: string) =>
  ctx.trx.selectFrom('crove_kernel.external_call').select(['state', 'calls', 'external_ref', 'updated_at']).where('org_id', '=', ctx.orgId).where('key', '=', key).executeTakeFirst();

const selectDraft = (ctx: CommandContext, draftId: string) =>
  ctx.trx.selectFrom('crove_finance.einvoice_draft').selectAll().where('org_id', '=', ctx.orgId).where('id', '=', draftId.toLowerCase()).forUpdate().executeTakeFirst();
type DraftRow = NonNullable<Awaited<ReturnType<typeof selectDraft>>>;

export type EInvoiceJobBegin =
  | { action: 'none'; reason: string }
  | {
      // files: the invoice is issued and its signed XML is not stored yet (the job was cut off, or the provider's files were not ready).
      action: 'issue' | 'ask' | 'poll' | 'files';
      draftId: string;
      legalEntityId: string;
      // Ludy's idempotency key for the draft, which is also the provider's.
      key: string;
      // The provider's reference, when it has given one.
      ref: string | null;
      connectionId: string;
      channelProvider: string;
      adapter: string;
      request: EInvoiceRequest;
    };

const none = (reason: string): EInvoiceJobBegin => ({ action: 'none', reason });

// A draft that could not be sent, and nothing was: it is `failed` for the code and at once a draft again with a new key, so the person fixes what the code says (a tax code, the
// connection) and issues it again with a new approval; the code stays on the draft until then.
async function releaseDraft(ctx: CommandContext, draft: DraftRow, code: string): Promise<void> {
  await ctx.trx
    .updateTable('crove_finance.einvoice_draft')
    .set({ state: 'failed', error_code: code, next_check_at: null, updated_at: ctx.now })
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', draft.id)
    .execute();
  await ctx.trx
    .updateTable('crove_finance.einvoice_draft')
    .set({ state: 'draft', idempotency_key: sql`pg_catalog.gen_random_uuid()`, provider_ref: null, submitted_at: null, next_check_at: null, check_attempts: 0, updated_at: ctx.now })
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', draft.id)
    .execute();
  ctx.audit({ draftId: draft.id, released: code });
}

// A problem on our side with an invoice the provider has or may have (the credential, the connection): it keeps its state and is asked about again a minute later. Past the day it
// is `failed` with STATUS_UNKNOWN for a person to look at, as for any question that keeps failing.
async function holdDraft(ctx: CommandContext, draft: DraftRow, code: string): Promise<string> {
  if (draft.submitted_at && statusDeadlinePassed(new Date(draft.submitted_at), ctx.now)) {
    await ctx.trx
      .updateTable('crove_finance.einvoice_draft')
      .set({ state: 'failed', error_code: EINVOICE_ERROR_CODES.statusUnknown, next_check_at: null, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', draft.id)
      .execute();
    ctx.audit({ draftId: draft.id, state: 'failed', code: EINVOICE_ERROR_CODES.statusUnknown });
    return 'failed';
  }
  await ctx.trx
    .updateTable('crove_finance.einvoice_draft')
    .set({ error_code: code, next_check_at: new Date(ctx.now.getTime() + AMBIGUOUS_RETRY_SECONDS * 1000), check_attempts: draft.check_attempts + 1, updated_at: ctx.now })
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', draft.id)
    .execute();
  ctx.audit({ draftId: draft.id, held: code });
  return draft.state;
}

// The connection a draft issues through: the entity's own connection to the series' provider, active, and, for a first send, with the seller's tax code the entity has NOW (the
// database checked it only when the connection was made).
export async function connectionFor(ctx: CommandContext, draft: Pick<DraftRow, 'legal_entity_id' | 'series_id'>, first: boolean) {
  const series = draft.series_id
    ? await ctx.trx.selectFrom('crove_finance.einvoice_series').select(['provider', 'template_no', 'symbol']).where('org_id', '=', ctx.orgId).where('id', '=', draft.series_id).executeTakeFirst()
    : undefined;
  if (!series) return { code: EINVOICE_ERROR_CODES.providerNotReady } as const;
  const entity = await ctx.trx.selectFrom('crove_kernel.legal_entity').select(['name', 'tax_code']).where('org_id', '=', ctx.orgId).where('id', '=', draft.legal_entity_id).executeTakeFirst();
  const rows = await ctx.trx
    .selectFrom('crove_finance.einvoice_connection as c')
    .innerJoin('crove_kernel.channel_connection as cc', (join) => join.onRef('cc.org_id', '=', 'c.org_id').onRef('cc.id', '=', 'c.channel_connection_id'))
    .select(['c.channel_connection_id', 'c.provider', 'c.seller_tax_code'])
    .where('c.org_id', '=', ctx.orgId)
    .where('c.legal_entity_id', '=', draft.legal_entity_id)
    .where('c.provider', '=', `einvoice_${series.provider}`)
    .where('cc.status', '=', 'active')
    .orderBy('c.seller_tax_code')
    .execute();
  if (!entity || rows.length === 0) return { code: EINVOICE_ERROR_CODES.providerNotReady } as const;
  // An entity with no tax code of its own issues nothing: the connection's code was typed for the connection alone (the org's tax code is set in Settings).
  if (first && !entity.tax_code) return { code: EINVOICE_ERROR_CODES.taxCodeNeeded } as const;
  const chosen = first ? rows.find((r) => r.seller_tax_code === entity.tax_code) : (rows.find((r) => r.seller_tax_code === entity.tax_code) ?? rows[0]);
  if (!chosen) return { code: EINVOICE_ERROR_CODES.sellerTaxCodeChanged } as const;
  return {
    connectionId: chosen.channel_connection_id,
    channelProvider: chosen.provider,
    adapter: series.provider,
    sellerTaxCode: chosen.seller_tax_code,
    sellerName: entity.name,
    templateNo: series.template_no,
    symbol: series.symbol,
  } as const;
}

// The request as the provider is sent it, from the stored rows only, and whether what is stored equals what its lines compute to.
async function requestFor(ctx: CommandContext, draft: DraftRow, target: { sellerTaxCode: string; sellerName: string; templateNo: string; symbol: string }): Promise<{ request: EInvoiceRequest; consistent: boolean }> {
  const lines = await ctx.trx.selectFrom('crove_finance.einvoice_draft_line').selectAll().where('org_id', '=', ctx.orgId).where('draft_id', '=', draft.id).orderBy('line_no').execute();
  const stored = lines.map((l) => ({
    description: l.description,
    unit: l.unit,
    quantity: plain(l.quantity),
    unitPrice: plain(l.unit_price),
    amount: plain(l.amount),
    vatRate: l.vat_rate,
    vatAmount: plain(l.vat_amount),
  }));
  const computed = computeDraft(stored.map((l) => ({ description: l.description, unit: l.unit, quantity: l.quantity, unitPrice: l.unitPrice, vatRate: l.vatRate })));
  const same = (a: string, b: string) => money(a).equals(money(b));
  const consistent =
    stored.length > 0 &&
    computed.lines.length === stored.length &&
    same(computed.subtotal, draft.subtotal) &&
    same(computed.vatAmount, draft.vat_amount) &&
    same(computed.total, draft.total) &&
    computed.lines.every((l, i) => same(l.amount, stored[i]?.amount ?? '0') && same(l.vatAmount, stored[i]?.vatAmount ?? '0'));
  const request: EInvoiceRequest = {
    key: draft.idempotency_key,
    templateNo: target.templateNo,
    symbol: target.symbol,
    date: typeof draft.invoice_date === 'string' ? draft.invoice_date : new Date(draft.invoice_date).toISOString().slice(0, 10),
    currency: draft.currency,
    seller: { taxCode: target.sellerTaxCode, name: target.sellerName },
    buyer: { kind: draft.buyer_kind, taxCode: draft.buyer_tax_code, name: draft.buyer_name, address: draft.buyer_address, email: draft.buyer_email },
    lines: stored,
    subtotal: plain(draft.subtotal),
    vatAmount: plain(draft.vat_amount),
    total: plain(draft.total),
  };
  return { request, consistent };
}

export const einvoiceJobBegin = defineCommand({
  name: 'finance.einvoice.job_begin',
  input: z.strictObject({ draftId: zId }),
  // Commits the call to the provider that the worker makes next: an effect outside Ludy. A system actor does R2, never R3: the legal act was the person's approved issue.
  risk: 'R2',
  sideEffect: 'external',
  access: 'system',
  handler: async (ctx, input): Promise<EInvoiceJobBegin> => {
    const draft = await selectDraft(ctx, input.draftId);
    if (!draft) return none('NOT_FOUND');
    const filesPending = draft.state === 'issued' && draft.signed_file_id === null;
    if (draft.state !== 'submitting' && draft.state !== 'pending' && !filesPending) return none(`STATE_${draft.state.toUpperCase()}`);
    const issue = await selectCall(ctx, issueKey(draft.idempotency_key));
    let action: 'issue' | 'ask' | 'poll' | 'files';
    if (filesPending) action = 'files';
    else if (draft.state === 'pending') action = 'poll';
    else if (!issue) action = 'issue';
    else if (issue.state === 'started' || issue.state === 'ambiguous') {
      // A send started a moment ago is in flight (or being retried after a crash): the provider is asked about it once it is old enough to have answered or given up.
      if (issue.state === 'started' && ctx.now.getTime() - new Date(issue.updated_at).getTime() < IN_FLIGHT_SECONDS * 1000) return none('IN_FLIGHT');
      action = 'ask';
    } else return none('CALL_ENDED');
    // Never asked faster than the check time the last answer set.
    if (action !== 'files' && draft.next_check_at !== null && new Date(draft.next_check_at).getTime() > ctx.now.getTime()) return none('NOT_DUE');
    const target = await connectionFor(ctx, draft, action === 'issue');
    if ('code' in target) {
      // An issued invoice is never failed: its evidence waits for the connection to be made again. One the provider has or may have is held, never ended; only a send
      // that was never made goes back to a draft.
      if (action === 'issue') await releaseDraft(ctx, draft, target.code);
      else if (action !== 'files') await holdDraft(ctx, draft, target.code);
      return none(target.code);
    }
    const { request, consistent } = await requestFor(ctx, draft, target);
    if (action === 'files') return { action, draftId: draft.id, legalEntityId: draft.legal_entity_id, key: draft.idempotency_key, ref: draft.provider_ref, connectionId: target.connectionId, channelProvider: target.channelProvider, adapter: target.adapter, request };
    if (action === 'issue' && !consistent) {
      await releaseDraft(ctx, draft, EINVOICE_ERROR_CODES.draftMismatch);
      return none(EINVOICE_ERROR_CODES.draftMismatch);
    }
    const provider = target.channelProvider;
    if (action === 'issue') {
      await startCall(ctx, { key: issueKey(draft.idempotency_key), target: provider, step: 'issue', safety: 'reconcile_only' });
    } else if (action === 'ask') {
      // The call was started and never answered: it is ambiguous now, and what is asked next is the provider's record under the key.
      await ctx.trx
        .updateTable('crove_kernel.external_call')
        .set({ state: 'ambiguous', updated_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('key', '=', issueKey(draft.idempotency_key))
        .where('state', '=', 'started')
        .execute();
      await startCall(ctx, { key: statusKey(draft.idempotency_key, `ask:${issue?.calls ?? 1}`), target: provider, step: 'status', safety: 'safe' });
    } else {
      await startCall(ctx, { key: statusKey(draft.idempotency_key, `poll:${draft.check_attempts}`), target: provider, step: 'status', safety: 'safe' });
    }
    ctx.audit({ draftId: draft.id, legalEntityId: draft.legal_entity_id, action });
    return {
      action,
      draftId: draft.id,
      legalEntityId: draft.legal_entity_id,
      key: draft.idempotency_key,
      ref: draft.provider_ref,
      connectionId: target.connectionId,
      channelProvider: provider,
      adapter: target.adapter,
      request,
    };
  },
});

const zIssued = z.strictObject({ outcome: z.literal('issued'), ref: z.string().min(1).max(200), number: z.string().min(1).max(50), signedAt: z.string().min(10).max(40).refine((value) => !Number.isNaN(Date.parse(value)), 'not a date'), taxAuthorityCode: z.string().min(1).max(100).nullable() });
const zRecord = z.discriminatedUnion('outcome', [
  zIssued,
  z.strictObject({ outcome: z.literal('pending'), ref: z.string().min(1).max(200) }),
  z.strictObject({ outcome: z.literal('still_pending') }),
  z.strictObject({ outcome: z.literal('rejected'), ref: z.string().min(1).max(200).nullable(), code: z.enum(['invalid_data', 'series_unknown', 'rejected_by_tax_authority', 'provider_refused']) }),
  // The answer to a send was lost, or the question could not be put: the draft stays as it is and the job asks the provider by the key a minute later.
  z.strictObject({ outcome: z.literal('ambiguous'), kind: z.enum(['unreachable', 'timeout', 'lost_answer', 'unavailable']) }),
  // The provider has no record under the key: the invoice was never made, so the job may send it.
  z.strictObject({ outcome: z.literal('not_found') }),
  z.strictObject({ outcome: z.literal('failed'), code: z.enum(['CREDENTIALS', 'PROVIDER_UNAVAILABLE']) }),
]);

export const einvoiceJobRecord = defineCommand({
  name: 'finance.einvoice.job_record',
  input: z.strictObject({ draftId: zId, step: z.enum(['issue', 'ask', 'poll']), result: zRecord }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx, input): Promise<{ recorded: boolean; state: string; resend?: EInvoiceRequest }> => {
    const draft = await selectDraft(ctx, input.draftId);
    if (!draft || (draft.state !== 'submitting' && draft.state !== 'pending')) return { recorded: false, state: draft?.state ?? 'gone' };
    const result = input.result;
    const issueCall = issueKey(draft.idempotency_key);
    const askKey = async () => statusKey(draft.idempotency_key, `ask:${(await selectCall(ctx, issueCall))?.calls ?? 1}`);
    const pollKey = statusKey(draft.idempotency_key, `poll:${draft.check_attempts}`);
    const closeStatus = async (state: CallEnd) => endCall(ctx, input.step === 'ask' ? await askKey() : pollKey, state);
    const update = (set: Record<string, unknown>) => ctx.trx.updateTable('crove_finance.einvoice_draft').set({ ...set, updated_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', draft.id).execute();

    switch (result.outcome) {
      case 'issued': {
        await update({ state: 'issued', provider_ref: draft.provider_ref ?? result.ref, issued_number: result.number, issued_at: new Date(result.signedAt), authority_code: result.taxAuthorityCode, error_code: null, next_check_at: null });
        if (input.step !== 'poll') await endCall(ctx, issueCall, { state: 'succeeded', ref: result.ref });
        if (input.step !== 'issue') await closeStatus({ state: 'succeeded' });
        ctx.audit({ draftId: draft.id, state: 'issued' });
        return { recorded: true, state: 'issued' };
      }
      case 'pending': {
        await update({ state: 'pending', provider_ref: draft.provider_ref ?? result.ref, error_code: null, check_attempts: 1, next_check_at: new Date(ctx.now.getTime() + nextCheckDelaySeconds(0) * 1000) });
        if (input.step !== 'poll') await endCall(ctx, issueCall, { state: 'succeeded', ref: result.ref });
        if (input.step !== 'issue') await closeStatus({ state: 'succeeded' });
        ctx.audit({ draftId: draft.id, state: 'pending' });
        return { recorded: true, state: 'pending' };
      }
      case 'still_pending': {
        await closeStatus({ state: 'succeeded' });
        // Asked for a day and still no answer the adapter can map: failed, shown to a person.
        if (draft.submitted_at && statusDeadlinePassed(new Date(draft.submitted_at), ctx.now)) {
          await update({ state: 'failed', error_code: EINVOICE_ERROR_CODES.statusUnknown, next_check_at: null });
          ctx.audit({ draftId: draft.id, state: 'failed', code: EINVOICE_ERROR_CODES.statusUnknown });
          return { recorded: true, state: 'failed' };
        }
        const attempts = draft.check_attempts + 1;
        await update({ check_attempts: attempts, next_check_at: new Date(ctx.now.getTime() + nextCheckDelaySeconds(attempts) * 1000) });
        return { recorded: true, state: draft.state };
      }
      case 'rejected': {
        const code = rejectionCode(result.code);
        // Rejected, and at once back to a draft with a new key, no reference and a clean slate: the person fixes it and issues again; the code stays on the draft.
        await update({ state: 'rejected', provider_ref: draft.provider_ref ?? result.ref, error_code: code, next_check_at: null });
        await update({ state: 'draft', idempotency_key: sql`pg_catalog.gen_random_uuid()`, provider_ref: null, submitted_at: null, next_check_at: null, check_attempts: 0 });
        if (input.step !== 'poll') await endCall(ctx, issueCall, { state: 'failed', kind: 'bad_request', code });
        if (input.step !== 'issue') await closeStatus({ state: 'succeeded' });
        ctx.audit({ draftId: draft.id, state: 'rejected', code });
        return { recorded: true, state: 'draft' };
      }
      case 'ambiguous': {
        // The draft stays as it is; the issue call (if that was the step) stays ambiguous, and the next try asks first.
        if (input.step === 'issue') await endCall(ctx, issueCall, { state: 'ambiguous', kind: result.kind === 'unreachable' || result.kind === 'timeout' ? 'transient' : 'unknown', code: result.kind.toUpperCase() });
        else await closeStatus({ state: 'ambiguous', kind: 'transient', code: result.kind.toUpperCase() });
        // A question that keeps failing is held to the same day as one that keeps answering `pending`: past it the invoice is `failed` with STATUS_UNKNOWN, for a person to look at.
        if (draft.submitted_at && statusDeadlinePassed(new Date(draft.submitted_at), ctx.now)) {
          await update({ state: 'failed', error_code: EINVOICE_ERROR_CODES.statusUnknown, next_check_at: null });
          ctx.audit({ draftId: draft.id, state: 'failed', code: EINVOICE_ERROR_CODES.statusUnknown });
          return { recorded: true, state: 'failed' };
        }
        await update({ next_check_at: new Date(ctx.now.getTime() + AMBIGUOUS_RETRY_SECONDS * 1000), check_attempts: draft.check_attempts + 1 });
        ctx.audit({ draftId: draft.id, ambiguous: result.kind });
        return { recorded: true, state: draft.state };
      }
      case 'not_found': {
        // Asked by the key and the provider has nothing: the send never happened. The call goes back to started, made again, and the request is handed back to send.
        await closeStatus({ state: 'succeeded' });
        const again = await ctx.trx
          .updateTable('crove_kernel.external_call')
          .set({ state: 'started', calls: sql<number>`calls + 1`, updated_at: ctx.now })
          .where('org_id', '=', ctx.orgId)
          .where('key', '=', issueCall)
          .where('state', 'in', ['started', 'ambiguous'])
          .where('calls', '<', 1000)
          .returning('id')
          .executeTakeFirst();
        if (!again) return { recorded: false, state: draft.state };
        // The provider has nothing under the key, so nothing was sent: what stops the send now returns the draft to a draft.
        const target = await connectionFor(ctx, draft, true);
        if ('code' in target) {
          await endCall(ctx, issueCall, { state: 'failed', kind: 'permission', code: target.code });
          await releaseDraft(ctx, draft, target.code);
          return { recorded: true, state: 'draft' };
        }
        const { request, consistent } = await requestFor(ctx, draft, target);
        if (!consistent) {
          await endCall(ctx, issueCall, { state: 'failed', kind: 'bad_request', code: EINVOICE_ERROR_CODES.draftMismatch });
          await releaseDraft(ctx, draft, EINVOICE_ERROR_CODES.draftMismatch);
          return { recorded: true, state: 'draft' };
        }
        return { recorded: true, state: draft.state, resend: request };
      }
      case 'failed': {
        const kind = result.code === 'CREDENTIALS' ? 'permission' : 'transient';
        if (input.step === 'issue') {
          // The send was refused before it was made: nothing was sent, so the draft goes back to a draft with the code on screen.
          await endCall(ctx, issueCall, { state: 'failed', kind, code: result.code });
          await releaseDraft(ctx, draft, result.code);
          return { recorded: true, state: 'draft' };
        }
        // A question to the provider about an invoice it has or may have: our problem (the credential) never ends the invoice. It is asked about again later.
        await closeStatus({ state: 'ambiguous', kind, code: result.code });
        return { recorded: true, state: await holdDraft(ctx, draft, result.code) };
      }
    }
  },
});

export const einvoiceJobFiles = defineCommand({
  name: 'finance.einvoice.job_files',
  input: z.strictObject({
    draftId: zId,
    step: z.discriminatedUnion('kind', [
      // The call that fetches the files is committed before it is made; it is a read, safe to make again.
      z.strictObject({ kind: z.literal('begin') }),
      // The two files are stored and linked to the draft, once.
      z.strictObject({ kind: z.literal('stored'), signedFileId: zId, pdfFileId: zId.nullable() }),
      z.strictObject({ kind: z.literal('failed') }),
    ]),
  }),
  risk: 'R2',
  sideEffect: 'external',
  access: 'system',
  handler: async (ctx, input): Promise<{ ok: boolean; ref: string | null; signedFileId: string | null }> => {
    const draft = await selectDraft(ctx, input.draftId);
    if (!draft || draft.state !== 'issued') return { ok: false, ref: null, signedFileId: null };
    const key = filesKey(draft.idempotency_key);
    const target = await ctx.trx
      .selectFrom('crove_finance.einvoice_connection')
      .select('provider')
      .where('org_id', '=', ctx.orgId)
      .where('legal_entity_id', '=', draft.legal_entity_id)
      .executeTakeFirst();
    const step = input.step;
    if (step.kind === 'begin') {
      if (draft.signed_file_id) return { ok: false, ref: draft.provider_ref, signedFileId: draft.signed_file_id };
      await startCall(ctx, { key, target: target?.provider ?? 'einvoice', step: 'files', safety: 'safe' });
      return { ok: true, ref: draft.provider_ref, signedFileId: null };
    }
    if (step.kind === 'failed') {
      await endCall(ctx, key, { state: 'ambiguous', kind: 'transient', code: 'FILES_UNAVAILABLE' });
      await ctx.trx.updateTable('crove_finance.einvoice_draft').set({ error_code: 'FILES_UNAVAILABLE', updated_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', draft.id).execute();
      return { ok: false, ref: draft.provider_ref, signedFileId: null };
    }
    await ctx.trx
      .updateTable('crove_finance.einvoice_draft')
      .set({ signed_file_id: step.signedFileId, pdf_file_id: step.pdfFileId, error_code: null, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', draft.id)
      .execute();
    await endCall(ctx, key, { state: 'succeeded', ref: draft.provider_ref });
    ctx.audit({ draftId: draft.id, filesStored: true });
    return { ok: true, ref: draft.provider_ref, signedFileId: step.signedFileId };
  },
});

export const einvoiceJobCommands = [einvoiceJobBegin, einvoiceJobRecord, einvoiceJobFiles];
