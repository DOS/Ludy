// SPDX-License-Identifier: AGPL-3.0-only
// Sales e-invoice drafts ("Hóa đơn bán ra", #2500, ADR-0044): the drafts of the invoices a business will issue, made, checked and edited here. Nothing is
// issued and no provider is called from this screen yet: a draft is a working copy. The amounts are the server's, computed from the lines (the form has no
// total to type), and the checks of the invoice's required fields show on the fields as the draft is typed.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useDeferredValue, useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import { BUYER_KINDS, EINVOICE_DRAFT_MAX_LINES, vietnamToday, type BuyerKind, type DraftIssueCode, type EInvoiceDraft, type EInvoiceDraftForm, type EInvoiceDraftSummary } from '@crove/kernel-contract';
import { Alert, AlertDescription } from '@crove/ui/components/alert';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
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
}
interface FormState {
  draftId: string | null;
  date: string;
  seriesId: string;
  buyer: { kind: BuyerKind; partyId: string | null; taxCode: string; name: string; address: string; email: string };
  lines: LineState[];
}

const blankLine = (): LineState => ({ description: '', unit: '', quantity: '1', unitPrice: '', vatRate: '10%' });
const blankForm = (seriesId: string): FormState => ({ draftId: null, date: vietnamToday(), seriesId, buyer: { kind: 'business', partyId: null, taxCode: '', name: '', address: '', email: '' }, lines: [blankLine()] });
const fromDraft = (d: EInvoiceDraft): FormState => ({
  draftId: d.id,
  date: d.date,
  seriesId: d.seriesId ?? '',
  buyer: { kind: d.buyer.kind as BuyerKind, partyId: d.buyer.partyId, taxCode: d.buyer.taxCode ?? '', name: d.buyer.name ?? '', address: d.buyer.address ?? '', email: d.buyer.email ?? '' },
  lines: d.lines.map((l) => ({ description: l.description, unit: l.unit ?? '', quantity: l.quantity, unitPrice: l.unitPrice, vatRate: l.vatRate })),
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

function DraftForm({ initial, series, legalEntityId, onClose }: { initial: FormState; series: Array<{ id: string; templateNo: string; symbol: string; description: string }>; legalEntityId: string | undefined; onClose: () => void }) {
  const t = useTranslations('salesInvoices');
  const f = useFormat();
  const [form, setForm] = useState(initial);
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
  const setBuyer = (patch: Partial<FormState['buyer']>) => setForm((s) => ({ ...s, buyer: { ...s.buyer, ...patch } }));
  const setLine = (index: number, patch: Partial<LineState>) => setForm((s) => ({ ...s, lines: s.lines.map((l, i) => (i === index ? { ...l, ...patch } : l)) }));
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
            <div key={index} className="grid items-end gap-2 sm:grid-cols-[2fr_0.6fr_0.8fr_1fr_0.8fr_1fr_auto]" data-testid="invoice-line">
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
