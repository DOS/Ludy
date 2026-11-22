// SPDX-License-Identifier: AGPL-3.0-only
// The bank file of approved supplier payments (#3113 S3, #3700; modelled on `hr.payroll.bank_file.get`, which hands over the salary file). Ludy never initiates a payment: this only hands the
// accountant the rows to upload to the bank. The ledger is not touched here; a payment is `paid` and its voucher is posted when a bank line matches it (S3c).
//
// `finance.supplier_payment.bank_file.get` is a sensitive query in the requesting owner's or admin's own context (never a worker, a stored job or an AI app): its audit row is committed before it
// reads, it needs a second factor used in the last 5 minutes (policy P11), and it opens the sealed holder and number of each payment's pinned account here and nowhere else, in one batch after
// the audit row. Nothing decrypted reaches an audit fact or a log, and the answer is returned to the caller and never stored.
//
// A payment the file cannot carry refuses the whole file, and the refusal names the payment (its id, never a holder, a number or an amount), so no file leaves with a payment left out unseen:
//   - not `approved` (stale, cancelled, paid), or not found for the caller (another org's, or one outside the caller's legal entities, is not found);
//   - before its `payable_after`, judged on the database clock (never the application's);
//   - its pinned account is not the supplier's active one with the same keyed hash any more (whatever the payment's status says: the `stale` trigger runs with the writer's own rights, so an entity-
//     limited admin who changed the account did not reach it; this check is the backstop the Accounting PO asked for on #3700);
//   - its invoice is voided;
//   - its amount differs from the amount frozen in the request that was approved (the proposal's payload);
//   - the payments are not all in one currency, or a sealed value cannot be opened (a key shredded since, an erased supplier).
// The file's total is the sum of the frozen amounts, to the dong, or there is no file at all.
//
// `finance.supplier_payment.bank_file.export` is the audit row of a handed-over file and the marker on each payment (exported_at, exported_by, export_count; the database stamps the time): a count and
// the currency in the row, never a name, a number or an amount. The route that answers runs it before it answers, so no row and no marker, no download. A payment already marked is refused unless the
// caller confirmed a second file (reexport), which the row says; the update is conditional, so two requests racing for the same payment cannot both get a first file.
import {
  SUPPLIER_PAYMENT_COMMAND,
  zSupplierPaymentBankFile,
  zSupplierPaymentBankFileExport,
  zSupplierPaymentBankFileQuery,
  type SupplierPaymentBankFile,
} from '@ludy/kernel-contract';
import type { MemberRole } from '@ludy/db';
import { sql } from 'kysely';
import { DomainError, defineCommand, defineQuery, hasFreshMfa } from '@ludy/kernel-runtime';
import { Decimal, money } from '@ludy/l10n-vn';
import { HOLDER_PLACE, NUMBER_PLACE, supplierSubject } from './supplier-bank-account.ts';

const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];

// Control characters (a tab, a line break) inside a name or an account would break the bank's file layout, so they become a space.
const isControl = (ch: string): boolean => {
  const code = ch.codePointAt(0) as number;
  return code < 0x20 || code === 0x7f || code === 0x85 || code === 0x2028 || code === 0x2029;
};
const clean = (text: string): string => Array.from(text, (ch) => (isControl(ch) ? ' ' : ch)).join('').replace(/\s+/g, ' ').trim();

type Candidate = {
  id: string;
  party_id: string;
  status: string;
  currency: string;
  amount: string;
  // The checks the database answers, on its own clock and from its own rows.
  ready: boolean;
  account_ok: boolean;
  voided: boolean;
  frozen: string | null;
  number_sealed: string | null;
  holder_sealed: string | null;
  bank_name: string | null;
  invoice_number: string | null;
  export_count: number;
  exported_at: Date | null;
};

export const supplierPaymentBankFileGet = defineQuery({
  name: 'finance.supplier_payment.bank_file.get',
  input: zSupplierPaymentBankFileQuery,
  access: MANAGERS,
  sensitive: true,
  // The kind of read is the fixed name the audit row says before a value is opened (an id is not a name, so the payments are not in it).
  auditDetail: () => ({ kind: 'supplier_payment_bank_file' }),
  handler: async (ctx, input): Promise<SupplierPaymentBankFile> => {
    // Opening the account numbers of suppliers needs a second factor used within the last 5 minutes (policy P11), checked before anything is read or opened.
    if (ctx.actor.type !== 'user' || !hasFreshMfa(ctx.actor)) throw new DomainError('STEP_UP_REQUIRED', 403, 'Cần xác thực hai lớp (MFA) trong 5 phút gần nhất để thực hiện việc này');
    const ids = [...new Set(input.paymentIds.map((id) => id.toLowerCase()))];
    // One read, as the caller (their row policies decide what they see), with the checks answered by the database: its clock for the hold, its rows for the pinned account and the void.
    const { rows } = await sql<Candidate>`
      SELECT p.id, p.party_id, p.status, p.currency, p.amount::text AS amount,
             (p.payable_after IS NULL OR p.payable_after <= pg_catalog.now()) AS ready,
             (a.id IS NOT NULL AND a.status = 'active' AND a.number_hash = p.number_hash AND a.hash_key_id = p.hash_key_id AND a.party_id = p.party_id) AS account_ok,
             (v.document_id IS NOT NULL) AS voided,
             (q.payload ->> 'amount') AS frozen,
             a.number_sealed, a.account_holder_sealed AS holder_sealed, a.bank_name, d.invoice_number, p.export_count, p.exported_at
        FROM crove_finance.supplier_payment p
        LEFT JOIN crove_finance.supplier_bank_account a ON a.org_id = p.org_id AND a.id = p.bank_account_id
        LEFT JOIN crove_finance.purchase_document d ON d.org_id = p.org_id AND d.id = p.purchase_document_id
        LEFT JOIN crove_finance.purchase_document_void v ON v.org_id = p.org_id AND v.document_id = p.purchase_document_id
        LEFT JOIN ludy_kernel.proposal q ON q.org_id = p.org_id AND q.id = p.proposal_id AND q.command = ${SUPPLIER_PAYMENT_COMMAND}
       WHERE p.org_id = ${ctx.orgId}::uuid AND p.id = ANY (${ids}::uuid[])`.execute(ctx.trx);
    const byId = new Map(rows.map((r) => [r.id, r]));
    // The order the caller named the payments in is the file's order before it is sorted for the bank; a missing one is named.
    for (const id of ids) if (!byId.has(id)) throw new DomainError('SUPPLIER_PAYMENT_NOT_FOUND', 404, 'Không tìm thấy một khoản chi trong danh sách', { paymentId: id });
    const chosen = ids.map((id) => byId.get(id) as Candidate);
    for (const p of chosen) {
      if (p.status !== 'approved') throw new DomainError('SUPPLIER_PAYMENT_NOT_APPROVED', 409, 'Một khoản chi không còn ở trạng thái đã duyệt; không xuất được file', { paymentId: p.id });
      // A file handed over before is not handed over again by accident: the caller confirms (reexport), and the refusal names the earlier hand-over (never a person).
      if (p.export_count > 0 && input.reexport !== true) {
        throw new DomainError('SUPPLIER_PAYMENT_ALREADY_EXPORTED', 409, 'Một khoản chi đã có file chuyển khoản; xác nhận xuất lại nếu thật sự cần', { paymentId: p.id, exportedAt: p.exported_at ? new Date(p.exported_at).toISOString() : null });
      }
      if (!p.ready) throw new DomainError('SUPPLIER_PAYMENT_HELD', 409, 'Một khoản chi còn trong thời gian giữ 24 giờ; chưa xuất được file', { paymentId: p.id });
      if (!p.account_ok) throw new DomainError('SUPPLIER_PAYMENT_ACCOUNT_CHANGED', 409, 'Tài khoản ngân hàng của một nhà cung cấp đã thay đổi từ lúc duyệt; hãy tạo đề xuất chi mới', { paymentId: p.id });
      if (p.voided) throw new DomainError('SUPPLIER_PAYMENT_DOCUMENT', 409, 'Hóa đơn của một khoản chi đã bị hủy; không xuất được file', { paymentId: p.id });
      // The amount frozen in the request that was approved is the amount the file pays: a payment whose own amount differs (or whose request cannot be read) is refused.
      if (p.frozen === null || !money(p.frozen).equals(money(p.amount))) throw new DomainError('SUPPLIER_PAYMENT_AMOUNT_MISMATCH', 422, 'Số tiền của một khoản chi không khớp số tiền đã duyệt; không xuất được file', { paymentId: p.id });
    }
    const currency = (chosen[0] as Candidate).currency;
    const other = chosen.find((p) => p.currency !== currency);
    if (other) throw new DomainError('SUPPLIER_PAYMENT_CURRENCY_MIXED', 422, 'Một file chỉ gồm các khoản chi cùng một loại tiền', { paymentId: other.id });
    // Only now are the sealed values opened, in one batch, after the audit row.
    const items = chosen.flatMap((p) => [
      { sealed: p.holder_sealed as string, place: HOLDER_PLACE, ref: supplierSubject(p.party_id) },
      { sealed: p.number_sealed as string, place: NUMBER_PLACE, ref: supplierSubject(p.party_id) },
    ]);
    const opened = await ctx.openMany(items);
    // A key shredded since the check (an erasure in between) reads as erased: the whole file is refused, naming the payment.
    const lines = chosen.map((p, i) => {
      const holder = opened[2 * i];
      const number = opened[2 * i + 1];
      if (typeof holder !== 'string' || typeof number !== 'string') throw new DomainError('SUPPLIER_PAYMENT_ACCOUNT_ERASED', 422, 'Dữ liệu ngân hàng của một nhà cung cấp đã bị xóa; không xuất được file', { paymentId: p.id });
      const account = clean(number.replace(/\s+/g, ''));
      if (account === '' || clean(holder) === '') throw new DomainError('SUPPLIER_PAYMENT_ACCOUNT_ERASED', 422, 'Dữ liệu ngân hàng của một nhà cung cấp không đọc được; không xuất được file', { paymentId: p.id });
      return { holder: clean(holder), account, bank: clean(p.bank_name ?? ''), amount: money(p.amount).toFixed(), content: `Thanh toan hoa don ${clean(p.invoice_number ?? '')}`.trim() };
    });
    const sorted = [...lines]
      .sort((a, b) => a.holder.localeCompare(b.holder, 'vi') || a.account.localeCompare(b.account) || a.amount.localeCompare(b.amount))
      .map((r, i) => ({ seq: String(i + 1), ...r }));
    const total = sorted.reduce((acc, r) => acc.plus(r.amount), new Decimal(0));
    return zSupplierPaymentBankFile.parse({ currency, rows: sorted, total: total.toFixed() });
  },
});

export const supplierPaymentBankFileExport = defineCommand({
  name: 'finance.supplier_payment.bank_file.export',
  input: zSupplierPaymentBankFileExport,
  risk: 'R0',
  sideEffect: 'none',
  access: MANAGERS,
  handler: async (ctx, input): Promise<{ rows: number }> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ một chủ sở hữu hoặc quản trị viên mới xuất file chuyển khoản');
    // The hand-over needs the same second factor as the read it follows: the command is not a way to mark payments without it.
    if (!hasFreshMfa(ctx.actor)) throw new DomainError('STEP_UP_REQUIRED', 403, 'Cần xác thực hai lớp (MFA) trong 5 phút gần nhất để thực hiện việc này');
    const ids = [...new Set(input.paymentIds.map((id) => id.toLowerCase()))].sort();
    const reexport = input.reexport === true;
    // Marks each payment that is still approved, past its hold, with its pinned account still the supplier's active one and its invoice not voided (the read's checks again, on the rows locked now, so
    // a change between the read and this step is caught), and never exported unless confirmed. Rows are locked in id order, so two overlapping files cannot deadlock. The guard stamps the time and counts.
    const { rows } = await sql<{ id: string; before: number }>`
      WITH picked AS (
        SELECT p.id FROM crove_finance.supplier_payment p
         WHERE p.org_id = ${ctx.orgId}::uuid AND p.id = ANY (${ids}::uuid[]) AND p.status = 'approved' AND (${reexport}::boolean OR p.export_count = 0)
           AND (p.payable_after IS NULL OR p.payable_after <= pg_catalog.now())
           AND EXISTS (SELECT 1 FROM crove_finance.supplier_bank_account a WHERE a.org_id = p.org_id AND a.id = p.bank_account_id AND a.status = 'active' AND a.number_hash = p.number_hash AND a.hash_key_id = p.hash_key_id)
           AND NOT EXISTS (SELECT 1 FROM crove_finance.purchase_document_void v WHERE v.org_id = p.org_id AND v.document_id = p.purchase_document_id)
         ORDER BY p.id FOR UPDATE OF p)
      UPDATE crove_finance.supplier_payment p SET exported_by = ${ctx.actor.userId}::uuid, export_count = p.export_count + 1
        FROM picked WHERE p.org_id = ${ctx.orgId}::uuid AND p.id = picked.id
      RETURNING p.id, (p.export_count - 1) AS before`.execute(ctx.trx);
    if (rows.length !== ids.length || input.rows !== ids.length) {
      const marked = new Set(rows.map((r) => r.id));
      const missing = ids.find((id) => !marked.has(id)) ?? null;
      // Which rule stopped it, so the page says the true reason (the status is read as the refusal, not guessed).
      const why = missing
        ? (
            await sql<{ status: string; export_count: number; ready: boolean; account_ok: boolean; voided: boolean }>`
              SELECT p.status, p.export_count, (p.payable_after IS NULL OR p.payable_after <= pg_catalog.now()) AS ready,
                     EXISTS (SELECT 1 FROM crove_finance.supplier_bank_account a WHERE a.org_id = p.org_id AND a.id = p.bank_account_id AND a.status = 'active' AND a.number_hash = p.number_hash AND a.hash_key_id = p.hash_key_id) AS account_ok,
                     EXISTS (SELECT 1 FROM crove_finance.purchase_document_void v WHERE v.org_id = p.org_id AND v.document_id = p.purchase_document_id) AS voided
                FROM crove_finance.supplier_payment p WHERE p.org_id = ${ctx.orgId}::uuid AND p.id = ${missing}::uuid`.execute(ctx.trx)
          ).rows[0]
        : undefined;
      if (!why) throw new DomainError('SUPPLIER_PAYMENT_NOT_FOUND', 404, 'Không tìm thấy một khoản chi trong danh sách', { paymentId: missing });
      if (why.status !== 'approved') throw new DomainError('SUPPLIER_PAYMENT_NOT_APPROVED', 409, 'Một khoản chi không còn ở trạng thái đã duyệt; không xuất được file', { paymentId: missing });
      if (why.export_count > 0 && !reexport) throw new DomainError('SUPPLIER_PAYMENT_ALREADY_EXPORTED', 409, 'Một khoản chi đã có file chuyển khoản; xác nhận xuất lại nếu thật sự cần', { paymentId: missing });
      if (!why.ready) throw new DomainError('SUPPLIER_PAYMENT_HELD', 409, 'Một khoản chi còn trong thời gian giữ 24 giờ; chưa xuất được file', { paymentId: missing });
      if (!why.account_ok) throw new DomainError('SUPPLIER_PAYMENT_ACCOUNT_CHANGED', 409, 'Tài khoản ngân hàng của một nhà cung cấp đã thay đổi từ lúc duyệt; hãy tạo đề xuất chi mới', { paymentId: missing });
      if (why.voided) throw new DomainError('SUPPLIER_PAYMENT_DOCUMENT', 409, 'Hóa đơn của một khoản chi đã bị hủy; không xuất được file', { paymentId: missing });
      throw new DomainError('SUPPLIER_PAYMENT_NOT_APPROVED', 409, 'Số khoản chi không khớp danh sách đã xuất', { paymentId: missing });
    }
    // The payments the file held (ids, never a name, a number or an amount) and those among them that had a file before, so the row says which payments one file held even after a confirmed second file moves the marker.
    ctx.audit({ rows: input.rows, currency: input.currency, reexport, paymentIds: ids, again: rows.filter((r) => r.before > 0).map((r) => r.id).sort() });
    return { rows: input.rows };
  },
});

export const supplierPaymentBankFileCommands = [supplierPaymentBankFileExport];
export const supplierPaymentBankFileQueries = [supplierPaymentBankFileGet];
