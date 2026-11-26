// SPDX-License-Identifier: AGPL-3.0-only
// Sales e-invoice drafts ("Hóa đơn bán ra", #2500, ADR-0044): the drafts of the invoices a business will issue, made, checked and edited here. Nothing is
// issued and no provider is called from this screen yet: a draft is a working copy. The amounts are the server's, computed from the lines (the form has no
// total to type), and the checks of the invoice's required fields show on the fields as the draft is typed.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { BUYER_IDENTITY_KINDS, BUYER_KINDS, EINVOICE_DRAFT_MAX_LINES, EINVOICE_RATE_NATURES, EINVOICE_SUGGEST_TEXT_MAX, vietnamToday, type BuyerIdentityKind, type BuyerKind, type DraftIssueCode, EINVOICE_NOTICE_FIELDS, einvoiceNoticeText, type EInvoiceCorrection, type EInvoiceCorrectionKind, type EInvoiceNotice, type EInvoiceNoticeField, type EInvoiceNoticeList, type EInvoiceNoticeStep, type EInvoiceRateNature, type EInvoiceReasonSuggested, type EInvoiceDraft, type EInvoiceDraftForm, type EInvoiceDraftSummary, type EInvoicePrevious, type EInvoiceSuggested } from '@ludy/kernel-contract';
import { Alert, AlertDescription } from '@ludy/ui/components/alert';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Card } from '@ludy/ui/components/card';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { Textarea } from '@ludy/ui/components/textarea';
import { TableCell, TableRow } from '@ludy/ui/components/table';
import { DateInput } from '../components/date-input.tsx';
import { useChosenEntity } from '../components/entity-switcher.tsx';
import { DataTable, Empty, ErrorText, FieldError, fieldControl, fieldHintId, PageHeader, TableSkeleton } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { StepUpPrompt } from '../components/two-factor.tsx';
import { reasonButtonOff, reasonFill } from '../lib/einvoice-reason.ts';
import { applyPrevious } from '../lib/invoice-copy.ts';
import { appendSource, bookingDay, bookingSourceText, dealSourceText } from '../lib/invoice-crm-source.ts';
import { ClientError, client, errorMessage, getCurrentOrg, isStepUpRequired, orpc, queryClient, uploadAgreement } from '../lib/api.ts';
import { installedModules, useModulesVersion } from '../lib/org-modules.ts';
import { formatSalesInvoicePrefillDescription, type SalesInvoiceHandoffSearch } from '../lib/project-acceptance-pdf.ts';

const NUM = 'text-right tabular-nums';
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
  // The day of the sale when it is not the invoice's day ('' is the same day), and the reason for an invoice later than the sale's next working day (#3535).
  saleDate: string;
  lateReason: string;
  seriesId: string;
  // Set when the draft is an adjusting or a replacing invoice (#2504): the form says so, and an adjustment may carry a negative price.
  correction: EInvoiceCorrection | null;
  // An individual's identity, one of CCCD, passport or budget code ('' is none); never sent for another kind of buyer.
  buyer: { kind: BuyerKind; partyId: string | null; taxCode: string; name: string; address: string; email: string; identityKind: BuyerIdentityKind | ''; identity: string; nationality: string };
  lines: LineState[];
}

const blankLine = (): LineState => ({ description: '', unit: '', quantity: '1', unitPrice: '', vatRate: '10%', ai: null });
const blankForm = (seriesId: string): FormState => ({ draftId: null, buyerAi: false, date: vietnamToday(), saleDate: '', lateReason: '', seriesId, correction: null, buyer: { kind: 'business', partyId: null, taxCode: '', name: '', address: '', email: '', identityKind: '', identity: '', nationality: '' }, lines: [blankLine()] });
const fromDraft = (d: EInvoiceDraft): FormState => ({
  draftId: d.id,
  buyerAi: false,
  date: d.date,
  saleDate: d.saleDate ?? '',
  lateReason: d.lateReason ?? '',
  seriesId: d.seriesId ?? '',
  correction: d.correction,
  buyer: { kind: d.buyer.kind as BuyerKind, partyId: d.buyer.partyId, taxCode: d.buyer.taxCode ?? '', name: d.buyer.name ?? '', address: d.buyer.address ?? '', email: d.buyer.email ?? '', identityKind: d.buyer.identity?.kind ?? '', identity: d.buyer.identity?.value ?? '', nationality: d.buyer.identity?.nationality ?? '' },
  lines: d.lines.map((l) => ({ description: l.description, unit: l.unit ?? '', quantity: l.quantity, unitPrice: l.unitPrice, vatRate: l.vatRate, ai: null })),
});
const orNull = (value: string): string | null => (value.trim() === '' ? null : value.trim());
// The form as the server takes it. A quantity or price that is not yet a number goes as typed, and the server's check says so on the field.
const toInput = (s: FormState): EInvoiceDraftForm => ({
  date: s.date,
  saleDate: s.saleDate === '' ? null : s.saleDate,
  lateReason: orNull(s.lateReason),
  seriesId: s.seriesId === '' ? null : s.seriesId,
  // A sale to a consumer carries no buyer details: what the form held before the kind was chosen is not sent.
  buyer:
    s.buyer.kind === 'consumer'
      ? { kind: 'consumer', partyId: null, taxCode: null, name: null, address: null, email: null, identity: null }
      : {
          kind: s.buyer.kind,
          partyId: s.buyer.partyId,
          taxCode: orNull(s.buyer.taxCode),
          name: orNull(s.buyer.name),
          address: orNull(s.buyer.address),
          email: orNull(s.buyer.email),
          // Only an individual has one; a business keeps its tax code.
          // A passport carries the buyer's nationality (#3709), written in capitals; no other identity does.
          identity:
            s.buyer.kind === 'individual' && s.buyer.identityKind !== '' && orNull(s.buyer.identity) !== null
              ? { kind: s.buyer.identityKind, value: s.buyer.identity.trim(), nationality: s.buyer.identityKind === 'passport' ? (orNull(s.buyer.nationality)?.toUpperCase() ?? null) : null }
              : null,
        },
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
  const buyerEmpty = b.partyId === null && b.taxCode.trim() === '' && b.name.trim() === '' && b.address.trim() === '' && b.email.trim() === '' && b.identityKind === '' && b.identity.trim() === '';
  // A person who chose a consumer sale keeps it: the coworker's customer does not replace the choice.
  const buyer = proposal.buyer !== null && buyerEmpty && b.kind !== 'consumer' ? proposal.buyer : null;
  return {
    ...s,
    lines: lines.length > 0 ? lines : s.lines,
    ...(buyer ? { buyerAi: true, buyer: { kind: buyer.kind, partyId: buyer.partyId, taxCode: buyer.taxCode ?? '', name: buyer.name ?? '', address: buyer.address ?? '', email: buyer.email ?? '', identityKind: '', identity: '', nationality: '' } } : {}),
  };
}

/** The "previous invoice" source of the draft form (#2721): a person picks a customer, sees the last invoice issued to them, and either copies its lines (by code, works with AI off) or lets the coworker
 * read those lines together with the text. Reading goes through the person's own finance permission; nothing is saved or issued here. */
function PreviousInvoice({ date, legalEntityId, onCopy, onPicked }: { date: string; legalEntityId: string | undefined; onCopy: (invoice: NonNullable<EInvoicePrevious['invoice']>) => { added: number; rateChanged: number }; onPicked: (source: { draftId: string; buyerPartyId: string } | null) => void }) {
  const t = useTranslations('salesInvoices.ai.previous');
  const f = useFormat();
  const [customerId, setCustomerId] = useState('');
  const [copied, setCopied] = useState<{ draftId: string; count: number; rateChanged: number } | null>(null);
  const customers = useQuery(orpc.parties.customers.queryOptions({ input: {} }));
  const previous = useQuery({ ...orpc.einvoice.drafts.previousInvoice.queryOptions({ input: { buyerPartyId: customerId, date, ...(legalEntityId ? { legalEntityId } : {}) } }), enabled: customerId !== '' && date !== '' });
  const invoice = previous.data?.invoice ?? null;
  // The coworker reads the invoice only while it is the one on screen.
  const draftId = customerId !== '' && invoice ? invoice.draftId : null;
  useLayoutEffect(() => {
    onPicked(draftId === null ? null : { draftId, buyerPartyId: customerId });
  }, [draftId, customerId, onPicked]);
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
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={copied?.draftId === invoice.draftId}
            onClick={() => {
              const done = onCopy(invoice);
              setCopied({ draftId: invoice.draftId, count: done.added, rateChanged: done.rateChanged });
            }}
            data-testid="invoice-previous-copy"
          >
            {t('copy')}
          </Button>
        </div>
      )}
      {copied && copied.draftId === invoice?.draftId && (
        <p className="text-xs text-foreground" role="status" data-testid="invoice-previous-copied">
          {t('copied', { count: String(copied.count) })} {copied.rateChanged > 0 && t('rateChanged', { count: String(copied.rateChanged) })}
        </p>
      )}
    </div>
  );
}

/** The deal and booking sources of the draft form (#2721): where the CRM is installed, a person picks one of the open deals or a past booking, and a sentence about it is added to the coworker's text box, where it
 * can be read and edited before asking. It reads only through the CRM's own queries under the person's own CRM permission; a query that is refused or fails hides the list. Nothing is saved or issued here. */
function CrmSource({ onAdd }: { onAdd: (sentence: string) => void }) {
  const t = useTranslations('salesInvoices.ai.crm');
  const f = useFormat();
  useModulesVersion(); // the apps of the org can change while this screen is open
  const installed = installedModules().includes('crm');
  const deals = useQuery({ ...orpc.crm.deals.list.queryOptions({ input: { status: 'open', limit: 50 } }), enabled: installed, retry: false });
  const bookings = useQuery({ ...orpc.crm.bookings.list.queryOptions({ input: { scope: 'mine', period: 'past' } }), enabled: installed, retry: false });
  const dealItems = deals.data?.items ?? [];
  const bookingItems = (bookings.data ?? []).filter((b) => b.status === 'confirmed').slice(0, 50);
  if (!installed || (dealItems.length === 0 && bookingItems.length === 0)) return null;
  return (
    <div className="mt-3 grid gap-3 sm:grid-cols-2" data-testid="invoice-crm">
      {dealItems.length > 0 && (
        <div className="space-y-1">
          <Label htmlFor="sales-invoice-deal">{t('deal')}</Label>
          <NativeSelect
            id="sales-invoice-deal"
            value=""
            onChange={(e) => {
              const deal = dealItems.find((d) => d.id === e.target.value);
              if (deal) onAdd(dealSourceText(deal));
            }}
            data-testid="invoice-crm-deal"
          >
            <NativeSelectOption value="">{t('choose')}</NativeSelectOption>
            {dealItems.map((d) => (
              <NativeSelectOption key={d.id} value={d.id}>
                {d.title} - {d.partyName}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      )}
      {bookingItems.length > 0 && (
        <div className="space-y-1">
          <Label htmlFor="sales-invoice-booking">{t('booking')}</Label>
          <NativeSelect
            id="sales-invoice-booking"
            value=""
            onChange={(e) => {
              const booking = bookingItems.find((b) => b.id === e.target.value);
              if (booking) onAdd(bookingSourceText(booking, f.date(bookingDay(booking.startsAt))));
            }}
            data-testid="invoice-crm-booking"
          >
            <NativeSelectOption value="">{t('choose')}</NativeSelectOption>
            {bookingItems.map((b) => (
              <NativeSelectOption key={b.id} value={b.id}>
                {b.eventType.title} - {f.date(bookingDay(b.startsAt))}
                {b.visitor.name ? ` - ${b.visitor.name}` : ''}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      )}
      <p className="text-xs text-subtle-foreground sm:col-span-2">{t('hint')}</p>
    </div>
  );
}

/** The coworker's box on the draft form (#2505): a person pastes or types a text about the sale, and the coworker proposes the lines, the VAT rate the text states and the buyer. The form works the same
 * with AI off; a proposal only fills the fields, marked as the coworker's, and issuing keeps its own approval. */
export function CoworkerBox({ date, room, legalEntityId, invoiceSource, buyerPartyId, text, onText, onProposal }: { date: string; room: number; legalEntityId: string | undefined; invoiceSource: { draftId: string; buyerPartyId: string } | null; buyerPartyId: string | null; text: string; onText: (text: string) => void; onProposal: (proposal: EInvoiceSuggested) => void }) {
  const t = useTranslations('salesInvoices.ai');
  const tp = useTranslations('salesInvoices.ai.previous');
  const current = useRef(date);
  // Written after the commit, not during render: a render React discards must not leave its date behind.
  useLayoutEffect(() => {
    current.current = date;
  }, [date]);
  const [state, setState] = useState<'filled' | 'partial' | 'stale' | Exclude<EInvoiceSuggested['ai'], 'used'> | null>(null);
  // Clear a previous status note as soon as the source text or invoice date changes (#4119).
  const [tracked, setTracked] = useState({ date, text });
  if (tracked.date !== date || tracked.text !== text) {
    setTracked({ date, text });
    if (state !== null) setState(null);
  }
  const ask = useMutation({
    // The date the request was made for travels in the mutation's variables: the options of a request still pending are replaced on every render, so a date taken from the closure could already be the new one.
    mutationFn: (asked: string) => client.einvoice.drafts.suggest({ text: text.trim(), date: asked === '' ? vietnamToday() : asked, ...(invoiceSource ? { invoiceDraftId: invoiceSource.draftId, buyerPartyId: invoiceSource.buyerPartyId } : {}), ...(buyerPartyId ? { formBuyerPartyId: buyerPartyId } : {}), ...(legalEntityId ? { legalEntityId } : {}) }),
    // Clear any lingering status note when a new request starts so it never shows during the run or beside a request error (#4119).
    onMutate: () => setState(null),
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
  const askRef = useRef(ask);
  useLayoutEffect(() => {
    askRef.current = ask;
  });
  useEffect(() => {
    if (!askRef.current.isPending && askRef.current.isError) askRef.current.reset();
  }, [date, text]);
  return (
    <div className="mt-3 rounded-lg border border-dashed border-proposal/60 p-3" data-testid="invoice-ai">
      <div className="space-y-2">
        <Label htmlFor="sales-invoice-ai-text">{t('label')}</Label>
        {/* Locked while a request is pending (#2713): an answer for the old text would otherwise fill the draft beside a text the person has since changed. */}
        <Textarea id="sales-invoice-ai-text" rows={2} value={text} maxLength={EINVOICE_SUGGEST_TEXT_MAX} placeholder={t('placeholder')} disabled={ask.isPending} onChange={(e) => onText(e.target.value)} data-testid="invoice-ai-text" />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" loading={ask.isPending} disabled={text.trim() === '' || ask.isPending} onClick={() => ask.mutate(date)} data-testid="invoice-ai-ask">
            {t('button')}
          </Button>
          <p className="text-xs text-subtle-foreground">{t('hint')}</p>
          {invoiceSource && <p className="text-xs text-subtle-foreground" data-testid="invoice-ai-source">{tp('askNote')}</p>}
        </div>
      </div>
      {/* Always-mounted live region so screen readers announce every status change while keeping invoice-ai-state absent when cleared. */}
      <div role="status" aria-live="polite">
        {state !== null && (
          <p className="mt-2 text-xs text-foreground" data-testid="invoice-ai-state" data-state={state}>
            {t(`state.${state}`)}
          </p>
        )}
      </div>
      {ask.error && <div className="mt-2"><ErrorText>{errorMessage(ask.error)}</ErrorText></div>}
    </div>
  );
}

// The warning of a sale invoiced after its next working day and the reason it asks for (#3535): the invoice is late, the fine is heavy, and the sale is declared in the period of its sale date.
export function LateSaleNotice({ id, reason, error, onChange }: { id: string; reason: string; error: string | null; onChange: (reason: string) => void }) {
  const t = useTranslations('salesInvoices');
  return (
    <div className="mt-3 space-y-1" role="alert" data-testid="invoice-late-sale">
      <p className="text-sm font-medium text-foreground">{t('lateWarning')}</p>
      <Label htmlFor={`${id}-late-reason`}>{t('lateReason')}</Label>
      <Textarea {...fieldControl(`${id}-late-reason`, { error: error !== null })} rows={2} maxLength={500} value={reason} placeholder={t('lateReasonPlaceholder')} onChange={(e) => onChange(e.target.value)} data-testid="invoice-late-reason" />
      <FieldError id={`${id}-late-reason`}>{error}</FieldError>
    </div>
  );
}

function DraftForm({ initial, series, legalEntityId, originalNumber, handoffPrefill, onClose }: { initial: FormState; originalNumber: string | null; series: Array<{ id: string; templateNo: string; symbol: string; description: string }>; legalEntityId: string | undefined; handoffPrefill?: { active: boolean; reference: string | null }; onClose: () => void }) {
  const t = useTranslations('salesInvoices');
  const f = useFormat();
  const [form, setForm] = useState(initial);
  const [sourceInvoice, setSourceInvoice] = useState<{ draftId: string; buyerPartyId: string } | null>(null);
  const [aiText, setAiText] = useState('');
  // The buyer of the invoice copied last: a second copy replaces that buyer, never one a person typed or a proposal brought.
  const copiedBuyer = useRef<string | null>(null);
  const deferred = useDeferredValue(form);
  const input = useMemo(() => ({ ...toInput(deferred), correction: deferred.correction ? { kind: deferred.correction.kind, originalDraftId: deferred.correction.originalDraftId, rateBasis: deferred.correction.rateBasis } : null }), [deferred]);
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
  const unsaveable = issues.some((i) => (['DATE_REQUIRED', 'DATE_INVALID', 'SALE_DATE_INVALID', 'SALE_DATE_AFTER_INVOICE', 'LINE_QUANTITY_INVALID', 'LINE_PRICE_INVALID', 'BUYER_NATIONALITY_REQUIRED', 'BUYER_NATIONALITY_INVALID'] as const).some((c) => c === i.code)) || check.data === undefined;
  const bad = (field: string) => issues.some((i) => i.field === field);
  // The error of each of the two late-sale fields sits under it and is linked to it, and a field shows only its own (#3535).
  const saleDateIssue = issues.find((i) => i.field === 'saleDate');
  const lateReasonIssue = issues.find((i) => i.field === 'lateReason');
  const setBuyer = (patch: Partial<FormState['buyer']>) => setForm((s) => ({ ...s, buyerAi: false, buyer: { ...s.buyer, ...patch } }));
  // An edit makes the line the person's own: it loses the coworker's mark.
  const setLine = (index: number, patch: Partial<LineState>) => setForm((s) => ({ ...s, lines: s.lines.map((l, i) => (i === index ? { ...l, ai: null, ...patch } : l)) }));
  const id = 'sales-invoice';
  const buyer = form.buyer;
  return (
    <Card className="mb-6 block p-4" aria-label={t('formTitle')} data-testid="invoice-form">
      <h2 className="text-base font-medium text-foreground">{form.draftId ? t('editTitle') : t('newTitle')}</h2>
      {handoffPrefill?.active && (
        <p className="mt-1 text-xs text-muted-foreground" data-testid="invoice-acceptance-prefill-note">
          {handoffPrefill.reference
            ? t('acceptancePrefillNote', { reference: handoffPrefill.reference })
            : t('acceptancePrefillNoteNoRef')}
        </p>
      )}
      {form.correction && <div className="mt-2"><CorrectionBanner correction={form.correction} originalNumber={originalNumber} /></div>}
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1">
          <Label htmlFor={`${id}-date`}>{t('date')}</Label>
          <DateInput id={`${id}-date`} value={form.date} max={vietnamToday()} aria-invalid={bad('date')} onChange={(date) => setForm((s) => ({ ...s, date }))} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-sale-date`}>{t('saleDate')}</Label>
          <DateInput {...fieldControl(`${id}-sale-date`, { hint: true, error: saleDateIssue !== undefined })} value={form.saleDate} max={form.date} onChange={(saleDate) => setForm((s) => ({ ...s, saleDate }))} />
          <p id={fieldHintId(`${id}-sale-date`)} className="text-xs text-subtle-foreground">
            {t('saleDateHint')}
          </p>
          <FieldError id={`${id}-sale-date`}>{saleDateIssue ? t(`issues.${saleDateIssue.code satisfies DraftIssueCode}`, { line: '' }) : null}</FieldError>
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
      {check.data?.lateSale && <LateSaleNotice id={id} reason={form.lateReason} error={lateReasonIssue ? t(`issues.${lateReasonIssue.code satisfies DraftIssueCode}`, { line: '' }) : null} onChange={(lateReason) => setForm((s) => ({ ...s, lateReason }))} />}
      <PreviousInvoice
        date={form.saleDate || form.date}
        legalEntityId={legalEntityId}
        onPicked={setSourceInvoice}
        onCopy={(invoice) => {
          // The counts come from the form as it is now; the form itself changes through the updater, so a proposal that lands in the same tick is not overwritten.
          const replaceBuyerOf = copiedBuyer.current;
          const done = applyPrevious(form, invoice, replaceBuyerOf);
          copiedBuyer.current = invoice.buyer.partyId;
          setForm((s) => applyPrevious(s, invoice, replaceBuyerOf).state);
          return { added: done.added, rateChanged: done.rateChanged };
        }}
      />
      <CrmSource onAdd={(sentence) => setAiText((text) => appendSource(text, sentence, EINVOICE_SUGGEST_TEXT_MAX))} />
      <CoworkerBox date={form.date} room={EINVOICE_DRAFT_MAX_LINES - form.lines.filter((l) => !isBlankLine(l)).length} legalEntityId={legalEntityId} invoiceSource={sourceInvoice} buyerPartyId={form.buyer.kind !== 'consumer' ? form.buyer.partyId : null} text={aiText} onText={setAiText} onProposal={(proposal) => setForm((s) => applySuggestion(s, proposal))} />
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
          {/* An individual may give a personal ID number, a passport number or a budget unit code instead of a tax code (#3678): optional, one at a time. */}
          {buyer.kind === 'individual' && (
            <div className="space-y-1 sm:col-span-2" data-testid="invoice-buyer-identity">
              <Label htmlFor={`${id}-identity`}>{t('identityLabel')}</Label>
              <div className="flex flex-wrap gap-2">
                <NativeSelect aria-label={t('identityKind')} className="w-52" value={buyer.identityKind} onChange={(e) => setBuyer({ identityKind: e.target.value as BuyerIdentityKind | '', ...(e.target.value === '' ? { identity: '' } : {}), ...(e.target.value !== 'passport' ? { nationality: '' } : {}) })}>
                  <NativeSelectOption value="">{t('identityNone')}</NativeSelectOption>
                  {BUYER_IDENTITY_KINDS.map((k) => (
                    <NativeSelectOption key={k} value={k}>
                      {t(`identityKinds.${k}`)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                {buyer.identityKind !== '' && <Input id={`${id}-identity`} className="max-w-xs" value={buyer.identity} maxLength={20} autoComplete="off" aria-invalid={bad('buyer.identity')} onChange={(e) => setBuyer({ identity: e.target.value })} />}
              </div>
              {/* A passport carries the buyer's nationality (Decree 254 Appendix point 4.b, #3709): required with it. */}
              {buyer.identityKind === 'passport' && (
                <div className="space-y-1" data-testid="invoice-buyer-nationality">
                  <Label htmlFor={`${id}-nationality`}>{t('nationalityLabel')}</Label>
                  <Input id={`${id}-nationality`} className="max-w-24 uppercase" value={buyer.nationality} maxLength={2} autoComplete="off" aria-invalid={bad('buyer.nationality')} onChange={(e) => setBuyer({ nationality: e.target.value.toUpperCase() })} />
                  <p className="text-xs text-subtle-foreground">{t('nationalityHint')}</p>
                </div>
              )}
              <p className="text-xs text-subtle-foreground">{t('identityHint')}</p>
            </div>
          )}
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
                <Input id={`${id}-p${index}`} value={line.unitPrice} inputMode={form.correction?.kind === 'adjustment' ? 'text' : 'decimal'} aria-invalid={bad(at('unitPrice'))} onChange={(e) => setLine(index, { unitPrice: e.target.value })} />
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

// What the form of an adjusting or a replacing invoice says about itself (#2504): which invoice it corrects, by which method, and why.
export function CorrectionBanner({ correction, originalNumber }: { correction: EInvoiceCorrection; originalNumber: string | null }) {
  const t = useTranslations('salesInvoices');
  const options = useQuery(orpc.einvoice.drafts.correctionOptions.queryOptions({ input: {} }));
  const label = options.data?.reasonCodes.find((c) => c.code === correction.reasonCode)?.label ?? correction.reasonCode;
  const number = originalNumber ?? '-';
  return (
    <Alert className="mb-3" data-testid="invoice-correction-banner">
      <AlertDescription>
        <p>{correction.kind === 'adjustment' ? t('correction.formAdjustment', { number }) : t('correction.formReplacement', { number })}</p>
        <p className="mt-1 text-xs">{t('correction.formReason', { label })}</p>
        <p className="mt-1 text-xs">{correction.rateBasis === 'correction_date' ? t('correction.formRateCorrectionDate') : t('correction.formRate')}</p>
      </AlertDescription>
    </Alert>
  );
}

// "Điều chỉnh" and "Thay thế" on an issued invoice (#2504). The method of an earlier correction is kept, the reason is one of Appendix XVII's (the list is empty until it is entered, and the
// panel says so), a business buyer needs the signed agreement attached and an individual none. It makes a draft: issuing it is the same request and approval as any invoice. There is no cancel.
export function CorrectionAction({ draft, onStarted, openWith = null }: { draft: EInvoiceDraftSummary; onStarted: (draftId: string) => void; openWith?: EInvoiceCorrectionKind | null }) {
  const t = useTranslations('salesInvoices');
  const id = useId();
  const options = useQuery(orpc.einvoice.drafts.correctionOptions.queryOptions({ input: {} }));
  const [kind, setKind] = useState<EInvoiceCorrectionKind | null>(openWith);
  const [reason, setReason] = useState('');
  // The coworker's proposal of the reason code (#3690): the person describes the error, the select is filled with the code proposed and the why is shown as the coworker's; nothing is saved until the
  // correction is started. Once an answer says the model is off or the AI budget is spent, the button stays off.
  const [errorNote, setErrorNote] = useState('');
  const [reasonAi, setReasonAi] = useState<EInvoiceReasonSuggested['ai'] | null>(null);
  const [reasonWhy, setReasonWhy] = useState<string | null>(null);
  // An answer is for the question it was asked: what the person does meanwhile (picks a reason, edits the note, closes the panel) moves the ticket on, and a late answer is dropped.
  const ticket = useRef(0);
  const suggest = useMutation({
    mutationFn: (variables: { method: EInvoiceCorrectionKind; ticket: number }) => client.einvoice.drafts.suggestReason({ originalDraftId: draft.id, kind: variables.method, note: errorNote.trim() }),
    onMutate: () => setReasonWhy(null),
    onSuccess: (proposal, variables) => {
      if (variables.ticket !== ticket.current) return;
      setReasonAi(proposal.ai);
      // The code is one of the list the select holds; anything else fills nothing.
      const fill = reasonFill(proposal, options.data?.reasonCodes ?? []);
      setReasonWhy(fill?.why ?? null);
      if (fill) setReason(fill.code);
    },
  });
  const [file, setFile] = useState<File | null>(null);
  // What the correction is about decides the VAT rate (#3709): the code proposes the basis for it, the coworker may explain it, and the person confirms before the draft is made.
  const [nature, setNature] = useState<EInvoiceRateNature | ''>('');
  const [rateConfirmed, setRateConfirmed] = useState(false);
  const rate = useQuery({ ...orpc.einvoice.drafts.correctionRate.queryOptions({ input: { originalDraftId: draft.id, nature: nature === '' ? 'no_amount_change' : nature } }), enabled: kind !== null && nature !== '' });
  const proposal = nature !== '' && rate.data?.nature === nature ? rate.data : null;
  const business = draft.buyerKind === 'business';
  const reasons = options.data?.reasonCodes ?? [];
  const start = useMutation({
    mutationFn: async (method: EInvoiceCorrectionKind) => {
      if (nature === '' || proposal === null) throw new ClientError('salesInvoices.correction.rateError', (tr) => tr('salesInvoices.correction.rateError'));
      // The invoice belongs to the organization on screen when the person pressed the button: if it changed while the agreement was uploading, nothing is started (the file is the first
      // organization's, the draft would be made in the second).
      const org = getCurrentOrg();
      const agreementFileId = file ? await uploadAgreement(file) : null;
      if (getCurrentOrg() !== org) throw new ClientError('salesInvoices.correction.orgChanged', (tr) => tr('salesInvoices.correction.orgChanged'));
      return client.einvoice.drafts.startCorrection({ originalDraftId: draft.id, kind: method, reasonCode: reason, agreementFileId, rateNature: nature, rateBasis: proposal.basis });
    },
    onSuccess: async (made) => {
      await refresh();
      setKind(null);
      setFile(null);
      setNature('');
      setRateConfirmed(false);
      ticket.current += 1;
      setErrorNote('');
      setReasonAi(null);
      setReasonWhy(null);
      onStarted(made.id);
    },
  });
  // Nothing corrects an invoice that was replaced, nor an adjusting invoice (it is corrected through the invoice it adjusts).
  if (draft.replaced || draft.correction?.kind === 'adjustment') return null;
  const methods: EInvoiceCorrectionKind[] = draft.correctedBy ? [draft.correctedBy] : ['adjustment', 'replacement'];
  const number = draft.issuedNumber ?? '-';
  return (
    <div className="mt-2" data-testid="invoice-correction">
      {kind === null ? (
        <span className="flex flex-wrap gap-1">
          {methods.map((m) => (
            <Button key={m} variant="outline" size="sm" onClick={() => setKind(m)} data-testid={`invoice-correct-${m}`}>
              {m === 'adjustment' ? t('correction.adjust') : t('correction.replace')}
            </Button>
          ))}
        </span>
      ) : (
        <Card className="block p-3" data-testid="invoice-correction-panel">
          <p className="text-sm font-medium">{kind === 'adjustment' ? t('correction.panelAdjust', { number }) : t('correction.panelReplace', { number })}</p>
          {draft.correctedBy && <p className="mt-1 text-xs text-subtle-foreground">{t('correction.methodKept', { method: draft.correctedBy === 'adjustment' ? t('correction.methodAdjustment') : t('correction.methodReplacement') })}</p>}
          {options.error ? (
            <div className="mt-2" data-testid="invoice-correction-options-error">
              <ErrorText>{errorMessage(options.error)}</ErrorText>
              <p className="text-xs text-subtle-foreground">{t('correction.optionsRetryHint')}</p>
              <Button className="mt-1" size="sm" variant="outline" loading={options.isFetching} onClick={() => void options.refetch()} data-testid="invoice-correction-options-retry">
                {t('correction.optionsRetry')}
              </Button>
            </div>
          ) : options.data && reasons.length === 0 ? (
            <p className="mt-2 text-xs text-warning" data-testid="invoice-correction-no-reasons">{t('correction.reasonEmpty')}</p>
          ) : (
            <div className="mt-2">
              <Label htmlFor={`${id}-reason`}>{t('correction.reason')}</Label>
              <NativeSelect
                id={`${id}-reason`}
                value={reason}
                onChange={(e) => {
                  ticket.current += 1;
                  setReasonWhy(null);
                  setReason(e.target.value);
                }}
                data-testid="invoice-correction-reason"
              >
                <NativeSelectOption value="">{t('correction.reasonPick')}</NativeSelectOption>
                {reasons.map((r) => (
                  <NativeSelectOption key={r.code} value={r.code}>
                    {r.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              {/* "Gợi ý lý do" (#3690): the person says what is wrong and the coworker proposes a code of the list; the person can change it. */}
              <div className="mt-2 space-y-1" data-testid="invoice-correction-reason-ai">
                <Label htmlFor={`${id}-error-note`}>{t('correction.reasonNote')}</Label>
                <Textarea id={`${id}-error-note`} rows={2} maxLength={600} value={errorNote}
                  placeholder={t('correction.reasonNotePlaceholder')}
                  onChange={(e) => {
                    ticket.current += 1;
                    setReasonWhy(null);
                    setErrorNote(e.target.value);
                  }}
                  data-testid="invoice-correction-error-note"
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    loading={suggest.isPending}
                    disabled={reasonButtonOff({ note: errorNote, pending: suggest.isPending, last: reasonAi })}
                    onClick={() => suggest.mutate({ method: kind, ticket: ticket.current })}
                    data-testid="invoice-correction-reason-suggest"
                  >
                    {t('correction.reasonSuggest')}
                  </Button>
                  {reasonAi !== null && reasonAi !== 'used' && (
                    <p className="text-xs text-subtle-foreground" role="status" data-testid="invoice-correction-reason-state" data-state={reasonAi}>
                      {t(`correction.reasonState.${reasonAi}`)}
                    </p>
                  )}
                </div>
                {reasonWhy !== null && (
                  <p className="text-xs text-foreground" role="status" data-testid="invoice-correction-reason-why">
                    {t('ai.reasonWhy', { why: reasonWhy })}
                  </p>
                )}
                {suggest.error && <ErrorText>{errorMessage(suggest.error)}</ErrorText>}
              </div>
            </div>
          )}
          <div className="mt-2">
            {business ? (
              <>
                <Label htmlFor={`${id}-file`}>{t('correction.agreement')}</Label>
                <Input id={`${id}-file`} type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} data-testid="invoice-correction-file" />
                <p className="mt-1 text-xs text-subtle-foreground">{t('correction.agreementHint')}</p>
              </>
            ) : (
              <p className="text-xs text-subtle-foreground">{t('correction.agreementNone')}</p>
            )}
          </div>
          <div className="mt-2" data-testid="invoice-correction-rate">
            <Label htmlFor={`${id}-nature`}>{t('correction.rateNature')}</Label>
            <NativeSelect
              id={`${id}-nature`}
              value={nature}
              onChange={(e) => {
                setNature(e.target.value as EInvoiceRateNature | '');
                setRateConfirmed(false);
              }}
              data-testid="invoice-correction-nature"
            >
              <NativeSelectOption value="">{t('correction.rateNaturePick')}</NativeSelectOption>
              {EINVOICE_RATE_NATURES.map((n) => (
                <NativeSelectOption key={n} value={n}>
                  {t(`correction.rateNatures.${n}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            {nature !== '' && rate.isLoading && <p className="mt-1 text-xs text-subtle-foreground">{t('correction.rateLoading')}</p>}
            {nature !== '' && rate.error && <ErrorText>{t('correction.rateError')}</ErrorText>}
            {proposal && (
              <div className="mt-2 rounded-md border border-border p-2 text-xs" data-testid="invoice-correction-rate-proposal">
                <p className="font-medium">{t('correction.rateProposal')}</p>
                <p className="mt-1">{proposal.changes.length === 0 ? t('correction.rateKept') : proposal.changes.map((c) => t('correction.rateChange', { from: c.from, to: c.to })).join('; ')}</p>
                <p className="mt-1 text-subtle-foreground">{proposal.basis === 'correction_date' ? t('correction.rateByCorrectionDate', { date: proposal.correctionDate }) : t('correction.rateByOriginal', { date: proposal.originalDate })}</p>
                {/* The reason the code wrote: always there, with or without the coworker. */}
                <p className="mt-1" data-testid="invoice-correction-rate-reason">{proposal.reason}</p>
                {proposal.explanation && (
                  <p className="mt-1 text-subtle-foreground" data-testid="invoice-correction-rate-explanation">
                    <span className="font-medium">{t('ai.rateCoworker')}: </span>
                    {proposal.explanation}
                  </p>
                )}
                {proposal.precedentNote && <p className="mt-1 text-subtle-foreground" data-testid="invoice-correction-rate-precedent">{proposal.precedentNote}</p>}
                <label className="mt-2 flex items-start gap-2">
                  <input type="checkbox" checked={rateConfirmed} onChange={(e) => setRateConfirmed(e.target.checked)} data-testid="invoice-correction-rate-confirm" />
                  <span>{t('correction.rateConfirm')}</span>
                </label>
              </div>
            )}
          </div>
          {start.error && <ErrorText>{errorMessage(start.error)}</ErrorText>}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" loading={start.isPending} disabled={reason === '' || (business && file === null) || proposal === null || !rateConfirmed} onClick={() => start.mutate(kind)} data-testid="invoice-correction-start">
              {t('correction.start')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                // Closing forgets the agreement picked: a reopened panel shows an empty picker, so nothing hidden is uploaded.
                setKind(null);
                setFile(null);
                setNature('');
                setRateConfirmed(false);
                ticket.current += 1;
                setReason('');
                setErrorNote('');
                setReasonAi(null);
                setReasonWhy(null);
              }}
            >
              {t('correction.cancel')}
            </Button>
          </div>
          <p className="mt-2 text-xs text-subtle-foreground">{t('correction.noCancel')}</p>
        </Card>
      )}
    </div>
  );
}

const NOTICE_FIELD_KEY = { buyer_name: 'notice.fieldBuyerName', buyer_address: 'notice.fieldBuyerAddress', amount_in_words: 'notice.fieldAmountInWords' } as const;

// One recorded error: the text of the notice to the buyer (built by code, read and sent by the person) and the two steps, each ticked once (#2504).
function NoticeCard({ notice, reference, draftId }: { notice: EInvoiceNotice; reference: EInvoiceNoticeList['reference']; draftId: string }) {
  const t = useTranslations('salesInvoices');
  const [copied, setCopied] = useState(false);
  const text = einvoiceNoticeText({ ...reference, field: notice.field, correctText: notice.correctText });
  const tick = useMutation({
    mutationFn: (step: EInvoiceNoticeStep) => client.einvoice.drafts.noticeStep({ noticeId: notice.id, step }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.einvoice.drafts.noticeList.key({ input: { draftId } }) }),
  });
  const copy = () => {
    // The clipboard can be refused (an older app view); the text stays selectable in the box.
    void navigator.clipboard.writeText(text).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };
  return (
    <div className="mt-2 rounded-md border border-border p-3" data-testid="invoice-notice">
      <p className="text-sm font-medium">
        {t(NOTICE_FIELD_KEY[notice.field])}: {notice.correctText}
      </p>
      <Label htmlFor={`notice-${notice.id}`} className="mt-2 block text-xs">
        {t('notice.textLabel')}
      </Label>
      <Textarea id={`notice-${notice.id}`} readOnly rows={7} value={text} data-testid="invoice-notice-text" />
      <p className="mt-1 text-xs text-subtle-foreground">{reference.buyerEmail ? t('notice.buyerEmail', { email: reference.buyerEmail }) : t('notice.noEmail')}</p>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={copy}>
          {copied ? t('notice.copied') : t('notice.copy')}
        </Button>
        <span className="text-xs text-subtle-foreground">{t('notice.notSent')}</span>
      </div>
      <ul className="mt-3 space-y-2">
        <li className="flex flex-wrap items-center gap-2" data-testid="invoice-notice-step-buyer">
          {notice.buyerNoticeState === 'sent' ? (
            <span className="text-sm">{t('notice.stepBuyerDone')}</span>
          ) : (
            <>
              <span className="text-sm">{t('notice.stepBuyer')}</span>
              <Button size="sm" loading={tick.isPending} onClick={() => tick.mutate('buyer_notice')}>
                {t('notice.stepBuyerTick')}
              </Button>
            </>
          )}
        </li>
        <li className="flex flex-wrap items-center gap-2" data-testid="invoice-notice-step-form">
          {notice.formState === 'filed' ? (
            <span className="text-sm">{t('notice.stepFormDone')}</span>
          ) : (
            <>
              <span className="text-sm">{t('notice.stepForm')}</span>
              <Button size="sm" loading={tick.isPending} onClick={() => tick.mutate('tax_form')}>
                {t('notice.stepFormTick')}
              </Button>
            </>
          )}
        </li>
      </ul>
      <p className="mt-2 text-xs text-subtle-foreground">{t('notice.formNote')}</p>
      {tick.error && <ErrorText>{errorMessage(tick.error)}</ErrorText>}
    </div>
  );
}

// "Sai sót không cần hóa đơn mới" on an issued invoice (#2504): an error only in the buyer's name or address or in the amount in words. No new invoice, no cancel: the person records the
// error and the text that is right, reads the notice the code built, sends it to the buyer themselves and ticks it, and ticks the form 04/SS-HĐĐT when it is filed.
export function NoticeAction({ draft, openWith = false }: { draft: EInvoiceDraftSummary; openWith?: boolean }) {
  const t = useTranslations('salesInvoices');
  const id = useId();
  const [open, setOpen] = useState(openWith);
  const [field, setField] = useState<EInvoiceNoticeField>('buyer_name');
  const [correctText, setCorrectText] = useState('');
  const list = useQuery({ ...orpc.einvoice.drafts.noticeList.queryOptions({ input: { draftId: draft.id } }), enabled: open });
  const record = useMutation({
    mutationFn: (sent: string) => client.einvoice.drafts.noticeOpen({ draftId: draft.id, field, correctText: sent }),
    onSuccess: async (_data, sent) => {
      // Clear the box only when it still holds what was sent: text typed while the request ran stays.
      setCorrectText((now) => (now.trim() === sent ? '' : now));
      await queryClient.invalidateQueries({ queryKey: orpc.einvoice.drafts.noticeList.key({ input: { draftId: draft.id } }) });
    },
  });
  if (!open) {
    return (
      <div className="mt-2">
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)} data-testid="invoice-notice-open">
          {t('notice.open')}
        </Button>
      </div>
    );
  }
  return (
    <Card className="mt-2 block p-3" data-testid="invoice-notice-panel">
      <p className="text-sm font-medium">{t('notice.title', { number: draft.issuedNumber ?? '-' })}</p>
      <p className="mt-1 text-xs text-subtle-foreground">{t('notice.intro')}</p>
      {list.error && <ErrorText>{errorMessage(list.error)}</ErrorText>}
      {list.data && (list.data.notices.length === 0 ? <p className="mt-2 text-xs text-subtle-foreground">{t('notice.none')}</p> : list.data.notices.map((n) => <NoticeCard key={n.id} notice={n} reference={list.data.reference} draftId={draft.id} />))}
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`${id}-field`}>{t('notice.field')}</Label>
          <NativeSelect id={`${id}-field`} value={field} onChange={(e) => setField(e.target.value as EInvoiceNoticeField)} data-testid="invoice-notice-field">
            {EINVOICE_NOTICE_FIELDS.map((f) => (
              <NativeSelectOption key={f} value={f}>
                {t(NOTICE_FIELD_KEY[f])}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-text`}>{t('notice.correctText')}</Label>
          <Input id={`${id}-text`} value={correctText} maxLength={500} onChange={(e) => setCorrectText(e.target.value)} data-testid="invoice-notice-text-input" />
        </div>
      </div>
      {record.error && <ErrorText>{errorMessage(record.error)}</ErrorText>}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" loading={record.isPending} disabled={correctText.trim() === ''} onClick={() => record.mutate(correctText.trim())} data-testid="invoice-notice-record">
          {t('notice.record')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          {t('notice.close')}
        </Button>
      </div>
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

export function SalesInvoicesPage({ prefill }: { prefill?: SalesInvoiceHandoffSearch } = {}) {
  const t = useTranslations('salesInvoices');
  const f = useFormat();
  const entity = useChosenEntity();
  const { slug } = useParams({ strict: false }) as { slug: string };
  const org = useQuery(orpc.org.get.queryOptions());
  const canWrite = org.data?.role === 'owner' || org.data?.role === 'admin' || org.data?.role === 'member';
  const canSync = org.data?.role === 'owner' || org.data?.role === 'admin';
  // Owners and admins approve an issue (the one who asked too, when nobody else can); a member asks and an approver decides in the Inbox.
  const canApprove = canSync;
  const status = useQuery(orpc.einvoice.status.queryOptions());
  const seriesQuery = useQuery(orpc.einvoice.series.list.queryOptions());
  // The Integrations section of Settings draws only where the deployment offers a provider or the sandbox, so the link to it does too (#3602).
  const providers = useQuery(orpc.einvoice.providers.queryOptions());
  // An invoice on its way (being sent, waiting for the tax authority, issued with its original still to store) is looked at again every few seconds, until it settles.
  const drafts = useQuery({
    ...orpc.einvoice.drafts.list.queryOptions({ input: { legalEntityId: entity.legalEntityId } }),
    enabled: entity.ready,
    refetchInterval: (query) => (query.state.data?.some((d) => d.state === 'submitting' || d.state === 'pending' || (d.state === 'issued' && !d.evidenceStored)) ? 3000 : false),
  });
  const [editing, setEditing] = useState<FormState | null>(null);
  const [prefillDismissedKey, setPrefillDismissedKey] = useState<string | null>(null);
  const sync = useMutation({ mutationFn: () => client.einvoice.series.sync({ legalEntityId: entity.legalEntityId ?? null, provider: 'sandbox' }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (draftId: string) => client.einvoice.drafts.delete({ draftId }), onSuccess: refresh });
  // The series of the entity on screen; an entity with none yet sees none (a series belongs to one entity).
  const series = (seriesQuery.data ?? []).filter((s) => entity.legalEntityId === undefined || s.legalEntityId === entity.legalEntityId);
  const defaultSeries = series.find((s) => s.isDefault) ?? series[0];

  const prefillDescription = prefill ? formatSalesInvoicePrefillDescription(prefill) : '';
  const activePrefillKey = prefillDescription ? `${slug}:${prefillDescription}` : null;
  const prefillActive =
    editing === null &&
    canWrite &&
    activePrefillKey !== null &&
    prefillDismissedKey !== activePrefillKey &&
    !seriesQuery.isPending;
  const activeForm: FormState | null =
    editing ??
    (prefillActive
      ? {
          ...blankForm(defaultSeries?.id ?? ''),
          lines: [{ ...blankLine(), description: prefillDescription }],
        }
      : null);
  const activeFormKey = editing
    ? (editing.draftId ?? 'new')
    : `prefill:${activePrefillKey}:${defaultSeries?.id ?? ''}`;

  const open = async (draftId: string | null) => {
    if (activePrefillKey) setPrefillDismissedKey(activePrefillKey);
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
            <Button disabled={activeForm !== null} onClick={() => void open(null)} data-testid="invoice-new">
              {t('new')}
            </Button>
          ) : undefined
        }
      />
      {series.length === 0 && !seriesQuery.isPending && (
        <Card className="mb-4 block p-4" data-testid="invoice-no-series">
          <p className="text-sm text-foreground">{t('noSeries')}</p>
          {/* The next step (#3602): the provider is connected in Cài đặt, section Kết nối; a deployment that runs the offline sandbox can also read its sample series. */}
          <p className="mt-2 text-sm text-muted-foreground">
            {status.data?.sandbox ? t('noSeriesSandbox') : t('noProvider')}
            {(providers.data?.length ?? 0) > 0 && (
              <>
                {' '}
                <Link to="/o/$slug/settings/connections" params={{ slug }} hash="integrations" className="text-link underline underline-offset-2" data-testid="invoice-open-connections">
                  {t('openConnections')}
                </Link>
              </>
            )}
          </p>
          {status.data?.sandbox && canSync && (
            <Button className="mt-3" variant="outline" size="sm" loading={sync.isPending} onClick={() => sync.mutate()} data-testid="invoice-sync">
              {t('syncSandbox')}
            </Button>
          )}
          {sync.error && <ErrorText>{errorMessage(sync.error)}</ErrorText>}
        </Card>
      )}
      {activeForm && (
        <DraftForm
          key={activeFormKey}
          initial={activeForm}
          series={series}
          legalEntityId={entity.legalEntityId}
          originalNumber={activeForm.correction ? (drafts.data?.find((d) => d.id === activeForm.correction?.originalDraftId)?.issuedNumber ?? null) : null}
          {...(prefillActive ? { handoffPrefill: { active: true, reference: prefill?.reference?.trim() || null } } : {})}
          onClose={() => {
            setEditing(null);
            if (activePrefillKey) setPrefillDismissedKey(activePrefillKey);
          }}
        />
      )}
      {drafts.isPending ? (
        <TableSkeleton columns={5} />
      ) : drafts.error ? (
        <ErrorText>{errorMessage(drafts.error)}</ErrorText>
      ) : drafts.data.length === 0 ? (
        <Empty title={t('empty')} hint={t('emptyHint')} />
      ) : (
        <DataTable stacked head={[t('date'), t('buyer'), t('total'), t('status'), '']} numeric={[2]}>
          {drafts.data.map((d) => (
            <TableRow key={d.id} data-testid="invoice-draft">
              <TableCell data-label={t('date')} className="tabular-nums">{f.date(d.date)}</TableCell>
              <TableCell data-label={t('buyer')}>{d.buyerName ?? t('consumerName')}</TableCell>
              <TableCell data-label={t('total')} className={NUM}>{f.money(d.total, 'VND')}</TableCell>
              <TableCell data-label={t('status')}>
                <Badge variant="secondary">{t(STATE_KEY[d.state as keyof typeof STATE_KEY] ?? 'states.failed')}</Badge>
                {d.issuedNumber !== null && <span className="ml-2 text-xs text-subtle-foreground">{t('issuedNumber', { number: d.issuedNumber })}</span>}
                {d.state === 'issued' && !d.evidenceStored && <span className="ml-2 text-xs text-subtle-foreground">{t('evidencePending')}</span>}
                {d.issueCount > 0 && <span className="ml-2 text-xs text-subtle-foreground">{t('issueCount', { count: String(d.issueCount) })}</span>}
                {d.correction && (
                  <Badge variant="outline" className="ml-2" data-testid="invoice-correction-badge">
                    {d.correction.kind === 'adjustment' ? t('correction.badgeAdjustment') : t('correction.badgeReplacement')}
                  </Badge>
                )}
                {d.replaced && <span className="ml-2 text-xs text-subtle-foreground" data-testid="invoice-replaced">{t('correction.replacedNote')}</span>}
                <DraftNote draft={d} />
                {canWrite && d.state === 'issued' && d.evidenceStored && activeForm === null && !d.replaced && <NoticeAction key={`notice-${d.id}`} draft={d} />}
                {canWrite && d.state === 'issued' && d.evidenceStored && activeForm === null && <CorrectionAction key={`${d.id}:${d.updatedAt}`} draft={d} onStarted={(draftId) => void open(draftId)} />}
                {/* Issuing needs a provider this deployment has switched on: with none, the request would be approved and nothing would send it. */}
                {canWrite && d.state === 'draft' && d.issueCount === 0 && status.data?.sandbox && <IssueAction key={`${d.id}:${d.updatedAt}`} draft={d} canApprove={canApprove} />}
              </TableCell>
              <TableCell className="text-right">
                {canWrite && d.state === 'draft' && (
                  <span className="flex justify-end gap-1">
                    <Button variant="ghost" size="sm" disabled={activeForm !== null} onClick={() => void open(d.id)} data-testid="invoice-edit">
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
