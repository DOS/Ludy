// SPDX-License-Identifier: AGPL-3.0-only
// Zoom's signed webhook, the doorbell of the recording import (meetings integrations C3, issue #3175, plan docs/plan/meetings-integrations.md section 6.3). The notice says a cloud recording finished, and
// all this route does with it is ask the sweep to list the host's connections again at its next pass (crove_kernel.meeting_platform_ring clears their last listing time). It is a doorbell and never data:
//
// - The notice carries a download address, a download token and the host's email. None is read, stored, logged or used: a recording is fetched only through the member's own sealed token, by the adapter,
//   after the member's click. A forged notice, even a correctly shaped one, can at worst cause one extra listing.
// - The route names no org, neither in its path nor in any answer, and answers 200 whether or not a connection matched, so nobody can learn which accounts exist.
// - The signature is checked before the event is looked at: a missing, malformed, stale or wrong one is refused with the same answer. Zoom's URL validation challenge may arrive without a signature
//   (unverified whether it does), so it is answered for a plainToken of a safe shape only (see meeting-platform-zoom-webhook.ts, THE SIGNING ORACLE), and it is charged to the same rate limit as a refusal.
// - Nothing of the body is logged.
import { sql } from 'kysely';
import { ZOOM_MAX_NOTICE_BYTES, ZOOM_SIGNATURE_HEADER, ZOOM_TIMESTAMP_HEADER, ZoomNoticeError, parseZoomNotice, zoomSignatureOk, zoomValidationAnswer } from '@ludy/channel';
import type { Runtime } from '@ludy/kernel-runtime';

export const ZOOM_WEBHOOK_PATH = '/api/meeting-platform/zoom/webhook';
export { ZOOM_MAX_NOTICE_BYTES, ZOOM_SIGNATURE_HEADER, ZOOM_TIMESTAMP_HEADER };

export interface ZoomWebhookConfig {
  // The app's secret token (ZOOM_WEBHOOK_SECRET_TOKEN): a credential, never logged or answered.
  secretToken: string;
  // The token it replaces while a rotation is under way (ZOOM_WEBHOOK_SECRET_TOKEN_PREVIOUS): a notice signed with either is taken.
  secretTokenPrevious?: string | undefined;
  // The clock the age of a notice is read against; the real one when absent.
  now?: (() => number) | undefined;
}

// Notices answered lately, by the meeting instance and the event, so a signed notice replayed (by Zoom's resends or by anyone holding a captured one) is answered without asking the database. It is a
// per-process guard only: ringing twice is harmless by construction (a column cleared twice), so nothing depends on it holding across processes.
export const ZOOM_REPLAY_WINDOW_MS = 60 * 60_000;
const ZOOM_REPLAY_MAX = 10_000;
export class ZoomReplayCache {
  private readonly seen = new Map<string, number>();
  private readonly now: () => number;
  constructor(now: () => number = Date.now) {
    this.now = now;
  }
  has(key: string): boolean {
    const until = this.seen.get(key);
    if (until === undefined) return false;
    if (until <= this.now()) {
      this.seen.delete(key);
      return false;
    }
    return true;
  }
  add(key: string): void {
    this.seen.delete(key);
    this.seen.set(key, this.now() + ZOOM_REPLAY_WINDOW_MS);
    // Insertion order is age order: the oldest go first when the cache is full.
    while (this.seen.size > ZOOM_REPLAY_MAX) this.seen.delete(this.seen.keys().next().value as string);
  }
}

export type ZoomWebhookOutcome =
  // `unsigned`: the answer was a URL validation challenge that came without a signature; the route charges it to the rate limit like a refusal.
  | { status: 200; body: Record<string, unknown>; unsigned?: true }
  | { status: 401; code: 'WEBHOOK_SIGNATURE' }
  | { status: 400; code: 'WEBHOOK_MALFORMED' };

const REFUSED: ZoomWebhookOutcome = { status: 401, code: 'WEBHOOK_SIGNATURE' };

export async function acceptZoomWebhook(
  runtime: Runtime,
  config: ZoomWebhookConfig,
  request: { signature: string | undefined; timestamp: string | undefined; body: Uint8Array },
  replays?: ZoomReplayCache,
): Promise<ZoomWebhookOutcome> {
  const signed = request.signature !== undefined && request.signature.trim() !== '';
  // A request that carries a signature must verify, whatever event it names (the validation challenge included).
  if (signed && !zoomSignatureOk({ body: request.body, signature: request.signature, timestamp: request.timestamp, secret: config.secretToken, secretPrevious: config.secretTokenPrevious, nowMs: (config.now ?? Date.now)() })) return REFUSED;
  let notice: ReturnType<typeof parseZoomNotice>;
  try {
    notice = parseZoomNotice(request.body);
  } catch (error) {
    if (!(error instanceof ZoomNoticeError)) throw error;
    // An unsigned body that is no notice is just an unauthenticated request; a signed one is Zoom's own and malformed.
    return signed ? { status: 400, code: 'WEBHOOK_MALFORMED' } : REFUSED;
  }
  if (notice.kind === 'validation') {
    const answer = zoomValidationAnswer(config.secretToken, notice.plainToken);
    if (!answer) return signed ? { status: 400, code: 'WEBHOOK_MALFORMED' } : REFUSED;
    return signed ? { status: 200, body: answer } : { status: 200, body: answer, unsigned: true };
  }
  // Nothing else is answered without a verified signature.
  if (!signed) return REFUSED;
  if (notice.kind === 'recording') {
    const key = notice.uuid !== '' && notice.eventTs !== '' ? `${notice.event}:${notice.uuid}:${notice.eventTs}` : null;
    if (!(key && replays?.has(key))) {
      await runtime.orgless(async (db) => {
        await sql`SELECT crove_kernel.meeting_platform_ring('zoom', ${notice.hostId})`.execute(db);
      });
      if (key) replays?.add(key);
    }
  }
  // A verified notice that rang, rang nothing, repeated or names no recording is answered the same.
  return { status: 200, body: { ok: true } };
}
