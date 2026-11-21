// SPDX-License-Identifier: AGPL-3.0-only
// The VAT card of marketplace sales in Settings (#4303 S3a, parent #2520): the method and rate an entity's marketplace sales carry, as dated rows. Owners and admins confirm the suggested schedule in one click or
// add a row; every member reads. Nothing is applied until a person saves it, and a change is a later row, never an edit. The sales posting (S3b) reads these rows; until a row covers a month, that month is
// held back with words instead of posted with a guessed rate. One rate per entity: a shop selling goods at different rates waits for the accountant.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import type { LegalEntity, MarketplaceVatRateRow } from '@ludy/kernel-contract';
import { Button } from '@ludy/ui/components/button';
import { Card } from '@ludy/ui/components/card';
import { Input } from '@ludy/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { ErrorText, RowsSkeleton } from '../components/ui.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { marketplaceCardShown } from '../lib/marketplace-connections.ts';
import { currentSchedule, draftProblem, draftToRow, rowInForce, showPercent, suggestedRows, suggestionOffered, type DraftRow, type SuggestMethod } from '../lib/marketplace-vat-rate.ts';
import type { Role } from '../lib/members.ts';

const refresh = async () => {
  await queryClient.invalidateQueries({ queryKey: orpc.marketplace.vatRates.list.key() });
};

// Today in Vietnam (the server's day), not UTC: before 07:00 local the UTC date is still yesterday.
const today = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

function RowText({ row }: { row: MarketplaceVatRateRow }) {
  const t = useTranslations('marketplaceVatRate');
  return <>{row.method === 'deduction' && row.vatPercent !== null ? t('rowDeduction', { percent: showPercent(row.vatPercent) }) : t('rowNone')}</>;
}

function Rows({ legalEntityId, entities, canManage }: { legalEntityId: string; entities: readonly LegalEntity[]; canManage: boolean }) {
  const t = useTranslations('marketplaceVatRate');
  const dateId = useId();
  const methodId = useId();
  const rateId = useId();
  const suggestId = useId();
  const rates = useQuery(orpc.marketplace.vatRates.list.queryOptions({ input: { legalEntityId } }));
  const set = useMutation(orpc.marketplace.vatRates.set.mutationOptions({ onSuccess: refresh }));
  const [draft, setDraft] = useState<DraftRow>({ effectiveFrom: '', method: 'deduction', vatPercent: '' });
  const [tried, setTried] = useState(false);
  const [suggestMethod, setSuggestMethod] = useState<SuggestMethod | ''>('');
  if (rates.isLoading) return <RowsSkeleton />;
  if (rates.error) return <ErrorText>{errorMessage(rates.error)}</ErrorText>;
  const entries = rates.data?.rows ?? [];
  const rows = currentSchedule(entries);
  const offered = suggestionOffered(entries);
  const suggestion = suggestedRows(entries, suggestMethod);
  const current = rowInForce(entries, today());
  const problem = tried ? draftProblem(draft) : null;
  const entityName = entities.find((e) => e.id === legalEntityId)?.name;
  const save = (next: readonly MarketplaceVatRateRow[]) => set.mutate({ legalEntityId, rows: [...next], idempotencyKey: crypto.randomUUID() });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (draftProblem(draft) !== null) return;
    // The form is cleared only once the server accepted the row, so a refusal leaves what was typed.
    set.mutate(
      { legalEntityId, rows: [draftToRow(draft)], idempotencyKey: crypto.randomUUID() },
      {
        onSuccess: () => {
          setDraft({ effectiveFrom: '', method: 'deduction', vatPercent: '' });
          setTried(false);
        },
      },
    );
  };
  return (
    <>
      {entityName && entities.length > 1 && <p className="mt-3 text-sm text-muted-foreground">{entityName}</p>}
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-subtle-foreground" data-testid="marketplace-vat-empty">
          {t('empty')}
        </p>
      ) : (
        <ul className="mt-3 divide-y" aria-label={t('rowsTitle')}>
          {rows.map((row) => (
            <li key={row.effectiveFrom} data-testid="marketplace-vat-row" className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
              <span className="tabular-nums text-muted-foreground">{t('from', { date: row.effectiveFrom })}</span>
              <span className={row.effectiveFrom === current?.effectiveFrom ? 'font-medium' : 'text-muted-foreground'}>
                <RowText row={row} />
              </span>
              {row.effectiveFrom === current?.effectiveFrom && <span className="text-xs text-muted-foreground">{t('inForce')}</span>}
            </li>
          ))}
        </ul>
      )}
      {canManage && offered && (
        <div className="mt-3 rounded-md border border-border p-3 text-sm" data-testid="marketplace-vat-suggestion">
          <p className="text-foreground">{t('suggestion')}</p>
          <label htmlFor={suggestId} className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
            {t('suggestMethodLabel')}
            <NativeSelect id={suggestId} className="min-h-11 min-w-48" value={suggestMethod} onChange={(e) => setSuggestMethod(e.target.value === 'deduction' ? 'deduction' : e.target.value === 'none' ? 'none' : '')}>
              <NativeSelectOption value="">{t('suggestMethodPick')}</NativeSelectOption>
              <NativeSelectOption value="deduction">{t('methodDeduction')}</NativeSelectOption>
              <NativeSelectOption value="none">{t('methodNone')}</NativeSelectOption>
            </NativeSelect>
          </label>
          {suggestion.length > 0 && (
            <ul className="mt-2 list-disc pl-5 text-muted-foreground">
              {suggestion.map((row) => (
                <li key={row.effectiveFrom}>
                  {t('from', { date: row.effectiveFrom })}: <RowText row={row} />
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1 text-xs text-muted-foreground">{t('suggestionNote')}</p>
          <Button type="button" className="mt-2 min-h-11" disabled={set.isPending || suggestion.length === 0} onClick={() => save(suggestion)}>
            {t('confirmSuggestion')}
          </Button>
        </div>
      )}
      {canManage && (
        <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={submit} aria-label={t('addTitle')} noValidate>
          <label htmlFor={dateId} className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('dateLabel')}
            <Input id={dateId} type="date" className="min-h-11 min-w-40" value={draft.effectiveFrom} onChange={(e) => setDraft({ ...draft, effectiveFrom: e.target.value })} />
          </label>
          <label htmlFor={methodId} className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('methodLabel')}
            <NativeSelect id={methodId} className="min-h-11 min-w-48" value={draft.method} onChange={(e) => setDraft({ ...draft, method: e.target.value === 'none' ? 'none' : 'deduction' })}>
              <NativeSelectOption value="deduction">{t('methodDeduction')}</NativeSelectOption>
              <NativeSelectOption value="none">{t('methodNone')}</NativeSelectOption>
            </NativeSelect>
          </label>
          {draft.method === 'deduction' && (
            <label htmlFor={rateId} className="flex flex-col gap-1 text-xs text-muted-foreground">
              {t('rateLabel')}
              <Input id={rateId} inputMode="decimal" className="min-h-11 w-28" value={draft.vatPercent} onChange={(e) => setDraft({ ...draft, vatPercent: e.target.value })} />
            </label>
          )}
          <Button type="submit" variant="outline" className="min-h-11" disabled={set.isPending}>
            {t('add')}
          </Button>
        </form>
      )}
      {problem && (
        <p role="alert" className="mt-2 text-sm text-destructive" data-testid="marketplace-vat-problem">
          {t(`problems.${problem}`)}
        </p>
      )}
      {set.error && <ErrorText>{errorMessage(set.error)}</ErrorText>}
      <p className="mt-3 text-xs text-muted-foreground">{t('oneRateNote')}</p>
    </>
  );
}

// The one line the closed card shows: where the rate stands, so a person sees it without opening the card.
function Status({ legalEntityId }: { legalEntityId: string }) {
  const t = useTranslations('marketplaceVatRate');
  const rates = useQuery(orpc.marketplace.vatRates.list.queryOptions({ input: { legalEntityId } }));
  if (!rates.data) return null;
  const current = rowInForce(rates.data.rows, today());
  return (
    <span role="status" className="text-sm text-muted-foreground" data-testid="marketplace-vat-status">
      {rates.data.rows.length === 0 ? t('statusNone') : current ? <RowText row={current} /> : t('statusLater')}
    </span>
  );
}

// Closed by default: a setting an owner touches once, so it takes one line of the Accounting tab until opened.
export function MarketplaceVatRateCard({ role }: { role: Role }) {
  const t = useTranslations('marketplaceVatRate');
  const headingId = useId();
  const canManage = role === 'owner' || role === 'admin';
  const providers = useQuery(orpc.marketplace.providers.queryOptions());
  const connections = useQuery(orpc.marketplace.connections.list.queryOptions());
  const entities = useQuery(orpc.legalEntities.list.queryOptions());
  const [chosen, setChosen] = useState('');
  const list = entities.data ?? [];
  const entity = list.find((e) => e.id === chosen) ?? list[0];
  // Only where marketplace sales can exist: an adapter is on or the org already has a connection.
  if (!marketplaceCardShown(providers.data?.adapters, connections.data)) return null;
  return (
    <Card role="group" aria-labelledby={headingId} className="block p-4">
      <details data-testid="marketplace-vat-card">
        <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-x-3 gap-y-1">
          <span id={headingId} className="text-sm font-medium text-muted-foreground">
            {t('title')}
          </span>
          {entity && <Status legalEntityId={entity.id} />}
        </summary>
        <p className="mt-2 text-sm text-muted-foreground">{t('intro')}</p>
        {entities.isLoading ? (
          <RowsSkeleton />
        ) : entities.error ? (
          <ErrorText>{errorMessage(entities.error)}</ErrorText>
        ) : entity ? (
          <>
            {list.length > 1 && (
              <NativeSelect aria-label={t('entity')} className="mt-3 min-h-11 min-w-48" value={entity.id} onChange={(e) => setChosen(e.target.value)}>
                {list.map((e) => (
                  <NativeSelectOption key={e.id} value={e.id}>
                    {e.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            )}
            <Rows key={entity.id} legalEntityId={entity.id} entities={list} canManage={canManage} />
          </>
        ) : null}
      </details>
    </Card>
  );
}
