// SPDX-License-Identifier: AGPL-3.0-only
// Customer payment reminders (#2488, "Nhắc thu nợ"): the customers with a sales invoice past its due date, and the reminder mail a person reads,
// edits and sends. Nothing here sends by itself: every mail goes out on a click of Gửi, one customer or several at once, each through
// finance.payment_reminder.send, which rebuilds the invoices, amounts and bank account from the books at that moment. The screen shows those facts as
// the mail will carry them and lets a person edit only the words around them.
import { useQueries, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import type { PaymentReminderCustomer, PaymentReminderDraft } from '@crove/kernel-contract';
import { PAYMENT_REMINDER_SUBJECT_MAX, PAYMENT_REMINDER_TEXT_MAX } from '@crove/kernel-contract';
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
import { useChosenEntity } from '../components/entity-switcher.tsx';
import { DataTable, Empty, ErrorText, PageHeader, TableSkeleton } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';

const NUM = 'px-4 py-3 text-right tabular-nums';
const LEVEL = { 1: 'levels.first', 2: 'levels.second', 3: 'levels.third' } as const;

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

const errorCode = (error: unknown): string | null => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
};

function DraftCard({
  draft,
  edit,
  approved,
  outcome,
  busy,
  onEdit,
  onApprove,
  onRefresh,
  onResend,
}: {
  draft: PaymentReminderDraft;
  edit: Edit;
  approved: boolean;
  outcome: Outcome | undefined;
  busy: boolean;
  onEdit: (patch: Edit) => void;
  onApprove: (value: boolean) => void;
  onRefresh: () => void;
  onResend: () => void;
}) {
  const t = useTranslations('paymentReminders');
  const f = useFormat();
  const id = `reminder-${draft.partyId}`;
  const words = { ...draft.words, ...edit };
  const payToId = edit.payToId === undefined ? (draft.payTo[0]?.id ?? null) : edit.payToId;
  const sent = outcome?.state === 'sent' || outcome?.state === 'suppressed';
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

      <fieldset className="mt-3 space-y-3" disabled={busy || sent}>
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
            {errorCode(outcome.error) === 'STALE_REMINDER' && (
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
    queries: ids.map((partyId) => ({ ...orpc.paymentReminders.draft.queryOptions({ input: { partyId, ...(legalEntityId ? { legalEntityId } : {}) } }), staleTime: 0, gcTime: 0, retry: false })),
  });
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [sending, setSending] = useState(false);

  const drafts = results.flatMap((r) => (r.data ? [r.data] : []));
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
          <Button loading={sending} disabled={pending.length === 0} onClick={() => void sendAll()} data-testid="reminder-send">
            {t('send', { count: pending.length })}
          </Button>
        </div>
      </div>
      <p className="text-xs text-subtle-foreground">{t('nothingAutomatic')}</p>
      {failed?.error && <ErrorText>{errorMessage(failed.error)}</ErrorText>}
      {results.some((r) => r.isPending) && <TableSkeleton columns={4} rows={2} />}
      {drafts.map((draft) => (
        <DraftCard
          key={draft.partyId}
          draft={draft}
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

export function PaymentRemindersPage() {
  const t = useTranslations('paymentReminders');
  const entity = useChosenEntity();
  const list = useQuery({ ...orpc.paymentReminders.list.queryOptions({ input: { legalEntityId: entity.legalEntityId } }), enabled: entity.ready });
  const org = useQuery(orpc.org.get.queryOptions());
  const canSend = org.data?.role === 'owner' || org.data?.role === 'admin' || org.data?.role === 'member';
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [reviewing, setReviewing] = useState<string[] | null>(null);
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
            <Button disabled={ids.length === 0} onClick={() => setReviewing(ids)} data-testid="reminder-compose-selected">
              {t('composeSelected', { count: ids.length })}
            </Button>
          ) : undefined
        }
      />
      {list.isPending ? (
        <TableSkeleton columns={6} />
      ) : list.error ? (
        <ErrorText>{errorMessage(list.error)}</ErrorText>
      ) : customers.length === 0 ? (
        <Empty title={t('empty')} hint={t('emptyHint')} />
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
              <Row key={c.partyId} customer={c} currency={currency} checked={checked.has(c.partyId)} onCheck={(value) => toggle(c.partyId, value)} onOpen={() => setReviewing([c.partyId])} />
            ))}
          </DataTable>
          {list.data?.more && <p className="mt-3 text-xs text-subtle-foreground">{t('more')}</p>}
          <p className="mt-3 text-xs text-subtle-foreground">{t('termsNote')}</p>
        </>
      )}
      {reviewing && canSend && <Review key={reviewing.join(',')} ids={reviewing} legalEntityId={entity.legalEntityId} onClose={() => setReviewing(null)} />}
    </>
  );
}
