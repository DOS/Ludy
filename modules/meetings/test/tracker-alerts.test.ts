// SPDX-License-Identifier: AGPL-3.0-only
// The counting of tracked words in the published minutes text for the alert (#4873): the same counting as the Trackers card, the busiest words first, at most five, none for a word that does not come up.
import { describe, expect, it } from 'vitest';
import { encodeTrackerAlertTerms, parseTrackerAlertTerms, TRACKER_ALERT_TERMS_MAX } from '@ludy/kernel-contract';
import { countTrackerHits } from '../src/tracker-alerts.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('countTrackerHits', () => {
  const terms = [
    { id: id(1), term: 'giá' },
    { id: id(2), term: 'Hợp đồng' },
    { id: id(3), term: 'ACME' },
    { id: id(4), term: 'đối thủ' },
  ];

  it('counts whole words over all the texts, the busiest first, and leaves out a word that does not come up', () => {
    const hits = countTrackerHits(terms, ['Khách hỏi giá và hợp đồng, giá cao.', 'Quyết định: gửi hợp đồng cho ACME.', 'Việc: báo giá']);
    expect(hits).toEqual([
      { termId: id(1), count: 3 },
      { termId: id(2), count: 2 },
      { termId: id(3), count: 1 },
    ]);
  });

  it('finds a term typed with marks with its marks only, and one typed without marks whatever the line has', () => {
    expect(countTrackerHits([{ id: id(1), term: 'giá' }], ['già, giả, gia đình'])).toEqual([]);
    expect(countTrackerHits([{ id: id(1), term: 'gia' }], ['giá, già, giả'])).toEqual([{ termId: id(1), count: 3 }]);
  });

  it('breaks a tie by id and keeps at most five words', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ id: id(i + 1), term: `tu${String.fromCharCode(97 + i)}` }));
    const hits = countTrackerHits(many, [many.map((m) => m.term).join(' ')]);
    expect(hits).toHaveLength(TRACKER_ALERT_TERMS_MAX);
    expect(hits.map((h) => h.termId)).toEqual([id(1), id(2), id(3), id(4), id(5)]);
  });

  it('is empty with no text or no word', () => {
    expect(countTrackerHits(terms, [])).toEqual([]);
    expect(countTrackerHits([], ['giá'])).toEqual([]);
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
