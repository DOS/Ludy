// SPDX-License-Identifier: AGPL-3.0-only
// The public booking link, where the owner sets bookings up and sends it (#3643, audit CR-1, CR-11, CR-20): shown, copyable and
// openable on "Lịch hẹn" and on each event type, with "Cài đặt lịch hẹn" to the hours and types. Nothing is sent from here: the owner
// copies the link and sends it to the client themselves. The link is the address the server already serves (`bookingLinkOf`).
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import type { EventType } from '@crove/kernel-contract';
import { Button, buttonVariants } from '@crove/ui/components/button';
import { Input } from '@crove/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { orpc } from '../lib/api.ts';
import { appOrigin, BOOKING_EVENT_TYPES_ID, BOOKING_SETTINGS_ID, bookingLinkOf } from '../lib/booking.ts';

/** The booking link of one event type of the org. */
export const bookingUrlOf = (orgSlug: string, type: Pick<EventType, 'slug'>) => bookingLinkOf(appOrigin(), orgSlug, type.slug);

/** A button that copies `url` and says so; where the clipboard refuses, `onFail` lets the caller select the text for a manual copy. */
export function CopyBookingLinkButton({ url, title, onFail, variant = 'outline' }: { url: string; title?: string; onFail?: () => void; variant?: 'default' | 'outline' }) {
  const t = useTranslations('bookings.link');
  const [copied, setCopied] = useState(false);
  // Where the caller has no field to select, the link itself shows for a manual copy (a plain-HTTP page, or a refused clipboard).
  const [manual, setManual] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2500);
    return () => clearTimeout(timer);
  }, [copied]);
  useEffect(() => {
    if (manual) field.current?.select();
  }, [manual]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setManual(false);
    } catch {
      setCopied(false);
      if (onFail) onFail();
      else setManual(true);
    }
  };
  return (
    <>
      <Button size="sm" variant={variant} onClick={() => void copy()} aria-label={!copied && title ? t('copyOf', { title }) : undefined}>
        {copied ? t('copied') : t('copy')}
      </Button>
      <span role="status" className="sr-only">
        {copied ? t('copied') : ''}
      </span>
      {manual && <Input ref={field} readOnly value={url} aria-label={t('field')} className="w-full min-w-48 font-mono text-xs" onFocus={(e) => e.target.select()} />}
    </>
  );
}

/** "Xem trang" / "Mở thử": the booking page as the client sees it, in a new tab. */
export function OpenBookingPageLink({ url, title, label }: { url: string; title?: string; label: 'open' | 'view' }) {
  const t = useTranslations('bookings.link');
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className={buttonVariants({ size: 'sm', variant: 'outline' })} aria-label={title ? t(`${label}Of`, { title }) : undefined}>
      {t(label)}
    </a>
  );
}

/** "Cài đặt lịch hẹn": the working hours card in Settings, with the event types right below; `anchor` "eventTypes" goes to the event types card itself. */
export function BookingSettingsLink({ slug, children, className, anchor = 'hours' }: { slug: string; children: ReactNode; className?: string; anchor?: 'hours' | 'eventTypes' }) {
  return (
    <Link to="/o/$slug/settings/bookings" params={{ slug }} hash={anchor === 'eventTypes' ? BOOKING_EVENT_TYPES_ID : BOOKING_SETTINGS_ID} className={className}>
      {children}
    </Link>
  );
}

export interface BookingLinkState {
  /** The active event types, in the server's order. */
  types: readonly EventType[];
  /** The type whose link shows: the one picked, else the first. */
  chosen: EventType | undefined;
  pick: (id: string) => void;
  url: string | null;
  loaded: boolean;
}

/** The org's active event types and the link of the one chosen: one type, its link; several, the owner picks. A viewer changes no bookings, so reads nothing. */
export function useBookingLink(slug: string, enabled: boolean): BookingLinkState {
  const query = useQuery({ ...orpc.crm.eventTypes.list.queryOptions(), enabled });
  const types = (query.data ?? []).filter((e) => e.active);
  const [id, pick] = useState('');
  const chosen = types.find((e) => e.id === id) ?? types[0];
  return { types, chosen, pick, url: chosen ? bookingUrlOf(slug, chosen) : null, loaded: query.isSuccess };
}

/** The link in a read-only field with "Sao chép liên kết đặt lịch" and "Mở thử"; with several types a picker above it. */
export function BookingLinkBlock({ link }: { link: BookingLinkState }) {
  const t = useTranslations('bookings.link');
  const field = useRef<HTMLInputElement>(null);
  if (!link.chosen || !link.url) return null;
  return (
    <div className="w-full space-y-2" data-testid="booking-link">
      {link.types.length > 1 && (
        <label className="flex max-w-sm flex-col gap-1 text-xs text-muted-foreground">
          {t('type')}
          <NativeSelect value={link.chosen.id} onChange={(e) => link.pick(e.target.value)}>
            {link.types.map((e) => (
              <NativeSelectOption key={e.id} value={e.id}>
                {e.title}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
      )}
      <div className="flex flex-wrap gap-2">
        <Input ref={field} readOnly value={link.url} aria-label={t('field')} className="min-w-48 flex-1 font-mono text-xs" onFocus={(e) => e.target.select()} />
        <CopyBookingLinkButton key={link.url} url={link.url} variant="default" onFail={() => field.current?.select()} />
        <OpenBookingPageLink url={link.url} label="open" />
      </div>
    </div>
  );
}
