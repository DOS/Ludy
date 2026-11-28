// VAT working per month or quarter (issue #316): finance.vat.period reads the period's input and output invoices and
// their totals by rate (see domain/vat-return.ts for the rules and their legal sources); finance.vat.export records an
// Excel export of it (GET /api/export/vat.xlsx), like finance.journal.export.
//
// Input invoices are the recorded purchase documents, output invoices the recorded sales documents (sales e-invoices,
// issue #313); both live in ludy_finance.purchase_document, told apart by direction. A document recorded from e-invoice
// XML since #685 carries the invoice's own VAT table (ludy_finance.purchase_tax_rate), which splits it by rate exactly;
// the others are split by estimate from their lines and flagged rate_split when that spreads VAT over several rates.
//
// The period of an input invoice is its posting date, the date of its journal entry (#478). That is its invoice date,
// except for an invoice recorded after its own month was locked, or dated on or before the org's opening entry (#366),
// which the approver posts on a later date: it is then declared in the period of that date, flagged declared_late when
// that is a later period than its invoice date's (posted later in the same period, it is an ordinary invoice of it).
// Source (checked 2026-10-19 against the General Department of Taxation's published answers, not the texts themselves):
// input VAT is declared in the period it arises (Law on VAT No. 48/2024/QH15, Article 14(1)(đ)), and an omission found
// later that lowers the tax payable, as a missed input invoice does, is declared in the period it is found (Decree
// 181/2025/ND-CP, Article 23(5) and (6)); one that raises it needs a supplementary return for its own period. Treating
// a late-received invoice as such an omission is an inference for the partner's accountant to confirm (#61). An output
// invoice always stays in its invoice period: a sale is never posted late (record.ts).
//
// The period of a sales invoice is the period of its sale date when the invoice has one apart from its issue date (#3535): a sale missed in its own period and invoiced later is
// declared there (the accountant's answer to #2506 question 4; the fine for a late invoice is heavy). The sale date is the sale date of the e-invoice draft the invoice was issued
// from, found by the entity, the symbol and the number. When that earlier period was already locked or its return filed when the invoice was recorded, nothing reopens it: the invoice is listed as a
// supplementary item of that period (cần kê khai bổ sung), apart from its figures, and it is in no main total of either period, but only if the invoice was recorded after the period was
// declared (declaredAt): one recorded before was in the figures that were filed and stays in them.
import { sql } from 'kysely';
import { z } from 'zod';
import type { MemberRole } from '@ludy/db';
import { INPUT_VAT_CHECK_OUTCOMES, VAT_WARNINGS, zId, zVatPeriod, zVatReturnMark, type DocumentDirection } from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@ludy/kernel-runtime';
import { money, type Money } from '@ludy/l10n-vn';
import {
  documentVatByRate,
  form01Indicators,
  previousVatPeriods,
  vatPeriodOf,
  declaringPeriods,
  reducedRateApplies,
  type InvoiceRateInput,
  sideTotals,
  vatMismatch,
  vatPeriod,
  type FormIndicator,
  type RateAmounts,
  type SideTotals,
  type VatPeriod,
} from './domain/vat-return.ts';
import { legalEntityNotAllowed, resolveLegalEntity } from './legal-entity.ts';
import { latestRevision } from './source-entry.ts';
import { needsPaymentCheck, nonCashThreshold, paymentMethodKind, type PaymentMethodKind } from './domain/non-cash-payment.ts';
import { HtkkAmountError, form01XmlValues } from './domain/vat-01gtgt-xml.ts';
import { salesNumberGaps, type SalesNumberGaps } from './domain/number-gaps.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

// More invoices than this in one period (per side) is refused rather than cut short: a partial VAT working is wrong.
export const VAT_PERIOD_LIMIT = 5_000;

// The VAT working of one legal entity (#1280): legalEntityId as in zLegalEntityChoice.
export const zVatPeriodInput = z.object({ period: zVatPeriod, legalEntityId: zId.optional() });

// Why an invoice needs a look before the figures are filed (VAT_WARNINGS, shared with the API contract).
export { VAT_WARNINGS };
export type VatWarning = (typeof VAT_WARNINGS)[number];

export interface VatInvoiceView {
  id: string;
  issueDate: string;
  // The date of the sale when it is not the issue date's (#3535); null for a purchase and for an invoice with none.
  saleDate: string | null;
  // The date of its journal entry, which chooses the period (#478).
  postingDate: string;
  series: string;
  number: string;
  partyName: string;
  partyTaxCode: string | null;
  subtotal: Money;
  vatAmount: Money;
  total: Money;
  rates: RateAmounts[];
  warnings: VatWarning[];
  // The invoice this one corrects (#916), for a replacement or an adjustment; null for any other. basis: the date its period follows, the posting date of its entry for a purchase
  // (as every purchase is counted, #478) and the date of its own invoice for a sale.
  correction?: { kind: 'replacement' | 'adjustment'; series: string; number: string; basis: 'issue_date' | 'posting_date' } | null;
}

export interface VatSide {
  // false: Ludy has no source for this side: the output side until the org sets its tax code (#313). The documents
  // and totals are then empty.
  available: boolean;
  documents: VatInvoiceView[];
  totals: SideTotals;
}

// An input invoice that needs proof of non-cash payment before its VAT is deducted (#917), with the accountant's mark.
export interface VatPaymentCheck {
  documentId: string;
  paymentMethod: string | null;
  methodKind: PaymentMethodKind;
  threshold: Money;
  total: Money;
  vatAmount: Money;
  mark: { outcome: 'paid_by_bank' | 'not_deductible'; voucherId: string | null; note: string | null; markedAt: string } | null;
}

export interface VatPaymentChecks {
  items: VatPaymentCheck[];
  vatAtRisk: Money;
  notDeductibleVat: Money;
  unchecked: number;
  // [24] minus the VAT marked not deductible: what [25] may hold once every item is checked.
  suggested25: Money;
}

// A period's VAT return as marked filed (#1400): [22], [25] and [43] in whole dong, and where they come from.
export interface VatFiledReturn {
  period: string;
  source: 'entered' | 'computed';
  carriedIn: string;
  deductible: string;
  carriedOut: string;
  markedAt: string;
}

// [22] of a period: the [43] of the return filed for the period just before it, or 0 when there is none (#1400).
export interface VatCarryForward {
  amount: string;
  previous: VatFiledReturn | null;
  lookedFor: string[];
}

// A sales invoice issued in this period for a sale of an earlier period (#3535).
export interface VatLateSale {
  documentId: string;
  series: string;
  number: string;
  partyName: string;
  issueDate: string;
  saleDate: string;
  originalPeriod: string;
  total: Money;
  vatAmount: Money;
  // The earlier period is locked or its return is filed: the invoice is a supplementary item there.
  supplementary: boolean;
}

export interface VatReport {
  period: VatPeriod;
  input: VatSide;
  output: VatSide;
  // Sales of this period issued after it was locked or its return filed (#3535): not in `output`, to declare in a supplementary return.
  supplementary: { documents: VatInvoiceView[]; totals: SideTotals };
  // Sales issued in this period for a sale of an earlier one (#3535): counted in that period.
  lateSales: VatLateSale[];
  indicators: FormIndicator[];
  paymentChecks: VatPaymentChecks;
  carryForward: VatCarryForward;
  filed: VatFiledReturn | null;
  // Whether the signed-in member may mark this entity's return filed (#1508); answered by finance.vat.period only.
  filable?: boolean;
}

function invoiceView(
  period: VatPeriod,
  doc: {
    id: string;
    issueDate: string;
    saleDate: string | null;
    postingDate: string;
    series: string;
    number: string;
    partyName: string;
    partyTaxCode: string | null;
    subtotal: string;
    vatAmount: string;
    total: string;
    correctionKind: 'replacement' | 'adjustment' | null;
    correctedSeries: string | null;
    correctedNumber: string | null;
  },
  direction: DocumentDirection,
  lines: Array<{ amount: string; vatRate: string | null }>,
  invoiceRates: InvoiceRateInput[],
): VatInvoiceView {
  const breakdown = documentVatByRate({ vatAmount: doc.vatAmount, subtotal: doc.subtotal, lines, invoiceRates });
  const warnings: VatWarning[] = [];
  if (breakdown.rates.some((r) => r.rate === 'other')) warnings.push('rate_unknown');
  if (breakdown.allocated) warnings.push('rate_split');
  // The rate that applies is the one of the day of the sale (#3535), which is the issue date unless the invoice has a sale date of its own.
  if (breakdown.rates.some((r) => r.rate === '8') && !reducedRateApplies(doc.saleDate ?? doc.issueDate)) warnings.push('reduced_rate_outside_period');
  const linesTaxable = lines.reduce((acc, l) => acc.plus(money(l.amount)), money(0));
  if (!linesTaxable.equals(money(doc.subtotal))) warnings.push('lines_mismatch');
  if (vatMismatch({ vatAmount: doc.vatAmount, lines })) warnings.push('vat_mismatch');
  // An invoice of an earlier period, posted in this one after its own month was locked (#478).
  if (doc.issueDate < period.from) warnings.push('declared_late');
  // A sale of this period invoiced after it (#3535).
  if (doc.saleDate !== null && doc.issueDate > period.to) warnings.push('late_sale');
  return {
    id: doc.id,
    issueDate: doc.issueDate,
    saleDate: doc.saleDate,
    postingDate: doc.postingDate,
    series: doc.series,
    number: doc.number,
    partyName: doc.partyName,
    partyTaxCode: doc.partyTaxCode,
    subtotal: money(doc.subtotal).toFixed(),
    vatAmount: money(doc.vatAmount).toFixed(),
    total: money(doc.total).toFixed(),
    rates: breakdown.rates,
    warnings,
    correction:
      doc.correctionKind !== null && doc.correctedSeries !== null && doc.correctedNumber !== null
        ? {
            kind: doc.correctionKind,
            series: doc.correctedSeries,
            number: doc.correctedNumber,
            basis: direction === 'purchase' ? 'posting_date' : 'issue_date',
          }
        : null,
  };
}

// The recorded documents of one direction in the period, except those voided by a reversal (#165), oldest first:
// purchases for the input side, by posting date (#478), and sales (#313) for the output side, by sale date when one
// differs from the invoice date (#3535), else invoice date. The party is the supplier or the customer. Each document has
// one entry in force: of its revisions (#1283) the join keeps the latest (#1338), and a document commits only together
// with its entry (purchase_document_entry, #560), so the inner join drops none. A reversal is an entry of another source.
interface PeriodInvoice {
  view: VatInvoiceView;
  paymentMethod: string | null;
  // When the document was recorded (its approval), which a sale invoiced late is compared with the moment its period was declared (#3535).
  recordedAt: Date;
}

interface VatDocumentRow {
  id: string;
  invoice_date: string;
  sale_date?: string | null;
  entry_date: string;
  invoice_series: string;
  invoice_number: string;
  subtotal: string;
  vat_amount: string;
  total: string;
  payment_method: string | null;
  created_at: Date | string;
  name: string;
  tax_code: string | null;
  correction_kind: string | null;
  corrected_series: string | null;
  corrected_number: string | null;
}

type VatLineTuple = [documentId: string, amount: string, vatRate: string | null];
type VatRateTuple = [documentId: string, vatRate: string, taxableAmount: string, vatAmount: string];

interface CheckMarkRow {
  document_id: string;
  outcome: string;
  voucher_id: string | null;
  note: string | null;
  created_at: Date | string;
}

interface FiledReturnRow {
  period: string;
  status: string;
  source: string | null;
  carried_in_amount: string | null;
  deductible_amount: string | null;
  carried_out_amount: string | null;
  created_at: Date | string;
}

interface LateSaleRow {
  id: string;
  invoice_series: string;
  invoice_number: string;
  name: string;
  invoice_date: string;
  sale_date: string;
  total: string;
  vat_amount: string;
  created_at: Date | string;
}

interface LockEventRow {
  period: string;
  at: Date | string | null;
}

interface VatReportDataRow {
  entity_allowed: boolean;
  tax_code: string | null;
  purchase_over: boolean;
  sale_over: boolean;
  late_sale_over: boolean;
  purchases: VatDocumentRow[];
  purchase_lines: VatLineTuple[];
  purchase_rates: VatRateTuple[];
  purchase_marks: CheckMarkRow[];
  sales: VatDocumentRow[];
  sale_lines: VatLineTuple[];
  sale_rates: VatRateTuple[];
  late_sales: LateSaleRow[];
  filed_returns: FiledReturnRow[];
  locked_through: string | null;
  lock_updated_at: Date | string | null;
  lock_events: LockEventRow[];
}

function periodTooLargeError(): DomainError {
  return new DomainError('PERIOD_TOO_LARGE', 422, `Kỳ này có hơn ${VAT_PERIOD_LIMIT} hóa đơn; hệ thống chưa lập được bảng kê lớn như vậy`);
}

function buildPeriodInvoices(
  period: VatPeriod,
  direction: DocumentDirection,
  docs: readonly VatDocumentRow[],
  lineRows: readonly VatLineTuple[],
  rateRows: readonly VatRateTuple[],
): PeriodInvoice[] {
  if (docs.length === 0) return [];
  const byDocument = new Map<string, Array<{ amount: string; vatRate: string | null }>>();
  for (const [documentId, amount, vatRate] of lineRows) {
    const list = byDocument.get(documentId) ?? [];
    list.push({ amount, vatRate });
    byDocument.set(documentId, list);
  }
  const ratesByDocument = new Map<string, InvoiceRateInput[]>();
  for (const [documentId, rate, taxable, vat] of rateRows) {
    const list = ratesByDocument.get(documentId) ?? [];
    list.push({ rate, taxable, vat });
    ratesByDocument.set(documentId, list);
  }
  return docs.map((d) => ({
    paymentMethod: d.payment_method,
    recordedAt: new Date(d.created_at),
    view: invoiceView(
      period,
      {
        id: d.id,
        issueDate: d.invoice_date,
        saleDate: d.sale_date ?? null,
        postingDate: d.entry_date,
        series: d.invoice_series,
        number: d.invoice_number,
        partyName: d.name,
        partyTaxCode: d.tax_code,
        subtotal: d.subtotal,
        vatAmount: d.vat_amount,
        total: d.total,
        correctionKind: d.correction_kind === 'replacement' || d.correction_kind === 'adjustment' ? d.correction_kind : null,
        correctedSeries: d.corrected_series,
        correctedNumber: d.corrected_number,
      },
      direction,
      byDocument.get(d.id) ?? [],
      ratesByDocument.get(d.id) ?? [],
    ),
  }));
}

function side(available: boolean, documents: VatInvoiceView[]): VatSide {
  return { available, documents, totals: sideTotals(documents) };
}

type CheckMark = NonNullable<VatPaymentCheck['mark']>;

// The latest mark of each input document (#917); a cleared mark counts as none.
function toMarksMap(rows: readonly CheckMarkRow[]): Map<string, CheckMark> {
  const marks = new Map<string, CheckMark>();
  for (const row of rows) {
    if (row.outcome !== 'paid_by_bank' && row.outcome !== 'not_deductible') continue;
    marks.set(row.document_id, {
      outcome: row.outcome,
      voucherId: row.voucher_id,
      note: row.note,
      markedAt: new Date(row.created_at).toISOString(),
    });
  }
  return marks;
}

// The input invoices of the period that need proof of non-cash payment, and the [25] they leave (#917).
function paymentChecks(input: PeriodInvoice[], marks: Map<string, CheckMark>, vat24: Money): VatPaymentChecks {
  const items: VatPaymentCheck[] = [];
  let atRisk = money(0);
  let notDeductible = money(0);
  let unchecked = 0;
  for (const { view, paymentMethod } of input) {
    if (!needsPaymentCheck({ issueDate: view.issueDate, total: view.total, paymentMethod })) continue;
    const mark = marks.get(view.id) ?? null;
    if (mark?.outcome !== 'paid_by_bank') atRisk = atRisk.plus(money(view.vatAmount));
    if (mark?.outcome === 'not_deductible') notDeductible = notDeductible.plus(money(view.vatAmount));
    if (!mark) {
      unchecked += 1;
      // Flagged on its row too, until the accountant marks it.
      view.warnings.push('check_payment');
    }
    items.push({
      documentId: view.id,
      paymentMethod,
      methodKind: paymentMethodKind(paymentMethod),
      threshold: nonCashThreshold(view.issueDate).amount,
      total: view.total,
      vatAmount: view.vatAmount,
      mark,
    });
  }
  return {
    items,
    vatAtRisk: atRisk.toFixed(),
    notDeductibleVat: notDeductible.toFixed(),
    unchecked,
    suggested25: money(vat24).minus(notDeductible).toFixed(),
  };
}

function toFiledReturnsMap(rows: readonly FiledReturnRow[]): Map<string, VatFiledReturn> {
  const out = new Map<string, VatFiledReturn>();
  for (const row of rows) {
    if (row.status !== 'filed' || (row.source !== 'entered' && row.source !== 'computed')) continue;
    out.set(row.period, {
      period: row.period,
      source: row.source,
      carriedIn: money(row.carried_in_amount ?? '0').toFixed(0),
      deductible: money(row.deductible_amount ?? '0').toFixed(0),
      carriedOut: money(row.carried_out_amount ?? '0').toFixed(0),
      markedAt: new Date(row.created_at).toISOString(),
    });
  }
  return out;
}

// The latest mark of each of `periods` (#1400) of one legal entity (#1280: each entity files its own returns, so [22]
// comes from the same entity's previous return); a withdrawn one counts as none.
async function filedReturns(ctx: QueryContext, legalEntityId: string, periods: string[]): Promise<Map<string, VatFiledReturn>> {
  if (periods.length === 0) return new Map();
  const rows = await ctx.trx
    .selectFrom('ludy_finance.vat_return_filed')
    .select(['period', 'status', 'source', 'carried_in_amount', 'deductible_amount', 'carried_out_amount', 'created_at'])
    .distinctOn('period')
    .where('org_id', '=', ctx.orgId)
    .where('legal_entity_id', '=', legalEntityId)
    .where('period', 'in', periods)
    .orderBy('period')
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .execute();
  return toFiledReturnsMap(rows);
}

// Each distinct original period of the late sales issued in `period` (#3535), with its date span, lock month, and
// alternate-kind filing period so return filings and lock timestamps join in the same statement.
function lateSalePeriodsSql(kind: VatPeriod['kind']) {
  const quarterExpr = sql`(((pg_catalog.extract('month'::text, ls.sale_date)::int - 1) / 3) + 1)`;
  const quarterCode = sql`(pg_catalog.to_char(ls.sale_date, 'YYYY') || '-Q' || ${quarterExpr}::text)`;
  const quarterLastMonth = sql`(pg_catalog.to_char(ls.sale_date, 'YYYY') || '-' || pg_catalog.lpad((${quarterExpr} * 3)::text, 2, '0'))`;
  const monthCode = sql`pg_catalog.to_char(ls.sale_date, 'YYYY-MM')`;
  if (kind === 'month') {
    return sql`
      SELECT DISTINCT
        ${monthCode} AS original_period,
        pg_catalog.date_trunc('month', ls.sale_date)::date AS from_date,
        ((pg_catalog.date_trunc('month', ls.sale_date) + interval '1 month')::date - 1) AS to_date,
        ${monthCode} AS lock_month,
        ${quarterCode} AS other_period
      FROM late_sale_docs ls
      WHERE (SELECT purchase_count <= ${VAT_PERIOD_LIMIT} AND sale_count <= ${VAT_PERIOD_LIMIT} AND late_sale_count <= ${VAT_PERIOD_LIMIT} FROM within_limits)
    `;
  }
  return sql`
    SELECT DISTINCT
      ${quarterCode} AS original_period,
      pg_catalog.date_trunc('quarter', ls.sale_date)::date AS from_date,
      ((pg_catalog.date_trunc('quarter', ls.sale_date) + interval '3 months')::date - 1) AS to_date,
      ${quarterLastMonth} AS lock_month,
      ${quarterLastMonth} AS other_period
    FROM late_sale_docs ls
    WHERE (SELECT purchase_count <= ${VAT_PERIOD_LIMIT} AND sale_count <= ${VAT_PERIOD_LIMIT} AND late_sale_count <= ${VAT_PERIOD_LIMIT} FROM within_limits)
  `;
}

// The VAT working of one legal entity (#1280), read in ONE statement (#613) so purchases, sales, lines, tax rates,
// payment marks, the tenant tax code, filed returns, period lock timestamps, and late sales all see one snapshot even
// in the query's READ COMMITTED transaction. Money and dates go through JSON as text so values keep full precision.
export async function loadVatReport(ctx: QueryContext, periodText: string, legalEntityId: string): Promise<VatReport> {
  const period = vatPeriod(periodText);
  const lookedFor = previousVatPeriods(period);
  const staticReturnPeriods = [...new Set([period.period, ...lookedFor, ...declaringPeriods(period)])];

  const baseDocuments = (direction: DocumentDirection) =>
    ctx.trx
      .selectFrom('ludy_finance.purchase_document as d')
      .innerJoin('ludy_kernel.party as p', (join) => join.onRef('p.org_id', '=', 'd.org_id').onRef('p.id', '=', 'd.party_id'))
      .where('d.org_id', '=', ctx.orgId)
      .where('d.legal_entity_id', '=', legalEntityId)
      .where('d.direction', '=', direction)
      .where(({ not, exists, selectFrom }) =>
        not(exists(selectFrom('ludy_finance.purchase_document_void as v').select('v.document_id').whereRef('v.org_id', '=', 'd.org_id').whereRef('v.document_id', '=', 'd.id'))),
      );

  // The sale date of the e-invoice draft a sales invoice was issued from (#3535), or null: the draft of the same
  // entity, issued, with the invoice's symbol and normalized number. Earliest issued_at answers, so a row is never
  // doubled and an earlier draft without a sale date never borrows a later draft's.
  const baseSalesDocs = () =>
    baseDocuments('sale').leftJoinLateral(
      (eb) =>
        eb
          .selectFrom('ludy_finance.einvoice_draft as e')
          .innerJoin('ludy_finance.einvoice_series as es', (join) => join.onRef('es.org_id', '=', 'e.org_id').onRef('es.id', '=', 'e.series_id'))
          .select('e.sale_date')
          .whereRef('e.org_id', '=', 'd.org_id')
          .whereRef('e.legal_entity_id', '=', 'd.legal_entity_id')
          .where('e.state', '=', 'issued')
          .whereRef('es.symbol', '=', 'd.invoice_series')
          .where(
            sql<boolean>`CASE WHEN pg_catalog.btrim(e.issued_number) ~ '^[0-9]+$' THEN pg_catalog.regexp_replace(pg_catalog.btrim(e.issued_number), '^0+(?=[0-9])', '') ELSE pg_catalog.upper(pg_catalog.btrim(e.issued_number)) END = d.invoice_number`,
          )
          .orderBy('e.issued_at')
          .orderBy('e.id')
          .limit(1)
          .as('sd'),
      (join) => join.onTrue(),
    );

  const purchaseDocs = baseDocuments('purchase')
    .innerJoin('ludy_finance.journal_entry as j', (join) =>
      join.onRef('j.org_id', '=', 'd.org_id').onRef('j.source_id', '=', 'd.id').on('j.source_type', '=', 'finance.purchase_document').on(latestRevision('j')),
    )
    .select([
      'd.id',
      'd.invoice_date',
      'j.entry_date',
      'd.invoice_series',
      'd.invoice_number',
      'd.subtotal',
      'd.vat_amount',
      'd.total',
      'd.payment_method',
      'd.created_at',
      'p.name',
      'p.tax_code',
      'd.correction_kind',
      'd.corrected_series',
      'd.corrected_number',
    ])
    .where('j.entry_date', '>=', period.from)
    .where('j.entry_date', '<=', period.to)
    .orderBy('j.entry_date')
    .orderBy('d.invoice_date')
    .orderBy('d.invoice_series')
    .orderBy('d.invoice_number')
    .orderBy('d.id')
    .limit(VAT_PERIOD_LIMIT + 1);

  const salePeriodDate = sql<string>`COALESCE(sd.sale_date, d.invoice_date)`;
  const saleDocs = baseSalesDocs()
    .innerJoin('ludy_finance.journal_entry as j', (join) =>
      join.onRef('j.org_id', '=', 'd.org_id').onRef('j.source_id', '=', 'd.id').on('j.source_type', '=', 'finance.purchase_document').on(latestRevision('j')),
    )
    .select([
      'd.id',
      'd.invoice_date',
      'sd.sale_date',
      'j.entry_date',
      'd.invoice_series',
      'd.invoice_number',
      'd.subtotal',
      'd.vat_amount',
      'd.total',
      'd.payment_method',
      'd.created_at',
      'p.name',
      'p.tax_code',
      'd.correction_kind',
      'd.corrected_series',
      'd.corrected_number',
    ])
    .where(sql<boolean>`(SELECT pg_catalog.count(*) FROM purchase_docs) <= ${VAT_PERIOD_LIMIT}`)
    .where(salePeriodDate, '>=', period.from)
    .where(salePeriodDate, '<=', period.to)
    .orderBy(salePeriodDate)
    .orderBy('d.invoice_date')
    .orderBy('d.invoice_series')
    .orderBy('d.invoice_number')
    .orderBy('d.id')
    .limit(VAT_PERIOD_LIMIT + 1);

  const lateSaleDocs = baseSalesDocs()
    .select([
      'd.id',
      'd.invoice_series',
      'd.invoice_number',
      'd.invoice_date',
      'd.vat_amount',
      'd.total',
      'd.created_at',
      'p.name',
      'sd.sale_date',
    ])
    .where(sql<boolean>`(SELECT pg_catalog.count(*) FROM purchase_docs) <= ${VAT_PERIOD_LIMIT}`)
    .where(sql<boolean>`(SELECT pg_catalog.count(*) FROM sale_docs) <= ${VAT_PERIOD_LIMIT}`)
    .where('d.invoice_date', '>=', period.from)
    .where('d.invoice_date', '<=', period.to)
    .where('sd.sale_date', '<', period.from)
    .orderBy('d.invoice_date')
    .orderBy('d.invoice_series')
    .orderBy('d.invoice_number')
    .orderBy('d.id')
    .limit(VAT_PERIOD_LIMIT + 1);

  const allWithinLimits = sql`
    (SELECT purchase_count <= ${VAT_PERIOD_LIMIT} AND sale_count <= ${VAT_PERIOD_LIMIT} AND late_sale_count <= ${VAT_PERIOD_LIMIT} FROM within_limits)
  `;

  // Every document id in purchase_docs / sale_docs is unique (latestRevision and LATERAL LIMIT 1 yield at most one row
  // per document), so JOIN preserves child row cardinality while letting PostgreSQL hash-join or probe PKs instead of
  // falling back to an unhashed linear ANY(ARRAY(...)) scan on un-analyzed tables.
  const docLinesJson = (cte: 'purchase_docs' | 'sale_docs', countCol: 'purchase_count' | 'sale_count') => {
    const cteRef = sql.id(cte);
    const countRef = sql.id(countCol);
    return sql`
      SELECT coalesce(
        json_agg(json_build_array(l.document_id, l.amount::text, l.vat_rate) ORDER BY l.document_id, l.line_no),
        '[]'::json
      )
      FROM ${cteRef} pd
      JOIN ludy_finance.purchase_line l
        ON l.org_id = ${ctx.orgId}::uuid
       AND l.document_id = pd.id
      WHERE (SELECT ${countRef} BETWEEN 1 AND ${VAT_PERIOD_LIMIT} AND purchase_count <= ${VAT_PERIOD_LIMIT} AND sale_count <= ${VAT_PERIOD_LIMIT} AND late_sale_count <= ${VAT_PERIOD_LIMIT} FROM within_limits)
    `;
  };

  const docRatesJson = (cte: 'purchase_docs' | 'sale_docs', countCol: 'purchase_count' | 'sale_count') => {
    const cteRef = sql.id(cte);
    const countRef = sql.id(countCol);
    return sql`
      SELECT coalesce(
        json_agg(json_build_array(r.document_id, r.vat_rate, r.taxable_amount::text, r.vat_amount::text) ORDER BY r.document_id, r.row_no),
        '[]'::json
      )
      FROM ${cteRef} pd
      JOIN ludy_finance.purchase_tax_rate r
        ON r.org_id = ${ctx.orgId}::uuid
       AND r.document_id = pd.id
      WHERE (SELECT ${countRef} BETWEEN 1 AND ${VAT_PERIOD_LIMIT} AND purchase_count <= ${VAT_PERIOD_LIMIT} AND sale_count <= ${VAT_PERIOD_LIMIT} AND late_sale_count <= ${VAT_PERIOD_LIMIT} FROM within_limits)
    `;
  };

  const { rows } = await sql<VatReportDataRow>`
    WITH
      purchase_docs AS MATERIALIZED ${purchaseDocs},
      sale_docs AS MATERIALIZED ${saleDocs},
      late_sale_docs AS MATERIALIZED ${lateSaleDocs},
      within_limits AS MATERIALIZED (
        SELECT
          (SELECT pg_catalog.count(*) FROM purchase_docs) AS purchase_count,
          (SELECT pg_catalog.count(*) FROM sale_docs) AS sale_count,
          (SELECT pg_catalog.count(*) FROM late_sale_docs) AS late_sale_count
      ),
      late_sale_periods AS MATERIALIZED (${lateSalePeriodsSql(period.kind)}),
      lock_row AS MATERIALIZED (
        SELECT pl.locked_through, pl.updated_at
        FROM ludy_finance.period_lock pl
        WHERE ${allWithinLimits}
          AND pl.org_id = ${ctx.orgId}::uuid
          AND pl.legal_entity_id = ${legalEntityId}::uuid
      ),
      lock_targets AS MATERIALIZED (
        SELECT t.period_key, t.from_date, t.to_date, t.lock_month
        FROM (
          SELECT ${period.period}::text AS period_key, ${period.from}::date AS from_date, ${period.to}::date AS to_date, ${period.to.slice(0, 7)}::text AS lock_month
          UNION
          SELECT original_period, from_date, to_date, lock_month
          FROM late_sale_periods
        ) t
        JOIN lock_row l ON l.locked_through IS NOT NULL AND l.locked_through >= t.to_date
      )
    SELECT
      EXISTS (
        SELECT 1 FROM ludy_kernel.legal_entity le
        WHERE le.org_id = ${ctx.orgId}::uuid AND le.id = ${legalEntityId}::uuid
      ) AS entity_allowed,
      (SELECT t.tax_code FROM ludy_kernel.tenant t WHERE t.org_id = ${ctx.orgId}::uuid) AS tax_code,
      (SELECT purchase_count > ${VAT_PERIOD_LIMIT} FROM within_limits) AS purchase_over,
      (SELECT sale_count > ${VAT_PERIOD_LIMIT} FROM within_limits) AS sale_over,
      (SELECT late_sale_count > ${VAT_PERIOD_LIMIT} FROM within_limits) AS late_sale_over,
      (
        SELECT coalesce(
          json_agg(
            json_build_object(
              'id', d.id,
              'invoice_date', d.invoice_date::text,
              'entry_date', d.entry_date::text,
              'invoice_series', d.invoice_series,
              'invoice_number', d.invoice_number,
              'subtotal', d.subtotal::text,
              'vat_amount', d.vat_amount::text,
              'total', d.total::text,
              'payment_method', d.payment_method,
              'created_at', d.created_at,
              'name', d.name,
              'tax_code', d.tax_code,
              'correction_kind', d.correction_kind,
              'corrected_series', d.corrected_series,
              'corrected_number', d.corrected_number
            )
            ORDER BY d.entry_date, d.invoice_date, d.invoice_series, d.invoice_number, d.id
          ),
          '[]'::json
        )
        FROM purchase_docs d
        WHERE ${allWithinLimits}
      ) AS purchases,
      (${docLinesJson('purchase_docs', 'purchase_count')}) AS purchase_lines,
      (${docRatesJson('purchase_docs', 'purchase_count')}) AS purchase_rates,
      (
        SELECT coalesce(
          json_agg(
            json_build_object(
              'document_id', m.document_id,
              'outcome', m.outcome,
              'voucher_id', m.voucher_id,
              'note', m.note,
              'created_at', m.created_at
            )
          ),
          '[]'::json
        )
        FROM (
          SELECT DISTINCT ON (c.document_id) c.document_id, c.outcome, c.voucher_id, c.note, c.created_at
          FROM purchase_docs pd
          JOIN ludy_finance.input_vat_check c
            ON c.org_id = ${ctx.orgId}::uuid
           AND c.document_id = pd.id
          WHERE (SELECT purchase_count BETWEEN 1 AND ${VAT_PERIOD_LIMIT} AND sale_count <= ${VAT_PERIOD_LIMIT} AND late_sale_count <= ${VAT_PERIOD_LIMIT} FROM within_limits)
          ORDER BY c.document_id, c.created_at DESC, c.id DESC
        ) m
      ) AS purchase_marks,
      (
        SELECT coalesce(
          json_agg(
            json_build_object(
              'id', d.id,
              'invoice_date', d.invoice_date::text,
              'sale_date', d.sale_date::text,
              'entry_date', d.entry_date::text,
              'invoice_series', d.invoice_series,
              'invoice_number', d.invoice_number,
              'subtotal', d.subtotal::text,
              'vat_amount', d.vat_amount::text,
              'total', d.total::text,
              'payment_method', d.payment_method,
              'created_at', d.created_at,
              'name', d.name,
              'tax_code', d.tax_code,
              'correction_kind', d.correction_kind,
              'corrected_series', d.corrected_series,
              'corrected_number', d.corrected_number
            )
            ORDER BY COALESCE(d.sale_date, d.invoice_date), d.invoice_date, d.invoice_series, d.invoice_number, d.id
          ),
          '[]'::json
        )
        FROM sale_docs d
        WHERE ${allWithinLimits}
      ) AS sales,
      (${docLinesJson('sale_docs', 'sale_count')}) AS sale_lines,
      (${docRatesJson('sale_docs', 'sale_count')}) AS sale_rates,
      (
        SELECT coalesce(
          json_agg(
            json_build_object(
              'id', d.id,
              'invoice_series', d.invoice_series,
              'invoice_number', d.invoice_number,
              'name', d.name,
              'invoice_date', d.invoice_date::text,
              'sale_date', d.sale_date::text,
              'total', d.total::text,
              'vat_amount', d.vat_amount::text,
              'created_at', d.created_at
            )
            ORDER BY d.invoice_date, d.invoice_series, d.invoice_number, d.id
          ),
          '[]'::json
        )
        FROM late_sale_docs d
        WHERE ${allWithinLimits}
      ) AS late_sales,
      (
        SELECT coalesce(
          json_agg(
            json_build_object(
              'period', f.period,
              'status', f.status,
              'source', f.source,
              'carried_in_amount', f.carried_in_amount::text,
              'deductible_amount', f.deductible_amount::text,
              'carried_out_amount', f.carried_out_amount::text,
              'created_at', f.created_at
            )
          ),
          '[]'::json
        )
        FROM (
          SELECT DISTINCT ON (r.period)
            r.period, r.status, r.source, r.carried_in_amount, r.deductible_amount, r.carried_out_amount, r.created_at
          FROM ludy_finance.vat_return_filed r
          WHERE ${allWithinLimits}
            AND r.org_id = ${ctx.orgId}::uuid
            AND r.legal_entity_id = ${legalEntityId}::uuid
            AND r.period IN (
              SELECT p FROM pg_catalog.unnest(${staticReturnPeriods}::text[]) AS p
              UNION
              SELECT original_period FROM late_sale_periods
              UNION
              SELECT other_period FROM late_sale_periods
            )
          ORDER BY r.period, r.created_at DESC, r.id DESC
        ) f
      ) AS filed_returns,
      (SELECT locked_through::text FROM lock_row) AS locked_through,
      (SELECT updated_at FROM lock_row) AS lock_updated_at,
      (
        SELECT coalesce(json_agg(json_build_object('period', m.period_key, 'at', m.at)), '[]'::json)
        FROM (
          SELECT t.period_key, pg_catalog.max(e.occurred_at) AS at
          FROM lock_targets t
          JOIN ludy_kernel.audit_event e
            ON e.org_id = ${ctx.orgId}::uuid
           AND e.command = 'finance.period.lock'
           AND e.outcome = 'ok'
           AND e.occurred_at >= t.from_date
           AND e.detail ->> 'month' = t.lock_month
           AND e.detail ->> 'legalEntityId' = ${legalEntityId}::uuid::text
          WHERE EXISTS (SELECT 1 FROM lock_targets)
            AND e.occurred_at >= (SELECT pg_catalog.min(lt.from_date) FROM lock_targets lt)
            AND (e.detail ->> 'month') IN (SELECT lt.lock_month FROM lock_targets lt)
          GROUP BY t.period_key
        ) m
      ) AS lock_events
  `.execute(ctx.trx);

  const data = rows[0];
  if (!data) throw new Error('the VAT report statement returned no row');
  if (!data.entity_allowed) throw legalEntityNotAllowed();
  if (data.purchase_over || data.sale_over || data.late_sale_over) throw periodTooLargeError();

  const purchases = buildPeriodInvoices(period, 'purchase', data.purchases, data.purchase_lines, data.purchase_rates);
  const marks = toMarksMap(data.purchase_marks);
  const input = side(
    true,
    purchases.map((p) => p.view),
  );

  const allSalesRows = buildPeriodInvoices(period, 'sale', data.sales, data.sale_lines, data.sale_rates);
  const allSales = allSalesRows.map((p) => p.view);
  const filedMap = toFiledReturnsMap(data.filed_returns);
  const previous = lookedFor.map((p) => filedMap.get(p)).find((r) => r !== undefined) ?? null;
  const carryForward: VatCarryForward = { amount: previous?.carriedOut ?? '0', previous, lookedFor };
  const filed = filedMap.get(period.period) ?? null;

  const lockEvents = new Map<string, Date>();
  for (const row of data.lock_events) {
    if (row.at !== null) lockEvents.set(row.period, new Date(row.at));
  }
  // period_lock keeps one row per entity with no per-month history: finance.period.lock writes a month-keyed
  // audit_event (read in lock_events above), and lock_updated_at is only the pre-#613 fallback when no event exists.
  const lockFallbackAt = data.lock_updated_at ? new Date(data.lock_updated_at) : null;

  // When a period was declared (#3535): the earlier of the moment its return was last marked filed (under its own key or
  // the other kind's, declaringPeriods) and, when its last month is locked, the moment that month was locked; null when neither.
  const declaredAtOf = (target: VatPeriod): Date | null => {
    const filedMarkedAt = declaringPeriods(target).map((k) => filedMap.get(k)?.markedAt).find((m) => m !== undefined) ?? null;
    const filedAt = filedMarkedAt === null ? null : new Date(filedMarkedAt);
    const locked = data.locked_through === null || data.locked_through < target.to ? null : (lockEvents.get(target.period) ?? lockFallbackAt);
    if (filedAt === null) return locked;
    return locked === null || filedAt.getTime() <= locked.getTime() ? filedAt : locked;
  };

  // A sale of this period invoiced after it (#3535) is a supplementary item only if it was RECORDED after the period was
  // declared: an invoice recorded before stays in the main figures so the working keeps matching what was declared.
  const closedAt = declaredAtOf(period);
  const recorded = new Map(allSalesRows.map((p) => [p.view.id, p.recordedAt]));
  const isSupplementary = (v: VatInvoiceView) => v.saleDate !== null && v.issueDate > period.to && closedAt !== null && (recorded.get(v.id) as Date) > closedAt;
  const supplementaryDocuments = allSales.filter(isSupplementary);
  const sales = allSales.filter((v) => !isSupplementary(v));
  // Sales are told apart by the org's tax code (#313). Without one Ludy cannot know them, so the output side says it
  // is not available, unless sales were recorded while a tax code was set (they stay in the books and count).
  const output = side(Boolean(data.tax_code) || allSales.length > 0, sales);

  const closedByOriginal = new Map<string, Date | null>();
  const lateSales: VatLateSale[] = data.late_sales.map((r) => {
    const original = vatPeriodOf(r.sale_date, period.kind);
    if (!closedByOriginal.has(original)) {
      closedByOriginal.set(original, declaredAtOf(vatPeriod(original)));
    }
    const closed = closedByOriginal.get(original) ?? null;
    return {
      documentId: r.id,
      series: r.invoice_series,
      number: r.invoice_number,
      partyName: r.name,
      issueDate: r.invoice_date,
      saleDate: r.sale_date,
      originalPeriod: original,
      total: money(r.total).toFixed(),
      vatAmount: money(r.vat_amount).toFixed(),
      supplementary: closed !== null && new Date(r.created_at) > closed,
    };
  });

  return {
    period,
    input,
    output,
    supplementary: { documents: supplementaryDocuments, totals: sideTotals(supplementaryDocuments) },
    lateSales,
    indicators: form01Indicators(input.totals, output.totals),
    paymentChecks: paymentChecks(purchases, marks, input.totals.vat),
    carryForward,
    filed,
  };
}

export const vatPeriodQuery = defineQuery({
  name: 'finance.vat.period',
  input: zVatPeriodInput,
  access: ALL,
  handler: async (ctx, input): Promise<VatReport> => {
    const legalEntityId = await resolveLegalEntity(ctx, input.legalEntityId);
    return { ...(await loadVatReport(ctx, input.period, legalEntityId)), filable: await mayFileVat(ctx, legalEntityId) };
  },
});

// More recorded sales than this in the years a gap check reads is refused rather than cut short: a partial check would
// miss a number or invent one.
export const SALES_NUMBER_GAP_LIMIT = 50_000;

// The numbers missing in the legal entity's own sales e-invoice series (#2140), for the VAT working of a period (period:
// the runs that may fall in it) and the Overview (fromYear). Reads the recorded sales that are not voided, in every year
// the check looks at, since a gap is found between two recorded numbers of one year. Writes nothing.
export const salesNumberGapsQuery = defineQuery({
  name: 'finance.vat.sales_number_gaps',
  input: z.object({ period: zVatPeriod.optional(), fromYear: z.number().int().min(2000).max(2100).optional(), legalEntityId: zId.optional() }),
  access: ALL,
  handler: async (ctx, input): Promise<SalesNumberGaps> => {
    const legalEntityId = await resolveLegalEntity(ctx, input.legalEntityId);
    const range = input.period ? vatPeriod(input.period) : null;
    // A month or a quarter lies inside one year, which is all its gaps are read from.
    const fromDate = range ? `${range.from.slice(0, 4)}-01-01` : input.fromYear !== undefined ? `${input.fromYear}-01-01` : null;
    const toDate = range ? `${range.to.slice(0, 4)}-12-31` : null;
    let query = ctx.trx
      .selectFrom('ludy_finance.purchase_document as d')
      .select(['d.invoice_series', 'd.invoice_number', 'd.invoice_date'])
      .where('d.org_id', '=', ctx.orgId)
      .where('d.legal_entity_id', '=', legalEntityId)
      .where('d.direction', '=', 'sale')
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('ludy_finance.purchase_document_void as v').select('v.document_id').whereRef('v.org_id', '=', 'd.org_id').whereRef('v.document_id', '=', 'd.id'),
          ),
        ),
      );
    if (fromDate) query = query.where('d.invoice_date', '>=', fromDate);
    if (toDate) query = query.where('d.invoice_date', '<=', toDate);
    const docs = await query.orderBy('d.invoice_date').orderBy('d.id').limit(SALES_NUMBER_GAP_LIMIT + 1).execute();
    if (docs.length > SALES_NUMBER_GAP_LIMIT) {
      throw new DomainError('PERIOD_TOO_LARGE', 422, `Có hơn ${SALES_NUMBER_GAP_LIMIT} hóa đơn bán ra trong các năm cần kiểm tra; hệ thống chưa kiểm tra được số hóa đơn còn thiếu`);
    }
    return salesNumberGaps(
      docs.map((d) => ({ series: d.invoice_series, number: d.invoice_number, issueDate: d.invoice_date })),
      { ...(range ? { period: { from: range.from, to: range.to } } : {}), ...(input.fromYear !== undefined ? { fromYear: input.fromYear } : {}) },
    );
  },
});

// Whether the signed-in member may mark this entity's VAT return filed (#1508): an owner or an admin, or finance.vat.file
// org-wide or for the entity. finance.vat.return_mark and vat_return_filed_guard decide again; roles.db.test.ts pins this
// answer to what the command does, per member and entity (#1923).
async function mayFileVat(ctx: QueryContext, legalEntityId: string): Promise<boolean> {
  if (ctx.actor.type !== 'user') return false;
  if (ctx.role === 'owner' || ctx.role === 'admin') return true;
  const { rows } = await sql<{ entities: string[] }>`SELECT ludy_kernel.ctx_permission_entities('finance.vat.file') AS entities`.execute(ctx.trx);
  const entities = rows[0]?.entities ?? [];
  return entities.includes('*') || entities.includes(legalEntityId);
}

// The taxpayer block of the HTKK return (issue #332): the org's tax code (#313), name and address (#324, #692).
export interface VatTaxpayer {
  taxCode: string;
  name: string;
  address: string | null;
}

export interface VatDeclaration {
  report: VatReport;
  taxpayer: VatTaxpayer;
}

// The VAT working of a period with the taxpayer it is declared for, for the HTKK XML export
// (GET /api/export/vat-01gtgt.xml). A return names the taxpayer's tax code, so an org without one is refused. The
// working is the legal entity's (#1280); the taxpayer block is still the org's.
export const vatDeclarationQuery = defineQuery({
  name: 'finance.vat.declaration',
  input: zVatPeriodInput,
  access: ALL,
  handler: async (ctx, input): Promise<VatDeclaration> => {
    const legalEntityId = await resolveLegalEntity(ctx, input.legalEntityId);
    const org = await ctx.trx.selectFrom('ludy_kernel.tenant').select(['tax_code', 'name', 'address', 'vat_filing_period']).where('org_id', '=', ctx.orgId).executeTakeFirst();
    if (!org?.tax_code) {
      throw new DomainError('TAX_CODE_REQUIRED', 422, 'Tổ chức chưa có mã số thuế. Nhập mã số thuế trong Cài đặt rồi xuất lại.');
    }
    // A return is filed for the org's filing period (#318): a monthly filer does not file a quarterly return. Unset
    // means nobody said, so either kind is allowed. Only the XML is refused; the Excel working stays open for any
    // period as an analysis tool (it is not a filing).
    const kind = vatPeriod(input.period).kind;
    if (org.vat_filing_period && org.vat_filing_period !== kind) {
      throw new DomainError(
        'PERIOD_KIND_MISMATCH',
        422,
        org.vat_filing_period === 'month'
          ? 'Tổ chức khai thuế GTGT theo tháng nên không xuất được tờ khai XML theo quý. Chọn một tháng, hoặc đổi kỳ khai trong Cài đặt.'
          : 'Tổ chức khai thuế GTGT theo quý nên không xuất được tờ khai XML theo tháng. Chọn một quý, hoặc đổi kỳ khai trong Cài đặt.',
      );
    }
    return { report: await loadVatReport(ctx, input.period, legalEntityId), taxpayer: { taxCode: org.tax_code, name: org.name, address: org.address } };
  },
});

// The file formats of a VAT export: the Excel working (#316, no format in the audit row, as before) or the HTKK XML
// of form 01/GTGT (#332).
export const VAT_EXPORT_FORMATS = ['htkk_01gtgt_xml'] as const;

// Records one export of a period's VAT working after the file is built. It changes nothing: its audit row is the
// record, with the period, the number of invoices, the format and the [25] choice, never their content. Same roles as
// finance.vat.period.
export const vatExport = defineCommand({
  name: 'finance.vat.export',
  input: zVatPeriodInput.extend({
    documents: z.number().int().nonnegative().max(2 * VAT_PERIOD_LIMIT),
    format: z.enum(VAT_EXPORT_FORMATS).optional(),
    // The HTKK XML with [25] = [24] (#692), or with the suggested [25] (#917), the accountant's choice for that download.
    deductInput: z.boolean().optional(),
    deductSuggested: z.boolean().optional(),
    // Where [22] of the HTKK XML came from (#1400): the previous filed return's [43], an amount the accountant typed,
    // or 0 for want of a previous return. Never the amount.
    carryForward: z.enum(['previous', 'edited', 'none']).optional(),
  }),
  risk: 'R0',
  sideEffect: 'none',
  access: ALL,
  handler: async (ctx, input) => {
    ctx.audit({
      period: input.period,
      documents: input.documents,
      ...(input.legalEntityId ? { legal_entity_id: input.legalEntityId } : {}),
      ...(input.format ? { format: input.format } : {}),
      ...(input.deductInput ? { deduct_input: true } : {}),
      ...(input.deductSuggested ? { deduct_suggested: true } : {}),
      ...(input.carryForward ? { carry_forward: input.carryForward } : {}),
    });
    return { ok: true as const };
  },
});

const MARKERS: readonly MemberRole[] = ['owner', 'admin', 'member'];

// The accountant's mark on an input invoice that needs proof of non-cash payment (#917): paid_by_bank (optionally
// with the bank voucher, báo Nợ, that paid it), not_deductible, or cleared. One appended row per mark; the latest is the
// invoice's state, and the audit row records each one. It changes no figure of the books: only the suggested [25].
export const vatPaymentMark = defineCommand({
  name: 'finance.vat.payment_mark',
  input: z.object({
    documentId: zId,
    outcome: z.enum(INPUT_VAT_CHECK_OUTCOMES),
    voucherId: zId.nullable().optional(),
    note: z.string().trim().min(1).max(500).nullable().optional(),
  }),
  risk: 'R1',
  sideEffect: 'internal',
  access: MARKERS,
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới đánh dấu được hóa đơn');
    const doc = await ctx.trx
      .selectFrom('ludy_finance.purchase_document as d')
      .select(['d.id', 'd.direction', 'd.invoice_date', 'd.total', 'd.payment_method', 'd.legal_entity_id'])
      .where('d.org_id', '=', ctx.orgId)
      .where('d.id', '=', input.documentId)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('ludy_finance.purchase_document_void as v').select('v.document_id').whereRef('v.org_id', '=', 'd.org_id').whereRef('v.document_id', '=', 'd.id'),
          ),
        ),
      )
      .executeTakeFirst();
    if (!doc || doc.direction !== 'purchase') throw new DomainError('NOT_FOUND', 404, 'Không tìm thấy hóa đơn mua vào');
    if (!needsPaymentCheck({ issueDate: doc.invoice_date, total: doc.total, paymentMethod: doc.payment_method })) {
      throw new DomainError('NOT_FLAGGED', 409, 'Hóa đơn này không cần kiểm tra chứng từ thanh toán không dùng tiền mặt');
    }
    const voucherId = input.voucherId ?? null;
    if (voucherId !== null) {
      if (input.outcome !== 'paid_by_bank') throw new DomainError('VOUCHER_NOT_BANK', 422, 'Chỉ gắn chứng từ ngân hàng khi hóa đơn đã thanh toán qua ngân hàng');
      const voucher = await ctx.trx
        .selectFrom('ludy_finance.cash_voucher')
        .select('voucher_type')
        .where('org_id', '=', ctx.orgId)
        // A voucher of the invoice's legal entity (#1280); the database holds both parents of a mark to one entity.
        .where('legal_entity_id', '=', doc.legal_entity_id)
        .where('id', '=', voucherId)
        .executeTakeFirst();
      if (voucher?.voucher_type !== 'bank_debit') throw new DomainError('VOUCHER_NOT_BANK', 422, 'Chứng từ này không phải giấy báo Nợ của tổ chức');
    }
    const note = input.note ?? null;
    await ctx.trx
      .insertInto('ludy_finance.input_vat_check')
      .values({ org_id: ctx.orgId, document_id: doc.id, outcome: input.outcome, voucher_id: voucherId, note, marked_by: ctx.actor.userId })
      .execute();
    ctx.audit({ document_id: doc.id, outcome: input.outcome, ...(voucherId ? { voucher_id: voucherId } : {}) });
    return { documentId: doc.id, outcome: input.outcome };
  },
});

const FILERS: readonly MemberRole[] = ['owner', 'admin'];

// Marks the period's VAT return filed (#1400), with the tax calendar's done mark hung on it: one appended row of
// ludy_finance.vat_return_filed with [22], [25] and [43] as filed, and kernel.tax_obligation.done for vat_return in
// the same transaction. With figures (the VAT screen) they are recorded as entered. Without them (the tax calendar's
// done button) Ludy records its own working: [22] from the return before, [25] the suggested deduction (#917) and
// the [43] the form's formulas give; a period already marked filed keeps its figures. done false takes both marks
// back (a withdrawn row, then kernel.tax_obligation.undo). The audit row holds the period, the choice and the source,
// never the figures.
// Each legal entity files its own return (#1280; legalEntityId as in zLegalEntityChoice), and the tax calendar keeps its
// done mark per entity (#1496): the mark is the entity's own.
export const vatReturnMark = defineCommand({
  name: 'finance.vat.return_mark',
  input: zVatReturnMark,
  risk: 'R1',
  sideEffect: 'internal',
  // Owners and admins, and a chief accountant for the return's legal entity (finance.vat.file: org-wide for
  // finance.chief_accountant, per entity for finance.entity_chief_accountant; #1508): the record feeds the next return.
  // The database holds an insert to this command (vat_return_filed_guard, which checks the same, and
  // vat_return_filed_requires_audit).
  access: FILERS,
  permission: 'finance.vat.file',
  permissionScope: 'legal_entity',
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    const period = vatPeriod(input.period);
    const legalEntityId = await resolveLegalEntity(ctx, input.legalEntityId);
    // A chief accountant of some entities marks only their returns (#1508).
    ctx.permissionEntity(legalEntityId);
    const current = (await filedReturns(ctx, legalEntityId, [period.period])).get(period.period) ?? null;
    const mark = { obligation: 'vat_return' as const, period: period.period, legalEntityId };
    if (!input.done) {
      if (input.figures) throw new DomainError('INVALID', 422, 'Bỏ đánh dấu đã nộp thì không kèm số liệu');
      if (current) {
        await ctx.trx
          .insertInto('ludy_finance.vat_return_filed')
          .values({ org_id: ctx.orgId, legal_entity_id: legalEntityId, period: period.period, status: 'withdrawn', source: null, carried_in_amount: null, deductible_amount: null, carried_out_amount: null, marked_by: ctx.actor.userId })
          .execute();
      }
      await ctx.run('kernel.tax_obligation.undo', mark);
      ctx.audit({ period: period.period, done: false, withdrawn: current !== null, legal_entity_id: legalEntityId });
      return { period: period.period, done: false };
    }
    let figures: { carriedIn: string; deductible: string; carriedOut: string } | null = null;
    let source: 'entered' | 'computed' = 'entered';
    if (input.figures) {
      figures = { carriedIn: money(input.figures.carriedIn).toFixed(0), deductible: money(input.figures.deductible).toFixed(0), carriedOut: money(input.figures.carriedOut).toFixed(0) };
    } else if (!current) {
      source = 'computed';
      const report = await loadVatReport(ctx, period.period, legalEntityId);
      let values: ReturnType<typeof form01XmlValues>;
      try {
        values = form01XmlValues(report.indicators, { carriedForward: report.carryForward.amount, deductible: report.paymentChecks.suggested25 });
      } catch (error) {
        if (error instanceof HtkkAmountError) {
          throw new DomainError('INVALID', 422, `Chỉ tiêu [${error.code}] vượt quá 14 chữ số; hãy kiểm tra lại các hóa đơn của kỳ này`);
        }
        throw error;
      }
      figures = { carriedIn: values['22'], deductible: values['25'], carriedOut: values['43'] };
    }
    // The same figures marked again add no row.
    const recorded =
      figures !== null &&
      !(current && current.source === source && current.carriedIn === figures.carriedIn && current.deductible === figures.deductible && current.carriedOut === figures.carriedOut);
    if (figures && recorded) {
      await ctx.trx
        .insertInto('ludy_finance.vat_return_filed')
        .values({
          org_id: ctx.orgId,
          legal_entity_id: legalEntityId,
          period: period.period,
          status: 'filed',
          source,
          carried_in_amount: figures.carriedIn,
          deductible_amount: figures.deductible,
          carried_out_amount: figures.carriedOut,
          marked_by: ctx.actor.userId,
        })
        .execute();
    }
    await ctx.run('kernel.tax_obligation.done', mark);
    ctx.audit({ period: period.period, done: true, source: recorded ? source : (current?.source ?? source), recorded, legal_entity_id: legalEntityId });
    return { period: period.period, done: true };
  },
});
