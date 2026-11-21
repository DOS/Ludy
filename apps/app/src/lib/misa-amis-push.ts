// SPDX-License-Identifier: AGPL-3.0-only
// Pure rules of the MISA AMIS push screen (#3902, S3b-2b of #3854): when the screen offers to send a previewed batch, and which rows a person may settle. The server enforces every rule (the 404 gate, the roles,
// the digest, the age of a row by the database clock); the screen offers only what can succeed, so a row never shows a button that is bound to be refused.
import type { MisaAmisPreview, MisaAmisPushConfirmed, MisaAmisPushRow } from '@ludy/kernel-contract';

/** How long MISA has to answer a sent request before a person may settle it (the polling window of the worker, 24 hours). */
export const PUSH_RESULT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** How long an ambiguous send (no answer to the call itself) waits before a person may settle it (3 days). */
export const PUSH_AMBIGUOUS_WAIT_MS = 3 * 24 * 60 * 60 * 1000;

export type PushOffer = 'hidden' | 'needs_test' | 'ready';

/**
 * Whether the preview offers to send what it shows: only an owner or admin, only where the deployment turned the push on, and only after a test of the connection that worked.
 * `needs_test` says why the button is not there instead of leaving it out silently.
 */
export function pushOffer(a: { canManage: boolean; pushOffered: boolean | undefined; testState: string | null }): PushOffer {
  if (!a.canManage || a.pushOffered !== true) return 'hidden';
  return a.testState === 'works' ? 'ready' : 'needs_test';
}

/** A previewed batch can be sent when it is whole (the digest covers all of it), has something in it and nothing blocked. */
export function previewSendable(result: Pick<MisaAmisPreview, 'vouchers' | 'blocked' | 'more'>): boolean {
  return result.vouchers > 0 && result.blocked === 0 && !result.more;
}

/** How young the last check against the MISA catalogue must be for the server to take a confirmation (15 minutes, as modules/finance MISA_AMIS_CHECK_MAX_AGE_MS: the server decides, this only tells the person first). */
export const PUSH_CHECK_MAX_AGE_MS = 15 * 60 * 1000;

/** Whether a check that finished at `checkedAt` (null when none did) is young enough at `now`. */
export function checkIsYoung(checkedAt: string | null, now: number): boolean {
  if (checkedAt === null) return false;
  const age = now - Date.parse(checkedAt);
  return Number.isFinite(age) && age >= 0 && age <= PUSH_CHECK_MAX_AGE_MS;
}

/** What a person may say about a row MISA never answered for: a `sent` row after 24 hours, an `ambiguous` one after 3 days. Anything else has no decision to make. */
export function canSettle(row: Pick<MisaAmisPushRow, 'state' | 'changedAt'>, now: number): boolean {
  const age = now - Date.parse(row.changedAt);
  if (row.state === 'sent') return age > PUSH_RESULT_WINDOW_MS;
  if (row.state === 'ambiguous') return age > PUSH_AMBIGUOUS_WAIT_MS;
  return false;
}

/** The rows of a list that are waiting for MISA or for a person: a count for the heading, never a total of money. */
export function openRows(rows: readonly Pick<MisaAmisPushRow, 'state'>[]): number {
  return rows.filter((r) => r.state === 'queued' || r.state === 'sending' || r.state === 'sent' || r.state === 'ambiguous').length;
}

/** Whether anything was newly put in the queue by a confirmation (as against everything being already there). */
export function confirmedAnything(c: MisaAmisPushConfirmed): boolean {
  return c.queued + c.requeued > 0;
}
