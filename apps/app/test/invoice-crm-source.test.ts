// SPDX-License-Identifier: AGPL-3.0-only
// A CRM deal or booking as a sentence for the finance coworker's text box (#2721): the figures stay as the CRM holds them, the visitor's note is flattened and cut, and a sentence is added after the
// typed text, never over it.
import { describe, expect, it } from 'vitest';
import { appendSource, bookingDay, bookingSourceText, dealSourceText } from '../src/lib/invoice-crm-source.ts';

const booking = (note: string | null) => ({ startsAt: '2026-11-05T03:00:00.000Z', eventType: { id: 'e', slug: 's', title: 'Tư vấn   thiết kế', active: true }, visitor: { name: null, email: null, phone: null, note } });

describe('invoice CRM source', () => {
  it('writes a deal with its amount as the CRM holds it', () => {
    expect(dealSourceText({ title: 'Bộ bánh Tết', partyName: 'Công ty Hoa Mai', amount: '12500000.5' })).toBe('Cơ hội Bộ bánh Tết của Công ty Hoa Mai, giá trị 12500000.5 VND.');
  });

  it('writes a booking with its date and the visitor note on one line, cut short, or without a note', () => {
    expect(bookingSourceText(booking('hai dòng\n\nthứ hai'), '05/11/2026')).toBe('Lịch hẹn Tư vấn thiết kế ngày 05/11/2026, ghi chú của khách: hai dòng thứ hai.');
    expect(bookingSourceText(booking(null), '05/11/2026')).toBe('Lịch hẹn Tư vấn thiết kế ngày 05/11/2026.');
    expect(bookingSourceText(booking('x'.repeat(500)), 'd').length).toBeLessThan(300);
  });

  it('adds the sentence after the typed text on a new line, and never grows past the limit', () => {
    expect(appendSource('', 'A', 100)).toBe('A');
    expect(appendSource('bán 10 hộp  \n', 'A', 100)).toBe('bán 10 hộp\nA');
    // A sentence that does not fit whole is left out, never cut in the middle of a figure.
    expect(appendSource('x'.repeat(95), 'giá trị 12500000 VND.', 100)).toBe('x'.repeat(95));
    expect(appendSource('', 'x'.repeat(101), 100)).toBe('');
  });

  it('gives the Vietnam day of a booking, not the UTC day', () => {
    expect(bookingDay('2026-11-04T18:30:00.000Z')).toBe('2026-11-05');
    expect(bookingDay('2026-11-05T03:00:00.000Z')).toBe('2026-11-05');
  });
});
