// SPDX-License-Identifier: AGPL-3.0-only
// The words an owner reads in the CRM screens (#3650): no server or queue jargon ("máy chủ", "hàng đợi", "server", "queued") and no provider API name ("Calendars.ReadBasic"), in either
// language; the screens say what happened in a shop owner's words.
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/messages/en.ts';
import { vi } from '../src/i18n/messages/vi.ts';
import { zoneLabel, timeZones } from '../src/lib/calendar.ts';

// The CRM screens' namespaces: Deals (with its quotes), Bookings and the booking page, Contacts and their import, working hours and the outside calendars, saved views, the accountant's client list.
const CRM = ['deals', 'quotes', 'bookings', 'contacts', 'contactImport', 'workingHours', 'savedViews', 'clients'] as const;
const JARGON = {
  vi: /máy chủ|hàng đợi|Calendars\.|Graph API/i,
  en: /\bserver\b|\bqueued?\b|Calendars\.|Graph API/i,
};

// Every string of a namespace, with its path.
function strings(value: unknown, path: string): [string, string][] {
  if (typeof value === 'string') return [[path, value]];
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, child]) => strings(child, `${path}.${key}`));
  return [];
}

describe('the CRM words', () => {
  for (const [lang, messages] of [['vi', vi], ['en', en]] as const) {
    it(`say no server, queue or provider API name in ${lang}`, () => {
      const hits = CRM.flatMap((ns) => strings(messages[ns], ns)).filter(([, text]) => JARGON[lang].test(text));
      expect(hits).toEqual([]);
    });
  }

  it('says AI is not on for the organization in plain words, in the four places that said "this server"', () => {
    for (const text of [vi.deals.nextSteps.followup.state.off, vi.quotes.suggest.state.off, vi.bookings.deal.brief.state.off, vi.bookings.suggest.ai.off]) expect(text).toMatch(/^AI chưa bật cho tổ chức này/);
    for (const text of [en.deals.nextSteps.followup.state.off, en.quotes.suggest.state.off, en.bookings.deal.brief.state.off, en.bookings.suggest.ai.off]) expect(text).toMatch(/^AI is not turned on for this organization/);
  });

  it('says a mail will go in a few minutes, not that it was queued', () => {
    expect(vi.quotes.send.mailed).toBe('Thư sẽ được gửi trong ít phút.');
    expect(en.quotes.send.mailed).toBe('The mail will be sent within a few minutes.');
  });

  it('calls the screen of people what the menu calls it', () => {
    expect(vi.contacts.title).toBe(vi.nav.contacts);
    expect(en.contacts.title).toBe(en.nav.contacts);
    // And counts them by the noun of the screen.
    expect(vi.contacts.more).toContain('người liên hệ');
    expect(vi.contacts.companiesMore).toContain('công ty');
  });
});

describe('a time zone as a person says it (#3650)', () => {
  it('has a place and an offset, no IANA name', () => {
    const at = Date.parse('2026-11-02T02:00:00.000Z');
    expect(zoneLabel('Asia/Ho_Chi_Minh', 'Việt Nam', at)).toBe('Việt Nam (GMT+7)');
    expect(zoneLabel('Asia/Tokyo', 'Việt Nam', at)).toBe('Tokyo (GMT+9)');
    expect(zoneLabel('America/New_York', 'Vietnam', at)).toBe('New York (GMT-5)');
  });

  it('lists Vietnam first and keeps the member\'s own zone when the browser does not list it', () => {
    expect(timeZones('Asia/Tokyo')[0]).toBe('Asia/Ho_Chi_Minh');
    expect(timeZones('Not/Listed')[0]).toBe('Not/Listed');
  });
});
