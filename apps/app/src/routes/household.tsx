// SPDX-License-Identifier: AGPL-3.0-only
// The books of a household business (#2517, plan docs/plan/stock-and-marketplaces.md section 8.5), for a legal entity of kind household: its profile (tax group, PIT method, trades, e-invoice
// registration, the representative's name) as dated rows, the books Circular 152 asks of its method, S1a-HKD, the sales listing, read from the ledger and downloaded as Excel, and for a household
// that pays by a percentage of revenue the quarterly worksheet 01/CNKD (#2518): revenue by trade, VAT and PIT, the tax the platforms already withheld. A worksheet, never filed by Ludy. A household is
// never asked for an account or a book: the profile decides which books it sees. The law behind a book is data still waiting for the accountant (#2520) and the screen says so. Owners and admins
// change the profile; every role reads the books.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { HOUSEHOLD_EXPENSE_GROUPS, HOUSEHOLD_TRADES, vietnamToday, type HouseholdProfileSet, type HouseholdS2a, type HouseholdS2b, type HouseholdVatCut, type HouseholdYearToDate } from '@ludy/kernel-contract';
import { Alert, AlertDescription } from '@ludy/ui/components/alert';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Card } from '@ludy/ui/components/card';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { TableCell, TableRow } from '@ludy/ui/components/table';
import { DateInput } from '../components/date-input.tsx';
import { CardSkeleton, DataTable, Empty, ErrorText, PageHeader } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { apiFetch, client, errorMessage, getCurrentOrg, orpc, queryClient } from '../lib/api.ts';

type Kind = 'month' | 'quarter' | 'year';

// 'YYYY-MM', 'YYYY-Qn' or 'YYYY': the period of the ledger reports.
function periodOf(kind: Kind, month: string, quarter: string, year: string): string {
  if (kind === 'month') return month;
  if (kind === 'quarter') return `${year}-Q${quarter}`;
  return year;
}

function S1aBook({ entityId }: { entityId: string }) {
  const t = useTranslations('household');
  const f = useFormat();
  const today = vietnamToday();
  const [kind, setKind] = useState<Kind>('month');
  const [month, setMonth] = useState(today.slice(0, 7));
  const [year, setYear] = useState(today.slice(0, 4));
  const [quarter, setQuarter] = useState(String(Math.floor((Number(today.slice(5, 7)) - 1) / 3) + 1));
  const period = periodOf(kind, month, quarter, year);
  const valid = /^20\d{2}(-(0[1-9]|1[0-2]|Q[1-4]))?$/.test(period);
  const book = useQuery({ ...orpc.household.s1a.queryOptions({ input: { legalEntityId: entityId, period } }), enabled: valid });
  const download = useMutation({
    mutationFn: async () => {
      const response = await apiFetch(`/api/export/household-s1a.xlsx?legalEntityId=${encodeURIComponent(entityId)}&period=${encodeURIComponent(period)}`);
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = t('s1aFile', { period, org: getCurrentOrg() ?? 'org' });
      a.click();
      URL.revokeObjectURL(url);
    },
  });
  return (
    <Card className="mb-6 block p-4" data-testid="household-s1a">
      <h2 className="text-sm font-semibold text-foreground">{t('s1aTitle')}</h2>
      <p className="mb-3 text-sm text-muted-foreground">{t('s1aHint')}</p>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="household-kind">{t('periodKind')}</Label>
          <NativeSelect id="household-kind" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            <NativeSelectOption value="month">{t('kinds.month')}</NativeSelectOption>
            <NativeSelectOption value="quarter">{t('kinds.quarter')}</NativeSelectOption>
            <NativeSelectOption value="year">{t('kinds.year')}</NativeSelectOption>
          </NativeSelect>
        </div>
        {kind === 'month' && (
          <div className="space-y-1">
            <Label htmlFor="household-month">{t('kinds.month')}</Label>
            <DateInput id="household-month" kind="month" className="w-44" value={month} onChange={setMonth} />
          </div>
        )}
        {kind !== 'month' && (
          <div className="space-y-1">
            <Label htmlFor="household-year">{t('kinds.year')}</Label>
            <Input id="household-year" className="w-24" inputMode="numeric" maxLength={4} value={year} onChange={(e) => setYear(e.target.value)} />
          </div>
        )}
        {kind === 'quarter' && (
          <div className="space-y-1">
            <Label htmlFor="household-quarter">{t('kinds.quarter')}</Label>
            <NativeSelect id="household-quarter" value={quarter} onChange={(e) => setQuarter(e.target.value)}>
              {['1', '2', '3', '4'].map((q) => (
                <NativeSelectOption key={q} value={q}>{`Q${q}`}</NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        )}
        <Button variant="outline" loading={download.isPending} disabled={!book.data} onClick={() => download.mutate()} data-testid="household-s1a-download">
          {t('download')}
        </Button>
      </div>
      {book.isLoading && valid && <CardSkeleton />}
      {book.error && <ErrorText>{errorMessage(book.error)}</ErrorText>}
      {download.error && <ErrorText>{errorMessage(download.error)}</ErrorText>}
      {book.data && (
        <DataTable stickyFirstCol numeric={[3]} head={[t('columns.date'), t('columns.reference'), t('columns.description'), t('columns.amount')]}>
          {book.data.rows.map((r) => (
            <TableRow key={r.entryId}>
              <TableCell className="text-muted-foreground tabular-nums">{f.date(r.date)}</TableCell>
              <TableCell className="font-mono text-xs">{r.reference ?? ''}</TableCell>
              <TableCell className="text-foreground">
                {r.description}
                {r.reversal && (
                  <Badge variant="secondary" className="ml-2">
                    {t('reversal')}
                  </Badge>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">{f.money(r.amount)}</TableCell>
            </TableRow>
          ))}
          <TableRow>
            <TableCell className="font-medium text-foreground" colSpan={3}>
              {t('total')}
            </TableCell>
            <TableCell className="text-right font-medium tabular-nums" data-testid="household-s1a-total">
              {f.money(book.data.total)}
            </TableCell>
          </TableRow>
        </DataTable>
      )}
      {book.data && book.data.rows.length === 0 && <p className="mt-2 text-sm text-muted-foreground">{t('noRows')}</p>}
    </Card>
  );
}

// S2a-HKD (#2517 slice 2a), the revenue book of a household that pays by a percentage of revenue: S1a split by business line, then the VAT and PIT of each line by the percentages in force. Read from the
// ledger (the total is account 511's movement) and downloaded as Excel. A trade comes from what each entry is built from (a sale document's items); an entry with no item is "chưa phân ngành" and holds the
// tax total back, never guessed. While a row behind the figures is unconfirmed (#2520) every figure that depends on it carries "Số liệu tạm, kế toán chưa xác nhận tỷ lệ" and so does the Excel file; the
// label goes when the rows are confirmed, with no code change. Ludy files nothing.
function S2aBook({ entityId, variant = 'S2a' }: { entityId: string; variant?: 'S2a' | 'S2b' }) {
  const p = variant === 'S2a' ? 's2a' : 's2b';
  const withPit = variant === 'S2a';
  const t = useTranslations('household');
  const f = useFormat();
  const today = vietnamToday();
  const [kind, setKind] = useState<Kind>('month');
  const [month, setMonth] = useState(today.slice(0, 7));
  const [year, setYear] = useState(today.slice(0, 4));
  const [quarter, setQuarter] = useState(String(Math.floor((Number(today.slice(5, 7)) - 1) / 3) + 1));
  const period = periodOf(kind, month, quarter, year);
  const valid = /^20\d{2}(-(0[1-9]|1[0-2]|Q[1-4]))?$/.test(period);
  // The trade that takes the yearly deduction, asked of a household with several trades and never defaulted (#3710 slice 3).
  const [deductionTrade, setDeductionTrade] = useState('');
  const s2aQuery = useQuery({
    ...orpc.household.s2a.queryOptions({ input: { legalEntityId: entityId, period, ...(deductionTrade !== '' ? { deductionTrade: deductionTrade as (typeof HOUSEHOLD_TRADES)[number] } : {}) } }),
    enabled: valid && withPit,
    retry: false,
  });
  const s2bQuery = useQuery({ ...orpc.household.s2b.queryOptions({ input: { legalEntityId: entityId, period } }), enabled: valid && !withPit, retry: false });
  const book = withPit ? s2aQuery : s2bQuery;
  const download = useMutation({
    mutationFn: async () => {
      const response = await apiFetch(`/api/export/household-${p}.xlsx?legalEntityId=${encodeURIComponent(entityId)}&period=${encodeURIComponent(period)}${withPit && deductionTrade !== '' ? `&deductionTrade=${encodeURIComponent(deductionTrade)}` : ''}`);
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = t(withPit ? 's2aFile' : 's2bFile', { period, org: getCurrentOrg() ?? 'org' });
      a.click();
      URL.revokeObjectURL(url);
    },
  });
  // S2b has no PIT: its lines carry none, so the PIT columns are read only on S2a.
  const data = book.data as ((HouseholdS2a | HouseholdS2b) & { lines: Array<{ trade: string; revenue: string; vatPercent: string; vat: string; pitPercent?: string; pit?: string }>; totals: { revenue: string; vat: string; pit?: string; tax?: string } | null }) | undefined;
  const tradeName = (trade: string) => (trade === 'unassigned' ? t('unassignedName') : t(`tradeNames.${trade as (typeof HOUSEHOLD_TRADES)[number]}`));
  const provisional = data?.commentary ? (
    <span className="block text-xs text-muted-foreground" data-testid={`household-${p}-provisional`}>
      {t('cnkdProvisional')}
    </span>
  ) : null;
  const provisionalForReader = data?.commentary ? <span className="sr-only">{t('cnkdProvisional')}</span> : null;
  return (
    <Card className="mb-6 block p-4" data-testid={`household-${p}`}>
      <h2 className="text-sm font-semibold text-foreground">{t(withPit ? 's2aTitle' : 's2bTitle')}</h2>
      <p className="mb-3 text-sm text-muted-foreground">{t(withPit ? 's2aHint' : 's2bHint')}</p>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor={`${p}-kind`}>{t('periodKind')}</Label>
          <NativeSelect id={`${p}-kind`} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            <NativeSelectOption value="month">{t('kinds.month')}</NativeSelectOption>
            <NativeSelectOption value="quarter">{t('kinds.quarter')}</NativeSelectOption>
            <NativeSelectOption value="year">{t('kinds.year')}</NativeSelectOption>
          </NativeSelect>
        </div>
        {kind === 'month' && (
          <div className="space-y-1">
            <Label htmlFor={`${p}-month`}>{t('kinds.month')}</Label>
            <DateInput id={`${p}-month`} kind="month" className="w-44" value={month} onChange={setMonth} />
          </div>
        )}
        {kind !== 'month' && (
          <div className="space-y-1">
            <Label htmlFor={`${p}-year`}>{t('kinds.year')}</Label>
            <Input id={`${p}-year`} className="w-24" inputMode="numeric" maxLength={4} value={year} onChange={(e) => setYear(e.target.value)} />
          </div>
        )}
        {kind === 'quarter' && (
          <div className="space-y-1">
            <Label htmlFor={`${p}-quarter`}>{t('kinds.quarter')}</Label>
            <NativeSelect id={`${p}-quarter`} value={quarter} onChange={(e) => setQuarter(e.target.value)}>
              {['1', '2', '3', '4'].map((q) => (
                <NativeSelectOption key={q} value={q}>{`Q${q}`}</NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        )}
        <Button variant="outline" loading={download.isPending} disabled={!data} onClick={() => download.mutate()} data-testid={`household-${p}-download`}>
          {t('download')}
        </Button>
      </div>
      {book.isLoading && valid && <CardSkeleton />}
      {book.error && <ErrorText>{errorMessage(book.error)}</ErrorText>}
      {download.error && <ErrorText>{errorMessage(download.error)}</ErrorText>}
      {data && (
        <>
          <Alert className="mb-3" data-testid={`household-${p}-notice`}>
            <AlertDescription>{t('s2aNotice')}</AlertDescription>
          </Alert>
          {data.commentary && (
            <Alert className="mb-3" data-testid={`household-${p}-draft`}>
              <AlertDescription>
                {t('s2aDraft')}
                <ul className="mt-1 list-disc pl-5">
                  {data.unconfirmed.map((u) => (
                    <li key={`${u.kind}-${u.key}`}>{u.kind === 'form' ? t('cnkdUnconfirmedForm', { key: u.key, date: f.date(u.effectiveFrom) }) : u.kind === 'threshold' ? t('cnkdUnconfirmedThreshold', { date: f.date(u.effectiveFrom) }) : u.kind === 'reduction' ? t(u.key === 'pit' ? 'cnkdUnconfirmedPitReduction' : 'cnkdUnconfirmedReduction', { date: f.date(u.effectiveFrom) }) : t('cnkdUnconfirmedRate', { trade: tradeName(u.key), date: f.date(u.effectiveFrom) })}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}
          <DataTable stickyFirstCol numeric={[4]} head={[t('columns.date'), t('columns.reference'), t('columns.description'), t('s2aByLine'), t('columns.amount')]}>
            {data.rows.map((r) => (
              <TableRow key={r.entryId}>
                <TableCell className="text-muted-foreground tabular-nums">{f.date(r.date)}</TableCell>
                <TableCell className="font-mono text-xs">{r.reference ?? ''}</TableCell>
                <TableCell className="text-foreground">
                  {r.description}
                  {r.reversal && (
                    <Badge variant="secondary" className="ml-2">
                      {t('reversal')}
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {r.parts.map((pt) => (
                    <span key={pt.trade} className="block whitespace-nowrap" data-testid={`household-${p}-part-${pt.trade}`}>
                      {tradeName(pt.trade)}: {f.money(pt.amount)}
                    </span>
                  ))}
                </TableCell>
                <TableCell className="text-right tabular-nums">{f.money(r.amount)}</TableCell>
              </TableRow>
            ))}
            <TableRow>
              <TableCell className="font-medium text-foreground" colSpan={4}>
                {t('total')}
              </TableCell>
              <TableCell className="text-right font-medium tabular-nums" data-testid={`household-${p}-total`}>
                {f.money(data.total)}
              </TableCell>
            </TableRow>
          </DataTable>
          {data.rows.length === 0 && <p className="mt-2 text-sm text-muted-foreground">{t('noRows')}</p>}
          <h3 className="mb-1 mt-4 text-sm font-semibold text-foreground">{t(withPit ? 's2aLinesTitle' : 's2bLinesTitle')}</h3>
          <DataTable stickyFirstCol numeric={withPit ? [1, 2, 3, 4, 5] : [1, 2, 3]} head={[t('cnkdColumns.trade'), t('cnkdColumns.revenue'), t('cnkdColumns.vatPercent'), t('cnkdColumns.vat'), ...(withPit ? [t('cnkdColumns.pitPercent'), t('cnkdColumns.pit')] : [])]}>
            {data.lines.map((l) => (
              <TableRow key={l.trade}>
                <TableCell className="text-foreground">
                  {tradeName(l.trade)}
                  {provisional}
                </TableCell>
                <TableCell className="text-right tabular-nums">{f.money(l.revenue)}</TableCell>
                <TableCell className="text-right tabular-nums">{l.vatPercent}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {f.money(l.vat)}
                  {provisionalForReader}
                </TableCell>
                {withPit && <TableCell className="text-right tabular-nums">{l.pitPercent}</TableCell>}
                {withPit && (
                  <TableCell className="text-right tabular-nums">
                    {f.money(l.pit ?? '0')}
                    {provisionalForReader}
                  </TableCell>
                )}
              </TableRow>
            ))}
          </DataTable>
          {data.totals === null ? (
            <Alert className="mt-3" data-testid={`household-${p}-unassigned`}>
              <AlertDescription>{t('s2aUnassigned', { amount: f.money(data.unassignedGross) })}</AlertDescription>
            </Alert>
          ) : (
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm" data-testid={`household-${p}-totals`}>
              <dt className="text-subtle-foreground">{t(withPit ? 'cnkdTotalTax' : 's2bTotalVat')}</dt>
              <dd className="text-right font-medium tabular-nums">
                {f.money((withPit ? data.totals.tax : data.totals.vat) ?? '0')}
                {provisional}
              </dd>
            </dl>
          )}
          <VatCutNotes cut={data.vatCut} prefix={`household-${p}`} mark={provisional} />
          <YearToDateNotes ytd={data.yearToDate} prefix={`household-${p}-ytd`} mark={provisional} withPit={withPit} trades={data.lines.map((l) => l.trade)} picked={deductionTrade} onPick={setDeductionTrade} />
        </>
      )}
    </Card>
  );
}

// S2c-HKD (#2517 slice 2b), the revenue and expense detail of a household that pays PIT on income. Read from the ledger (revenue is account 511's movement; each expense line is a journal line on an expense account with
// its document, account and group) and downloaded as Excel. The group comes from the dated account-to-group rows; an account with no row shows as "chưa xếp nhóm" and holds the income back, never a guessed group. While a row behind
// the figures is unconfirmed (#2520) the expense and income figures carry "Số liệu tạm, kế toán chưa xác nhận tỷ lệ" and so does the Excel file; the label goes when the rows are confirmed, with no code change. The PIT is not
// computed. Ludy files nothing.
function S2cBook({ entityId }: { entityId: string }) {
  const t = useTranslations('household');
  const f = useFormat();
  const today = vietnamToday();
  const [kind, setKind] = useState<Kind>('month');
  const [month, setMonth] = useState(today.slice(0, 7));
  const [year, setYear] = useState(today.slice(0, 4));
  const [quarter, setQuarter] = useState(String(Math.floor((Number(today.slice(5, 7)) - 1) / 3) + 1));
  const period = periodOf(kind, month, quarter, year);
  const valid = /^20\d{2}(-(0[1-9]|1[0-2]|Q[1-4]))?$/.test(period);
  const book = useQuery({ ...orpc.household.s2c.queryOptions({ input: { legalEntityId: entityId, period } }), enabled: valid, retry: false });
  const download = useMutation({
    mutationFn: async () => {
      const response = await apiFetch(`/api/export/household-s2c.xlsx?legalEntityId=${encodeURIComponent(entityId)}&period=${encodeURIComponent(period)}`);
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = t('s2cFile', { period, org: getCurrentOrg() ?? 'org' });
      a.click();
      URL.revokeObjectURL(url);
    },
  });
  const data = book.data;
  const groupName = (group: string | null) => (group === null ? t('unmappedGroupName') : t(`groupNames.${group as keyof typeof EXPENSE_GROUP_KEYS}`));
  const provisional = data?.commentary ? (
    <span className="block text-xs text-muted-foreground" data-testid="household-s2c-provisional">
      {t('cnkdProvisional')}
    </span>
  ) : null;
  const provisionalForReader = data?.commentary ? <span className="sr-only">{t('cnkdProvisional')}</span> : null;
  return (
    <Card className="mb-6 block p-4" data-testid="household-s2c">
      <h2 className="text-sm font-semibold text-foreground">{t('s2cTitle')}</h2>
      <p className="mb-3 text-sm text-muted-foreground">{t('s2cHint')}</p>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="s2c-kind">{t('periodKind')}</Label>
          <NativeSelect id="s2c-kind" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            <NativeSelectOption value="month">{t('kinds.month')}</NativeSelectOption>
            <NativeSelectOption value="quarter">{t('kinds.quarter')}</NativeSelectOption>
            <NativeSelectOption value="year">{t('kinds.year')}</NativeSelectOption>
          </NativeSelect>
        </div>
        {kind === 'month' && (
          <div className="space-y-1">
            <Label htmlFor="s2c-month">{t('kinds.month')}</Label>
            <DateInput id="s2c-month" kind="month" className="w-44" value={month} onChange={setMonth} />
          </div>
        )}
        {kind !== 'month' && (
          <div className="space-y-1">
            <Label htmlFor="s2c-year">{t('kinds.year')}</Label>
            <Input id="s2c-year" className="w-24" inputMode="numeric" maxLength={4} value={year} onChange={(e) => setYear(e.target.value)} />
          </div>
        )}
        {kind === 'quarter' && (
          <div className="space-y-1">
            <Label htmlFor="s2c-quarter">{t('kinds.quarter')}</Label>
            <NativeSelect id="s2c-quarter" value={quarter} onChange={(e) => setQuarter(e.target.value)}>
              {['1', '2', '3', '4'].map((q) => (
                <NativeSelectOption key={q} value={q}>{`Q${q}`}</NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        )}
        <Button variant="outline" loading={download.isPending} disabled={!data} onClick={() => download.mutate()} data-testid="household-s2c-download">
          {t('download')}
        </Button>
      </div>
      {book.isLoading && valid && <CardSkeleton />}
      {book.error && <ErrorText>{errorMessage(book.error)}</ErrorText>}
      {download.error && <ErrorText>{errorMessage(download.error)}</ErrorText>}
      {data && (
        <>
          <Alert className="mb-3" data-testid="household-s2c-notice">
            <AlertDescription>{t('s2cNotice')}</AlertDescription>
          </Alert>
          {data.commentary && (
            <Alert className="mb-3" data-testid="household-s2c-draft">
              <AlertDescription>
                {t('s2cDraft')}
                <ul className="mt-1 list-disc pl-5">
                  {data.unconfirmed.map((u) => (
                    <li key={`${u.kind}-${u.key}`}>{u.kind === 'form' ? t('cnkdUnconfirmedForm', { key: u.key, date: f.date(u.effectiveFrom) }) : t('s2cUnconfirmedGroup', { key: u.key, date: f.date(u.effectiveFrom) })}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}
          <h3 className="mb-1 text-sm font-semibold text-foreground">{t('s2cRevenueTitle')}</h3>
          <DataTable stickyFirstCol numeric={[3]} head={[t('columns.date'), t('columns.reference'), t('columns.description'), t('columns.amount')]}>
            {data.revenueRows.map((r) => (
              <TableRow key={r.entryId}>
                <TableCell className="text-muted-foreground tabular-nums">{f.date(r.date)}</TableCell>
                <TableCell className="font-mono text-xs">{r.reference ?? ''}</TableCell>
                <TableCell className="text-foreground">
                  {r.description}
                  {r.reversal && (
                    <Badge variant="secondary" className="ml-2">
                      {t('reversal')}
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">{f.money(r.amount)}</TableCell>
              </TableRow>
            ))}
            <TableRow>
              <TableCell className="font-medium text-foreground" colSpan={3}>
                {t('total')}
              </TableCell>
              <TableCell className="text-right font-medium tabular-nums" data-testid="household-s2c-revenue-total">
                {f.money(data.revenue)}
              </TableCell>
            </TableRow>
          </DataTable>
          {data.revenueRows.length === 0 && <p className="mt-2 text-sm text-muted-foreground">{t('noRows')}</p>}
          <h3 className="mb-1 mt-4 text-sm font-semibold text-foreground">{t('s2cExpenseTitle')}</h3>
          <DataTable stickyFirstCol numeric={[5]} head={[t('columns.date'), t('columns.reference'), t('columns.description'), t('s2cColumns.account'), t('s2cColumns.group'), t('columns.amount')]}>
            {data.expenseRows.map((r) => (
              <TableRow key={`${r.entryId}-${r.lineNo}`}>
                <TableCell className="text-muted-foreground tabular-nums">{f.date(r.date)}</TableCell>
                <TableCell className="font-mono text-xs">{r.reference ?? ''}</TableCell>
                <TableCell className="text-foreground">
                  {r.description}
                  {r.reversal && (
                    <Badge variant="secondary" className="ml-2">
                      {t('reversal')}
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs">{r.accountCode}</TableCell>
                <TableCell className="text-xs text-muted-foreground" data-testid={`household-s2c-group-${r.group ?? 'unmapped'}`}>
                  {groupName(r.group)}
                </TableCell>
                <TableCell className="text-right tabular-nums">{f.money(r.amount)}</TableCell>
              </TableRow>
            ))}
          </DataTable>
          {data.expenseRows.length === 0 && <p className="mt-2 text-sm text-muted-foreground">{t('s2cNoExpenses')}</p>}
          <h3 className="mb-1 mt-4 text-sm font-semibold text-foreground">{t('s2cGroupsTitle')}</h3>
          <DataTable numeric={[1]} head={[t('s2cColumns.group'), t('columns.amount')]}>
            {data.groups.map((g) => (
              <TableRow key={g.group}>
                <TableCell className="text-foreground">
                  {groupName(g.group)}
                  {provisional}
                </TableCell>
                <TableCell className="text-right tabular-nums" data-testid={`household-s2c-group-total-${g.group}`}>
                  {f.money(g.amount)}
                  {provisionalForReader}
                </TableCell>
              </TableRow>
            ))}
          </DataTable>
          {data.unmappedGross !== '0' && (
            <Alert className="mt-3" data-testid="household-s2c-unmapped">
              <AlertDescription>{t('s2cUnmapped', { amount: f.money(data.unmappedGross) })}</AlertDescription>
            </Alert>
          )}
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm" data-testid="household-s2c-totals">
            <dt className="text-subtle-foreground">{t('s2cExpenseTotal')}</dt>
            <dd className="text-right font-medium tabular-nums" data-testid="household-s2c-expense-total">
              {f.money(data.expenseTotal)}
              {provisional}
            </dd>
            <dt className="font-medium text-foreground">{t('s2cIncome')}</dt>
            <dd className="text-right font-medium tabular-nums" data-testid="household-s2c-income">
              {data.income === null ? '' : f.money(data.income)}
              {provisional}
            </dd>
          </dl>
        </>
      )}
    </Card>
  );
}

// S2e-HKD (#2517 slice 2e), the cash and bank book of a household that pays PIT on income. Read from the ledger: one section per account of 111 and 112 with the opening balance, each line (cash in, cash out, the
// other account, the running balance) and the closing balance; the total equals the ledger. A negative balance is shown and flagged. While the layout row is unconfirmed (#2520) the figures and the Excel file carry
// "Số liệu tạm, kế toán chưa xác nhận bố cục sổ"; the label goes when the row is confirmed, with no code change. Ludy files nothing.
function S2eBook({ entityId }: { entityId: string }) {
  const t = useTranslations('household');
  const f = useFormat();
  const today = vietnamToday();
  const [kind, setKind] = useState<Kind>('month');
  const [month, setMonth] = useState(today.slice(0, 7));
  const [year, setYear] = useState(today.slice(0, 4));
  const [quarter, setQuarter] = useState(String(Math.floor((Number(today.slice(5, 7)) - 1) / 3) + 1));
  const period = periodOf(kind, month, quarter, year);
  const valid = /^20\d{2}(-(0[1-9]|1[0-2]|Q[1-4]))?$/.test(period);
  const book = useQuery({ ...orpc.household.s2e.queryOptions({ input: { legalEntityId: entityId, period } }), enabled: valid, retry: false });
  const download = useMutation({
    mutationFn: async () => {
      const response = await apiFetch(`/api/export/household-s2e.xlsx?legalEntityId=${encodeURIComponent(entityId)}&period=${encodeURIComponent(period)}`);
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = t('s2eFile', { period, org: getCurrentOrg() ?? 'org' });
      a.click();
      URL.revokeObjectURL(url);
    },
  });
  const data = book.data;
  const provisional = data?.commentary ? (
    <span className="block text-xs text-muted-foreground" data-testid="household-s2e-provisional">
      {t('layoutProvisional')}
    </span>
  ) : null;
  return (
    <Card className="mb-6 block p-4" data-testid="household-s2e">
      <h2 className="text-sm font-semibold text-foreground">{t('s2eTitle')}</h2>
      <p className="mb-3 text-sm text-muted-foreground">{t('s2eHint')}</p>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="s2e-kind">{t('periodKind')}</Label>
          <NativeSelect id="s2e-kind" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            <NativeSelectOption value="month">{t('kinds.month')}</NativeSelectOption>
            <NativeSelectOption value="quarter">{t('kinds.quarter')}</NativeSelectOption>
            <NativeSelectOption value="year">{t('kinds.year')}</NativeSelectOption>
          </NativeSelect>
        </div>
        {kind === 'month' && (
          <div className="space-y-1">
            <Label htmlFor="s2e-month">{t('kinds.month')}</Label>
            <DateInput id="s2e-month" kind="month" className="w-44" value={month} onChange={setMonth} />
          </div>
        )}
        {kind !== 'month' && (
          <div className="space-y-1">
            <Label htmlFor="s2e-year">{t('kinds.year')}</Label>
            <Input id="s2e-year" className="w-24" inputMode="numeric" maxLength={4} value={year} onChange={(e) => setYear(e.target.value)} />
          </div>
        )}
        {kind === 'quarter' && (
          <div className="space-y-1">
            <Label htmlFor="s2e-quarter">{t('kinds.quarter')}</Label>
            <NativeSelect id="s2e-quarter" value={quarter} onChange={(e) => setQuarter(e.target.value)}>
              {['1', '2', '3', '4'].map((q) => (
                <NativeSelectOption key={q} value={q}>{`Q${q}`}</NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        )}
        <Button variant="outline" loading={download.isPending} disabled={!data} onClick={() => download.mutate()} data-testid="household-s2e-download">
          {t('download')}
        </Button>
      </div>
      {book.isLoading && valid && <CardSkeleton />}
      {book.error && <ErrorText>{errorMessage(book.error)}</ErrorText>}
      {download.error && <ErrorText>{errorMessage(download.error)}</ErrorText>}
      {data && (
        <>
          <Alert className="mb-3" data-testid="household-s2e-notice">
            <AlertDescription>{t('s2eNotice')}</AlertDescription>
          </Alert>
          {data.commentary && (
            <Alert className="mb-3" data-testid="household-s2e-draft">
              <AlertDescription>
                {t('s2eDraft')}
                <ul className="mt-1 list-disc pl-5">
                  {data.unconfirmed.map((u) => (
                    <li key={`${u.kind}-${u.key}`}>{t('cnkdUnconfirmedForm', { key: u.key, date: f.date(u.effectiveFrom) })}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}
          {data.accounts.map((a) => (
            <div key={a.accountCode} className="mb-4" data-testid={`household-s2e-account-${a.accountCode}`}>
              <h3 className="mb-1 text-sm font-semibold text-foreground">
                {t('s2eAccount', { code: a.accountCode })}
                {a.accountName ? ` - ${a.accountName}` : ''}
              </h3>
              <DataTable stickyFirstCol numeric={[4, 5, 6]} head={[t('columns.date'), t('columns.reference'), t('columns.description'), t('s2eColumns.counter'), t('s2eColumns.in'), t('s2eColumns.out'), t('s2eColumns.balance')]}>
                <TableRow>
                  <TableCell className="font-medium text-foreground" colSpan={6}>
                    {t('s2eOpening')}
                  </TableCell>
                  <TableCell className="text-right tabular-nums" data-testid={`household-s2e-opening-${a.accountCode}`}>
                    {f.money(a.opening)}
                  </TableCell>
                </TableRow>
                {a.rows.map((r) => (
                  <TableRow key={`${r.entryId}-${r.lineNo}`}>
                    <TableCell className="text-muted-foreground tabular-nums">{f.date(r.date)}</TableCell>
                    <TableCell className="font-mono text-xs">{r.reference ?? ''}</TableCell>
                    <TableCell className="text-foreground">
                      {r.description}
                      {r.reversal && (
                        <Badge variant="secondary" className="ml-2">
                          {t('reversal')}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{r.counterAccounts.join(', ')}</TableCell>
                    <TableCell className="text-right tabular-nums">{f.money(r.cashIn)}</TableCell>
                    <TableCell className="text-right tabular-nums">{f.money(r.cashOut)}</TableCell>
                    <TableCell className="text-right tabular-nums">{f.money(r.balance)}</TableCell>
                  </TableRow>
                ))}
                <TableRow>
                  <TableCell className="font-medium text-foreground" colSpan={4}>
                    {t('s2eTotals')}
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{f.money(a.totalIn)}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{f.money(a.totalOut)}</TableCell>
                  <TableCell />
                </TableRow>
                <TableRow>
                  <TableCell className="font-medium text-foreground" colSpan={6}>
                    {t('s2eClosing')}
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums" data-testid={`household-s2e-closing-${a.accountCode}`}>
                    {f.money(a.closing)}
                    {provisional}
                  </TableCell>
                </TableRow>
              </DataTable>
              {a.negative && (
                <Alert className="mt-2" data-testid={`household-s2e-negative-${a.accountCode}`}>
                  <AlertDescription>{t('s2eNegative')}</AlertDescription>
                </Alert>
              )}
            </div>
          ))}
          {data.accounts.length === 0 && <p className="mt-2 text-sm text-muted-foreground">{t('s2eNoAccounts')}</p>}
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm" data-testid="household-s2e-totals">
            <dt className="text-subtle-foreground">{t('s2eAllAccounts')}: {t('s2eOpening')}</dt>
            <dd className="text-right tabular-nums" data-testid="household-s2e-total-opening">
              {f.money(data.totals.opening)}
            </dd>
            <dt className="font-medium text-foreground">{t('s2eAllAccounts')}: {t('s2eClosing')}</dt>
            <dd className="text-right font-medium tabular-nums" data-testid="household-s2e-total-closing">
              {f.money(data.totals.closing)}
              {provisional}
            </dd>
          </dl>
        </>
      )}
    </Card>
  );
}

// S2d-HKD (#2517 slice 2d), the goods book of a household that pays PIT on income: per item the quantity and value in, out and on hand for ONE month, read from the stock data of #2513 (the same figures as the Nhập xuất
// tồn report). A month that is not closed says the cost is provisional; while the layout row is unconfirmed (#2520) the figures and the Excel file carry "Số liệu tạm, kế toán chưa xác nhận bố cục sổ". Ludy files nothing.
function S2dBook({ entityId }: { entityId: string }) {
  const t = useTranslations('household');
  const ts = useTranslations('stock');
  const f = useFormat();
  const [month, setMonth] = useState(vietnamToday().slice(0, 7));
  const valid = /^20\d{2}-(0[1-9]|1[0-2])$/.test(month);
  const book = useQuery({ ...orpc.household.s2d.queryOptions({ input: { legalEntityId: entityId, month } }), enabled: valid, retry: false });
  const download = useMutation({
    mutationFn: async () => {
      const response = await apiFetch(`/api/export/household-s2d.xlsx?legalEntityId=${encodeURIComponent(entityId)}&month=${encodeURIComponent(month)}`);
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = t('s2dFile', { month, org: getCurrentOrg() ?? 'org' });
      a.click();
      URL.revokeObjectURL(url);
    },
  });
  const data = book.data;
  const provisional = data?.commentary ? (
    <span className="block text-xs text-muted-foreground" data-testid="household-s2d-provisional">
      {t('layoutProvisional')}
    </span>
  ) : null;
  return (
    <Card className="mb-6 block p-4" data-testid="household-s2d">
      <h2 className="text-sm font-semibold text-foreground">{t('s2dTitle')}</h2>
      <p className="mb-3 text-sm text-muted-foreground">{t('s2dHint')}</p>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="s2d-month">{t('kinds.month')}</Label>
          <DateInput id="s2d-month" kind="month" className="w-44" value={month} onChange={setMonth} />
        </div>
        <Button variant="outline" loading={download.isPending} disabled={!data} onClick={() => download.mutate()} data-testid="household-s2d-download">
          {t('download')}
        </Button>
      </div>
      {book.isLoading && valid && <CardSkeleton />}
      {book.error && <ErrorText>{errorMessage(book.error)}</ErrorText>}
      {download.error && <ErrorText>{errorMessage(download.error)}</ErrorText>}
      {data && (
        <>
          <Alert className="mb-3" data-testid="household-s2d-notice">
            <AlertDescription>{t('s2dNotice')}</AlertDescription>
          </Alert>
          {!data.monthClosed && (
            <Alert className="mb-3" data-testid="household-s2d-open">
              <AlertDescription>{t('s2dOpen')}</AlertDescription>
            </Alert>
          )}
          {data.commentary && (
            <Alert className="mb-3" data-testid="household-s2d-draft">
              <AlertDescription>
                {t('s2dDraft')}
                <ul className="mt-1 list-disc pl-5">
                  {data.unconfirmed.map((u) => (
                    <li key={`${u.kind}-${u.key}`}>{t('cnkdUnconfirmedForm', { key: u.key, date: f.date(u.effectiveFrom) })}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}
          {data.items.map((item) => (
            <div key={item.itemId} className="mb-4" data-testid={`household-s2d-item-${item.code}`}>
              <h3 className="mb-1 text-sm font-semibold text-foreground">{`${item.code} - ${item.name} (${item.unit})`}</h3>
              <DataTable stickyFirstCol numeric={[3, 4, 5, 6]} head={[t('columns.date'), t('columns.reference'), t('columns.description'), t('s2dColumns.in'), t('s2dColumns.out'), t('s2dColumns.valueIn'), t('s2dColumns.balance')]}>
                <TableRow>
                  <TableCell className="font-medium text-foreground" colSpan={2}>
                    {t('s2dOpening')}
                  </TableCell>
                  <TableCell className="text-muted-foreground" colSpan={4}>
                    {t('s2dOpeningValue', { value: f.money(item.openingValue) })}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{item.openingQuantity}</TableCell>
                </TableRow>
                {item.rows.map((r) => (
                  <TableRow key={r.moveId}>
                    <TableCell className="text-muted-foreground tabular-nums">{f.date(r.date)}</TableCell>
                    <TableCell className="font-mono text-xs">{r.reference ?? ''}</TableCell>
                    <TableCell className="text-foreground">{ts(`sources.${r.source}`)}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.quantityIn}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.quantityOut}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.valueIn === null ? '' : f.money(r.valueIn)}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.balanceQuantity}</TableCell>
                  </TableRow>
                ))}
                <TableRow>
                  <TableCell className="font-medium text-foreground" colSpan={2}>
                    {t('s2dMonthTotals')}
                  </TableCell>
                  <TableCell className="text-muted-foreground" colSpan={4}>
                    {t('s2dTotalsLine', {
                      inQuantity: item.inQuantity,
                      inValue: f.money(item.inValue),
                      outQuantity: item.outQuantity,
                      outValue: f.money(item.outValue),
                      unitCost: item.unitCost === null ? '' : f.money(item.unitCost),
                    })}
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{item.closingQuantity}</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="font-medium text-foreground" colSpan={6}>
                    {t('s2dClosing')}
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums" data-testid={`household-s2d-closing-${item.code}`}>
                    {f.money(item.closingValue)}
                    {provisional}
                  </TableCell>
                </TableRow>
              </DataTable>
            </div>
          ))}
          {data.items.length === 0 && <p className="mt-2 text-sm text-muted-foreground">{t('s2dNoItems')}</p>}
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm" data-testid="household-s2d-totals">
            <dt className="text-subtle-foreground">{t('s2dTotalOpening')}</dt>
            <dd className="text-right tabular-nums">{f.money(data.totals.openingValue)}</dd>
            <dt className="text-subtle-foreground">{t('s2dTotalIn')}</dt>
            <dd className="text-right tabular-nums">{f.money(data.totals.inValue)}</dd>
            <dt className="text-subtle-foreground">{t('s2dTotalOut')}</dt>
            <dd className="text-right tabular-nums">{f.money(data.totals.outValue)}</dd>
            <dt className="font-medium text-foreground">{t('s2dTotalClosing')}</dt>
            <dd className="text-right font-medium tabular-nums" data-testid="household-s2d-total-closing">
              {f.money(data.totals.closingValue)}
              {provisional}
            </dd>
          </dl>
        </>
      )}
    </Card>
  );
}

// The keys of the expense groups' names, typed from the contract's list.
const EXPENSE_GROUP_KEYS = Object.fromEntries(HOUSEHOLD_EXPENSE_GROUPS.map((g) => [g, true])) as Record<(typeof HOUSEHOLD_EXPENSE_GROUPS)[number], true>;

const MONEY_INPUT = /^\d{1,16}(\.\d{1,4})?$/;
// A decimal string that is zero (the amounts are strings, never numbers).
const isZeroAmount = (value: string) => /^-?0+(\.0+)?$/.test(value);

// The yearly PIT finalization worksheet 02/CNKD-TNCN-QTT (#5285) of a household on the income method: the year's revenue and costs from the ledger and the rate of the revenue band, plus three amounts the
// household types for the ask only (the tax the platforms withheld [14], the tax prepaid in the year [15] and the revenue of platforms with no payment function [09c]: whole dong, never stored). A worksheet,
// never filed by Ludy: what the figures cannot know is held or said (holds, notes), and the 30% PIT cut, which the form has no line for, is shown before and after.
const WHOLE_DONG = /^\d{1,16}$/;
const isBadDong = (value: string) => value !== '' && !WHOLE_DONG.test(value);
// The lines whose figures depend on a rule (the rate, a cost group, the form) that may still wait for the accountant.
const QTT_RULE_LINES = new Set(['10', '10a', '10b', '10c', '10d', '10đ', '10e', '11', '12', '13', '17', '18', '19', '20']);
function QttReturn({ entityId }: { entityId: string }) {
  const t = useTranslations('household');
  const f = useFormat();
  const [year, setYear] = useState(vietnamToday().slice(0, 4));
  const [withheldText, setWithheldText] = useState('');
  const [prepaidText, setPrepaidText] = useState('');
  const [noPaymentText, setNoPaymentText] = useState('');
  const withheld = withheldText.trim();
  const prepaid = prepaidText.trim();
  const noPayment = noPaymentText.trim();
  const valid = /^20\d{2}$/.test(year) && Number(year) >= 2026;
  const bad = isBadDong(withheld) || isBadDong(prepaid) || isBadDong(noPayment);
  const sheet = useQuery({
    ...orpc.household.qtt.queryOptions({
      input: {
        legalEntityId: entityId,
        year: Number(year),
        ...(withheld !== '' && !isBadDong(withheld) ? { withheld } : {}),
        ...(prepaid !== '' && !isBadDong(prepaid) ? { prepaid } : {}),
        ...(noPayment !== '' && !isBadDong(noPayment) ? { noPaymentRevenue: noPayment } : {}),
      },
    }),
    enabled: valid && !bad,
    retry: false,
  });
  // A figure typed wrongly never leaves the last good answer on the screen: the figures would leave that amount out.
  const data = bad ? undefined : sheet.data;
  // The file is the worksheet as the screen shows it (the same typed amounts); a held worksheet has no file, and the server refuses it too.
  const download = useMutation({
    mutationFn: async () => {
      const query = new URLSearchParams({ legalEntityId: entityId, year });
      if (withheld !== '') query.set('withheld', withheld);
      if (prepaid !== '') query.set('prepaid', prepaid);
      if (noPayment !== '') query.set('noPaymentRevenue', noPayment);
      const response = await apiFetch(`/api/export/household-qtt.xlsx?${query.toString()}`);
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = t('qttFile', { year, org: getCurrentOrg() ?? 'org' });
      a.click();
      URL.revokeObjectURL(url);
    },
  });
  const provisional = (code: string, amount: string | null) =>
    data?.commentary && amount !== null && QTT_RULE_LINES.has(code) ? (
      <span className="block text-xs text-muted-foreground" data-testid="household-qtt-provisional">
        {t('cnkdProvisional')}
      </span>
    ) : null;
  const field = (id: string, label: string, value: string, set: (next: string) => void) => (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} className="w-56" inputMode="numeric" value={value} onChange={(e) => set(e.target.value)} aria-invalid={isBadDong(value.trim())} aria-describedby={isBadDong(value.trim()) ? 'qtt-amounts-error' : undefined} />
    </div>
  );
  const reduction = data?.reduction ?? null;
  return (
    <Card className="mb-6 block p-4" data-testid="household-qtt">
      <h2 className="text-sm font-semibold text-foreground">{t('qttTitle')}</h2>
      <p className="mb-3 text-sm text-muted-foreground">{t('qttHint')}</p>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="qtt-year">{t('kinds.year')}</Label>
          <Input id="qtt-year" className="w-24" inputMode="numeric" maxLength={4} value={year} onChange={(e) => setYear(e.target.value)} aria-invalid={!valid} />
        </div>
        <Button variant="outline" loading={download.isPending} disabled={!valid || !data || data.holds.length > 0 || bad} onClick={() => download.mutate()} data-testid="household-qtt-download">
          {t('download')}
        </Button>
      </div>
      {download.error && <ErrorText>{errorMessage(download.error)}</ErrorText>}
      <fieldset className="mb-3" data-testid="household-qtt-entered">
        <legend className="mb-1 text-xs text-subtle-foreground">{t('qttEntered')}</legend>
        <p className="mb-2 text-xs text-muted-foreground">{t('qttEnteredHint')}</p>
        {bad && (
          <p id="qtt-amounts-error" className="mb-2 text-xs text-destructive" role="alert" data-testid="household-qtt-invalid">
            {t('qttInvalid')}
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          {field('qtt-withheld', t('qttWithheld'), withheldText, setWithheldText)}
          {field('qtt-prepaid', t('qttPrepaid'), prepaidText, setPrepaidText)}
          {field('qtt-no-payment', t('qttNoPayment'), noPaymentText, setNoPaymentText)}
        </div>
      </fieldset>
      {sheet.isLoading && valid && !bad && <CardSkeleton />}
      {sheet.error && !bad && <ErrorText>{errorMessage(sheet.error)}</ErrorText>}
      {data && (
        <>
          <Alert className="mb-3" data-testid="household-qtt-notice">
            <AlertDescription>{t('cnkdNotice')}</AlertDescription>
          </Alert>
          {data.commentary && (
            <Alert className="mb-3" data-testid="household-qtt-draft">
              <AlertDescription>
                {t('qttDraft')}
                <ul className="mt-1 list-disc pl-5">
                  {data.unconfirmed.map((u) => (
                    <li key={`${u.kind}-${u.key}`}>
                      {u.kind === 'form'
                        ? t('cnkdUnconfirmedForm', { key: u.key, date: f.date(u.effectiveFrom) })
                        : u.kind === 'threshold'
                          ? t('cnkdUnconfirmedThreshold', { date: f.date(u.effectiveFrom) })
                          : u.kind === 'reduction'
                            ? t('cnkdUnconfirmedPitReduction', { date: f.date(u.effectiveFrom) })
                            : u.kind === 'rate'
                              ? t('qttUnconfirmedRate', { key: u.key, date: f.date(u.effectiveFrom) })
                              : t('s2cUnconfirmedGroup', { key: u.key, date: f.date(u.effectiveFrom) })}
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}
          {data.holds.map((hold) => (
            <Alert key={hold} className="mb-3" data-testid={`household-qtt-hold-${hold}`}>
              <AlertDescription>{t(`qttHolds.${hold}`, { amount: hold === 'unmapped_costs' ? f.money(data.unmappedCosts) : f.money(data.threshold) })}</AlertDescription>
            </Alert>
          ))}
          <p className="mb-2 text-sm text-muted-foreground">{t('qttPeriod', { year: String(data.period.year), from: f.date(data.period.from), to: f.date(data.period.to) })}</p>
          <DataTable stickyFirstCol numeric={[2]} head={[t('qttColumns.code'), t('qttColumns.label'), t('qttColumns.amount')]}>
            {data.lines.map((l) => (
              <TableRow key={l.code} data-testid={`household-qtt-line-${l.code}`}>
                <TableCell className="whitespace-nowrap text-foreground">{`[${l.code}]`}</TableCell>
                <TableCell className="text-foreground">{l.label}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {l.amount === null ? t('qttHeld') : l.code === '12' ? `${l.amount}%` : f.money(l.amount)}
                  {provisional(l.code, l.amount)}
                </TableCell>
              </TableRow>
            ))}
          </DataTable>
          {data.rate && <p className="mt-2 text-sm text-muted-foreground">{t('qttRate', { percent: data.rate.percent, over: f.money(data.rate.revenueOver) })}</p>}
          {reduction && (
            <section className="mt-4" data-testid="household-qtt-cut">
              <h3 className="text-sm font-semibold text-foreground">{t('qttCutTitle', { percent: reduction.percent })}</h3>
              <p className="mb-2 text-xs text-muted-foreground">{t('qttCutHint')}</p>
              {!reduction.applies && <p className="mb-2 text-sm text-foreground">{t('qttCutNotApplies', { ceiling: reduction.ceiling === null ? '' : f.money(reduction.ceiling) })}</p>}
              <DataTable numeric={[1, 2]} head={[t('qttCutColumns.item'), t('qttCutColumns.before'), t('qttCutColumns.after')]}>
                {(['tax', 'cut', 'payable', 'exempt', 'due', 'overpaid'] as const).map((row) => (
                  <TableRow key={row} data-testid={`household-qtt-cut-${row}`}>
                    <TableCell className="text-foreground">{t(`qttCutRows.${row}`)}</TableCell>
                    <TableCell className="text-right tabular-nums">{f.money(row === 'cut' ? '0' : reduction.before[row])}</TableCell>
                    <TableCell className="text-right tabular-nums">{f.money(row === 'cut' ? reduction.cut : reduction.after[row])}</TableCell>
                  </TableRow>
                ))}
              </DataTable>
            </section>
          )}
          <ul className="mt-3 list-disc pl-5 text-xs text-muted-foreground" data-testid="household-qtt-notes">
            {data.notes
              .filter((note) => !(note === 'reduction_not_in_form' && reduction))
              .map((note) => (
                <li key={note}>{t(`qttNotes.${note}`)}</li>
              ))}
          </ul>
        </>
      )}
    </Card>
  );
}

// The quarterly worksheet 01/CNKD (#2518): a household with one trade has all revenue on it; with several it types the split, which the screen keeps for the ask only and the server never stores.
// While a row behind the figures is unconfirmed (#2520) every figure that depends on it carries "Số liệu tạm, kế toán chưa xác nhận tỷ lệ" and the Excel file says the same; the label goes when the rows are
// confirmed, with no code change. Totals wait for every dong of revenue to have a trade.
function CnkdReturn({ entityId, trades }: { entityId: string; trades: readonly string[] }) {
  const t = useTranslations('household');
  const f = useFormat();
  const today = vietnamToday();
  const [year, setYear] = useState(today.slice(0, 4));
  const [quarter, setQuarter] = useState<1 | 2 | 3 | 4>((Math.floor((Number(today.slice(5, 7)) - 1) / 3) + 1) as 1 | 2 | 3 | 4);
  const [split, setSplit] = useState<Record<string, string>>({});
  const [splitBefore, setSplitBefore] = useState<Record<string, string>>({});
  const [deductionTrade, setDeductionTrade] = useState('');
  // The drafts belong to the period they were typed for: another year or quarter starts from empty (a split of Q3 sent for Q2 would assign revenue to the wrong trade).
  const changePeriod = (nextYear: string, nextQuarter: 1 | 2 | 3 | 4) => {
    setYear(nextYear);
    setQuarter(nextQuarter);
    setSplit({});
    setSplitBefore({});
  };
  // The ledger's revenue before the quarter, remembered for the period so the fields to split it stay mounted while the sheet recalculates or refuses a split.
  const [seenBefore, setSeenBefore] = useState<{ key: string; amount: string } | null>(null);
  const periodKey = `${year}-${quarter}`;
  const valid = /^20\d{2}$/.test(year) && Number(year) >= 2026;
  const parts = trades.length > 1 ? trades.filter((x) => MONEY_INPUT.test((split[x] ?? '').trim())).map((x) => ({ trade: x, revenue: (split[x] ?? '').trim() })) : [];
  const badSplit = trades.length > 1 && trades.some((x) => (split[x] ?? '').trim() !== '' && !MONEY_INPUT.test((split[x] ?? '').trim()));
  // The year's revenue before the quarter is split by trade only when the household has several trades and the quarter is not the first of the year.
  const askBefore = trades.length > 1 && quarter > 1;
  const partsBefore = askBefore ? trades.filter((x) => MONEY_INPUT.test((splitBefore[x] ?? '').trim())).map((x) => ({ trade: x, revenue: (splitBefore[x] ?? '').trim() })) : [];
  const badBefore = askBefore && trades.some((x) => (splitBefore[x] ?? '').trim() !== '' && !MONEY_INPUT.test((splitBefore[x] ?? '').trim()));
  type TradeRevenue = Array<{ trade: (typeof HOUSEHOLD_TRADES)[number]; revenue: string }>;
  const sheet = useQuery({
    ...orpc.household.cnkd.queryOptions({
      input: {
        legalEntityId: entityId,
        year: Number(year),
        quarter,
        ...(parts.length > 0 ? { split: parts as TradeRevenue } : {}),
        ...(partsBefore.length > 0 ? { splitBefore: partsBefore as TradeRevenue } : {}),
        ...(deductionTrade !== '' ? { deductionTrade: deductionTrade as (typeof HOUSEHOLD_TRADES)[number] } : {}),
      },
    }),
    enabled: valid,
    retry: false,
  });
  const download = useMutation({
    mutationFn: async () => {
      const query = new URLSearchParams({ legalEntityId: entityId, year, quarter: String(quarter) });
      if (parts.length > 0) query.set('split', parts.map((x) => `${x.trade}:${x.revenue}`).join(','));
      // The yearly rule's inputs travel with the file, as with the screen: the split before the quarter and the trade that takes the threshold deduction.
      if (partsBefore.length > 0) query.set('splitBefore', partsBefore.map((x) => `${x.trade}:${x.revenue}`).join(','));
      if (deductionTrade !== '') query.set('deductionTrade', deductionTrade);
      const response = await apiFetch(`/api/export/household-cnkd.xlsx?${query.toString()}`);
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = t('cnkdFile', { period: `${year}-Q${quarter}`, org: getCurrentOrg() ?? 'org' });
      a.click();
      URL.revokeObjectURL(url);
    },
  });
  const data = sheet.data;
  const dataBefore = data?.yearToDate.revenueBefore;
  useEffect(() => {
    if (dataBefore !== undefined) setSeenBefore({ key: periodKey, amount: dataBefore });
  }, [dataBefore, periodKey]);
  const beforeAmount = seenBefore && seenBefore.key === periodKey ? seenBefore.amount : (dataBefore ?? null);
  // The label under a figure that depends on the rows still waiting for the accountant; nothing once they are confirmed.
  const provisional = data?.commentary ? (
    <span className="block text-xs text-muted-foreground" data-testid="household-cnkd-provisional">
      {t('cnkdProvisional')}
    </span>
  ) : null;
  // The same words for a screen reader, in the VAT and PIT cells, so a person who reaches the amount directly hears them (the visible label is once per row, in the trade cell).
  const provisionalForReader = data?.commentary ? <span className="sr-only">{t('cnkdProvisional')}</span> : null;
  return (
    <Card className="mb-6 block p-4" data-testid="household-cnkd">
      <h2 className="text-sm font-semibold text-foreground">{t('cnkdTitle')}</h2>
      <p className="mb-3 text-sm text-muted-foreground">{t('cnkdHint')}</p>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="cnkd-year">{t('kinds.year')}</Label>
          <Input id="cnkd-year" className="w-24" inputMode="numeric" maxLength={4} value={year} onChange={(e) => changePeriod(e.target.value, quarter)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="cnkd-quarter">{t('kinds.quarter')}</Label>
          <NativeSelect id="cnkd-quarter" value={String(quarter)} onChange={(e) => changePeriod(year, Number(e.target.value) as 1 | 2 | 3 | 4)}>
            {['1', '2', '3', '4'].map((q) => (
              <NativeSelectOption key={q} value={q}>{`Q${q}`}</NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <Button variant="outline" loading={download.isPending} disabled={!data || data.totals === null} onClick={() => download.mutate()} data-testid="household-cnkd-download">
          {t('download')}
        </Button>
      </div>
      {trades.length > 1 && (
        <fieldset className="mb-3" data-testid="household-cnkd-split">
          <legend className="mb-1 text-xs text-subtle-foreground">{t('splitTitle')}</legend>
          <p className="mb-2 text-xs text-muted-foreground">{t('splitHint')}</p>
          {badSplit && (
            <p className="mb-2 text-xs text-destructive" role="alert" data-testid="household-cnkd-split-invalid">
              {t('splitInvalid')}
            </p>
          )}
          <div className="flex flex-wrap gap-3">
            {trades.map((x) => (
              <div key={x} className="space-y-1">
                <Label htmlFor={`cnkd-split-${x}`}>{t(`tradeNames.${x as (typeof HOUSEHOLD_TRADES)[number]}`)}</Label>
                <Input id={`cnkd-split-${x}`} className="w-40" inputMode="decimal" value={split[x] ?? ''} onChange={(e) => setSplit({ ...split, [x]: e.target.value })} />
              </div>
            ))}
          </div>
        </fieldset>
      )}
      {askBefore && beforeAmount !== null && !/^0+(\.0+)?$/.test(beforeAmount) && (
        <fieldset className="mb-3" data-testid="household-cnkd-split-before">
          <legend className="mb-1 text-xs text-subtle-foreground">{t('splitBeforeTitle')}</legend>
          <p className="mb-2 text-xs text-muted-foreground">{t('splitBeforeHint', { amount: f.money(beforeAmount) })}</p>
          {badBefore && (
            <p className="mb-2 text-xs text-destructive" role="alert" data-testid="household-cnkd-split-before-invalid">
              {t('splitInvalid')}
            </p>
          )}
          <div className="flex flex-wrap gap-3">
            {trades.map((x) => (
              <div key={x} className="space-y-1">
                <Label htmlFor={`cnkd-split-before-${x}`}>{t(`tradeNames.${x as (typeof HOUSEHOLD_TRADES)[number]}`)}</Label>
                <Input id={`cnkd-split-before-${x}`} className="w-40" inputMode="decimal" value={splitBefore[x] ?? ''} onChange={(e) => setSplitBefore({ ...splitBefore, [x]: e.target.value })} />
              </div>
            ))}
          </div>
        </fieldset>
      )}
      {sheet.isLoading && valid && <CardSkeleton />}
      {sheet.error && <ErrorText>{errorMessage(sheet.error)}</ErrorText>}
      {download.error && <ErrorText>{errorMessage(download.error)}</ErrorText>}
      {data && (
        <>
          <Alert className="mb-3" data-testid="household-cnkd-notice">
            <AlertDescription>{t('cnkdNotice')}</AlertDescription>
          </Alert>
          {data.commentary && (
            <Alert className="mb-3" data-testid="household-cnkd-draft">
              <AlertDescription>
                {t('cnkdDraft')}
                <ul className="mt-1 list-disc pl-5">
                  {data.unconfirmed.map((u) => (
                    <li key={`${u.kind}-${u.key}`}>{u.kind === 'form' ? t('cnkdUnconfirmedForm', { key: u.key, date: f.date(u.effectiveFrom) }) : u.kind === 'threshold' ? t('cnkdUnconfirmedThreshold', { date: f.date(u.effectiveFrom) }) : u.kind === 'reduction' ? t(u.key === 'pit' ? 'cnkdUnconfirmedPitReduction' : 'cnkdUnconfirmedReduction', { date: f.date(u.effectiveFrom) }) : t('cnkdUnconfirmedRate', { trade: t(`tradeNames.${u.key as (typeof HOUSEHOLD_TRADES)[number]}`), date: f.date(u.effectiveFrom) })}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}
          <p className="mb-2 text-sm text-muted-foreground">{t('cnkdPeriod', { from: f.date(data.period.from), to: f.date(data.period.to), revenue: f.money(data.revenue) })}</p>
          <DataTable stickyFirstCol numeric={[1, 2, 3, 4, 5]} head={[t('cnkdColumns.trade'), t('cnkdColumns.revenue'), t('cnkdColumns.vatPercent'), t('cnkdColumns.vat'), t('cnkdColumns.pitPercent'), t('cnkdColumns.pit')]}>
            {data.lines.map((l) => (
              <TableRow key={l.trade}>
                <TableCell className="text-foreground">
                  {t(`tradeNames.${l.trade}`)}
                  {provisional}
                </TableCell>
                <TableCell className="text-right tabular-nums">{f.money(l.revenue)}</TableCell>
                <TableCell className="text-right tabular-nums">{l.vatPercent}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {f.money(l.vat)}
                  {provisionalForReader}
                </TableCell>
                <TableCell className="text-right tabular-nums">{l.pitPercent}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {f.money(l.pit)}
                  {provisionalForReader}
                </TableCell>
              </TableRow>
            ))}
          </DataTable>
          {data.totals === null ? (
            <Alert className="mt-3" data-testid="household-cnkd-unassigned">
              <AlertDescription>{t('cnkdUnassigned', { amount: f.money(data.unassigned) })}</AlertDescription>
            </Alert>
          ) : (
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm" data-testid="household-cnkd-totals">
              <dt className="text-subtle-foreground">{t('cnkdTotalTax')}</dt>
              <dd className="tabular-nums" data-testid="household-cnkd-tax">
                {f.money(data.totals.tax)}
                {provisional}
              </dd>
              <dt className="text-subtle-foreground">{t('cnkdWithheld')}</dt>
              <dd className="tabular-nums" data-testid="household-cnkd-withheld">
                {f.money(data.withheld.total)}
              </dd>
              <dt className="font-medium text-foreground">{t('cnkdDue')}</dt>
              <dd className="font-medium tabular-nums" data-testid="household-cnkd-due">
                {data.due === null ? t('cnkdDuePending') : f.money(data.due)}
                {data.due === null ? null : provisional}
              </dd>
              {data.overpaid && data.overpaid !== '0' && (
                <>
                  <dt className="text-subtle-foreground">{t('cnkdOverpaid')}</dt>
                  <dd className="tabular-nums">
                    {f.money(data.overpaid)}
                    {provisional}
                  </dd>
                </>
              )}
            </dl>
          )}
          <VatCutNotes cut={data.vatCut} prefix="household-cnkd" mark={provisional} />
          <YearToDateNotes ytd={data.yearToDate} prefix="household-cnkd-ytd" mark={provisional} withPit trades={trades} picked={deductionTrade} onPick={setDeductionTrade} />
          <p className="mt-3 text-xs text-muted-foreground">{t('cnkdWithheldHint')}</p>
          {data.withheld.settlements.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-sm">
              {data.withheld.settlements.map((w) => (
                <li key={w.id}>{t('cnkdWithheldLine', { platform: w.platform, from: f.date(w.periodStart), to: f.date(w.periodEnd), amount: f.money(w.taxWithheld) })}</li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-muted-foreground">{t('cnkdExemptNote')}</p>
        </>
      )}
    </Card>
  );
}

// The Decree 174 VAT cut under the totals of a book (#3710): the cut and the VAT payable when the profile answered yes, and when it did not answer, what the VAT would be if the household were eligible.
function VatCutNotes({ cut, prefix, mark }: { cut: HouseholdVatCut; prefix: string; mark: ReactNode }) {
  const t = useTranslations('household');
  const f = useFormat();
  return (
    <>
      {cut.applied && cut.total && (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm" data-testid={`${prefix}-vatcut`}>
          <dt className="text-subtle-foreground">{t('vatCutLine', { percent: cut.percent })}</dt>
          <dd className="tabular-nums" data-testid={`${prefix}-vatcut-amount`}>
            {f.money(cut.total.cut)}
            {mark}
          </dd>
          <dt className="text-subtle-foreground">{t('vatCutPayable')}</dt>
          <dd className="tabular-nums" data-testid={`${prefix}-vatcut-payable`}>
            {f.money(cut.total.vatPayable)}
            {mark}
          </dd>
        </dl>
      )}
      {cut.ifEligible && (
        <Alert className="mt-3" data-testid={`${prefix}-vatcut-ask`}>
          <AlertDescription>
            {t('vatCutIfEligible', { vat: f.money(cut.ifEligible.vatPayable), cut: f.money(cut.ifEligible.cut) })}
            {mark}
          </AlertDescription>
        </Alert>
      )}
    </>
  );
}

// The yearly rule under the totals of a book (#3710 slice 3): tax is on the year-to-date revenue, nothing is owed up to the threshold, VAT is on all revenue above it and PIT only on the part above it. With several
// trades the household picks the trade that takes the deduction; until it does the PIT is held back (`payable` is null) and nothing is guessed. The income method (S2b) has no PIT and asks no deduction.
function YearToDateNotes({ ytd, prefix, mark, withPit, trades, picked, onPick }: { ytd: HouseholdYearToDate; prefix: string; mark: ReactNode; withPit: boolean; trades: readonly string[]; picked: string; onPick: (trade: string) => void }) {
  const t = useTranslations('household');
  const f = useFormat();
  const pay = ytd.payable;
  const amount = ytd.threshold ? f.money(ytd.threshold.amount) : '';
  return (
    <section className="mt-3" data-testid={prefix}>
      <h3 className="mb-1 text-sm font-semibold text-foreground">{t('ytdTitle', { year: String(ytd.year) })}</h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-subtle-foreground">{t('ytdRevenue')}</dt>
        <dd className="tabular-nums" data-testid={`${prefix}-revenue`}>
          {f.money(ytd.revenueToDate)}
        </dd>
        {ytd.threshold && (
          <>
            <dt className="text-subtle-foreground">{t('ytdThreshold')}</dt>
            <dd className="tabular-nums" data-testid={`${prefix}-threshold`}>
              {f.money(ytd.threshold.amount)}
            </dd>
          </>
        )}
      </dl>
      <p className="mt-1 text-sm text-muted-foreground" data-testid={`${prefix}-state`}>
        {ytd.crossed ? t(withPit ? 'ytdCrossed' : 'ytdCrossedVat') : t('ytdBelow')}
      </p>
      {withPit && (ytd.deductionNeeded || picked !== '') && (
        <div className="mt-2 space-y-1" data-testid={`${prefix}-deduction`}>
          <Label htmlFor={`${prefix}-deduction-trade`}>{t('ytdDeductionQuestion', { amount })}</Label>
          <NativeSelect id={`${prefix}-deduction-trade`} value={picked} onChange={(e) => onPick(e.target.value)}>
            <NativeSelectOption value="">{t('ytdDeductionNone')}</NativeSelectOption>
            {trades.map((x) => (
              <NativeSelectOption key={x} value={x}>
                {t(`tradeNames.${x as (typeof HOUSEHOLD_TRADES)[number]}`)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <p className="text-xs text-muted-foreground">{t('ytdDeductionHint', { amount })}</p>
        </div>
      )}
      {withPit && ytd.deductionShort && (
        <Alert className="mt-2" data-testid={`${prefix}-short`}>
          <AlertDescription>{t('ytdShort', { amount })}</AlertDescription>
        </Alert>
      )}
      {pay && (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm" data-testid={`${prefix}-payable`}>
          <dt className="text-subtle-foreground">{t('ytdVatPayable')}</dt>
          <dd className="tabular-nums" data-testid={`${prefix}-vat`}>
            {f.money(pay.vat)}
            {mark}
          </dd>
          {!isZeroAmount(pay.vatCut) && (
            <>
              <dt className="text-subtle-foreground">{t('ytdVatCut')}</dt>
              <dd className="tabular-nums" data-testid={`${prefix}-vatcut`}>
                {f.money(pay.vatCut)}
                {mark}
              </dd>
            </>
          )}
          {withPit && (
            <>
              <dt className="text-subtle-foreground">{t('ytdPitPayable')}</dt>
              <dd className="tabular-nums" data-testid={`${prefix}-pit`}>
                {f.money(pay.pit)}
                {mark}
              </dd>
            </>
          )}
          {withPit && ytd.pitCut && (ytd.pitCut.applied || !isZeroAmount(pay.pitCut)) && (
            <>
              <dt className="text-subtle-foreground">{t('ytdPitCut', { percent: ytd.pitCut.percent })}</dt>
              <dd className="tabular-nums" data-testid={`${prefix}-pitcut`}>
                {f.money(pay.pitCut)}
                {mark}
              </dd>
            </>
          )}
        </dl>
      )}
    </section>
  );
}

const GROUPS = [1, 2, 3] as const;

function ProfileForm({ entityId, onDone }: { entityId: string; onDone: () => void }) {
  const t = useTranslations('household');
  const [effectiveFrom, setEffectiveFrom] = useState(vietnamToday());
  const [taxGroup, setTaxGroup] = useState<1 | 2 | 3>(1);
  const [method, setMethod] = useState<'percentage' | 'income'>('percentage');
  const [trades, setTrades] = useState<string[]>(['goods']);
  const [einvoice, setEinvoice] = useState(false);
  const [vatCut, setVatCut] = useState<'' | 'yes' | 'no'>('');
  const [name, setName] = useState('');
  // One key per request is not needed: a profile row is refused when it repeats a date, so a retry cannot add a second one.
  const pitMethod: HouseholdProfileSet['pitMethod'] = taxGroup === 1 ? null : taxGroup === 3 ? 'income' : method;
  const save = useMutation({
    mutationFn: () =>
      client.household.profileSet({
        legalEntityId: entityId,
        effectiveFrom,
        taxGroup,
        pitMethod,
        trades: HOUSEHOLD_TRADES.filter((x) => trades.includes(x)),
        einvoiceRegistered: einvoice,
        representativeName: name.trim() === '' ? null : name.trim(),
        vatCutEligible: vatCut === '' ? null : vatCut,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      onDone();
    },
  });
  return (
    <form
      className="mt-3 space-y-3 border-t pt-3"
      data-testid="household-profile-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!save.isPending && trades.length > 0 && effectiveFrom !== '') save.mutate();
      }}
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="hh-from">{t('effectiveFrom')}</Label>
          <DateInput id="hh-from" className="w-44" value={effectiveFrom} onChange={setEffectiveFrom} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="hh-group">{t('taxGroup')}</Label>
          <NativeSelect id="hh-group" value={String(taxGroup)} onChange={(e) => setTaxGroup(Number(e.target.value) as 1 | 2 | 3)}>
            {GROUPS.map((g) => (
              <NativeSelectOption key={g} value={String(g)}>
                {t(`groups.group${g}`)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        {taxGroup === 2 && (
          <div className="space-y-1">
            <Label htmlFor="hh-method">{t('pitMethod')}</Label>
            <NativeSelect id="hh-method" value={method} onChange={(e) => setMethod(e.target.value as 'percentage' | 'income')}>
              <NativeSelectOption value="percentage">{t('methods.percentage')}</NativeSelectOption>
              <NativeSelectOption value="income">{t('methods.income')}</NativeSelectOption>
            </NativeSelect>
          </div>
        )}
      </div>
      <fieldset className="flex flex-wrap gap-4">
        <legend className="mb-1 text-xs text-subtle-foreground">{t('trades')}</legend>
        {HOUSEHOLD_TRADES.map((x) => (
          <label key={x} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={trades.includes(x)} onChange={(e) => setTrades(e.target.checked ? [...trades, x] : trades.filter((y) => y !== x))} />
            {t(`tradeNames.${x}`)}
          </label>
        ))}
      </fieldset>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={einvoice} onChange={(e) => setEinvoice(e.target.checked)} />
        {t('einvoice')}
      </label>
      <div className="space-y-1">
        <Label htmlFor="hh-vatcut">{t('vatCutQuestion')}</Label>
        <NativeSelect id="hh-vatcut" value={vatCut} onChange={(e) => setVatCut(e.target.value as '' | 'yes' | 'no')} data-testid="household-profile-vatcut">
          <NativeSelectOption value="">{t('vatCutAnswerNone')}</NativeSelectOption>
          <NativeSelectOption value="yes">{t('vatCutAnswerYes')}</NativeSelectOption>
          <NativeSelectOption value="no">{t('vatCutAnswerNo')}</NativeSelectOption>
        </NativeSelect>
        <p className="max-w-xl text-xs text-muted-foreground">{t('vatCutHint')}</p>
      </div>
      <div className="space-y-1">
        <Label htmlFor="hh-name">{t('representative')}</Label>
        <Input id="hh-name" className="max-w-sm" maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm" loading={save.isPending} data-testid="household-profile-save">
          {t('save')}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          {t('cancel')}
        </Button>
      </div>
      {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
    </form>
  );
}

function ProfileCard({ entityId, canEdit }: { entityId: string; canEdit: boolean }) {
  const t = useTranslations('household');
  const f = useFormat();
  const [editing, setEditing] = useState(false);
  const view = useQuery(orpc.household.profile.queryOptions({ input: { legalEntityId: entityId } }));
  const p = view.data?.profile ?? null;
  return (
    <Card className="mb-6 block p-4" data-testid="household-profile">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{t('profileTitle')}</h2>
          <p className="text-sm text-muted-foreground">{t('profileHint')}</p>
        </div>
        {canEdit && !editing && (
          <Button variant="outline" size="sm" onClick={() => setEditing(true)} data-testid="household-profile-edit">
            {p ? t('change') : t('set')}
          </Button>
        )}
      </div>
      {view.isLoading && <CardSkeleton />}
      {view.error && <ErrorText>{errorMessage(view.error)}</ErrorText>}
      {view.data && !p && <p className="mt-2 text-sm text-muted-foreground">{t('noProfile')}</p>}
      {p && (
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-subtle-foreground">{t('effectiveFrom')}</dt>
          <dd>{f.date(p.effectiveFrom)}</dd>
          <dt className="text-subtle-foreground">{t('taxGroup')}</dt>
          <dd>{p.taxGroup >= 1 && p.taxGroup <= 3 ? t(`groups.group${p.taxGroup as 1 | 2 | 3}`) : String(p.taxGroup)}</dd>
          {p.pitMethod && (
            <>
              <dt className="text-subtle-foreground">{t('pitMethod')}</dt>
              <dd>{t(`methods.${p.pitMethod}`)}</dd>
            </>
          )}
          <dt className="text-subtle-foreground">{t('trades')}</dt>
          <dd>{p.trades.map((x) => t(`tradeNames.${x}`)).join(', ')}</dd>
          <dt className="text-subtle-foreground">{t('einvoice')}</dt>
          <dd>{p.einvoiceRegistered ? t('yes') : t('no')}</dd>
          <dt className="text-subtle-foreground">{t('vatCutProfile')}</dt>
          <dd data-testid="household-profile-vatcut-answer">{p.vatCutEligible === 'yes' ? t('vatCutAnswerYes') : p.vatCutEligible === 'no' ? t('vatCutAnswerNo') : t('vatCutAnswerNone')}</dd>
          {p.representativeName && (
            <>
              <dt className="text-subtle-foreground">{t('representative')}</dt>
              <dd>{p.representativeName}</dd>
            </>
          )}
        </dl>
      )}
      {view.data && view.data.books.length > 0 && (
        <div className="mt-4" data-testid="household-books">
          <p className="text-xs font-medium text-muted-foreground">{t('booksTitle')}</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
            {view.data.books.map((b) => (
              <li key={b.book}>
                {b.name}
                {b.book !== 'S1a' && b.book !== 'S2a' && b.book !== 'S2b' && b.book !== 'S2c' && b.book !== 'S2d' && b.book !== 'S2e' && <span className="text-subtle-foreground"> {t('comingSoon')}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {view.data?.commentary && (
        <Alert className="mt-3" data-testid="household-commentary">
          <AlertDescription>{t('commentary')}</AlertDescription>
        </Alert>
      )}
      {editing && <ProfileForm entityId={entityId} onDone={() => setEditing(false)} />}
    </Card>
  );
}

export function HouseholdPage() {
  const t = useTranslations('household');
  const org = useQuery(orpc.org.get.queryOptions());
  const entities = useQuery(orpc.bookEntities.list.queryOptions());
  const households = useMemo(() => (entities.data ?? []).filter((e) => e.kind === 'household'), [entities.data]);
  const [picked, setPicked] = useState<string | null>(null);
  const entity = households.find((e) => e.id === picked) ?? households[0] ?? null;
  const canEdit = org.data?.role === 'owner' || org.data?.role === 'admin';
  const view = useQuery({ ...orpc.household.profile.queryOptions({ input: { legalEntityId: entity?.id ?? '' } }), enabled: entity !== null });
  const hasS1a = view.data?.books.some((b) => b.book === 'S1a') ?? false;
  const hasS2a = view.data?.books.some((b) => b.book === 'S2a') ?? false;
  const hasS2b = view.data?.books.some((b) => b.book === 'S2b') ?? false;
  const hasS2c = view.data?.books.some((b) => b.book === 'S2c') ?? false;
  const hasS2d = view.data?.books.some((b) => b.book === 'S2d') ?? false;
  const hasS2e = view.data?.books.some((b) => b.book === 'S2e') ?? false;
  // The quarterly worksheet is for the percentage method alone today (the income method and group 1 have no quarterly worksheet here).
  const cnkdTrades = view.data?.profile?.pitMethod === 'percentage' ? view.data.profile.trades : null;
  // The yearly finalization worksheet is for the income method alone (the percentage method files the quarterly 01/CNKD).
  const qttIncome = view.data?.profile?.pitMethod === 'income';
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      {entities.isLoading ? (
        <CardSkeleton />
      ) : entities.error ? (
        <ErrorText>{errorMessage(entities.error)}</ErrorText>
      ) : !entity ? (
        <Empty title={t('noHousehold')} hint={t('noHouseholdHint')} />
      ) : (
        <>
          {households.length > 1 && (
            <div className="mb-4 space-y-1">
              <Label htmlFor="household-entity">{t('entity')}</Label>
              <NativeSelect id="household-entity" className="w-80 max-w-full" value={entity.id} onChange={(e) => setPicked(e.target.value)}>
                {households.map((e) => (
                  <NativeSelectOption key={e.id} value={e.id}>
                    {e.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          )}
          <ProfileCard key={entity.id} entityId={entity.id} canEdit={canEdit} />
          {hasS1a && <S1aBook key={entity.id} entityId={entity.id} />}
          {hasS2a && <S2aBook key={entity.id} entityId={entity.id} />}
          {hasS2b && <S2aBook key={`${entity.id}-s2b`} entityId={entity.id} variant="S2b" />}
          {hasS2c && <S2cBook key={entity.id} entityId={entity.id} />}
          {hasS2d && <S2dBook key={`${entity.id}-s2d`} entityId={entity.id} />}
          {hasS2e && <S2eBook key={`${entity.id}-s2e`} entityId={entity.id} />}
          {cnkdTrades && <CnkdReturn key={entity.id} entityId={entity.id} trades={cnkdTrades} />}
          {qttIncome && <QttReturn key={`${entity.id}-qtt`} entityId={entity.id} />}
        </>
      )}
    </>
  );
}
