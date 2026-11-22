// SPDX-License-Identifier: AGPL-3.0-only
// The settlement of an approved supplier payment (#3113 S3c, #3700; option A of the Accounting PO). Ludy never moves money: the payment was approved (S2), its bank file handed over (S3b) and the
// business made the transfer at its bank. When the bank statement line of that transfer is matched, this records it as a bank voucher (giấy báo Nợ: Dr 331 with the supplier / Cr the bank account
// of the line) that names the payment, and the payment becomes `paid`, in one approved step:
// - finance.supplier_payment.settle.prepare (R1, owners and admins; the preparer of kernel.proposal.request for the settlement): checks the payment and the line and builds the voucher proposal from the
//   payment (the supplier, the amount, the description) and the line (the bank account, the date), never from the requester. It writes nothing.
// - finance.supplier_payment.settle.record (R3, ledger policy 16: only through kernel.proposal.approve): checks everything again, records the voucher with the payment's id and posts its entry (the
//   shared voucher path), then moves the payment to `paid`; the guard of the payment and the database checks of the voucher hold the same rules.
// - finance.bank.supplier_match: the payments an open money-out line may be (read only).
// Conditions of the PO, all checked at the request and again at the approval:
//   1. the line's amount equals the payment's frozen amount and the payment is in VND; the line is not before the day the FIRST file was handed over (first_exported_at: a re-export does not move it) (the file's day itself is fine: a transfer on the day
//      of the file is normal); the payment is approved, past its hold, still on its pinned account with its invoice standing, and has been exported;
//   2. when the line carries the beneficiary's account number, its keyed hash must be the pinned account's: a different one refuses the settlement (SUPPLIER_PAYMENT_ACCOUNT_MISMATCH), never settles
//      by itself and leaves no voucher; a line without a usable number is settled on the amount and the file;
//   3. a voucher of a payment is unique, and its entry cannot be reversed while the payment is paid (SUPPLIER_PAYMENT_PAID here and a database trigger), so a reversal never frees a payment to be paid twice;
//   4. policy version 16.
import { sql } from 'kysely';
import { z } from 'zod';
import {
  SUPPLIER_PAYMENT_SETTLE_COMMAND,
  VOUCHER_KIND,
  zBankSupplierMatch,
  zId,
  zSupplierPaymentSettlePrepare,
  zSupplierPaymentSettleProposal,
  type BankSupplierCandidate,
  type BankSupplierMatch,
} from '@ludy/kernel-contract';
import type { MemberRole } from '@ludy/db';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@ludy/kernel-runtime';
import { Decimal, money } from '@ludy/l10n-vn';
import { bankLineStates, findBankLine, type StoredBankLine } from './bank-match.ts';
import { buildVoucherProposal, recordVoucherPayload } from './cash-voucher.ts';
import { voucherTitle } from './domain/cash-voucher.ts';
import { HASH_PURPOSE } from './supplier-bank-account.ts';

const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];
const SETTLE_ACCOUNT = '331';
const WHOLE_VND = /^[0-9]{1,15}$/;

type PaymentRow = {
  id: string;
  party_id: string;
  party_name: string | null;
  tax_code: string | null;
  legal_entity_id: string;
  amount: string;
  currency: string;
  status: string;
  ready: boolean;
  export_count: number;
  first_exported_at: Date | string | null;
  account_ok: boolean;
  voided: boolean;
  number_hash: string;
  hash_key_id: string;
  invoice_number: string | null;
};

// The payment as the database sees it now, with its own clock and rows: the hold, the pinned account, the void.
async function loadPayment(ctx: QueryContext, paymentId: string): Promise<PaymentRow> {
  const { rows } = await sql<PaymentRow>`
    SELECT p.id, p.party_id, pa.name AS party_name, pa.tax_code, p.legal_entity_id, p.amount::text AS amount, p.currency, p.status,
           (p.payable_after IS NULL OR p.payable_after <= pg_catalog.now()) AS ready, p.export_count, p.first_exported_at,
           (a.id IS NOT NULL AND a.status = 'active' AND a.number_hash = p.number_hash AND a.hash_key_id = p.hash_key_id AND a.party_id = p.party_id) AS account_ok,
           EXISTS (SELECT 1 FROM crove_finance.purchase_document_void v WHERE v.org_id = p.org_id AND v.document_id = p.purchase_document_id) AS voided,
           p.number_hash, p.hash_key_id, d.invoice_number
      FROM crove_finance.supplier_payment p
      LEFT JOIN crove_finance.supplier_bank_account a ON a.org_id = p.org_id AND a.id = p.bank_account_id
      LEFT JOIN crove_finance.purchase_document d ON d.org_id = p.org_id AND d.id = p.purchase_document_id
      LEFT JOIN crove_kernel.party pa ON pa.org_id = p.org_id AND pa.id = p.party_id
     WHERE p.org_id = ${ctx.orgId}::uuid AND p.id = ${paymentId}::uuid`.execute(ctx.trx);
  const row = rows[0];
  if (!row) throw new DomainError('SUPPLIER_PAYMENT_NOT_FOUND', 404, 'Không tìm thấy khoản chi này');
  return row;
}

// The day (Vietnam time) a timestamp falls on.
const localDay = (value: Date | string): string => new Date(new Date(value).getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

// The description of the voucher is fixed from the invoice: never free text from a requester or a bank statement.
const clean = (text: string): string => text.replace(/[\p{Cc}\s]+/gu, ' ').trim();
const settleDescription = (invoiceNumber: string | null): string => `Thanh toan hoa don ${clean(invoiceNumber ?? '')}`.trim().slice(0, 300);

// Every rule of condition 1 and 2 for a payment and a line, in the order a person would fix them. Used when the settlement is asked for and again when it is approved.
function checkSettleable(ctx: CommandContext, p: PaymentRow, line: StoredBankLine): void {
  if (p.status !== 'approved') throw new DomainError('SUPPLIER_PAYMENT_NOT_APPROVED', 409, 'Khoản chi này không còn ở trạng thái đã duyệt', { paymentId: p.id });
  if (!p.ready) throw new DomainError('SUPPLIER_PAYMENT_HELD', 409, 'Khoản chi này còn trong thời gian giữ 24 giờ', { paymentId: p.id });
  if (!p.account_ok) throw new DomainError('SUPPLIER_PAYMENT_ACCOUNT_CHANGED', 409, 'Tài khoản ngân hàng của nhà cung cấp đã thay đổi từ lúc duyệt; hãy tạo đề xuất chi mới', { paymentId: p.id });
  if (p.voided) throw new DomainError('SUPPLIER_PAYMENT_DOCUMENT', 409, 'Hóa đơn của khoản chi này đã bị hủy', { paymentId: p.id });
  if (p.export_count === 0 || p.first_exported_at === null) {
    throw new DomainError('SUPPLIER_PAYMENT_NOT_EXPORTED', 409, 'Khoản chi này chưa có file chuyển khoản; hãy xuất file trước khi ghi sổ', { paymentId: p.id });
  }
  const amount = money(p.amount).toFixed();
  if (p.currency !== 'VND') throw new DomainError('SUPPLIER_PAYMENT_CURRENCY', 422, 'Chỉ ghi sổ được khoản chi bằng VND từ dòng sao kê', { paymentId: p.id });
  const out = new Decimal(line.amount);
  const problems: string[] = [];
  if (!out.isNegative() || out.isZero()) problems.push('DIRECTION');
  if (!out.abs().equals(new Decimal(amount)) || !WHOLE_VND.test(amount)) problems.push('AMOUNT');
  if (line.legalEntityId !== p.legal_entity_id) problems.push('ENTITY');
  if (problems.length > 0) {
    throw new DomainError('SUPPLIER_PAYMENT_LINE_MISMATCH', 422, 'Dòng sao kê phải là tiền ra, đúng số tiền và cùng pháp nhân với khoản chi', { paymentId: p.id, problems });
  }
  if (line.date < localDay(p.first_exported_at)) {
    throw new DomainError('SUPPLIER_PAYMENT_LINE_BEFORE_FILE', 422, 'Dòng sao kê có ngày trước ngày xuất file chuyển khoản nên không phải khoản chi này', { paymentId: p.id });
  }
  beneficiaryIsApproved(ctx, p, line);
}

// Condition 2: the account the money went to is the account that was approved. The statement's number, when it has a whole one, is hashed under the key of the pinned account and compared; the number
// is never stored, shown or logged. A line with no usable number says nothing either way. A key the deployment no longer keeps cannot compare, which refuses (the safe side).
function beneficiaryIsApproved(ctx: CommandContext, p: PaymentRow, line: StoredBankLine): void {
  if (line.counterpartyAccount === null) return;
  const digits = line.counterpartyAccount.replace(/[\s.-]/g, '');
  // A number that is there but not a whole one cannot be compared: it refuses (the statement's own check keeps it to 6 to 20 digits, so this is the safe side, not a case).
  let same = false;
  try {
    same = /^[0-9]{6,20}$/.test(digits) && ctx.keyedHash(HASH_PURPOSE, digits, p.hash_key_id) === p.number_hash;
  } catch (error) {
    if (!(error instanceof DomainError && error.code === 'KEYED_HASH_KEY_RETIRED')) throw error;
  }
  if (!same) {
    throw new DomainError('SUPPLIER_PAYMENT_ACCOUNT_MISMATCH', 409, 'Tài khoản trên sao kê không khớp được với tài khoản đã duyệt (khác tài khoản, hoặc không đối chiếu được); không tự ghi sổ. Hãy kiểm tra với ngân hàng và nhà cung cấp', { paymentId: p.id });
  }
}

const lockPayment = (ctx: CommandContext, paymentId: string) =>
  sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`${SUPPLIER_PAYMENT_SETTLE_COMMAND}:${ctx.orgId}:${paymentId}`}, 0))`.execute(ctx.trx);

export const supplierPaymentSettlePrepare = defineCommand({
  name: 'finance.supplier_payment.settle.prepare',
  input: zSupplierPaymentSettlePrepare,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  handler: async (ctx, input) => {
    const paymentId = input.paymentId.toLowerCase();
    await lockPayment(ctx, paymentId);
    const open = await ctx.trx
      .selectFrom('crove_kernel.proposal')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('command', '=', SUPPLIER_PAYMENT_SETTLE_COMMAND)
      .where('status', '=', 'pending')
      .where(sql<string>`pg_catalog.lower(payload->'supplierPayment'->>'paymentId')`, '=', paymentId)
      .executeTakeFirst();
    if (open) throw new DomainError('SUPPLIER_PAYMENT_SETTLE_PENDING', 409, 'Khoản chi này đã có đề xuất ghi sổ đang chờ duyệt', { proposalId: open.id });
    const line = await findBankLine(ctx, input.bankLineId);
    if (!line) throw new DomainError('BANK_LINE_NOT_FOUND', 422, 'Không tìm thấy dòng sao kê; hãy tải lại trang ngân hàng');
    const payment = await loadPayment(ctx, paymentId);
    checkSettleable(ctx, payment, line);
    const draft = await buildVoucherProposal(ctx, {
      type: 'bank_debit',
      date: line.date,
      cashAccount: line.bankAccount,
      partyId: payment.party_id,
      description: settleDescription(payment.invoice_number),
      lines: [{ account: SETTLE_ACCOUNT, amount: money(payment.amount).toFixed() }],
      bankLineId: line.id,
      legalEntityId: payment.legal_entity_id,
    });
    const payload = zSupplierPaymentSettleProposal.parse({ ...draft.payload, supplierPayment: { paymentId } });
    return { kind: VOUCHER_KIND, command: SUPPLIER_PAYMENT_SETTLE_COMMAND, title: voucherTitle(payload), payload };
  },
});

export const supplierPaymentSettleRecord = defineCommand({
  // A literal, not the shared constant: the job-egress analyzer reads a command's name from the source.
  name: 'finance.supplier_payment.settle.record',
  input: z.object({ payload: zSupplierPaymentSettleProposal, acceptFailedChecks: z.boolean().default(false) }),
  risk: 'R3',
  sideEffect: 'financial',
  access: 'proposal',
  proposalKind: VOUCHER_KIND,
  target: (input) => ({ type: 'finance.supplier_payment', id: input.payload.supplierPayment.paymentId }),
  handler: async (ctx, { payload }) => {
    if (!ctx.proposalId) throw new DomainError('FORBIDDEN', 403, 'Lệnh này chỉ chạy qua đề xuất đã duyệt');
    const paymentId = payload.supplierPayment.paymentId.toLowerCase();
    await lockPayment(ctx, paymentId);
    const payment = await loadPayment(ctx, paymentId);
    // The stored proposal is the voucher the preparer builds from the payment, and no other: a row written some other way is refused, so a requester cannot choose a party, an amount or a line.
    const amount = money(payment.amount).toFixed();
    const [only] = payload.lines;
    const same =
      payload.type === 'bank_debit' &&
      payload.party?.id === payment.party_id &&
      payload.personName === null &&
      payload.legalEntityId === payment.legal_entity_id &&
      payload.description === settleDescription(payment.invoice_number) &&
      payload.lines.length === 1 &&
      only?.account === SETTLE_ACCOUNT &&
      money(only.amount).equals(money(amount)) &&
      money(payload.total).equals(money(amount)) &&
      payload.bankLineId !== undefined;
    if (!same) throw new DomainError('SUPPLIER_PAYMENT_SETTLE_MISMATCH', 422, 'Đề xuất ghi sổ không khớp khoản chi đã duyệt; hãy lập lại đề xuất', { paymentId });
    const line = await findBankLine(ctx, payload.bankLineId as string);
    if (!line) throw new DomainError('BANK_LINE_NOT_FOUND', 422, 'Không tìm thấy dòng sao kê; hãy tải lại trang ngân hàng');
    checkSettleable(ctx, payment, line);
    const recorded = await recordVoucherPayload(ctx, payload, null, paymentId);
    // The payment is paid by this voucher; the guard checks the hold, the account, the invoice, the file and the voucher once more, and a payment that moved since is refused, not forced.
    const moved = await ctx.trx
      .updateTable('crove_finance.supplier_payment')
      .set({ status: 'paid' })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', paymentId)
      .where('status', '=', 'approved')
      .returning('id')
      .executeTakeFirst();
    if (!moved) throw new DomainError('SUPPLIER_PAYMENT_NOT_APPROVED', 409, 'Khoản chi này không còn ở trạng thái đã duyệt', { paymentId });
    ctx.audit({ supplier_payment_id: paymentId });
    return { ...recorded, paymentId };
  },
});

// The payments an open money-out line may be. Code decides by the amount and the rules above; the invoice number in the description only ranks. Read only.
export const bankSupplierMatch = defineQuery({
  name: 'finance.bank.supplier_match',
  input: z.object({ bankLineId: zId }),
  access: MANAGERS,
  handler: async (ctx, input): Promise<BankSupplierMatch> => {
    const line = await findBankLine(ctx, input.bankLineId);
    if (!line) throw new DomainError('BANK_LINE_NOT_FOUND', 404, 'Không tìm thấy dòng sao kê; hãy tải lại trang ngân hàng');
    const none: BankSupplierMatch = { bankLineId: line.id, date: line.date, candidates: [] };
    const out = new Decimal(line.amount);
    if (!out.isNegative() || out.isZero()) return none;
    if (((await bankLineStates(ctx, [line.id])).get(line.id)?.status ?? 'open') !== 'open') return none;
    const wanted = out.abs().toFixed();
    const { rows } = await sql<{ id: string; party_id: string; party_name: string | null; invoice_number: string | null; amount: string; exported_at: Date | string }>`
      SELECT p.id, p.party_id, pa.name AS party_name, d.invoice_number, p.amount::text AS amount, p.exported_at
        FROM crove_finance.supplier_payment p
        JOIN crove_finance.supplier_bank_account a ON a.org_id = p.org_id AND a.id = p.bank_account_id
          AND a.status = 'active' AND a.number_hash = p.number_hash AND a.hash_key_id = p.hash_key_id
        LEFT JOIN crove_finance.purchase_document d ON d.org_id = p.org_id AND d.id = p.purchase_document_id
        LEFT JOIN crove_kernel.party pa ON pa.org_id = p.org_id AND pa.id = p.party_id
       WHERE p.org_id = ${ctx.orgId}::uuid AND p.legal_entity_id = ${line.legalEntityId}::uuid AND p.status = 'approved' AND p.currency = 'VND'
         AND p.exported_at IS NOT NULL AND (p.payable_after IS NULL OR p.payable_after <= pg_catalog.now())
         AND p.amount = ${wanted}::numeric
         AND (p.first_exported_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date <= ${line.date}::date AND p.amount = trunc(p.amount)
         AND NOT EXISTS (SELECT 1 FROM crove_finance.purchase_document_void v WHERE v.org_id = p.org_id AND v.document_id = p.purchase_document_id)
         AND NOT EXISTS (SELECT 1 FROM crove_kernel.proposal q WHERE q.org_id = p.org_id AND q.command = ${SUPPLIER_PAYMENT_SETTLE_COMMAND} AND q.status = 'pending'
                           AND pg_catalog.lower(q.payload->'supplierPayment'->>'paymentId') = p.id::text)
       ORDER BY (d.invoice_number IS NOT NULL AND d.invoice_number <> '' AND pg_catalog.strpos(pg_catalog.lower(${line.description}), pg_catalog.lower(d.invoice_number)) > 0) DESC, p.exported_at DESC, p.id
       LIMIT 20`.execute(ctx.trx);
    const description = line.description.toLowerCase();
    const candidates: BankSupplierCandidate[] = rows.map((r) => ({
      paymentId: r.id,
      partyId: r.party_id,
      partyName: r.party_name ?? '',
      invoiceNumber: r.invoice_number ?? '',
      amount: money(r.amount).toFixed(),
      exportedAt: new Date(r.exported_at).toISOString(),
      reason: r.invoice_number && description.includes(r.invoice_number.toLowerCase()) ? 'amount_note' : 'amount',
    }));
    candidates.sort((a, b) => Number(b.reason === 'amount_note') - Number(a.reason === 'amount_note'));
    return zBankSupplierMatch.parse({ bankLineId: line.id, date: line.date, candidates });
  },
});

// The entry of a settlement's voucher is not reversed while its payment is paid (SUPPLIER_PAYMENT_PAID): checked when the reversal is asked for and again when it is approved; the database holds it too
// (20270116140000). Every other entry is let through.
export async function refuseSupplierPaymentReversal(ctx: QueryContext, entry: { source_type: string; source_id: string }): Promise<void> {
  if (entry.source_type !== 'finance.cash_voucher') return;
  const { rows } = await sql<{ payment_id: string }>`
    SELECT v.supplier_payment_id AS payment_id
      FROM crove_finance.cash_voucher v
      JOIN crove_finance.supplier_payment p ON p.org_id = v.org_id AND p.id = v.supplier_payment_id AND p.status = 'paid'
     WHERE v.org_id = ${ctx.orgId}::uuid AND v.id = ${entry.source_id}::uuid AND v.supplier_payment_id IS NOT NULL`.execute(ctx.trx);
  if (rows[0]) throw new DomainError('SUPPLIER_PAYMENT_PAID', 409, 'Chứng từ này ghi sổ một khoản chi nhà cung cấp đã chi nên không đảo được', { paymentId: rows[0].payment_id });
}

export const supplierPaymentSettleCommands = [supplierPaymentSettlePrepare, supplierPaymentSettleRecord];
export const supplierPaymentSettleQueries = [bankSupplierMatch];
