// SPDX-License-Identifier: AGPL-3.0-only
// The policy of the revoke at the platform (W2-1, issue #2296, ADR-0043 point 4, the Platform PO's conditions of 2026-11-03): a write connection that is
// closed leaves a sealed copy of its token to the revoke job alone, until the platform has removed the person's permissions for the app. This file is
// the rules of that obligation, with no database and no network: when it is due again, what each answer of the platform means, and when the sealed copy is
// wiped. The copy is wiped when the revoke succeeded (or the platform no longer accepts the token), and also after at most 7 days or 10 attempts: the
// screen then says "revoke by hand" (remove the app in the platform's settings), and a copy is never kept for ever. A copy is never wiped without an
// attempt, except at once by the org's purge.
//
// Nothing here ever holds a token: it deals in states, counts and times.

// How long an obligation may stay open, and how many times the platform is asked, before the copy is wiped and a person is told to revoke by hand.
export const REVOKE_MAX_AGE_MS = 7 * 86_400_000;
export const REVOKE_MAX_ATTEMPTS = 10;

// The wait after the n-th failed attempt (1-based): a minute, five, a quarter of an hour, an hour, three, six, twelve, then a day, so the ten attempts
// are spread over the seven days and a platform that is down for a day is still asked.
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 3 * 60 * 60_000, 6 * 60 * 60_000, 12 * 60 * 60_000, 86_400_000, 86_400_000, 86_400_000] as const;
export const backoffMs = (attempts: number): number => BACKOFF_MS[Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1] as number;

export type RevokeState = 'pending' | 'done' | 'gave_up';
export type RevokeHow = 'revoked' | 'already_invalid' | 'sandbox';
export type GiveUpReason = 'attempts' | 'age';

// What a try ended in, as the worker reports it (the platform's error kinds, never its text).
export type RevokeOutcome =
  | { kind: 'done'; how: RevokeHow }
  | { kind: 'failed'; error: 'rate_limited' | 'transient' | 'permission' | 'bad_request' | 'unknown'; code: string | null; retryAt: Date | null };

export interface RevokeRow {
  state: RevokeState;
  // The tries made so far.
  attempts: number;
  createdAt: Date;
}

// What the database records after a try (or a refusal to try): the new state, the count, when it is due again, whether the sealed copy goes, and why.
export interface RevokeSettlement {
  state: RevokeState;
  attempts: number;
  nextAttemptAt: Date | null;
  // True when the sealed copy is wiped with this settlement.
  wipe: boolean;
  how: RevokeHow | null;
  giveUp: GiveUpReason | null;
}

// Whether an obligation is due: still pending and its time has come.
export const isDue = (row: Pick<RevokeRow, 'state'>, nextAttemptAt: Date | null, now: Date): boolean => row.state === 'pending' && nextAttemptAt !== null && nextAttemptAt.getTime() <= now.getTime();

// Whether an open obligation is past its age: it is closed without another try (the copy is wiped, the screen says to revoke by hand).
export const isTooOld = (row: Pick<RevokeRow, 'createdAt'>, now: Date): boolean => now.getTime() - row.createdAt.getTime() >= REVOKE_MAX_AGE_MS;

// The record after one try. A success wipes the copy; a failure keeps it and sets the next time (the platform's own wait when it names one, the
// backoff otherwise, whichever is later), unless the tenth attempt was this one or the seventh day has come, when the copy is wiped and a person is told.
export function settleAttempt(row: RevokeRow, outcome: RevokeOutcome, now: Date): RevokeSettlement {
  const attempts = row.attempts + 1;
  if (outcome.kind === 'done') return { state: 'done', attempts, nextAttemptAt: null, wipe: true, how: outcome.how, giveUp: null };
  if (attempts >= REVOKE_MAX_ATTEMPTS) return { state: 'gave_up', attempts, nextAttemptAt: null, wipe: true, how: null, giveUp: 'attempts' };
  if (isTooOld(row, now)) return { state: 'gave_up', attempts, nextAttemptAt: null, wipe: true, how: null, giveUp: 'age' };
  const own = now.getTime() + backoffMs(attempts);
  const next = Math.max(own, outcome.retryAt?.getTime() ?? 0);
  return { state: 'pending', attempts, nextAttemptAt: new Date(next), wipe: false, how: null, giveUp: null };
}

// An obligation found past its age by the sweep, before any try: the same ending as a failed seventh day (the attempts it made stay as they were).
export function expire(row: RevokeRow): RevokeSettlement {
  return { state: 'gave_up', attempts: row.attempts, nextAttemptAt: null, wipe: true, how: null, giveUp: 'age' };
}

// The failures that are worth trying again at once after the backoff, and those a person should look at: all are retried within the limits above, but
// the screen words them differently (a refused permission or a bad request will not mend by waiting).
export const needsAPerson = (error: 'rate_limited' | 'transient' | 'permission' | 'bad_request' | 'unknown'): boolean => error === 'permission' || error === 'bad_request';
