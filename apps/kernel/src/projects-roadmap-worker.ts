// SPDX-License-Identifier: AGPL-3.0-only
// Nightly keeping sweep and shipped notification dispatcher for Projects Public Roadmap (#4399, #4400, ADR-0053, ADR-0057).
import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import type { Db } from '@ludy/db';
import { zRoadmapShippedMailPayload } from '@ludy/kernel-contract';
import type { Actor, CredentialBinding, CredentialBroker, Runtime } from '@ludy/kernel-runtime';

export const ROADMAP_OTP_RETENTION_HOURS = 24;
export const ROADMAP_ANNOUNCEMENT_NOTIFY_EVENT = 'projects.roadmap.announcement_notify';
const SWEEP_ORG_BATCH = 500;
const SUBSCRIBER_BATCH = 200;
const SEALED_VALUE_RE = /^crove:cs1:([^:]+):([A-Za-z0-9_-]+)$/;
const ROADMAP_CLEANUP_ACTOR: Actor = { type: 'system', component: 'worker:projects-roadmap-otp-cleanup' };
const ROADMAP_NOTIFY_ACTOR: Actor = { type: 'system', component: 'worker:projects-roadmap-notify' };

export function openSealedRoadmapValue(
  broker: CredentialBroker,
  encoded: string,
  binding: CredentialBinding,
): string | null {
  const match = SEALED_VALUE_RE.exec(encoded);
  if (!match) return null;
  try {
    return broker.open({ keyId: match[1]!, envelope: Buffer.from(match[2]!, 'base64url') }, binding);
  } catch {
    return null;
  }
}

function sha256Hex(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

function oneLineSubject(raw: string, max = 300): string {
  const cleaned = raw.replace(/[\p{Cc}\p{Zl}\p{Zp}\r\n]+/gu, ' ').trim();
  return cleaned.slice(0, max) || 'Changelog update';
}

export async function dispatchRoadmapAnnouncementNotifications(
  deps: {
    workerDb: Db;
    runtime: Runtime;
    broker?: CredentialBroker | undefined;
    log?: Pick<Console, 'log' | 'error'>;
  },
  job: { orgId: string; eventId: string },
): Promise<{ queued: number; skipped: number; off: boolean }> {
  const log = deps.log ?? console;
  if (!deps.broker || deps.broker.id === 'none') {
    log.error('[projects-roadmap-notify] skipped: broker not configured');
    return { queued: 0, skipped: 0, off: false };
  }
  if (!(await deps.runtime.appOn(job.orgId, 'projects', { fresh: true }))) {
    return { queued: 0, skipped: 0, off: true };
  }

  const eventInfo = await deps.runtime.query<{ announcementId: string } | null>(
    'projects.roadmap.announcement_from_event',
    { eventId: job.eventId },
    { actor: ROADMAP_NOTIFY_ACTOR, orgId: job.orgId },
  );
  if (!eventInfo) {
    return { queued: 0, skipped: 0, off: false };
  }

  type DispatchContext = {
    orgSlug: string;
    orgName: string;
    boardId: string;
    boardSlug: string;
    boardTitle: string;
    announcementId: string;
    title: string;
    bodyMd: string;
    publishedAt: string;
  };
  const { rows: ctxRows } = await sql<{ ctx: DispatchContext | null }>`
    SELECT crove_projects.worker_roadmap_announcement_context(
      ${job.orgId}::uuid,
      ${eventInfo.announcementId}::uuid
    ) AS ctx`.execute(deps.workerDb);
  const ctx = ctxRows[0]?.ctx ?? null;
  if (!ctx) {
    return { queued: 0, skipped: 0, off: false };
  }

  const subject = oneLineSubject(`[${ctx.boardTitle}] ${ctx.title}`, 300);
  let afterId: string | null = null;
  let queued = 0;
  let skipped = 0;

  while (true) {
    const { rows: subscribers } = await sql<{
      id: string;
      voter_email_hash: string;
      email_sealed: string;
      unsub_token_sealed: string | null;
      mail_hash: string | null;
    }>`
      SELECT id, voter_email_hash, email_sealed, unsub_token_sealed, mail_hash
      FROM crove_projects.worker_roadmap_announcement_subscribers(
        ${job.orgId}::uuid,
        ${ctx.boardId}::uuid,
        ${afterId}::uuid,
        ${SUBSCRIBER_BATCH}::int
      )`.execute(deps.workerDb);

    if (subscribers.length === 0) break;

    for (const sub of subscribers) {
      afterId = sub.id;
      const email = openSealedRoadmapValue(deps.broker, sub.email_sealed, {
        orgId: job.orgId,
        provider: 'projects.roadmap_subscriber',
        externalAccountId: `${ctx.boardId}:${sub.voter_email_hash}`,
      });
      if (!email) {
        skipped += 1;
        continue;
      }

      if (!sub.unsub_token_sealed) {
        const rawUnsubToken = randomBytes(32).toString('base64url');
        const sealedUnsub = deps.broker.seal(rawUnsubToken, {
          orgId: job.orgId,
          provider: 'projects.roadmap_subscriber_unsub',
          externalAccountId: `${ctx.boardId}:${sub.voter_email_hash}`,
        });
        const unsubTokenSealed = `crove:cs1:${sealedUnsub.keyId}:${sealedUnsub.envelope.toString('base64url')}`;
        const { rows: sealRows } = await sql<{ sealed: string | null }>`
          SELECT crove_projects.worker_roadmap_subscriber_seal_unsub(
            ${job.orgId}::uuid,
            ${ctx.boardId}::uuid,
            ${sub.id}::uuid,
            ${sha256Hex(rawUnsubToken)},
            ${unsubTokenSealed},
            NULL
          ) AS sealed`.execute(deps.workerDb);
        if (!sealRows[0]?.sealed) {
          skipped += 1;
          continue;
        }
      }

      const payload = zRoadmapShippedMailPayload.parse({
        lang: 'vi',
        orgName: ctx.orgName,
        orgSlug: ctx.orgSlug,
        boardId: ctx.boardId,
        boardSlug: ctx.boardSlug,
        boardTitle: ctx.boardTitle,
        announcementId: ctx.announcementId,
        subscriberId: sub.id,
      });

      const res = await deps.runtime.execute<{ status: 'queued' | 'suppressed' | 'already_queued'; messageId: string }>(
        'kernel.mail.roadmap_shipped.queue',
        {
          announcementId: ctx.announcementId,
          subscriberId: sub.id,
          to: email,
          subject,
          payload,
        },
        { actor: ROADMAP_NOTIFY_ACTOR, orgId: job.orgId },
      );
      if (res.status === 'queued') {
        queued += 1;
      } else {
        skipped += 1;
      }
    }

    if (subscribers.length < SUBSCRIBER_BATCH) break;
  }

  return { queued, skipped, off: false };
}

export async function sweepRoadmapOtpCleanup(deps: {
  workerDb: Db;
  runtime: Runtime;
  now?: Date;
  log?: Pick<Console, 'log' | 'error'>;
}): Promise<{ orgs: number; deleted: number }> {
  const log = deps.log ?? console;
  const nowMs = (deps.now ?? new Date()).getTime();
  const cutoff = new Date(nowMs - ROADMAP_OTP_RETENTION_HOURS * 3_600_000);
  const { rows: orgs } = await sql<{ org_id: string }>`
    SELECT org_id
      FROM crove_projects.cleanup_roadmap_otp_due_orgs(${cutoff}::timestamptz, ${SWEEP_ORG_BATCH}::int)
     ORDER BY org_id ASC`.execute(deps.workerDb);

  const totals = { orgs: 0, deleted: 0 };
  for (const row of orgs) {
    try {
      const res = await deps.runtime.execute<{ deleted: number }>(
        'kernel.projects_roadmap.otp_cleanup',
        { cutoff: cutoff.toISOString() },
        { actor: ROADMAP_CLEANUP_ACTOR, orgId: row.org_id },
      );
      totals.orgs += 1;
      totals.deleted += res.deleted;
    } catch (error) {
      log.error(`[projects-roadmap-cleanup] org ${row.org_id.slice(0, 8)} failed`, error instanceof Error ? error.name : 'error');
    }
  }
  return totals;
}
