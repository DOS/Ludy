// SPDX-License-Identifier: AGPL-3.0-only
// The delivery of one wake-up to the receiver an org set for an MCP grant (ADR-0051 decision 4, issue #3024). One job per delivery: it loads the stored event
// and the grant's receiver and sealed secrets (the grant must still be in good standing), signs the event and posts it once through the egress guard, and records
// what happened. pg-boss retries a failed attempt with a bounded backoff; the event id never changes, so a receiver that saw it once ignores it again (at least once).
//
// - The request: POST, JSON, headers Ludy-Event-Id, Ludy-Timestamp and Ludy-Signature (`v1=<hex>`, HMAC-SHA256 over the timestamp, a dot and the exact bytes of the
//   body, with a second `v1=` while a rotation overlaps). Every attempt is signed afresh with the time of the attempt, so a retry after the receiver's five minutes still
//   verifies. The body is what mcp-wake-body.ts returns: ids, dates and amounts, never a name.
// - The reach: egressFetch only, https only, on the default port to a public address, re-resolved and pinned on every attempt (the guard); a redirect is an answer and counts as a
//   failed attempt. At most 4 KB of the answer is read and it is never looked at: it is not an instruction (ADR-0051 decision 8), only its status is.
// - A failure never touches Home: it changes this delivery and the wake-up's counters, nothing else. A grant that can no longer be woken drops the delivery.
import { createHmac } from 'node:crypto';
import { MCP_WAKE_PROVIDER, type McpWakeDeliveryRow, type McpWakeTargetRow } from '@crove/kernel';
import { DomainError, egressFetch, type CredentialBroker, type EgressOptions, type Runtime } from '@crove/kernel-runtime';
import { wakeBody } from './mcp-wake-body.ts';

// One attempt takes at most 10 seconds, and reads at most 4 KB of the answer.
const ATTEMPT_MS = 10_000;
const MAX_ANSWER = 4 * 1024;

// The queue's retries: eight more tries after the first, from 30 seconds on and doubling, about two hours in all; a delivery still waiting after eight hours is failed by the sweep.
export const WAKE_RETRY_LIMIT = 8;
export const WAKE_RETRY_DELAY_SECONDS = 30;
// A job that runs longer than this is expired (an attempt's own deadline is shorter).
export const WAKE_JOB_EXPIRE_SECONDS = 60;

const ACTOR = { type: 'system' as const, component: 'kernel.mcp.wake' };

export interface WakeJob {
  orgId: string;
  id: string;
}

export interface WakeDeps {
  runtime: Runtime;
  broker: CredentialBroker;
  now?: () => number;
  // Tests only: the guard's options (a local server, a name that resolves).
  egress?: Partial<EgressOptions>;
}

export type WakeResult = 'sent' | 'retry' | 'failed' | 'dropped' | 'skipped';

const codeOf = (error: unknown) => (error instanceof DomainError ? error.code : error instanceof Error ? error.name : 'error');

// `v1=<hex>` of the HMAC-SHA256 over `<timestamp>.<text>`.
export function wakeSignature(secret: string, timestamp: string, text: string): string {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${text}`).digest('hex')}`;
}

// One attempt for one delivery. Throws, so the queue retries, only when the attempt failed and tries remain; the last failure is recorded as final and returned.
export async function runWakeDelivery(deps: WakeDeps, job: WakeJob, attempt: { retryCount: number; retryLimit: number }): Promise<WakeResult> {
  const ctx = { actor: ACTOR, orgId: job.orgId };
  const delivery = await deps.runtime.query<McpWakeDeliveryRow | null>('kernel.mcp.wake.delivery', { id: job.id }, ctx);
  // A delivery that is gone or already settled (a second job for it, a replay) is not sent again.
  if (!delivery || delivery.status !== 'queued') return 'skipped';
  const target = await deps.runtime.query<McpWakeTargetRow | null>('kernel.mcp.wake.target', { grantId: delivery.grantId }, ctx);
  if (!target) {
    // The grant was revoked, expired or lost its owner or admin, the org was stopped or the wake-up was switched off: nothing is sent.
    await deps.runtime.execute('kernel.mcp.wake.record', { id: job.id, outcome: 'dropped' }, ctx);
    return 'dropped';
  }
  const binding = { orgId: job.orgId, provider: MCP_WAKE_PROVIDER, externalAccountId: delivery.grantId };
  const open = (sealed: { keyId: string; envelope: string }) => deps.broker.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, binding);
  const secrets = [open(target.sealed), ...(target.previous ? [open(target.previous)] : [])];
  // The body is checked once more as it is sent: what the receiver gets is what the builder accepts.
  const { body: stored } = delivery;
  const text = wakeBody(stored);
  const timestamp = String(Math.floor((deps.now ? deps.now() : Date.now()) / 1000));
  let status: number | null = null;
  try {
    const send = egressFetch({ timeoutMs: ATTEMPT_MS, maxBytes: MAX_ANSWER, overLimit: 'truncate', httpsOnly: true, userAgent: 'Ludy-Webhook/1', ...deps.egress });
    const answer = await send(target.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Ludy-Event-Id': job.id,
        'Ludy-Timestamp': timestamp,
        'Ludy-Signature': secrets.map((s) => wakeSignature(s, timestamp, text)).join(','),
      },
      body: text,
    });
    status = answer.status;
  } catch (error) {
    // A name the guard refuses, one that does not resolve, a timeout, a dropped connection: a failed attempt.
    console.warn(`[mcp-wake] ${job.id.slice(0, 8)} not delivered`, codeOf(error));
  }
  if (status !== null && status >= 200 && status < 300) {
    await deps.runtime.execute('kernel.mcp.wake.record', { id: job.id, outcome: 'sent', code: status }, ctx);
    return 'sent';
  }
  const last = attempt.retryCount >= attempt.retryLimit;
  await deps.runtime.execute('kernel.mcp.wake.record', { id: job.id, outcome: last ? 'failed' : 'retry', ...(status !== null && status >= 100 && status <= 599 ? { code: status } : {}) }, ctx);
  if (last) return 'failed';
  throw new Error(`wake-up ${job.id.slice(0, 8)} not delivered (attempt ${attempt.retryCount + 1})`);
}
