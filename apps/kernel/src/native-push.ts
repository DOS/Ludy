// SPDX-License-Identifier: AGPL-3.0-only
// Open native-push sender interface, content-free payload builder, claim/enqueue helper, and worker dispatcher (#4883, ADR-0059).
// Self-hosted deployments leave KernelAdapters.nativePush unset, keeping native push cleanly disabled without vendor SDKs or APNs/FCM secrets.
import { sql, type Transaction } from 'kysely';
import type { SendOptions } from 'pg-boss';
import type { Database, Db } from '@ludy/db';
import type { NativePushPlatform } from '@ludy/kernel-contract';
import type { NativePushDeviceRef, NativePushKind, NativePushTargetsResult } from '@ludy/kernel';
import type { Runtime, SystemActor } from '@ludy/kernel-runtime';
import { jobKey } from './job-keys.ts';
import { QUEUES } from './jobs-schema.ts';

export type NativePushOutcome = 'sent' | 'gone' | 'failed';

export interface NativePushTarget {
  readonly platform: NativePushPlatform;
  readonly token: string;
}

// Strictly content-free notification payload handed off to the native push sender adapter (for example Crove Cloud relay).
// Carries static Vietnamese copy, the trigger kind, the workspace slug, the opaque subject id (when present), and deep-link path only.
// Zero customer text, message previews, amounts, or proposal titles ever enter this payload.
export interface NativePushPayload {
  readonly kind: NativePushKind;
  readonly title: string;
  readonly orgSlug: string;
  readonly subjectId: string | null;
  readonly path: string;
}

export interface NativePushSender {
  readonly id: string;
  send(target: NativePushTarget, payload: NativePushPayload): Promise<NativePushOutcome>;
}

export interface NativePushJob {
  orgId: string;
  notificationId: string;
}

export interface NativePushJobSender {
  send(name: string, data?: object | null, options?: SendOptions): Promise<string | null>;
}

export const NATIVE_PUSH_SWEEP_MS = 10_000;
export const NATIVE_PUSH_BATCH_LIMIT = 100;

const NATIVE_PUSH_ACTOR: SystemActor = { type: 'system', component: 'kernel.native_push' };

const NATIVE_PUSH_SPEC: Readonly<
  Record<NativePushKind, { title: string; path: (orgSlug: string, subjectId: string | null) => string }>
> = {
  'kernel.conversation_new': {
    title: 'Có 1 hội thoại mới',
    path: (orgSlug, subjectId) =>
      subjectId
        ? `/o/${encodeURIComponent(orgSlug)}/social/inbox?c=${encodeURIComponent(subjectId)}`
        : `/o/${encodeURIComponent(orgSlug)}/social/inbox?status=new`,
  },
  'kernel.approval_waiting': {
    title: 'Có 1 đề xuất cần duyệt',
    path: (orgSlug, subjectId) =>
      subjectId
        ? `/o/${encodeURIComponent(orgSlug)}/inbox/${encodeURIComponent(subjectId)}`
        : `/o/${encodeURIComponent(orgSlug)}/inbox`,
  },
};

export function buildNativePushPayload(kind: NativePushKind, orgSlug: string, subjectId: string | null): NativePushPayload {
  const spec = NATIVE_PUSH_SPEC[kind];
  return {
    kind,
    title: spec.title,
    orgSlug,
    subjectId,
    path: spec.path(orgSlug, subjectId),
  };
}

// Claims unread recent native-push-eligible notifications on `claimDb` (typically a relayBatch transaction opened by worker.ts)
// and enqueues one at-most-once job per notification on QUEUES.nativePush. Keeps `boss` parameter name for job-egress AST tracking.
export async function enqueueNativePushes(
  boss: NativePushJobSender,
  claimDb: Db | Transaction<Database>,
  limit = NATIVE_PUSH_BATCH_LIMIT,
  orgId: string | null = null,
): Promise<number> {
  const { rows } = await sql<{ org_id: string; notification_id: string }>`
    SELECT org_id, notification_id FROM ludy_kernel.native_push_claim(${limit}::int, ${orgId}::uuid)`.execute(claimDb);
  for (const row of rows) {
    await boss.send(
      QUEUES.nativePush,
      { orgId: row.org_id, notificationId: row.notification_id } satisfies NativePushJob,
      {
        singletonKey: jobKey(row.org_id, QUEUES.nativePush, row.notification_id),
        retryLimit: 0,
        expireInSeconds: 300,
      },
    );
  }
  return rows.length;
}

export async function runNativePushJob(deps: {
  runtime: Runtime;
  sender: NativePushSender;
  orgId: string;
  notificationId: string;
  checkUpstream?: boolean;
}): Promise<{ sent: number; gone: number; failed: number }> {
  const loaded = await deps.runtime.query<NativePushTargetsResult | null>(
    'kernel.native_push.targets',
    { notificationId: deps.notificationId, checkUpstream: deps.checkUpstream ?? false },
    { actor: NATIVE_PUSH_ACTOR, orgId: deps.orgId },
  );
  if (!loaded || loaded.targets.length === 0) return { sent: 0, gone: 0, failed: 0 };

  const payload = buildNativePushPayload(loaded.kind, loaded.orgSlug, loaded.subjectId);
  const sent: NativePushDeviceRef[] = [];
  const gone: NativePushDeviceRef[] = [];
  const expired: NativePushDeviceRef[] = [];
  const failed: NativePushDeviceRef[] = [];

  try {
    for (let i = 0; i < loaded.targets.length; i++) {
      const initial = loaded.targets[i];
      if (!initial) continue;
      let target = initial;
      if (i > 0) {
        // Re-verify live eligibility, session validity, and device generation before dispatching to subsequent devices.
        const fresh = await deps.runtime.query<NativePushTargetsResult | null>(
          'kernel.native_push.targets',
          { notificationId: deps.notificationId, checkUpstream: deps.checkUpstream ?? false },
          { actor: NATIVE_PUSH_ACTOR, orgId: deps.orgId },
        );
        if (!fresh) break;
        const match = fresh.targets.find((t) => t.deviceId === initial.deviceId && t.generation === initial.generation);
        if (!match) continue;
        target = match;
      }
      const ref: NativePushDeviceRef = { id: target.deviceId, generation: target.generation };
      if (!target.sessionValid) {
        expired.push(ref);
        continue;
      }
      const outcome = await deps.sender
        .send({ platform: target.platform, token: target.token }, payload)
        .catch(() => 'failed' as const);
      if (outcome === 'sent') sent.push(ref);
      else if (outcome === 'gone') gone.push(ref);
      else failed.push(ref);
    }
  } finally {
    if (sent.length + gone.length + expired.length + failed.length > 0) {
      try {
        await deps.runtime.execute(
          'kernel.native_push.record',
          { sent, gone, expired, failed, checkUpstream: deps.checkUpstream ?? false },
          { actor: NATIVE_PUSH_ACTOR, orgId: deps.orgId },
        );
      } catch (error) {
        console.warn(
          `[native-push] record failed for ${deps.notificationId.slice(0, 8)}`,
          error instanceof Error ? error.name : 'error',
        );
      }
    }
  }
  return { sent: sent.length, gone: gone.length + expired.length, failed: failed.length };
}
