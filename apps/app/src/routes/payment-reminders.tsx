// SPDX-License-Identifier: AGPL-3.0-only
// Customer payment reminders (#2488, "Nhắc thu nợ"): the customers with a sales invoice past its due date, and the reminder mail a person reads,
// edits and sends. Nothing here sends by itself: every mail goes out on a click of Gửi, one customer or several at once, each through
// finance.payment_reminder.send, which rebuilds the invoices, amounts and bank account from the books at that moment. The screen shows those facts as
// the mail will carry them and lets a person edit only the words around them.
import { useMutation, useQueries, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import { vietnamToday, type PausedCustomer, type PaymentReminderCustomer, type PaymentReminderDraft } from '@crove/kernel-contract';
import { PAYMENT_REMINDER_HINT_MAX, PAYMENT_REMINDER_SUBJECT_MAX, PAYMENT_REMINDER_TEXT_MAX } from '@crove/kernel-contract';
import { Alert, AlertDescription } from '@crove/ui/components/alert';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { Textarea } from '@crove/ui/components/textarea';
import { DateInput } from '../components/date-input.tsx';
import { useChosenEntity } from '../components/entity-switcher.tsx';
import { DataTable, Empty, ErrorText, PageHeader, TableSkeleton } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';

const NUM = 'px-4 py-3 text-right tabular-nums';
const LEVEL = { 1: 'levels.first', 2: 'levels.second', 3: 'levels.third' } as const;
const WORDING = { used: 'wording.used', off: 'wording.off', busy: 'wording.busy', budget: 'wording.budget', failed: 'wording.failed' } as const;

// What a person changed in a draft; whatever is left out is the server's draft.
interface Edit {
  subject?: string;
  greeting?: string;
  lead?: string;
  closing?: string;
  payToId?: string | null;
}
// How the send of one draft ended.
type Outcome = { state: 'sent' } | { state: 'suppressed' } | { state: 'error'; error: unknown; repeat: boolean };

// The answers of a draft that is no longer one: the customer was paused, or owes nothing overdue now.
const GONE = ['CUSTOMER_PAUSED', 'NOTHING_OVERDUE'];
const errorCode = (error: unknown): string | null => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
};

function DraftCard({
  draft,
  legalEntityId,
  edit,
  approved,
  outcome,
  busy,
  onEdit,
  onApprove,
  onAsking,
  onRefresh,
  onResend,
}: {
  draft: PaymentReminderDraft;
  legalEntityId: string | undefined;
  edit: Edit;
  approved: boolean;
  outcome: Outcome | undefined;
  busy: boolean;
  onEdit: (patch: Edit) => void;
  onApprove: (value: boolean) => void;
  // Whether the coworker is wording this draft: the send waits for it, so words that arrive late never land on a mail already sent.
  onAsking: (value: boolean) => void;
  onRefresh: () => void;
  onResend: () => void;
}) {
  const t = useTranslations('paymentReminders');
  const f = useFormat();
  const id = `reminder-${draft.partyId}`;
  const words = { ...draft.words, ...edit };
  const payToId = edit.payToId === undefined ? (draft.payTo[0]?.id ?? null) : edit.payToId;
  const sent = outcome?.state === 'sent' || outcome?.state === 'suppressed';
  // The finance coworker words the opening and the closing; the table, the total and the bank account stay the books'. A refusal of any kind leaves the words
  // as they are.
  const [hint, setHint] = useState('');
  // The person's own words before the coworker's replaced them, for a way back.
  const [before, setBefore] = useState<{ lead: string; closing: string } | null>(null);
  const wording = useMutation({
    onMutate: () => onAsking(true),
    onSettled: () => onAsking(false),
    mutationFn: () => client.paymentReminders.wording({ partyId: draft.partyId, ...(legalEntityId ? { legalEntityId } : {}), ...(hint.trim() ? { hint: hint.trim() } : {}) }),
    onSuccess: (answer) => {
      if (answer.words && !sent) {
        setBefore({ lead: words.lead, closing: words.closing });
        onEdit({ lead: answer.words.lead, closing: answer.words.closing });
      }
    },
  });
  return (
    <Card className="block p-4" aria-label={t('draftOf', { name: draft.name })} data-testid="reminder-draft">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="break-words text-base font-medium text-foreground">{draft.name}</h2>
          <p className="mt-1 text-xs text-subtle-foreground">
            {draft.email ?? t('noEmail')} · {t(LEVEL[draft.level])} · {t(draft.lang === 'en' ? 'langEn' : 'langVi')}
          </p>
        </div>
        {!sent && (
          <Label className="flex items-center gap-2 text-sm">
            <Checkbox checked={approved} disabled={busy || draft.email === null} onCheckedChange={(value) => onApprove(value === true)} aria-label={t('approve', { name: draft.name })} />
            {t('approveShort')}
          </Label>
        )}
      </div>

      {draft.email === null && (
        <Alert className="mt-3">
          <AlertDescription>{t('noEmailHint')}</AlertDescription>
        </Alert>
      )}

      {!sent && <CustomerSettings draft={draft} />}

      {!sent && (
        <div className="mt-3 space-y-2 rounded-lg border border-dashed p-3">
          <Label htmlFor={`${id}-hint`}>{t('hint')}</Label>
          <div className="flex flex-wrap gap-2">
            <Input id={`${id}-hint`} className="min-w-48 flex-1" value={hint} maxLength={PAYMENT_REMINDER_HINT_MAX} placeholder={t('hintExample')} disabled={busy || wording.isPending} onChange={(e) => {
                setHint(e.target.value);
                wording.reset();
              }}
            />
            <Button variant="outline" size="sm" loading={wording.isPending} disabled={busy} onClick={() => wording.mutate()} data-testid="reminder-wording">
              {t('wordingButton')}
            </Button>
          </div>
          {wording.data && (
            <p className="text-xs text-subtle-foreground" role="status" data-testid="reminder-wording-state">
              {t(WORDING[wording.data.ai])}
            </p>
          )}
          {wording.error && <ErrorText>{errorMessage(wording.error)}</ErrorText>}
          {before && wording.data?.words && (
            <Button variant="ghost" size="sm" onClick={() => {
                onEdit(before);
                setBefore(null);
                wording.reset();
              }}>
              {t('wordingUndo')}
            </Button>
          )}
        </div>
      )}

      <fieldset className="mt-3 space-y-3" disabled={busy || sent || wording.isPending}>
        <legend className="sr-only">{t('wordsLegend')}</legend>
        <div className="space-y-1">
          <Label htmlFor={`${id}-subject`}>{t('subject')}</Label>
          <Input id={`${id}-subject`} value={words.subject} maxLength={PAYMENT_REMINDER_SUBJECT_MAX} onChange={(e) => onEdit({ subject: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-greeting`}>{t('greeting')}</Label>
          <Input id={`${id}-greeting`} value={words.greeting} maxLength={PAYMENT_REMINDER_TEXT_MAX} onChange={(e) => onEdit({ greeting: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-lead`}>{t('lead')}</Label>
          <Textarea id={`${id}-lead`} value={words.lead} maxLength={PAYMENT_REMINDER_TEXT_MAX} onChange={(e) => onEdit({ lead: e.target.value })} />
        </div>

        <div>
          <p className="text-sm font-medium text-muted-foreground">{t('factsHeading')}</p>
          <p className="mt-1 text-xs text-subtle-foreground">{t('factsHint')}</p>
          <div className="mt-2">
            <DataTable head={[t('invoice'), t('invoiceDate'), t('dueDate'), t('overdue'), t('amountDue')]} numeric={[4]} foot={<FactsTotal draft={draft} />}>
              {draft.invoices.map((i) => (
                <TableRow key={i.id}>
                  <TableCell className="px-4 py-3">{t('invoiceName', { number: i.number, series: i.series || '-' })}</TableCell>
                  <TableCell className="px-4 py-3">{f.date(i.date)}</TableCell>
                  <TableCell className="px-4 py-3">{f.date(i.dueDate)}</TableCell>
                  <TableCell className="px-4 py-3">{t('days', { count: i.daysOverdue })}</TableCell>
                  <TableCell className={NUM}>{f.money(i.amountDue, draft.currency)}</TableCell>
                </TableRow>
              ))}
            </DataTable>
          </div>
          {draft.other !== '0' && <p className="mt-2 text-xs text-subtle-foreground">{t('other', { amount: f.money(draft.other, draft.currency) })}</p>}
        </div>

        <div className="space-y-1">
          <Label htmlFor={`${id}-payto`}>{t('payTo')}</Label>
          {draft.payTo.length === 0 ? (
            <p className="text-xs text-subtle-foreground">{t('payToNone')}</p>
          ) : (
            <NativeSelect id={`${id}-payto`} value={payToId ?? ''} onChange={(e) => onEdit({ payToId: e.target.value === '' ? null : e.target.value })}>
              {draft.payTo.map((p) => (
                <NativeSelectOption key={p.id} value={p.id}>
                  {t('payToOption', { bank: p.bank, number: p.number })}
                </NativeSelectOption>
              ))}
              <NativeSelectOption value="">{t('payToSkip')}</NativeSelectOption>
            </NativeSelect>
          )}
        </div>

        <div className="space-y-1">
          <Label htmlFor={`${id}-closing`}>{t('closing')}</Label>
          <Textarea id={`${id}-closing`} value={words.closing} maxLength={PAYMENT_REMINDER_TEXT_MAX} onChange={(e) => onEdit({ closing: e.target.value })} />
        </div>
      </fieldset>

      {draft.lastReminder && !sent && (
        <p className="mt-3 text-xs text-subtle-foreground">{t('lastReminder', { date: f.date(draft.lastReminder.at), level: t(LEVEL[draft.lastReminder.level]) })}</p>
      )}

      {outcome?.state === 'sent' && (
        <p className="mt-3 text-sm text-foreground" role="status" data-testid="reminder-sent">
          {t('sent')}
        </p>
      )}
      {outcome?.state === 'suppressed' && (
        <p className="mt-3 text-sm text-destructive" role="status">
          {t('suppressed')}
        </p>
      )}
      {outcome?.state === 'error' && (
        <div className="mt-3" role="alert">
          <ErrorText>{errorMessage(outcome.error)}</ErrorText>
          <div className="mt-2 flex flex-wrap gap-2">
            {outcome.repeat && (
              <Button variant="destructive" size="sm" disabled={busy} onClick={onResend}>
                {t('sendAnyway')}
              </Button>
            )}
            {(errorCode(outcome.error) === 'STALE_REMINDER' || errorCode(outcome.error) === 'PAY_TO_NOT_FOUND') && (
              <Button variant="outline" size="sm" disabled={busy} onClick={onRefresh}>
                {t('reopen')}
              </Button>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

function FactsTotal({ draft }: { draft: PaymentReminderDraft }) {
  const t = useTranslations('paymentReminders');
  const f = useFormat();
  return (
    <TableRow>
      <TableCell className="px-4 py-3 font-medium" colSpan={4}>
        {t('total')}
      </TableCell>
      <TableCell className={`${NUM} font-medium`}>{f.money(draft.total, draft.currency)}</TableCell>
    </TableRow>
  );
}

function Review({ ids, legalEntityId, onClose }: { ids: string[]; legalEntityId: string | undefined; onClose: () => void }) {
  const t = useTranslations('paymentReminders');
  const results = useQueries({
    queries: ids.map((partyId) => ({ ...orpc.paymentReminders.draft.queryOptions({ input: { partyId, ...(legalEntityId ? { legalEntityId } : {}) } }), staleTime: 0, gcTime: 0, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false })),
  });
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [sending, setSending] = useState(false);
  // The drafts the coworker is wording right now.
  const [asking, setAsking] = useState<ReadonlySet<string>>(new Set());

  // A draft whose last read was refused (a customer paused since, nothing overdue any more) is no draft to send, whatever it held before.
  const drafts = results.flatMap((r) => (r.data && !r.isError ? [r.data] : []));
  const failed = results.find((r) => r.error);
  const pending = drafts.filter((d) => d.email !== null && !skipped.has(d.partyId) && outcomes[d.partyId]?.state !== 'sent' && outcomes[d.partyId]?.state !== 'suppressed');

  async function sendOne(draft: PaymentReminderDraft, confirm: boolean): Promise<void> {
    const edit = edits[draft.partyId] ?? {};
    const words = { ...draft.words, ...edit };
    const payToId = edit.payToId === undefined ? (draft.payTo[0]?.id ?? null) : edit.payToId;
    try {
      const sent = await client.paymentReminders.send({
        partyId: draft.partyId,
        ...(legalEntityId ? { legalEntityId } : {}),
        level: draft.level,
        total: draft.total,
        invoiceKey: draft.invoiceKey,
        subject: words.subject,
        greeting: words.greeting,
        lead: words.lead,
        closing: words.closing,
        payToId,
        ...(confirm ? { confirm: true } : {}),
      });
      setOutcomes((o) => ({ ...o, [draft.partyId]: { state: sent.status === 'suppressed' ? 'suppressed' : 'sent' } }));
    } catch (error) {
      setOutcomes((o) => ({ ...o, [draft.partyId]: { state: 'error', error, repeat: errorCode(error) === 'ALREADY_REMINDED' } }));
    }
  }

  async function sendAll(): Promise<void> {
    setSending(true);
    // One at a time, in the order shown: each is its own audited send, and a refusal of one leaves the others going.
    for (const draft of pending) await sendOne(draft, false);
    setSending(false);
    await queryClient.invalidateQueries({ queryKey: orpc.paymentReminders.list.key() });
  }

  async function resend(draft: PaymentReminderDraft): Promise<void> {
    setSending(true);
    await sendOne(draft, true);
    setSending(false);
    await queryClient.invalidateQueries({ queryKey: orpc.paymentReminders.list.key() });
  }

  return (
    <section className="mt-6 space-y-4" aria-label={t('reviewTitle')}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-medium text-foreground">{t('reviewTitle')}</h2>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" size="sm" disabled={sending} onClick={onClose}>
            {t('close')}
          </Button>
          <Button loading={sending} disabled={pending.length === 0 || asking.size > 0} onClick={() => void sendAll()} data-testid="reminder-send">
            {t('send', { count: pending.length })}
          </Button>
        </div>
      </div>
      <p className="text-xs text-subtle-foreground">{t('nothingAutomatic')}</p>
      {failed?.error && (GONE.includes(errorCode(failed.error) ?? '') ? <p className="text-sm text-muted-foreground">{t('draftGone')}</p> : <ErrorText>{errorMessage(failed.error)}</ErrorText>)}
      {results.some((r) => r.isPending) && <TableSkeleton columns={4} rows={2} />}
      {drafts.map((draft) => (
        <DraftCard
          key={draft.partyId}
          draft={draft}
          legalEntityId={legalEntityId}
          edit={edits[draft.partyId] ?? {}}
          approved={!skipped.has(draft.partyId)}
          outcome={outcomes[draft.partyId]}
          busy={sending}
          onEdit={(patch) => setEdits((e) => ({ ...e, [draft.partyId]: { ...e[draft.partyId], ...patch } }))}
          onApprove={(value) =>
            setSkipped((s) => {
              const next = new Set(s);
              if (value) next.delete(draft.partyId);
              else next.add(draft.partyId);
              return next;
            })
          }
          onAsking={(value) =>
            setAsking((s) => {
              const next = new Set(s);
              if (value) next.add(draft.partyId);
              else next.delete(draft.partyId);
              return next;
            })
          }
          onRefresh={() => {
            setOutcomes(({ [draft.partyId]: _gone, ...rest }) => rest);
            setEdits(({ [draft.partyId]: _kept, ...rest }) => rest);
            void queryClient.invalidateQueries({ queryKey: orpc.paymentReminders.draft.key() });
          }}
          onResend={() => void resend(draft)}
        />
      ))}
    </section>
  );
}

function Row({ customer, checked, onCheck, onOpen, currency }: { customer: PaymentReminderCustomer; checked: boolean; onCheck: (value: boolean) => void; onOpen: () => void; currency: string }) {
  const t = useTranslations('paymentReminders');
  const f = useFormat();
  return (
    <TableRow data-testid="reminder-row">
      <TableCell className="w-10 px-4 py-3">
        <Checkbox checked={checked} onCheckedChange={(value) => onCheck(value === true)} aria-label={t('select', { name: customer.name })} />
      </TableCell>
      <TableCell className="px-4 py-3">
        <p className="break-words text-foreground">{customer.name}</p>
        {customer.email === null && <p className="mt-1 text-xs text-destructive">{t('noEmail')}</p>}
        {customer.other !== '0' && <p className="mt-1 text-xs text-subtle-foreground">{t('other', { amount: f.money(customer.other, currency) })}</p>}
      </TableCell>
      <TableCell className={NUM}>{customer.invoiceCount}</TableCell>
      <TableCell className={NUM}>{t('days', { count: customer.daysOverdue })}</TableCell>
      <TableCell className="px-4 py-3">
        <Badge variant={customer.level === 3 ? 'destructive' : 'outline'}>{t(LEVEL[customer.level])}</Badge>
      </TableCell>
      <TableCell className={NUM}>{f.money(customer.total, currency)}</TableCell>
      <TableCell className="px-4 py-3 text-sm text-muted-foreground">
        {customer.lastReminder ? t('lastReminder', { date: f.date(customer.lastReminder.at), level: t(LEVEL[customer.lastReminder.level]) }) : t('never')}
      </TableCell>
      <TableCell className="px-4 py-3 text-right">
        <Button variant="outline" size="sm" onClick={onOpen} aria-label={t('composeFor', { name: customer.name })}>
          {t('compose')}
        </Button>
      </TableCell>
    </TableRow>
  );
}

// What the org and a customer set for the reminders (#2488, slice 3). Saving refreshes the list and every open draft: the terms change the due dates, the levels and the
// totals, a pause takes the customer out of the list.
const refreshReminders = () => {
  void queryClient.invalidateQueries({ queryKey: orpc.paymentReminders.list.key() });
  void queryClient.invalidateQueries({ queryKey: orpc.paymentReminders.draft.key() });
};

function SettingsCard({ canManage }: { canManage: boolean }) {
  const t = useTranslations('paymentReminders');
  const settings = useQuery(orpc.paymentReminders.settings.get.queryOptions());
  const [terms, setTerms] = useState<string | null>(null);
  const [weekly, setWeekly] = useState<boolean | null>(null);
  const save = useMutation(
    orpc.paymentReminders.settings.set.mutationOptions({
      onSuccess: () => {
        setTerms(null);
        setWeekly(null);
        void queryClient.invalidateQueries({ queryKey: orpc.paymentReminders.settings.get.key() });
        refreshReminders();
      },
    }),
  );
  if (settings.isPending) return null;
  if (settings.error) return <ErrorText>{errorMessage(settings.error)}</ErrorText>;
  const current = settings.data;
  const typed = terms ?? String(current.termsDays);
  const days = Number(typed);
  const valid = Number.isInteger(days) && days >= 1 && days <= 365;
  const changed = terms !== null || weekly !== null;
  if (!canManage) {
    return (
      <p className="mb-4 text-xs text-subtle-foreground" data-testid="reminder-settings-readonly">
        {t('settings.readOnly', { days: String(current.termsDays) })}
      </p>
    );
  }
  return (
    <Card className="mb-4 block p-4" aria-label={t('settings.title')} data-testid="reminder-settings">
      <p className="text-sm font-medium text-muted-foreground">{t('settings.title')}</p>
      <div className="mt-3 flex flex-wrap items-end gap-4">
        <div className="space-y-1">
          <Label htmlFor="reminder-terms">{t('settings.terms')}</Label>
          <Input id="reminder-terms" className="w-28" type="number" inputMode="numeric" min={1} max={365} value={typed} aria-invalid={!valid} onChange={(e) => setTerms(e.target.value)} />
        </div>
        <Label className="flex items-center gap-2 text-sm">
          <Checkbox checked={weekly ?? current.weeklyItem} onCheckedChange={(value) => setWeekly(value === true)} />
          {t('settings.weekly')}
        </Label>
        <Button size="sm" loading={save.isPending} disabled={!changed || !valid} onClick={() => save.mutate({ termsDays: days, weeklyItem: weekly ?? current.weeklyItem })}>
          {t('settings.save')}
        </Button>
      </div>
      <p className="mt-2 text-xs text-subtle-foreground">{t('settings.weeklyHint')}</p>
      {!valid && <ErrorText>{t('settings.termsInvalid')}</ErrorText>}
      {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
    </Card>
  );
}

// One customer's own terms and its pause, in its draft: members who may send write them, a viewer never sees the draft.
function CustomerSettings({ draft }: { draft: PaymentReminderDraft }) {
  const t = useTranslations('paymentReminders');
  const [terms, setTerms] = useState(draft.ownTermsDays === null ? '' : String(draft.ownTermsDays));
  const [until, setUntil] = useState('');
  const save = useMutation(orpc.paymentReminders.customer.set.mutationOptions({ onSuccess: refreshReminders }));
  const days = terms.trim() === '' ? null : Number(terms);
  const valid = days === null || (Number.isInteger(days) && days >= 1 && days <= 365);
  const id = `reminder-own-${draft.partyId}`;
  return (
    <details className="mt-3 rounded-lg border border-dashed p-3 text-sm">
      <summary className="cursor-pointer text-muted-foreground">{t('customer.title')}</summary>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`${id}-terms`}>{t('customer.terms')}</Label>
          <Input id={`${id}-terms`} type="number" inputMode="numeric" min={1} max={365} placeholder={String(draft.orgTermsDays)} value={terms} aria-invalid={!valid} onChange={(e) => setTerms(e.target.value)} />
          <p className="text-xs text-subtle-foreground">{t('customer.termsHint')}</p>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-pause`}>{t('customer.pauseUntil')}</Label>
          <DateInput id={`${id}-pause`} value={until} onChange={setUntil} min={vietnamToday()} />
          <p className="text-xs text-subtle-foreground">{t('customer.pauseHint')}</p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          loading={save.isPending}
          disabled={!valid || (until !== '' && until < vietnamToday())}
          onClick={() => save.mutate({ partyId: draft.partyId, termsDays: days, pausedUntil: until === '' ? null : until })}
          data-testid="reminder-customer-save"
        >
          {t('customer.save')}
        </Button>
        {save.isSuccess && (
          <span className="text-xs text-subtle-foreground" role="status">
            {t('settings.saved')}
          </span>
        )}
      </div>
      {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
    </details>
  );
}

function PausedCustomers({ paused, currency, canEdit }: { paused: PausedCustomer[]; currency: string; canEdit: boolean }) {
  const t = useTranslations('paymentReminders');
  const f = useFormat();
  const resume = useMutation(orpc.paymentReminders.customer.set.mutationOptions({ onSuccess: refreshReminders }));
  if (paused.length === 0) return null;
  return (
    <section className="mt-6" aria-label={t('paused.title', { count: paused.length })} data-testid="reminder-paused">
      <h2 className="text-sm font-medium text-muted-foreground">{t('paused.title', { count: paused.length })}</h2>
      <ul className="mt-2 divide-y rounded-xl border bg-card">
        {paused.map((c) => (
          <li key={c.partyId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
            <div className="min-w-0">
              <p className="break-words text-foreground">{c.name}</p>
              <p className="mt-1 text-xs text-subtle-foreground">{t('paused.until', { date: f.date(c.pausedUntil), total: f.money(c.total, currency) })}</p>
            </div>
            {canEdit && (
              <Button variant="outline" size="sm" loading={resume.isPending && resume.variables?.partyId === c.partyId} onClick={() => resume.mutate({ partyId: c.partyId, pausedUntil: null })} aria-label={t('paused.resumeOf', { name: c.name })}>
                {t('paused.resume')}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {resume.error && <ErrorText>{errorMessage(resume.error)}</ErrorText>}
    </section>
  );
}

export function PaymentRemindersPage() {
  const t = useTranslations('paymentReminders');
  const entity = useChosenEntity();
  const list = useQuery({ ...orpc.paymentReminders.list.queryOptions({ input: { legalEntityId: entity.legalEntityId } }), enabled: entity.ready });
  const org = useQuery(orpc.org.get.queryOptions());
  const canSend = org.data?.role === 'owner' || org.data?.role === 'admin' || org.data?.role === 'member';
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  // Each opening of the review is a fresh one (its own key): reopening a customer whose reminder just went out starts a new draft, not the sent one.
  const [reviewing, setReviewing] = useState<{ ids: string[]; opened: number } | null>(null);
  const open = (ids: string[]) => setReviewing((r) => ({ ids, opened: (r?.opened ?? 0) + 1 }));
  const customers = list.data?.customers ?? [];
  const currency = list.data?.currency ?? 'VND';
  const ids = useMemo(() => customers.filter((c) => checked.has(c.partyId)).map((c) => c.partyId), [customers, checked]);
  const all = customers.length > 0 && ids.length === customers.length;

  const toggle = (id: string, value: boolean) =>
    setChecked((s) => {
      const next = new Set(s);
      if (value) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          canSend && customers.length > 0 ? (
            <Button disabled={ids.length === 0} onClick={() => open(ids)} data-testid="reminder-compose-selected">
              {t('composeSelected', { count: ids.length })}
            </Button>
          ) : undefined
        }
      />
      <SettingsCard canManage={org.data?.role === 'owner' || org.data?.role === 'admin'} />
      {list.isPending ? (
        <TableSkeleton columns={6} />
      ) : list.error ? (
        <ErrorText>{errorMessage(list.error)}</ErrorText>
      ) : customers.length === 0 ? (
        <Empty title={t('empty')} hint={t('emptyHint', { days: String(list.data?.termsDays ?? 30) })} />
      ) : (
        <>
          <div className="mb-3 flex items-center gap-2 text-sm">
            <Checkbox
              checked={all}
              indeterminate={ids.length > 0 && !all}
              onCheckedChange={(value) => setChecked(value === true ? new Set(customers.map((c) => c.partyId)) : new Set())}
              aria-label={t('selectAll')}
            />
            <span className="text-muted-foreground">{t('selectAll')}</span>
          </div>
          <DataTable head={['', t('columns.customer'), t('columns.invoices'), t('columns.overdue'), t('columns.level'), t('columns.owed'), t('columns.last'), '']} numeric={[2, 3, 5]}>
            {customers.map((c) => (
              <Row key={c.partyId} customer={c} currency={currency} checked={checked.has(c.partyId)} onCheck={(value) => toggle(c.partyId, value)} onOpen={() => open([c.partyId])} />
            ))}
          </DataTable>
          {list.data?.more && <p className="mt-3 text-xs text-subtle-foreground">{t('more')}</p>}
          <p className="mt-3 text-xs text-subtle-foreground">{t('termsNote', { days: String(list.data?.termsDays ?? 30) })}</p>
        </>
      )}
      {list.data && <PausedCustomers paused={list.data.paused} currency={currency} canEdit={canSend} />}
      {reviewing && canSend && <Review key={`${reviewing.opened}:${entity.legalEntityId ?? ''}`} ids={reviewing.ids} legalEntityId={entity.legalEntityId} onClose={() => setReviewing(null)} />}
    </>
  );
}
