// SPDX-License-Identifier: AGPL-3.0-only
// The Inbox card of what an AI coworker asks to do in an Engage line (E4 #3863; ADR-0051 decision 10): the text and the amounts exactly as the AI app sent them, marked as not trusted, who asked, and a plain
// statement that nothing has happened yet. It reads the proposal's stored payload (kernel.inbox.get, `engage`) and renders every value as text, never as markup. Approve and Reject are the page's own buttons.
import { Link } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Card } from '@crove/ui/components/card';
import { useFormat } from '../i18n/provider.tsx';
import type { EngageProposalView } from '@crove/kernel-contract';

// The screen where the thing the AI asked about can be seen, when there is one.
function screenOf(kind: string, fields: readonly { key: string; value: string }[]): { to: 'social' | 'ads' | 'bookings'; postId?: string; label: 'engageOpenPost' | 'engageOpenAds' | 'engageOpenBookings' } | null {
  if (kind.startsWith('social.')) {
    const postId = fields.find((f) => f.key === 'postId')?.value;
    return postId ? { to: 'social', postId, label: 'engageOpenPost' } : null;
  }
  if (kind.startsWith('ads.')) return { to: 'ads', label: 'engageOpenAds' };
  if (kind.startsWith('crm.booking_')) return { to: 'bookings', label: 'engageOpenBookings' };
  return null;
}

// The words the card has for each kind and each field of the payloads (a key outside them shows as it is).
const KIND_KEYS = [
  'kernel_conversation_reply',
  'kernel_conversation_reply_privately',
  'kernel_conversation_hide',
  'crm_quote_send',
  'crm_booking_move',
  'crm_booking_cancel',
  'social_post_submit',
  'social_variant_schedule',
  'ads_launch_stop',
  'ads_pause_all',
  'ads_object_pause',
  'ads_object_archive',
  'ads_budget_lower',
  'ads_schedule_shorten',
] as const;
const FIELD_KEYS = ['body', 'conversationId', 'lastSeenSeq', 'draftId', 'savedReplyId', 'messageId', 'hidden', 'quoteId', 'version', 'via', 'to', 'bookingId', 'startsAt', 'postId', 'variantIds', 'at', 'queue', 'slotAt', 'times', 'launchId', 'slot', 'dailyBudget', 'endOn'] as const;
// A time the AI wrote as an ISO instant is shown in the reader's own clock beside what was written, so 09:00Z is not read as 09:00 in Vietnam.
const TIME_KEYS = ['startsAt', 'at', 'slotAt'] as const;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
// The words of the `about` lines (a label outside them cannot arrive: the contract's enum is the same list) and of the states a quote and a launch can be in (a state outside them shows as it is).
const ABOUT_KEYS = [
  'channel',
  'contact',
  'customerMessage',
  'guest',
  'guestEmail',
  'eventType',
  'bookingTime',
  'quote',
  'quoteStatus',
  'quoteTotal',
  'party',
  'partyEmail',
  'post',
  'channels',
  'launch',
  'adAccount',
  'launchState',
  'launchBudget',
  'launchEnds',
] as const satisfies readonly EngageProposalView['about'][number]['label'][];
// A label the contract adds and this list lacks fails the typecheck here, not on a card.
const ABOUT_KEYS_ARE_ALL: EngageProposalView['about'][number]['label'] extends (typeof ABOUT_KEYS)[number] ? true : never = true;
void ABOUT_KEYS_ARE_ALL;
const STATE_KEYS = ['draft', 'sent', 'accepted', 'declined', 'superseded', 'queued', 'launching', 'live', 'needs_attention', 'stopped', 'failed', 'cancelled'] as const;
const isStateKey = (value: string): value is (typeof STATE_KEYS)[number] => (STATE_KEYS as readonly string[]).includes(value);
const isKindKey = (key: string): key is (typeof KIND_KEYS)[number] => (KIND_KEYS as readonly string[]).includes(key);
const isFieldKey = (key: string): key is (typeof FIELD_KEYS)[number] => (FIELD_KEYS as readonly string[]).includes(key);

export function EngageProposalCard({ engage, kind, status, client, slug }: { engage: EngageProposalView; kind: string; status: string; client: { client: string; host: string } | null; slug: string }) {
  const t = useTranslations('inboxDetail');
  const fmt = useFormat();
  const kindKey = kind.replaceAll('.', '_');
  const screen = screenOf(kind, engage.fields);
  // A booking's current time is shown in the reader's own clock beside the instant, like the proposed time below; a state in words.
  const aboutValue = (a: { label: string; value: string }): string => {
    if (a.label === 'bookingTime' && ISO_INSTANT.test(a.value)) return `${fmt.dateTime(a.value)} (${a.value})`;
    if ((a.label === 'quoteStatus' || a.label === 'launchState') && isStateKey(a.value)) return t(`engageAboutValue.${a.value}`);
    return a.value;
  };
  return (
    <Card className="block space-y-3 p-4" data-testid="engage-change">
      <p className="text-sm font-medium text-muted-foreground">{t('engageChange')}</p>
      <p className="break-words text-base font-semibold text-foreground">{isKindKey(kindKey) ? t(`engageKinds.${kindKey}`) : kind}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="proposal">{t('engageBadge')}</Badge>
      </div>
      <p className="text-sm text-muted-foreground">{t('engageTainted')}</p>
      {engage.about.length > 0 && (
        <dl className="space-y-2 rounded-md border border-border p-3" data-testid="engage-about">
          {engage.about.filter((a) => (ABOUT_KEYS as readonly string[]).includes(a.label)).map((a) => (
            <div key={a.label}>
              <dt className="text-sm text-muted-foreground">{t(`engageAbout.${a.label}`)}</dt>
              <dd className="whitespace-pre-wrap break-words text-base text-foreground" data-testid={`engage-about-${a.label}`}>
                {aboutValue(a)}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <dl className="space-y-2" data-testid="engage-fields">
        {engage.fields.map((f) => (
          <div key={f.key}>
            <dt className="text-sm text-muted-foreground">{isFieldKey(f.key) ? t(`engageField.${f.key}`) : f.key}</dt>
            {f.long ? (
              // The text a customer will read: whole, in its own block, with its line breaks, as plain text.
              <dd className="mt-1 whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 p-3 text-base text-foreground" data-testid={`engage-field-${f.key}`}>
                {f.value}
              </dd>
            ) : (
              <dd className="break-words text-base text-foreground" data-testid={`engage-field-${f.key}`}>
                {(TIME_KEYS as readonly string[]).includes(f.key) && ISO_INSTANT.test(f.value) ? `${fmt.dateTime(f.value)} (${f.value})` : f.value}
              </dd>
            )}
          </div>
        ))}
      </dl>
      {client && <p className="text-sm text-muted-foreground">{t('engageWhoAsked', { client: client.client, host: client.host })}</p>}
      {/* What is true now: nothing yet while it waits; once decided, what was decided. */}
      <p role="note" className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-foreground">
        {status === 'pending' ? t('engageNothingYet') : status === 'executed' ? t('engageDone') : status === 'rejected' ? t('engageRejected') : t('engageClosed')}
      </p>
      {screen?.to === 'social' && screen.postId && (
        <Link to="/o/$slug/social/$id" params={{ slug, id: screen.postId }} className="inline-flex min-h-11 items-center text-sm text-link hover:underline">
          {t(screen.label)}
        </Link>
      )}
      {screen?.to === 'ads' && (
        <Link to="/o/$slug/ads" params={{ slug }} className="inline-flex min-h-11 items-center text-sm text-link hover:underline">
          {t(screen.label)}
        </Link>
      )}
      {screen?.to === 'bookings' && (
        <Link to="/o/$slug/bookings" params={{ slug }} className="inline-flex min-h-11 items-center text-sm text-link hover:underline">
          {t(screen.label)}
        </Link>
      )}
    </Card>
  );
}

// What a member or a viewer sees where an owner or an admin sees the card (L4 of #4160): the kernel gives them no `engage` view (the text an AI app proposed may hold a customer's words and numbers), so the
// page shows this plain card instead of falling back to the invoice layout. It says what it is, who asked, that only owners and admins see and decide it, and what is true now. It reads nothing of the payload.
export function EngageProposalHiddenCard({ status, client }: { status: string; client: { client: string; host: string } | null }) {
  const t = useTranslations('inboxDetail');
  return (
    <Card className="block space-y-3 p-4" data-testid="engage-change-hidden">
      <p className="text-sm font-medium text-muted-foreground">{t('engageChange')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="proposal">{t('engageBadge')}</Badge>
      </div>
      <p className="text-base text-foreground">{t('engageDetailsHidden')}</p>
      {client && <p className="text-sm text-muted-foreground">{t('engageWhoAsked', { client: client.client, host: client.host })}</p>}
      <p role="note" className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-foreground">
        {status === 'pending' ? t('engageHiddenPending') : status === 'executed' ? t('engageHiddenDone') : status === 'rejected' ? t('engageRejected') : t('engageClosed')}
      </p>
    </Card>
  );
}
