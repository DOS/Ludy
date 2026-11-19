// SPDX-License-Identifier: AGPL-3.0-only
// The Inbox card of what an AI coworker asks to do in an Engage line (E4 #3863; ADR-0051 decision 10): the text and the amounts exactly as the AI app sent them, marked as not trusted, who asked, and a plain
// statement that nothing has happened yet. It reads the proposal's stored payload (kernel.inbox.get, `engage`) and renders every value as text, never as markup. Approve and Reject are the page's own buttons.
import { Link } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Card } from '@crove/ui/components/card';
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
const isKindKey = (key: string): key is (typeof KIND_KEYS)[number] => (KIND_KEYS as readonly string[]).includes(key);
const isFieldKey = (key: string): key is (typeof FIELD_KEYS)[number] => (FIELD_KEYS as readonly string[]).includes(key);

export function EngageProposalCard({ engage, kind, client, slug }: { engage: EngageProposalView; kind: string; client: { client: string; host: string } | null; slug: string }) {
  const t = useTranslations('inboxDetail');
  const kindKey = kind.replaceAll('.', '_');
  const screen = screenOf(kind, engage.fields);
  return (
    <Card className="block space-y-3 p-4" data-testid="engage-change">
      <p className="text-sm font-medium text-muted-foreground">{t('engageChange')}</p>
      <p className="break-words text-base font-semibold text-foreground">{isKindKey(kindKey) ? t(`engageKinds.${kindKey}`) : kind}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="proposal">{t('engageTainted')}</Badge>
      </div>
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
                {f.value}
              </dd>
            )}
          </div>
        ))}
      </dl>
      {client && <p className="text-sm text-muted-foreground">{t('engageWhoAsked', { client: client.client, host: client.host })}</p>}
      <p role="note" className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-foreground">
        {t('engageNothingYet')}
      </p>
      {screen?.to === 'social' && screen.postId && (
        <Link to="/o/$slug/social/$id" params={{ slug, id: screen.postId }} className="inline-block text-sm text-link hover:underline">
          {t(screen.label)}
        </Link>
      )}
      {screen?.to === 'ads' && (
        <Link to="/o/$slug/ads" params={{ slug }} className="inline-block text-sm text-link hover:underline">
          {t(screen.label)}
        </Link>
      )}
      {screen?.to === 'bookings' && (
        <Link to="/o/$slug/bookings" params={{ slug }} className="inline-block text-sm text-link hover:underline">
          {t(screen.label)}
        </Link>
      )}
    </Card>
  );
}
