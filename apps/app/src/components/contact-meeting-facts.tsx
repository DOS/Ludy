// SPDX-License-Identifier: AGPL-3.0-only
// Deterministic pre-meeting contact facts card (#4991 PM1, AI-free):
// Shows matching contacts for an upcoming calendar event, booking, or recorded meeting (up to 3),
// their open deals, latest sent quote, finance invoice summary, and newest 5 inbound messages under caller RLS.
// Supports private per-member draft saving ("Keep as draft") and explicit second-click handoff to meeting notes.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { useTranslations } from 'use-intl';
import type { MeetingBriefDraft, MeetingBriefTargetKind, MeetingFactsContact } from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ludy/ui/components/card';
import { Label } from '@ludy/ui/components/label';
import { Textarea } from '@ludy/ui/components/textarea';
import { ErrorText } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { installedModules } from '../lib/org-modules.ts';

const READ_ONCE = { staleTime: 60_000, refetchOnWindowFocus: false } as const;
const DRAFT_MAX_CHARS = 8000;

export interface DraftFormatLabels {
  heading: string;
  deals: string;
  noDeals: string;
  quote: string;
  noQuote: string;
  quoteExpired: string;
  quoteStatus: Record<'sent' | 'accepted' | 'declined' | 'superseded', string>;
  invoices: string;
  invoicesSummary: (openCount: number, overdueFormatted: string, lastInvoiceDate: string, lastPaidDate: string) => string;
  messages: string;
  noMessages: string;
  noDate: string;
}

export interface DraftFormatters {
  money: (value: string) => string;
  date: (value: string) => string;
}

function isNonZeroDecimal(value: string): boolean {
  return value.replace(/[.-]/g, '').replace(/^0+/, '') !== '';
}

function truncateCodePoints(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join('');
}

// Formats deterministic pre-meeting contact facts into plain text for a private draft or meeting note.
export function formatContactBriefDraft(contact: MeetingFactsContact, labels: DraftFormatLabels, format: DraftFormatters): string {
  const lines: string[] = [labels.heading];

  lines.push(`${labels.deals}:`);
  if (contact.deals.length === 0) {
    lines.push(`- ${labels.noDeals}`);
  } else {
    for (const deal of contact.deals) {
      const parts = [deal.title, deal.stage];
      if (deal.amount !== null) parts.push(format.money(deal.amount));
      if (deal.expectedClose !== null) parts.push(format.date(deal.expectedClose));
      lines.push(`- ${parts.join(' | ')}`);
    }
  }

  lines.push(`${labels.quote}:`);
  if (!contact.latestQuote) {
    lines.push(`- ${labels.noQuote}`);
  } else {
    const q = contact.latestQuote;
    const statusText = q.expired ? labels.quoteExpired : labels.quoteStatus[q.status];
    lines.push(`- ${q.label} | ${format.money(q.total)} | ${statusText} | ${format.date(q.validUntil)}`);
  }

  if (contact.invoices) {
    lines.push(`${labels.invoices}:`);
    lines.push(
      `- ${labels.invoicesSummary(
        contact.invoices.openCount,
        format.money(contact.invoices.overdueAmount),
        contact.invoices.lastInvoiceDate ? format.date(contact.invoices.lastInvoiceDate) : labels.noDate,
        contact.invoices.lastPaidDate ? format.date(contact.invoices.lastPaidDate) : labels.noDate,
      )}`,
    );
  }

  lines.push(`${labels.messages}:`);
  if (contact.messages.length === 0) {
    lines.push(`- ${labels.noMessages}`);
  } else {
    for (const msg of contact.messages) {
      lines.push(`- ${msg}`);
    }
  }

  return truncateCodePoints(lines.join('\n'), DRAFT_MAX_CHARS);
}

function ContactFactItem({
  slug,
  contact,
  targetKind,
  targetId,
  linkedMeetingId,
  canPutToNotes,
  meetingsEnabled,
  draft,
}: {
  slug: string;
  contact: MeetingFactsContact;
  targetKind: MeetingBriefTargetKind;
  targetId: string;
  linkedMeetingId: string | null;
  canPutToNotes: boolean;
  meetingsEnabled: boolean;
  draft: MeetingBriefDraft | undefined;
}) {
  const t = useTranslations('meetings.briefFacts');
  const f = useFormat();
  const inputId = useId();
  const hintId = useId();
  const [editedText, setEditedText] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const invalidateDrafts = () =>
    queryClient.invalidateQueries({ queryKey: orpc.meetings.briefDraft.list.key() });

  const saveDraft = useMutation({
    mutationFn: (body: string) =>
      orpc.meetings.briefDraft.save.call({
        targetKind: draft?.targetKind ?? targetKind,
        targetId: draft?.targetId ?? targetId,
        partyId: contact.partyId,
        body,
      }),
    onSuccess: (res) => {
      setEditedText(res.draft.body);
      setStatusMessage(t('draftSaved'));
      void invalidateDrafts();
    },
  });

  const removeDraft = useMutation({
    mutationFn: (d: { targetKind: MeetingBriefTargetKind; targetId: string }) =>
      orpc.meetings.briefDraft.remove.call({
        targetKind: d.targetKind,
        targetId: d.targetId,
        partyId: contact.partyId,
      }),
    onSuccess: () => {
      setEditedText(null);
      setStatusMessage(t('draftRemoved'));
      void invalidateDrafts();
    },
  });

  const putToNotes = useMutation({
    mutationFn: async () => {
      if (!linkedMeetingId) return null;
      const sourceKind = draft?.targetKind ?? targetKind;
      const sourceId = draft?.targetId ?? targetId;
      const trimmedEdit = editedText?.trim() ?? '';
      if (draft && trimmedEdit !== '' && trimmedEdit !== draft.body.trim()) {
        await orpc.meetings.briefDraft.save.call({
          targetKind: sourceKind,
          targetId: sourceId,
          partyId: contact.partyId,
          body: trimmedEdit,
        });
      }
      return orpc.meetings.briefDraft.putToNotes.call({
        targetKind: sourceKind,
        targetId: sourceId,
        partyId: contact.partyId,
        meetingId: linkedMeetingId,
      });
    },
    onSuccess: (res) => {
      if (!res) return;
      setStatusMessage(t('addedToNotes'));
      void invalidateDrafts();
      if (linkedMeetingId) {
        void queryClient.invalidateQueries({ queryKey: orpc.meetings.results.notesGet.key({ input: { meetingId: linkedMeetingId } }) });
      }
    },
  });

  const builtDraft = formatContactBriefDraft(
    contact,
    {
      heading: t('draftHeading', { name: contact.contactName }),
      deals: t('dealsTitle'),
      noDeals: t('noDeals'),
      quote: t('quoteTitle'),
      noQuote: t('noQuote'),
      quoteExpired: t('quoteExpired'),
      quoteStatus: {
        sent: t('quoteStatus.sent'),
        accepted: t('quoteStatus.accepted'),
        declined: t('quoteStatus.declined'),
        superseded: t('quoteStatus.superseded'),
      },
      invoices: t('invoicesTitle'),
      invoicesSummary: (openCount, overdueFormatted, lastInvoiceDate, lastPaidDate) =>
        t('invoicesDraftLine', {
          openCount: String(openCount),
          overdue: overdueFormatted,
          lastInvoice: lastInvoiceDate,
          lastPaid: lastPaidDate,
        }),
      messages: t('messagesTitle'),
      noMessages: t('noMessages'),
      noDate: t('noDate'),
    },
    {
      money: (val) => f.money(val),
      date: (val) => f.date(val),
    },
  );

  const currentBody = editedText ?? draft?.body ?? '';
  const hasSavedDraft = draft !== undefined;
  const dirty = hasSavedDraft && editedText !== null && editedText.trim() !== draft.body.trim();
  const busy = saveDraft.isPending || removeDraft.isPending || putToNotes.isPending;
  const activeError = saveDraft.error ?? removeDraft.error ?? putToNotes.error;
  const overdueNonZero = contact.invoices !== null && isNonZeroDecimal(contact.invoices.overdueAmount);

  return (
    <article className="space-y-3 rounded-lg border border-border bg-background/60 p-3" data-testid="contact-facts-item">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="min-w-0 break-words text-sm font-semibold text-foreground" data-testid="contact-facts-name">
          {contact.contactName}
        </h3>
        <Link to="/o/$slug/contacts" params={{ slug }} className="inline-flex min-h-7 max-md:min-h-11 items-center text-xs font-medium text-link underline underline-offset-4">
          {t('openContacts')}
        </Link>
      </div>

      <section className="space-y-1 text-sm" data-testid="contact-facts-deals">
        <h4 className="text-xs font-medium uppercase text-muted-foreground">{t('dealsTitle')}</h4>
        {contact.deals.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('noDeals')}</p>
        ) : (
          <ul className="space-y-1">
            {contact.deals.map((deal) => (
              <li key={deal.dealId} className="flex flex-wrap items-center gap-2">
                <Link to="/o/$slug/deals" params={{ slug }} className="inline-flex min-h-7 max-md:min-h-11 items-center min-w-0 break-words font-medium text-link underline underline-offset-4">
                  {deal.title}
                </Link>
                {deal.stage !== '' && <Badge variant="outline">{deal.stage}</Badge>}
                {deal.amount !== null && <span className="tabular-nums text-foreground">{f.money(deal.amount)}</span>}
                {deal.expectedClose && <span className="text-xs text-muted-foreground">{t('closeOn', { date: f.date(deal.expectedClose) })}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-1 text-sm" data-testid="contact-facts-quote">
        <h4 className="text-xs font-medium uppercase text-muted-foreground">{t('quoteTitle')}</h4>
        {contact.latestQuote === null ? (
          <p className="text-xs text-muted-foreground">{t('noQuote')}</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium text-foreground">{contact.latestQuote.label}</span>
            <span className="tabular-nums text-foreground">{f.money(contact.latestQuote.total)}</span>
            <Badge variant={contact.latestQuote.expired ? 'warning' : 'outline'}>
              {contact.latestQuote.expired ? t('quoteExpired') : t(`quoteStatus.${contact.latestQuote.status}`)}
            </Badge>
            <span className="text-muted-foreground">{t('validUntil', { date: f.date(contact.latestQuote.validUntil) })}</span>
            {contact.latestQuote.sentOn && (
              <span className="text-muted-foreground">{t('sentOn', { date: f.date(contact.latestQuote.sentOn) })}</span>
            )}
          </div>
        )}
      </section>

      {contact.invoices && (
        <section className="space-y-1 text-sm" data-testid="contact-facts-invoices">
          <h4 className="text-xs font-medium uppercase text-muted-foreground">{t('invoicesTitle')}</h4>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="tabular-nums text-foreground">{t('invoicesOpen', { count: String(contact.invoices.openCount) })}</span>
            {overdueNonZero ? (
              <Badge variant="warning" data-testid="contact-facts-overdue">
                {t('overdueAmount', { amount: f.money(contact.invoices.overdueAmount) })}
              </Badge>
            ) : (
              <span className="text-muted-foreground">{t('noOverdue')}</span>
            )}
            <span className="text-muted-foreground">
              {t('lastInvoice', { date: contact.invoices.lastInvoiceDate ? f.date(contact.invoices.lastInvoiceDate) : t('noDate') })}
            </span>
            <span className="text-muted-foreground">
              {t('lastPaid', { date: contact.invoices.lastPaidDate ? f.date(contact.invoices.lastPaidDate) : t('noDate') })}
            </span>
          </div>
        </section>
      )}

      <section className="space-y-1 text-sm" data-testid="contact-facts-messages">
        <h4 className="text-xs font-medium uppercase text-muted-foreground">{t('messagesTitle')}</h4>
        {contact.messages.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('noMessages')}</p>
        ) : (
          <ul className="space-y-1 text-xs text-foreground">
            {contact.messages.map((message, i) => (
              <li key={i} className="whitespace-pre-wrap break-words rounded border border-border/60 bg-muted/20 px-2 py-1">
                {message}
              </li>
            ))}
          </ul>
        )}
      </section>

      {meetingsEnabled && (
        <div className="space-y-2 border-t border-border pt-2" data-testid="contact-facts-draft-section">
          {!hasSavedDraft ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="min-h-11 md:min-h-9"
                loading={saveDraft.isPending}
                disabled={busy}
                onClick={() => saveDraft.mutate(builtDraft)}
                data-testid="contact-facts-keep-draft"
              >
                {t('keepDraft')}
              </Button>
              <span className="text-xs text-muted-foreground">{t('draftPrivateHint')}</span>
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor={inputId} className="text-xs font-medium text-foreground">
                {t('draftLabel')}
              </Label>
              <Textarea
                id={inputId}
                rows={5}
                value={currentBody}
                maxLength={DRAFT_MAX_CHARS}
                onChange={(e) => {
                  setStatusMessage(null);
                  setEditedText(e.target.value);
                }}
                aria-describedby={hintId}
                className="text-sm"
                data-testid="contact-facts-draft-input"
              />
              <p id={hintId} className="text-xs text-muted-foreground">
                {t('draftPrivateHint')}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {dirty && currentBody.trim() !== '' && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="min-h-11 md:min-h-9"
                    loading={saveDraft.isPending}
                    disabled={busy}
                    onClick={() => saveDraft.mutate(currentBody.trim())}
                    data-testid="contact-facts-update-draft"
                  >
                    {t('updateDraft')}
                  </Button>
                )}
                {canPutToNotes && linkedMeetingId && (
                  <Button
                    type="button"
                    size="sm"
                    className="min-h-11 md:min-h-9"
                    loading={putToNotes.isPending}
                    disabled={busy || currentBody.trim() === ''}
                    onClick={() => putToNotes.mutate()}
                    data-testid="contact-facts-put-to-notes"
                  >
                    {t('putToNotes')}
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="min-h-11 md:min-h-9"
                  loading={removeDraft.isPending}
                  disabled={busy}
                  onClick={() => removeDraft.mutate({ targetKind: draft.targetKind, targetId: draft.targetId })}
                  data-testid="contact-facts-remove-draft"
                >
                  {t('removeDraft')}
                </Button>
              </div>
            </div>
          )}
          {statusMessage && (
            <p role="status" aria-live="polite" className="text-xs text-foreground" data-testid="contact-facts-status">
              {statusMessage}
            </p>
          )}
          {activeError && <ErrorText>{errorMessage(activeError)}</ErrorText>}
        </div>
      )}
    </article>
  );
}

export interface ContactMeetingFactsProps {
  slug: string;
  targetKind: MeetingBriefTargetKind;
  targetId: string;
  linkedMeetingId?: string | null;
  isRecorder?: boolean;
  collapsible?: boolean;
  rowLabel?: string;
  canRead?: boolean;
  className?: string;
}

export function ContactMeetingFacts({
  slug,
  targetKind,
  targetId,
  linkedMeetingId = null,
  isRecorder,
  collapsible = false,
  rowLabel,
  canRead,
  className,
}: ContactMeetingFactsProps) {
  const t = useTranslations('meetings.briefFacts');
  const panelId = useId();
  const [open, setOpen] = useState(false);

  const modules = installedModules();
  const crmOn = modules.includes('crm');
  const meetingsOn = modules.includes('meetings');
  const org = useQuery({
    ...orpc.org.get.queryOptions(),
    enabled: crmOn && canRead === undefined,
    ...READ_ONCE,
  });

  const allowed = crmOn && (canRead ?? (org.data !== undefined && org.data.role !== 'viewer'));
  const expanded = allowed && (!collapsible || open);

  const facts = useQuery({
    ...orpc.crm.contacts.meetingFacts.queryOptions({ input: { targetKind, targetId } }),
    enabled: expanded,
    ...READ_ONCE,
    retry: false,
  });

  const hasContacts = (facts.data?.contacts.length ?? 0) > 0;
  const drafts = useQuery({
    ...orpc.meetings.briefDraft.list.queryOptions({ input: { targetKind, targetId } }),
    enabled: expanded && hasContacts && meetingsOn,
    ...READ_ONCE,
  });

  const meetingQuery = useQuery({
    ...orpc.meetings.get.queryOptions({ input: { meetingId: linkedMeetingId ?? '' } }),
    enabled: expanded && hasContacts && meetingsOn && linkedMeetingId !== null && isRecorder === undefined,
    ...READ_ONCE,
    retry: false,
  });

  if (!allowed) return null;

  const toggleLabel = open ? t('hide') : t('show');
  const toggleAriaLabel = rowLabel
    ? open
      ? t('hideFor', { name: rowLabel })
      : t('showFor', { name: rowLabel })
    : undefined;

  const effectiveRecorder = isRecorder ?? meetingQuery.data?.isRecorder ?? false;
  const draftByParty = new Map((drafts.data?.drafts ?? []).map((d) => [d.partyId, d]));

  if (!collapsible) {
    if (facts.isPending || facts.error || !facts.data || facts.data.contacts.length === 0) {
      return null;
    }
    return (
      <Card data-testid="contact-meeting-facts">
        <CardHeader>
          <CardTitle role="heading" aria-level={2} className="text-base font-medium">
            {t('title')}
          </CardTitle>
          <CardDescription className="text-xs text-muted-foreground">{t('subtitle')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {facts.data.contacts.map((contact) => (
            <ContactFactItem
              key={contact.partyId}
              slug={slug}
              contact={contact}
              targetKind={targetKind}
              targetId={targetId}
              linkedMeetingId={linkedMeetingId}
              canPutToNotes={Boolean(linkedMeetingId && effectiveRecorder)}
              meetingsEnabled={meetingsOn}
              draft={draftByParty.get(contact.partyId)}
            />
          ))}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className={className ? `space-y-2 ${className}` : 'space-y-2'} data-testid="contact-meeting-facts-box">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="min-h-11 md:min-h-9"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={toggleAriaLabel}
        data-testid="contact-facts-toggle"
      >
        {toggleLabel}
      </Button>
      {open && (
        <div id={panelId} className="space-y-3 rounded-lg border border-border bg-card p-3" data-testid="contact-meeting-facts">
          <div className="space-y-0.5">
            <p role="heading" aria-level={2} className="text-sm font-medium text-foreground">{t('title')}</p>
            <p className="text-xs text-muted-foreground">{t('subtitle')}</p>
          </div>
          {facts.isPending && (
            <p className="text-xs text-muted-foreground" role="status" data-testid="contact-facts-loading">
              {t('loading')}
            </p>
          )}
          {facts.error && <ErrorText>{errorMessage(facts.error)}</ErrorText>}
          {facts.data && facts.data.contacts.length === 0 && (
            <p className="text-xs text-muted-foreground" role="status" data-testid="contact-facts-empty">
              {t('empty')}
            </p>
          )}
          {facts.data && facts.data.contacts.length > 0 && (
            <div className="space-y-3">
              {facts.data.contacts.map((contact) => (
                <ContactFactItem
                  key={contact.partyId}
                  slug={slug}
                  contact={contact}
                  targetKind={targetKind}
                  targetId={targetId}
                  linkedMeetingId={linkedMeetingId}
                  canPutToNotes={Boolean(linkedMeetingId && effectiveRecorder)}
                  meetingsEnabled={meetingsOn}
                  draft={draftByParty.get(contact.partyId)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
