// SPDX-License-Identifier: AGPL-3.0-only
// A payment to a supplier approved in Ludy (#3113 S2, #3699). Ludy moves no money: an owner or an admin approves paying one received invoice to the bank account they saw, and the bank file and
// the bank-line match (S3) follow. The request for approval is a proposal (finance.supplier_payment.record, asked for through kernel.proposal.request with `purchaseDocumentId`); its payload names
// the account the approver sees (the bank, the last four digits, the day it was added) so a changed account makes the request stale. No number, holder or hash crosses any of these.
import { z } from 'zod';
import { zCashVoucherProposal, zId, zLocalDate } from './schemas.ts';

export const SUPPLIER_PAYMENT_COMMAND = 'finance.supplier_payment.record';
export const SUPPLIER_PAYMENT_KIND = 'finance.supplier_payment';
// `approved`: waiting to be paid (and exported, from payable_after on). `stale`: the supplier's account changed after the approval, so it can only be asked for again. `paid` follows the bank-line match (S3).
export const SUPPLIER_PAYMENT_STATUSES = ['approved', 'paid', 'cancelled', 'stale'] as const;
// How the supplier confirmed the account: by a channel known beforehand, never one that came with the change. Evidence only: it never shortens the 24-hour hold.
export const SUPPLIER_PAYMENT_CHANNELS = ['phone_on_file', 'in_person', 'email_on_file'] as const;
export const SUPPLIER_PAYMENT_HOLD_REASONS = ['new_account'] as const;

const zAmount = z.string().regex(/^(?:0|[1-9][0-9]{0,15})(?:\.[0-9]{1,4})?$/);

export const zSupplierPaymentPrepare = z.strictObject({ purchaseDocumentId: z.uuid() });
// What the request for approval holds: the invoice, the supplier, the account the approver is shown and the amount. Parsed when the request is made and again at the approval.
export const zSupplierPaymentPayload = z.strictObject({
  purchaseDocumentId: z.uuid(),
  partyId: z.uuid(),
  accountId: z.uuid(),
  bankName: z.string().min(1).max(100),
  last4: z.string().regex(/^[0-9]{4}$/),
  // The day (Vietnam time) the account was added, so an approver sees a new one.
  accountAddedOn: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/),
  amount: zAmount,
  currency: z.string().regex(/^[A-Z]{3}$/),
});
export type SupplierPaymentPayload = z.infer<typeof zSupplierPaymentPayload>;
export const zSupplierPaymentRecord = z.object({ payload: zSupplierPaymentPayload });

export const zSupplierPaymentListInput = z.strictObject({ partyId: z.uuid().optional() });
export const zSupplierPaymentConfirm = z.strictObject({ paymentId: z.uuid(), channel: z.enum(SUPPLIER_PAYMENT_CHANNELS) });
export const zSupplierPaymentCancel = z.strictObject({ paymentId: z.uuid(), reason: z.string().trim().min(1).max(300) });

export const zSupplierPayment = z.strictObject({
  id: z.uuid(),
  partyId: z.uuid(),
  purchaseDocumentId: z.uuid(),
  amount: z.string(),
  currency: z.string(),
  status: z.enum(SUPPLIER_PAYMENT_STATUSES),
  bankName: z.string(),
  last4: z.string().regex(/^[0-9]{4}$/),
  approvedAt: z.string(),
  // Set when the 24-hour hold applies: the payment is not exported or paid before this time (the database clock).
  payableAfter: z.string().nullable(),
  holdReason: z.enum(SUPPLIER_PAYMENT_HOLD_REASONS).nullable(),
  confirmedAt: z.string().nullable(),
  confirmedChannel: z.enum(SUPPLIER_PAYMENT_CHANNELS).nullable(),
  staleAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  paidAt: z.string().nullable(),
  // When a bank file with this payment was last handed over (the database clock) and how many times; a second file needs the caller's confirmation.
  exportedAt: z.string().nullable(),
  exportCount: z.number().int().min(0),
});
export type SupplierPayment = z.infer<typeof zSupplierPayment>;
export const zSupplierPaymentList = z.array(zSupplierPayment);

// The bank file of approved supplier payments (#3113 S3, #3700). `finance.supplier_payment.bank_file.get` is a sensitive query in the requesting owner's or admin's own context: its audit row is
// committed before it reads, it needs a second factor used in the last 5 minutes, and it opens the sealed holder and number of each payment's pinned account there and nowhere else. The answer is
// returned to the caller and never stored. One file holds the payments the caller names, all in one currency; a payment the file cannot carry refuses the whole file, naming the payment (never a number).
export const SUPPLIER_PAYMENT_BANK_FILE_MAX = 200;
// reexport: the caller confirms that a payment whose file was handed over before gets a second file (the first is named in the refusal otherwise).
export const zSupplierPaymentBankFileQuery = z.strictObject({ paymentIds: z.array(z.uuid()).min(1).max(SUPPLIER_PAYMENT_BANK_FILE_MAX), reexport: z.boolean().optional() });
export type SupplierPaymentBankFileQuery = z.infer<typeof zSupplierPaymentBankFileQuery>;
export const zSupplierPaymentBankFileRow = z.strictObject({
  seq: z.string(),
  holder: z.string(),
  account: z.string(),
  bank: z.string(),
  amount: zAmount,
  content: z.string(),
});
export const zSupplierPaymentBankFile = z.strictObject({
  currency: z.string().regex(/^[A-Z]{3}$/),
  rows: z.array(zSupplierPaymentBankFileRow),
  total: zAmount,
});
export type SupplierPaymentBankFile = z.infer<typeof zSupplierPaymentBankFile>;
// The audit row of a handed-over file and the marker on each payment: the payments, a count and the currency, never a name, a number or an amount. reexport says the caller confirmed a second file.
export const zSupplierPaymentBankFileExport = z.strictObject({
  paymentIds: z.array(z.uuid()).min(1).max(SUPPLIER_PAYMENT_BANK_FILE_MAX),
  rows: z.number().int().min(1).max(SUPPLIER_PAYMENT_BANK_FILE_MAX),
  currency: z.string().regex(/^[A-Z]{3}$/),
  reexport: z.boolean().optional(),
});
export type SupplierPaymentBankFileExport = z.infer<typeof zSupplierPaymentBankFileExport>;

// The settlement of an approved payment (#3113 S3c, #3700): a bank statement line that is the transfer of the payment records it as a payment voucher (giấy báo Nợ, Dr 331 with the supplier, Cr the
// bank account of the line) and the payment becomes `paid`, in one approved step. Ludy never moves money: the voucher records a transfer the business made. The request is a proposal
// (`finance.supplier_payment.settle.record`, asked for through kernel.proposal.request with the payment and the line); its payload is a voucher that names the payment, and the server builds every
// line and the amount from the payment, never from the requester.
export const SUPPLIER_PAYMENT_SETTLE_COMMAND = 'finance.supplier_payment.settle.record';
export const zSupplierPaymentSettlePrepare = z.strictObject({ paymentId: z.uuid(), bankLineId: zId });
export const zSupplierPaymentSettleProposal = zCashVoucherProposal.extend({ supplierPayment: z.strictObject({ paymentId: zId }) });
export type SupplierPaymentSettleProposal = z.infer<typeof zSupplierPaymentSettleProposal>;
// The payments an open money-out line may be: approved, exported, past the hold, of the line's amount and entity, with the line not before the day of the file. Code decides, by the amount; the
// description's words only rank. The beneficiary account is compared when the settlement is asked for (the refusal SUPPLIER_PAYMENT_ACCOUNT_MISMATCH), never here.
export const zBankSupplierCandidate = z.strictObject({
  paymentId: zId,
  partyId: zId,
  partyName: z.string(),
  invoiceNumber: z.string(),
  amount: zAmount,
  exportedAt: z.string(),
  reason: z.enum(['amount', 'amount_note']),
});
export type BankSupplierCandidate = z.infer<typeof zBankSupplierCandidate>;
export const zBankSupplierMatch = z.strictObject({ bankLineId: zId, date: zLocalDate, candidates: z.array(zBankSupplierCandidate) });
export type BankSupplierMatch = z.infer<typeof zBankSupplierMatch>;

