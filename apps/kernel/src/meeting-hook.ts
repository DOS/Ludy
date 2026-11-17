// SPDX-License-Identifier: AGPL-3.0-only
// The delivery of one minutes webhook event to the address a member set (meetings integrations A6, issue #3164, plan docs/plan/meetings-integrations.md section 4.5). One job per delivery: it loads
// the stored event and the member's address and sealed secrets (the hook must still stand: enabled, the owner's switch on, the member still in the org), signs the event and posts it once, and
// records what happened. pg-boss retries a failed attempt with the wake-up's bounded backoff; the event id never changes, so a receiver that saw it once ignores it again (at least once).
//
// - The signing and the request are mcp-wake.ts's postSigned: this file never signs, resolves or reaches the network itself, and reads nothing of the receiver's answer (only its status).
// - The body is what meetingHookBody accepts: checked once more as it is sent, by the same strict builder that stored it. It is wiped the moment the delivery settles (the database does it).
// - No model is called anywhere on this path: what leaves is what the person approved when they published.
// - A failure never touches the meeting or its minutes: it changes this delivery and the hook's counters, nothing else. A hook that no longer stands drops the delivery.
import { meetingHookBody, type MeetingHookDeliveryRow, type MeetingHookTargetRow } from '@crove/kernel-contract';
import { DomainError, type Runtime } from '@crove/kernel-runtime';
import { postSigned, type WakeDeps, type WakeJob, type WakeResult } from './mcp-wake.ts';
import { MEETING_HOOK_PROVIDER } from './meeting-hook-setup.ts';

const ACTOR = { type: 'system' as const, component: 'meetings.hook' };
const codeOf = (error: unknown) => (error instanceof DomainError ? error.code : error instanceof Error ? error.name : 'error');

export type MeetingHookJob = WakeJob;
export type MeetingHookDeps = WakeDeps & { runtime: Runtime };

// One attempt for one delivery. Throws, so the queue retries, only when the attempt failed and tries remain; the last failure is recorded as final and returned.
export async function runMeetingHookDelivery(deps: MeetingHookDeps, job: MeetingHookJob, attempt: { retryCount: number; retryLimit: number }): Promise<WakeResult> {
  const ctx = { actor: ACTOR, orgId: job.orgId };
  const delivery = await deps.runtime.query<MeetingHookDeliveryRow | null>('meetings.hook.delivery', { id: job.id }, ctx);
  // A delivery that is gone or already settled (a second job for it, a replay) is not sent again.
  if (!delivery || delivery.status !== 'queued') return 'skipped';
  const target = await deps.runtime.query<MeetingHookTargetRow | null>('meetings.hook.target', { hookId: delivery.hookId }, ctx);
  if (!target) {
    // The member left, turned the hook off or the owner turned the feature off: nothing is sent, and the body is wiped.
    await deps.runtime.execute('meetings.hook.record', { id: job.id, outcome: 'dropped' }, ctx);
    return 'dropped';
  }
  let status: number | null = null;
  try {
    const binding = { orgId: job.orgId, provider: MEETING_HOOK_PROVIDER, externalAccountId: target.userId };
    const open = (sealed: { keyId: string; envelope: string }) => deps.broker.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, binding);
    const secrets = [open(target.sealed), ...(target.previous ? [open(target.previous)] : [])];
    // The body is checked once more as it is sent: what the receiver gets is what the builder accepts.
    const { body: stored } = delivery;
    const message = meetingHookBody(stored);
    status = await postSigned(deps, { url: target.url, eventId: job.id, message, secrets });
  } catch (error) {
    // A key that no longer opens, a stored body that no longer fits, a name the guard refuses, one that does not resolve, a timeout, a dropped connection: a failed attempt, recorded like any other.
    console.warn(`[meeting-hook] ${job.id.slice(0, 8)} not delivered`, codeOf(error));
  }
  if (status !== null && status >= 200 && status < 300) {
    await deps.runtime.execute('meetings.hook.record', { id: job.id, outcome: 'sent', code: status }, ctx);
    return 'sent';
  }
  const last = attempt.retryCount >= attempt.retryLimit;
  await deps.runtime.execute('meetings.hook.record', { id: job.id, outcome: last ? 'failed' : 'retry', ...(status !== null && status >= 100 && status <= 599 ? { code: status } : {}) }, ctx);
  if (last) return 'failed';
  throw new Error(`minutes webhook ${job.id.slice(0, 8)} not delivered (attempt ${attempt.retryCount + 1})`);
}
