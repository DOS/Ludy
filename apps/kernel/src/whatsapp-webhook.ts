// SPDX-License-Identifier: AGPL-3.0-only
// WhatsApp Business (Cloud API) webhook for customers' messages (conversation core, issue #3131, plan docs/plan/conversations-channels.md section 4.1).
//
// Handshake (`GET /api/channels/whatsapp/webhook`): Meta sends `hub.mode=subscribe`, `hub.verify_token` and `hub.challenge` [S]. The route compares
// `hub.verify_token` with CHANNEL_WHATSAPP_VERIFY_TOKEN in constant time and echoes `hub.challenge` as `text/plain`.
//
// Delivery (`POST /api/channels/whatsapp/webhook`): the route checks `X-Hub-Signature-256` over the raw request bytes (the same check as Messenger's,
// `metaSignatureOk`, with the secret of the WhatsApp product's own Meta app) before anything else. A missing, malformed or wrong signature is refused with
// 401 and nothing is read, stored or logged from the body. A verified notice that carries a customer's message, or a status `failed` of one of ours, is parked
// in crove_kernel.conversation_inbound_pending (`whatsapp`) for the worker, which finds the org from the stored connection by the phone number id; the notice
// names no org, and neither does the path or any answer (ADR-0039). A body holds a customer's phone number and words, so the route logs nothing of it and the
// table deletes it the moment it is stored. A verified notice with nothing to store (a `sent`, `delivered` or `read` status, a reaction) is answered 200 and
// not parked, so Meta stops sending it and the queue holds messages only.
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { ConversationNoticeError, WHATSAPP_SIGNATURE_HEADER, metaSignatureOk, parseWhatsAppNotices, type InboundConversationEvent } from '@crove/channel';
import { DomainError, type Runtime } from '@crove/kernel-runtime';
import { FacebookReplayCache, verifyFacebookWebhookChallenge, type FacebookWebhookChallengeOutcome } from './facebook-webhook.ts';

export const WHATSAPP_WEBHOOK_PATH = '/api/channels/whatsapp/webhook';
export { WHATSAPP_SIGNATURE_HEADER };

export interface WhatsAppWebhookConfig {
  // The secret of the Meta app the WhatsApp product belongs to (CHANNEL_WHATSAPP_APP_SECRET): a credential, never logged or answered.
  appSecret: string;
  // The secret it replaces while a rotation is under way (CHANNEL_WHATSAPP_APP_SECRET_PREVIOUS).
  appSecretPrevious?: string | undefined;
  // The token configured beside the callback URL in the Meta app dashboard (CHANNEL_WHATSAPP_VERIFY_TOKEN): a credential, never logged or answered.
  verifyToken: string;
  // The clock the age of a notice is read against; the real one when absent.
  now?: (() => number) | undefined;
}

// Events seen lately, by their own id, so a signed notice replayed (by Meta's retries or by anyone holding a captured one) is answered without being parked
// again; the window is Messenger's 36 hours, the one figure on file [U for WhatsApp]. A per-process guard against a queue flooded with one body: the guarantee
// that a replay stores nothing twice is the unique platform message id of the thread's messages, which holds across processes and restarts. An event is
// remembered only once it is parked.
export { FacebookReplayCache as WhatsAppReplayCache };

// A verified event dated more than 7 days ago is answered 200 and not parked. How long Meta retries a WhatsApp delivery is [U] (a week is the longest figure
// seen), so a deployment that was down for a day or two still takes the messages it missed; an erased customer's old message does not come back through
// this, since an event dated before the erasure is ignored at intake (CV6).
export const WHATSAPP_NOTICE_MAX_AGE_MS = 7 * 24 * 3_600_000;

export type WhatsAppWebhookChallengeOutcome = FacebookWebhookChallengeOutcome;
export function verifyWhatsAppWebhookChallenge(
  config: Pick<WhatsAppWebhookConfig, 'verifyToken'>,
  query: { mode: string | undefined; verifyToken: string | undefined; challenge: string | undefined },
): WhatsAppWebhookChallengeOutcome {
  return verifyFacebookWebhookChallenge(config, query);
}

export type WhatsAppWebhookOutcome =
  | { status: 200; parked: boolean }
  | { status: 401; code: 'WEBHOOK_SIGNATURE' }
  | { status: 400; code: 'WEBHOOK_MALFORMED' }
  | { status: 503; code: 'BACKLOG' };

// The id of an event: the phone number, which way it went, the platform's message id, and whether it is a message or a failed status of one of ours (the
// same wamid is the message's and its status's).
function eventReplayKey(accountId: string, event: InboundConversationEvent): string {
  return `${accountId}:${event.direction}:${event.deliveryFailed ? `f:${createHash('sha256').update(event.deliveryFailed.code).digest('hex').slice(0, 8)}` : 'm'}:${event.messageId}`;
}

export async function acceptWhatsAppWebhook(
  runtime: Runtime,
  config: Pick<WhatsAppWebhookConfig, 'appSecret' | 'appSecretPrevious' | 'now'>,
  request: { signature: string | undefined; body: Uint8Array },
  replays?: FacebookReplayCache,
): Promise<WhatsAppWebhookOutcome> {
  if (!metaSignatureOk({ body: request.body, header: request.signature, appSecret: config.appSecret, appSecretPrevious: config.appSecretPrevious })) return { status: 401, code: 'WEBHOOK_SIGNATURE' };
  const now = (config.now ?? Date.now)();
  let notices: ReturnType<typeof parseWhatsAppNotices>;
  try {
    notices = parseWhatsAppNotices(request.body, now);
  } catch (error) {
    if (error instanceof ConversationNoticeError) return { status: 400, code: 'WEBHOOK_MALFORMED' };
    throw error;
  }
  const freshKeys: string[] = [];
  for (const notice of notices) {
    for (const event of notice.events) {
      if (now - Date.parse(event.at) > WHATSAPP_NOTICE_MAX_AGE_MS) continue;
      const key = eventReplayKey(notice.accountId, event);
      if (!replays?.has(key)) freshKeys.push(key);
    }
  }
  if (freshKeys.length === 0) return { status: 200, parked: false };
  try {
    await runtime.orgless(async (db) => {
      await sql`SELECT crove_kernel.conversation_inbound_enqueue('whatsapp', ${Buffer.from(request.body)}::bytea)`.execute(db);
    });
  } catch (error) {
    // The definer refuses past 10000 waiting notices (53400), which the runtime maps to OVERLOADED: Meta retries, so a 503 is recovered.
    if (error instanceof DomainError && error.code === 'OVERLOADED') return { status: 503, code: 'BACKLOG' };
    throw error;
  }
  for (const key of freshKeys) replays?.add(key);
  return { status: 200, parked: true };
}
