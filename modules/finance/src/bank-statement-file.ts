// SPDX-License-Identifier: AGPL-3.0-only
// A bank statement that arrives as a file (#2142): forwarded to the org's inbound address or dropped in the Inbox as an
// .xlsx or CSV, read in the parsing sandbox (kind bank_statement, the browser import's header detection) and stored as
// the bank lines of the account its own account number names. Nothing here is a proposal: the lines are the bank's own
// figures, stored as an import's are (finance.bank.import), so a line a statement and a feed both carry, or a file sent
// twice, is stored once. The account is never chosen by the file's sender: the account number in the file must be one an
// owner or admin mapped to a bank account in Settings (finance.bank_feed.map, #2099); a file whose number is not mapped
// is an Inbox exception (a failed read with the reason) and nothing is written.
// - finance.bank.statement_file (system) maps the account number, stores the lines and answers what became of the file.
// - readStatementFile is the worker's side: the sandbox's answer is checked again here, then the command runs and the
//   file's read is recorded (kernel.extraction.record) as done (imported) or failed (the exception).
import { sql } from 'kysely';
import { z } from 'zod';
import { EXTRACT_LIMIT_RETRIES, EXTRACT_LIMITS, type ExtractClient } from '@crove/extract-contract';
import { BANK_IMPORT_MAX_ROWS, statementAmountText, zBankStatementRow, zId, type BankImportResult, type BankStatementRow } from '@crove/kernel-contract';
import { DomainError, defineCommand, readVerified, type BlobStore, type Runtime } from '@crove/kernel-runtime';
import { importStatement } from './bank.ts';

export const BANK_STATEMENT_ACTOR = { type: 'system' as const, component: 'finance.bank_statement' };

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

// What became of the file. unmapped: no mapping for its account number (or the file names none), ambiguous: the number is
// mapped to two different bank accounts or entities, refused: the lines could not be stored (an invalid row, an account
// that is gone or stopped). Only imported writes anything.
export type StatementFileOutcome =
  | { outcome: 'imported'; importId: string; bankAccount: string; legalEntityId: string; counts: BankImportResult['counts'] }
  | { outcome: 'unmapped'; accountNumber: string | null }
  | { outcome: 'ambiguous'; accountNumber: string }
  | { outcome: 'refused'; code: string; message: string; rows: number[] };

// Refusals the file can be told about; anything else is a fault and the job is retried.
const REFUSED_CODES: ReadonlySet<string> = new Set(['BANK_IMPORT_INVALID', 'NOT_A_BANK_ACCOUNT', 'ACCOUNT_INACTIVE']);

export const bankStatementFile = defineCommand({
  name: 'finance.bank.statement_file',
  input: zStatementFile,
  // Records the bank's own figures and posts nothing, as an import does (R1).
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx, input): Promise<StatementFileOutcome> => {
    if (input.accountNumber === null) return { outcome: 'unmapped', accountNumber: null };
    // The mapping's account number is the digits of the external account id: banks print it with spaces or dots.
    const mapped = await ctx.trx
      .selectFrom('crove_finance.bank_feed_account')
      .select(['bank_account', 'legal_entity_id'])
      .where('org_id', '=', ctx.orgId)
      .where(sql<boolean>`pg_catalog.regexp_replace(external_account_id, '[^0-9]', '', 'g') = ${input.accountNumber}`)
      .execute();
    const places = new Map(mapped.map((m) => [`${m.legal_entity_id}|${m.bank_account}`, m]));
    if (places.size === 0) return { outcome: 'unmapped', accountNumber: input.accountNumber };
    if (places.size > 1) return { outcome: 'ambiguous', accountNumber: input.accountNumber };
    const [place] = [...places.values()];
    if (!place) return { outcome: 'unmapped', accountNumber: input.accountNumber };
    try {
      const result = await importStatement(
        ctx,
        { bankAccount: place.bank_account, filename: input.filename, rows: input.rows, legalEntityId: place.legal_entity_id },
        place.legal_entity_id,
        input.fileId,
      );
      return { outcome: 'imported', importId: result.importId, bankAccount: place.bank_account, legalEntityId: place.legal_entity_id, counts: result.counts };
    } catch (error) {
      // Raised before anything is written (the account check, the file's own check), so the transaction is whole.
      if (error instanceof DomainError && REFUSED_CODES.has(error.code)) {
        const rows = (error.details as { rows?: unknown } | undefined)?.rows;
        return { outcome: 'refused', code: error.code, message: error.message, rows: Array.isArray(rows) ? rows.filter((r): r is number => typeof r === 'number').slice(0, 20) : [] };
      }
      throw error;
    }
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
const TOO_MANY = `Sao kê có hơn ${vnNumber(EXTRACT_LIMITS.maxStatementRows)} dòng; hãy chia thành nhiều tệp theo tháng`;

export function unmappedMessage(accountNumber: string | null): string {
  return accountNumber === null
    ? 'Không tìm thấy số tài khoản trong sao kê (dòng "Số tài khoản" phía trên bảng); hãy nhập sao kê ở màn Ngân hàng và chọn tài khoản'
    : `Số tài khoản ${accountNumber} chưa được liên kết với tài khoản ngân hàng nào của tổ chức; hãy liên kết trong Cài đặt, mục nguồn giao dịch ngân hàng, rồi bấm Đọc lại ở tệp này`;
}

function failureMessage(outcome: Exclude<StatementFileOutcome, { outcome: 'imported' }>): string {
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

// The statement's rows as the module takes them: the same amount text the browser import sends.
export function statementFileRows(rows: ReadonlyArray<{ rowNo: number; date: string; description: string; reference: string; moneyIn: { kind: string; value: string } | null; moneyOut: { kind: string; value: string } | null; balance: { kind: string; value: string } | null }>): BankStatementRow[] {
  return rows.map((r) => ({
    rowNo: r.rowNo,
    date: r.date,
    description: r.description,
    moneyIn: statementAmountText(r.moneyIn ?? undefined).slice(0, 50),
    moneyOut: statementAmountText(r.moneyOut ?? undefined).slice(0, 50),
    balance: statementAmountText(r.balance ?? undefined).slice(0, 50),
    reference: r.reference,
  }));
}

// Tries to read a received file as a bank statement, before it is read as an invoice or opened as an archive: an .xlsx
// arrives as a ZIP (its content is what tells it from an archive of invoices), a CSV with its own type. handled is true
// when the file's read is recorded here (imported or the exception), false when it is no statement and the caller goes
// on as before. `attempt` is the job's retry count: a sandbox that cannot answer throws and the job is retried; a
// timeout or memory answer is retried EXTRACT_LIMIT_RETRIES times first. `version` is a re-read someone asked for (the
// "Đọc lại" button, for instance once the account is mapped): it runs only while that run is still pending, and its
// outcome is recorded on that run.
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
  const record = (status: 'done' | 'failed', fields: { error: string | null; result?: unknown; summary?: string }) =>
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
  const outcome = await deps.runtime.execute<StatementFileOutcome>(
    'finance.bank.statement_file',
    { fileId, filename: file.filename.slice(0, 255), accountNumber: statement.accountNumber, rows: statementFileRows(statement.rows) },
    // One key per run of the file: a job that stored the lines and then failed before recording the read (or was killed)
    // finds the stored answer instead of storing again, which lines with neither a reference nor a balance would not
    // guard against (the import marks them ambiguous and stores them). A re-read is another run, so it asks afresh.
    { actor, orgId, idempotencyKey: `bank-statement-file:${fileId}:${version ?? 0}` },
  );
  if (outcome.outcome !== 'imported') {
    await record('failed', { error: failureMessage(outcome).slice(0, 2000) });
    return { handled: true };
  }
  const { counts } = outcome;
  const newLines = counts.new + counts.ambiguous;
  await record('done', {
    error: null,
    result: { kind: 'bank_statement', summary: { bankAccount: outcome.bankAccount, importId: outcome.importId, newLines, duplicateLines: counts.duplicate } },
    summary: `Đã nhập sao kê tài khoản ${outcome.bankAccount}: ${newLines} dòng mới, ${counts.duplicate} dòng đã có`,
  });
  return { handled: true };
}
