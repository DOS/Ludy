// SPDX-License-Identifier: AGPL-3.0-only
// What the alert does with the counts the counting definer returns (#4873): the busiest words first, at most five, none for a word that does not come up. The counting itself is held to the Trackers card's
// (tracker-count.ts) by the database test, which runs the same fixtures through the SQL and through the TS.
import { describe, expect, it } from 'vitest';
import { encodeTrackerAlertTerms, parseTrackerAlertTerms, TRACKER_ALERT_TERMS_MAX } from '@ludy/kernel-contract';
import { topTrackerHits } from '../src/tracker-alerts.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('topTrackerHits', () => {
  it('orders the words by how often they came up, the busiest first', () => {
    expect(
      topTrackerHits([
        { term_id: id(2), hits: 2 },
        { term_id: id(1), hits: 3 },
        { term_id: id(3), hits: 1 },
      ]),
    ).toEqual([
      { termId: id(1), count: 3 },
      { termId: id(2), count: 2 },
      { termId: id(3), count: 1 },
    ]);
  });

  it('leaves out a word that did not come up', () => {
    expect(topTrackerHits([{ term_id: id(1), hits: 0 }, { term_id: id(2), hits: 4 }])).toEqual([{ termId: id(2), count: 4 }]);
  });

  it('breaks a tie by id and keeps at most five words', () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({ term_id: id(8 - i), hits: 1 }));
    const hits = topTrackerHits(rows);
    expect(hits).toHaveLength(TRACKER_ALERT_TERMS_MAX);
    expect(hits.map((h) => h.termId)).toEqual([id(1), id(2), id(3), id(4), id(5)]);
  });

  it('is empty when no word came up', () => {
    expect(topTrackerHits([])).toEqual([]);
  });
});

describe('the notice detail', () => {
  it('writes ids and counts only, and reads back exactly what it wrote', () => {
    const terms = [{ termId: id(1), count: 3 }, { termId: id(2), count: 12 }];
    const detail = encodeTrackerAlertTerms(terms);
    expect(detail).toEqual({ terms: `${id(1)}:3,${id(2)}:12` });
    expect(parseTrackerAlertTerms(detail)).toEqual(terms);
  });

  it('drops a value that is not exactly that shape: never shown', () => {
    for (const bad of [undefined, '', 'giá:3', `${id(1)}:0`, `${id(1)}:3,x`, `${id(1)}:3 `, 7, 'a'.repeat(401)]) expect(parseTrackerAlertTerms({ terms: bad })).toEqual([]);
    expect(parseTrackerAlertTerms(null)).toEqual([]);
  });

  it('keeps at most five words', () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ termId: id(i + 1), count: 1 }));
    expect(parseTrackerAlertTerms(encodeTrackerAlertTerms(six))).toHaveLength(TRACKER_ALERT_TERMS_MAX);
  });
});
