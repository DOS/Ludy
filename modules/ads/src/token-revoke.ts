// SPDX-License-Identifier: AGPL-3.0-only
// The policy of the revoke at the platform (W2-1, issue #2296, ADR-0043 point 4, the Platform PO's conditions of 2026-11-03): a write connection that is
// closed leaves a sealed copy of its token to the revoke job alone, until the platform has removed the person's permissions for the app. This file is
// the rules of that obligation, with no database and no network: when it is due again, what each answer of the platform means, and when the sealed copy is
// wiped. The copy is wiped when the revoke succeeded (or the person had already removed the app), when another live connection of the same person needs the
// grant, when the token cannot be revoked at all, and after at most 7 days or 10 tries: the screen then says "revoke by hand" (remove the app in the
// platform's settings), and a copy is never kept for ever. A copy is never wiped without a try, except at once by the org's purge, by a reconnect of the
// same account (the database does that) and when another live connection of the same person needs the grant (no call is made).
//
// The tries are counted when the copy is opened (by the database's worker-only open), not here: a crash, a retry of the job and a failed call all count, so the
// count the policy is given already includes the try whose outcome it settles.
//
// Nothing here ever holds a token: it deals in states, counts and times.

// How long an obligation may stay open, and how many times the copy is opened, before the copy is wiped and a person is told to revoke by hand.
export const REVOKE_MAX_AGE_MS = 7 * 86_400_000;
export const REVOKE_MAX_ATTEMPTS = 10;

// The wait after the n-th try (1-based) that failed: a minute, five, a quarter of an hour, an hour, three, six, twelve, then a day, so the ten tries are
// spread over the seven days and a platform that is down for a day is still asked.
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 3 * 60 * 60_000, 6 * 60 * 60_000, 12 * 60 * 60_000, 86_400_000, 86_400_000, 86_400_000] as const;
export const backoffMs = (attempts: number): number => BACKOFF_MS[Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1] as number;

export type RevokeState = 'pending' | 'done' | 'gave_up';
// `reconnected` is the database's own (a new connection of the account cancels the pending revoke); the worker reports the others.
export type RevokeHow = 'revoked' | 'already_invalid' | 'sandbox' | 'shared_grant' | 'reconnected';
// `unrevocable`: the platform does not accept the token for a reason that is not the person removing the app (it expired, was invalidated, the password
// changed), or the copy cannot be opened: nothing can be revoked from here, and the grant may still stand at the platform.
export type GiveUpReason = 'attempts' | 'age' | 'unrevocable';

// What a try ended in, as the worker reports it (the platform's error kinds, never its text).
export type RevokeOutcome =
  | { kind: 'done'; how: 'revoked' | 'already_invalid' | 'sandbox' | 'shared_grant' }
  | { kind: 'unrevocable'; code: string | null }
  | { kind: 'failed'; error: 'rate_limited' | 'transient' | 'permission' | 'bad_request' | 'unknown'; code: string | null; retryAt: Date | null };

export interface RevokeRow {
  state: RevokeState;
  // The tries made so far, the one being settled included.
  attempts: number;
  createdAt: Date;
}

// What the database records after a try: the new state, when it is due again, whether the sealed copy is wiped, and why.
export interface RevokeSettlement {
  state: RevokeState;
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

// The record after one try. A success wipes the copy; a token that cannot be revoked wipes it and says so; a failure keeps it and sets the next time (the
// platform's own wait when it names one, the backoff otherwise, whichever is later), unless the tenth try was this one or the seventh day has come, when the
// copy is wiped and a person is told.
export function settleAttempt(row: RevokeRow, outcome: RevokeOutcome, now: Date): RevokeSettlement {
  if (outcome.kind === 'done') return { state: 'done', nextAttemptAt: null, wipe: true, how: outcome.how, giveUp: null };
  if (outcome.kind === 'unrevocable') return { state: 'gave_up', nextAttemptAt: null, wipe: true, how: null, giveUp: 'unrevocable' };
  if (row.attempts >= REVOKE_MAX_ATTEMPTS) return { state: 'gave_up', nextAttemptAt: null, wipe: true, how: null, giveUp: 'attempts' };
  if (isTooOld(row, now)) return { state: 'gave_up', nextAttemptAt: null, wipe: true, how: null, giveUp: 'age' };
  const own = now.getTime() + backoffMs(row.attempts);
  const next = Math.max(own, outcome.retryAt?.getTime() ?? 0);
  return { state: 'pending', nextAttemptAt: new Date(next), wipe: false, how: null, giveUp: null };
}

// The failures that are worth trying again after the backoff, and those a person should look at: all are retried within the limits above, but the screen
// words them differently (a refused permission or a bad request will not mend by waiting).
export const needsAPerson = (error: 'rate_limited' | 'transient' | 'permission' | 'bad_request' | 'unknown'): boolean => error === 'permission' || error === 'bad_request';
