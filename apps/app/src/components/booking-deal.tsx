// SPDX-License-Identifier: AGPL-3.0-only
// A booking and its deal (#3103, docs/plan/calendar.md "Deal links"). On a deal, the panel lists the deal's upcoming and past bookings and "Đặt lịch" starts a booking from the
// deal: the link it offers the client carries the deal, so the client's booking arrives already linked. On a booking of the "Lịch hẹn" screen, the deal it is linked to (with
// "Gỡ liên kết") or, for a booking with none, the open deals the coworker suggests for the guest by a fixed rule on their email and phone (no model call): nothing is linked until
// a person presses "Liên kết". On a confirmed booking that has not ended and has a deal, "Chuẩn bị cuộc hẹn" opens Dy's brief (#3115). Only people who read bookings see any of it; the server shows each person the bookings they may read.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import type { BookingItem, MeetingBrief } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { BookingSuggestCard } from './booking-suggest.tsx';
import { ErrorText } from './ui.tsx';
import { useLocaleSetting } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { formatDate, formatMoney } from '../lib/format.ts';
import { visitorTimeZone } from '../lib/booking.ts';
import { whenOf } from '../routes/booking-page.tsx';

const refreshBookings = () => {
  void queryClient.invalidateQueries({ queryKey: orpc.crm.bookings.list.key() });
  void queryClient.invalidateQueries({ queryKey: orpc.crm.deals.bookings.key() });
};

// Dy's brief before a confirmed, upcoming booking that is linked to a deal (#3115). A person opens it; the server works it out when it is read (nothing is stored or sent): the facts from the books
// (the deal, its open follow-up, the latest sent quote, the customer's latest words that this person may read) and, when the model is on and its words pass the checks, a summary and 2 to 3 points
// to raise, in the proposal style. With AI off, spent or refused, the facts list stands alone.
export function MeetingBriefBody({ brief }: { brief: MeetingBrief }) {
  const t = useTranslations('bookings.deal.brief');
  const { locale } = useLocaleSetting();
  const { deal, quote } = brief;
  return (
    <div className="space-y-2 text-xs" data-testid="booking-brief-body">
      <p className="text-foreground" role="status" data-testid="booking-brief-state" data-state={brief.ai}>
        {t(`state.${brief.ai}`)}
      </p>
      {brief.summary !== null && (
        <div className="space-y-1 rounded-lg border border-dashed border-proposal/60 p-2" data-testid="booking-brief-words">
          <Badge variant="proposal">{t('proposal')}</Badge>
          <p className="text-foreground" data-testid="booking-brief-summary">
            {brief.summary}
          </p>
          <p className="font-medium text-foreground">{t('pointsTitle')}</p>
          <ul className="list-disc space-y-0.5 pl-4 text-foreground" data-testid="booking-brief-points">
            {brief.points.map((point, i) => (
              <li key={i}>{point}</li>
            ))}
          </ul>
        </div>
      )}
      <div data-testid="booking-brief-facts">
        <p className="font-medium text-foreground">{t('factsTitle')}</p>
        <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
          <li>{t('deal', { title: deal.title, contact: deal.contactName, stage: deal.stage })}</li>
          {deal.status !== 'open' && <li>{t(deal.status === 'won' ? 'dealWon' : 'dealLost')}</li>}
          <li>{deal.amount === null ? t('noAmount') : t('amount', { amount: formatMoney(deal.amount, locale) })}</li>
          {deal.expectedClose !== null && <li>{t('expectedClose', { date: formatDate(deal.expectedClose, locale) })}</li>}
          {brief.nextSteps.length === 0 ? <li>{t('noNextStep')}</li> : brief.nextSteps.map((step) => <li key={`${step.reason}-${step.sinceOn}`}>{t(`step.${step.reason}`, { date: formatDate(step.sinceOn, locale) })}</li>)}
          <li>
            {quote === null
              ? t('noQuote')
              : t('quote', {
                  label: quote.label,
                  total: formatMoney(quote.total, locale),
                  status: quote.expired ? t('quoteExpired') : t(`quoteStatus.${quote.status}`),
                  date: formatDate(quote.validUntil, locale),
                })}
          </li>
        </ul>
      </div>
      <div data-testid="booking-brief-messages">
        <p className="font-medium text-foreground">{t('messagesTitle')}</p>
        {brief.messages.length === 0 ? (
          <p className="text-muted-foreground">{t('noMessages')}</p>
        ) : (
          <ul className="space-y-0.5 text-muted-foreground">
            {brief.messages.map((message, i) => (
              <li key={i} className="whitespace-pre-line">
                {message}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function MeetingBriefPanel({ booking }: { booking: BookingItem }) {
  const t = useTranslations('bookings.deal.brief');
  const { locale } = useLocaleSetting();
  const [zone] = useState(visitorTimeZone);
  const [open, setOpen] = useState(false);
  // Worked out each time it is opened (a paid call when the model is on), never kept as a record.
  const brief = useQuery({ ...orpc.crm.bookings.meetingBrief.queryOptions({ input: { bookingId: booking.id } }), enabled: open, retry: false, refetchOnWindowFocus: false, gcTime: 0 });
  const when = whenOf({ start: booking.startsAt, end: booking.endsAt }, zone, locale);
  return (
    <div className="space-y-1" data-testid="booking-brief">
      <Button size="sm" variant="outline" aria-expanded={open} aria-label={t('buttonOf', { when })} data-testid="booking-brief-open" onClick={() => setOpen((o) => !o)}>
        {open ? t('close') : t('button')}
      </Button>
      {open &&
        (brief.error ? (
          <ErrorText>{errorMessage(brief.error)}</ErrorText>
        ) : brief.isPending ? (
          <p className="text-xs text-muted-foreground" role="status" data-testid="booking-brief-loading">
            {t('loading')}
          </p>
        ) : brief.data ? (
          <MeetingBriefBody brief={brief.data} />
        ) : null)}
    </div>
  );
}

// The deal of a booking on the "Lịch hẹn" screen: its title, stage and "Gỡ liên kết"; or Dy's suggestions with "Liên kết", each a person's click.
export function BookingDeal({ booking }: { booking: BookingItem }) {
  const t = useTranslations('bookings.deal');
  const link = useMutation(orpc.crm.bookings.linkDeal.mutationOptions({ onSuccess: refreshBookings }));
  const unlink = useMutation(orpc.crm.bookings.unlinkDeal.mutationOptions({ onSuccess: refreshBookings }));
  const error = link.error ?? unlink.error;
  if (!booking.deal && booking.dealSuggestions.length === 0) return null;
  return (
    <div className="mt-2 space-y-1" data-testid="booking-deal">
      {booking.deal ? (
        <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground" data-testid="booking-deal-linked">
          <span>{t('linked', { title: booking.deal.title })}</span>
          <Badge variant="outline">{booking.deal.stage}</Badge>
          <Button
            size="sm"
            variant="ghost"
            loading={unlink.isPending}
            aria-label={t('unlinkOf', { title: booking.deal.title })}
            data-testid="booking-deal-unlink"
            onClick={() => unlink.mutate({ bookingId: booking.id })}
          >
            {t('unlink')}
          </Button>
        </p>
      ) : (
        booking.dealSuggestions.map((s) => (
          // A suggestion nobody approved yet: the proposal badge and a dashed outline (DESIGN.md §3.1), though no model made it.
          <div key={s.id} className="flex flex-wrap items-center gap-1 rounded-lg border border-dashed border-proposal/60 p-2 text-xs" data-testid="booking-deal-suggestion">
            <Badge variant="proposal">{t('proposal')}</Badge>
            <span className="text-foreground">{t('suggested', { title: s.title })}</span>
            <span className="text-muted-foreground">
              {s.stage} · {t(`match.${s.match}`)}
            </span>
            <Button
              size="sm"
              variant="outline"
              loading={link.isPending && link.variables?.dealId === s.id}
              disabled={link.isPending}
              aria-label={t('linkOf', { title: s.title })}
              data-testid="booking-deal-link"
              onClick={() => link.mutate({ bookingId: booking.id, dealId: s.id })}
            >
              {t('link')}
            </Button>
          </div>
        ))
      )}
      {/* Dy's brief for a confirmed booking that has not ended and has a deal: opened by a person, worked out when read, never stored. */}
      {booking.deal && booking.status === 'confirmed' && Date.parse(booking.endsAt) > Date.now() && <MeetingBriefPanel booking={booking} />}
      {error && <ErrorText>{errorMessage(error)}</ErrorText>}
    </div>
  );
}

// The deal panel: "Đặt lịch" (a booking link that carries the deal), then the deal's upcoming and past bookings, each with "Gỡ liên kết". Nothing for a viewer, who reads no booking.
export function DealBookings({ deal, canEdit }: { deal: { id: string; title: string }; canEdit: boolean }) {
  const t = useTranslations('bookings.deal');
  const tb = useTranslations('bookings');
  const { slug } = useParams({ strict: false }) as { slug: string };
  const { locale } = useLocaleSetting();
  const [zone] = useState(visitorTimeZone);
  const [booking, setBooking] = useState(false);
  const bookings = useQuery({ ...orpc.crm.deals.bookings.queryOptions({ input: { dealId: deal.id } }), enabled: canEdit });
  const unlink = useMutation(orpc.crm.bookings.unlinkDeal.mutationOptions({ onSuccess: refreshBookings }));
  if (!canEdit) return null;
  const group = (key: 'upcoming' | 'past', items: BookingItem[]) => (
    <div data-testid={`deal-bookings-${key}`}>
      <p className="mb-1 text-sm font-medium text-muted-foreground">{tb(key)}</p>
      {items.length === 0 ? (
        <p className="text-sm text-subtle-foreground">{t(key === 'upcoming' ? 'emptyUpcoming' : 'emptyPast')}</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {items.map((b) => (
            <li key={b.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1" data-testid="deal-booking">
              <span className="font-medium text-foreground">{whenOf({ start: b.startsAt, end: b.endsAt }, zone, locale)}</span>
              <span>{b.eventType.title}</span>
              <span className="text-muted-foreground">{b.visitor.name ?? tb('erased')}</span>
              <Badge variant={b.status === 'confirmed' ? 'success' : 'outline'}>{tb(`status.${b.status === 'confirmed' ? 'confirmed' : 'cancelled'}`)}</Badge>
              <Button
                size="sm"
                variant="ghost"
                loading={unlink.isPending && unlink.variables?.bookingId === b.id}
                aria-label={t('unlinkFrom', { when: whenOf({ start: b.startsAt, end: b.endsAt }, zone, locale) })}
                data-testid="deal-booking-unlink"
                onClick={() => unlink.mutate({ bookingId: b.id })}
              >
                {t('unlink')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
  return (
    <section className="space-y-3" aria-label={t('panelTitle', { title: deal.title })} data-testid="deal-bookings">
      <div className="flex flex-wrap items-center gap-2">
        {/* Names the deal: on the board this panel sits above every card, so the heading is what says whose bookings these are. */}
        <h3 className="text-sm font-medium text-foreground">{t('panelTitle', { title: deal.title })}</h3>
        <Button size="sm" variant="outline" onClick={() => setBooking((o) => !o)} aria-expanded={booking} data-testid="deal-book">
          {t('book')}
        </Button>
      </div>
      <p className="text-xs text-subtle-foreground">{t('panelHint')}</p>
      {booking && <BookingSuggestCard slug={slug} dealId={deal.id} startOpen onClose={() => setBooking(false)} />}
      {bookings.error ? (
        <ErrorText>{errorMessage(bookings.error)}</ErrorText>
      ) : bookings.isPending ? (
        <p className="text-sm text-muted-foreground" role="status" data-testid="deal-bookings-loading">
          {t('loading')}
        </p>
      ) : bookings.data ? (
        <div className="space-y-3">
          {group('upcoming', bookings.data.upcoming)}
          {group('past', bookings.data.past)}
        </div>
      ) : null}
      {unlink.error && <ErrorText>{errorMessage(unlink.error)}</ErrorText>}
    </section>
  );
}
