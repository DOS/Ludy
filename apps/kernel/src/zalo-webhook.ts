// SPDX-License-Identifier: AGPL-3.0-only
// Zalo OA's signed notice of a customer's message (conversation core, issue #2304, plan docs/plan/conversations.md section 6.1). The
// route checks the signature before anything else: a missing, malformed or wrong one is refused with the same answer, and nothing is
// read, stored or logged from the body. A verified notice that carries a message is parked, signed body and all, in
// crove_kernel.conversation_inbound_pending for the worker, which finds the org from the stored connection by the OA id; the notice names
// no org, and neither does the path or any answer (ADR-0039). A body is personal data of a third party, so the route logs nothing of it
// and the table deletes it the moment it is stored. A verified notice with no message in it (a follow, a delivery or a seen mark) is
// answered 200 and not parked, so Zalo stops sending it and the queue holds messages only.
import { sql } from 'kysely';
import { ConversationNoticeError, parseZaloNotice, zaloSignatureOk } from '@crove/channel';
import { DomainError, type Runtime } from '@crove/kernel-runtime';

export const ZALO_WEBHOOK_PATH = '/api/channels/zalo/webhook';
export const ZALO_SIGNATURE_HEADER = 'x-zevent-signature';

export interface ZaloWebhookConfig {
  appId: string;
  // The OA secret key: a credential, never logged or answered.
  oaSecretKey: string;
  // The key it replaces while a rotation is under way (CHANNEL_ZALO_OA_SECRET_KEY_PREVIOUS): a notice signed with either is taken.
  oaSecretKeyPrevious?: string | undefined;
  // The clock the age of a notice is read against; the real one when absent.
  now?: (() => number) | undefined;
}

// Events seen lately, by their own id, so a signed notice replayed (by Zalo's resends or by anyone holding a captured one) is answered
// without being parked again. Zalo resends after an outage 30 seconds, 5, 15, 30 minutes and 1 hour later [S], so the window is an
// hour. It is a per-process guard against a queue flooded with one body; the guarantee that a replay stores nothing twice is the unique
// platform message id of the thread's messages, which holds across processes and restarts. An event is remembered only once it is
// parked, so a notice refused for backlog is accepted when Zalo sends it again.
export const ZALO_REPLAY_WINDOW_MS = 60 * 60_000;
const ZALO_REPLAY_MAX = 10_000;
export class ZaloReplayCache {
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
    this.seen.set(key, this.now() + ZALO_REPLAY_WINDOW_MS);
    // Insertion order is age order: the oldest go first when the cache is full.
    while (this.seen.size > ZALO_REPLAY_MAX) this.seen.delete(this.seen.keys().next().value as string);
  }
}

// A verified notice older than a day is answered and not parked: Zalo's resends stop after an hour [S], so an older one is a captured body
// replayed, and the unique message id alone must not be what keeps a purged or erased thread from coming back (CV6).
export const ZALO_NOTICE_MAX_AGE_MS = 24 * 3_600_000;

export type ZaloWebhookOutcome =
  | { status: 200; parked: boolean }
  | { status: 401; code: 'WEBHOOK_SIGNATURE' }
  | { status: 400; code: 'WEBHOOK_MALFORMED' }
  | { status: 503; code: 'BACKLOG' };

export async function acceptZaloWebhook(runtime: Runtime, config: ZaloWebhookConfig, request: { signature: string | undefined; body: Uint8Array }, replays?: ZaloReplayCache): Promise<ZaloWebhookOutcome> {
  if (!zaloSignatureOk({ body: request.body, header: request.signature, appId: config.appId, oaSecretKey: config.oaSecretKey, oaSecretKeyPrevious: config.oaSecretKeyPrevious })) return { status: 401, code: 'WEBHOOK_SIGNATURE' };
  let notice: ReturnType<typeof parseZaloNotice>;
  try {
    notice = parseZaloNotice(request.body);
  } catch (error) {
    if (error instanceof ConversationNoticeError) return { status: 400, code: 'WEBHOOK_MALFORMED' };
    throw error;
  }
  if (notice.events.length === 0) return { status: 200, parked: false };
  // The id of the event: the OA, the platform's message id and which way it went. A replay inside the window is answered, not parked.
  const event = notice.events[0];
  if (event && (config.now ?? Date.now)() - Date.parse(event.at) > ZALO_NOTICE_MAX_AGE_MS) return { status: 200, parked: false };
  const key = event ? `${notice.accountId}:${event.direction}:${event.messageId}` : null;
  if (key && replays?.has(key)) return { status: 200, parked: false };
  try {
    await runtime.orgless(async (db) => {
      await sql`SELECT crove_kernel.conversation_inbound_enqueue('zalo_oa', ${Buffer.from(request.body)}::bytea)`.execute(db);
    });
  } catch (error) {
    // The definer refuses past 10000 waiting notices (53400), which the runtime maps to OVERLOADED. Zalo does not retry on an error status
    // [S], so this one is lost: the history read of CV5b is what recovers it.
    if (error instanceof DomainError && error.code === 'OVERLOADED') return { status: 503, code: 'BACKLOG' };
    throw error;
  }
  if (key) replays?.add(key);
  return { status: 200, parked: true };
}
