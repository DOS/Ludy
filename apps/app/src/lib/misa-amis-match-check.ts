// SPDX-License-Identifier: AGPL-3.0-only
// The wait for a check against the firm's MISA catalogue (#4112): the worker does the check, so after it is queued the preview is read again every two seconds until it is no longer waiting, for half a minute at most.
import type { MisaAmisMatchStatus, MisaAmisPreview } from '@crove/kernel-contract';

export const CHECK_POLL_MS = 2000;
export const CHECK_WAIT_MS = 30_000;

// What the next tick does: `stop` when the check is no longer waiting (done or failed landed), `slow` when half a minute passed with no answer, `poll` to read the preview again.
// A null state is a re-read in flight with nothing yet to show: keep polling.
export function checkTick(state: MisaAmisMatchStatus['state'] | null, until: number, now: number): 'stop' | 'slow' | 'poll' {
  if (state !== null && state !== 'requested') return 'stop';
  return now > until ? 'slow' : 'poll';
}

// What the panel shows: the answer in hand for the choices on screen, or the last one that landed for them while a re-read is in flight (its data is cleared then), never an answer for other choices.
export function pickResult(last: { asked: string; data: MisaAmisPreview } | null, current: MisaAmisPreview | null, answeredFor: string | null, asked: string): MisaAmisPreview | null {
  if (current && answeredFor === asked) return current;
  return last && last.asked === asked ? last.data : null;
}
