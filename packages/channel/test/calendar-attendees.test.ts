// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { normalizeAttendeeEmails } from '../src/calendar-attendees.ts';

describe('normalizeAttendeeEmails (#4991)', () => {
  it('excludes self, resource rooms, and malformed emails, trims and lowercases while preserving dots, and deduplicates sorted up to 50', () => {
    const raw = [
      { email: 'Me@Example.COM', self: true, resource: false },
      { email: 'room-a@resource.calendar.example', self: false, resource: true },
      { email: '  Minh.Nguyen+VIP@Example.COM ', self: false, resource: false },
      { email: 'minh.nguyen+vip@example.com' },
      { email: 'An@Example.ORG' },
      { email: 'invalid-no-at' },
      { email: '' },
      null,
    ];
    expect(
      normalizeAttendeeEmails(raw, (item) => (item && typeof item === 'object' ? (item as { email?: unknown; self?: unknown; resource?: unknown }) : null)),
    ).toEqual(['an@example.org', 'minh.nguyen+vip@example.com']);
  });

  it('caps deduplicated attendee emails at 50', () => {
    const many = Array.from({ length: 70 }, (_, i) => ({ email: `person${i}@example.test` }));
    const result = normalizeAttendeeEmails(many, (item) => item as { email?: unknown });
    expect(result).toHaveLength(50);
    expect(result).not.toContain('person50@example.test');
  });
});
