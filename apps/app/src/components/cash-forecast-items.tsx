// SPDX-License-Identifier: AGPL-3.0-only
// The items an owner enters into the 90-day cash forecast (#5326), inside the forecast card of the Tổng quan: rent, payroll, a loan, a one-off, the costs and receipts the books cannot show. Everyone who reads
// the forecast sees the list; an owner or an admin adds, edits and removes (the server refuses anyone else, so the buttons are only hidden). Money is whole dong typed as digits and sent as a string, never a
// number. The label is the owner's own words: it is shown here and nowhere else (not in the audit, not to the coworker). No AI part: the core works with AI off.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import {
  CASH_FORECAST_ENTERED_CATEGORIES,
  CASH_FORECAST_ENTERED_DIRECTIONS,
  CASH_FORECAST_ENTERED_RECURRENCES,
  CASH_FORECAST_ITEM_FIRST_DAY,
  CASH_FORECAST_ITEM_LABEL_MAX,
  CASH_FORECAST_ITEM_LAST_DAY,
  type CashForecastEnteredCategory,
  type CashForecastEnteredDirection,
  type CashForecastEnteredRecurrence,
  type CashForecastItemView,
} from '@ludy/kernel-contract';
import { Button } from '@ludy/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@ludy/ui/components/dialog';
import { Input } from '@ludy/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { ConfirmDialog } from './confirm-dialog.tsx';
import { DateInput } from './date-input.tsx';
import { ErrorText, Field, focusFirstInvalid } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { toast } from '../lib/toast.ts';

const AMOUNT = /^[1-9]\d{0,14}$/;

interface Draft {
  label: string;
  category: CashForecastEnteredCategory;
  direction: CashForecastEnteredDirection;
  amount: string;
  firstDate: string;
  recurrence: CashForecastEnteredRecurrence;
  endDate: string;
}

type DraftError = 'label' | 'amount' | 'firstDate' | 'endDate';

const blank = (): Draft => ({ label: '', category: 'rent', direction: 'out', amount: '', firstDate: '', recurrence: 'monthly', endDate: '' });
const draftOf = (item: CashForecastItemView): Draft => ({
  label: item.label,
  category: item.category,
  direction: item.direction,
  amount: item.amount,
  firstDate: item.firstDate,
  recurrence: item.recurrence,
  endDate: item.endDate ?? '',
});

// What is wrong with the entries, by field; the server checks the same things again.
export function draftErrors(draft: Draft): Partial<Record<DraftError, true>> {
  const bad: Partial<Record<DraftError, true>> = {};
  const label = draft.label.trim();
  if (label === '' || Array.from(label).length > CASH_FORECAST_ITEM_LABEL_MAX || /\p{Cc}/u.test(label)) bad.label = true;
  if (!AMOUNT.test(draft.amount)) bad.amount = true;
  const within = (d: string) => d >= CASH_FORECAST_ITEM_FIRST_DAY && d <= CASH_FORECAST_ITEM_LAST_DAY;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.firstDate) || !within(draft.firstDate)) bad.firstDate = true;
  if (draft.recurrence !== 'once' && draft.endDate !== '' && (!within(draft.endDate) || draft.endDate < draft.firstDate)) bad.endDate = true;
  return bad;
}

function ItemDialog({ legalEntityId, item, onClose }: { legalEntityId: string; item: CashForecastItemView | null; onClose: () => void }) {
  const t = useTranslations('financeCashForecast.items');
  const common = useTranslations('common');
  const [draft, setDraft] = useState<Draft>(() => (item ? draftOf(item) : blank()));
  const [tried, setTried] = useState(false);
  const bad = tried ? draftErrors(draft) : {};
  const save = useMutation({
    mutationFn: () =>
      orpc.financeCashForecast.setItem.call({
        ...(item ? { id: item.id } : {}),
        legalEntityId,
        label: draft.label.trim(),
        category: draft.category,
        direction: draft.direction,
        amount: draft.amount,
        firstDate: draft.firstDate,
        recurrence: draft.recurrence,
        endDate: draft.recurrence === 'once' || draft.endDate === '' ? null : draft.endDate,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: orpc.financeCashForecast.key() });
      toast(t('saved'), 'success');
      onClose();
    },
  });
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    setTried(true);
    if (Object.keys(draftErrors(draft)).length > 0) {
      // Focus goes to the first field marked invalid once it is drawn as such.
      requestAnimationFrame(() => focusFirstInvalid(form));
      return;
    }
    save.mutate();
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !save.isPending && onClose()}>
      <DialogContent>
        <form onSubmit={submit} noValidate className="space-y-4" data-testid="cash-forecast-item-form">
          <DialogHeader>
            <DialogTitle>{item ? t('form.editTitle') : t('form.addTitle')}</DialogTitle>
            <DialogDescription>{t('form.description')}</DialogDescription>
          </DialogHeader>
          <Field label={t('form.label')} error={bad.label ? t('errors.label', { max: CASH_FORECAST_ITEM_LABEL_MAX }) : undefined}>
            {(control) => <Input {...control} value={draft.label} maxLength={CASH_FORECAST_ITEM_LABEL_MAX} autoComplete="off" onChange={(e) => set('label', e.target.value)} />}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('form.direction')}>
              {(control) => (
                <NativeSelect {...control} value={draft.direction} onChange={(e) => set('direction', e.target.value as CashForecastEnteredDirection)}>
                  {CASH_FORECAST_ENTERED_DIRECTIONS.map((d) => (
                    <NativeSelectOption key={d} value={d}>
                      {t(`direction.${d}`)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              )}
            </Field>
            <Field label={t('form.category')}>
              {(control) => (
                <NativeSelect {...control} value={draft.category} onChange={(e) => set('category', e.target.value as CashForecastEnteredCategory)}>
                  {CASH_FORECAST_ENTERED_CATEGORIES.map((c) => (
                    <NativeSelectOption key={c} value={c}>
                      {t(`category.${c}`)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              )}
            </Field>
          </div>
          <Field label={t('form.amount')} hint={t('form.amountHint')} error={bad.amount ? t('errors.amount') : undefined}>
            {(control) => <Input {...control} value={draft.amount} inputMode="numeric" autoComplete="off" onChange={(e) => set('amount', e.target.value.trim())} />}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('form.recurrence')}>
              {(control) => (
                <NativeSelect {...control} value={draft.recurrence} onChange={(e) => set('recurrence', e.target.value as CashForecastEnteredRecurrence)}>
                  {CASH_FORECAST_ENTERED_RECURRENCES.map((r) => (
                    <NativeSelectOption key={r} value={r}>
                      {t(`recurrence.${r}`)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              )}
            </Field>
            <Field label={draft.recurrence === 'once' ? t('form.onceDate') : t('form.firstDate')} error={bad.firstDate ? t('errors.date') : undefined}>
              {(control) => <DateInput {...control} value={draft.firstDate} min={CASH_FORECAST_ITEM_FIRST_DAY} max={CASH_FORECAST_ITEM_LAST_DAY} onChange={(v) => set('firstDate', v)} />}
            </Field>
          </div>
          {draft.recurrence !== 'once' && (
            <Field label={t('form.endDate')} hint={t('form.endHint')} error={bad.endDate ? t('errors.endDate') : undefined}>
              {(control) => <DateInput {...control} value={draft.endDate} min={draft.firstDate || CASH_FORECAST_ITEM_FIRST_DAY} max={CASH_FORECAST_ITEM_LAST_DAY} onChange={(v) => set('endDate', v)} />}
            </Field>
          )}
          <p className="text-xs text-muted-foreground" data-testid="cash-forecast-item-overlap">
            {t('form.overlap')}
          </p>
          {save.isError && <ErrorText>{errorMessage(save.error)}</ErrorText>}
          <DialogFooter>
            <Button type="button" variant="outline" className="min-h-11" disabled={save.isPending} onClick={onClose}>
              {common('cancel')}
            </Button>
            <Button type="submit" className="min-h-11" disabled={save.isPending}>
              {save.isPending ? common('processing') : t('form.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// The list of the chosen entity's items and, for an owner or an admin, the way to change it.
export function CashForecastItems({ legalEntityId }: { legalEntityId: string }) {
  const t = useTranslations('financeCashForecast.items');
  const f = useFormat();
  const org = useQuery(orpc.org.get.queryOptions());
  const canManage = org.data?.role === 'owner' || org.data?.role === 'admin';
  const list = useQuery(orpc.financeCashForecast.items.queryOptions({ input: { legalEntityId } }));
  const [editing, setEditing] = useState<CashForecastItemView | 'new' | null>(null);
  const [removing, setRemoving] = useState<CashForecastItemView | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => orpc.financeCashForecast.removeItem.call({ id }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: orpc.financeCashForecast.key() });
      toast(t('removed'), 'success');
    },
  });
  const items = list.data?.items ?? [];
  return (
    <div className="mt-4 border-t pt-4" data-testid="cash-forecast-items">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t('title')}</h3>
        {canManage && (
          <Button type="button" variant="outline" className="min-h-11" onClick={() => setEditing('new')} data-testid="cash-forecast-item-add">
            {t('add')}
          </Button>
        )}
      </div>
      <p className="mt-1 text-xs text-subtle-foreground">{t('hint')}</p>
      {list.isError && <ErrorText>{errorMessage(list.error)}</ErrorText>}
      {list.data && items.length === 0 && (
        <p className="mt-3 text-sm text-muted-foreground" data-testid="cash-forecast-items-empty">
          {t('empty')}
        </p>
      )}
      {items.length > 0 && (
        <ul className="mt-3 divide-y text-sm">
          {items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2" data-testid="cash-forecast-item">
              <div className="min-w-0">
                <p className="break-words font-medium">{item.label}</p>
                <p className="text-xs text-muted-foreground">
                  {t(`category.${item.category}`)} · {t(`recurrence.${item.recurrence}`)}
                  {item.endDate ? ` · ${t('until', { date: f.date(item.endDate) })}` : ''} · {item.nextDate ? t('next', { date: f.date(item.nextDate) }) : t('noNext')}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className="tabular-nums font-medium">
                  {t(`direction.${item.direction}`)} {f.money(item.amount)}
                </span>
                {canManage && (
                  <>
                    <Button type="button" variant="ghost" className="min-h-11" aria-label={t('editLabel', { label: item.label })} onClick={() => setEditing(item)}>
                      {t('edit')}
                    </Button>
                    <Button type="button" variant="ghost" className="min-h-11" aria-label={t('removeLabel', { label: item.label })} onClick={() => setRemoving(item)}>
                      {t('remove')}
                    </Button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {!canManage && org.data && <p className="mt-2 text-xs text-subtle-foreground">{t('readOnly')}</p>}
      {remove.isError && <ErrorText>{errorMessage(remove.error)}</ErrorText>}
      {editing !== null && <ItemDialog legalEntityId={legalEntityId} item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t('removeTitle')}
        description={t('removeDescription')}
        confirm={t('removeYes')}
        destructive
        onConfirm={() => {
          if (removing) remove.mutate(removing.id);
          setRemoving(null);
        }}
      />
    </div>
  );
}
