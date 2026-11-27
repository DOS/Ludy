// SPDX-License-Identifier: AGPL-3.0-only
// The unusual entries card on the Kế toán Tổng quan (#5182): for one ended month of the chosen legal entity, the posted entries that five rules found unusual (a repeat of an invoice, a manual voucher on a control
// account, an amount far from the usual, an account never used before, an entry keyed on a day off). Every hit and every figure comes from the books (finance.unusual_entries); the finance coworker's possible thing
// to look at per hit is read from the same read by the model and shown only when it came back, labelled as a possibility, so with AI off the list is the same and there is no gap and no notice. A hit is a place to
// look, not a finding: a person opens the voucher, and may mark the hit as reviewed (finance.unusual_entries.review, audited, it touches no ledger table).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import { UNUSUAL_NEW_ACCOUNT_MONTHS, vietnamToday, type FinanceUnusualEntries, type UnusualEntryHit } from '@ludy/kernel-contract';
import { Button, buttonVariants } from '@ludy/ui/components/button';
import { Card } from '@ludy/ui/components/card';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc } from '../lib/api.ts';
import { defaultMonth, pickerMonths } from '../lib/expense-variance.ts';
import { accountText, canReviewEntries, detailKind, noteFor } from '../lib/unusual-entries.ts';
import { ErrorText } from '../components/ui.tsx';

function HitRow({ hit, note, slug, canMark, legalEntityId }: { hit: UnusualEntryHit; note: string | undefined; slug: string; canMark: boolean; legalEntityId: string }) {
  const t = useTranslations('financeOverview.unusual');
  const f = useFormat();
  const queryClient = useQueryClient();
  const mark = useMutation({
    mutationFn: () => client.financeUnusualEntries.review({ legalEntityId, entryId: hit.entryId, rule: hit.rule }),
    // Only the read is invalidated: the notes are asked again by themselves when the hits change (one model call, not two), and the focus goes to the heading because the marked row leaves the list.
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: orpc.financeUnusualEntries.get.key() });
      document.getElementById('overview-unusual')?.focus();
    },
  });
  const kind = detailKind(hit);
  const detail =
    kind === 'duplicate'
      ? t('detail.duplicate', { number: hit.invoiceNumber ?? '', date: hit.otherEntryDate ? f.date(hit.otherEntryDate) : '' })
      : kind === 'control'
        ? t('detail.control', { account: hit.control ? t(`control.${hit.control}`) : accountText(hit) })
        : kind === 'amount'
          ? t('detail.amount', { groupAmount: f.money(hit.groupAmount ?? '0'), account: accountText(hit), usual: f.money(hit.usual ?? '0'), count: hit.historyCount ?? 0, ratio: f.decimal(hit.ratio ?? '0', 1) })
          : kind === 'newParty' || kind === 'newKind'
            ? t(`detail.${kind}`, { account: accountText(hit), months: UNUSUAL_NEW_ACCOUNT_MONTHS })
            : t(`detail.${kind}`, { date: f.date(hit.entryDate) });
  const date = f.date(hit.entryDate);
  return (
    <li className="border-b py-3" data-testid={`unusual-hit-${hit.rule}-${hit.entryId}`}>
      <p className="text-sm font-medium text-foreground">{t(`rules.${hit.rule}`)}</p>
      <p className="mt-0.5 text-xs text-subtle-foreground">
        {t('voucherOf', { date })} · {t(`sourceKind.${hit.sourceKind}`)}
        {hit.partyName ? ` · ${t('partyName', { name: hit.partyName })}` : ''}
      </p>
      {hit.description && <p className="mt-0.5 text-xs text-muted-foreground">{hit.description}</p>}
      <p className="mt-1 text-sm tabular-nums">
        <span className="text-xs text-subtle-foreground">{t('amountLabel')}: </span>
        {f.money(hit.amount)}
      </p>
      <p className="mt-1 text-sm text-foreground">{detail}</p>
      {note && (
        <div className="mt-2" data-testid={`unusual-note-${hit.rule}-${hit.entryId}`}>
          <p className="text-xs font-medium text-muted-foreground">{t('note.by')}</p>
          <p className="mt-0.5 text-sm text-foreground">{note}</p>
          <p className="mt-0.5 text-xs text-subtle-foreground">{t('note.caution')}</p>
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Link
          to="/o/$slug/journal"
          params={{ slug }}
          search={{ from: hit.entryDate, to: hit.entryDate }}
          hash={`entry-${hit.entryId}`}
          aria-label={t('openLabel', { date })}
          className={buttonVariants({ variant: 'outline', size: 'sm' }) + ' min-h-11 md:min-h-8'}
        >
          {t('open')}
        </Link>
        {canMark && (
          <Button type="button" size="sm" variant="outline" className="min-h-11 md:min-h-8" disabled={mark.isPending} aria-label={t('markLabel', { date })} onClick={() => mark.mutate()}>
            {mark.isPending ? t('marking') : t('mark')}
          </Button>
        )}
      </div>
      {mark.isError && <ErrorText>{t('markError')}</ErrorText>}
    </li>
  );
}

// The hits of a read, with the coworker's notes by hit key (none with AI off).
export function UnusualEntriesList({
  data,
  notes,
  slug,
  canMark,
}: {
  data: FinanceUnusualEntries;
  notes: ReadonlyArray<{ key: string; text: string }>;
  slug: string;
  canMark: boolean;
}) {
  const t = useTranslations('financeOverview.unusual');
  const f = useFormat();
  return (
    <>
      <p className="mb-2 text-xs text-subtle-foreground">{t('books', { regime: t(`regimes.${data.regime}`) })}</p>
      {data.empty ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : data.hits.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('none')}</p>
      ) : (
        <ul>
          {data.hits.map((hit) => (
            <HitRow key={`${hit.rule}:${hit.entryId}`} hit={hit} note={noteFor(notes, hit)} slug={slug} canMark={canMark} legalEntityId={data.legalEntityId} />
          ))}
        </ul>
      )}
      {data.moreHits > 0 && <p className="mt-2 text-xs text-subtle-foreground">{t('more', { count: data.moreHits })}</p>}
      {data.reviewed > 0 && <p className="mt-2 text-xs text-subtle-foreground">{t('reviewed', { count: data.reviewed })}</p>}
      <p className="mt-3 text-xs text-subtle-foreground">
        {t('threshold', {
          factor: data.thresholds.amountFactor,
          months: data.thresholds.historyMonths,
          history: data.thresholds.minHistory,
          minDiff: f.money(data.thresholds.amountMinDiff),
          offDay: f.money(data.thresholds.offDayMinAmount),
        })}
      </p>
      <p className="mt-1 text-xs text-subtle-foreground">{t('calendar')}</p>
    </>
  );
}

// The coworker's notes: none at all unless they came back used, so with AI off the card has no gap and no notice. `version` is when the hits on screen were read: the notes are asked again whenever they are, so
// they never sit beside hits they were not written from (the server keeps them by their facts, so asking again over the same hits costs no model call).
function useNotes(input: { month: string; legalEntityId?: string }, enabled: boolean, version: number) {
  const lang = useLocale() === 'en' ? 'en' : 'vi';
  const base = orpc.financeUnusualEntries.explain.queryOptions({ input: { ...input, lang } });
  const explain = useQuery({ ...base, queryKey: [...base.queryKey, version], enabled, staleTime: Infinity, retry: false });
  return explain.data?.ai === 'used' ? explain.data.notes : [];
}

export function UnusualEntriesCard({ slug, legalEntityId, ready }: { slug: string; legalEntityId?: string | undefined; ready: boolean }) {
  const t = useTranslations('financeOverview.unusual');
  const today = vietnamToday();
  const [month, setMonth] = useState(() => defaultMonth(today));
  const input = { month, ...(legalEntityId ? { legalEntityId } : {}) };
  const read = useQuery({ ...orpc.financeUnusualEntries.get.queryOptions({ input }), enabled: ready });
  const org = useQuery(orpc.org.get.queryOptions());
  const data = read.data;
  const notes = useNotes(input, ready && data !== undefined && data.hits.length > 0, read.dataUpdatedAt);
  return (
    <section aria-labelledby="overview-unusual" className="mt-8" data-testid="unusual-entries">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="overview-unusual" tabIndex={-1} className="text-sm font-semibold outline-none">
            {t('title')}
          </h2>
          <p className="mt-1 text-xs text-subtle-foreground">{t('subtitle')}</p>
        </div>
        <label className="flex items-center gap-2 text-xs text-subtle-foreground">
          <span className="whitespace-nowrap">{t('month.label')}</span>
          <NativeSelect className="min-h-11 w-40 md:min-h-8" value={month} onChange={(e) => setMonth(e.target.value)}>
            {pickerMonths(today).map((m) => (
              <NativeSelectOption key={m} value={m}>
                {t('month.option', { month: m.slice(5), year: m.slice(0, 4) })}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
      </div>
      <Card className="mt-3 p-4">
        {read.isError ? (
          <ErrorText>
            {errorMessage(read.error)}{' '}
            <button type="button" className="min-h-11 underline md:min-h-8" onClick={() => void read.refetch()}>
              {t('retry')}
            </button>
          </ErrorText>
        ) : !data ? (
          <p className="text-sm text-muted-foreground" aria-busy="true">
            {t('loading')}
          </p>
        ) : (
          <UnusualEntriesList data={data} notes={notes} slug={slug} canMark={canReviewEntries(org.data?.role)} />
        )}
      </Card>
    </section>
  );
}
