// SPDX-License-Identifier: AGPL-3.0-only
// The wait for a check against the firm's MISA catalogue (#4112): the worker does the check, so after it is queued the preview is read again every two seconds until it is no longer waiting, for half a minute at most.
import type { MisaAmisMatchStatus } from '@crove/kernel-contract';

export const CHECK_POLL_MS = 2000;
export const CHECK_WAIT_MS = 30_000;

// What the next tick does: `stop` when the check is no longer waiting (done or failed landed), `slow` when half a minute passed with no answer, `poll` to read the preview again.
export function checkTick(state: MisaAmisMatchStatus['state'] | null, until: number, now: number): 'stop' | 'slow' | 'poll' {
  if (state !== 'requested') return 'stop';
  return now > until ? 'slow' : 'poll';
}
