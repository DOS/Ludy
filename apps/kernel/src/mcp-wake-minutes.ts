// SPDX-License-Identifier: AGPL-3.0-only
// The wake-up for published minutes (#3803, ADR-0051 decision 4): when the recorder publishes a result of a meeting shared with the whole company, `meetings.result.publish` stores one outbox event
// (`meetings.minutes.published`: the meeting's id and the instant, no word of the minutes), and the worker's notify job calls this with the event's id. It reaches no URL and enters no grant's context:
//   1. Meetings must be on for the org (the relay already parks the events of an app that is off; this asks again, as the sweep of the minutes webhook does).
//   2. `kernel.mcp.wake.minutes_targets` reads the event itself, lists the company grants whose wake-up stands now (worker-only definer, ids only) and drops, with an audit row by the event's id, an
//      event older than 24 hours when it would be sent.
//   3. For each grant: the body is built by the one builder (mcp-wake-body.ts), stored through `kernel.mcp.wake.enqueue` (the database checks the body again and refuses the type for a member-bound
//      grant) and handed to the queue (mcp-wake.ts signs and sends it). A queue failure leaves the delivery stored, to be handed over again by the sweep; a grant that stopped standing between the list
//      and the store is skipped; a failure for one grant never stops the others.
// Dedupe: the delivery's id is derived from the outbox event's id and the grant's id (a name-based UUID), so a retry of the same event stores nothing new and sends nothing new, while a second publish is
// a second event and sends one more.
import { createHash } from 'node:crypto';
import { MINUTES_WAKE_TYPE } from '@crove/kernel-contract';
import type { McpWakeMinutesTargets } from '@crove/kernel';
import { DomainError, type Runtime } from '@crove/kernel-runtime';
import { wakeEvent } from './mcp-wake-body.ts';
import type { WakeJob } from './mcp-wake.ts';

const ACTOR = { type: 'system' as const, component: 'kernel.mcp.wake' };
const codeOf = (error: unknown) => (error instanceof DomainError ? error.code : error instanceof Error ? error.name : 'error');
// A fixed namespace for the name-based ids of these deliveries (RFC 4122 version 5); any constant that is not another feature's would do.
const NAMESPACE = '6f1d3a52-3803-5c11-9a55-3f2d8e6b4a10';

interface MinutesWakeDeps {
  runtime: Runtime;
  // Hands one delivery to the kernel-mcp-wake queue (a singleton job per delivery).
  send: (job: WakeJob) => Promise<unknown>;
  now?: () => Date;
}

interface MinutesWakeResult {
  // Meetings was off for the org when the job ran: nothing was looked at.
  off: boolean;
  // The event was older than 24 hours: dropped and audited, nothing stored.
  dropped: boolean;
  // Deliveries newly stored, and of those the ones handed to the queue now.
  stored: number;
  handedOver: number;
}

// A version 5 UUID of a name in the namespace: the same inputs always give the same id.
function wakeDeliveryId(eventId: string, grantId: string): string {
  const hash = createHash('sha1')
    .update(Buffer.from(NAMESPACE.replace(/-/g, ''), 'hex'))
    .update(`${eventId}:${grantId}`)
    .digest();
  hash[6] = ((hash[6] as number) & 0x0f) | 0x50;
  hash[8] = ((hash[8] as number) & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function wakeMinutesPublished(deps: MinutesWakeDeps, job: { orgId: string; eventId: string }): Promise<MinutesWakeResult> {
  const now = deps.now ?? (() => new Date());
  const result: MinutesWakeResult = { off: false, dropped: false, stored: 0, handedOver: 0 };
  if (!(await deps.runtime.appOn(job.orgId, 'meetings', { fresh: true }))) return { ...result, off: true };
  const ctx = { actor: ACTOR, orgId: job.orgId };
  const targets = await deps.runtime.execute<McpWakeMinutesTargets | null>('kernel.mcp.wake.minutes_targets', { eventId: job.eventId, now: now().toISOString() }, ctx);
  if (!targets) return result;
  if (targets.dropped) return { ...result, dropped: true };
  for (const grantId of targets.grants) {
    const id = wakeDeliveryId(job.eventId, grantId);
    try {
      const body = wakeEvent({ id, type: MINUTES_WAKE_TYPE, created_at: now().toISOString(), org: job.orgId, grant: grantId, data: { meeting_id: targets.meetingId, published_at: targets.publishedAt } });
      const stored = await deps.runtime.execute<{ stored: boolean }>('kernel.mcp.wake.enqueue', { id, grantId, type: MINUTES_WAKE_TYPE, body }, ctx);
      if (!stored.stored) continue;
      result.stored += 1;
      await deps.send({ orgId: job.orgId, id }).then(
        () => void (result.handedOver += 1),
        (error: unknown) => console.warn(`[mcp-wake-minutes] ${id.slice(0, 8)} not handed over, will be again`, codeOf(error)),
      );
    } catch (error) {
      // A grant that no longer stands, or a store that failed: the others go on.
      console.warn(`[mcp-wake-minutes] grant ${grantId.slice(0, 8)}`, codeOf(error));
    }
  }
  return result;
}
