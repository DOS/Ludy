// SPDX-License-Identifier: AGPL-3.0-only
// A bank statement that arrives as a file (#2142): forwarded to the org's inbound address or dropped in the Inbox as an
// .xlsx or CSV, read in the parsing sandbox (kind bank_statement, the browser import's header detection) and STAGED: the
// lines are kept with the file's read, none is stored and no dedupe key is taken, until a member imports them. An email
// carries no proof of who sent it, so it can never write bank lines by itself; a forged statement a member skips leaves
// every key free for the real lines.
// - The account is never chosen by the file's sender: the account number in the file must be one an owner or admin mapped
//   to a bank account in Settings (finance.bank_feed.map, #2099); a file whose number is not mapped is an Inbox
//   exception (a failed read with the reason) and nothing is staged.
// - finance.bank.statement_stage (a system query, the worker's) maps the account number, checks the lines against the
//   account (writing nothing) and answers the summary the Inbox shows: account, lines, period, totals.
// - readStatementFile is the worker's side: the sandbox's answer is checked again, then the read is recorded
//   (kernel.extraction.record) as done (staged, with the rows) or failed (the exception).
// - finance.bank.statement_confirm (owners, admins, members; R1) stores the staged lines once through the import's own path
//   (the same checks, keys and account lock) and marks the read imported, in one transaction; finance.bank.statement_reject
//   skips it, storing nothing. Both run on the staged run only, locked, so two members cannot both decide it.
// - finance.bank.statement_lines (#2191): the staged lines as they stand against the account now, so the member who decides
//   sees each line, its reference, and the ones whose reference the account already holds with another date or amount
//   (conflicts: stored flagged when imported, never silently dropped as duplicates).
import { sql } from 'kysely';
import { z } from 'zod';
import { EXTRACT_LIMIT_RETRIES, EXTRACT_LIMITS, type ExtractClient } from '@crove/extract-contract';
import type { MemberRole } from '@crove/db';
import { BANK_IMPORT_MAX_ROWS, STAGED_STATEMENT_MAX_BYTES, STATEMENT_LINES_SHOWN, statementAmountText, zBankStatementRow, zId, zStatementSummary, type BankImportResult, type BankStatementRow, type StatementLines } from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, readVerified, type BlobStore, type QueryContext, type Runtime } from '@crove/kernel-runtime';
import { Decimal } from '@crove/l10n-vn';
import { maskAccountNumber } from './account-number.ts';
import { importStatement, previewStatement } from './bank.ts';
import { resolveLegalEntity } from './legal-entity.ts';

export const BANK_STATEMENT_ACTOR = { type: 'system' as const, component: 'finance.bank_statement' };
// Importing a statement is data entry, like uploading invoices: the browser import's roles.
const IMPORTERS: readonly MemberRole[] = ['owner', 'admin', 'member'];

const ZIP = 'application/zip';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const CSV = 'text/csv';

const zStatementFile = z.strictObject({
  fileId: zId,
  filename: z.string().max(255),
  // The digits of the account number the file names, or null when it names none.
  accountNumber: z.string().regex(/^\d{6,20}$/).nullable(),
  rows: z.array(zBankStatementRow).min(1).max(BANK_IMPORT_MAX_ROWS),
});

// What the stage keeps with the file's read, next to the summary the Inbox shows: where the lines go when a member
// imports them, and the number that named the account, so the mapping is looked at again then.
// conflictRows: the file rows the card showed as conflicts, so an import refuses a conflict it did not show (#2191).
const zStagedSummary = zStatementSummary.extend({ accountNumber: z.string(), legalEntityId: zId, importId: zId.optional(), conflictRows: z.array(z.number().int().positive()).default([]) });
type StagedSummary = z.infer<typeof zStagedSummary>;
const zStagedResult = z.object({ kind: z.literal('bank_statement'), summary: zStagedSummary, rows: z.array(zBankStatementRow).optional() });

// What became of the file. unmapped: no mapping for its account number (or the file names none), ambiguous: the number is
// mapped to two different bank accounts or entities, refused: the lines would not be accepted (an invalid row, an account
// that is gone or stopped). Only staged goes on, and nothing is written in any case.
export type StatementStageOutcome =
  | { outcome: 'staged'; summary: StagedSummary }
  | { outcome: 'unmapped'; accountNumber: string | null }
  | { outcome: 'ambiguous'; accountNumber: string }
  | { outcome: 'refused'; code: string; message: string; rows: number[] };

type Place = { kind: 'none' } | { kind: 'ambiguous' } | { kind: 'one'; bankAccount: string; legalEntityId: string };

// The bank account and legal entity an account number is mapped to: by a bank feed mapping (#2099), whose account number is
// the digits of its external account id (banks print it with spaces or dots), or by a number an owner or admin recorded on
// the bank account itself (#2183, the way without a bank feed). The same account named by both is one place; two
// different accounts are ambiguous, and nothing is staged against a guess.
async function mappedPlace(ctx: QueryContext, accountNumber: string): Promise<Place> {
  const fed = await ctx.trx
    .selectFrom('crove_finance.bank_feed_account')
    .select(['bank_account', 'legal_entity_id'])
    .where('org_id', '=', ctx.orgId)
    .where(sql<boolean>`pg_catalog.regexp_replace(external_account_id, '[^0-9]', '', 'g') = ${accountNumber}`)
    .execute();
  const recorded = await ctx.trx
    .selectFrom('crove_finance.bank_account_number')
    .select(['bank_account', 'legal_entity_id'])
    .where('org_id', '=', ctx.orgId)
    .where('account_number', '=', accountNumber)
    .execute();
  const places = new Map([...fed, ...recorded].map((m) => [`${m.legal_entity_id}|${m.bank_account}`, m]));
  if (places.size > 1) return { kind: 'ambiguous' };
  const [place] = [...places.values()];
  return place ? { kind: 'one', bankAccount: place.bank_account, legalEntityId: place.legal_entity_id } : { kind: 'none' };
}

// Refusals the file can be told about; anything else is a fault and the job is retried.
const REFUSED_CODES: ReadonlySet<string> = new Set(['NOT_A_BANK_ACCOUNT', 'ACCOUNT_INACTIVE']);

export const bankStatementStage = defineQuery({
  name: 'finance.bank.statement_stage',
  input: zStatementFile,
  access: 'system',
  handler: async (ctx, input): Promise<StatementStageOutcome> => {
    if (input.accountNumber === null) return { outcome: 'unmapped', accountNumber: null };
    const place = await mappedPlace(ctx, input.accountNumber);
    if (place.kind === 'none') return { outcome: 'unmapped', accountNumber: input.accountNumber };
    if (place.kind === 'ambiguous') return { outcome: 'ambiguous', accountNumber: input.accountNumber };
    // The rows are kept with the file's read until a member decides: a bounded amount, refused with the reason past it.
    if (Buffer.byteLength(JSON.stringify(input.rows), 'utf8') > STAGED_STATEMENT_MAX_BYTES) return { outcome: 'refused', code: 'STATEMENT_TOO_LARGE', message: TOO_BIG, rows: [] };
    try {
      const preview = await previewStatement(ctx, { bankAccount: place.bankAccount, filename: input.filename, rows: input.rows, legalEntityId: place.legalEntityId }, place.legalEntityId);
      if (!preview.ok) {
        return { outcome: 'refused', code: 'BANK_IMPORT_INVALID', message: 'Sao kê có dòng không đọc được', rows: preview.rows.filter((r) => r.errors.length > 0).map((r) => r.rowNo).slice(0, 20) };
      }
      let totalIn = new Decimal(0);
      let totalOut = new Decimal(0);
      for (const row of preview.rows) {
        if (row.amount === null) continue;
        const amount = new Decimal(row.amount);
        if (amount.isNegative()) totalOut = totalOut.plus(amount.abs());
        else totalIn = totalIn.plus(amount);
      }
      // A total the summary cannot hold (zMoney has 16 integer digits) would drop the statement out of the Inbox: refused.
      if (totalIn.gte('1e16') || totalOut.gte('1e16')) return { outcome: 'refused', code: 'STATEMENT_TOTAL_TOO_LARGE', message: 'Tổng tiền của sao kê vượt giới hạn; hãy kiểm tra các số tiền trong tệp', rows: [] };
      return {
        outcome: 'staged',
        summary: {
          state: 'staged',
          accountNumber: input.accountNumber,
          accountMask: maskAccountNumber(input.accountNumber),
          bankAccount: place.bankAccount,
          legalEntityId: place.legalEntityId,
          filename: input.filename,
          lines: preview.rows.length,
          newLines: preview.counts.new + preview.counts.ambiguous + preview.counts.conflict,
          duplicateLines: preview.counts.duplicate,
          conflictLines: preview.counts.conflict,
          conflictRows: preview.rows.filter((r) => r.status === 'conflict').map((r) => r.rowNo),
          from: preview.from,
          to: preview.to,
          totalIn: totalIn.toFixed(),
          totalOut: totalOut.toFixed(),
        },
      };
    } catch (error) {
      if (error instanceof DomainError && REFUSED_CODES.has(error.code)) return { outcome: 'refused', code: error.code, message: error.message, rows: [] };
      throw error;
    }
  },
});

// The newest run of a file: the run a member decides. Null when the file has no run, or its newest run is not a staged
// statement (decided already, read again, or no statement at all). `lock`: the run is locked for the decision, after
// the file row, which is the order a re-read and a record take them in (kernel.extraction), so a decision and a re-read
// of the same file never wait on each other in a circle.
async function stagedRun(ctx: QueryContext, fileId: string, lock: boolean): Promise<{ summary: StagedSummary; rows: BankStatementRow[] } | null> {
  if (lock) {
    await ctx.trx.selectFrom('crove_kernel.file').select('id').where('org_id', '=', ctx.orgId).where('id', '=', fileId).forUpdate().executeTakeFirst();
  }
  let query = ctx.trx
    .selectFrom('crove_kernel.extraction')
    .select(['result', 'status'])
    .where('org_id', '=', ctx.orgId)
    .where('file_id', '=', fileId)
    .orderBy('version', 'desc')
    .limit(1);
  if (lock) query = query.forUpdate();
  const run = await query.executeTakeFirst();
  if (!run || run.status !== 'done') return null;
  const parsed = zStagedResult.safeParse(run.result);
  if (!parsed.success || parsed.data.summary.state !== 'staged' || !parsed.data.rows) return null;
  return { summary: parsed.data.summary, rows: parsed.data.rows };
}

// One decision at a time per file: a second member waits here until the first has committed, and then finds the file's
// newest run changed (a decided statement is no longer staged). Without it both would read the same staged run.
const lockStatement = (ctx: QueryContext, fileId: string) =>
  sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`finance.bank.statement:${ctx.orgId}:${fileId}`}, 0))`.execute(ctx.trx);

const notStaged = () => new DomainError('STATEMENT_NOT_STAGED', 409, 'Sao kê này đã được xử lý hoặc đã được đọc lại; hãy tải lại danh sách');

export const bankStatementConfirm = defineCommand({
  name: 'finance.bank.statement_confirm',
  input: z.strictObject({ fileId: zId }),
  // Records the bank's own figures and posts nothing, as an import does (R1).
  risk: 'R1',
  sideEffect: 'internal',
  access: IMPORTERS,
  handler: async (ctx, input): Promise<BankImportResult> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới nhập được sao kê');
    await lockStatement(ctx, input.fileId);
    const staged = await stagedRun(ctx, input.fileId, true);
    if (!staged) throw notStaged();
    // The mapping is looked at again: an owner may have removed or moved it since the file was read, and the lines go to
    // the account it names now, never to one the file's sender or an old reading chose.
    const place = await mappedPlace(ctx, staged.summary.accountNumber);
    if (place.kind !== 'one' || place.bankAccount !== staged.summary.bankAccount || place.legalEntityId !== staged.summary.legalEntityId) {
      throw new DomainError('STATEMENT_MAPPING_CHANGED', 409, 'Số tài khoản của sao kê không còn liên kết với tài khoản ngân hàng này; hãy kiểm tra Cài đặt rồi đọc lại tệp');
    }
    const legalEntityId = await resolveLegalEntity(ctx, place.legalEntityId);
    const result = await importStatement(ctx, { bankAccount: place.bankAccount, filename: staged.summary.filename, rows: staged.rows, legalEntityId }, legalEntityId, input.fileId, new Set(staged.summary.conflictRows));
    await ctx.run('kernel.extraction.statement_state', {
      fileId: input.fileId,
      state: 'imported',
      newLines: result.counts.new + result.counts.ambiguous + result.counts.conflict,
      duplicateLines: result.counts.duplicate,
      importId: result.importId,
    });
    return result;
  },
});

export const bankStatementReject = defineCommand({
  name: 'finance.bank.statement_reject',
  input: z.strictObject({ fileId: zId }),
  risk: 'R1',
  sideEffect: 'internal',
  access: IMPORTERS,
  handler: async (ctx, input): Promise<{ fileId: string }> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới bỏ qua được sao kê');
    await lockStatement(ctx, input.fileId);
    if (!(await stagedRun(ctx, input.fileId, true))) throw notStaged();
    // Nothing was stored in the account, and every dedupe key stays free. The rows themselves stay in the finished run's
    // result, which nothing may change (extraction_guard) and no tenant role may delete, until the org is purged: they
    // are bounded (STAGED_STATEMENT_MAX_BYTES) and read by no screen once the statement is skipped. Dropping them after a
    // retention period needs a purge function in a migration; the rule proposed in #2191 is in its PR.
    await ctx.run('kernel.extraction.statement_state', { fileId: input.fileId, state: 'rejected' });
    ctx.audit({ fileId: input.fileId });
    return { fileId: input.fileId };
  },
});

export const bankStatementLines = defineQuery({
  name: 'finance.bank.statement_lines',
  input: z.strictObject({ fileId: zId }),
  access: IMPORTERS,
  handler: async (ctx, input): Promise<StatementLines> => {
    const staged = await stagedRun(ctx, input.fileId, false);
    if (!staged) throw notStaged();
    // Against the account as it is now, not as it was when the file was read: a line another source stored since shows.
    const preview = await previewStatement(
      ctx,
      { bankAccount: staged.summary.bankAccount, filename: staged.summary.filename, rows: staged.rows, legalEntityId: staged.summary.legalEntityId },
      staged.summary.legalEntityId,
    );
    const conflicts = preview.rows.filter((r) => r.status === 'conflict');
    const others = preview.rows.filter((r) => r.status !== 'conflict');
    // Every conflict is listed, whatever the cap: importing stores them all, so none may go unseen. The other lines fill
    // what is left of the cap.
    return { lines: [...conflicts, ...others].slice(0, Math.max(STATEMENT_LINES_SHOWN, conflicts.length)), total: preview.rows.length, conflicts: conflicts.length };
  },
});

interface StatementFileSource {
  id: string;
  filename: string;
  content_type: string;
  storage_key: string;
  generation: string | null;
  sha256: string;
  hasExtraction: boolean;
  // With a version: that re-read is still pending.
  due: boolean;
}

export interface StatementFileDeps {
  runtime: Runtime;
  store: BlobStore;
  extract: ExtractClient;
}

const vnNumber = (n: number) => n.toLocaleString('vi-VN');

// What a file that is no statement says in the Inbox, and what the exceptions say: the reason and what to do.
export const NOT_A_STATEMENT = 'Không nhận ra sao kê ngân hàng: cần dòng tiêu đề có cột ngày và số tiền, và dòng "Số tài khoản" phía trên bảng';
const TOO_LARGE = 'Tệp sao kê quá lớn (tối đa 10 MB); hãy chia thành nhiều tệp nhỏ hơn';
const TOO_BIG = 'Sao kê có quá nhiều dữ liệu để chờ nhập (tối đa 4 MB nội dung các dòng); hãy chia thành nhiều tệp theo tháng';
const TOO_MANY = `Sao kê có hơn ${vnNumber(EXTRACT_LIMITS.maxStatementRows)} dòng; hãy chia thành nhiều tệp theo tháng`;

export function unmappedMessage(accountNumber: string | null): string {
  return accountNumber === null
    ? 'Không tìm thấy số tài khoản trong sao kê (dòng "Số tài khoản" phía trên bảng); hãy nhập sao kê ở màn Ngân hàng và chọn tài khoản'
    : `Số tài khoản ${accountNumber} chưa được liên kết với tài khoản ngân hàng nào của tổ chức; nếu đây đúng là số tài khoản của tổ chức, hãy ghi số vào tài khoản ngân hàng ở Cài đặt, mục Số tài khoản ngân hàng (hoặc liên kết nguồn giao dịch ngân hàng), rồi bấm Đọc lại ở tệp này; thư gửi đến không chứng minh người gửi là ai`;
}

function failureMessage(outcome: Exclude<StatementStageOutcome, { outcome: 'staged' }>): string {
  switch (outcome.outcome) {
    case 'unmapped':
      return unmappedMessage(outcome.accountNumber);
    case 'ambiguous':
      return `Số tài khoản ${outcome.accountNumber} được liên kết với nhiều tài khoản ngân hàng; hãy gỡ liên kết thừa trong Cài đặt rồi bấm Đọc lại ở tệp này`;
    case 'refused':
      return outcome.code === 'BANK_IMPORT_INVALID'
        ? `Sao kê có dòng không đọc được${outcome.rows.length > 0 ? ` (dòng ${outcome.rows.join(', ')} của tệp)` : ''}; hãy nhập sao kê ở màn Ngân hàng để xem từng dòng`
        : outcome.message;
  }
}

const AMOUNT_TEXT_MAX = 50;

// The statement's rows as the module takes them: the same amount text the browser import sends. An amount text longer
// than the module takes (#2191) is refused with its row, never cut: a cut text could read as another, smaller number.
export function statementFileRows(
  rows: ReadonlyArray<{ rowNo: number; date: string; description: string; reference: string; moneyIn: { kind: string; value: string } | null; moneyOut: { kind: string; value: string } | null; balance: { kind: string; value: string } | null }>,
): BankStatementRow[] | { tooLongRow: number } {
  const out: BankStatementRow[] = [];
  for (const r of rows) {
    const moneyIn = statementAmountText(r.moneyIn ?? undefined);
    const moneyOut = statementAmountText(r.moneyOut ?? undefined);
    const balance = statementAmountText(r.balance ?? undefined);
    if (moneyIn.length > AMOUNT_TEXT_MAX || moneyOut.length > AMOUNT_TEXT_MAX || balance.length > AMOUNT_TEXT_MAX) return { tooLongRow: r.rowNo };
    out.push({ rowNo: r.rowNo, date: r.date, description: r.description, moneyIn, moneyOut, balance, reference: r.reference });
  }
  return out;
}

// Fails the pending re-read `version` of a bank statement with the reason, for a job that kept failing (#2142): the run
// is a statement's, so a ZIP is let through, as for any record of a statement run.
export function recordStatementReadFailure(runtime: Runtime, orgId: string, fileId: string, version: number, error: string) {
  return runtime.execute(
    'kernel.extraction.record',
    { fileId, version, method: 'unsupported', status: 'failed', result: null, checks: [], error: error.slice(0, 2000), proposal: null, statement: true },
    { actor: BANK_STATEMENT_ACTOR, orgId },
  );
}

// Tries to read a received file as a bank statement, before it is read as an invoice or opened as an archive: an .xlsx
// arrives as a ZIP (its content is what tells it from an archive of invoices), a CSV with its own type. handled is true
// when the file's read is recorded here (staged or the exception), false when it is no statement and the caller goes
// on as before. `attempt` is the job's retry count: a sandbox that cannot answer throws and the job is retried; a
// timeout or memory answer is retried EXTRACT_LIMIT_RETRIES times first. `version` is a re-read someone asked for (the
// "Đọc lại" button, for instance once the account is mapped): it runs only while that run is still pending, and its
// outcome is recorded on that run. Nothing is stored in the account's lines here, however often a job runs.
export async function readStatementFile(deps: StatementFileDeps, orgId: string, fileId: string, attempt = 0, version?: number): Promise<{ handled: boolean }> {
  const actor = BANK_STATEMENT_ACTOR;
  const file = await deps.runtime.query<StatementFileSource | null>(
    'finance.extraction.file',
    { fileId, ...(version === undefined ? {} : { version }) },
    { actor: { type: 'system', component: 'finance.extract' }, orgId },
  );
  if (!file || ![ZIP, XLSX, CSV].includes(file.content_type)) return { handled: false };
  // Already read (a retried job, or an archive opened before), or a re-read that is no longer pending: nothing to do, and
  // the caller's own checks never run, as they never did for a file already read.
  if (version === undefined ? file.hasExtraction : !file.due) return { handled: true };
  const asCsv = file.content_type === CSV;
  const record = (status: 'done' | 'failed', fields: { error: string | null; result?: unknown; summary?: string; legalEntityId?: string }) =>
    deps.runtime.execute(
      'kernel.extraction.record',
      {
        fileId,
        ...(version === undefined ? {} : { version }),
        method: 'unsupported',
        status,
        result: fields.result ?? null,
        checks: [],
        error: fields.error,
        proposal: null,
        statement: true,
        ...(fields.legalEntityId ? { legalEntityId: fields.legalEntityId } : {}),
        ...(fields.summary ? { summary: fields.summary } : {}),
      },
      { actor, orgId },
    );
  const bytes = await readVerified(deps.store, { key: file.storage_key, generation: file.generation, sha256: file.sha256 });
  // Over the sandbox's statement cap the sandbox would refuse the body at its door: a big ZIP is an archive of invoices
  // (opened as before, with its own caps), a big CSV is too large to read.
  if (bytes.byteLength > EXTRACT_LIMITS.maxStatementBytes) {
    if (!asCsv) return { handled: false };
    await record('failed', { error: TOO_LARGE });
    return { handled: true };
  }
  const read = await deps.extract.extract('bank_statement', bytes);
  if (!read.ok) {
    const limitHit = read.code === 'timeout' || read.code === 'memory';
    if (limitHit && attempt < EXTRACT_LIMIT_RETRIES) throw new Error(`crove-extract stopped at a limit: ${read.code}`);
    // A ZIP the sandbox will not read as a statement may still be an archive of invoices: the caller opens it.
    if (!asCsv) return { handled: false };
    await record('failed', { error: read.code === 'too_large' ? TOO_LARGE : NOT_A_STATEMENT });
    return { handled: true };
  }
  const statement = read.statement;
  if (!statement.recognized) {
    if (!asCsv) return { handled: false };
    await record('failed', { error: NOT_A_STATEMENT });
    return { handled: true };
  }
  if (statement.tooMany) {
    await record('failed', { error: TOO_MANY });
    return { handled: true };
  }
  const rows = statementFileRows(statement.rows);
  if ('tooLongRow' in rows) {
    await record('failed', { error: `Dòng ${rows.tooLongRow} của tệp có số tiền quá dài (tối đa ${AMOUNT_TEXT_MAX} ký tự); hãy kiểm tra lại tệp` });
    return { handled: true };
  }
  // A read-only question: nothing is stored whatever happens to this job.
  const outcome = await deps.runtime.query<StatementStageOutcome>(
    'finance.bank.statement_stage',
    { fileId, filename: file.filename.slice(0, 255), accountNumber: statement.accountNumber, rows },
    { actor, orgId },
  );
  if (outcome.outcome !== 'staged') {
    await record('failed', { error: failureMessage(outcome).slice(0, 2000) });
    return { handled: true };
  }
  const { summary } = outcome;
  await record('done', {
    error: null,
    result: { kind: 'bank_statement', summary, rows },
    // The run belongs to the entity the account is mapped to: only members who see it see the statement's account and totals.
    legalEntityId: summary.legalEntityId,
    summary: `Sao kê tài khoản ${summary.bankAccount} chờ nhập: ${summary.lines} dòng, ${summary.newLines} dòng mới`,
  });
  return { handled: true };
}
