// SPDX-License-Identifier: AGPL-3.0-only
// A booking and its deal (#3103, docs/plan/calendar.md "Deal links"). On a deal, the panel lists the deal's upcoming and past bookings and "Đặt lịch" starts a booking from the
// deal: the link it offers the client carries the deal, so the client's booking arrives already linked. On a booking of the "Lịch hẹn" screen, the deal it is linked to (with
// "Gỡ liên kết") or, for a booking with none, the open deals the coworker suggests for the guest by a fixed rule on their email and phone (no model call): nothing is linked until
// a person presses "Liên kết". Only people who read bookings see any of it; the server shows each person the bookings they may read.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import type { BookingItem } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { BookingSuggestCard } from './booking-suggest.tsx';
import { ErrorText } from './ui.tsx';
import { useLocaleSetting } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { visitorTimeZone } from '../lib/booking.ts';
import { whenOf } from '../routes/booking-page.tsx';

const refreshBookings = () => {
  void queryClient.invalidateQueries({ queryKey: orpc.crm.bookings.list.key() });
  void queryClient.invalidateQueries({ queryKey: orpc.crm.deals.bookings.key() });
};

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
    <section className="space-y-3" aria-label={t('panelTitle')} data-testid="deal-bookings">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium text-foreground">{t('panelTitle')}</h3>
        <Button size="sm" variant="outline" onClick={() => setBooking((o) => !o)} aria-expanded={booking} data-testid="deal-book">
          {t('book')}
        </Button>
      </div>
      <p className="text-xs text-subtle-foreground">{t('panelHint')}</p>
      {booking && <BookingSuggestCard slug={slug} dealId={deal.id} startOpen onClose={() => setBooking(false)} />}
      {bookings.error ? (
        <ErrorText>{errorMessage(bookings.error)}</ErrorText>
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
