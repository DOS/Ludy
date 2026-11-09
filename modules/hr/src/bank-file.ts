// SPDX-License-Identifier: AGPL-3.0-only
// The bank bulk-salary file of an approved pay run (issue #2532; payroll plan docs/plan/payroll.md section 6.4, ADR-0046): one row per person with the net pay, for the accountant to upload to the bank.
// Ludy never initiates a payment; this only hands over the file.
//
// `hr.payroll.bank_file.get` is a sensitive query in the requesting owner's or admin's own context (never a worker or a stored job): its audit row is committed before it reads, it needs a second
// factor used in the last 5 minutes (policy P11, as the declaration exports), and it opens each person's sealed account number here and nowhere else, in one batch after the audit row. Nothing
// decrypted reaches an audit fact or a log, and the answer is returned to the caller and never stored. Only the lines of an approved run that are paid (a pay line, calculated, with a net above zero)
// are in it, and a run with an adjustment line or a line not calculated gets no file. A person with no account number on record, or erased, refuses the whole file with a count (never a name): a file with some people missing must not exist.
//
// One file is for one bank (#2897): the query takes the code of a bank of the list `VN_BANKS` (@crove/l10n-vn; the route's `bank` parameter carries it, so the route needs no change) and the file holds the
// people of the run whose record names that bank, with the bank's short name from the list in the `bank` column. A person with no bank on record refuses the whole file with a count, like a missing
// account number: no file may leave someone out unseen. The check that nothing is lost is on the whole run: the amounts of every bank together must equal the net pay frozen at approval, to the dong, before
// any file is made; the file's own total is its bank's part, and the answer says how many people are in other banks' files (a count). A code not in the list is refused. More people in one file than the
// cap is refused too.
//
// A saved template (#2893, `crove_hr.payroll_bank_template`, the screen "Mẫu file lương") of the run's legal entity may be chosen: the file then follows its columns in its order (`sequence` of a
// template is the file's `seq`), its headers and its remark text (`{month}` becomes MM/YYYY). The bank cell stays the list's short name. The headers and the remark are text a person typed: they go
// through the same control-character clean-up as a name and are written as string cells with the Text format (./bank-file-xlsx.ts), so a leading `=`, `+`, `-` or `@` stays inert. A template that is not
// found, or belongs to another legal entity than the run, is refused as not found.
//
// `hr.payroll.bank_file.export` is the audit row of a downloaded file: the run and a count, never a name, an account number or an amount. The route writes it before it answers, so no row, no download.
import type { MemberRole } from '@crove/db';
import { HR_BANK_FILE_COLUMNS, HR_BANK_FILE_HEADERS, HR_BANK_FILE_MAX_PEOPLE, zHrBankFileExport, zHrBankFileQuery, zHrBankLayout, type HrBankFile, type HrBankFileColumn, type HrBankFileExport } from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, hasFreshMfa } from '@crove/kernel-runtime';
import { Decimal, bankByCode, money } from '@crove/l10n-vn';
import { ACCOUNT_PLACE, subjectOf } from './employees.ts';

const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];
// Only an approved run: one that is paid or closed has had its money moved, so it must not give a second file to upload.
const APPROVED = ['approved'] as const;

// "03/2026", as a bank's remark line writes the month.
const monthText = (month: string): string => `${month.slice(5, 7)}/${month.slice(0, 4)}`;
// Control characters (a tab, a line break) inside a name or an account would break the bank's file layout, so they become a space.
const isControl = (ch: string): boolean => {
  const code = ch.codePointAt(0) as number;
  return code < 0x20 || code === 0x7f || code === 0x85 || code === 0x2028 || code === 0x2029;
};
const clean = (text: string): string => Array.from(text, (ch) => (isControl(ch) ? ' ' : ch)).join('').replace(/\s+/g, ' ').trim();

export const bankFileGet = defineQuery({
  name: 'hr.payroll.bank_file.get',
  input: zHrBankFileQuery,
  access: MANAGERS,
  sensitive: true,
  // The kind of read is the fixed name the audit row says before a value is opened (an id is not a name, so the run is not in it).
  auditDetail: () => ({ kind: 'bank_file' }),
  handler: async (ctx, input): Promise<HrBankFile> => {
    // Opening the account numbers of the whole staff needs a second factor used within the last 5 minutes (policy P11), checked before anything is read or opened.
    if (ctx.actor.type !== 'user' || !hasFreshMfa(ctx.actor)) throw new DomainError('STEP_UP_REQUIRED', 403, 'Cần xác thực hai lớp (MFA) trong 5 phút gần nhất để thực hiện việc này');
    // The bank is a bank of the list, never free text: a code that is not in it is refused before anything is read.
    const bank = bankByCode(input.bankName);
    if (!bank) throw new DomainError('HR_BANK_UNKNOWN', 422, 'Ngân hàng này không có trong danh sách ngân hàng của Ludy');
    const run = await ctx.trx.selectFrom('crove_hr.payroll_run').select(['id', 'legal_entity_id', 'month', 'status', 'approval']).where('org_id', '=', ctx.orgId).where('id', '=', input.runId).executeTakeFirst();
    if (!run) throw new DomainError('HR_RUN_NOT_FOUND', 404, 'Không tìm thấy bảng lương này');
    if (!(APPROVED as readonly string[]).includes(run.status)) throw new DomainError('HR_RUN_NOT_APPROVED', 409, 'Chỉ bảng lương đã được duyệt mới xuất được file chuyển lương');
    // The saved template, if one is chosen: of this run's legal entity, found by the caller's own row policies (another org's or another entity's is not found), and a valid layout.
    let template: { columns: HrBankFileColumn[]; headers: string[]; content: string } | null = null;
    if (input.templateId !== undefined) {
      const row = await ctx.trx.selectFrom('crove_hr.payroll_bank_template').select(['legal_entity_id', 'layout']).where('org_id', '=', ctx.orgId).where('id', '=', input.templateId).executeTakeFirst();
      const layout = row && row.legal_entity_id === run.legal_entity_id ? zHrBankLayout.safeParse(row.layout) : null;
      if (!layout?.success) throw new DomainError('HR_BANK_TEMPLATE_NOT_FOUND', 404, 'Không tìm thấy mẫu file này');
      template = {
        columns: layout.data.columns.map((c) => (c.key === 'sequence' ? 'seq' : c.key)),
        // A header that is nothing but control characters shows the generic header of its column instead.
        headers: layout.data.columns.map((c) => clean(c.header) || HR_BANK_FILE_HEADERS[c.key === 'sequence' ? 'seq' : c.key]),
        content: clean(layout.data.content.replaceAll('{month}', monthText(run.month))),
      };
    }
    const lines = await ctx.trx
      .selectFrom('crove_hr.payroll_line')
      .select(['employee_id', 'net', 'kind', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('run_id', '=', run.id)
      .execute();
    // A run with an adjustment line (a signed correction of an earlier month, carried in this run) pays a different amount than its pay lines add up to, and a line not calculated has no net: such a
    // run gets no file (the same refusal as the posting), never a file that pays the wrong amount.
    if (lines.some((l) => l.kind !== 'pay')) throw new DomainError('HR_BANK_FILE_ADJUSTMENTS', 422, 'Bảng lương có dòng điều chỉnh; chưa xuất được file chuyển lương loại bảng lương này');
    if (lines.some((l) => l.status !== 'calculated')) throw new DomainError('HR_BANK_FILE_MISMATCH', 422, 'Bảng lương có dòng chưa tính; không xuất được file chuyển lương');
    const paid = lines.filter((l) => l.net !== null && money(l.net as string).greaterThan(0));
    if (paid.length === 0) throw new DomainError('HR_BANK_FILE_EMPTY', 422, 'Bảng lương này không có khoản thực nhận nào để chuyển');
    const ids = paid.map((l) => l.employee_id);
    const employees = await ctx.trx
      .selectFrom('crove_hr.payroll_employee')
      .select(['id', 'display_name', 'erased_at', 'bank_account_sealed', 'bank_code'])
      .where('org_id', '=', ctx.orgId)
      .where('id', 'in', ids)
      .execute();
    if (employees.length !== new Set(ids).size) throw new DomainError('HR_EMPLOYEE_NOT_FOUND', 409, 'Một dòng lương nêu một nhân viên không còn trong danh sách');
    const byId = new Map(employees.map((e) => [e.id, e]));
    // The people the file cannot name: no account number on record, or erased. A count only, never a name.
    const missing = ids.filter((id) => {
      const e = byId.get(id);
      return !e || e.erased_at !== null || e.bank_account_sealed === null;
    }).length;
    if (missing > 0) throw new DomainError('HR_BANK_ACCOUNT_MISSING', 422, `${missing} người trong bảng lương chưa có số tài khoản ngân hàng; hãy bổ sung rồi xuất lại`, { missing });
    // The people with no bank on record (or one the list does not hold) belong to no file: the whole export is refused with a count, so no one is left out unseen.
    const noBank = ids.filter((id) => {
      const code = byId.get(id)?.bank_code ?? null;
      return code === null || bankByCode(code) === undefined;
    }).length;
    if (noBank > 0) throw new DomainError('HR_BANK_CODE_MISSING', 422, `${noBank} người trong bảng lương chưa có ngân hàng; hãy chọn ngân hàng cho họ rồi xuất lại`, { missing: noBank });
    // Nothing is lost across the files: every bank's amounts together are the net pay frozen with the run's approval, to the dong, or there is no file at all.
    const runTotal = paid.reduce((acc, l) => acc.plus(money(l.net as string)), new Decimal(0));
    const approvedNet = (run.approval as { totals?: { net?: string } } | null)?.totals?.net;
    if (approvedNet === undefined || !money(approvedNet).equals(runTotal)) throw new DomainError('HR_BANK_FILE_MISMATCH', 422, 'Tổng tiền của file chuyển lương không khớp tổng thực nhận lúc duyệt bảng lương; không xuất được file');
    // The people of this bank: the file. The others are in the files of their banks.
    const mine = paid.filter((l) => byId.get(l.employee_id)?.bank_code === bank.code);
    if (mine.length === 0) throw new DomainError('HR_BANK_FILE_NO_PEOPLE', 422, 'Không có ai trong bảng lương này nhận lương qua ngân hàng này');
    if (mine.length > HR_BANK_FILE_MAX_PEOPLE) throw new DomainError('EXPORT_TOO_LARGE', 422, `Có hơn ${HR_BANK_FILE_MAX_PEOPLE} người của ngân hàng này trong bảng lương; không xuất được một lần`);
    // Only this file's account numbers are opened, in one batch, after the audit row.
    const items = mine.map((l) => ({ sealed: (byId.get(l.employee_id) as { bank_account_sealed: string }).bank_account_sealed, place: ACCOUNT_PLACE, ref: subjectOf(l.employee_id) }));
    const opened = await ctx.openMany(items);
    // A key shredded since the check (an erasure in between) reads as erased: the same refusal.
    // (an account that is nothing but spaces or control characters is no account)
    const gone = opened.filter((v) => typeof v !== 'string' || clean(v.replace(/\s+/g, '')) === '').length;
    if (gone > 0) throw new DomainError('HR_BANK_ACCOUNT_MISSING', 422, `${gone} người trong bảng lương chưa có số tài khoản ngân hàng; hãy bổ sung rồi xuất lại`, { missing: gone });
    const content = template !== null && template.content !== '' ? template.content : `Luong thang ${monthText(run.month)}`;
    const rows = mine
      .map((l, i) => ({ name: clean((byId.get(l.employee_id) as { display_name: string }).display_name), account: clean(String(opened[i]).replace(/\s+/g, '')), amount: money(l.net as string).toFixed() }))
      .sort((a, b) => a.name.localeCompare(b.name, 'vi') || a.account.localeCompare(b.account))
      // The bank cell is the list's short name, never text a person typed.
      .map((r, i) => ({ seq: String(i + 1), name: r.name, account: r.account, bank: bank.shortName, amount: r.amount, content }));
    const total = rows.reduce((acc, r) => acc.plus(r.amount), new Decimal(0));
    const columns = template?.columns ?? input.columns ?? [...HR_BANK_FILE_COLUMNS];
    const headers = template?.headers ?? columns.map((c) => HR_BANK_FILE_HEADERS[c]);
    return { runId: run.id, month: run.month, bankCode: bank.code, columns, headers, rows, total: total.toFixed(), otherPeople: paid.length - mine.length };
  },
});

export const bankFileExport = defineCommand({
  name: 'hr.payroll.bank_file.export',
  input: zHrBankFileExport,
  risk: 'R0',
  sideEffect: 'none',
  access: MANAGERS,
  handler: async (ctx, input: HrBankFileExport): Promise<{ rows: number }> => {
    ctx.audit({ runId: input.runId, rows: input.rows, columns: input.columns });
    return { rows: input.rows };
  },
});

export const hrBankFileCommands = [bankFileExport];
export const hrBankFileQueries = [bankFileGet];
