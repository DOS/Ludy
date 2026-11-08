// SPDX-License-Identifier: AGPL-3.0-only
// The timing and the codes of the e-invoice issue job (#2502): how long a pending invoice waits before the next question, when the day is over, and the rejection codes.
import { describe, expect, it } from 'vitest';
import { AMBIGUOUS_RETRY_SECONDS, EINVOICE_ERROR_CODES, STATUS_DEADLINE_HOURS, nextCheckDelaySeconds, rejectionCode, statusDeadlinePassed } from '../src/domain/einvoice-job.ts';

describe('the wait between questions', () => {
  it('starts in seconds, grows to minutes and never passes half an hour', () => {
    expect([0, 1, 2, 3, 4, 5].map(nextCheckDelaySeconds)).toEqual([5, 15, 30, 60, 120, 300]);
    expect(nextCheckDelaySeconds(9)).toBe(1800);
    expect(nextCheckDelaySeconds(10)).toBe(1800);
    expect(nextCheckDelaySeconds(10_000)).toBe(1800);
    expect(nextCheckDelaySeconds(-3)).toBe(5);
    expect(nextCheckDelaySeconds(2.9)).toBe(30);
  });
  it('holds about fifty questions in a day, so one connection is never asked faster than a provider allows', () => {
    let seconds = 0;
    let questions = 0;
    while (seconds < STATUS_DEADLINE_HOURS * 3600) {
      seconds += nextCheckDelaySeconds(questions);
      questions += 1;
    }
    expect(questions).toBeGreaterThan(40);
    expect(questions).toBeLessThan(70);
    expect(AMBIGUOUS_RETRY_SECONDS).toBe(60);
  });
});

describe('the end of the day', () => {
  it('is 24 hours after the submit time', () => {
    const submitted = new Date('2026-11-04T01:00:00Z');
    expect(statusDeadlinePassed(submitted, new Date('2026-11-05T00:59:59Z'))).toBe(false);
    expect(statusDeadlinePassed(submitted, new Date('2026-11-05T01:00:00Z'))).toBe(true);
  });
});

describe('the codes a draft carries', () => {
  it('maps each rejection the provider reports to a code, never to its text', () => {
    expect(rejectionCode('invalid_data')).toBe('REJECTED_INVALID_DATA');
    expect(rejectionCode('series_unknown')).toBe('REJECTED_SERIES_UNKNOWN');
    expect(rejectionCode('rejected_by_tax_authority')).toBe('REJECTED_BY_TAX_AUTHORITY');
    expect(rejectionCode('provider_refused')).toBe('REJECTED_BY_PROVIDER');
  });
  it('are upper case words the database accepts', () => {
    for (const code of Object.values(EINVOICE_ERROR_CODES)) expect(code).toMatch(/^[A-Z][A-Z0-9_]{1,59}$/);
  });
});
