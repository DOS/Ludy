// SPDX-License-Identifier: AGPL-3.0-only
// The policy of the pause of a stopped launch (W2-4a, issue #2296, ADR-0043 points 4 and 7a): a launch that is stopped is WOUND DOWN, which is to say that what it made at
// the platform is paused. This file is the rules of that obligation, with no database and no network: when a run is due again, what a run's answer means, and when Ludy
// gives up and tells the person to pause by hand at the platform. It follows the revoke's policy (token-revoke.ts) on purpose: the same backoff, the same ten tries and
// seven days, because the sealed copy of a closed connection's token, the only token left to pause with after a switch-off, lives for seven days at most.
//
// Nothing here ever holds a token: it deals in states, counts, times and codes.
import { backoffMs, REVOKE_MAX_AGE_MS, REVOKE_MAX_ATTEMPTS } from './token-revoke.ts';

export const WIND_DOWN_MAX_TRIES = REVOKE_MAX_ATTEMPTS;
export const WIND_DOWN_MAX_AGE_MS = REVOKE_MAX_AGE_MS;
// How long a run holds a stopped launch (the lease the claim takes): a run that dies is found again after this, by the sweep.
export const WIND_DOWN_LEASE_SECONDS = 600;

// Why Ludy gave up (the codes the ledger holds): the token was refused or there is none (nothing can be paused from here), ten runs did not finish, seven days passed.
export type WindDownCode = 'token_refused' | 'no_token' | 'attempts' | 'age';
export type WindDownState = 'pending' | 'done' | 'gave_up';

// What the platform's side of one run came to, as the command reads it from the job's report.
export interface PauseSummary {
  // Every level that has a status was listed in full and every object found or recorded was paused, none left untried.
  complete: boolean;
  // The token was refused: nothing more can be paused with it.
  tokenRefused: boolean;
  // The platform's own time to wait, when it named one.
  retryAt: Date | null;
}

export interface WindDownRow {
  // The runs begun so far, the one being settled included (the claim counts a run as it begins).
  tries: number;
  // When the launch was stopped: the age is counted from it.
  stoppedAt: Date;
}

export interface WindDownSettlement {
  state: WindDownState;
  nextAt: Date | null;
  code: WindDownCode | null;
}

// Whether a launch has waited so long that a person is told: seven days after the stop (the sealed copy of its token is gone by then).
export const isTooOld = (row: Pick<WindDownRow, 'stoppedAt'>, now: Date): boolean => now.getTime() - row.stoppedAt.getTime() >= WIND_DOWN_MAX_AGE_MS;

// The record after one run. A complete run winds the launch down; a refused token cannot pause anything and gives up; any other run keeps the launch open and sets
// the next time (the platform's own wait when it names one, the backoff otherwise, whichever is later), unless this was the tenth run or the seventh day has come.
export function settlePause(row: WindDownRow, summary: PauseSummary, now: Date): WindDownSettlement {
  if (summary.complete) return { state: 'done', nextAt: null, code: null };
  if (summary.tokenRefused) return { state: 'gave_up', nextAt: null, code: 'token_refused' };
  if (row.tries >= WIND_DOWN_MAX_TRIES) return { state: 'gave_up', nextAt: null, code: 'attempts' };
  if (isTooOld(row, now)) return { state: 'gave_up', nextAt: null, code: 'age' };
  const own = now.getTime() + backoffMs(row.tries);
  return { state: 'pending', nextAt: new Date(Math.max(own, summary.retryAt?.getTime() ?? 0)), code: null };
}
