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
import type { Runtime } from '@crove/kernel-runtime';

export const ZALO_WEBHOOK_PATH = '/api/channels/zalo/webhook';
export const ZALO_SIGNATURE_HEADER = 'x-zevent-signature';

export interface ZaloWebhookConfig {
  appId: string;
  // The OA secret key: a credential, never logged or answered.
  oaSecretKey: string;
}

export type ZaloWebhookOutcome =
  | { status: 200; parked: boolean }
  | { status: 401; code: 'WEBHOOK_SIGNATURE' }
  | { status: 400; code: 'WEBHOOK_MALFORMED' }
  | { status: 503; code: 'BACKLOG' };

export async function acceptZaloWebhook(runtime: Runtime, config: ZaloWebhookConfig, request: { signature: string | undefined; body: Uint8Array }): Promise<ZaloWebhookOutcome> {
  if (!zaloSignatureOk({ body: request.body, header: request.signature, appId: config.appId, oaSecretKey: config.oaSecretKey })) return { status: 401, code: 'WEBHOOK_SIGNATURE' };
  let events: number;
  try {
    events = parseZaloNotice(request.body).events.length;
  } catch (error) {
    if (error instanceof ConversationNoticeError) return { status: 400, code: 'WEBHOOK_MALFORMED' };
    throw error;
  }
  if (events === 0) return { status: 200, parked: false };
  try {
    await runtime.orgless(async (db) => {
      await sql`SELECT crove_kernel.conversation_inbound_enqueue('zalo_oa', ${Buffer.from(request.body)}::bytea)`.execute(db);
    });
  } catch (error) {
    // The definer refuses past 10000 waiting notices (53400): Zalo is told to come back, and sends no more than it must.
    if ((error as { code?: unknown } | null)?.code === '53400') return { status: 503, code: 'BACKLOG' };
    throw error;
  }
  return { status: 200, parked: true };
}
