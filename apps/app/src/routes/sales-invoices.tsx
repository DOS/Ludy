// SPDX-License-Identifier: AGPL-3.0-only
// Sales e-invoice drafts ("Hóa đơn bán ra", #2500, ADR-0044): the drafts of the invoices a business will issue, made, checked and edited here. Nothing is
// issued and no provider is called from this screen yet: a draft is a working copy. The amounts are the server's, computed from the lines (the form has no
// total to type), and the checks of the invoice's required fields show on the fields as the draft is typed.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useDeferredValue, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { BUYER_KINDS, EINVOICE_DRAFT_MAX_LINES, EINVOICE_SUGGEST_TEXT_MAX, vietnamToday, type BuyerKind, type DraftIssueCode, type EInvoiceDraft, type EInvoiceDraftForm, type EInvoiceDraftSummary, type EInvoicePrevious, type EInvoiceSuggested } from '@crove/kernel-contract';
import { Alert, AlertDescription } from '@crove/ui/components/alert';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { Textarea } from '@crove/ui/components/textarea';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { DateInput } from '../components/date-input.tsx';
import { useChosenEntity } from '../components/entity-switcher.tsx';
import { DataTable, Empty, ErrorText, PageHeader, TableSkeleton } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { StepUpPrompt } from '../components/two-factor.tsx';
import { client, errorMessage, isStepUpRequired, orpc, queryClient } from '../lib/api.ts';

const NUM = 'px-4 py-3 text-right tabular-nums';
const VAT_RATES = ['0%', '5%', '8%', '10%', 'KCT', 'KKKNT'] as const;
const STATE_KEY = { draft: 'states.draft', submitting: 'states.submitting', pending: 'states.pending', issued: 'states.issued', rejected: 'states.rejected', failed: 'states.failed' } as const;

interface LineState {
  description: string;
  unit: string;
  quantity: string;
  unitPrice: string;
  vatRate: string;
  // Set while the line is the coworker's proposal and nobody has edited it (#2505): where its VAT rate came from. Any edit makes the line the person's own.
  ai: EInvoiceSuggested['lines'][number]['vatFrom'] | null;
}
interface FormState {
  draftId: string | null;
  // The buyer is the coworker's proposal, from a customer's record, until a person edits it.
  buyerAi: boolean;
  date: string;
  seriesId: string;
  buyer: { kind: BuyerKind; partyId: string | null; taxCode: string; name: string; address: string; email: string };
  lines: LineState[];
}

const blankLine = (): LineState => ({ description: '', unit: '', quantity: '1', unitPrice: '', vatRate: '10%', ai: null });
const blankForm = (seriesId: string): FormState => ({ draftId: null, buyerAi: false, date: vietnamToday(), seriesId, buyer: { kind: 'business', partyId: null, taxCode: '', name: '', address: '', email: '' }, lines: [blankLine()] });
const fromDraft = (d: EInvoiceDraft): FormState => ({
  draftId: d.id,
  buyerAi: false,
  date: d.date,
  seriesId: d.seriesId ?? '',
  buyer: { kind: d.buyer.kind as BuyerKind, partyId: d.buyer.partyId, taxCode: d.buyer.taxCode ?? '', name: d.buyer.name ?? '', address: d.buyer.address ?? '', email: d.buyer.email ?? '' },
  lines: d.lines.map((l) => ({ description: l.description, unit: l.unit ?? '', quantity: l.quantity, unitPrice: l.unitPrice, vatRate: l.vatRate, ai: null })),
});
const orNull = (value: string): string | null => (value.trim() === '' ? null : value.trim());
// The form as the server takes it. A quantity or price that is not yet a number goes as typed, and the server's check says so on the field.
const toInput = (s: FormState): EInvoiceDraftForm => ({
  date: s.date,
  seriesId: s.seriesId === '' ? null : s.seriesId,
  // A sale to a consumer carries no buyer details: what the form held before the kind was chosen is not sent.
  buyer:
    s.buyer.kind === 'consumer'
      ? { kind: 'consumer', partyId: null, taxCode: null, name: null, address: null, email: null }
      : { kind: s.buyer.kind, partyId: s.buyer.partyId, taxCode: orNull(s.buyer.taxCode), name: orNull(s.buyer.name), address: orNull(s.buyer.address), email: orNull(s.buyer.email) },
  lines: s.lines.map((l) => ({ description: l.description, unit: orNull(l.unit), quantity: l.quantity.trim(), unitPrice: l.unitPrice.trim(), vatRate: l.vatRate })),
});

const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.einvoice.key() });

const isBlankLine = (l: LineState) => l.description.trim() === '' && l.unit.trim() === '' && l.unitPrice.trim() === '';

// What the coworker proposed, put into the form (#2505). The proposed lines take the place of the blank ones, or follow the lines a person already wrote (at most what a draft holds); the buyer is
// filled only while the form has none of its own. Everything is marked as the coworker's until it is edited, and nothing is saved.
function applySuggestion(s: FormState, proposal: EInvoiceSuggested): FormState {
  const proposed: LineState[] = proposal.lines.map((l) => ({ description: l.description, unit: l.unit ?? '', quantity: l.quantity, unitPrice: l.unitPrice, vatRate: l.vatRate, ai: l.vatFrom }));
  const kept = s.lines.filter((l) => !isBlankLine(l));
  const lines = [...kept, ...proposed].slice(0, EINVOICE_DRAFT_MAX_LINES);
  const b = s.buyer;
  const buyerEmpty = b.partyId === null && b.taxCode.trim() === '' && b.name.trim() === '' && b.address.trim() === '' && b.email.trim() === '';
  // A person who chose a consumer sale keeps it: the coworker's customer does not replace the choice.
  const buyer = proposal.buyer !== null && buyerEmpty && b.kind !== 'consumer' ? proposal.buyer : null;
  return {
    ...s,
    lines: lines.length > 0 ? lines : s.lines,
    ...(buyer ? { buyerAi: true, buyer: { kind: buyer.kind, partyId: buyer.partyId, taxCode: buyer.taxCode ?? '', name: buyer.name ?? '', address: buyer.address ?? '', email: buyer.email ?? '' } } : {}),
  };
}

// The previous invoice to the same customer copied into the form by code, with no model (#2721): its lines take the place of the blank ones, the buyer is filled while the form has none of its
// own, and a VAT rate the form's date no longer allows is set to the default so a person chooses it again. Returns how many lines took the default rate.
function applyPrevious(s: FormState, invoice: NonNullable<EInvoicePrevious['invoice']>): { state: FormState; rateChanged: number } {
  const proposed: LineState[] = invoice.lines.map((l) => ({ description: l.description, unit: l.unit ?? '', quantity: l.quantity, unitPrice: l.unitPrice, vatRate: l.vatAllowed ? l.vatRate : '10%', ai: null }));
  const kept = s.lines.filter((l) => !isBlankLine(l));
  const lines = [...kept, ...proposed].slice(0, EINVOICE_DRAFT_MAX_LINES);
  const b = s.buyer;
  const buyerEmpty = b.partyId === null && b.taxCode.trim() === '' && b.name.trim() === '' && b.address.trim() === '' && b.email.trim() === '';
  const from = invoice.buyer;
  const buyer = buyerEmpty && b.kind !== 'consumer' ? { kind: from.kind as BuyerKind, partyId: from.partyId, taxCode: from.taxCode ?? '', name: from.name ?? '', address: from.address ?? '', email: from.email ?? '' } : b;
  return { state: { ...s, lines: lines.length > 0 ? lines : s.lines, buyer }, rateChanged: invoice.lines.filter((l) => !l.vatAllowed).length };
}

/** The "previous invoice" source of the draft form (#2721): a person picks a customer, sees the last invoice issued to them, and either copies its lines (by code, works with AI off) or lets the coworker
 * read those lines together with the text. Reading goes through the person's own finance permission; nothing is saved or issued here. */
function PreviousInvoice({ date, onCopy, onPicked }: { date: string; onCopy: (invoice: NonNullable<EInvoicePrevious['invoice']>) => number; onPicked: (draftId: string | null) => void }) {
  const t = useTranslations('salesInvoices.ai.previous');
  const f = useFormat();
  const [customerId, setCustomerId] = useState('');
  const [copied, setCopied] = useState<{ count: number; rateChanged: number } | null>(null);
  const customers = useQuery(orpc.parties.customers.queryOptions({ input: {} }));
  const previous = useQuery({ ...orpc.einvoice.drafts.previousInvoice.queryOptions({ input: { buyerPartyId: customerId, date } }), enabled: customerId !== '' });
  const invoice = previous.data?.invoice ?? null;
  // The coworker reads the invoice only while it is the one on screen.
  const draftId = customerId !== '' && invoice ? invoice.draftId : null;
  useLayoutEffect(() => {
    onPicked(draftId);
  }, [draftId, onPicked]);
  return (
    <div className="mt-3 space-y-2 rounded-lg border border-border p-3" data-testid="invoice-previous">
      <Label htmlFor="sales-invoice-previous">{t('label')}</Label>
      <NativeSelect
        id="sales-invoice-previous"
        value={customerId}
        onChange={(e) => {
          setCustomerId(e.target.value);
          setCopied(null);
        }}
        data-testid="invoice-previous-customer"
      >
        <NativeSelectOption value="">{t('choose')}</NativeSelectOption>
        {(customers.data?.items ?? []).map((c) => (
          <NativeSelectOption key={c.id} value={c.id}>
            {c.name}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      {previous.isError && <p className="text-xs text-foreground">{t('failed')}</p>}
      {customerId !== '' && previous.data && !invoice && (
        <p className="text-xs text-subtle-foreground" data-testid="invoice-previous-none">
          {t('none')}
        </p>
      )}
      {invoice && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-foreground" data-testid="invoice-previous-found">
            {invoice.number ? t('found', { number: invoice.number, date: f.date(invoice.date), count: String(invoice.lines.length) }) : t('foundNoNumber', { date: f.date(invoice.date), count: String(invoice.lines.length) })}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => setCopied({ count: invoice.lines.length, rateChanged: onCopy(invoice) })} data-testid="invoice-previous-copy">
            {t('copy')}
          </Button>
        </div>
      )}
      {copied && (
        <p className="text-xs text-foreground" role="status" data-testid="invoice-previous-copied">
          {t('copied', { count: String(copied.count) })} {copied.rateChanged > 0 && t('rateChanged', { count: String(copied.rateChanged) })}
        </p>
      )}
    </div>
  );
}

/** The coworker's box on the draft form (#2505): a person pastes or types a text about the sale, and the coworker proposes the lines, the VAT rate the text states and the buyer. The form works the same
 * with AI off; a proposal only fills the fields, marked as the coworker's, and issuing keeps its own approval. */
function CoworkerBox({ date, room, invoiceDraftId, onProposal }: { date: string; room: number; invoiceDraftId: string | null; onProposal: (proposal: EInvoiceSuggested) => void }) {
  const t = useTranslations('salesInvoices.ai');
  const tp = useTranslations('salesInvoices.ai.previous');
  const [text, setText] = useState('');
  const current = useRef(date);
  // Written after the commit, not during render: a render React discards must not leave its date behind.
  useLayoutEffect(() => {
    current.current = date;
  }, [date]);
  const [state, setState] = useState<'filled' | 'partial' | 'stale' | Exclude<EInvoiceSuggested['ai'], 'used'> | null>(null);
  const ask = useMutation({
    // The date the request was made for travels in the mutation's variables: the options of a request still pending are replaced on every render, so a date taken from the closure could already be the new one.
    mutationFn: (asked: string) => client.einvoice.drafts.suggest({ text: text.trim(), date: asked === '' ? vietnamToday() : asked, ...(invoiceDraftId ? { invoiceDraftId } : {}) }),
    onSuccess: (proposal, asked) => {
      // The VAT rates were checked for the date asked with: if the invoice date was changed meanwhile, nothing is filled.
      if (proposal.ai === 'used' && current.current !== asked) {
        setState('stale');
        return;
      }
      if (proposal.ai === 'used') onProposal(proposal);
      setState(proposal.ai === 'used' ? (proposal.lines.length > room ? 'partial' : 'filled') : proposal.ai);
    },
  });
  return (
    <div className="mt-3 space-y-2 rounded-lg border border-dashed border-proposal/60 p-3" data-testid="invoice-ai">
      <Label htmlFor="sales-invoice-ai-text">{t('label')}</Label>
      <Textarea id="sales-invoice-ai-text" rows={2} value={text} maxLength={EINVOICE_SUGGEST_TEXT_MAX} placeholder={t('placeholder')} onChange={(e) => setText(e.target.value)} data-testid="invoice-ai-text" />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" loading={ask.isPending} disabled={text.trim() === '' || ask.isPending} onClick={() => ask.mutate(date)} data-testid="invoice-ai-ask">
          {t('button')}
        </Button>
        <p className="text-xs text-subtle-foreground">{t('hint')}</p>
        {invoiceDraftId && <p className="text-xs text-subtle-foreground" data-testid="invoice-ai-source">{tp('askNote')}</p>}
      </div>
      {state !== null && (
        <p className="text-xs text-foreground" role="status" data-testid="invoice-ai-state" data-state={state}>
          {t(`state.${state}`)}
        </p>
      )}
      {ask.error && <ErrorText>{errorMessage(ask.error)}</ErrorText>}
    </div>
  );
}

function DraftForm({ initial, series, legalEntityId, onClose }: { initial: FormState; series: Array<{ id: string; templateNo: string; symbol: string; description: string }>; legalEntityId: string | undefined; onClose: () => void }) {
  const t = useTranslations('salesInvoices');
  const f = useFormat();
  const [form, setForm] = useState(initial);
  const [sourceInvoice, setSourceInvoice] = useState<string | null>(null);
  const deferred = useDeferredValue(form);
  const input = useMemo(() => toInput(deferred), [deferred]);
  const check = useQuery({ ...orpc.einvoice.drafts.check.queryOptions({ input }), placeholderData: (previous) => previous });
  const save = useMutation({
    mutationFn: () => client.einvoice.drafts.save({ ...toInput(form), draftId: form.draftId, legalEntityId: legalEntityId ?? null }),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });
  const issues = check.data?.issues ?? [];
  // What cannot be stored yet (a date, a quantity or a price that is not a value): the rest is saved with its issues shown.
  const unsaveable = issues.some((i) => (['DATE_REQUIRED', 'DATE_INVALID', 'LINE_QUANTITY_INVALID', 'LINE_PRICE_INVALID'] as const).some((c) => c === i.code)) || check.data === undefined;
  const bad = (field: string) => issues.some((i) => i.field === field);
  const setBuyer = (patch: Partial<FormState['buyer']>) => setForm((s) => ({ ...s, buyerAi: false, buyer: { ...s.buyer, ...patch } }));
  // An edit makes the line the person's own: it loses the coworker's mark.
  const setLine = (index: number, patch: Partial<LineState>) => setForm((s) => ({ ...s, lines: s.lines.map((l, i) => (i === index ? { ...l, ai: null, ...patch } : l)) }));
  const id = 'sales-invoice';
  const buyer = form.buyer;
  return (
    <Card className="mb-6 block p-4" aria-label={t('formTitle')} data-testid="invoice-form">
      <h2 className="text-base font-medium text-foreground">{form.draftId ? t('editTitle') : t('newTitle')}</h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor={`${id}-date`}>{t('date')}</Label>
          <DateInput id={`${id}-date`} value={form.date} max={vietnamToday()} aria-invalid={bad('date')} onChange={(date) => setForm((s) => ({ ...s, date }))} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-series`}>{t('series')}</Label>
          <NativeSelect id={`${id}-series`} value={form.seriesId} aria-invalid={bad('series')} onChange={(e) => setForm((s) => ({ ...s, seriesId: e.target.value }))}>
            <NativeSelectOption value="">{t('seriesChoose')}</NativeSelectOption>
            {series.map((s) => (
              <NativeSelectOption key={s.id} value={s.id}>
                {s.templateNo}/{s.symbol} {s.description}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-kind`}>{t('buyerKind')}</Label>
          <NativeSelect id={`${id}-kind`} value={buyer.kind} onChange={(e) => setBuyer({ kind: e.target.value as BuyerKind })}>
            {BUYER_KINDS.map((k) => (
              <NativeSelectOption key={k} value={k}>
                {t(`kinds.${k}`)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      </div>
      <PreviousInvoice
        date={form.date}
        onPicked={setSourceInvoice}
        onCopy={(invoice) => {
          const done = applyPrevious(form, invoice);
          setForm(done.state);
          return done.rateChanged;
        }}
      />
      <CoworkerBox date={form.date} room={EINVOICE_DRAFT_MAX_LINES - form.lines.filter((l) => !isBlankLine(l)).length} invoiceDraftId={sourceInvoice} onProposal={(proposal) => setForm((s) => applySuggestion(s, proposal))} />
      {form.buyerAi && (
        <p className="mt-3 text-xs text-subtle-foreground" data-testid="invoice-buyer-ai">
          <Badge variant="proposal">{t('ai.badge')}</Badge> <span className="ml-1">{t('ai.buyerNote')}</span>
        </p>
      )}
      {buyer.kind !== 'consumer' && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor={`${id}-tax`}>{t('taxCode')}</Label>
            <Input id={`${id}-tax`} value={buyer.taxCode} maxLength={20} inputMode="numeric" aria-invalid={bad('buyer.taxCode')} onChange={(e) => setBuyer({ taxCode: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-name`}>{t('buyerName')}</Label>
            <Input id={`${id}-name`} value={buyer.name} maxLength={400} aria-invalid={bad('buyer.name')} onChange={(e) => setBuyer({ name: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-address`}>{t('address')}</Label>
            <Input id={`${id}-address`} value={buyer.address} maxLength={500} aria-invalid={bad('buyer.address')} onChange={(e) => setBuyer({ address: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-email`}>{t('email')}</Label>
            <Input id={`${id}-email`} type="email" value={buyer.email} maxLength={254} aria-invalid={bad('buyer.email')} onChange={(e) => setBuyer({ email: e.target.value })} />
          </div>
        </div>
      )}
      {buyer.kind === 'consumer' && <p className="mt-3 text-xs text-subtle-foreground">{t('consumerHint')}</p>}

      <div className="mt-4 space-y-2">
        <h3 className="text-sm font-medium text-foreground">{t('lines')}</h3>
        {form.lines.map((line, index) => {
          const at = (key: string) => `lines.${index + 1}.${key}`;
          const computed = check.data?.lines[index];
          return (
            <div key={index}>
            <div className={`grid items-end gap-2 sm:grid-cols-[2fr_0.6fr_0.8fr_1fr_0.8fr_1fr_auto]${line.ai !== null ? ' rounded-md border border-dashed border-proposal/60 p-2' : ''}`} data-testid="invoice-line">
              <div className="space-y-1">
                <Label htmlFor={`${id}-d${index}`} className={index === 0 ? undefined : 'sr-only'}>
                  {t('description')}
                </Label>
                <Input id={`${id}-d${index}`} value={line.description} maxLength={500} aria-invalid={bad(at('description'))} onChange={(e) => setLine(index, { description: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${id}-u${index}`} className={index === 0 ? undefined : 'sr-only'}>
                  {t('unit')}
                </Label>
                <Input id={`${id}-u${index}`} value={line.unit} maxLength={50} onChange={(e) => setLine(index, { unit: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${id}-q${index}`} className={index === 0 ? undefined : 'sr-only'}>
                  {t('quantity')}
                </Label>
                <Input id={`${id}-q${index}`} value={line.quantity} inputMode="decimal" aria-invalid={bad(at('quantity'))} onChange={(e) => setLine(index, { quantity: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${id}-p${index}`} className={index === 0 ? undefined : 'sr-only'}>
                  {t('unitPrice')}
                </Label>
                <Input id={`${id}-p${index}`} value={line.unitPrice} inputMode="decimal" aria-invalid={bad(at('unitPrice'))} onChange={(e) => setLine(index, { unitPrice: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${id}-v${index}`} className={index === 0 ? undefined : 'sr-only'}>
                  {t('vatRate')}
                </Label>
                <NativeSelect id={`${id}-v${index}`} value={line.vatRate} aria-invalid={bad(at('vatRate'))} onChange={(e) => setLine(index, { vatRate: e.target.value })}>
                  {VAT_RATES.map((r) => (
                    <NativeSelectOption key={r} value={r}>
                      {r === 'KCT' ? t('vatExempt') : r === 'KKKNT' ? t('vatUndeclared') : r}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
              <p className="pb-2 text-right text-sm tabular-nums" aria-label={t('lineAmount')} data-testid="invoice-line-amount">
                {computed ? f.money(computed.amount, 'VND') : ''}
              </p>
              <Button variant="ghost" size="sm" disabled={form.lines.length === 1} onClick={() => setForm((s) => ({ ...s, lines: s.lines.filter((_, i) => i !== index) }))} aria-label={t('removeLine', { n: String(index + 1) })}>
                {t('remove')}
              </Button>
            </div>
            {line.ai !== null && (
              <p className="mt-1 text-xs text-subtle-foreground" data-testid="invoice-line-ai">
                <Badge variant="proposal">{t('ai.badge')}</Badge> <span className="ml-1">{t(`ai.vatFrom.${line.ai}`)}</span>
              </p>
            )}
            </div>
          );
        })}
        <Button variant="outline" size="sm" disabled={form.lines.length >= EINVOICE_DRAFT_MAX_LINES} onClick={() => setForm((s) => ({ ...s, lines: [...s.lines, blankLine()] }))} data-testid="invoice-add-line">
          {t('addLine')}
        </Button>
      </div>

      <dl className="mt-4 grid max-w-sm gap-1 text-sm" data-testid="invoice-totals">
        <div className="flex justify-between gap-4">
          <dt className="text-subtle-foreground">{t('subtotal')}</dt>
          <dd className="tabular-nums">{check.data ? f.money(check.data.subtotal, 'VND') : ''}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-subtle-foreground">{t('vat')}</dt>
          <dd className="tabular-nums">{check.data ? f.money(check.data.vatAmount, 'VND') : ''}</dd>
        </div>
        <div className="flex justify-between gap-4 font-medium">
          <dt>{t('total')}</dt>
          <dd className="tabular-nums" data-testid="invoice-total">
            {check.data ? f.money(check.data.total, 'VND') : ''}
          </dd>
        </div>
      </dl>
      <p className="mt-1 text-xs text-subtle-foreground">{t('computedHint')}</p>

      {issues.length > 0 && (
        <Alert className="mt-3" data-testid="invoice-issues">
          <AlertDescription>
            <p className="font-medium">{t('issuesTitle', { count: String(issues.length) })}</p>
            <ul className="mt-1 list-disc pl-5">
              {issues.map((issue, i) => (
                <li key={`${issue.field}-${issue.code}-${i}`}>{t(`issues.${issue.code satisfies DraftIssueCode}`, { line: /^lines\.(\d+)\./.exec(issue.field)?.[1] ?? '' })}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      {check.error && <ErrorText>{errorMessage(check.error)}</ErrorText>}
      {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button loading={save.isPending} disabled={unsaveable} onClick={() => save.mutate()} data-testid="invoice-save">
          {t('save')}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {t('cancel')}
        </Button>
      </div>
      <p className="mt-3 text-xs text-subtle-foreground">{t('notIssued')}</p>
    </Card>
  );
}

// The codes the draft's `errorCode` can hold, in words (never a provider's own text).
const DRAFT_ERRORS = [
  'PROVIDER_NOT_READY',
  'TAX_CODE_NEEDED',
  'SELLER_TAX_CODE_CHANGED',
  'DRAFT_MISMATCH',
  'CREDENTIALS',
  'PROVIDER_UNAVAILABLE',
  'STATUS_UNKNOWN',
  'REJECTED_INVALID_DATA',
  'REJECTED_SERIES_UNKNOWN',
  'REJECTED_BY_TAX_AUTHORITY',
  'REJECTED_BY_PROVIDER',
  'FILES_UNAVAILABLE',
] as const;
type DraftErrorCode = (typeof DRAFT_ERRORS)[number];
const isDraftError = (code: string): code is DraftErrorCode => (DRAFT_ERRORS as readonly string[]).includes(code);

// Asking to issue a draft (ADR-0044 point 3): the request is made here and the approval is an owner's or an admin's, who may be the one asking when nobody else can
// approve (the one-person path). The approval needs a fresh second factor; where another person must approve, the request waits in the Inbox.
function IssueAction({ draft, canApprove }: { draft: EInvoiceDraftSummary; canApprove: boolean }) {
  const t = useTranslations('salesInvoices');
  const f = useFormat();
  const [requestKey] = useState(() => crypto.randomUUID());
  const [approveKey] = useState(() => crypto.randomUUID());
  const [proposalId, setProposalId] = useState<string | null>(null);
  const [notice, setNotice] = useState<'awaiting' | 'sent' | null>(null);
  const approve = useMutation({
    mutationFn: (id: string) => client.inbox.approve({ id, revision: 1, idempotencyKey: approveKey }),
    onSuccess: async () => {
      setNotice('sent');
      await refresh();
    },
    onError: (error) => {
      // Someone else has to approve (four-eyes, or not an approver): the request stays in the Inbox for them.
      const code = (error as { code?: string } | null)?.code;
      if (code === 'FOUR_EYES_REQUIRED' || code === 'NOT_ELIGIBLE') setNotice('awaiting');
    },
  });
  const request = useMutation({
    mutationFn: () => client.inbox.request({ command: 'finance.einvoice.issue', input: { draftId: draft.id }, idempotencyKey: requestKey }),
    onSuccess: (result) => {
      setProposalId(result.proposalId);
      if (canApprove) approve.mutate(result.proposalId);
      else setNotice('awaiting');
    },
  });
  const stepUp = approve.error !== null && isStepUpRequired(approve.error) && proposalId !== null;
  const busy = request.isPending || approve.isPending;
  return (
    <div className="mt-2" data-testid="invoice-issue">
      {notice === null && !stepUp && (
        <Button size="sm" loading={busy} disabled={busy} onClick={() => (proposalId !== null && canApprove ? approve.mutate(proposalId) : request.mutate())} data-testid="invoice-issue-button" title={t('issueHint')}>
          {t('issue')}
        </Button>
      )}
      {stepUp && proposalId !== null && <StepUpPrompt action={t('issueStepUp', { total: f.money(draft.total, 'VND') })} onVerified={() => approve.mutate(proposalId)} onCancel={() => approve.reset()} />}
      {notice === 'awaiting' && <p className="text-xs text-subtle-foreground" data-testid="invoice-issue-awaiting">{t('issueAwaiting')}</p>}
      {notice === 'sent' && <p className="text-xs text-subtle-foreground" data-testid="invoice-issue-sent">{t('issueSent')}</p>}
      {request.error && <ErrorText>{errorMessage(request.error)}</ErrorText>}
      {approve.error && !stepUp && notice === null && <ErrorText>{errorMessage(approve.error)}</ErrorText>}
    </div>
  );
}

// The words of what stopped a draft, or null.
function DraftNote({ draft }: { draft: EInvoiceDraftSummary }) {
  const t = useTranslations('salesInvoices');
  if (draft.errorCode === null) return null;
  return (
    <p className="mt-1 text-xs text-warning" data-testid="invoice-error">
      {isDraftError(draft.errorCode) ? t(`draftErrors.${draft.errorCode}`) : draft.errorCode}
    </p>
  );
}

export function SalesInvoicesPage() {
  const t = useTranslations('salesInvoices');
  const f = useFormat();
  const entity = useChosenEntity();
  const org = useQuery(orpc.org.get.queryOptions());
  const canWrite = org.data?.role === 'owner' || org.data?.role === 'admin' || org.data?.role === 'member';
  const canSync = org.data?.role === 'owner' || org.data?.role === 'admin';
  // Owners and admins approve an issue (the one who asked too, when nobody else can); a member asks and an approver decides in the Inbox.
  const canApprove = canSync;
  const status = useQuery(orpc.einvoice.status.queryOptions());
  const seriesQuery = useQuery(orpc.einvoice.series.list.queryOptions());
  // An invoice on its way (being sent, waiting for the tax authority, issued with its original still to store) is looked at again every few seconds, until it settles.
  const drafts = useQuery({
    ...orpc.einvoice.drafts.list.queryOptions({ input: { legalEntityId: entity.legalEntityId } }),
    enabled: entity.ready,
    refetchInterval: (query) => (query.state.data?.some((d) => d.state === 'submitting' || d.state === 'pending' || (d.state === 'issued' && !d.evidenceStored)) ? 3000 : false),
  });
  const [editing, setEditing] = useState<FormState | null>(null);
  const sync = useMutation({ mutationFn: () => client.einvoice.series.sync({ legalEntityId: entity.legalEntityId ?? null, provider: 'sandbox' }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (draftId: string) => client.einvoice.drafts.delete({ draftId }), onSuccess: refresh });
  // The series of the entity on screen; an entity with none yet sees none (a series belongs to one entity).
  const series = (seriesQuery.data ?? []).filter((s) => entity.legalEntityId === undefined || s.legalEntityId === entity.legalEntityId);
  const defaultSeries = series.find((s) => s.isDefault) ?? series[0];
  const open = async (draftId: string | null) => {
    if (draftId === null) {
      setEditing(blankForm(defaultSeries?.id ?? ''));
      return;
    }
    setEditing(fromDraft(await client.einvoice.drafts.get({ draftId })));
  };

  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          canWrite ? (
            <Button disabled={editing !== null} onClick={() => void open(null)} data-testid="invoice-new">
              {t('new')}
            </Button>
          ) : undefined
        }
      />
      {series.length === 0 && !seriesQuery.isPending && (
        <Card className="mb-4 block p-4" data-testid="invoice-no-series">
          <p className="text-sm text-foreground">{t('noSeries')}</p>
          {status.data?.sandbox && canSync && (
            <Button className="mt-3" variant="outline" size="sm" loading={sync.isPending} onClick={() => sync.mutate()} data-testid="invoice-sync">
              {t('syncSandbox')}
            </Button>
          )}
          {!status.data?.sandbox && <p className="mt-2 text-xs text-subtle-foreground">{t('noProvider')}</p>}
          {sync.error && <ErrorText>{errorMessage(sync.error)}</ErrorText>}
        </Card>
      )}
      {editing && <DraftForm key={editing.draftId ?? 'new'} initial={editing} series={series} legalEntityId={entity.legalEntityId} onClose={() => setEditing(null)} />}
      {drafts.isPending ? (
        <TableSkeleton columns={5} />
      ) : drafts.error ? (
        <ErrorText>{errorMessage(drafts.error)}</ErrorText>
      ) : drafts.data.length === 0 ? (
        <Empty title={t('empty')} hint={t('emptyHint')} />
      ) : (
        <DataTable head={[t('date'), t('buyer'), t('total'), t('status'), '']} numeric={[2]}>
          {drafts.data.map((d) => (
            <TableRow key={d.id} data-testid="invoice-draft">
              <TableCell className="px-4 py-3">{f.date(d.date)}</TableCell>
              <TableCell className="px-4 py-3">{d.buyerName ?? t('consumerName')}</TableCell>
              <TableCell className={NUM}>{f.money(d.total, 'VND')}</TableCell>
              <TableCell className="px-4 py-3">
                <Badge variant="secondary">{t(STATE_KEY[d.state as keyof typeof STATE_KEY] ?? 'states.failed')}</Badge>
                {d.issuedNumber !== null && <span className="ml-2 text-xs text-subtle-foreground">{t('issuedNumber', { number: d.issuedNumber })}</span>}
                {d.state === 'issued' && !d.evidenceStored && <span className="ml-2 text-xs text-subtle-foreground">{t('evidencePending')}</span>}
                {d.issueCount > 0 && <span className="ml-2 text-xs text-subtle-foreground">{t('issueCount', { count: String(d.issueCount) })}</span>}
                <DraftNote draft={d} />
                {/* Issuing needs a provider this deployment has switched on: with none, the request would be approved and nothing would send it. */}
                {canWrite && d.state === 'draft' && d.issueCount === 0 && status.data?.sandbox && <IssueAction key={`${d.id}:${d.updatedAt}`} draft={d} canApprove={canApprove} />}
              </TableCell>
              <TableCell className="px-4 py-3 text-right">
                {canWrite && d.state === 'draft' && (
                  <span className="flex justify-end gap-1">
                    <Button variant="ghost" size="sm" disabled={editing !== null} onClick={() => void open(d.id)} data-testid="invoice-edit">
                      {t('edit')}
                    </Button>
                    <Button variant="ghost" size="sm" loading={remove.isPending && remove.variables === d.id} onClick={() => remove.mutate(d.id)} data-testid="invoice-delete">
                      {t('delete')}
                    </Button>
                  </span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </DataTable>
      )}
      {remove.error && <ErrorText>{errorMessage(remove.error)}</ErrorText>}
    </>
  );
}
