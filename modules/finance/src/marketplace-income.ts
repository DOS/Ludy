// SPDX-License-Identifier: AGPL-3.0-only
// Marketplace income reports as files (#2516, ADR-0045 points 5 and 7, plan stock-and-marketplaces.md section 8.4): the income export of Shopee or TikTok Shop forwarded to the org's inbound
// address or dropped in the Inbox as an .xlsx or CSV, read in the parsing sandbox (kind marketplace_income, through the platform's profile) and STAGED: the lines are kept with the file's
// read, none is stored as a settlement, until a member confirms. Like the order report (#2515), a file's sender chooses nothing: the platform is told by the file's headers and shown for
// confirmation, the legal entity is the one the file was uploaded for (or the org's default), and a forged or unknown file stages nothing. No buyer data is read at all (the sandbox returns an
// allow-list of columns), so none can be stored, shown or logged, and nothing a file says reaches the audit facts beyond the platform and counts.
// - readMarketplaceIncomeFile is the worker's side, tried after the order report's and before the bank statement's: the sandbox's answer is checked again, then the read is recorded
//   (kernel.extraction.record) as done (staged, with the lines) or failed (the exception, with the reason); a file that is no income report is not handled and goes on as before.
// - finance.marketplace_income.staged and .preview (members) are what the Inbox card shows: the summary, and how the report stands against the org's orders and settlements now, with what
//   blocks confirming it.
// - finance.marketplace_income.confirm (owners, admins, members; R1) checks the report in code and stores ONE settlement with its lines (channel_settlement and _line, append-only) in
//   one transaction, and marks the read imported; it posts nothing: proposing the entry is a later step. finance.marketplace_income.reject skips it. Both run on the staged run only,
//   locked, so two members cannot both decide it.
// - The checks (each a blocker the preview names): every line has a payment date (the period is the first and last), the lines add up to the net the file states, every order the report
//   names is already known (the order report says what was sold, the income report only what was paid, so no order is made from it), no settlement of the platform that stands covers
//   part of the period, and no sale line is already stored in another settlement that stands. The last two are also the database's own refusals (20261126110000), so a race ends in a clear
//   message and nothing stored.
import { sql } from 'kysely';
import { z } from 'zod';
import { EXTRACT_LIMIT_RETRIES, EXTRACT_LIMITS, zExtractedMarketplaceIncome, type ExtractClient } from '@crove/extract-contract';
import type { MemberRole } from '@crove/db';
import { STAGED_STATEMENT_MAX_BYTES, zId, zMarketplaceIncomeSummary, type MarketplaceIncomeConfirmResult, type MarketplaceIncomePreview, type MarketplaceIncomeStaged, type MarketplaceIncomeSummary } from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, readVerified, type BlobStore, type QueryContext, type Runtime } from '@crove/kernel-runtime';
import { money, sum, toMoney } from '@crove/l10n-vn';
import { resolveLegalEntity } from './legal-entity.ts';

export const MARKETPLACE_INCOME_ACTOR = { type: 'system' as const, component: 'finance.marketplace_income' };
const IMPORTERS: readonly MemberRole[] = ['owner', 'admin', 'member'];

const ZIP = 'application/zip';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const CSV = 'text/csv';

type Platform = MarketplaceIncomeSummary['platform'];
const zLine = zExtractedMarketplaceIncome.shape.lines.element;
type StagedLine = z.infer<typeof zLine>;
const zStagedResult = z.object({ kind: z.literal('marketplace_income'), summary: zMarketplaceIncomeSummary, lines: z.array(zLine).optional() });

// How many orders of a report may be named in a message.
const NAMED_ORDERS = 10;
const BATCH = 500;

// What the table channel_settlement_line takes (numeric(20, 4), the deductions and the sale not below zero, net = sales - deductions + other), checked again on every line of a read before it is
// staged: the sandbox's answer is trusted for its shape, not for these figures, so a reader that drifts fails here with the row named and not at confirm with a raw CHECK error (#2753).
const MAX_AMOUNT = money('10000000000000000');
const NON_NEGATIVE = ['sales', 'sellerDiscount', 'commission', 'serviceFee', 'paymentFee', 'shipping', 'taxWithheld', 'refund'] as const;
export function badIncomeLines(lines: readonly StagedLine[]): number[] {
  const bad: number[] = [];
  for (const line of lines) {
    const fits = (value: string) => {
      const amount = money(value);
      return amount.decimalPlaces() <= 4 && amount.abs().lt(MAX_AMOUNT);
    };
    const parts = [...NON_NEGATIVE.map((f) => line[f]), line.other, line.net];
    const ok =
      parts.every(fits) &&
      NON_NEGATIVE.every((f) => !money(line[f]).isNegative()) &&
      money(line.net).eq(money(line.sales).minus(line.sellerDiscount).minus(line.commission).minus(line.serviceFee).minus(line.paymentFee).minus(line.shipping).minus(line.taxWithheld).minus(line.refund).plus(line.other));
    if (!ok) bad.push(line.rowNo);
  }
  return bad;
}

// The summary a staged read keeps: the file's own figures and the totals of its lines, nothing of the orders' content beyond counts.
export function incomeSummaryOf(
  read: { platform: Platform; profile: { version: string; confirmed: boolean }; sheet: string | null; lines: readonly StagedLine[]; statedNet: string | null; skipped: ReadonlyArray<{ reason: string }> },
  filename: string,
): MarketplaceIncomeSummary {
  const orders = new Set(read.lines.map((l) => l.orderNo));
  const total = (pick: (l: StagedLine) => string) => toMoney(sum(read.lines.map(pick)));
  const dates = read.lines.map((l) => l.paidAt);
  const dated = dates.every((d): d is string => d !== null);
  const sorted = dated ? [...(dates as string[])].sort() : [];
  return {
    state: 'staged',
    platform: read.platform,
    profileVersion: read.profile.version,
    profileConfirmed: read.profile.confirmed,
    filename,
    sheet: read.sheet,
    orders: orders.size,
    lines: read.lines.length,
    periodStart: dated && sorted.length > 0 ? (sorted[0] as string) : null,
    periodEnd: dated && sorted.length > 0 ? (sorted[sorted.length - 1] as string) : null,
    totals: {
      sales: total((l) => l.sales),
      sellerDiscount: total((l) => l.sellerDiscount),
      commission: total((l) => l.commission),
      serviceFee: total((l) => l.serviceFee),
      paymentFee: total((l) => l.paymentFee),
      shipping: total((l) => l.shipping),
      taxWithheld: total((l) => l.taxWithheld),
      refund: total((l) => l.refund),
      other: total((l) => l.other),
      net: total((l) => l.net),
    },
    statedNet: read.statedNet,
    ignoredRows: read.skipped.filter((s) => s.reason === 'no_order_no').length,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The staged read
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

type Staged = { summary: MarketplaceIncomeSummary; platform: Platform; lines: StagedLine[]; legalEntityId: string | null; sha256: string };

// The newest run of a file when it is a staged income report: the run a member decides. `lock`: the file row and the run are locked for the decision (the order a re-read and a record take
// them in, as for a bank statement and an order report).
async function stagedRun(ctx: QueryContext, fileId: string, lock: boolean): Promise<Staged | null> {
  const file = await ctx.trx.selectFrom('crove_kernel.file').select(['id', 'sha256']).where('org_id', '=', ctx.orgId).where('id', '=', fileId).$if(lock, (qb) => qb.forUpdate()).executeTakeFirst();
  if (!file) return null;
  let query = ctx.trx.selectFrom('crove_kernel.extraction').select(['result', 'status', 'legal_entity_id']).where('org_id', '=', ctx.orgId).where('file_id', '=', fileId).orderBy('version', 'desc').limit(1);
  if (lock) query = query.forUpdate();
  const run = await query.executeTakeFirst();
  if (!run || run.status !== 'done') return null;
  const parsed = zStagedResult.safeParse(run.result);
  if (!parsed.success || parsed.data.summary.state !== 'staged' || !parsed.data.lines) return null;
  return { summary: parsed.data.summary, platform: parsed.data.summary.platform, lines: parsed.data.lines, legalEntityId: run.legal_entity_id ?? null, sha256: file.sha256 };
}

const lockReport = (ctx: QueryContext, fileId: string) => sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`finance.marketplace_income.report:${ctx.orgId}:${fileId}`}, 0))`.execute(ctx.trx);
const notStaged = () => new DomainError('MARKETPLACE_INCOME_NOT_STAGED', 409, 'Báo cáo thu nhập này đã được xử lý hoặc đã được đọc lại; hãy tải lại danh sách');

const PLATFORM_NAME: Record<Platform, string> = { shopee: 'Shopee', tiktok_shop: 'TikTok Shop' };
const dmy = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;
const day = (value: unknown) => String(value).slice(0, 10);

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// How a report stands against the org now
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

interface Standing {
  preview: MarketplaceIncomePreview;
  // The order each order number names in the entity, for the lines to be stored.
  orderIds: Map<string, string>;
  period: { start: string; end: string } | null;
}

// The orders of the entity and platform the report names, by order number.
async function knownOrders(ctx: Pick<QueryContext, 'trx' | 'orgId'>, legalEntityId: string, platform: Platform, orderNos: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < orderNos.length; i += 1000) {
    const rows = await ctx.trx
      .selectFrom('crove_finance.channel_order')
      .select(['id', 'order_no'])
      .where('org_id', '=', ctx.orgId)
      .where('legal_entity_id', '=', legalEntityId)
      .where('platform', '=', platform)
      .where('order_no', 'in', orderNos.slice(i, i + 1000))
      .execute();
    for (const r of rows) out.set(r.order_no, r.id);
  }
  return out;
}

async function standingOf(ctx: Pick<QueryContext, 'trx' | 'orgId'>, staged: Staged, legalEntityId: string): Promise<Standing> {
  const { summary, platform, lines } = staged;
  const blockers: MarketplaceIncomePreview['blockers'] = [];
  const linesNet = toMoney(sum(lines.map((l) => l.net)));
  const stated = summary.statedNet;
  const reportNet = stated ?? linesNet;
  const period = summary.periodStart !== null && summary.periodEnd !== null ? { start: summary.periodStart, end: summary.periodEnd } : null;
  if (period === null) blockers.push('PERIOD_UNKNOWN');
  if (stated !== null && !money(stated).eq(money(linesNet))) blockers.push('TOTAL_MISMATCH');
  const orderNos = [...new Set(lines.map((l) => l.orderNo))];
  const orderIds = await knownOrders(ctx, legalEntityId, platform, orderNos);
  const unknown = orderNos.filter((n) => !orderIds.has(n));
  if (unknown.length > 0) blockers.push('UNKNOWN_ORDERS');
  // A settlement of the platform that stands (not reversed, not itself a reversal) and covers part of the period.
  let overlap: MarketplaceIncomePreview['overlap'] = null;
  if (period !== null) {
    const { rows } = await sql<{ period_start: unknown; period_end: unknown }>`
      SELECT s.period_start, s.period_end FROM crove_finance.channel_settlement s
      WHERE s.org_id = ${ctx.orgId}::uuid AND s.legal_entity_id = ${legalEntityId}::uuid AND s.platform = ${platform} AND s.reversal_of IS NULL
        AND s.period_start <= ${period.end}::date AND s.period_end >= ${period.start}::date
        AND NOT EXISTS (SELECT 1 FROM crove_finance.channel_settlement r WHERE r.org_id = s.org_id AND r.legal_entity_id = s.legal_entity_id AND r.reversal_of = s.id)
      ORDER BY s.period_start LIMIT 1`.execute(ctx.trx);
    const hit = rows[0];
    if (hit) {
      overlap = { periodStart: day(hit.period_start), periodEnd: day(hit.period_end) };
      blockers.push('OVERLAP');
    }
  }
  // Sale lines already stored (same order and line key) in a settlement that stands.
  let repeated = 0;
  const wanted = new Set(lines.filter((l) => money(l.sales).gt(0) && orderIds.has(l.orderNo)).map((l) => `${orderIds.get(l.orderNo)}\u0000${l.lineKey}`));
  if (wanted.size > 0) {
    const ids = [...new Set(lines.flatMap((l) => (money(l.sales).gt(0) && orderIds.has(l.orderNo) ? [orderIds.get(l.orderNo) as string] : [])))];
    for (let i = 0; i < ids.length; i += 1000) {
      const { rows } = await sql<{ order_id: string; line_key: string }>`
        SELECT l.order_id::text AS order_id, l.line_key FROM crove_finance.channel_settlement_line l
        JOIN crove_finance.channel_settlement s ON s.org_id = l.org_id AND s.legal_entity_id = l.legal_entity_id AND s.id = l.settlement_id
        WHERE l.org_id = ${ctx.orgId}::uuid AND l.legal_entity_id = ${legalEntityId}::uuid AND l.order_id = ANY(${ids.slice(i, i + 1000)}::uuid[])
          AND NOT l.adjustment AND l.sales > 0 AND s.reversal_of IS NULL
          AND NOT EXISTS (SELECT 1 FROM crove_finance.channel_settlement r WHERE r.org_id = s.org_id AND r.legal_entity_id = s.legal_entity_id AND r.reversal_of = s.id)`.execute(ctx.trx);
      for (const r of rows) if (wanted.has(`${r.order_id}\u0000${r.line_key}`)) repeated += 1;
    }
  }
  if (repeated > 0) blockers.push('REPEATED_LINES');
  return {
    preview: { reportNet, fileStatesNet: stated !== null, linesNet, unknownOrders: unknown.length, unknownOrderNos: unknown.slice(0, NAMED_ORDERS), overlap, repeatedLines: repeated, blockers },
    orderIds,
    period,
  };
}

// The refusal a blocker is, in words a member can act on.
function refusal(staged: Staged, standing: Standing): DomainError | null {
  const platform = PLATFORM_NAME[staged.platform];
  const p = standing.preview;
  const first = p.blockers[0];
  switch (first) {
    case 'PERIOD_UNKNOWN':
      return new DomainError('MARKETPLACE_INCOME_PERIOD_UNKNOWN', 422, `Báo cáo ${platform} có dòng không có ngày thanh toán nên không xác định được kỳ báo cáo; hãy kiểm tra lại tệp`);
    case 'TOTAL_MISMATCH':
      return new DomainError(
        'MARKETPLACE_INCOME_TOTAL_MISMATCH',
        422,
        `Các dòng của báo cáo ${platform} cộng lại ${p.linesNet} đồng, không khớp với tổng ${staged.summary.statedNet ?? ''} đồng mà tệp ghi; hãy kiểm tra lại tệp hoặc báo cho người hỗ trợ nếu sàn đã đổi mẫu báo cáo`,
      );
    case 'UNKNOWN_ORDERS':
      return new DomainError(
        'MARKETPLACE_INCOME_UNKNOWN_ORDERS',
        422,
        `Báo cáo ${platform} có ${p.unknownOrders} đơn chưa có trong hệ thống${p.unknownOrderNos.length > 0 ? ` (${p.unknownOrderNos.join(', ')}${p.unknownOrders > p.unknownOrderNos.length ? ', ...' : ''})` : ''}; hãy nhập báo cáo đơn hàng của cùng kỳ trước`,
      );
    case 'OVERLAP':
      return new DomainError(
        'MARKETPLACE_INCOME_OVERLAP',
        409,
        `Đã có báo cáo thu nhập ${platform} cho kỳ ${p.overlap ? `${dmy(p.overlap.periodStart)} đến ${dmy(p.overlap.periodEnd)}` : ''} trùng với kỳ của báo cáo này; nếu báo cáo cũ nhập nhầm, hãy hủy nó trước rồi nhập lại`,
      );
    case 'REPEATED_LINES':
      return new DomainError('MARKETPLACE_INCOME_REPEATED_LINES', 409, `${p.repeatedLines} dòng bán của báo cáo ${platform} đã có trong một báo cáo thu nhập khác; hãy kiểm tra xem tệp này có phải đã nhập rồi không`);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Queries for the Inbox card
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const marketplaceIncomeStaged = defineQuery({
  name: 'finance.marketplace_income.staged',
  input: z.strictObject({}),
  access: IMPORTERS,
  handler: async (ctx): Promise<MarketplaceIncomeStaged[]> => {
    const { rows } = await sql<{ file_id: string; filename: string; created_at: Date; summary: unknown; legal_entity_id: string | null }>`
      SELECT x.file_id::text AS file_id, f.filename, f.created_at, x.result -> 'summary' AS summary, x.legal_entity_id::text AS legal_entity_id
      FROM crove_kernel.extraction x
      JOIN crove_kernel.file f ON f.org_id = x.org_id AND f.id = x.file_id
      WHERE x.org_id = ${ctx.orgId}::uuid AND x.method = 'unsupported' AND x.status = 'done' AND x.result ->> 'kind' = 'marketplace_income' AND x.result -> 'summary' ->> 'state' = 'staged'
        AND x.version = (SELECT max(v.version) FROM crove_kernel.extraction v WHERE v.org_id = x.org_id AND v.file_id = x.file_id)
      ORDER BY f.created_at DESC
      LIMIT 20`.execute(ctx.trx);
    const entityIds = [...new Set(rows.flatMap((r) => (r.legal_entity_id ? [r.legal_entity_id] : [])))];
    const names = new Map<string, string>();
    if (entityIds.length > 0) {
      for (const e of await ctx.trx.selectFrom('crove_kernel.legal_entity').select(['id', 'name']).where('org_id', '=', ctx.orgId).where('id', 'in', entityIds).execute()) names.set(e.id, e.name);
    }
    return rows.flatMap((r) => {
      const summary = zMarketplaceIncomeSummary.safeParse(r.summary);
      if (!summary.success) return [];
      const entityName = r.legal_entity_id ? names.get(r.legal_entity_id) : undefined;
      return [{ fileId: r.file_id, filename: r.filename, createdAt: r.created_at.toISOString(), summary: summary.data, entity: r.legal_entity_id && entityName !== undefined ? { id: r.legal_entity_id, name: entityName } : null }];
    });
  },
});

export const marketplaceIncomePreview = defineQuery({
  name: 'finance.marketplace_income.preview',
  input: z.strictObject({ fileId: zId }),
  access: IMPORTERS,
  handler: async (ctx, input): Promise<MarketplaceIncomePreview> => {
    const staged = await stagedRun(ctx, input.fileId, false);
    if (!staged) throw notStaged();
    const entity = await resolveLegalEntity(ctx, staged.legalEntityId);
    return (await standingOf(ctx, staged, entity)).preview;
  },
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const marketplaceIncomeConfirm = defineCommand({
  name: 'finance.marketplace_income.confirm',
  input: z.strictObject({ fileId: zId }),
  // Records what a platform paid, as a member confirmed it from the platform's own file; it posts nothing (R1). The settlement and its lines are append-only: a mistake is undone by a reversal.
  risk: 'R1',
  sideEffect: 'internal',
  access: IMPORTERS,
  handler: async (ctx, input): Promise<MarketplaceIncomeConfirmResult> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới nhập được báo cáo thu nhập');
    await lockReport(ctx, input.fileId);
    const staged = await stagedRun(ctx, input.fileId, true);
    if (!staged) throw notStaged();
    const legalEntityId = await resolveLegalEntity(ctx, staged.legalEntityId);
    const standing = await standingOf(ctx, staged, legalEntityId);
    const blocked = refusal(staged, standing);
    if (blocked) throw blocked;
    const period = standing.period as { start: string; end: string };
    let settlementId: string;
    try {
      const settlement = await ctx.trx
        .insertInto('crove_finance.channel_settlement')
        .values({ org_id: ctx.orgId, legal_entity_id: legalEntityId, platform: staged.platform, period_start: period.start, period_end: period.end, report_net: standing.preview.reportNet, source_sha256: staged.sha256 })
        .returning('id')
        .executeTakeFirstOrThrow();
      settlementId = settlement.id;
      for (let i = 0; i < staged.lines.length; i += BATCH) {
        await ctx.trx
          .insertInto('crove_finance.channel_settlement_line')
          .values(
            staged.lines.slice(i, i + BATCH).map((line) => ({
              org_id: ctx.orgId,
              settlement_id: settlementId,
              order_id: standing.orderIds.get(line.orderNo) as string,
              line_key: line.lineKey,
              sales: line.sales,
              seller_discount: line.sellerDiscount,
              commission: line.commission,
              service_fee: line.serviceFee,
              payment_fee: line.paymentFee,
              shipping: line.shipping,
              tax_withheld: line.taxWithheld,
              refund: line.refund,
              other: line.other,
              net: line.net,
              source_row: line.rowNo,
            })),
          )
          .execute();
      }
    } catch (error) {
      // The database's own refusals (an import racing this one past the checks above) end as the same messages, and nothing is stored.
      const failure = error as { code?: string; message?: string } | null;
      if (failure?.code === '23P01') throw new DomainError('MARKETPLACE_INCOME_OVERLAP', 409, `Vừa có báo cáo thu nhập ${PLATFORM_NAME[staged.platform]} khác trùng kỳ được nhập; hãy tải lại danh sách`);
      if (failure?.code === '23505' && String(failure.message).includes('CHANNEL_SETTLEMENT_LINE_DUPLICATE')) {
        throw new DomainError('MARKETPLACE_INCOME_REPEATED_LINES', 409, `Vừa có báo cáo thu nhập khác chứa các dòng bán này được nhập; hãy tải lại danh sách`);
      }
      // Only the period key (an import of the same period racing this one) is a concurrency problem; any other unique violation (a duplicate line key from a reader that drifted, say) is a real error.
      if (failure?.code === '23505' && (failure as { constraint?: string }).constraint === 'channel_settlement_period_uq') {
        throw new DomainError('MARKETPLACE_INCOME_BUSY', 409, 'Có báo cáo khác đang được nhập cùng lúc; hãy thử lại sau ít phút');
      }
      throw error;
    }
    await ctx.run('kernel.extraction.statement_state', { fileId: input.fileId, state: 'imported', newLines: staged.lines.length, duplicateLines: 0, importId: settlementId });
    // The audit names the platform and counts, never an order number or an amount of the file.
    ctx.audit({ fileId: input.fileId, platform: staged.platform, settlementId, lines: staged.lines.length, orders: new Set(staged.lines.map((l) => l.orderNo)).size });
    return { settlementId, lines: staged.lines.length, reportNet: standing.preview.reportNet, other: staged.summary.totals.other };
  },
});

export const marketplaceIncomeReject = defineCommand({
  name: 'finance.marketplace_income.reject',
  input: z.strictObject({ fileId: zId }),
  risk: 'R1',
  sideEffect: 'internal',
  access: IMPORTERS,
  handler: async (ctx, input): Promise<{ fileId: string }> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới bỏ qua được báo cáo thu nhập');
    await lockReport(ctx, input.fileId);
    if (!(await stagedRun(ctx, input.fileId, true))) throw notStaged();
    // Nothing was stored as a settlement, and the lines stay in the finished run's result, which nothing may change and no tenant may delete (they hold no buyer data).
    await ctx.run('kernel.extraction.statement_state', { fileId: input.fileId, state: 'rejected' });
    ctx.audit({ fileId: input.fileId });
    return { fileId: input.fileId };
  },
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The worker's side
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

interface ReportFileSource {
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

export interface MarketplaceIncomeFileDeps {
  runtime: Runtime;
  store: BlobStore;
  extract: ExtractClient;
}

const TOO_MANY_LINES = `Báo cáo có hơn ${EXTRACT_LIMITS.maxIncomeLines.toLocaleString('vi-VN')} dòng; hãy chia thành nhiều tệp theo tháng`;
const TOO_BIG = 'Báo cáo có quá nhiều dữ liệu để chờ nhập (tối đa 4 MB nội dung các dòng); hãy chia thành nhiều tệp theo tháng';

// Tries to read a received file as a marketplace income report, after the order report and before a bank statement, an invoice or an archive: an .xlsx arrives as a ZIP, a CSV with its own
// type. handled is true when the file's read is recorded here (staged, or a failed read with the reason), false when it is no income report and the caller goes on as before. A report
// that could not be read in full (a row with an amount, a date or an id that does not read) is recorded as failed with the rows, and nothing is staged: a layout the profile does not know
// shows what it could not read, and stores nothing.
export async function readMarketplaceIncomeFile(deps: MarketplaceIncomeFileDeps, orgId: string, fileId: string, attempt = 0, version?: number): Promise<{ handled: boolean }> {
  const actor = MARKETPLACE_INCOME_ACTOR;
  const file = await deps.runtime.query<ReportFileSource | null>('finance.extraction.file', { fileId, ...(version === undefined ? {} : { version }) }, { actor: { type: 'system', component: 'finance.extract' }, orgId });
  if (!file || ![ZIP, XLSX, CSV].includes(file.content_type)) return { handled: false };
  // Already read, or a re-read that is no longer pending: not this reader's to take; the next reader finds the same and ends the job.
  if (version === undefined ? file.hasExtraction : !file.due) return { handled: false };
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
  if (bytes.byteLength > EXTRACT_LIMITS.maxOrderReportBytes) return { handled: false };
  const read = await deps.extract.extract('marketplace_income', bytes);
  if (!read.ok) {
    const limitHit = read.code === 'timeout' || read.code === 'memory';
    if (limitHit && attempt < EXTRACT_LIMIT_RETRIES) throw new Error(`crove-extract stopped at a limit: ${read.code}`);
    return { handled: false };
  }
  const income = read.income;
  if (!income.recognized || income.platform === null || income.profile === null) return { handled: false };
  if (income.tooMany) {
    await record('failed', { error: TOO_MANY_LINES });
    return { handled: true };
  }
  // A row the profile could not read stops the file (a totals row without an order number does not): what could not be read is named by its row, and nothing is stored.
  const blocking = income.skipped.filter((s) => s.reason !== 'no_order_no');
  if (blocking.length > 0 || income.lines.length === 0) {
    const rows = [...new Set(blocking.map((s) => s.rowNo))].slice(0, 20);
    await record('failed', {
      error: (blocking.length > 0
        ? `Báo cáo thu nhập ${income.platform} có ${blocking.length} dòng không đọc được (dòng ${rows.join(', ')} của tệp): số tiền, ngày hoặc mã đơn không đúng định dạng; hãy kiểm tra lại tệp hoặc báo cho người hỗ trợ nếu sàn đã đổi mẫu báo cáo`
        : 'Không nhận ra báo cáo thu nhập của Shopee hoặc TikTok Shop'
      ).slice(0, 2000),
    });
    return { handled: true };
  }
  const bad = badIncomeLines(income.lines);
  if (bad.length > 0) {
    const rows = [...new Set(bad)].slice(0, 20);
    await record('failed', {
      error: `Báo cáo thu nhập ${income.platform} có ${bad.length} dòng có số tiền không hợp lệ (dòng ${rows.join(', ')} của tệp): số tiền âm, quá 4 chữ số thập phân hoặc thực nhận không khớp các khoản; hãy kiểm tra lại tệp hoặc báo cho người hỗ trợ nếu sàn đã đổi mẫu báo cáo`.slice(0, 2000),
    });
    return { handled: true };
  }
  const summary = incomeSummaryOf(
    { platform: income.platform, profile: income.profile, sheet: income.sheet, lines: income.lines, statedNet: income.statedNet, skipped: income.skipped },
    file.filename.slice(0, 255),
  );
  const result = { kind: 'marketplace_income', summary, lines: income.lines };
  // The lines are kept with the file's read until a member decides: a bounded amount, refused with the reason past it.
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > STAGED_STATEMENT_MAX_BYTES) {
    await record('failed', { error: TOO_BIG });
    return { handled: true };
  }
  await record('done', { error: null, result, summary: `Báo cáo thu nhập ${income.platform} chờ nhập: ${summary.orders} đơn, ${summary.lines} dòng` });
  return { handled: true };
}

// Fails the pending re-read `version` of an income report with the reason, for a job that kept failing.
export function recordMarketplaceIncomeReadFailure(runtime: Runtime, orgId: string, fileId: string, version: number, error: string) {
  return runtime.execute(
    'kernel.extraction.record',
    { fileId, version, method: 'unsupported', status: 'failed', result: null, checks: [], error: error.slice(0, 2000), proposal: null, statement: true },
    { actor: MARKETPLACE_INCOME_ACTOR, orgId },
  );
}

export const marketplaceIncomeCommands = [marketplaceIncomeConfirm, marketplaceIncomeReject];
export const marketplaceIncomeQueries = [marketplaceIncomeStaged, marketplaceIncomePreview];
