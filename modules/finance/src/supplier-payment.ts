// SPDX-License-Identifier: AGPL-3.0-only
// A payment to a supplier approved in Ludy (#3113 S2, #3699; JOY's answers of 2026-11-14 on #3113). Ludy moves no money: an owner or an admin approves paying one received invoice to the bank
// account they saw, and the bank file and the bank-line match (S3) follow. What keeps the approved amount from going to an account the approver did not see lives in the database
// (migration 20270115130000: the 24-hour hold of a single owner or admin with a new account, `stale` when the account changes, `paid` only after the hold and to the pinned account); these
// commands feed and read it.
// - finance.supplier_payment.prepare (owners and admins; R1): checks the invoice and the supplier's one active account and builds the request for approval. It writes nothing;
//   kernel.proposal.request stores the proposal. One live payment or open request per invoice.
// - finance.supplier_payment.record (R3, a proposal command: runs only through kernel.proposal.approve, as the approver, in the approving transaction; owners and admins approve, with four-eyes and
//   the one-person path judged on the members now): re-reads the invoice and the account and refuses a request whose account is no longer the one it showed ("approve what you saw"), then
//   writes the payment as `approved`, pinning the account and the hash of its number. The database sets the hold.
// - finance.supplier_payment.confirm_account (R3, owners and admins): marks that the supplier confirmed the account by a channel known beforehand. Evidence only; it never shortens the hold.
// - finance.supplier_payment.cancel (R2, owners and admins): an approved payment is cancelled with a reason (it can then be asked for again).
// - finance.supplier_payment.list: the payments of the org or of one supplier (never a number). finance.signals.supplier_payments_waiting: rule 3's second read, ids and days only.
// Agents never run any of these.
import {
  SIGNALS_MAX_CRM,
  SIGNAL_PARTIAL_VIEW_CODE,
  SUPPLIER_PAYMENT_COMMAND,
  SUPPLIER_PAYMENT_KIND,
  zSupplierPaymentCancel,
  zSupplierPaymentConfirm,
  zSupplierPaymentListInput,
  zSupplierPaymentPayload,
  zSupplierPaymentPrepare,
  zSupplierPaymentRecord,
  zSupplierPaymentsWaiting,
  type SupplierPayment,
  type SupplierPaymentWaiting,
} from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { sql } from 'kysely';
import { z } from 'zod';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@crove/kernel-runtime';
import { money } from '@crove/l10n-vn';

const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];
const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

type Trx = CommandContext['trx'];

const iso = (value: Date | string | null): string | null => (value === null ? null : new Date(value).toISOString());
const day = (value: Date | string): string => new Date(new Date(value).getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
const changed = () => new DomainError('SUPPLIER_PAYMENT_CHANGED', 409, 'Tài khoản hoặc hóa đơn đã thay đổi từ lúc đề xuất này được tạo; hãy tạo đề xuất mới');

// The invoice a payment is for: a purchase of the org (not a sale), not voided.
async function loadInvoice(trx: Trx, orgId: string, id: string) {
  const doc = await trx
    .selectFrom('crove_finance.purchase_document as d')
    .select(['d.id', 'd.party_id', 'd.total', 'd.currency', 'd.legal_entity_id', 'd.direction'])
    .where('d.org_id', '=', orgId)
    .where('d.id', '=', id.toLowerCase())
    .where(sql<boolean>`NOT EXISTS (SELECT 1 FROM crove_finance.purchase_document_void v WHERE v.org_id = d.org_id AND v.document_id = d.id)`)
    .executeTakeFirst();
  if (!doc || doc.direction !== 'purchase') throw new DomainError('SUPPLIER_PAYMENT_INVOICE_NOT_FOUND', 404, 'Không tìm thấy hóa đơn mua vào này');
  return doc;
}

// The supplier's active account: exactly one, so the approver is never asked to choose between two.
async function activeAccount(trx: Trx, orgId: string, partyId: string) {
  const rows = await trx
    .selectFrom('crove_finance.supplier_bank_account')
    .select(['id', 'bank_name', 'last4', 'number_hash', 'hash_key_id', 'created_at'])
    .where('org_id', '=', orgId)
    .where('party_id', '=', partyId)
    .where('status', '=', 'active')
    .execute();
  if (rows.length === 0) throw new DomainError('SUPPLIER_PAYMENT_NO_ACCOUNT', 409, 'Nhà cung cấp này chưa có tài khoản ngân hàng; hãy thêm tài khoản trước');
  if (rows.length > 1) throw new DomainError('SUPPLIER_PAYMENT_ACCOUNT_AMBIGUOUS', 409, 'Nhà cung cấp này có nhiều tài khoản đang dùng; hãy ngừng các tài khoản cũ trước');
  return rows[0] as NonNullable<(typeof rows)[number]>;
}

// One live payment per invoice and one open request: a second is refused, with the first named.
async function refuseDuplicate(ctx: CommandContext, invoiceId: string): Promise<void> {
  await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`${SUPPLIER_PAYMENT_COMMAND}:${invoiceId}`}, 0))`.execute(ctx.trx);
  const live = await ctx.trx
    .selectFrom('crove_finance.supplier_payment')
    .select('id')
    .where('org_id', '=', ctx.orgId)
    .where('purchase_document_id', '=', invoiceId)
    .where('status', 'in', ['approved', 'paid'])
    .executeTakeFirst();
  if (live) throw new DomainError('SUPPLIER_PAYMENT_EXISTS', 409, 'Hóa đơn này đã có khoản chi được duyệt');
  const open = await ctx.trx
    .selectFrom('crove_kernel.proposal')
    .select('id')
    .where('org_id', '=', ctx.orgId)
    .where('command', '=', SUPPLIER_PAYMENT_COMMAND)
    .where('status', '=', 'pending')
    .where(sql<string>`pg_catalog.lower(payload->>'purchaseDocumentId')`, '=', invoiceId)
    .executeTakeFirst();
  if (open) throw new DomainError('SUPPLIER_PAYMENT_PENDING', 409, 'Hóa đơn này đã có đề xuất chi đang chờ duyệt', { proposalId: open.id });
}

export const supplierPaymentPrepare = defineCommand({
  name: 'finance.supplier_payment.prepare',
  input: zSupplierPaymentPrepare,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  handler: async (ctx, input) => {
    const invoiceId = input.purchaseDocumentId.toLowerCase();
    await refuseDuplicate(ctx, invoiceId);
    const doc = await loadInvoice(ctx.trx, ctx.orgId, invoiceId);
    const account = await activeAccount(ctx.trx, ctx.orgId, doc.party_id);
    const amount = money(doc.total).toFixed();
    return {
      kind: SUPPLIER_PAYMENT_KIND,
      command: SUPPLIER_PAYMENT_COMMAND,
      title: `Chi ${amount} ${doc.currency} cho nhà cung cấp`.slice(0, 300),
      // Parsed here as well as at the approval: a request the approval could not read would sit in the Inbox stuck.
      payload: zSupplierPaymentPayload.parse({
        purchaseDocumentId: invoiceId,
        partyId: doc.party_id,
        accountId: account.id,
        bankName: account.bank_name,
        last4: account.last4,
        accountAddedOn: day(account.created_at),
        amount,
        currency: doc.currency,
      }),
      // The proposal belongs to the invoice's legal entity (#1538), and its payload does not name it.
      legalEntityId: doc.legal_entity_id,
    };
  },
});

export const supplierPaymentRecord = defineCommand({
  // A literal, not SUPPLIER_PAYMENT_COMMAND: the job egress analysis reads a command's name from its source.
  name: 'finance.supplier_payment.record',
  input: zSupplierPaymentRecord,
  risk: 'R3',
  sideEffect: 'internal',
  access: 'proposal',
  proposalKind: SUPPLIER_PAYMENT_KIND,
  target: (input) => ({ type: 'finance.purchase_document', id: input.payload.purchaseDocumentId }),
  handler: async (ctx, { payload }): Promise<SupplierPayment> => {
    if (!ctx.proposalId || ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Lệnh này chỉ chạy qua đề xuất đã duyệt');
    const mfaAt = ctx.actor.mfaAt;
    if (typeof mfaAt !== 'number' || !Number.isFinite(mfaAt)) throw new DomainError('STEP_UP_REQUIRED', 401, 'Cần xác thực hai lớp gần đây để thực hiện việc này');
    const invoiceId = payload.purchaseDocumentId.toLowerCase();
    await refuseDuplicate(ctx, invoiceId);
    const doc = await loadInvoice(ctx.trx, ctx.orgId, invoiceId);
    const account = await activeAccount(ctx.trx, ctx.orgId, doc.party_id);
    // "Approve what you saw": the request showed this account (by its row, its last four digits and the day it was added), this supplier and this amount.
    const proposal = await ctx.trx.selectFrom('crove_kernel.proposal').select('legal_entity_id').where('org_id', '=', ctx.orgId).where('id', '=', ctx.proposalId).executeTakeFirst();
    if (
      doc.party_id !== payload.partyId.toLowerCase() ||
      account.id !== payload.accountId.toLowerCase() ||
      account.last4 !== payload.last4 ||
      day(account.created_at) !== payload.accountAddedOn ||
      !money(doc.total).equals(money(payload.amount)) ||
      doc.currency !== payload.currency ||
      proposal?.legal_entity_id !== doc.legal_entity_id
    ) {
      throw changed();
    }
    const row = await ctx.trx
      .insertInto('crove_finance.supplier_payment')
      .values({
        org_id: ctx.orgId,
        legal_entity_id: doc.legal_entity_id,
        party_id: doc.party_id,
        purchase_document_id: invoiceId,
        amount: money(doc.total).toFixed(),
        currency: doc.currency,
        bank_account_id: account.id,
        number_hash: account.number_hash,
        hash_key_id: account.hash_key_id,
        proposal_id: ctx.proposalId,
        approved_by: ctx.actor.userId,
        approver_step_up_at: new Date(mfaAt * 1000),
      })
      .returning(['id', 'party_id', 'purchase_document_id', 'amount', 'currency', 'status', 'approved_at', 'payable_after', 'hold_reason', 'confirmed_at', 'confirmed_channel', 'stale_at', 'cancelled_at', 'paid_at'])
      .executeTakeFirstOrThrow();
    // The party, the invoice, the account and the amount: never the number, the last four digits or the hash.
    ctx.audit({ paymentId: row.id, partyId: doc.party_id, purchaseDocumentId: invoiceId, accountId: account.id, amount: money(doc.total).toFixed(), currency: doc.currency, holdReason: row.hold_reason });
    return toView(row, account.bank_name, account.last4);
  },
});

type PaymentRow = {
  id: string;
  party_id: string;
  purchase_document_id: string;
  amount: string;
  currency: string;
  status: string;
  approved_at: Date | string;
  payable_after: Date | string | null;
  hold_reason: string | null;
  confirmed_at: Date | string | null;
  confirmed_channel: string | null;
  stale_at: Date | string | null;
  cancelled_at: Date | string | null;
  paid_at: Date | string | null;
};

function toView(row: PaymentRow, bankName: string, last4: string): SupplierPayment {
  return {
    id: row.id,
    partyId: row.party_id,
    purchaseDocumentId: row.purchase_document_id,
    amount: money(row.amount).toFixed(),
    currency: row.currency,
    status: row.status as SupplierPayment['status'],
    bankName,
    last4,
    approvedAt: iso(row.approved_at) as string,
    payableAfter: iso(row.payable_after),
    holdReason: row.hold_reason as SupplierPayment['holdReason'],
    confirmedAt: iso(row.confirmed_at),
    confirmedChannel: row.confirmed_channel as SupplierPayment['confirmedChannel'],
    staleAt: iso(row.stale_at),
    cancelledAt: iso(row.cancelled_at),
    paidAt: iso(row.paid_at),
  };
}

const PAYMENT_COLUMNS = ['p.id', 'p.party_id', 'p.purchase_document_id', 'p.amount', 'p.currency', 'p.status', 'p.approved_at', 'p.payable_after', 'p.hold_reason', 'p.confirmed_at', 'p.confirmed_channel', 'p.stale_at', 'p.cancelled_at', 'p.paid_at'] as const;

async function loadPayment(trx: Trx, orgId: string, id: string) {
  const row = await trx
    .selectFrom('crove_finance.supplier_payment as p')
    .innerJoin('crove_finance.supplier_bank_account as a', (join) => join.onRef('a.org_id', '=', 'p.org_id').onRef('a.id', '=', 'p.bank_account_id'))
    .select([...PAYMENT_COLUMNS, 'a.bank_name', 'a.last4'])
    .where('p.org_id', '=', orgId)
    .where('p.id', '=', id.toLowerCase())
    .forUpdate('p')
    .executeTakeFirst();
  if (!row) throw new DomainError('SUPPLIER_PAYMENT_NOT_FOUND', 404, 'Không tìm thấy khoản chi này');
  return row;
}

export const supplierPaymentConfirmAccount = defineCommand({
  name: 'finance.supplier_payment.confirm_account',
  input: zSupplierPaymentConfirm,
  // The marker is what an approver relies on that the supplier confirmed the account: a human with a fresh second factor.
  risk: 'R3',
  sideEffect: 'internal',
  access: MANAGERS,
  target: (input) => ({ type: 'finance.supplier_payment', id: input.paymentId }),
  handler: async (ctx, input): Promise<SupplierPayment> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    const row = await loadPayment(ctx.trx, ctx.orgId, input.paymentId);
    if (row.status !== 'approved') throw new DomainError('SUPPLIER_PAYMENT_NOT_APPROVED', 409, 'Khoản chi này không còn ở trạng thái đã duyệt');
    if (row.confirmed_at !== null) throw new DomainError('SUPPLIER_PAYMENT_ALREADY_CONFIRMED', 409, 'Khoản chi này đã được ghi nhận xác nhận với nhà cung cấp');
    await ctx.trx
      .updateTable('crove_finance.supplier_payment')
      .set({ confirmed_by: ctx.actor.userId, confirmed_at: ctx.now, confirmed_channel: input.channel })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', row.id)
      .execute();
    ctx.audit({ paymentId: row.id, partyId: row.party_id, channel: input.channel });
    const fresh = await loadPayment(ctx.trx, ctx.orgId, row.id);
    return toView(fresh as unknown as PaymentRow, fresh.bank_name, fresh.last4);
  },
});

export const supplierPaymentCancel = defineCommand({
  name: 'finance.supplier_payment.cancel',
  input: zSupplierPaymentCancel,
  risk: 'R2',
  sideEffect: 'internal',
  access: MANAGERS,
  target: (input) => ({ type: 'finance.supplier_payment', id: input.paymentId }),
  handler: async (ctx, input): Promise<SupplierPayment> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    const row = await loadPayment(ctx.trx, ctx.orgId, input.paymentId);
    if (row.status !== 'approved') throw new DomainError('SUPPLIER_PAYMENT_NOT_APPROVED', 409, 'Khoản chi này không còn ở trạng thái đã duyệt');
    await ctx.trx
      .updateTable('crove_finance.supplier_payment')
      .set({ status: 'cancelled', cancelled_by: ctx.actor.userId, cancel_reason: input.reason })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', row.id)
      .execute();
    // The reason is free text a person typed: the audit keeps that there is one, not the text.
    ctx.audit({ paymentId: row.id, partyId: row.party_id, hasReason: true });
    const fresh = await loadPayment(ctx.trx, ctx.orgId, row.id);
    return toView(fresh as unknown as PaymentRow, fresh.bank_name, fresh.last4);
  },
});

export const supplierPaymentList = defineQuery({
  name: 'finance.supplier_payment.list',
  input: zSupplierPaymentListInput,
  access: MANAGERS,
  handler: async (ctx, input): Promise<SupplierPayment[]> => {
    let query = ctx.trx
      .selectFrom('crove_finance.supplier_payment as p')
      .innerJoin('crove_finance.supplier_bank_account as a', (join) => join.onRef('a.org_id', '=', 'p.org_id').onRef('a.id', '=', 'p.bank_account_id'))
      .select([...PAYMENT_COLUMNS, 'a.bank_name', 'a.last4'])
      .where('p.org_id', '=', ctx.orgId);
    if (input.partyId) query = query.where('p.party_id', '=', input.partyId.toLowerCase());
    const rows = await query.orderBy('p.approved_at', 'desc').orderBy('p.id').limit(500).execute();
    return rows.map((r) => toView(r as unknown as PaymentRow, r.bank_name, r.last4));
  },
});

// Rule 3's second read (V5, #3113): the suppliers with a payment waiting, as ids and days. A request not decided yet (`pending`) and a payment waiting to be paid (`approved`) both count. Complete
// or refused: more suppliers than SIGNALS_MAX_CRM are not cut to a part, the read refuses with SIGNAL_PARTIAL_VIEW. An owner, an admin, a member or a viewer who can open the org sees every row.
export const financeSupplierPaymentsWaitingSignals = defineQuery({
  name: 'finance.signals.supplier_payments_waiting',
  input: z.strictObject({}),
  access: ALL,
  // An AI app the owner or an admin connected may run this read (ADR-0051): ids and days only, never a number.
  mcp: { scope: 'ludy.read' },
  handler: async (ctx): Promise<SupplierPaymentWaiting[]> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    const { rows } = await sql<{ party_id: string; state: 'pending' | 'approved'; since: Date | string }>`
      SELECT party_id, state, since FROM (
        SELECT p.party_id, 'approved'::text AS state, p.approved_at AS since
          FROM crove_finance.supplier_payment p WHERE p.org_id = ${ctx.orgId}::uuid AND p.status = 'approved'
        UNION ALL
        SELECT (q.payload->>'partyId')::uuid AS party_id, 'pending'::text AS state, q.created_at AS since
          FROM crove_kernel.proposal q WHERE q.org_id = ${ctx.orgId}::uuid AND q.command = ${SUPPLIER_PAYMENT_COMMAND} AND q.status = 'pending'
      ) w
      ORDER BY party_id, state, since
      LIMIT ${SIGNALS_MAX_CRM + 1}`.execute(ctx.trx);
    if (rows.length > SIGNALS_MAX_CRM) throw new DomainError(SIGNAL_PARTIAL_VIEW_CODE, 403, 'Quá nhiều khoản chi đang chờ để kiểm tra hết một lượt');
    return zSupplierPaymentsWaiting.parse(rows.map((r) => ({ partyId: r.party_id, state: r.state, since: day(r.since) })));
  },
});

export const supplierPaymentCommands = [supplierPaymentPrepare, supplierPaymentRecord, supplierPaymentConfirmAccount, supplierPaymentCancel];
export const supplierPaymentQueries = [supplierPaymentList, financeSupplierPaymentsWaitingSignals];
