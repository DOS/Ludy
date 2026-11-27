// SPDX-License-Identifier: AGPL-3.0-only
// The deal's side sheet (#3648, the owner's rule of 2026-11-17, DESIGN.md 4.5): adding a deal, and everything about one (its details to edit, its quotes with the orders, its bookings
// and meetings) in one panel at the right edge, in place of forms and panels that opened above the whole board or under a table row. Focus moves into the sheet, Tab stays inside,
// Escape or the close button closes it and focus returns to the card or the row that opened it. A stray click on the dimmed page does not close it: a form or a quote may be half typed.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';
import type { Deal, PartyChoice } from '@ludy/kernel-contract';
import { Button } from '@ludy/ui/components/button';
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@ludy/ui/components/sheet';
import { DealBookings } from './booking-deal.tsx';
import { DealForm, newerDeal, type Member } from './deal-form.tsx';
import { DealQuotes } from './deal-quotes.tsx';
import { LinkedMeetings, meetingsInstalled } from './linked-meetings.tsx';
import { useLocaleSetting } from '../i18n/provider.tsx';
import { orpc } from '../lib/api.ts';
import { formatDate, formatMoney } from '../lib/format.ts';
import { installedModules } from '../lib/org-modules.ts';
import { AiWrittenBadge } from './ai-written-badge.tsx';
import { RoadmapSignalModal } from './roadmap-signal-modal.tsx';

// What the sheet shows: a new deal (for a customer already chosen, from a contact's panel, or not), or a deal that exists.
export type DealSheetTarget = { kind: 'new'; presetParty?: PartyChoice | null } | { kind: 'deal'; deal: Deal };

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <h3 id={id} className="text-sm font-semibold text-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

export function DealSheet({ target, members, canEdit, onClose }: { target: DealSheetTarget; members: readonly Member[]; canEdit: boolean; onClose: () => void }) {
  const t = useTranslations('deals');
  const tRoadmap = useTranslations('projects.roadmap.admin');
  const common = useTranslations('common');
  const { locale } = useLocaleSetting();
  const [roadmapSignalOpen, setRoadmapSignalOpen] = useState(false);
  // The deal as it is now: a quote's offer or a move made in the sheet changes it, and a stale version would refuse the next edit. The row or card it was opened from is the first answer, and a cached read older than it never replaces it (#5015).
  const opened = target.kind === 'deal' ? target.deal : null;
  const fresh = useQuery({ ...orpc.crm.deals.get.queryOptions({ input: { dealId: opened?.id ?? '00000000-0000-0000-0000-000000000000' } }), enabled: opened !== null, ...(opened ? { placeholderData: opened } : {}) });
  const deal = opened === null ? null : newerDeal(opened, fresh.data);
  const stages = useQuery(orpc.crm.pipeline.stages.queryOptions({ input: {} }));
  const stageName = deal ? stages.data?.find((s) => s.id === deal.stageId)?.name : undefined;
  return (
    <Sheet open disablePointerDismissal onOpenChange={(open) => !open && onClose()}>
      <SheetContent closeLabel={common('close')} className="sm:max-w-2xl" data-testid="deal-sheet">
        <SheetHeader>
          <SheetTitle>{deal ? deal.title : t('form.newTitle')}</SheetTitle>
          {deal && <AiWrittenBadge actorOrigin={deal.actorOrigin} tainted={deal.tainted} showHint />}
          <SheetDescription>
            {deal ? [deal.partyName, stageName, formatMoney(deal.amount, locale, deal.currency)].filter(Boolean).join(' · ') : t('sheet.newHint')}
          </SheetDescription>
        </SheetHeader>
        <SheetBody className="space-y-8">
          {deal === null ? (
            <DealForm plain deal={null} members={members} presetParty={target.kind === 'new' ? (target.presetParty ?? null) : null} onDone={onClose} />
          ) : (
            <>
              <Section id="deal-sheet-details" title={t('sheet.details')}>
                {canEdit ? (
                  <DealForm key={deal.id} plain deal={deal} members={members} onDone={onClose} />
                ) : (
                  <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                    <div>
                      <dt className="text-subtle-foreground">{t('form.party')}</dt>
                      <dd className="text-foreground">{deal.partyName}</dd>
                    </div>
                    <div>
                      <dt className="text-subtle-foreground">{t('form.amount')}</dt>
                      <dd className="text-foreground tabular-nums">{formatMoney(deal.amount, locale, deal.currency)}</dd>
                    </div>
                    {deal.expectedClose && (
                      <div>
                        <dt className="text-subtle-foreground">{t('form.expectedClose')}</dt>
                        <dd className="text-foreground">{formatDate(deal.expectedClose, locale)}</dd>
                      </div>
                    )}
                  </dl>
                )}
              </Section>
              <Section id="deal-sheet-quotes" title={t('quotes')}>
                <DealQuotes key={deal.id} deal={deal} canEdit={canEdit} />
              </Section>
              {canEdit && (
                <Section id="deal-sheet-bookings" title={t('bookings')}>
                  <DealBookings key={deal.id} deal={deal} canEdit={canEdit} />
                </Section>
              )}
              {meetingsInstalled() && (
                <Section id="deal-sheet-meetings" title={t('meetings')}>
                  <LinkedMeetings kind="deal" targetId={deal.id} />
                </Section>
              )}
              {canEdit && installedModules().includes('projects') && (
                <Section id="deal-sheet-roadmap" title={tRoadmap('signalModalFromSourceTitle')}>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    onClick={() => setRoadmapSignalOpen(true)}
                    data-testid="deal-sheet-link-roadmap"
                  >
                    {tRoadmap('linkToRoadmapBtn')}
                  </Button>
                  <RoadmapSignalModal
                    open={roadmapSignalOpen}
                    onOpenChange={setRoadmapSignalOpen}
                    prefillSource={{
                      sourceType: 'crm.deal',
                      sourceId: deal.id,
                      sourceLabel: deal.title,
                      accountLabel: deal.partyName,
                      dealValue: deal.amount,
                      dealCurrency: deal.currency,
                    }}
                  />
                </Section>
              )}
            </>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
