// SPDX-License-Identifier: AGPL-3.0-only
// The booking mails of a Google Meet booking (C7, #1375): the confirmation says where the meeting is (the join link once the Meet is made, else the type's fixed
// link, else only that it is online), the .ics carries the same in LOCATION and URL, the host is told when the Meet could not be made, and a cancelled booking
// names no link.
import { describe, expect, it } from 'vitest';
import { bookingPlace, renderBookingMail } from '../src/booking-mail.ts';
import type { MailTemplateInput } from '../src/mail-queue.ts';

const NOW = new Date('2026-11-01T00:00:00.000Z');
const MEET = 'https://meet.google.com/abc-defg-hij';
const FIXED = 'https://rooms.example.test/phong-1';
const base = {
  kind: 'confirmed',
  recipient: 'visitor',
  bookingId: '0192f0aa-0000-7000-8000-000000000001',
  revision: 0,
  org: 'cong-ty-a',
  orgName: 'Công ty A',
  type: 'tu-van',
  title: 'Tư vấn thuế',
  startsAt: '2026-11-02T02:00:00.000Z',
  endsAt: '2026-11-02T02:30:00.000Z',
  timeZone: 'Asia/Ho_Chi_Minh',
  locationKind: 'google_meet',
  location: null as string | null,
};
type Meeting = { state: 'none' | 'pending' | 'ready' | 'failed'; url: string | null };
const ready: Meeting = { state: 'ready', url: MEET };

function input(payload: Record<string, unknown>, meeting: Meeting | undefined): MailTemplateInput {
  return {
    messageId: 'm1',
    subject: 'Đã xác nhận lịch hẹn: Tư vấn thuế',
    payload,
    publicUrl: 'https://app.example.test/',
    inboundAddress: null,
    brand: 'Ludy',
    execute: async <T,>() => ({ token: null, visitor: { name: 'Nguyễn Văn Khách', email: 'khach@example.test', phone: null, note: null }, ...(meeting ? { meeting } : {}) }) as T,
  };
}
const icsOf = (mail: Awaited<ReturnType<typeof renderBookingMail>>) => (mail?.attachments?.[0]?.content ?? '').split('\r\n');

describe('where a Google Meet booking says the meeting is', () => {
  it('names the join link once the Meet is made', () => {
    expect(bookingPlace({ ...base, locationKind: 'google_meet', kind: 'confirmed', meeting: ready } as never)).toEqual({ label: 'Google Meet', link: MEET });
  });

  it('falls back to the type\'s fixed link when the Meet is not made (failed, still pending, or none), and to nothing when there is none', () => {
    for (const state of ['failed', 'pending', 'none'] as const) {
      expect(bookingPlace({ kind: 'confirmed', locationKind: 'google_meet', location: FIXED, meeting: { state, url: null } })).toEqual({ label: 'Họp trực tuyến', link: FIXED });
      expect(bookingPlace({ kind: 'confirmed', locationKind: 'google_meet', location: null, meeting: { state, url: null } })).toEqual({ label: 'Họp trực tuyến', link: null });
    }
  });

  it('names no link for a cancelled booking, and leaves every other kind of location as it was', () => {
    expect(bookingPlace({ kind: 'cancelled', locationKind: 'google_meet', location: FIXED, meeting: ready })).toEqual({ label: 'Google Meet', link: null });
    const none: Meeting = { state: 'none', url: null };
    expect(bookingPlace({ kind: 'confirmed', locationKind: 'video', location: FIXED, meeting: none })).toEqual({ label: 'Họp trực tuyến', link: FIXED });
    expect(bookingPlace({ kind: 'confirmed', locationKind: 'in_person', location: '12 Lê Lợi', meeting: none })).toEqual({ label: 'Gặp trực tiếp', link: '12 Lê Lợi' });
  });

  it('keeps the join link of a booking whose type the host has switched away from Meet since, in what is sent later', () => {
    for (const kind of ['reminder', 'moved'] as const) expect(bookingPlace({ kind, locationKind: 'video', location: FIXED, meeting: ready })).toEqual({ label: 'Google Meet', link: MEET });
    expect(bookingPlace({ kind: 'cancelled', locationKind: 'video', location: FIXED, meeting: ready })).toEqual({ label: 'Họp trực tuyến', link: FIXED });
  });
});

describe('the mails of a Google Meet booking', () => {
  it('carries the join link in the text, the page and the .ics (LOCATION, URL and the description) of the confirmation', async () => {
    const mail = await renderBookingMail(input(base, ready), () => NOW);
    expect(mail?.text).toContain(`Hình thức: Google Meet: ${MEET}`);
    expect(mail?.html).toContain(MEET);
    const ics = icsOf(mail);
    expect(ics).toContain(`LOCATION:${MEET}`);
    expect(ics).toContain(`URL:${MEET}`);
    expect(ics.some((l) => l.startsWith('DESCRIPTION:Google Meet: https://meet.google.com/abc-defg-hij'))).toBe(true);
  });

  it('carries the fixed link when the Meet failed, tells the host, and tells the visitor nothing of the failure', async () => {
    const failed: Meeting = { state: 'failed', url: null };
    const visitor = await renderBookingMail(input({ ...base, location: FIXED }, failed), () => NOW);
    expect(visitor?.text).toContain(`Hình thức: Họp trực tuyến: ${FIXED}`);
    expect(visitor?.text).not.toContain('Google Meet');
    expect(icsOf(visitor)).toContain(`LOCATION:${FIXED}`);
    const host = await renderBookingMail(input({ ...base, recipient: 'host', location: FIXED }, failed), () => NOW);
    expect(host?.text).toContain('Chưa tạo được liên kết Google Meet; đã dùng liên kết cố định');
    // With no fixed link the host is asked to send one; the visitor's mail says it is an online meeting and nothing more.
    const bare = await renderBookingMail(input({ ...base, recipient: 'host' }, failed), () => NOW);
    expect(bare?.text).toContain('hãy gửi liên kết cho khách');
    const bareVisitor = await renderBookingMail(input(base, failed), () => NOW);
    expect(bareVisitor?.text).toContain('Hình thức: Họp trực tuyến');
    expect(icsOf(bareVisitor).some((l) => l.startsWith('LOCATION:'))).toBe(false);
  });

  it('keeps the link in a reminder and a move, which read the booking as it is when they are sent, and none in a cancel', async () => {
    for (const kind of ['reminder', 'moved'] as const) expect((await renderBookingMail(input({ ...base, kind }, ready), () => NOW))?.text).toContain(MEET);
    const cancelled = await renderBookingMail(input({ ...base, kind: 'cancelled' }, ready), () => NOW);
    expect(cancelled?.text).not.toContain(MEET);
    // No line of a cancelled booking's .ics carries a Meet address (the pattern names the scheme and the host, not a substring of the text).
    expect(icsOf(cancelled).some((l) => /https:\/\/meet\.google\.com\//.test(l))).toBe(false);
  });

  it('tells a host of a failure even when the type has been switched away from Meet since, tells no host of one for a booking that never asked, and treats data without a meeting as none', async () => {
    // `failed` is only ever set for a booking whose type asked for a Meet when it was confirmed: the type's kind now does not matter.
    const switched = await renderBookingMail(input({ ...base, recipient: 'host', locationKind: 'video', location: FIXED }, { state: 'failed', url: null }), () => NOW);
    expect(switched?.text).toContain('Chưa tạo được liên kết Google Meet');
    // After a switch to a place the type's value is an address: the note does not call it a link.
    const place = await renderBookingMail(input({ ...base, recipient: 'host', locationKind: 'in_person', location: '12 Lê Lợi' }, { state: 'failed', url: null }), () => NOW);
    expect(place?.text).toContain('hãy gửi liên kết cho khách');
    expect(place?.text).not.toContain('đã dùng liên kết cố định');
    const never = await renderBookingMail(input({ ...base, recipient: 'host', locationKind: 'video', location: FIXED }, { state: 'none', url: null }), () => NOW);
    expect(never?.text).not.toContain('Google Meet');
    // A booking's later mails (a reminder, a move) do not repeat the failure: the host heard it with the new booking.
    for (const kind of ['reminder', 'moved'] as const) {
      const later = await renderBookingMail(input({ ...base, kind, recipient: 'host', location: FIXED }, { state: 'failed', url: null }), () => NOW);
      expect(later?.text, kind).not.toContain('Chưa tạo được liên kết Google Meet');
    }
    // The .ics names a URL only for the Meet link: another kind of location is as it was before.
    const fixed = await renderBookingMail(input({ ...base, locationKind: 'video', location: FIXED }, { state: 'none', url: null }), () => NOW);
    expect(icsOf(fixed)).toContain(`LOCATION:${FIXED}`);
    expect(icsOf(fixed).some((l) => l.startsWith('URL:'))).toBe(false);
    const old = await renderBookingMail(input({ ...base, locationKind: 'video', location: FIXED }, undefined), () => NOW);
    expect(old?.text).toContain(`Hình thức: Họp trực tuyến: ${FIXED}`);
  });
});
