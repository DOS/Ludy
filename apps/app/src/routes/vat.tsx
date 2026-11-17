import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import { vatDueDate, vatLateFacts, vatLateKey, vatLateTemplate, type VAT_RATES, type VAT_WARNINGS } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { AmountInput } from '../components/amount-input.tsx';
import { useChosenEntity } from '../components/entity-switcher.tsx';
import { SalesNumberGaps } from '../components/sales-number-gaps.tsx';
import { DataTable, Empty, ErrorText, PageHeader, TableSkeleton } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { apiFetch, client, errorMessage, getCurrentOrg, orpc, queryClient } from '../lib/api.ts';
import { periodParts } from '../lib/clients.ts';
import { isZeroAmount } from '../lib/decimal.ts';
import { exportQuery } from '../lib/legal-entity-choice.ts';
import {
  DEDUCT_CHOICES,
  canMarkFiled,
  canMarkPayment,
  carriedOutOf,
  deductAmount,
  deductParams,
  defaultPeriod,
  periodChoiceOf,
  roundDong,
  periodKey,
  periodSearch,
  switchKind,
  wholeDong,
  INDICATOR_GLOSS,
  vatResultOf,
  yearOptions,
  type DeductChoice,
  type PeriodChoice,
  type PeriodKind,
  type PeriodSearch,
} from '../lib/vat.ts';

type Rate = (typeof VAT_RATES)[number];
type Warning = (typeof VAT_WARNINGS)[number];

interface Invoice {
  id: string;
  issueDate: string;
  // The day of the sale when the invoice is later than it (#3535).
  saleDate?: string | null;
  series: string;
  number: string;
  partyName: string;
  partyTaxCode: string | null;
  rates: Array<{ rate: Rate; taxable: string; vat: string }>;
  warnings: Warning[];
}

// A money cell: right-aligned with tabular figures, under a header DataTable aligns the same way (DESIGN.md §4.3, #2001).
const NUM = 'px-4 py-3 text-right tabular-nums';

export function InvoiceTable({ invoices, partyLabel }: { invoices: Invoice[]; partyLabel: string }) {
  const t = useTranslations('vat');
  const f = useFormat();
  return (
    <DataTable numeric={[4, 5]} head={[t('columns.issueDate'), t('columns.number'), partyLabel, t('columns.rate'), t('columns.taxable'), t('columns.vat'), t('columns.notes')]}>
      {invoices.flatMap((invoice) =>
        invoice.rates.map((rate, i) => (
          <TableRow key={`${invoice.id}-${rate.rate}`}>
            <TableCell className="px-4 py-3 text-muted-foreground">
              {i === 0 ? f.date(invoice.issueDate) : ''}
              {i === 0 && invoice.saleDate && <span className="block text-xs text-subtle-foreground">{t('saleOn', { date: f.date(invoice.saleDate) })}</span>}
            </TableCell>
            <TableCell className="px-4 py-3 font-mono text-xs text-foreground">
              {i === 0 ? `${invoice.series ? `${invoice.series}-` : ''}${invoice.number}` : ''}
            </TableCell>
            <TableCell className="px-4 py-3 text-foreground">
              {i === 0 && (
                <>
                  {invoice.partyName}
                  {invoice.partyTaxCode && <span className="block font-mono text-xs text-subtle-foreground">{invoice.partyTaxCode}</span>}
                </>
              )}
            </TableCell>
            <TableCell className="px-4 py-3 text-muted-foreground">{t(`rates.${rate.rate}`)}</TableCell>
            <TableCell className={`${NUM} text-foreground`}>{f.money(rate.taxable)}</TableCell>
            <TableCell className={`${NUM} text-foreground`}>{f.money(rate.vat)}</TableCell>
            <TableCell className="px-4 py-3">
              {i === 0 && (
                <div className="flex flex-wrap gap-1">
                  {invoice.warnings.map((w) => (
                    <Badge key={w} variant="warning">
                      {t(`warnings.${w}`)}
                    </Badge>
                  ))}
                </div>
              )}
            </TableCell>
          </TableRow>
        )),
      )}
    </DataTable>
  );
}

type VatReport = Awaited<ReturnType<typeof client.vat.period>>;
type PaymentCheck = VatReport['paymentChecks']['items'][number];

// The coworker's sentence on the late sales of the working (#3540): each late invoice and the period of its sale. The template is built from the lists below with no model, so it shows
// with AI off, spent or refused (the server drops a sentence that names an invoice or period not in the lists). A coworker sentence that came back used goes above it and never states a
// status: the template always stays, because whether an invoice needs a supplementary declaration is the one fact a person acts on, and only code states it.
// It reads and names only: nothing is declared or posted, and a person decides the supplementary declaration. `version` is when the lists were read, so the sentence is asked again
// whenever they are (the server keeps one by its facts, so asking again over unchanged lists costs no model call).
export function LateSummary({ data, legalEntityId, ready, version }: { data: Pick<VatReport, 'period' | 'supplementary' | 'lateSales'>; legalEntityId: string | undefined; ready: boolean; version: number }) {
  const t = useTranslations('vat');
  const lang = useLocale() === 'en' ? 'en' : 'vi';
  const facts = vatLateFacts(data);
  const base = orpc.vat.explain.queryOptions({ input: { period: data.period.period, legalEntityId, lang } });
  const explain = useQuery({ ...base, queryKey: [...base.queryKey, version], enabled: ready && facts.length > 0, staleTime: Infinity, retry: false });
  const template = vatLateTemplate(facts, lang);
  if (template === null) return null;
  // The coworker sentence only when it was written from the lists on screen (the server read them again for it).
  const text = explain.data?.ai === 'used' && explain.data.text && explain.data.key === vatLateKey(facts) ? explain.data.text : template;
  return (
    <section aria-labelledby="vat-late-summary-title" data-testid="vat-late-summary" className="rounded-lg border border-border p-4">
      <h2 id="vat-late-summary-title" className="text-xs font-medium text-muted-foreground">
        {t('lateSummary.title')}
      </h2>
      {text !== template ? (
        <p className="mt-1 text-sm text-foreground" data-testid="vat-late-summary-sentence">
          {text}
        </p>
      ) : null}
      <p className="mt-1 text-sm text-foreground" data-testid="vat-late-summary-status">
        {template}
      </p>
      <p className="mt-2 text-xs text-subtle-foreground">{t('lateSummary.note')}</p>
    </section>
  );
}

// The sales of this period that must go in a supplementary return (#3535): issued after the period was locked or its return filed, for a sale made in it. Not in the figures above.
export function SupplementaryItems({ data }: { data: Pick<VatReport, 'supplementary'> }) {
  const t = useTranslations('vat');
  const f = useFormat();
  if (data.supplementary.documents.length === 0) return null;
  return (
    <section aria-labelledby="vat-supplementary-title" data-testid="vat-supplementary">
      <h2 id="vat-supplementary-title" className="mb-1 text-base font-semibold text-foreground">
        {t('supplementary.title', { count: f.number(data.supplementary.documents.length) })}
      </h2>
      <p className="mb-2 text-sm text-muted-foreground">{t('supplementary.hint', { vat: f.money(data.supplementary.totals.vat) })}</p>
      <InvoiceTable invoices={data.supplementary.documents} partyLabel={t('columns.buyer')} />
    </section>
  );
}

// The sales invoiced in this period for a sale of an earlier one (#3535): counted in the period of the sale, listed here so none goes unseen.
export function LateSales({ data }: { data: Pick<VatReport, 'lateSales'> }) {
  const t = useTranslations('vat');
  const f = useFormat();
  if (data.lateSales.length === 0) return null;
  return (
    <section aria-labelledby="vat-late-sales-title" data-testid="vat-late-sales">
      <h2 id="vat-late-sales-title" className="mb-1 text-base font-semibold text-foreground">
        {t('lateSales.title', { count: f.number(data.lateSales.length) })}
      </h2>
      <p className="mb-2 text-sm text-muted-foreground">{t('lateSales.hint')}</p>
      <DataTable numeric={[4]} head={[t('columns.number'), t('columns.buyer'), t('lateSales.saleDate'), t('lateSales.originalPeriod'), t('columns.vat'), t('columns.notes')]}>
        {data.lateSales.map((sale) => (
          <TableRow key={sale.documentId}>
            <TableCell className="px-4 py-3 font-mono text-xs text-foreground">{`${sale.series ? `${sale.series}-` : ''}${sale.number}`}</TableCell>
            <TableCell className="px-4 py-3 text-foreground">{sale.partyName}</TableCell>
            <TableCell className="px-4 py-3 text-muted-foreground">{f.date(sale.saleDate)}</TableCell>
            <TableCell className="px-4 py-3 text-foreground">{sale.originalPeriod}</TableCell>
            <TableCell className={`${NUM} text-foreground`}>{f.money(sale.vatAmount)}</TableCell>
            <TableCell className="px-4 py-3">
              <Badge variant="warning">{sale.supplementary ? t('lateSales.supplementary') : t('lateSales.counted')}</Badge>
            </TableCell>
          </TableRow>
        ))}
      </DataTable>
    </section>
  );
}

// Input invoices that need proof of non-cash payment before their VAT is deducted (#917), with the accountant's marks.
function PaymentChecks({ data, canMark, legalEntityId }: { data: VatReport; canMark: boolean; legalEntityId: string | undefined }) {
  const t = useTranslations('vat.payment');
  const f = useFormat();
  const checks = data.paymentChecks;
  const byId = new Map(data.input.documents.map((d) => [d.id, d]));
  // The bank payment vouchers (báo Nợ) of the report's entity, to name the one that paid an invoice. The newest page is
  // enough to pick from.
  const vouchers = useQuery({ ...orpc.vouchers.list.queryOptions({ input: { type: 'bank_debit', legalEntityId } }), enabled: canMark && checks.items.length > 0 });
  const [voucherFor, setVoucherFor] = useState<Record<string, string>>({});
  const mark = useMutation({
    mutationFn: (v: { documentId: string; outcome: 'paid_by_bank' | 'not_deductible' | 'cleared'; voucherId?: string | null }) => client.vat.markPayment(v),
    onSettled: () => queryClient.invalidateQueries({ queryKey: orpc.vat.period.key() }),
  });
  const status = (item: PaymentCheck) => (item.mark ? t(`outcome.${item.mark.outcome}`) : t('unchecked'));
  // Nothing to check: no card (#3600).
  if (checks.items.length === 0) return null;
  return (
    <section>
      <h2 className="mb-1 text-base font-semibold text-foreground">{t('title', { count: checks.items.length })}</h2>
      <p className="mb-2 text-xs text-subtle-foreground">{t('hint')}</p>
      {
        <>
          <DataTable
            numeric={[2, 3]}
            head={[t('columns.invoice'), t('columns.seller'), t('columns.total'), t('columns.vat'), t('columns.method'), t('columns.status'), ...(canMark ? [t('columns.actions')] : [])]}
          >
            {checks.items.map((item) => {
              const doc = byId.get(item.documentId);
              const busy = mark.isPending && mark.variables?.documentId === item.documentId;
              return (
                <TableRow key={item.documentId}>
                  <TableCell className="px-4 py-3 text-foreground">
                    <span className="font-mono text-xs">{doc ? `${doc.series ? `${doc.series}-` : ''}${doc.number}` : ''}</span>
                    {doc && <span className="block text-xs text-subtle-foreground">{f.date(doc.issueDate)}</span>}
                  </TableCell>
                  <TableCell className="px-4 py-3 text-foreground">{doc?.partyName ?? ''}</TableCell>
                  <TableCell className={NUM}>{f.money(item.total)}</TableCell>
                  <TableCell className={NUM}>{f.money(item.vatAmount)}</TableCell>
                  <TableCell className="px-4 py-3 text-muted-foreground">{item.paymentMethod ?? t('methodMissing')}</TableCell>
                  <TableCell className="px-4 py-3">
                    <Badge variant={item.mark?.outcome === 'paid_by_bank' ? 'success' : 'warning'}>{status(item)}</Badge>
                    {item.mark?.voucherId && <span className="block text-xs text-subtle-foreground">{t('withVoucher')}</span>}
                  </TableCell>
                  {canMark && (
                    <TableCell className="space-y-2 px-4 py-3">
                      {(vouchers.data?.items.length ?? 0) > 0 && (
                        <NativeSelect
                          aria-label={t('voucher')}
                          className="w-48"
                          value={voucherFor[item.documentId] ?? ''}
                          onChange={(e) => setVoucherFor({ ...voucherFor, [item.documentId]: e.target.value })}>
                          <NativeSelectOption value="">{t('noVoucher')}</NativeSelectOption>
                          {vouchers.data?.items
                            .filter((v) => !v.reversal)
                            .map((v) => (
                              <NativeSelectOption key={v.id} value={v.id}>
                                {`${v.code} · ${f.date(v.date)} · ${f.money(v.amount)}`}
                              </NativeSelectOption>
                            ))}
                        </NativeSelect>
                      )}
                      <div className="flex flex-wrap gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => mark.mutate({ documentId: item.documentId, outcome: 'paid_by_bank', voucherId: voucherFor[item.documentId] || null })}>
                          {t('markBank')}
                        </Button>
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => mark.mutate({ documentId: item.documentId, outcome: 'not_deductible' })}>
                          {t('markNotDeductible')}
                        </Button>
                        {item.mark && (
                          <Button size="sm" variant="ghost" disabled={busy} onClick={() => mark.mutate({ documentId: item.documentId, outcome: 'cleared' })}>
                            {t('clear')}
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </DataTable>
          <p className="mt-2 text-sm text-muted-foreground">
            {t('summary', { atRisk: f.money(checks.vatAtRisk), notDeductible: f.money(checks.notDeductibleVat), unchecked: checks.unchecked })}
          </p>
        </>
      }
      {mark.error && <ErrorText>{errorMessage(mark.error)}</ErrorText>}
    </section>
  );
}

// A return's period inside a sentence: "tháng 9/2026", "quý 3/2026".
function useReturnPeriod() {
  const t = useTranslations('vat.carry');
  return (period: string) => {
    const parts = periodParts(period);
    if (!parts) return period;
    return parts.kind === 'month' ? t('returnMonth', { month: String(parts.index), year: String(parts.year) }) : t('returnQuarter', { quarter: String(parts.index), year: String(parts.year) });
  };
}

// [22] of the return (#1400): the [43] of the return filed for the period before, prefilled and editable, with where it
// comes from. A missing previous return leaves it at 0, with a warning.
function CarryForward({ data, text, onChange }: { data: VatReport; text: string; onChange: (text: string | null) => void }) {
  const t = useTranslations('vat.carry');
  const f = useFormat();
  const periodLabel = useReturnPeriod();
  const { amount, previous, lookedFor } = data.carryForward;
  const value = wholeDong(text);
  return (
    <section aria-labelledby="vat-carry-title">
      <h2 id="vat-carry-title" className="mb-1 text-base font-semibold text-foreground">
        {t('title')}
      </h2>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs">
          <span className="text-subtle-foreground">{t('label')}</span>
          <AmountInput aria-label={t('label')} className="mt-1 w-56 tabular-nums" value={text} onChange={(v) => onChange(v)} aria-invalid={value === null} />
        </label>
        {value !== null && value !== amount && (
          <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
            {t('reset')}
          </Button>
        )}
      </div>
      {value === null && <ErrorText>{t('invalid')}</ErrorText>}
      {previous ? (
        <p className="mt-2 text-sm text-muted-foreground">
          {t('fromPrevious', { period: periodLabel(previous.period), amount: f.money(previous.carriedOut), date: f.date(previous.markedAt.slice(0, 10)) })}
        </p>
      ) : (
        <p className="mt-2 text-sm text-warning">{t('missing', { periods: lookedFor.map(periodLabel).join(t('or')) })}</p>
      )}
      {previous?.source === 'computed' && <p className="mt-1 text-sm text-warning">{t('fromComputed', { period: periodLabel(previous.period) })}</p>}
      {value !== null && value !== amount && <p className="mt-1 text-xs text-subtle-foreground">{t('edited', { amount: f.money(amount) })}</p>}
      <p className="mt-1 text-xs text-subtle-foreground">{t('note')}</p>
    </section>
  );
}

// The period's return as filed (#1400): owners, admins and the entity's chief accountant (#1508) mark it filed with [22],
// [25] and [43] as on the return, which
// the next period's [22] starts from, and the tax calendar marks it done; or take both marks back.
function FiledReturn({
  data,
  carried,
  deduct25,
  canFile,
  legalEntityId,
}: {
  data: VatReport;
  carried: string | null;
  deduct25: string;
  canFile: boolean;
  legalEntityId: string | undefined;
}) {
  const t = useTranslations('vat.filed');
  const f = useFormat();
  const period = data.period.period;
  const filed = data.filed;
  const v35 = data.indicators.find((i) => i.code === '35')?.amount ?? '0';
  const [form, setForm] = useState<{ c22: string; c25: string; c43: string; c43Typed: boolean } | null>(null);
  const done = async () => {
    setForm(null);
    await Promise.all([queryClient.invalidateQueries({ queryKey: orpc.vat.period.key() }), queryClient.invalidateQueries({ queryKey: orpc.org.overview.key() })]);
  };
  // The period and the entity (#1280) travel with each mutation, so switching either while one is in flight never marks
  // another return.
  const save = useMutation({
    mutationFn: (v: { period: string; legalEntityId: string | undefined; figures: { carriedIn: string; deductible: string; carriedOut: string } }) =>
      client.vat.markReturn({ period: v.period, done: true, figures: v.figures, legalEntityId: v.legalEntityId }),
    onSuccess: done,
  });
  const withdraw = useMutation({
    mutationFn: (v: { period: string; legalEntityId: string | undefined }) => client.vat.markReturn({ period: v.period, done: false, legalEntityId: v.legalEntityId }),
    onSuccess: done,
  });
  const open = () => {
    const c22 = filed?.carriedIn ?? carried ?? data.carryForward.amount;
    const c25 = filed?.deductible ?? deduct25;
    setForm({ c22, c25, c43: filed?.carriedOut ?? carriedOutOf(v35, c25, c22), c43Typed: filed !== null });
  };
  // [43] follows [22] and [25] until the accountant types it.
  const change = (field: 'c22' | 'c25' | 'c43', text: string) => {
    if (!form) return;
    const next = { ...form, [field]: text, c43Typed: form.c43Typed || field === 'c43' };
    const c22 = wholeDong(next.c22);
    const c25 = wholeDong(next.c25);
    if (!next.c43Typed && c22 !== null && c25 !== null) next.c43 = carriedOutOf(v35, c25, c22);
    setForm(next);
  };
  const figures = form ? { carriedIn: wholeDong(form.c22), deductible: wholeDong(form.c25), carriedOut: wholeDong(form.c43) } : null;
  const valid = figures !== null && figures.carriedIn !== null && figures.deductible !== null && figures.carriedOut !== null;
  const error = save.error ?? withdraw.error;
  return (
    <section aria-labelledby="vat-filed-title">
      <h2 id="vat-filed-title" className="mb-1 text-base font-semibold text-foreground">
        {t('title')}
      </h2>
      {filed ? (
        <>
          <p className="text-sm text-foreground">
            {t('done', { date: f.date(filed.markedAt.slice(0, 10)), c22: f.money(filed.carriedIn), c25: f.money(filed.deductible), c43: f.money(filed.carriedOut) })}
          </p>
          {filed.source === 'computed' && <p className="mt-1 text-sm text-warning">{t('computedNote')}</p>}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">{t('none')}</p>
      )}
      {!canFile && <p className="mt-1 text-xs text-subtle-foreground">{t('onlyAdmins')}</p>}
      {canFile && !form && (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" variant={filed ? 'outline' : 'default'} onClick={open}>
            {filed ? t('edit') : t('mark')}
          </Button>
          {filed && (
            <Button loading={withdraw.isPending} size="sm" variant="ghost" onClick={() => withdraw.mutate({ period, legalEntityId })}>
              {t('withdraw')}
            </Button>
          )}
        </div>
      )}
      {canFile && form && (
        <form
          className="mt-2 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) save.mutate({ period, legalEntityId, figures: { carriedIn: figures.carriedIn as string, deductible: figures.deductible as string, carriedOut: figures.carriedOut as string } });
          }}>
          <p className="text-xs text-subtle-foreground">{t('formHint')}</p>
          <div className="flex flex-wrap gap-3">
            {(['c22', 'c25', 'c43'] as const).map((field) => (
              <label key={field} className="text-xs">
                <span className="text-subtle-foreground">{t(field)}</span>
                <AmountInput aria-label={t(field)} className="mt-1 w-56 tabular-nums" value={form[field]} onChange={(v) => change(field, v)} aria-invalid={wholeDong(form[field]) === null} />
              </label>
            ))}
          </div>
          {!valid && <ErrorText>{t('invalid')}</ErrorText>}
          <div className="flex flex-wrap gap-2">
            <Button loading={save.isPending} size="sm" type="submit" disabled={!valid || save.isPending}>
              {t('save')}
            </Button>
            <Button size="sm" type="button" variant="ghost" onClick={() => setForm(null)}>
              {t('cancel')}
            </Button>
          </div>
        </form>
      )}
      {error && <ErrorText>{errorMessage(error)}</ErrorText>}
    </section>
  );
}

// The answer an owner opens this screen for (#3600), above the table: the period, the input and output VAT, what Ludy works out from them, the day the return is due, whether it is
// filed, and the one action. Every figure is a decimal string from the report; the result is the form's own [35] - [25] - [22] and says it leaves [36] to [43] to the accountant.
export function ResultStrip({
  data,
  carried,
  fileDeduct25,
  action,
}: {
  data: Pick<VatReport, 'period' | 'indicators' | 'filed' | 'paymentChecks'>;
  carried: string | null;
  // The [25] the HTKK file will hold (the accountant's choice in "Cách tính").
  fileDeduct25: string;
  action: ReactNode;
}) {
  const t = useTranslations('vat.strip');
  const f = useFormat();
  const amountOf = (code: string) => data.indicators.find((i) => i.code === code)?.amount ?? '0';
  // A filed return speaks with its own [22] and [25]; otherwise [25] is the suggestion (the input VAT less what may not be deducted), whatever the XML file is set to write: the file is the
  // accountant's to complete, the strip is the owner's first answer. An [22] that is not a whole number leaves no result rather than a wrong one.
  const suggested25 = roundDong(data.paymentChecks.suggested25);
  const c22 = data.filed ? data.filed.carriedIn : carried;
  const c25 = data.filed ? data.filed.deductible : suggested25;
  const result = c22 === null ? null : vatResultOf(amountOf('35'), c25, c22);
  const due = vatDueDate(data.period.period);
  return (
    <section aria-labelledby="vat-strip-title" data-testid="vat-strip" className="rounded-lg border border-border bg-card p-4">
      <h2 id="vat-strip-title" className="sr-only">
        {t('title')}
      </h2>
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="text-xs font-medium text-muted-foreground">{t(result?.kind ?? 'carried')}</p>
          <p className="mt-1 text-3xl font-semibold tabular-nums text-foreground" data-testid="vat-strip-result" data-kind={result?.kind ?? 'unknown'}>
            {result ? f.money(result.amount) : '-'}
          </p>
        </div>
        <div className="md:shrink-0 [&>*]:w-full md:[&>*]:w-auto">{action}</div>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm md:grid-cols-5">
        <div>
          <dt className="text-xs text-muted-foreground">{t('period')}</dt>
          <dd className="text-foreground">{`${f.date(data.period.from)} - ${f.date(data.period.to)}`}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('inputVat')}</dt>
          <dd className="tabular-nums text-foreground" data-testid="vat-strip-input">{f.money(amountOf('24'))}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('outputVat')}</dt>
          <dd className="tabular-nums text-foreground" data-testid="vat-strip-output">{f.money(amountOf('35'))}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('deadline')}</dt>
          <dd className="text-foreground" data-testid="vat-strip-deadline">{due ? f.date(due) : t('deadlineUnknown')}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('status')}</dt>
          <dd>
            {data.filed ? <Badge variant="success">{t('filed', { date: f.date(data.filed.markedAt.slice(0, 10)) })}</Badge> : <Badge variant="warning">{t('notFiled')}</Badge>}
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-xs text-subtle-foreground">{data.filed ? t('basisFiled') : t('basis', { amount: f.money(suggested25) })}</p>
      {!data.filed && fileDeduct25 !== suggested25 && <p className="mt-1 text-xs text-warning">{t('fileNote', { amount: f.money(fileDeduct25) })}</p>}
    </section>
  );
}

export function VatPage() {
  const t = useTranslations('vat');
  const f = useFormat();
  const locale = useLocale();
  // The org's tax code goes into the HTKK file (#332); without one the server refuses it, so the button waits for it.
  const org = useQuery(orpc.org.get.queryOptions());
  const taxCode = org.data?.taxCode ?? null;
  // The org's filing period (#318) picks the kind the screen opens on, until the user picks another one. The pick lives
  // in the address (#1513), left out when it is that default.
  const filing = org.data?.vatFilingPeriod ?? null;
  const { slug } = useParams({ strict: false }) as { slug: string };
  const search: PeriodSearch = useSearch({ strict: false });
  const navigate = useNavigate();
  const fallback = defaultPeriod(filing ?? 'month');
  const choice = (search.period ? periodChoiceOf(search.period) : null) ?? fallback;
  const setChoice = (next: PeriodChoice) => void navigate({ to: '/o/$slug/vat', params: { slug }, search: periodSearch(periodKey(next), periodKey(fallback)) });
  const period = periodKey(choice);
  // The VAT working of the entity chosen in the shell (#1280); the downloads and the filed mark follow it.
  const entity = useChosenEntity();
  const report = useQuery({ ...orpc.vat.period.queryOptions({ input: { period, legalEntityId: entity.legalEntityId } }), enabled: entity.ready });
  const data = report.data;
  // The XML is a filing, so the server refuses the other kind (PERIOD_KIND_MISMATCH); the button says why first.
  const wrongKind = filing !== null && filing !== choice.kind;

  // What [25] holds in the XML (#692, #917): 0 by default, the accountant's choice per download.
  const [deduct, setDeduct] = useState<DeductChoice>('none');
  // [22] (#1400): the previous return's [43] as the server found it, until the accountant edits it for this period.
  const [carriedEdit, setCarriedEdit] = useState<{ period: string; text: string } | null>(null);
  const carriedText = carriedEdit?.period === period ? carriedEdit.text : (data?.carryForward.amount ?? '0');
  const carried = wholeDong(carriedText);
  const download = async (path: string, filename: string, extra: Record<string, string> = {}) => {
    const response = await apiFetch(`${path}?${exportQuery({ period, ...extra }, entity.legalEntityId)}`);
    const url = URL.createObjectURL(await response.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };
  const exportXlsx = useMutation({
    mutationFn: () => download('/api/export/vat.xlsx', t('exportFile', { period, org: getCurrentOrg() ?? 'org' })),
  });
  const exportXml = useMutation({
    mutationFn: () =>
      download('/api/export/vat-01gtgt.xml', t('exportXmlFile', { period, org: getCurrentOrg() ?? 'org' }), { ...deductParams(deduct), carried: carried ?? '0' }),
  });
  const exportError = exportXlsx.error ?? exportXml.error;

  const wrongKindText = t('exportXmlWrongKind', {
    kind: filing === 'quarter' ? t('filingQuarterly') : t('filingMonthly'),
    kindOne: filing === 'quarter' ? t('kindQuarter') : t('kindMonth'),
  });
  const xmlButton = (
    <Button
      loading={exportXml.isPending}
      size="lg"
      onClick={() => exportXml.mutate()}
      disabled={exportXml.isPending || !data || !taxCode || wrongKind || carried === null}
      title={org.data && !taxCode ? t('exportXmlNeedsTaxCode') : wrongKind ? wrongKindText : undefined}>
      {t('exportXml')}
    </Button>
  );
  const indexes = choice.kind === 'month' ? Array.from({ length: 12 }, (_, i) => i + 1) : [1, 2, 3, 4];
  const rateRows = data ? data.input.totals.byRate.map((input, i) => ({ input, output: data.output.totals.byRate[i] })) : [];
  // Sales at a rate Crove cannot place count in the totals but in no form indicator (issue #358).
  const otherSales = data?.output.totals.byRate.find((r) => r.rate === 'other')?.taxable ?? '0';

  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <Button loading={exportXlsx.isPending} size="lg" variant="outline" onClick={() => exportXlsx.mutate()} disabled={exportXlsx.isPending || !data}>
            {t('export')}
          </Button>
        }
      />
      {org.data && !taxCode && <p className="mb-4 text-sm text-muted-foreground">{t('exportXmlNeedsTaxCode')}</p>}
      {org.data && taxCode && wrongKind && <p className="mb-4 text-sm text-muted-foreground">{wrongKindText}</p>}
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="text-xs">
          <span className="text-subtle-foreground">{t('kind')}</span>
          <NativeSelect aria-label={t('kind')} className="mt-1 w-32" value={choice.kind} onChange={(e) => setChoice(switchKind(choice, e.target.value as PeriodKind))}>
            <NativeSelectOption value="month">{t('month')}</NativeSelectOption>
            <NativeSelectOption value="quarter">{t('quarter')}</NativeSelectOption>
          </NativeSelect>
        </label>
        <label className="text-xs">
          <span className="text-subtle-foreground">{choice.kind === 'month' ? t('month') : t('quarter')}</span>
          <NativeSelect
            aria-label={choice.kind === 'month' ? t('month') : t('quarter')}
            className="mt-1 w-28"
            value={choice.index} onChange={(e) => setChoice({ ...choice, index: Number(e.target.value) })}>
            {indexes.map((n) => (
              <NativeSelectOption key={n} value={n}>
                {choice.kind === 'month' ? t('monthOption', { n: String(n) }) : t('quarterOption', { n: String(n) })}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        <label className="text-xs">
          <span className="text-subtle-foreground">{t('year')}</span>
          <NativeSelect aria-label={t('year')} className="mt-1 w-28" value={choice.year} onChange={(e) => setChoice({ ...choice, year: Number(e.target.value) })}>
            {yearOptions().map((y) => (
              <NativeSelectOption key={y} value={y}>
                {y}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        {data && <p className="pb-1.5 text-sm text-muted-foreground">{t('range', { from: f.date(data.period.from), to: f.date(data.period.to) })}</p>}
      </div>
      {exportError && (
        <div className="mb-4">
          <ErrorText>{errorMessage(exportError)}</ErrorText>
        </div>
      )}
      {report.isPending ? (
        <TableSkeleton columns={3} rows={8} />
      ) : report.error ? (
        <ErrorText>{errorMessage(report.error)}</ErrorText>
      ) : data ? (
        <div className="space-y-8">
          <ResultStrip
            data={data}
            carried={carried}
            fileDeduct25={deductAmount(deduct, data.indicators.find((i) => i.code === '24')?.amount ?? '0', data.paymentChecks.suggested25)}
            action={xmlButton}
          />
          <CarryForward data={data} text={carriedText} onChange={(text) => setCarriedEdit(text === null ? null : { period, text })} />
          <section>
            <h2 className="mb-2 text-base font-semibold text-foreground">{t('indicatorsTitle')}</h2>
            <DataTable numeric={[2]} head={[t('columns.indicator'), t('columns.description'), t('columns.amount')]}>
              {data.indicators.map((indicator) => (
                <TableRow key={indicator.code}>
                  <TableCell className="px-4 py-3 font-mono text-xs text-foreground">[{indicator.code}]</TableCell>
                  <TableCell className="px-4 py-3 text-muted-foreground">
                    {indicator.label}
                    {locale === 'en' && INDICATOR_GLOSS[indicator.code] && <span className="block text-xs text-subtle-foreground">{INDICATOR_GLOSS[indicator.code]}</span>}
                  </TableCell>
                  <TableCell className={`${NUM} font-medium text-foreground`}>{f.money(indicator.amount)}</TableCell>
                </TableRow>
              ))}
            </DataTable>
            <details className="mt-3 rounded-lg border border-border p-3" data-testid="vat-rules">
              <summary className="cursor-pointer text-sm font-medium text-foreground">{t('rules.title')}</summary>
              <p className="mt-2 text-xs text-subtle-foreground">{t('indicatorsNote')}</p>
              <p className="mt-1 text-xs text-subtle-foreground">{t('xmlNote')}</p>
              <label className="mt-2 block text-xs">
                <span className="text-subtle-foreground">{t('xmlDeduct')}</span>
                <NativeSelect aria-label={t('xmlDeduct')} className="mt-1 w-full max-w-md" value={deduct} onChange={(e) => setDeduct(e.target.value as DeductChoice)}>
                  {DEDUCT_CHOICES.map((c) => (
                    <NativeSelectOption key={c} value={c}>
                      {c === 'suggested' ? t('xmlDeductSuggested', { amount: f.money(data.paymentChecks.suggested25) }) : t(c === 'all' ? 'xmlDeductAll' : 'xmlDeductNone')}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </label>
              {deduct === 'suggested' && data.paymentChecks.unchecked > 0 && (
                <p className="mt-1 text-xs text-warning">{t('xmlDeductUnchecked', { count: data.paymentChecks.unchecked })}</p>
              )}
            </details>
            {!isZeroAmount(otherSales) && <p className="mt-2 text-sm text-warning">{t('otherSales', { amount: f.money(otherSales) })}</p>}
          </section>

          <FiledReturn
            key={`${data.period.period}:${entity.legalEntityId ?? ''}`}
            data={data}
            legalEntityId={entity.legalEntityId}
            carried={carried}
            deduct25={deductAmount(deduct, data.indicators.find((i) => i.code === '24')?.amount ?? '0', data.paymentChecks.suggested25)}
            canFile={data.filable ?? canMarkFiled(org.data?.role)}
          />

          <PaymentChecks data={data} canMark={canMarkPayment(org.data?.role)} legalEntityId={entity.legalEntityId} />

          <section>
            <h2 className="mb-2 text-base font-semibold text-foreground">{t('ratesTitle')}</h2>
            <DataTable
              numeric={[1, 2, 3, 4]}
              head={[t('columns.rate'), t('columns.outputTaxable'), t('columns.outputVat'), t('columns.inputTaxable'), t('columns.inputVat')]}
              foot={
                <TableRow>
                  <TableCell className="px-4 py-3 text-foreground">{t('total')}</TableCell>
                  <TableCell className={NUM}>{f.money(data.output.totals.taxable)}</TableCell>
                  <TableCell className={NUM}>{f.money(data.output.totals.vat)}</TableCell>
                  <TableCell className={NUM}>{f.money(data.input.totals.taxable)}</TableCell>
                  <TableCell className={NUM}>{f.money(data.input.totals.vat)}</TableCell>
                </TableRow>
              }>
              {rateRows.map(({ input, output }) => (
                <TableRow key={input.rate}>
                  <TableCell className="px-4 py-3 text-foreground">{t(`rates.${input.rate}`)}</TableCell>
                  <TableCell className={NUM}>{f.money(output?.taxable ?? '0')}</TableCell>
                  <TableCell className={NUM}>{f.money(output?.vat ?? '0')}</TableCell>
                  <TableCell className={NUM}>{f.money(input.taxable)}</TableCell>
                  <TableCell className={NUM}>{f.money(input.vat)}</TableCell>
                </TableRow>
              ))}
            </DataTable>
          </section>

          <section>
            <h2 className="mb-2 text-base font-semibold text-foreground">{t('outputTitle', { count: f.number(data.output.documents.length) })}</h2>
            {!data.output.available ? (
              <Empty title={t('outputUnavailable')} hint={t('outputUnavailableHint')} />
            ) : data.output.documents.length === 0 ? (
              <Empty title={t('emptyOutput')} hint={t('emptyOutputHint')} />
            ) : (
              <InvoiceTable invoices={data.output.documents} partyLabel={t('columns.buyer')} />
            )}
          </section>

          <LateSummary data={data} legalEntityId={entity.legalEntityId} ready={entity.ready} version={report.dataUpdatedAt} />

          <SupplementaryItems data={data} />

          <LateSales data={data} />

          <SalesNumberGaps period={period} legalEntityId={entity.legalEntityId} enabled={entity.ready && data.output.available} />

          <section>
            <h2 className="mb-2 text-base font-semibold text-foreground">{t('inputTitle', { count: f.number(data.input.documents.length) })}</h2>
            {data.input.documents.length === 0 ? (
              <Empty title={t('emptyInput')} hint={t('emptyInputHint')} />
            ) : (
              <InvoiceTable invoices={data.input.documents} partyLabel={t('columns.seller')} />
            )}
          </section>
        </div>
      ) : null}
    </>
  );
}
