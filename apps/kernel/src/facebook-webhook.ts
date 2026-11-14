// SPDX-License-Identifier: AGPL-3.0-only
// Meta's webhook for Facebook Page comments (conversation core, issue #2307, plan docs/plan/conversations.md sections 6.1, 6.2 and 13 CV2).
//
// Handshake (`GET /api/channels/facebook/webhook`): Meta sends `hub.mode=subscribe`, `hub.verify_token` and `hub.challenge`. The route
// compares `hub.verify_token` against `CHANNEL_META_WEBHOOK_VERIFY_TOKEN` in constant time and echoes `hub.challenge` as `text/plain`.
//
// Delivery (`POST /api/channels/facebook/webhook`): the route checks `X-Hub-Signature-256` against the raw request bytes before anything
// else. A missing, malformed or wrong signature is refused with 401 and nothing is read, stored or logged from the body. A verified
// notice that carries Page comment events is parked in `crove_kernel.conversation_inbound_pending` (`facebook_page`) for the worker, which
// finds the org from the stored connection by the Page id; the notice names no org, and neither does the path or any answer (ADR-0039).
import { createHash, timingSafeEqual } from 'node:crypto';
import { sql } from 'kysely';
import {
  ConversationNoticeError,
  FACEBOOK_SIGNATURE_HEADER,
  metaSignatureOk,
  parseFacebookNotices,
  parseInstagramNotices,
  parseThreadsNotices,
  threadsSignatureOk,
  type InboundConversationEvent,
} from '@crove/channel';
import { DomainError, type Runtime } from '@crove/kernel-runtime';

export const FACEBOOK_WEBHOOK_PATH = '/api/channels/facebook/webhook';
export { FACEBOOK_SIGNATURE_HEADER };

export interface FacebookWebhookConfig {
  // The Meta app secret: a credential, never logged or answered.
  appSecret: string;
  // The secret it replaces while a rotation is under way (`CHANNEL_META_APP_SECRET_PREVIOUS`).
  appSecretPrevious?: string | undefined;
  // The secret of the Instagram app when it is not the app above (`CHANNEL_INSTAGRAM_APP_ID`, #2212): its notices are signed with it.
  instagramAppSecret?: string | undefined;
  // The secret of the Threads app (`CHANNEL_THREADS_APP_SECRET`, #3133): its reply notices are signed with it, and are taken in only when it
  // verifies; the same URL serves them, with the same verify token. A notice the Pages or Instagram secret signed is never read as Threads'.
  threadsAppSecret?: string | undefined;
  // Shared token configured in Meta App Dashboard -> Webhooks (`CHANNEL_META_WEBHOOK_VERIFY_TOKEN`).
  verifyToken: string;
  // Clock for notice age checks; defaults to `Date.now`.
  now?: (() => number) | undefined;
}

// Meta retries failed webhook deliveries for up to 36 hours (plan section 15).
export const FACEBOOK_REPLAY_WINDOW_MS = 36 * 3_600_000;
const FACEBOOK_REPLAY_MAX = 10_000;

export class FacebookReplayCache {
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
    this.seen.set(key, this.now() + FACEBOOK_REPLAY_WINDOW_MS);
    while (this.seen.size > FACEBOOK_REPLAY_MAX) this.seen.delete(this.seen.keys().next().value as string);
  }
}

// A verified notice older than 48 hours is past Meta's 36-hour retry window, so it is acknowledged with 200 and not parked.
export const FACEBOOK_NOTICE_MAX_AGE_MS = 48 * 3_600_000;

export type FacebookWebhookChallengeOutcome =
  | { status: 200; challenge: string }
  | { status: 403; code: 'WEBHOOK_VERIFY_FAILED' };

export function verifyFacebookWebhookChallenge(
  config: Pick<FacebookWebhookConfig, 'verifyToken'>,
  query: { mode: string | undefined; verifyToken: string | undefined; challenge: string | undefined },
): FacebookWebhookChallengeOutcome {
  if (
    !config.verifyToken ||
    query.mode !== 'subscribe' ||
    typeof query.verifyToken !== 'string' ||
    query.verifyToken.length === 0 ||
    typeof query.challenge !== 'string' ||
    query.challenge.length === 0 ||
    query.challenge.length > 500 ||
    query.challenge.includes('\u0000')
  ) {
    return { status: 403, code: 'WEBHOOK_VERIFY_FAILED' };
  }
  const givenDigest = createHash('sha256').update(query.verifyToken, 'utf8').digest();
  const expectedDigest = createHash('sha256').update(config.verifyToken, 'utf8').digest();
  if (!timingSafeEqual(givenDigest, expectedDigest)) {
    return { status: 403, code: 'WEBHOOK_VERIFY_FAILED' };
  }
  return { status: 200, challenge: query.challenge };
}

export type FacebookWebhookOutcome =
  | { status: 200; parked: boolean }
  | { status: 401; code: 'WEBHOOK_SIGNATURE' }
  | { status: 400; code: 'WEBHOOK_MALFORMED' }
  | { status: 503; code: 'BACKLOG' };

function eventReplayKey(accountId: string, event: InboundConversationEvent): string {
  const action = event.removed
    ? 'rm'
    : event.edited
      ? `ed:${createHash('sha256').update(event.text).digest('hex').slice(0, 16)}`
      : event.hidden !== undefined && event.hiddenOnly
        ? `hd:${event.hidden ? '1' : '0'}`
        : `add:${event.hidden === true ? '1' : '0'}`;
  return `${accountId}:${event.messageId}:${action}`;
}

export async function acceptFacebookWebhook(
  runtime: Runtime,
  config: Pick<FacebookWebhookConfig, 'appSecret' | 'appSecretPrevious' | 'instagramAppSecret' | 'threadsAppSecret' | 'now'>,
  request: { signature: string | undefined; body: Uint8Array },
  replays?: FacebookReplayCache,
): Promise<FacebookWebhookOutcome> {
  // A notice is signed by the app it was subscribed on: the Pages app's secret (or the one it replaces), the Instagram app's, or the Threads app's.
  // A Threads app's reply notice is taken in only when the Threads secret verified it, and a Page or Instagram one only when theirs did (when
  // one Meta app holds both products its secret is all of them).
  const metaSigned =
    metaSignatureOk({ body: request.body, header: request.signature, appSecret: config.appSecret, appSecretPrevious: config.appSecretPrevious }) ||
    (config.instagramAppSecret !== undefined && metaSignatureOk({ body: request.body, header: request.signature, appSecret: config.instagramAppSecret }));
  const threadsSigned = config.threadsAppSecret !== undefined && threadsSignatureOk({ body: request.body, header: request.signature, appSecret: config.threadsAppSecret });
  if (!metaSigned && !threadsSigned) return { status: 401, code: 'WEBHOOK_SIGNATURE' };
  const now = (config.now ?? Date.now)();
  let pageNotices: ReturnType<typeof parseFacebookNotices> = [];
  let igNotices: ReturnType<typeof parseInstagramNotices> = [];
  let threadsNotices: ReturnType<typeof parseThreadsNotices> = [];
  try {
    if (metaSigned) {
      pageNotices = parseFacebookNotices(request.body, now);
      igNotices = parseInstagramNotices(request.body, now);
    }
    if (threadsSigned) threadsNotices = parseThreadsNotices(request.body, now);
  } catch (error) {
    if (error instanceof ConversationNoticeError) return { status: 400, code: 'WEBHOOK_MALFORMED' };
    throw error;
  }
  const provider = threadsNotices.length > 0 ? 'threads' : igNotices.length > 0 ? 'instagram' : 'facebook_page';
  const notices = threadsNotices.length > 0 ? threadsNotices : igNotices.length > 0 ? igNotices : pageNotices;
  const freshKeys: string[] = [];
  for (const notice of notices) {
    for (const event of notice.events) {
      if (now - Date.parse(event.at) > FACEBOOK_NOTICE_MAX_AGE_MS) continue;
      const key = eventReplayKey(notice.accountId, event);
      if (!replays?.has(key)) freshKeys.push(key);
    }
  }
  if (freshKeys.length === 0) return { status: 200, parked: false };
  try {
    await runtime.orgless(async (db) => {
      await sql`SELECT crove_kernel.conversation_inbound_enqueue(${provider}, ${Buffer.from(request.body)}::bytea)`.execute(db);
    });
  } catch (error) {
    if (error instanceof DomainError && error.code === 'OVERLOADED') return { status: 503, code: 'BACKLOG' };
    throw error;
  }
  for (const key of freshKeys) replays?.add(key);
  return { status: 200, parked: true };
}
