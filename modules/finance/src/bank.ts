// Bank statements (issue #326, stage 1): a bank's Excel or CSV export, read in the browser, becomes the statement lines
// of one bank account, deduplicated as ADR-0021 section 6 says (domain/bank-statement.ts). A line becomes a bank voucher
// in stage 2a (bank-match.ts).
// - finance.bank.preview: checks a file against what the account has and answers line by line. It writes nothing.
// - finance.bank.import: checks it again and stores its new and ambiguous lines, refusing a file with an invalid row.
//   R1: it records the bank's own figures and posts nothing. Imports of one account are serialized by a
//   transaction-level advisory lock, so two at once cannot both store the same line: the second waits, then sees the
//   first's lines (READ COMMITTED, the runtime's isolation for commands). The unique key on (account, dedupe_key)
//   refuses a double from any writer anyway, and the insert skips a key already there rather than failing.
//   A reference the account already holds with another date or amount (#2191) is a conflict, not a duplicate: the key
//   `ref:<reference>` stays as ADR-0021 fixed it (so a transaction seen from a feed and in a file is one line, whichever
//   date format each prints), the amount and date are compared on top of it, and a line that disagrees is stored
//   keyless and flagged (ambiguous), as a line "to look at" is, instead of being dropped. Statements and feed pulls alike.
// - finance.bank.platform_lines: the lines of all accounts of an entity whose description names a platform (Ads, slice D2).
// - finance.bank.lines: the stored lines of one account for a month, quarter or year, each with what became of it
//   (stage 2a, bank-match.ts: open, proposed as a voucher, or settled by one).
// - finance.bank.ingest (ADR-0039, #2044): the lines a bank feed reports, sent by the worker, checked and stored on the
//   same path as a statement's (the account lock, the ADR-0021 keys, the unique key), so a transaction that comes from
//   the feed and again in a file is one line. A system command: people import files; only feed jobs send lines.
import { sql } from 'kysely';
import { z } from 'zod';
import type { MemberRole } from '@crove/db';
import {
  BANK_PLATFORM_LINES_LIMIT,
  zBankFeedIngest,
  zBankStatementImport,
  type BankFeedIngest,
  zId,
  zLedgerPeriod,
  zLocalDate,
  type BankImportPreview,
  type BankImportResult,
  type BankLines,
  type BankPlatformLines,
  type BankStatementImport,
} from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';
import { resolveLegalEntity } from './legal-entity.ts';
import { Decimal } from '@crove/l10n-vn';
import { chartAccounts } from './accounts.ts';
import { bankLineStates } from './bank-match.ts';
import { checkLines, checkStatement, readFeedLines, readStatement, skipFedLines, type StatementCheck, type StoredChainLine, type StoredDateAmount, type StoredFacts } from './domain/bank-statement.ts';
import { ledgerPeriod } from './domain/ledger-reports.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
// Importing statements is data entry, like uploading invoices.
const IMPORTERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
export const BANK_IMPORT_KIND = 'finance.bank_statement';

// A bank account of the org: a TT133 account under 112, or a sub-account rolling up to one. An import needs it active.
export async function bankAccount(ctx: QueryContext, code: string, active: boolean) {
  const account = (await chartAccounts(ctx, [code])).get(code);
  if (!account || !account.rootCode.startsWith('112')) {
    throw new DomainError('NOT_A_BANK_ACCOUNT', 422, `Tài khoản ${code} không phải tài khoản tiền gửi ngân hàng (112) của tổ chức`, { code });
  }
  if (active && !account.active) {
    throw new DomainError('ACCOUNT_INACTIVE', 422, `Tài khoản ${code} đã ngừng sử dụng; hãy chọn tài khoản khác`, { codes: [code] });
  }
  return account;
}

type Chain = { before: StoredChainLine | null; within: StoredChainLine[] };

// What the account already has around a batch of lines, whatever its source: the stored keys among the batch's, the
// date and amount of stored lines on its days, the last stored line before its first day and the stored lines of its
// days, in import order. Of one legal entity (#1280): a bank account's lines are deduplicated and chained per entity.
async function storedAround(
  ctx: QueryContext,
  legalEntityId: string,
  bankAccountCode: string,
  lines: ReadonlyArray<{ date: string; reference: string | null }>,
  keys: ReadonlyArray<string | null>,
): Promise<{ stored: StoredFacts; chain: Chain }> {
  const dates = lines.map((l) => l.date).sort();
  const from = dates[0];
  const to = dates.at(-1);
  const batchKeys = keys.filter((k): k is string => k !== null);
  // The lines the account holds under the batch's keys, and under its references with no key: a line stored as a conflict
  // has none (#2191), so a reference that comes again with another date or amount is a conflict, never a silent
  // duplicate. The keys go through the unique index; only a keyless, flagged line is looked for by its reference, so the
  // lookup stays bounded by the batch and the conflicts, not the account's whole history.
  const batchRefs = [...new Set(lines.flatMap((l) => (l.reference ? [l.reference] : [])))];
  const storedRows =
    batchKeys.length === 0 && batchRefs.length === 0
      ? []
      : await ctx.trx
          .selectFrom('crove_finance.bank_line')
          .select(['dedupe_key', 'bank_ref', 'value_date', 'amount'])
          .where('org_id', '=', ctx.orgId)
          .where('legal_entity_id', '=', legalEntityId)
          .where('bank_account', '=', bankAccountCode)
          .where((eb) =>
            eb.or([
              ...(batchKeys.length > 0 ? [eb('dedupe_key', 'in', batchKeys)] : []),
              ...(batchRefs.length > 0 ? [eb.and([eb('dedupe_key', 'is', null), eb('ambiguous', '=', true), eb('bank_ref', 'in', batchRefs)])] : []),
            ]),
          )
          .orderBy('import_id')
          .orderBy('position')
          .execute();
  const storedKeys = storedRows.filter((r) => r.dedupe_key !== null);
  const refs = new Map<string, StoredDateAmount[]>();
  for (const r of storedRows) {
    if (r.bank_ref === null) continue;
    refs.set(r.bank_ref, [...(refs.get(r.bank_ref) ?? []), { date: r.value_date, amount: new Decimal(r.amount).toFixed() }]);
  }
  let within: Array<StoredChainLine> = [];
  let before: StoredChainLine | null = null;
  if (from && to) {
    within = await ctx.trx
      .selectFrom('crove_finance.bank_line')
      .select(['value_date as date', 'amount', 'running_balance as balance'])
      .where('org_id', '=', ctx.orgId)
      .where('legal_entity_id', '=', legalEntityId)
      .where('bank_account', '=', bankAccountCode)
      .where('value_date', '>=', from)
      .where('value_date', '<=', to)
      .orderBy('value_date')
      .orderBy('import_id')
      .orderBy('position')
      .execute();
    before =
      (await ctx.trx
        .selectFrom('crove_finance.bank_line')
        .select(['value_date as date', 'amount', 'running_balance as balance'])
        .where('org_id', '=', ctx.orgId)
        .where('legal_entity_id', '=', legalEntityId)
        .where('bank_account', '=', bankAccountCode)
        .where('value_date', '<', from)
        .orderBy('value_date', 'desc')
        .orderBy('import_id', 'desc')
        .orderBy('position', 'desc')
        .executeTakeFirst()) ?? null;
  }
  const dateAmounts = new Set(within.map((l) => `${l.date}|${new Decimal(l.amount).toFixed()}`));
  return {
    stored: { keys: new Set(storedKeys.map((k) => k.dedupe_key as string)), dateAmounts, refs },
    chain: {
      before: before && { ...before, amount: new Decimal(before.amount).toFixed(), balance: before.balance === null ? null : new Decimal(before.balance).toFixed() },
      within: within.map((l) => ({ ...l, amount: new Decimal(l.amount).toFixed(), balance: l.balance === null ? null : new Decimal(l.balance).toFixed() })),
    },
  };
}

// A statement file checked against the account.
async function check(ctx: QueryContext, input: BankStatementImport, legalEntityId: string): Promise<StatementCheck> {
  const { lines, keys } = readStatement(input);
  const { stored, chain } = await storedAround(ctx, legalEntityId, input.bankAccount, lines, keys);
  const checked = checkStatement(input, stored, chain);
  // Only once the feed has pulled: before that nothing it supplies is in the books, and its first pull may start later than the day set (the day then moves up), so a file's lines are kept.
  const cutover = await feedCutover(ctx, legalEntityId, input.bankAccount, true);
  return cutover ? skipFedLines(checked, cutover) : checked;
}

// The day a bank feed takes over an account from statement files (#4218): the earliest cut-over of its mappings whose
// connection is still active, so a feed that stopped (expired or revoked) never leaves lines in neither source. Null when
// there is none: files and the feed are only deduplicated.
export async function feedCutover(ctx: QueryContext, legalEntityId: string, bankAccountCode: string, syncedOnly = false): Promise<string | null> {
  const row = await ctx.trx
    .selectFrom('crove_finance.bank_feed_account as a')
    .innerJoin('crove_kernel.channel_connection as c', (j) => j.onRef('c.org_id', '=', 'a.org_id').onRef('c.id', '=', 'a.channel_connection_id'))
    .select((eb) => eb.fn.min('a.feed_from').as('feed_from'))
    .where('a.org_id', '=', ctx.orgId)
    .where('a.legal_entity_id', '=', legalEntityId)
    .where('a.bank_account', '=', bankAccountCode)
    .where('c.status', '=', 'active')
    .$if(syncedOnly, (q) => q.where('a.cursor', 'is not', null))
    .executeTakeFirst();
  return row?.feed_from ?? null;
}

// Stores the lines a check found new or ambiguous as one import of the account, under the account's lock (the caller
// holds it), and returns the import's id. Every source stores through here (ADR-0039).
async function storeLines(ctx: CommandContext, legalEntityId: string, bankAccountCode: string, lines: StatementCheck['lines']): Promise<string> {
  // Time-ordered and taken under the lock, so ordering by import_id is the order the imports were made in.
  const { rows: ids } = await sql<{ id: string }>`SELECT crove_kernel.uuid_v7() AS id`.execute(ctx.trx);
  const importId = ids[0]?.id;
  if (!importId) throw new DomainError('INTERNAL', 500, 'Lỗi hệ thống');
  const actor = ctx.actor.type === 'user' ? ctx.actor.userId : null;
  let stored = 0;
  // In chunks, so a long batch stays under the bind-parameter limit.
  for (let i = 0; i < lines.length; i += 500) {
    const chunk = lines.slice(i, i + 500);
    const inserted = await ctx.trx
      .insertInto('crove_finance.bank_line')
      .values(
        chunk.map((l) => ({
          org_id: ctx.orgId,
          legal_entity_id: legalEntityId,
          bank_account: bankAccountCode,
          import_id: importId,
          position: l.position,
          value_date: l.date,
          description: l.description,
          amount: l.amount,
          running_balance: l.balance,
          bank_ref: l.reference,
          counterparty_account: l.counterpartyAccount ?? null,
          dedupe_key: l.key,
          ambiguous: l.ambiguous,
          created_by: actor,
        })),
      )
      .onConflict((oc) => oc.columns(['org_id', 'legal_entity_id', 'bank_account', 'dedupe_key']).where('dedupe_key', 'is not', null).doNothing())
      .returning('id')
      .execute();
    stored += inserted.length;
  }
  // Under the lock nothing else stores lines of this account, so every line the check called new was stored.
  if (stored !== lines.length) throw new DomainError('RETRY', 409, 'Xung đột đồng thời, hãy thử lại');
  return importId;
}

const lockAccount = (ctx: QueryContext, legalEntityId: string, code: string) =>
  sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`${BANK_IMPORT_KIND}:${ctx.orgId}:${legalEntityId}:${code}`}, 0))`.execute(ctx.trx);

export const bankPreview = defineQuery({
  name: 'finance.bank.preview',
  input: zBankStatementImport,
  access: IMPORTERS,
  handler: async (ctx, input): Promise<BankImportPreview> => {
    await bankAccount(ctx, input.bankAccount, true);
    return (await check(ctx, input, await resolveLegalEntity(ctx, input.legalEntityId))).preview;
  },
});

// A statement file checked against the account and what it already has, writing nothing: what a file received is staged
// with (#2142), so a member sees the account, the lines, the period and the totals before anything is stored.
export async function previewStatement(ctx: QueryContext, input: BankStatementImport, legalEntityId: string): Promise<BankImportPreview> {
  await bankAccount(ctx, input.bankAccount, true);
  return (await check(ctx, input, legalEntityId)).preview;
}

// Checks a statement file against the account and stores its new and ambiguous lines as one import, under the account's
// lock, refusing a file with an invalid row (BANK_IMPORT_INVALID, before anything is written). The browser import
// (finance.bank.import) and a statement read from a forwarded or dropped file (finance.bank.statement_file, #2142) store
// through here, so both keep the same lines and the same keys. `fileId`, for a file received, is named in the audit row.
// `shownConflicts`, for a statement a member decides from a card (#2191): the file rows whose conflicts the card told
// them about. A conflict on any other row (a line the books took since the file was read) refuses the import, before
// anything is written, so the member never imports a conflict they were not shown. Compared by row, not by count: a
// conflict that went away while another appeared leaves the count as it was.
export async function importStatement(ctx: CommandContext, input: BankStatementImport, legalEntityId: string, fileId?: string, shownConflicts?: ReadonlySet<number>): Promise<BankImportResult> {
  await bankAccount(ctx, input.bankAccount, true);
  await lockAccount(ctx, legalEntityId, input.bankAccount);
  const { preview, lines } = await check(ctx, input, legalEntityId);
  if (!preview.ok) {
    throw new DomainError('BANK_IMPORT_INVALID', 422, 'Sao kê có dòng không đọc được; hãy xem lại trước khi nhập', {
      rows: preview.rows.filter((r) => r.errors.length > 0).map((r) => r.rowNo),
    });
  }
  if (shownConflicts !== undefined && preview.rows.some((r) => r.status === 'conflict' && !shownConflicts.has(r.rowNo))) {
    throw new DomainError('STATEMENT_CONFLICTS_CHANGED', 409, 'Sổ vừa có thêm dòng trùng mã tham chiếu với sao kê này nhưng khác ngày hoặc số tiền; hãy xem lại các dòng, bấm Đọc lại ở tệp này rồi nhập', {
      conflicts: preview.counts.conflict,
    });
  }
  const importId = await storeLines(ctx, legalEntityId, input.bankAccount, lines);
  const result = { importId, counts: preview.counts, breaks: preview.breaks };
  ctx.audit({
    bankAccount: input.bankAccount,
    importId,
    filename: input.filename,
    from: preview.from,
    to: preview.to,
    ...preview.counts,
    breaks: preview.breaks.length,
    // The lines the feed's cut-over day kept out (#4218), counted among the duplicates above.
    ...(preview.feed ? { feedFrom: preview.feed.from, feedSkipped: preview.feed.leftOut } : {}),
    ...(fileId ? { fileId, source: 'file' } : {}),
  });
  await ctx.activity(
    'finance.bank_account',
    importId,
    'bank.statement_imported',
    `Nhập sao kê ${input.bankAccount}: ${preview.counts.new + preview.counts.ambiguous + preview.counts.conflict} dòng mới, ${preview.counts.duplicate} dòng đã có${preview.counts.conflict > 0 ? `, ${preview.counts.conflict} dòng trùng mã tham chiếu nhưng khác ngày hoặc số tiền` : ''}`,
    // An import with no new line stores no bank_line to take the entity from (#1728).
    { legalEntityId },
  );
  // Lines that need a look (a conflict is one too, #2191): the owners and admins are told (#671, finance.notification.dispatch).
  const toLookAt = preview.counts.ambiguous + preview.counts.conflict;
  if (toLookAt > 0) await ctx.emit('finance.bank.imported', { importId, bankAccount: input.bankAccount, ambiguous: toLookAt });
  return result;
}

export const bankImport = defineCommand({
  name: 'finance.bank.import',
  input: zBankStatementImport,
  risk: 'R1',
  sideEffect: 'internal',
  access: IMPORTERS,
  handler: async (ctx, input): Promise<BankImportResult> => importStatement(ctx, input, await resolveLegalEntity(ctx, input.legalEntityId)),
});

export const bankIngest = defineCommand({
  name: 'finance.bank.ingest',
  input: zBankFeedIngest,
  // Records the bank's own figures and posts nothing, as an import does (R1). The feed's network call is the job's,
  // before this runs.
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: (ctx, input): Promise<BankImportResult> => ingestFeedLines(ctx, input),
});

// A feed's lines checked and stored as one import of the account (ADR-0039 point 1): finance.bank.ingest, and the
// pull of a mapped bank feed account (finance.bank_feed.record_pull), which names the account and entity itself.
export async function ingestFeedLines(ctx: CommandContext, input: BankFeedIngest): Promise<BankImportResult> {
  await bankAccount(ctx, input.bankAccount, true);
  const legalEntityId = await resolveLegalEntity(ctx, input.legalEntityId);
  const read = readFeedLines(input.lines);
  if (!read.ok) throw new DomainError('BANK_FEED_INVALID', 422, 'Nguồn giao dịch ngân hàng gửi dòng không hợp lệ', { rows: read.rows });
  await lockAccount(ctx, legalEntityId, input.bankAccount);
  const { stored, chain } = await storedAround(ctx, legalEntityId, input.bankAccount, read.lines, read.keys);
  const { statuses, toStore, breaks } = checkLines(read.lines, read.keys, stored, chain);
  const importId = await storeLines(ctx, legalEntityId, input.bankAccount, toStore);
  // A batch the account already has stores nothing; its importId then names no line, as an import of a known file.
  // The feed's lines were checked whole above, so none is invalid.
  const counts = { new: 0, duplicate: 0, ambiguous: 0, conflict: 0, invalid: 0 };
  for (const status of statuses) counts[status]++;
  const dates = read.lines.map((l) => l.date);
  ctx.audit({ bankAccount: input.bankAccount, importId, source: input.source, from: dates[0], to: dates.at(-1), ...counts, breaks: breaks.length });
  // Only a pull that stored lines shows on the account's timeline (the import shows every file a person brought).
  const storedCount = counts.new + counts.ambiguous + counts.conflict;
  if (storedCount > 0) {
    await ctx.activity(
      'finance.bank_account',
      importId,
      'bank.feed_received',
      `Nhận giao dịch ngân hàng ${input.bankAccount} (${input.source}): ${storedCount} dòng mới, ${counts.duplicate} dòng đã có${counts.conflict > 0 ? `, ${counts.conflict} dòng trùng mã tham chiếu nhưng khác ngày hoặc số tiền` : ''}`,
      { legalEntityId },
    );
  }
  // Lines that need a look (a conflict is one too, #2191): the owners and admins are told, as for an import (#671).
  const toLookAt = counts.ambiguous + counts.conflict;
  if (toLookAt > 0) await ctx.emit('finance.bank.imported', { importId, bankAccount: input.bankAccount, ambiguous: toLookAt });
  return { importId, counts, breaks };
}

export const bankLines = defineQuery({
  name: 'finance.bank.lines',
  input: z.object({ bankAccount: z.string().max(50), period: zLedgerPeriod, legalEntityId: zId.optional() }),
  access: ALL,
  handler: async (ctx, input): Promise<BankLines> => {
    await bankAccount(ctx, input.bankAccount, false);
    const period = ledgerPeriod(input.period);
    // The lines of one legal entity (#1280).
    const legalEntityId = await resolveLegalEntity(ctx, input.legalEntityId);
    const rows = await ctx.trx
      .selectFrom('crove_finance.bank_line')
      .select(['id', 'value_date', 'description', 'amount', 'running_balance', 'bank_ref', 'ambiguous', 'import_id'])
      .where('org_id', '=', ctx.orgId)
      .where('legal_entity_id', '=', legalEntityId)
      .where('bank_account', '=', input.bankAccount)
      .where('value_date', '>=', period.from)
      .where('value_date', '<=', period.to)
      .orderBy('value_date')
      .orderBy('import_id')
      .orderBy('position')
      .execute();
    const states = await bankLineStates(ctx, rows.map((r) => r.id));
    let moneyIn = new Decimal(0);
    let moneyOut = new Decimal(0);
    const lines = rows.map((r) => {
      const amount = new Decimal(r.amount);
      if (amount.isPositive()) moneyIn = moneyIn.plus(amount);
      else moneyOut = moneyOut.plus(amount.abs());
      return {
        id: r.id,
        date: r.value_date,
        description: r.description,
        amount: amount.toFixed(),
        balance: r.running_balance === null ? null : new Decimal(r.running_balance).toFixed(),
        reference: r.bank_ref,
        ambiguous: r.ambiguous,
        importId: r.import_id,
        state: states.get(r.id) ?? { status: 'open' as const },
      };
    });
    return { bankAccount: input.bankAccount, from: period.from, to: period.to, lines, moneyIn: moneyIn.toFixed(), moneyOut: moneyOut.toFixed() };
  },
});

// The lines of every bank and card account of one legal entity in a range whose description holds one of the terms as
// whole words, with marks and case set aside as the search folds them (crove_kernel.search_fold): what Ads lays beside a
// month's spend (slice D2, plan docs/plan/ads.md section 6). Read only, and the same rows `finance.bank.lines` shows, so
// the row policy and the legal entity scope decide what is seen.
export const bankPlatformLines = defineQuery({
  name: 'finance.bank.platform_lines',
  input: z.object({ from: zLocalDate, to: zLocalDate, terms: z.array(z.string().min(2).max(60)).min(1).max(8), legalEntityId: zId.optional() }),
  access: ALL,
  handler: async (ctx, input): Promise<BankPlatformLines> => {
    const legalEntityId = await resolveLegalEntity(ctx, input.legalEntityId);
    // A folded description is words of a-z and 0-9 apart by one space, so padded with spaces a term is found only as whole words.
    const named = sql<boolean>`pg_catalog.strpos(' ' || crove_kernel.search_fold(l.description) || ' ', ' ' || crove_kernel.search_fold(t.term) || ' ') > 0`;
    const rows = await ctx.trx
      .selectFrom('crove_finance.bank_line as l')
      .select(['l.id', 'l.bank_account', 'l.value_date', 'l.description', 'l.amount'])
      .where('l.org_id', '=', ctx.orgId)
      .where('l.legal_entity_id', '=', legalEntityId)
      .where('l.value_date', '>=', input.from)
      .where('l.value_date', '<=', input.to)
      .where(sql<boolean>`EXISTS (SELECT 1 FROM pg_catalog.unnest(${input.terms}::text[]) AS t (term) WHERE crove_kernel.search_fold(t.term) <> '' AND ${named})`)
      .orderBy('l.value_date', 'desc')
      .orderBy('l.import_id')
      .orderBy('l.position')
      .limit(BANK_PLATFORM_LINES_LIMIT + 1)
      .execute();
    const kept = rows.slice(0, BANK_PLATFORM_LINES_LIMIT);
    const states = await bankLineStates(ctx, kept.map((r) => r.id));
    return {
      from: input.from,
      to: input.to,
      lines: kept.map((r) => ({
        id: r.id,
        bankAccount: r.bank_account,
        date: r.value_date,
        description: r.description,
        amount: new Decimal(r.amount).toFixed(),
        state: states.get(r.id) ?? { status: 'open' as const },
      })),
      truncated: rows.length > BANK_PLATFORM_LINES_LIMIT,
    };
  },
});
