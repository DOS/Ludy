// SPDX-License-Identifier: AGPL-3.0-only
// "Khi nào đăng?" in the composer (#3653): the next free slot is offered only to channels that have slots, so the first
// post of a new channel is given a time and never meets "the queue is empty"; the card reads in both languages.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WhenCard } from '../src/components/social-when-card.tsx';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { en } from '../src/i18n/messages/en.ts';
import { vi } from '../src/i18n/messages/vi.ts';
import { setActiveLocale } from '../src/i18n/runtime.ts';
import { defaultPostTime, effectiveWhen, futureInstant, queueReady } from '../src/lib/social-when.ts';

const render = (node: React.ReactNode, locale: 'vi' | 'en' = 'vi') => {
  setActiveLocale(locale);
  return renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>);
};
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const card = (over: Partial<React.ComponentProps<typeof WhenCard>> = {}) => (
  <WhenCard mode="time" onMode={() => undefined} queueAvailable={false} noSlots={false} value="2026-11-18T09:00" onValue={() => undefined} min="2026-11-17T10:00" timeInPast={false} {...over} />
);

describe('the time a new post goes out is chosen (#3653)', () => {
  it('starts from 09:00 today when that is more than an hour away, else 09:00 tomorrow', () => {
    expect(defaultPostTime(new Date(2026, 10, 17, 7, 0))).toBe('2026-11-17T09:00');
    expect(defaultPostTime(new Date(2026, 10, 17, 8, 30))).toBe('2026-11-18T09:00');
    expect(defaultPostTime(new Date(2026, 10, 17, 15, 0))).toBe('2026-11-18T09:00');
    // A month's end.
    expect(defaultPostTime(new Date(2026, 10, 30, 20, 0))).toBe('2026-12-01T09:00');
  });

  it('offers the queue only when every chosen channel has slots and none is paused', () => {
    expect(queueReady([])).toBe(false);
    // Not read yet: never offered, so no one is sent to an empty queue.
    expect(queueReady([null])).toBe(false);
    // A fresh channel has no slots.
    expect(queueReady([{ slots: 0, paused: false }])).toBe(false);
    expect(queueReady([{ slots: 7, paused: true }])).toBe(false);
    expect(queueReady([{ slots: 7, paused: false }, { slots: 0, paused: false }])).toBe(false);
    expect(queueReady([{ slots: 7, paused: false }, { slots: 3, paused: false }])).toBe(true);
  });

  it('defaults to the next free slot when the channels have one, else a time, and drops a queue choice that no longer holds', () => {
    expect(effectiveWhen(null, true)).toBe('queue');
    expect(effectiveWhen(null, false)).toBe('time');
    expect(effectiveWhen('queue', false)).toBe('time');
    expect(effectiveWhen('time', true)).toBe('time');
    expect(effectiveWhen('draft', true)).toBe('draft');
    expect(effectiveWhen('draft', false)).toBe('draft');
  });

  it('sends a time only while it is ahead', () => {
    const now = Date.parse('2026-11-17T03:00:00.000Z');
    expect(futureInstant('2026-11-18T02:00:00.000Z', now)).toBe('2026-11-18T02:00:00.000Z');
    expect(futureInstant('2026-11-17T02:00:00.000Z', now)).toBeNull();
    expect(futureInstant(null, now)).toBeNull();
  });
});

describe('the "when" card', () => {
  it('has no next-free-slot choice for a channel without slots, and says why', () => {
    const html = render(card({ noSlots: true }));
    const read = text(html);
    expect(read).toContain('Khi nào đăng?');
    expect(read).toContain('Giờ cụ thể');
    expect(read).toContain('Chọn giờ sau');
    expect(read).not.toContain('Khung giờ trống kế tiếp');
    expect(read).toContain('chưa có khung giờ đăng cố định');
    expect(html).toMatch(/aria-pressed="true"[^>]*>Giờ cụ thể/);
  });

  it('offers the three choices when the channels have slots, and shows the time field only for a time', () => {
    const all = text(render(card({ queueAvailable: true })));
    expect(all).toContain('Giờ cụ thể');
    expect(all).toContain('Khung giờ trống kế tiếp');
    expect(all).toContain('Chọn giờ sau');
    expect(render(card({ queueAvailable: true, mode: 'time' }))).toContain('aria-label="Ngày và giờ đăng"');
    const queue = render(card({ queueAvailable: true, mode: 'queue' }));
    expect(queue).not.toContain('aria-label="Ngày và giờ đăng"');
    expect(text(queue)).toContain('Mỗi kênh đăng ở khung giờ trống kế tiếp');
    const draft = render(card({ queueAvailable: true, mode: 'draft' }));
    expect(draft).not.toContain('aria-label="Ngày và giờ đăng"');
    expect(text(draft)).toContain('Bài chưa có giờ đăng');
    
  });

  it('tells a time that has passed, in both languages', () => {
    expect(text(render(card({ timeInPast: true })))).toContain('Giờ này đã qua');
    expect(text(render(card({ timeInPast: true }), 'en'))).toContain('That time has passed');
    expect(text(render(card({ queueAvailable: true }), 'en'))).toContain('When should it go out?');
  });

  it('names the outcome on the button and gives a reason for a disabled one, with no setting names, in both languages', () => {
    expect(vi.social.publishAt).toBe('Duyệt và đăng lúc {time} ngày {date}');
    expect(en.social.publishAt).toBe('Approve and post at {time} on {date}');
    expect(vi.social.publishInQueue).toContain('khung giờ kế tiếp');
    for (const copy of [vi.social, en.social]) {
      for (const key of ['whenTitle', 'whenLater', 'whenTimeLabel', 'whenPast', 'whenDraftHint', 'whenQueueHint', 'whenNoSlotsHint', 'whyPickChannel', 'whyBlocking', 'whyPickTime'] as const) {
        expect(copy[key], key).not.toMatch(/queue|hàng đợi|[A-Z]{3,}_[A-Z_]+/);
      }
    }
  });
});
