// SPDX-License-Identifier: AGPL-3.0-only
// The numbered facts of the brief before a meeting (#3543): one fixed order and numbering both the model's prompt and the page use, the day a task is due as the Vietnam day (a day starts at 17:00 UTC the
// evening before, so a slice of the instant is a day early), and the amounts as the books write them.
import { describe, expect, it } from 'vitest';
import { briefItemDue, briefLines, groupedAmount, vnDateOf, zBriefTarget, type BriefFacts } from '../src/meeting-brief.ts';

const ID = '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5b';
const item = (over: Partial<BriefFacts['items'][number]> = {}): BriefFacts['items'][number] => ({
  id: ID, title: 'Gửi báo giá', who: 'Nam', whoUserId: null, assigneeSeat: null, when: 'thứ sáu', whenDate: null, assigned: true, taskStatus: 'todo', due: null, ...over,
});
const facts = (over: Partial<BriefFacts> = {}): BriefFacts => ({
  previous: { meetingId: ID, title: 'Giao ban', startedAt: '2026-11-10T02:00:00.000Z' },
  decisions: ['Chốt giá'],
  items: [item()],
  customer: { partyId: ID, name: 'Công ty A' },
  deals: [{ id: ID, title: 'Gói năm', stage: 'Mới', amount: '15000000.00', expectedClose: '2026-12-31' }],
  empty: false,
  ...over,
});

describe('the day a task is due', () => {
  it('is the Vietnam day: a task due at 00:00 there (17:00 UTC the day before) is that day, not the one before', () => {
    expect(vnDateOf('2026-12-07T17:00:00.000Z')).toBe('2026-12-08');
    expect(vnDateOf('2026-12-08T00:00:00.000Z')).toBe('2026-12-08');
    expect(vnDateOf('2026-12-08T16:59:59.000Z')).toBe('2026-12-08');
  });

  it("is the live task's day when it has one, else the day said in the meeting, so the page and the facts say one date", () => {
    expect(briefItemDue({ due: '2026-12-07T17:00:00.000Z', whenDate: '2026-12-05' })).toBe('2026-12-08');
    expect(briefItemDue({ due: null, whenDate: '2026-12-05' })).toBe('2026-12-05');
    expect(briefItemDue({ due: null, whenDate: null })).toBeNull();
    expect(briefLines(facts({ items: [item({ due: '2026-12-07T17:00:00.000Z', whenDate: '2026-12-05' })] }))[1]?.text).toContain('due: 2026-12-08');
  });
});

describe('the numbered facts', () => {
  it('number decisions, then items, then deals, from 1, each with its source', () => {
    const lines = briefLines(facts());
    expect(lines.map((l) => [l.n, l.kind])).toEqual([[1, 'decision'], [2, 'item'], [3, 'deal']]);
    expect(lines[0]?.source).toEqual({ type: 'meeting', id: ID });
    expect(lines[2]?.source).toEqual({ type: 'deal', id: ID });
    expect(lines[2]?.text).toBe('Open deal for Công ty A: Gói năm (stage: Mới; amount: 15.000.000 VND; expected close: 2026-12-31)');
  });

  it('list no decision and no item without a previous meeting the member read, and nothing for an empty brief', () => {
    expect(briefLines(facts({ previous: null, decisions: [], items: [] })).map((l) => l.kind)).toEqual(['deal']);
    expect(briefLines(facts({ previous: null, decisions: [], items: [], customer: null, deals: [], empty: true }))).toEqual([]);
  });
});

describe('amounts and targets', () => {
  it('groups the integer part with dots, drops a fraction of zeros and keeps any other fraction as it is', () => {
    expect(groupedAmount('15000000')).toBe('15.000.000');
    expect(groupedAmount('15000000.00')).toBe('15.000.000');
    expect(groupedAmount('1250.50')).toBe('1.250,50');
    expect(groupedAmount('0')).toBe('0');
  });

  it('wants a meeting or a calendar event, not both and not neither', () => {
    expect(zBriefTarget.safeParse({ meetingId: ID }).success).toBe(true);
    expect(zBriefTarget.safeParse({ agendaId: ID }).success).toBe(true);
    expect(zBriefTarget.safeParse({}).success).toBe(false);
    expect(zBriefTarget.safeParse({ meetingId: ID, agendaId: ID }).success).toBe(false);
  });
});
