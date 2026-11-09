// SPDX-License-Identifier: AGPL-3.0-only
// A CRM deal or booking written as a sentence for the finance coworker's text box on a sales invoice draft (#2721). The person sees the sentence in the box and may edit it before asking, so
// what the coworker reads is what is on screen, and its figures are checked against that text as for any typed text. No browser or API imports, so it is unit tested.
import type { BookingItem } from '@crove/kernel-contract';

const NOTE_MAX = 200;
const oneLine = (value: string, max: number): string => value.replace(/\s+/g, ' ').trim().slice(0, max);

/** "Cơ hội <title> của <customer>, giá trị <amount> VND." The amount is the deal's decimal string as it is, with no thousands separators, so a figure the model returns matches the text. */
export function dealSourceText(deal: { title: string; partyName: string; amount: string }): string {
  return `Cơ hội ${oneLine(deal.title, 200)} của ${oneLine(deal.partyName, 200)}, giá trị ${deal.amount} VND.`;
}

/** "Lịch hẹn <event> ngày <date>, ghi chú của khách: <note>." The visitor's note is the visitor's own text, cut short and flattened to one line; it may be null once erased. */
export function bookingSourceText(booking: Pick<BookingItem, 'startsAt' | 'eventType' | 'visitor'>, date: string): string {
  const note = booking.visitor.note ? oneLine(booking.visitor.note, NOTE_MAX) : '';
  return `Lịch hẹn ${oneLine(booking.eventType.title, 200)} ngày ${date}${note === '' ? '.' : `, ghi chú của khách: ${note}.`}`;
}

/** The sentence added after what the person already typed, on a new line, never over it. A sentence that does not fit whole is not added, so a figure is never cut in the middle. */
export function appendSource(typed: string, sentence: string, max: number): string {
  const text = typed.trim() === '' ? sentence : `${typed.replace(/\s+$/, '')}\n${sentence}`;
  return text.length > max ? typed : text;
}

/** The date a booking starts on in Vietnam (the invoice's calendar), YYYY-MM-DD: the UTC date would be a day early for a booking between 00:00 and 07:00 Vietnam time. */
export function bookingDay(startsAt: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(startsAt));
}
