// SPDX-License-Identifier: AGPL-3.0-only
// The bank bulk-salary file of an approved pay run (issue #2532; payroll plan docs/plan/payroll.md section 6.4, ADR-0046): one row per person with the net pay, for the accountant to upload to the bank.
// Ludy never initiates a payment; this only hands over the file.
//
// `hr.payroll.bank_file.get` is a sensitive query in the requesting owner's or admin's own context (never a worker or a stored job): its audit row is committed before it reads, it needs a second
// factor used in the last 5 minutes (policy P11, as the declaration exports), and it opens each person's sealed account number here and nowhere else, in one batch after the audit row. Nothing
// decrypted reaches an audit fact or a log, and the answer is returned to the caller and never stored. Only the lines of an approved run that are paid (a pay line, calculated, with a net above zero)
// are in it. A person with no account number on record, or erased, refuses the whole file with a count (never a name): a file with some people missing must not exist. More people than the cap is
// refused too.
//
// `hr.payroll.bank_file.export` is the audit row of a downloaded file: the run and a count, never a name, an account number or an amount. The route writes it before it answers, so no row, no download.
import type { MemberRole } from '@crove/db';
import { HR_BANK_FILE_COLUMNS, HR_BANK_FILE_MAX_PEOPLE, zHrBankFileExport, zHrBankFileQuery, type HrBankFile, type HrBankFileExport } from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, hasFreshMfa } from '@crove/kernel-runtime';
import { Decimal, money } from '@crove/l10n-vn';
import { ACCOUNT_PLACE, subjectOf } from './employees.ts';

const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];
const APPROVED = ['approved', 'paid', 'closed'] as const;

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
    const run = await ctx.trx.selectFrom('crove_hr.payroll_run').select(['id', 'month', 'status']).where('org_id', '=', ctx.orgId).where('id', '=', input.runId).executeTakeFirst();
    if (!run) throw new DomainError('HR_RUN_NOT_FOUND', 404, 'Không tìm thấy bảng lương này');
    if (!(APPROVED as readonly string[]).includes(run.status)) throw new DomainError('HR_RUN_NOT_APPROVED', 409, 'Chỉ bảng lương đã được duyệt mới xuất được file chuyển lương');
    const lines = await ctx.trx
      .selectFrom('crove_hr.payroll_line')
      .select(['employee_id', 'net'])
      .where('org_id', '=', ctx.orgId)
      .where('run_id', '=', run.id)
      .where('kind', '=', 'pay')
      .where('status', '=', 'calculated')
      .execute();
    const paid = lines.filter((l) => l.net !== null && money(l.net as string).greaterThan(0));
    if (paid.length === 0) throw new DomainError('HR_BANK_FILE_EMPTY', 422, 'Bảng lương này không có khoản thực nhận nào để chuyển');
    if (paid.length > HR_BANK_FILE_MAX_PEOPLE) throw new DomainError('EXPORT_TOO_LARGE', 422, `Có hơn ${HR_BANK_FILE_MAX_PEOPLE} người trong bảng lương này; không xuất được một lần`);
    const ids = paid.map((l) => l.employee_id);
    const employees = await ctx.trx
      .selectFrom('crove_hr.payroll_employee')
      .select(['id', 'display_name', 'erased_at', 'bank_account_sealed'])
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
    const items = paid.map((l) => ({ sealed: (byId.get(l.employee_id) as { bank_account_sealed: string }).bank_account_sealed, place: ACCOUNT_PLACE, ref: subjectOf(l.employee_id) }));
    const opened = await ctx.openMany(items);
    // A key shredded since the check (an erasure in between) reads as erased: the same refusal.
    const gone = opened.filter((v) => typeof v !== 'string').length;
    if (gone > 0) throw new DomainError('HR_BANK_ACCOUNT_MISSING', 422, `${gone} người trong bảng lương chưa có số tài khoản ngân hàng; hãy bổ sung rồi xuất lại`, { missing: gone });
    const bank = clean(input.bankName);
    const content = `Luong thang ${monthText(run.month)}`;
    const rows = paid
      .map((l, i) => ({ name: clean((byId.get(l.employee_id) as { display_name: string }).display_name), account: clean(String(opened[i]).replace(/\s+/g, '')), amount: money(l.net as string).toFixed() }))
      .sort((a, b) => a.name.localeCompare(b.name, 'vi') || a.account.localeCompare(b.account))
      .map((r, i) => ({ seq: String(i + 1), name: r.name, account: r.account, bank, amount: r.amount, content }));
    const total = rows.reduce((acc, r) => acc.plus(r.amount), new Decimal(0));
    const columns = input.columns ?? [...HR_BANK_FILE_COLUMNS];
    return { runId: run.id, month: run.month, columns, rows, total: total.toFixed() };
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
