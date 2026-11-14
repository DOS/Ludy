// SPDX-License-Identifier: AGPL-3.0-only
// The books of a household business (#2517, plan docs/plan/stock-and-marketplaces.md section 8.5), for a legal entity of kind household: its profile (tax group, PIT method, trades, e-invoice
// registration, the representative's name) as dated rows, the books Circular 152 asks of its method, and S1a-HKD, the sales listing, read from the ledger and downloaded as Excel. A household is
// never asked for an account or a book: the profile decides which books it sees. The law behind a book is data still waiting for the accountant (#2520) and the screen says so. Owners and admins
// change the profile; every role reads the books.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import { HOUSEHOLD_TRADES, vietnamToday, type HouseholdProfileSet } from '@crove/kernel-contract';
import { Alert, AlertDescription } from '@crove/ui/components/alert';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { TableCell, TableRow } from '@crove/ui/components/table';
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
        <DataTable numeric={[3]} head={[t('columns.date'), t('columns.reference'), t('columns.description'), t('columns.amount')]}>
          {book.data.rows.map((r) => (
            <TableRow key={r.entryId}>
              <TableCell className="px-4 py-3 text-muted-foreground">{f.date(r.date)}</TableCell>
              <TableCell className="px-4 py-3 font-mono text-xs">{r.reference ?? ''}</TableCell>
              <TableCell className="px-4 py-3 text-foreground">
                {r.description}
                {r.reversal && (
                  <Badge variant="secondary" className="ml-2">
                    {t('reversal')}
                  </Badge>
                )}
              </TableCell>
              <TableCell className="px-4 py-3 text-right tabular-nums">{f.money(r.amount)}</TableCell>
            </TableRow>
          ))}
          <TableRow>
            <TableCell className="px-4 py-3 font-medium text-foreground" colSpan={3}>
              {t('total')}
            </TableCell>
            <TableCell className="px-4 py-3 text-right font-medium tabular-nums" data-testid="household-s1a-total">
              {f.money(book.data.total)}
            </TableCell>
          </TableRow>
        </DataTable>
      )}
      {book.data && book.data.rows.length === 0 && <p className="mt-2 text-sm text-muted-foreground">{t('noRows')}</p>}
    </Card>
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
                {b.book !== 'S1a' && <span className="text-subtle-foreground"> {t('comingSoon')}</span>}
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
        </>
      )}
    </>
  );
}
