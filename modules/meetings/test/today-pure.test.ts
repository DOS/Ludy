// SPDX-License-Identifier: AGPL-3.0-only
// The pure parts of the Today view (#3955, review follow-ups of #3968): the time the day's events occupy, and the CRM stage names being read once for the whole day.
import { describe, expect, it, vi } from 'vitest';
import { stageNamesOnce } from '../src/brief.ts';
import { occupiedMinutes } from '../src/today.ts';

const at = (hhmm: string) => `2026-11-19T${hhmm}:00+07:00`;
const ev = (from: string, to: string) => ({ startsAt: at(from), endsAt: at(to) });

describe('occupiedMinutes', () => {
  it('sums events that do not overlap, as a plain sum did', () => {
    expect(occupiedMinutes([ev('09:00', '10:00'), ev('13:00', '14:30'), ev('16:00', '17:00')])).toBe(60 + 90 + 60);
  });

  it('counts two simultaneous one hour events as one hour', () => {
    expect(occupiedMinutes([ev('09:00', '10:00'), ev('09:00', '10:00')])).toBe(60);
  });

  it('merges partly overlapping, nested and touching events, in any order', () => {
    expect(occupiedMinutes([ev('10:30', '11:30'), ev('09:00', '10:45')])).toBe(150);
    expect(occupiedMinutes([ev('09:00', '12:00'), ev('10:00', '11:00')])).toBe(180);
    expect(occupiedMinutes([ev('09:00', '10:00'), ev('10:00', '11:00')])).toBe(120);
  });

  it('counts nothing for no event, an event that ends before it starts or one with no time', () => {
    expect(occupiedMinutes([])).toBe(0);
    expect(occupiedMinutes([ev('10:00', '09:00'), { startsAt: 'x', endsAt: at('10:00') }])).toBe(0);
  });
});

describe('stageNamesOnce', () => {
  it('asks the CRM module once however many times the names are wanted, and not at all when none is', async () => {
    const query = vi.fn(async () => ({ status: 'ok' as const, value: [{ id: 's1', name: 'Báo giá' }] }));
    const names = stageNamesOnce({ query: query as never });
    expect(query).not.toHaveBeenCalled();
    const [a, b, c] = await Promise.all([names(), names(), names()]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(a.get('s1')).toBe('Báo giá');
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('gives no names where the CRM module is not installed', async () => {
    const names = stageNamesOnce({ query: (async () => ({ status: 'not_installed' })) as never });
    expect((await names()).size).toBe(0);
  });
});
