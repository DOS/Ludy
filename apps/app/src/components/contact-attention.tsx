// SPDX-License-Identifier: AGPL-3.0-only
// SG1 "Can chu y" (attention) card on the contact panel (#4993, docs/plan/crm.md 10.3).
// Shows up to 10 customer activity signals (newest first) with deep links, per-member "Da xem"
// dismissal (editors only), and optional Dy follow-up draft trigger (hidden when AI is off).
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { useTranslations } from 'use-intl';
import type { FollowupDraftInput, PartyAttentionItem, PartyAttentionMarkSeen } from '@ludy/kernel-contract';
import { Button } from '@ludy/ui/components/button';
import { FollowupDraftAction } from './followup-draft.tsx';
import { ErrorText } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { getConfig } from '../lib/auth.ts';

function followupInputFor(item: PartyAttentionItem): FollowupDraftInput | null {
  if (item.kind === 'quote_viewed' && item.quoteId) return { reason: 'quote_viewed', quoteId: item.quoteId };
  if (item.kind === 'customer_replied' && item.conversationId) {
    return { reason: 'customer_replied', partyId: item.partyId, conversationId: item.conversationId };
  }
  if ((item.kind === 'quote_expiring' || item.kind === 'quote_unanswered') && item.nextStepId) {
    return { nextStepId: item.nextStepId };
  }
  return null;
}

export interface ContactAttentionViewProps {
  items: readonly PartyAttentionItem[];
  isLoading: boolean;
  error: unknown;
  canEdit: boolean;
  aiEnabled: boolean;
  slug: string;
  pendingKey: string | null;
  markError: unknown;
  onMarkSeen: (input: PartyAttentionMarkSeen) => void;
}

export function ContactAttentionView({
  items,
  isLoading,
  error,
  canEdit,
  aiEnabled,
  slug,
  pendingKey,
  markError,
  onMarkSeen,
}: ContactAttentionViewProps) {
  const t = useTranslations('contacts.attention');
  const f = useFormat();
  const headingId = useId();
  const linkClass =
    'inline-flex min-h-6 items-center text-sm font-medium text-link underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 max-md:min-h-11 max-md:px-1';

  return (
    <section
      aria-labelledby={headingId}
      className="space-y-3 rounded-lg border border-border bg-card p-3"
      data-testid="contact-attention"
    >
      <h2 id={headingId} className="text-sm font-semibold text-foreground">
        {t('title')}
      </h2>
      {isLoading && (
        <p className="text-xs text-muted-foreground" role="status">
          {t('loading')}
        </p>
      )}
      {error ? <ErrorText>{errorMessage(error)}</ErrorText> : null}
      {markError ? <ErrorText>{errorMessage(markError)}</ErrorText> : null}
      {!isLoading && !error && items.length === 0 && (
        <p className="text-xs text-muted-foreground" data-testid="contact-attention-empty">
          {t('empty')}
        </p>
      )}
      {items.length > 0 && (
        <ul className="space-y-2">
          {items.map((item) => {
            const key = `${item.kind}:${item.targetId}`;
            const kindLabel = t(`kind.${item.kind}`);
            const formattedDate = f.dateTime(item.eventAt);
            const draftInput = followupInputFor(item);
            return (
              <li
                key={key}
                className="flex flex-col gap-2 rounded-md border border-border/70 bg-background/60 p-2.5 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between"
                data-testid="contact-attention-item"
                data-kind={item.kind}
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="text-sm font-medium text-foreground">{kindLabel}</div>
                  <time dateTime={item.eventAt} className="block text-xs text-muted-foreground tabular-nums">
                    {formattedDate}
                  </time>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {item.kind === 'customer_replied' && item.conversationId ? (
                    <Link
                      to="/o/$slug/social/inbox"
                      params={{ slug }}
                      search={{ c: item.conversationId }}
                      className={linkClass}
                      data-testid="attention-link"
                    >
                      {t('linkConversation')}
                    </Link>
                  ) : item.dealId && item.quoteId ? (
                    <Link
                      to="/o/$slug/deals"
                      params={{ slug }}
                      search={{ deal: item.dealId, quote: item.quoteId }}
                      className={linkClass}
                      data-testid="attention-link"
                    >
                      {t('linkQuote')}
                    </Link>
                  ) : item.dealId ? (
                    <Link
                      to="/o/$slug/deals"
                      params={{ slug }}
                      search={{ deal: item.dealId }}
                      className={linkClass}
                      data-testid="attention-link"
                    >
                      {t('linkDeal')}
                    </Link>
                  ) : null}
                  {canEdit && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="max-md:min-h-11 max-md:min-w-11"
                      disabled={pendingKey !== null}
                      loading={pendingKey === key}
                      aria-label={t('markSeenOf', { kind: kindLabel, date: formattedDate })}
                      onClick={() =>
                        onMarkSeen({
                          partyId: item.partyId,
                          kind: item.kind,
                          targetId: item.targetId,
                          eventAt: item.eventAt,
                        })
                      }
                      data-testid="attention-mark-seen"
                    >
                      {t('markSeen')}
                    </Button>
                  )}
                  {canEdit && aiEnabled && draftInput !== null && (
                    <FollowupDraftAction
                      input={draftInput}
                      label={kindLabel}
                      buttonLabel={t('suggestNextStep')}
                      buttonAriaLabel={t('suggestNextStepOf', { kind: kindLabel })}
                    />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function ContactAttention({ partyId, canEdit }: { partyId: string; canEdit: boolean }) {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const aiEnabled = getConfig().aiEnabled === true;
  const query = useQuery(orpc.crm.contacts.attention.queryOptions({ input: { partyId } }));
  const markSeen = useMutation(
    orpc.crm.contacts.markAttentionSeen.mutationOptions({
      onMutate: (variables) => {
        setPendingKey(`${variables.kind}:${variables.targetId}`);
      },
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.crm.contacts.attention.queryKey({ input: { partyId } }) });
      },
      onSettled: () => {
        setPendingKey(null);
      },
    }),
  );

  return (
    <ContactAttentionView
      items={query.data?.items ?? []}
      isLoading={query.isPending}
      error={query.error}
      canEdit={canEdit}
      aiEnabled={aiEnabled}
      slug={slug ?? ''}
      pendingKey={pendingKey}
      markError={markSeen.error}
      onMarkSeen={(input) => markSeen.mutate(input)}
    />
  );
}
