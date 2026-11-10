// SPDX-License-Identifier: AGPL-3.0-only
// The nightly sweep of a member's private Vy data is scheduled with an expiry (#2822, from the review of #2920), so a pass that hangs does not hold the next night's
// run behind pg-boss's default. No database: the worker source is read as text.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MEMBER_VY_SWEEP_EXPIRE_SECONDS } from '../src/member-vy-worker.ts';

describe('the member Vy sweep schedule', () => {
  it('has an expiry above pg-boss\'s 15 minute default and below the day between two runs', () => {
    expect(MEMBER_VY_SWEEP_EXPIRE_SECONDS).toBeGreaterThan(900);
    expect(MEMBER_VY_SWEEP_EXPIRE_SECONDS).toBeLessThan(24 * 3600);
  });

  it('passes it to the schedule call in the worker', () => {
    const worker = readFileSync(fileURLToPath(new URL('../src/worker.ts', import.meta.url)), 'utf8');
    const call = /boss\.schedule\(QUEUES\.memberVySweep,[^)]*\)/.exec(worker)?.[0] ?? '';
    expect(call, 'the schedule call of the sweep is found').not.toBe('');
    expect(call).toContain('expireInSeconds: MEMBER_VY_SWEEP_EXPIRE_SECONDS');
  });
});
