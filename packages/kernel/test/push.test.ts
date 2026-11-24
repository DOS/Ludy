// SPDX-License-Identifier: AGPL-3.0-only
// Unit checks for the kernel's pushed notification registry (#3736, #4082): event-driven kinds populate PUSH_EVENTS, while cron-triggered kinds (meetings.morning) register their fixed line and app path without an outbox event.
import { describe, expect, it } from 'vitest';
import { MORNING_KIND, SUMMARY_READY_EVENT, SUMMARY_READY_KIND } from '@ludy/kernel-contract';
import { PUSH_EVENTS, PUSH_KINDS } from '../src/push.ts';

describe('kernel push kinds and events', () => {
  it('registers meetings.summary_ready with its outbox event and meeting path', () => {
    const summary = PUSH_KINDS.get(SUMMARY_READY_KIND);
    expect(summary).toBeDefined();
    expect(summary?.event).toBe(SUMMARY_READY_EVENT);
    expect(summary?.line).toBe('Bản nháp biên bản đã sẵn sàng để bạn xem');
    expect(summary?.path('acme', { type: 'meetings.meeting', id: '0193b3a0-1c2d-7e4f-8a9b-0c1d2e3f4a5b' })).toBe(
      '/o/acme/meetings/0193b3a0-1c2d-7e4f-8a9b-0c1d2e3f4a5b',
    );
    expect(summary?.path('acme', { type: null, id: null })).toBe('/o/acme/meetings');
  });

  it('registers meetings.morning with a fixed privacy-safe line and meetings path without an outbox event', () => {
    const morning = PUSH_KINDS.get(MORNING_KIND);
    expect(morning).toBeDefined();
    expect(morning?.event).toBeUndefined();
    expect(morning?.line).toBe('Hôm nay bạn có cuộc họp');
    expect(morning?.path('acme', { type: null, id: null })).toBe('/o/acme/meetings');
    expect(morning?.path('acme', { type: 'meetings.meeting', id: '0193b3a0-1c2d-7e4f-8a9b-0c1d2e3f4a5b' })).toBe('/o/acme/meetings');
  });

  it('collects only defined outbox event strings in PUSH_EVENTS', () => {
    expect([...PUSH_EVENTS]).toEqual([SUMMARY_READY_EVENT]);
    expect(PUSH_EVENTS.has(MORNING_KIND)).toBe(false);
    expect(PUSH_EVENTS.has(undefined as unknown as string)).toBe(false);
  });
});
