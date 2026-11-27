// SPDX-License-Identifier: AGPL-3.0-only
// finance.unusual_entries (#5182): the monthly review of POSTED entries that look unusual, for one legal entity and one ended month, and finance.unusual_entries.review, a person's audited, idempotent mark that
// one hit was looked at. It differs from the flags of #2380, which fire on a proposal before a payment is approved; the thresholds that fit are reused from it and from the expense variance (#4392).
// Read only, in the member's own transaction: the entity is the caller's own (resolveLegalEntity), every read filters org and entity and the tables' le_scope policy applies. The five rules (kernel-contract
// UNUSUAL_ENTRY_RULES) are deterministic and run in ONE statement that ranks and caps the hits in the database; money is NUMERIC there (the median and the spread are computed over numeric with ordered
// row_number(), never percentile_cont, which returns double precision) and decimal strings out.
//
// What each part of the statement reads, and the index it uses (no new index on the ledger):
// - `we` (the entries of the last 24 months and the month, materialized): journal_entry by journal_entry_date_idx (org_id, entry_date) and the entity (journal_entry_legal_entity_idx); the reversal check by
//   journal_entry_reverses_uq (org_id, reverses_entry_id); the 911 check by a correlated scalar subquery on the line key (org_id, entry_id, line_no). `ln` (their lines) is driven FROM `we` by a lateral join
//   on that key, so a line is only ever fetched for an entry of the window (journal_line has no date column and must never be scanned); the journal_voucher join is by its key (org_id, id). `ln` is read once
//   (referenced by several parts, so it is materialized) and is bounded by 24 months of ONE entity, whatever the org holds.
// - amount_outlier: `ga` and its medians read only `ln` rows of the last 6 months, per group (party and account line); a group with fewer than 6 earlier entries raises nothing.
// - new_account: the history is `ln` rows of the last 24 months (the party basis and the kind basis share it), counted and tested per party or per kind: bounded by the same window.
// - duplicate_invoice: the entries of the month's documents (journal_entry by the source key (org_id, source_type, source_id)), their twins by purchase_document_party_idx (org_id, party_id, direction); the void
//   check by purchase_document_void's key.
// - control_manual and off_day read the month's entries from `ln` and need no history.
// - reviewed hits: entry_review_mark by its unique key (org_id, entry_id, rule), one probe per hit.
// A DB test seeds a few hundred history rows and shows the hit list does not change with them and that the whole review is this one statement (plus the small reads of names and books).
import { sql } from 'kysely';
import type { MemberRole } from '@ludy/db';
import {
  UNUSUAL_AMOUNT_FACTOR,
  UNUSUAL_AMOUNT_MIN_DIFF,
  UNUSUAL_AMOUNT_MIN_HISTORY,
  UNUSUAL_HISTORY_MONTHS,
  UNUSUAL_MAD_FACTOR,
  UNUSUAL_MAX_HITS,
  UNUSUAL_MAX_PER_RULE,
  UNUSUAL_NEW_ACCOUNT_KIND_MIN,
  UNUSUAL_NEW_ACCOUNT_PARTY_MIN,
  UNUSUAL_OFF_DAY_MIN_AMOUNT,
  UNUSUAL_REVIEWED_SHOWN,
  zFinanceUnusualEntriesInput,
  zFinanceUnusualEntryReviewInput,
  type ExpenseVarianceSourceKind,
  type FinanceUnusualEntries,
  type ReviewedHit,
  type UnusualControlGroup,
  type UnusualEntryHit,
  type UnusualEntryRule,
} from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@ludy/kernel-runtime';
import { booksOnDate, type BooksRow } from './domain/expense-variance.ts';
import { CONTROL_ACCOUNT_PATTERN, NOT_GROUPED_PATTERN, chartStart, holidaysIn, moneyText, ratioText, reviewWindow } from './domain/unusual-entries.ts';
import { resolveLegalEntity } from './legal-entity.ts';
import { databaseToday } from './period-lock.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const MARKERS: readonly MemberRole[] = ['owner', 'admin', 'member'];

export const unusualMonthNotEnded = () => new DomainError('MONTH_NOT_ENDED', 422, 'Tháng này chưa kết thúc; hãy chọn một tháng đã qua để rà soát bút toán');

async function booksRows(ctx: QueryContext, entity: string): Promise<BooksRow[]> {
  const rows = await ctx.trx
    .selectFrom('ludy_finance.legal_entity_books')
    .select(['regime', 'chart_version', 'effective_from'])
    .where('org_id', '=', ctx.orgId)
    .where('legal_entity_id', '=', entity)
    .execute();
  return rows.map((r) => ({ regime: r.regime, chartVersion: r.chart_version, effectiveFrom: String(r.effective_from).slice(0, 10) }));
}

// An invoice number as the tax portal reconciliation compares it (l10n-vn normalizeNumber; the intake itself compares series and number exactly, so this finds what the intake lets through: the same number under another series or written another way): spaces dropped, then leading zeros dropped when it is all digits, else upper case. POSIX classes keep the template free of backslashes.
const invoiceKey = (column: string) => {
  const squeezed = sql`pg_catalog.regexp_replace(pg_catalog.btrim(${sql.ref(column)}), '[[:space:]]+', '', 'g')`;
  return sql`CASE WHEN ${squeezed} ~ '^[0-9]+$' THEN pg_catalog.regexp_replace(${squeezed}, '^0+(?=[0-9])', '') ELSE pg_catalog.upper(${squeezed}) END`;
};

// A journal voucher a person typed: none of the links a system-made one (payroll, settlement, payout, stock, closing, surplus, fee) carries.
const MANUAL_VOUCHER = sql`(jv.closing_year IS NULL AND jv.stock_closing_month IS NULL AND jv.stock_count_id IS NULL AND jv.payroll_run_id IS NULL AND jv.settlement_id IS NULL
  AND jv.payout_settlement_id IS NULL AND jv.payout_bank_line_id IS NULL AND jv.fee_document_id IS NULL AND jv.settlement_month IS NULL AND jv.surplus_count_id IS NULL)`;

interface HitRow {
  entries: string;
  open_total: string;
  reviewed_total: string;
  entry_id: string | null;
  rule: UnusualEntryRule | null;
  entry_date: string | null;
  kind: ExpenseVarianceSourceKind | null;
  description: string | null;
  amount: string | null;
  party_id: string | null;
  grp: string | null;
  d_amount: string | null;
  d_median: string | null;
  d_count: string | null;
  d_direction: 'high' | 'low' | null;
  d_basis: 'party' | 'kind' | null;
  d_day: 'weekend' | 'holiday' | null;
  d_control: UnusualControlGroup | null;
  d_number: string | null;
  d_other: string | null;
  d_other_date: string | null;
  reviewed: boolean | null;
  marked_by: string | null;
  marked_on: string | null;
}

// The valid lines, the five rules and the hits with their reviewed marks, as the head of a statement (the tail is the caller's): the list ranks and caps them, the review command asks only whether one entry is a
// hit of a rule (`entryId`). See the header for what each part reads.
function hitsHead(ctx: QueryContext, entity: string, regime: 'tt133' | 'tt99', span: ReturnType<typeof reviewWindow>, holidays: readonly string[], entryId: string | null) {
  const org = ctx.orgId;
  return sql`
    -- The entries of the window, driven from journal_entry by org, entity and date (journal_entry_date_idx); journal_line has no date column, so its lines are fetched per entry below, never scanned.
    -- The 911 check is a correlated scalar subquery on the line key, which the planner runs per entry (an EXISTS could be planned as a hash anti join over every line of the org).
    WITH we AS MATERIALIZED (
      SELECT e.org_id, e.id, e.entry_date, e.source_type, e.source_id, e.description
      FROM ludy_finance.journal_entry e
      WHERE e.org_id = ${org}::uuid AND e.legal_entity_id = ${entity}::uuid
        AND e.entry_date >= ${span.newAccountFrom}::date AND e.entry_date <= ${span.to}::date
        AND e.reverses_entry_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM ludy_finance.journal_entry rv WHERE rv.org_id = e.org_id AND rv.reverses_entry_id = e.id)
        AND (SELECT pg_catalog.bool_or(c.account_code LIKE '911%') FROM ludy_finance.journal_line c WHERE c.org_id = e.org_id AND c.entry_id = e.id) IS NOT TRUE
    ),
    ln AS (
      SELECT e.id AS entry_id, e.entry_date, e.source_type, e.source_id, e.description, l.account_code, l.debit, l.credit,
        -- The party of a line is its own, or the one party the whole entry names: an invoice posts the party on its payable or receivable line only (record.ts), not on the expense line the rules look at.
        COALESCE(l.party_id, CASE WHEN pg_catalog.min(l.party_id::text) OVER w = pg_catalog.max(l.party_id::text) OVER w THEN (pg_catalog.min(l.party_id::text) OVER w)::uuid END) AS party_id,
        CASE WHEN ${regime}::text = 'tt133' AND l.account_code ~ '^64[0-9][0-9]' THEN pg_catalog.left(l.account_code, 4) ELSE pg_catalog.left(l.account_code, 3) END AS grp,
        CASE
          WHEN e.source_type = 'finance.purchase_document' THEN 'invoice'
          WHEN e.source_type = 'finance.cash_voucher' THEN 'cash_bank'
          WHEN e.source_type LIKE 'hr.payroll%' THEN 'payroll'
          WHEN e.source_type = 'finance.journal_voucher' AND jv.id IS NOT NULL AND ${MANUAL_VOUCHER} THEN 'manual'
          ELSE 'other'
        END AS kind
      FROM we e
      CROSS JOIN LATERAL (SELECT jl.account_code, jl.debit, jl.credit, jl.party_id FROM ludy_finance.journal_line jl WHERE jl.org_id = e.org_id AND jl.entry_id = e.id) l
      LEFT JOIN ludy_finance.journal_voucher jv ON jv.org_id = e.org_id AND e.source_type = 'finance.journal_voucher' AND jv.id = e.source_id
      WINDOW w AS (PARTITION BY e.id)
    ),
    em AS (
      SELECT entry_id, pg_catalog.min(entry_date) AS entry_date, pg_catalog.min(source_type) AS source_type, pg_catalog.min(source_id::text)::uuid AS source_id, pg_catalog.min(kind) AS kind,
        pg_catalog.min(description) AS description, pg_catalog.sum(debit) AS amount
      FROM ln WHERE entry_date >= ${span.from}::date GROUP BY entry_id
    ),
    -- amount_outlier: the entry's amount per group (party and account line), against the median and the spread of the group's earlier entries of the last 6 months.
    ga AS (
      SELECT entry_id, entry_date, party_id, grp, pg_catalog.abs(pg_catalog.sum(debit - credit)) AS amt
      FROM ln WHERE party_id IS NOT NULL AND account_code !~ ${NOT_GROUPED_PATTERN}::text AND entry_date >= ${span.historyFrom}::date
      GROUP BY entry_id, entry_date, party_id, grp
    ),
    hr AS (
      SELECT party_id, grp, amt, pg_catalog.row_number() OVER (PARTITION BY party_id, grp ORDER BY amt) AS rn, pg_catalog.count(*) OVER (PARTITION BY party_id, grp) AS n
      FROM ga WHERE entry_date < ${span.from}::date
    ),
    med AS (
      SELECT party_id, grp, n, pg_catalog.avg(amt) AS median FROM hr WHERE rn IN ((n + 1) / 2, (n + 2) / 2) GROUP BY party_id, grp, n
    ),
    dr AS (
      SELECT h.party_id, h.grp, pg_catalog.abs(h.amt - m.median) AS d,
        pg_catalog.row_number() OVER (PARTITION BY h.party_id, h.grp ORDER BY pg_catalog.abs(h.amt - m.median)) AS rn, m.n
      FROM hr h JOIN med m ON m.party_id = h.party_id AND m.grp = h.grp
    ),
    mad AS (
      SELECT party_id, grp, pg_catalog.avg(d) AS mad FROM dr WHERE rn IN ((n + 1) / 2, (n + 2) / 2) GROUP BY party_id, grp
    ),
    ho AS (
      SELECT DISTINCT ON (c.entry_id) c.entry_id AS entry_id, 'amount_outlier'::text AS rule, c.party_id AS party_id, c.grp AS grp, c.amt AS d_amount, m.median AS d_median, m.n AS d_count,
        (CASE WHEN c.amt >= m.median * ${UNUSUAL_AMOUNT_FACTOR}::numeric THEN 'high' ELSE 'low' END)::text AS d_direction, NULL::text AS d_basis, NULL::text AS d_day, NULL::text AS d_control,
        NULL::text AS d_number, NULL::uuid AS d_other, NULL::date AS d_other_date
      FROM ga c
      JOIN med m ON m.party_id = c.party_id AND m.grp = c.grp
      JOIN mad s ON s.party_id = c.party_id AND s.grp = c.grp
      WHERE c.entry_date >= ${span.from}::date AND m.n >= ${UNUSUAL_AMOUNT_MIN_HISTORY} AND m.median > 0
        AND (c.amt >= m.median * ${UNUSUAL_AMOUNT_FACTOR}::numeric OR (c.amt > 0 AND c.amt <= m.median / ${UNUSUAL_AMOUNT_FACTOR}::numeric))
        AND pg_catalog.abs(c.amt - m.median) >= ${UNUSUAL_AMOUNT_MIN_DIFF}::numeric
        AND (s.mad = 0 OR pg_catalog.abs(c.amt - m.median) >= ${UNUSUAL_MAD_FACTOR}::numeric * s.mad)
      ORDER BY c.entry_id, pg_catalog.abs(c.amt - m.median) DESC, c.grp
    ),
    -- new_account: a line whose account line this party (or, for a line with no party, this kind of voucher) has not used in the last 24 months.
    ca AS (
      SELECT entry_id, party_id, grp, kind, pg_catalog.sum(debit + credit) AS amt
      FROM ln WHERE entry_date >= ${span.from}::date AND account_code !~ ${NOT_GROUPED_PATTERN}::text GROUP BY entry_id, party_id, grp, kind
    ),
    hl AS (
      SELECT entry_id, party_id, grp, kind FROM ln WHERE entry_date < ${span.from}::date AND account_code !~ ${NOT_GROUPED_PATTERN}::text
    ),
    pgrp AS (SELECT DISTINCT party_id, grp FROM hl WHERE party_id IS NOT NULL),
    pcnt AS (SELECT party_id, pg_catalog.count(DISTINCT entry_id) AS n FROM hl WHERE party_id IS NOT NULL GROUP BY party_id),
    kgrp AS (SELECT DISTINCT kind, grp FROM hl),
    kcnt AS (SELECT kind, pg_catalog.count(DISTINCT entry_id) AS n FROM hl GROUP BY kind),
    hn AS (
      SELECT DISTINCT ON (c.entry_id) c.entry_id AS entry_id, 'new_account'::text AS rule, c.party_id AS party_id, c.grp AS grp, c.amt AS d_amount, NULL::numeric AS d_median,
        NULL::bigint AS d_count, NULL::text AS d_direction, (CASE WHEN c.party_id IS NOT NULL THEN 'party' ELSE 'kind' END)::text AS d_basis, NULL::text AS d_day, NULL::text AS d_control,
        NULL::text AS d_number, NULL::uuid AS d_other, NULL::date AS d_other_date
      FROM ca c
      LEFT JOIN pcnt pc ON pc.party_id = c.party_id
      LEFT JOIN kcnt kc ON kc.kind = c.kind
      WHERE (c.party_id IS NOT NULL AND COALESCE(pc.n, 0) >= ${UNUSUAL_NEW_ACCOUNT_PARTY_MIN}
             AND NOT EXISTS (SELECT 1 FROM pgrp g WHERE g.party_id = c.party_id AND g.grp = c.grp))
         OR (c.party_id IS NULL AND c.kind IN ('invoice', 'cash_bank', 'manual') AND COALESCE(kc.n, 0) >= ${UNUSUAL_NEW_ACCOUNT_KIND_MIN}
             AND NOT EXISTS (SELECT 1 FROM kgrp g WHERE g.kind = c.kind AND g.grp = c.grp))
      ORDER BY c.entry_id, c.amt DESC, c.grp
    ),
    -- control_manual: a voucher a person typed with a line on a control account.
    hc AS (
      SELECT DISTINCT ON (l.entry_id) l.entry_id AS entry_id, 'control_manual'::text AS rule, l.party_id AS party_id, pg_catalog.left(l.account_code, 3) AS grp, NULL::numeric AS d_amount,
        NULL::numeric AS d_median, NULL::bigint AS d_count, NULL::text AS d_direction, NULL::text AS d_basis, NULL::text AS d_day,
        (CASE pg_catalog.left(l.account_code, 3) WHEN '131' THEN 'receivable' WHEN '331' THEN 'payable' WHEN '133' THEN 'input_vat' WHEN '333' THEN 'tax' ELSE 'employee' END)::text AS d_control,
        NULL::text AS d_number, NULL::uuid AS d_other, NULL::date AS d_other_date
      FROM ln l WHERE l.entry_date >= ${span.from}::date AND l.kind = 'manual' AND l.account_code ~ ${CONTROL_ACCOUNT_PATTERN}::text
      ORDER BY l.entry_id, (l.debit + l.credit) DESC, l.account_code
    ),
    -- off_day: an entry a person keyed, of a size worth a look, dated on a weekend day or a public holiday of the shared calendar.
    hf AS (
      SELECT e.entry_id AS entry_id, 'off_day'::text AS rule, NULL::uuid AS party_id, NULL::text AS grp, NULL::numeric AS d_amount, NULL::numeric AS d_median, NULL::bigint AS d_count,
        NULL::text AS d_direction, NULL::text AS d_basis, (CASE WHEN e.entry_date = ANY (${[...holidays]}::text[]::date[]) THEN 'holiday' ELSE 'weekend' END)::text AS d_day,
        NULL::text AS d_control, NULL::text AS d_number, NULL::uuid AS d_other, NULL::date AS d_other_date
      FROM em e
      WHERE e.kind IN ('manual', 'cash_bank') AND e.amount >= ${UNUSUAL_OFF_DAY_MIN_AMOUNT}::numeric
        AND (e.entry_date = ANY (${[...holidays]}::text[]::date[]) OR pg_catalog.date_part('isodow', e.entry_date) IN (6, 7))
    ),
    -- duplicate_invoice: a purchase document that has an earlier copy in force (same supplier, same invoice number once spaces and leading zeros are normalized, the series may differ, same total), unless the pair is a replacement or a correction.
    hd AS (
      SELECT DISTINCT ON (e.entry_id) e.entry_id AS entry_id, 'duplicate_invoice'::text AS rule, d1.party_id AS party_id, NULL::text AS grp, NULL::numeric AS d_amount, NULL::numeric AS d_median,
        NULL::bigint AS d_count, NULL::text AS d_direction, NULL::text AS d_basis, NULL::text AS d_day, NULL::text AS d_control, d1.invoice_number AS d_number, o.entry_id AS d_other,
        o.entry_date AS d_other_date
      FROM em e
      JOIN ludy_finance.purchase_document d1 ON d1.org_id = ${org}::uuid AND d1.id = e.source_id AND e.source_type = 'finance.purchase_document'
      JOIN LATERAL (
        SELECT oe.id AS entry_id, oe.entry_date
        FROM ludy_finance.purchase_document d2
        JOIN ludy_finance.journal_entry oe ON oe.org_id = d2.org_id AND oe.source_type = 'finance.purchase_document' AND oe.source_id = d2.id AND oe.reverses_entry_id IS NULL
        WHERE d2.org_id = d1.org_id AND d2.party_id = d1.party_id AND d2.direction = 'purchase' AND d2.id <> d1.id AND d2.legal_entity_id = d1.legal_entity_id
          AND d2.total = d1.total AND ${invoiceKey('d2.invoice_number')} = ${invoiceKey('d1.invoice_number')}
          AND NOT EXISTS (SELECT 1 FROM ludy_finance.purchase_document_void v2 WHERE v2.org_id = d2.org_id AND v2.document_id = d2.id)
          AND d2.replaces_document_id IS DISTINCT FROM d1.id AND d1.replaces_document_id IS DISTINCT FROM d2.id
          AND d2.corrects_document_id IS DISTINCT FROM d1.id AND d1.corrects_document_id IS DISTINCT FROM d2.id
          AND (d2.created_at, d2.id) < (d1.created_at, d1.id)
        ORDER BY oe.source_revision DESC, oe.id
        LIMIT 1
      ) o ON true
      WHERE d1.direction = 'purchase'
        AND NOT EXISTS (SELECT 1 FROM ludy_finance.purchase_document_void v1 WHERE v1.org_id = d1.org_id AND v1.document_id = d1.id)
      ORDER BY e.entry_id
    ),
    hits AS (
      SELECT u.*, e.entry_date, e.kind, e.description, e.amount, (m.entry_id IS NOT NULL) AS reviewed, m.marked_by, m.created_at AS marked_at,
        (CASE u.rule WHEN 'duplicate_invoice' THEN 1 WHEN 'control_manual' THEN 2 WHEN 'amount_outlier' THEN 3 WHEN 'new_account' THEN 4 ELSE 5 END) AS prio
      FROM (
        SELECT * FROM hd UNION ALL SELECT * FROM hc UNION ALL SELECT * FROM ho UNION ALL SELECT * FROM hn UNION ALL SELECT * FROM hf
      ) u
      JOIN em e ON e.entry_id = u.entry_id AND (${entryId}::uuid IS NULL OR e.entry_id = ${entryId}::uuid)
      LEFT JOIN ludy_finance.entry_review_mark m ON m.org_id = ${org}::uuid AND m.entry_id = u.entry_id AND m.rule = u.rule
    )`;
}

// The list in ONE statement: the hits not yet reviewed, ranked and capped, then the newest reviewed ones.
async function hitRows(ctx: QueryContext, entity: string, regime: 'tt133' | 'tt99', span: ReturnType<typeof reviewWindow>, holidays: readonly string[]): Promise<HitRow[]> {
  const { rows } = await sql<HitRow>`
    ${hitsHead(ctx, entity, regime, span, holidays, null)},
    unreviewed AS (
      SELECT h.*, pg_catalog.row_number() OVER (PARTITION BY h.rule ORDER BY h.amount DESC, h.entry_date DESC, h.entry_id) AS rk FROM hits h WHERE NOT h.reviewed
    ),
    picked AS (
      SELECT * FROM unreviewed WHERE rk <= ${UNUSUAL_MAX_PER_RULE} ORDER BY prio, amount DESC, entry_date DESC, entry_id LIMIT ${UNUSUAL_MAX_HITS}
    ),
    done AS (
      SELECT h.*, NULL::bigint AS rk FROM hits h WHERE h.reviewed ORDER BY h.marked_at DESC, h.entry_id LIMIT ${UNUSUAL_REVIEWED_SHOWN}
    ),
    summary AS (
      SELECT (SELECT pg_catalog.count(*) FROM em) AS entries, pg_catalog.count(*) FILTER (WHERE NOT reviewed) AS open_total, pg_catalog.count(*) FILTER (WHERE reviewed) AS reviewed_total FROM hits
    )
    SELECT s.entries, s.open_total, s.reviewed_total, p.entry_id, p.rule, pg_catalog.to_char(p.entry_date, 'YYYY-MM-DD') AS entry_date, p.kind, p.description, p.amount, p.party_id, p.grp, p.d_amount,
      p.d_median, p.d_count, p.d_direction, p.d_basis, p.d_day, p.d_control, p.d_number, p.d_other, pg_catalog.to_char(p.d_other_date, 'YYYY-MM-DD') AS d_other_date,
      p.reviewed, p.marked_by, pg_catalog.to_char(p.marked_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') AS marked_on
    FROM summary s LEFT JOIN (SELECT * FROM picked UNION ALL SELECT * FROM done) p ON true
    ORDER BY p.reviewed NULLS FIRST, CASE WHEN p.reviewed THEN NULL ELSE p.prio END, p.marked_at DESC NULLS LAST, p.amount DESC, p.entry_date DESC, p.entry_id`.execute(ctx.trx);
  return rows;
}

// Whether one entry is a hit of one rule right now (reviewed or not): the same rule SQL, asked of that entry alone, in the month of its date.
async function isCurrentHit(ctx: QueryContext, entity: string, regime: 'tt133' | 'tt99', span: ReturnType<typeof reviewWindow>, holidays: readonly string[], entryId: string, rule: string): Promise<boolean> {
  const { rows } = await sql<{ rule: string }>`${hitsHead(ctx, entity, regime, span, holidays, entryId)} SELECT h.rule FROM hits h WHERE h.rule = ${rule}::text`.execute(ctx.trx);
  return rows.length > 0;
}

async function accountNames(ctx: QueryContext, regime: string, version: string, codes: readonly string[]): Promise<Map<string, string>> {
  if (codes.length === 0) return new Map();
  const rows =
    regime === 'tt99'
      ? await ctx.trx.selectFrom('ludy_finance.chart_account').select(['code', 'name']).where('regime', '=', 'tt99').where('version', '=', version).where('code', 'in', [...codes]).execute()
      : await ctx.trx.selectFrom('ludy_finance.account').select(['code', 'name']).where('code', 'in', [...codes]).execute();
  return new Map(rows.map((r) => [r.code, r.name]));
}

// What a review of one ended month reads from the entity's books rows: the chart in force (regime and version), the days each rule reads and the holidays of the month. A month in progress is not reviewed: its entries
// are still being posted.
async function reviewSetup(ctx: QueryContext, entity: string, month: string) {
  const today = await databaseToday(ctx.trx);
  if (month >= today.slice(0, 7)) throw unusualMonthNotEnded();
  const books = await booksRows(ctx, entity);
  const first = reviewWindow(month, '1900-01-01');
  const here = booksOnDate(books, first.to);
  return { here, span: reviewWindow(month, chartStart(books, first.to)), holidays: holidaysIn(month) };
}

export const notAHit = () => new DomainError('NOT_A_HIT', 404, 'Bút toán này không nằm trong danh sách cần xem lại của tháng của nó, nên chưa đánh dấu được');

// The display names the org knows its members by (a member with no display name has none: the card then says only when).
async function memberNameMap(ctx: QueryContext, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const { rows } = await sql<{ user_id: string; display_name: string | null }>`SELECT user_id, display_name FROM ludy_kernel.member_profiles(${[...ids]}::uuid[])`.execute(ctx.trx);
  return new Map(rows.flatMap((r) => (r.display_name && r.display_name.trim() !== '' ? [[r.user_id, r.display_name.trim()] as const] : [])));
}

export async function financeUnusualEntries(ctx: QueryContext, input: { month: string; legalEntityId?: string | undefined }): Promise<FinanceUnusualEntries> {
  const entity = await resolveLegalEntity(ctx, input.legalEntityId);
  const { here, span: real, holidays } = await reviewSetup(ctx, entity, input.month);
  const rows = await hitRows(ctx, entity, here.regime, real, holidays);
  const summary = rows[0];
  const found = rows.filter((r): r is HitRow & { entry_id: string; rule: UnusualEntryRule; entry_date: string; kind: ExpenseVarianceSourceKind; amount: string } => r.entry_id !== null && r.rule !== null);

  const partyIds = [...new Set(found.flatMap((r) => (r.party_id ? [r.party_id] : [])))];
  const parties = new Map<string, string>();
  if (partyIds.length > 0) {
    for (const p of await ctx.trx.selectFrom('ludy_kernel.party').select(['id', 'name']).where('org_id', '=', ctx.orgId).where('id', 'in', partyIds).execute()) parties.set(p.id, p.name);
  }
  const names = await accountNames(ctx, here.regime, here.version, [...new Set(found.flatMap((r) => (r.grp ? [r.grp] : [])))]);

  const toHit = (r: (typeof found)[number]): UnusualEntryHit => {
    const usual = r.rule === 'amount_outlier' ? moneyText(r.d_median) : null;
    const groupAmount = r.rule === 'amount_outlier' ? moneyText(r.d_amount) : null;
    return {
      rule: r.rule,
      entryId: r.entry_id,
      entryDate: r.entry_date,
      sourceKind: r.kind,
      description: r.description,
      amount: moneyText(r.amount) ?? '0',
      partyId: r.party_id,
      partyName: r.party_id ? (parties.get(r.party_id) ?? null) : null,
      accountCode: r.grp,
      accountName: r.grp ? (names.get(r.grp) ?? null) : null,
      groupAmount,
      usual,
      historyCount: r.rule === 'amount_outlier' && r.d_count !== null ? Number(r.d_count) : null,
      ratio: usual !== null && groupAmount !== null ? ratioText(groupAmount, usual) : null,
      direction: r.d_direction,
      basis: r.d_basis,
      day: r.d_day,
      control: r.d_control,
      invoiceNumber: r.d_number,
      otherEntryId: r.d_other,
      otherEntryDate: r.d_other_date,
    };
  };
  const hits = found.filter((r) => !r.reviewed).map(toHit);
  const doneRows = found.filter((r) => r.reviewed);
  const reviewers = await memberNameMap(ctx, [...new Set(doneRows.flatMap((r) => (r.marked_by ? [r.marked_by] : [])))]);
  const reviewedHits: ReviewedHit[] = doneRows.map((r) => ({ hit: toHit(r), reviewedByName: r.marked_by ? (reviewers.get(r.marked_by) ?? null) : null, reviewedAt: r.marked_on ?? r.entry_date }));
  const open = Number(summary?.open_total ?? 0);
  return {
    month: input.month,
    legalEntityId: entity,
    regime: here.regime,
    chartVersion: here.version,
    thresholds: {
      amountFactor: UNUSUAL_AMOUNT_FACTOR,
      amountMinDiff: UNUSUAL_AMOUNT_MIN_DIFF,
      madFactor: UNUSUAL_MAD_FACTOR,
      historyMonths: UNUSUAL_HISTORY_MONTHS,
      minHistory: UNUSUAL_AMOUNT_MIN_HISTORY,
      offDayMinAmount: UNUSUAL_OFF_DAY_MIN_AMOUNT,
    },
    historyFrom: real.historyFrom,
    empty: Number(summary?.entries ?? 0) === 0,
    hits,
    moreHits: Math.max(0, open - hits.length),
    reviewed: Number(summary?.reviewed_total ?? 0),
    reviewedHits,
  };
}

export const financeUnusualEntriesQuery = defineQuery({
  name: 'finance.unusual_entries',
  input: zFinanceUnusualEntriesInput,
  access: ALL,
  handler: (ctx, input): Promise<FinanceUnusualEntries> => financeUnusualEntries(ctx, input),
});

// A person marks one CURRENT hit (an entry and the rule that finds it now) as reviewed; anything else is refused NOT_A_HIT and writes nothing. It changes no ledger table: one row of entry_review_mark, the first time. The unique key (org, entry, rule) makes it idempotent: a second
// mark inserts nothing and answers alreadyReviewed. The runtime audits every run; the audit holds the entry id, the rule and whether it was already marked, never a figure, name or text. A viewer is refused by access,
// and so is an agent or Vy (only a user marks).
export const unusualEntriesReview = defineCommand({
  name: 'finance.unusual_entries.review',
  input: zFinanceUnusualEntryReviewInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: MARKERS,
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới đánh dấu đã xem được');
    const entity = await resolveLegalEntity(ctx, input.legalEntityId);
    const entry = await ctx.trx
      .selectFrom('ludy_finance.journal_entry')
      .select(['id', 'entry_date'])
      .where('org_id', '=', ctx.orgId)
      .where('legal_entity_id', '=', entity)
      .where('id', '=', input.entryId)
      .executeTakeFirst();
    if (!entry) throw new DomainError('NOT_FOUND', 404, 'Không tìm thấy bút toán trong pháp nhân này');
    // Only a current hit is marked: a member must not be able to suppress a hit that has not happened yet. The same rule SQL is run for that one entry, in the month of its date.
    const month = String(entry.entry_date).slice(0, 7);
    const { here, span, holidays } = await reviewSetup(ctx, entity, month).catch((error: unknown) => {
      if (error instanceof DomainError && error.code === 'MONTH_NOT_ENDED') throw notAHit();
      throw error;
    });
    if (!(await isCurrentHit(ctx, entity, here.regime, span, holidays, entry.id, input.rule))) throw notAHit();
    const inserted = await ctx.trx
      .insertInto('ludy_finance.entry_review_mark')
      .values({ org_id: ctx.orgId, legal_entity_id: entity, entry_id: entry.id, rule: input.rule, marked_by: ctx.actor.userId })
      .onConflict((oc) => oc.columns(['org_id', 'entry_id', 'rule']).doNothing())
      .returning('id')
      .executeTakeFirst();
    const alreadyReviewed = inserted === undefined;
    ctx.audit({ entry_id: entry.id, rule: input.rule, already_reviewed: alreadyReviewed });
    return { entryId: entry.id, rule: input.rule, alreadyReviewed };
  },
});
