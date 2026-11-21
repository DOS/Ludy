// SPDX-License-Identifier: AGPL-3.0-only
// Deterministic Vy Today ("Hom nay can ban") read and single-shot 24h pre-expiry reminder sweep for eSign Slice 3c (#3813).
// - sign.today: zero AI cost, read-only, strictly enforcing org_app_on(org_id, 'sign') and hr_contract confidentiality
//   (owner, admin, or created_by only; ordinary members and viewers never see another employee's HR contract envelope).
//   Emits message keys with numeric parameters only so zero free text enters Today or Vy's brief.
// - sign.envelope.pre_expiry_remind_sweep: ADR-0053 'work' (no runsWhenOff), atomically stamps pre_expiry_reminded_at
//   so each eligible email recipient on active envelopes expiring within 24h receives at most one reminder email via
//   ADR-0034 (respecting mail_suppression, sequential routing_order, N1(a) direct-link suppression, active-session grace,
//   and storing zero plaintext tokens in queues).
import { sql } from 'kysely';
import { z } from 'zod';
import type { MemberRole } from '@crove/db';
import { TODAY_ITEMS_MAX, isMailAddress, tableWrite, zTodayItems, type TodayItem, type TodayTitle } from '@crove/kernel-contract';
import { defineCommand, defineQuery } from '@crove/kernel-runtime';
import { appendSigningEvent } from './events.ts';
import { applyEnvelopeVisibilityFilter, canAccessEnvelopeRow } from './hr-visibility.ts';
import { signManifest } from './manifest.ts';
import {
  SIGN_PRE_EXPIRY_REMIND_MAIL_SOURCE,
  SIGN_REMIND_MAIL_TEMPLATE,
  queueSignInviteEmail,
} from './sign-mail.ts';
import {
  MAIL_MESSAGE_WRITE,
  SIGNING_EVENT_WRITE,
  SIGN_READERS,
  assertSystemCommand,
} from './shared.ts';

export const SIGN_TODAY_EXPIRING_HOURS = 48;
export const SIGN_TODAY_DECLINED_DAYS = 14;
export const SIGN_PRE_EXPIRY_REMIND_HOURS = 24;
export const SIGN_ACTIVE_VIEW_GRACE_MINUTES = 15;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const VN_TZ_OFFSET_MS = 7 * HOUR_MS;
const SIGN_TODAY_ROW_LIMIT = 500;
const PRE_EXPIRY_SWEEP_BATCH = 100;

export interface SignTodayEnvelopeRow {
  id: string;
  status: string;
  source_kind: string;
  source_id?: string | null;
  created_by: string;
  expires_at: Date | string | null;
  declined_at: Date | string | null;
  decline_acknowledged_at?: Date | string | null;
  updated_at: Date | string;
}

interface PrioritizedSignTodayItem {
  priority: number;
  sortMs: number;
  envelopeId: string;
  item: TodayItem;
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

// Calendar day index in Vietnam time (Asia/Ho_Chi_Minh, UTC+07:00 without DST),
// so a decline at 23:55 yesterday reads as 1 day ago at 08:00 today rather than "today".
function vnCalendarDay(epochMs: number): number {
  return Math.floor((epochMs + VN_TZ_OFFSET_MS) / DAY_MS);
}

function declinedTitle(days: number): TodayTitle {
  return days >= 1
    ? { key: 'sign.envelopeDeclinedDays', params: { days } }
    : { key: 'sign.envelopeDeclinedToday', params: {} };
}

/**
 * Pure projection of visible eSign envelope rows into Home TodayItems for one actor.
 * Strictly enforces hr_contract confidentiality (owner, admin, or created_by only), excludes acknowledged declines,
 * and excludes viewers (who cannot remind, void, mint links, or create replacement envelopes).
 */
export function signTodayItemsOf(
  rows: readonly SignTodayEnvelopeRow[],
  options: { userId: string; role: MemberRole | null; now: Date; totalCount?: number | undefined },
): TodayItem[] {
  const { userId, role, now } = options;
  if (role === null || role === 'viewer') return [];

  const nowMs = now.getTime();
  const nowVnDay = vnCalendarDay(nowMs);
  const expiringUntilMs = nowMs + SIGN_TODAY_EXPIRING_HOURS * HOUR_MS;
  const declinedCutoffMs = nowMs - SIGN_TODAY_DECLINED_DAYS * DAY_MS;
  const visibilityCtx = {
    actor: { type: 'user' as const, userId, aal: 'aal1' as const },
    role,
  };

  const prioritized: PrioritizedSignTodayItem[] = [];

  for (const row of rows) {
    if (!canAccessEnvelopeRow(visibilityCtx, row)) continue;

    const href = `/sign/envelopes/${row.id}`;

    if (row.status === 'declined') {
      if (row.decline_acknowledged_at !== undefined && row.decline_acknowledged_at !== null) continue;
      const declinedDate = row.declined_at !== null ? toDate(row.declined_at) : toDate(row.updated_at);
      const declinedMs = declinedDate.getTime();
      if (Number.isNaN(declinedMs) || declinedMs < declinedCutoffMs) continue;
      const days = Math.max(0, nowVnDay - vnCalendarDay(declinedMs));
      prioritized.push({
        priority: 0,
        sortMs: -declinedMs,
        envelopeId: row.id,
        item: {
          kind: 'flag',
          app: 'sign',
          id: `declined:${row.id}`,
          title: declinedTitle(days),
          severity: 'warn',
          href,
        },
      });
      continue;
    }

    if ((row.status === 'sent' || row.status === 'in_progress') && row.expires_at !== null) {
      const expiresDate = toDate(row.expires_at);
      const expiresMs = expiresDate.getTime();
      if (Number.isNaN(expiresMs) || expiresMs <= nowMs || expiresMs > expiringUntilMs) continue;
      const hours = Math.max(1, Math.ceil((expiresMs - nowMs) / HOUR_MS));
      prioritized.push({
        priority: 1,
        sortMs: expiresMs,
        envelopeId: row.id,
        item: {
          kind: 'deadline',
          app: 'sign',
          id: `expiring:${row.id}`,
          title: { key: 'sign.envelopeExpiringHours', params: { hours } },
          dueAt: expiresDate.toISOString(),
          href,
        },
      });
    }
  }

  prioritized.sort(
    (a, b) =>
      a.priority - b.priority ||
      a.sortMs - b.sortMs ||
      byText(a.envelopeId, b.envelopeId) ||
      byText(a.item.id, b.item.id),
  );

  const deduped: TodayItem[] = [];
  const seenEnvelopes = new Set<string>();
  for (const entry of prioritized) {
    if (seenEnvelopes.has(entry.envelopeId)) continue;
    seenEnvelopes.add(entry.envelopeId);
    deduped.push(entry.item);
  }

  const totalCount = Math.max(deduped.length, options.totalCount ?? 0);
  if (totalCount <= TODAY_ITEMS_MAX) {
    return zTodayItems.parse(deduped);
  }

  const headCount = TODAY_ITEMS_MAX - 1;
  const head = deduped.slice(0, headCount);
  const overflow = totalCount - head.length;
  return zTodayItems.parse([
    ...head,
    {
      kind: 'flag',
      app: 'sign',
      id: 'more',
      title: { key: 'sign.more', params: { count: overflow } },
      count: overflow,
      severity: 'warn',
      href: '/sign/envelopes',
    },
  ]);
}

export const signToday = defineQuery({
  name: 'sign.today',
  // `now` is passed only by deterministic tests; kernel.today passes {}.
  input: z.strictObject({ now: z.iso.datetime({ offset: true }).optional() }),
  access: SIGN_READERS,
  handler: async (ctx, input): Promise<TodayItem[]> => {
    if (ctx.actor.type !== 'user' || ctx.role === null || ctx.role === 'viewer') return [];

    const { rows: appRows } = await sql<{ enabled: boolean }>`
      SELECT crove_kernel.org_app_on(${ctx.orgId}::uuid, 'sign') AS enabled
    `.execute(ctx.trx);
    if (!appRows[0]?.enabled) return [];

    const now = input.now ? new Date(input.now) : new Date();
    const expiringUntil = new Date(now.getTime() + SIGN_TODAY_EXPIRING_HOURS * HOUR_MS);
    const declinedCutoff = new Date(now.getTime() - SIGN_TODAY_DECLINED_DAYS * DAY_MS);

    const isDeclinedRecentExpr = sql<boolean>`status = 'declined' AND decline_acknowledged_at IS NULL AND COALESCE(declined_at, updated_at) >= ${declinedCutoff}`;
    const isExpiringSoonExpr = sql<boolean>`status IN ('sent', 'in_progress') AND expires_at IS NOT NULL AND expires_at > ${now} AND expires_at <= ${expiringUntil}`;

    let base = ctx.trx
      .selectFrom('crove_sign.envelope')
      .where('org_id', '=', ctx.orgId)
      .where(sql<boolean>`((${isDeclinedRecentExpr}) OR (${isExpiringSoonExpr}))`);
    base = applyEnvelopeVisibilityFilter(base, ctx);

    const rows = await base
      .select([
        'id',
        'status',
        'source_kind',
        'source_id',
        'created_by',
        'expires_at',
        'declined_at',
        'decline_acknowledged_at',
        'updated_at',
      ])
      .orderBy(sql`CASE WHEN status = 'declined' THEN 0 ELSE 1 END ASC`)
      .orderBy(
        sql`CASE WHEN status = 'declined' THEN NULL ELSE expires_at END ASC NULLS FIRST`,
      )
      .orderBy(
        sql`CASE WHEN status = 'declined' THEN COALESCE(declined_at, updated_at) ELSE NULL END DESC NULLS LAST`,
      )
      .orderBy('id', 'asc')
      .limit(SIGN_TODAY_ROW_LIMIT)
      .execute();

    let totalCount: number | undefined;
    if (rows.length === SIGN_TODAY_ROW_LIMIT) {
      const countRow = await base.select(sql<string>`count(*)::text`.as('total')).executeTakeFirst();
      totalCount = Number(countRow?.total ?? rows.length);
    }

    return signTodayItemsOf(rows, {
      userId: ctx.actor.userId,
      role: ctx.role,
      now,
      ...(totalCount === undefined ? {} : { totalCount }),
    });
  },
});

export interface SignPreExpirySignerCandidate {
  id: string;
  routing_order: number;
  signer_role: string;
  role_label: string;
  email: string | null;
  delivery_mode: string;
  status: string;
  viewed_at?: Date | string | null;
  otp_verified_at?: Date | string | null;
  pre_expiry_reminded_at: Date | string | null;
}

/**
 * Selects active email-mode signers eligible for the single-shot 24h pre-expiry reminder.
 * In sequential routing mode, strictly restricts reminders to the lowest unfinished routing_order step
 * and never selects 'waiting' or 'cc' recipients.
 * Respects N1(a) direct-link mail-relay suppression (requiring otp_verified_at on direct-link envelopes)
 * and a 15-minute active-view grace window so an in-progress signing session is not interrupted.
 */
export function selectPreExpiryEligibleSigners<T extends SignPreExpirySignerCandidate>(
  routingMode: string,
  signers: readonly T[],
  options?: { isDirectLinkEnvelope?: boolean; now?: Date },
): T[] {
  const nonCc = signers.filter((s) => s.signer_role !== 'cc');
  if (nonCc.length === 0) return [];
  const isDirectLinkEnvelope = options?.isDirectLinkEnvelope === true;
  const activeViewCutoffMs =
    options?.now !== undefined ? options.now.getTime() - SIGN_ACTIVE_VIEW_GRACE_MINUTES * MINUTE_MS : null;

  let activeOrder: number | null = null;
  if (routingMode === 'sequential') {
    const remaining = nonCc.filter(
      (s) => s.status === 'waiting' || s.status === 'pending' || s.status === 'viewed',
    );
    if (remaining.length === 0) return [];
    activeOrder = remaining.reduce(
      (min, s) => (s.routing_order < min ? s.routing_order : min),
      remaining[0]!.routing_order,
    );
  }

  return nonCc
    .filter((s) => {
      if (activeOrder !== null && s.routing_order !== activeOrder) return false;
      if (s.status !== 'pending' && s.status !== 'viewed') return false;
      if (activeViewCutoffMs !== null && s.viewed_at !== undefined && s.viewed_at !== null) {
        const viewedMs = toDate(s.viewed_at).getTime();
        if (!Number.isNaN(viewedMs) && viewedMs > activeViewCutoffMs) return false;
      }
      if (s.delivery_mode !== 'email') return false;
      if (isDirectLinkEnvelope && (s.otp_verified_at === undefined || s.otp_verified_at === null)) {
        return false;
      }
      if (s.pre_expiry_reminded_at !== null) return false;
      const normalized = s.email?.trim().toLowerCase() ?? '';
      return normalized.length > 0 && isMailAddress(normalized);
    })
    .sort((a, b) => a.routing_order - b.routing_order || byText(a.id, b.id));
}

export interface SignPreExpirySweepResult {
  envelopesReminded: number;
  remindedSigners: number;
  queuedEmails: number;
  suppressedEmails: number;
  remindedEnvelopeIds: string[];
}

export const envelopePreExpiryRemindSweep = defineCommand({
  name: 'sign.envelope.pre_expiry_remind_sweep',
  input: z.strictObject({
    now: z.iso.datetime({ offset: true }).optional(),
  }),
  risk: 'R2',
  sideEffect: 'external',
  access: 'system',
  writes: [
    tableWrite(signManifest.tables, 'crove_sign', 'signer', ['pre_expiry_reminded_at', 'updated_at']),
    SIGNING_EVENT_WRITE,
    MAIL_MESSAGE_WRITE,
  ],
  handler: async (ctx, input): Promise<SignPreExpirySweepResult> => {
    assertSystemCommand(ctx);
    const sweepNow = input.now ? new Date(input.now) : ctx.now;
    const windowEnd = new Date(sweepNow.getTime() + SIGN_PRE_EXPIRY_REMIND_HOURS * HOUR_MS);
    const activeViewCutoff = new Date(sweepNow.getTime() - SIGN_ACTIVE_VIEW_GRACE_MINUTES * MINUTE_MS);

    // Filter eligible unreminded signers BEFORE LIMIT so already-reminded envelopes never starve >100 due envelopes.
    const dueEnvelopes = await ctx.trx
      .selectFrom('crove_sign.envelope as e')
      .select(['e.id', 'e.title', 'e.routing_mode', 'e.expires_at', 'e.source_sha256', 'e.direct_link_id'])
      .where('e.org_id', '=', ctx.orgId)
      .where('e.status', 'in', ['sent', 'in_progress'])
      .where('e.auto_remind_before_expiry', '=', true)
      .where('e.expires_at', 'is not', null)
      .where('e.expires_at', '>', sweepNow)
      .where('e.expires_at', '<=', windowEnd)
      .where(
        sql<boolean>`EXISTS (
          SELECT 1
          FROM crove_sign.signer s
          WHERE s.org_id = e.org_id
            AND s.envelope_id = e.id
            AND s.signer_role <> 'cc'
            AND s.delivery_mode = 'email'
            AND s.email IS NOT NULL
            AND s.status IN ('pending', 'viewed')
            AND (s.viewed_at IS NULL OR s.viewed_at <= ${activeViewCutoff})
            AND s.pre_expiry_reminded_at IS NULL
            AND (
              e.routing_mode <> 'sequential'
              OR NOT EXISTS (
                SELECT 1
                FROM crove_sign.signer earlier
                WHERE earlier.org_id = e.org_id
                  AND earlier.envelope_id = e.id
                  AND earlier.signer_role <> 'cc'
                  AND earlier.status IN ('waiting', 'pending', 'viewed')
                  AND earlier.routing_order < s.routing_order
              )
            )
            AND (
              s.otp_verified_at IS NOT NULL
              OR (
                e.direct_link_id IS NULL
                AND NOT EXISTS (
                  SELECT 1
                  FROM crove_sign.signing_event ge
                  WHERE ge.org_id = e.org_id
                    AND ge.envelope_id = e.id
                    AND ge.seq = 1
                    AND ge.actor_label = 'system:sign-direct-link'
                )
              )
            )
        )`,
      )
      .orderBy('e.expires_at', 'asc')
      .orderBy('e.id', 'asc')
      .limit(PRE_EXPIRY_SWEEP_BATCH)
      .forUpdate()
      .skipLocked()
      .execute();

    if (dueEnvelopes.length === 0) {
      ctx.audit({ envelopesReminded: 0, remindedSigners: 0, queuedEmails: 0, suppressedEmails: 0 });
      return {
        envelopesReminded: 0,
        remindedSigners: 0,
        queuedEmails: 0,
        suppressedEmails: 0,
        remindedEnvelopeIds: [],
      };
    }

    const dueIds = dueEnvelopes.map((e) => e.id);
    const idsWithoutDirectFk = dueEnvelopes.filter((e) => e.direct_link_id == null).map((e) => e.id);

    // Batch-read genesis events (seq = 1) and signers across all locked dueEnvelopes (zero per-envelope N+1 queries).
    const directGenesisSet = new Set<string>();
    if (idsWithoutDirectFk.length > 0) {
      const genesisRows = await ctx.trx
        .selectFrom('crove_sign.signing_event')
        .select(['envelope_id', 'actor_label'])
        .where('org_id', '=', ctx.orgId)
        .where('envelope_id', 'in', idsWithoutDirectFk)
        .where('seq', '=', 1)
        .execute();
      for (const g of genesisRows) {
        if (g.actor_label === 'system:sign-direct-link') {
          directGenesisSet.add(g.envelope_id);
        }
      }
    }

    const allSigners = await ctx.trx
      .selectFrom('crove_sign.signer')
      .select([
        'id',
        'envelope_id',
        'routing_order',
        'signer_role',
        'role_label',
        'email',
        'delivery_mode',
        'status',
        'viewed_at',
        'otp_verified_at',
        'pre_expiry_reminded_at',
      ])
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', 'in', dueIds)
      .orderBy('envelope_id', 'asc')
      .orderBy('routing_order', 'asc')
      .orderBy('id', 'asc')
      .forUpdate()
      .execute();

    const signersByEnvelope = new Map<string, typeof allSigners>();
    for (const s of allSigners) {
      const list = signersByEnvelope.get(s.envelope_id);
      if (list) {
        list.push(s);
      } else {
        signersByEnvelope.set(s.envelope_id, [s]);
      }
    }

    let orgName: string | null = null;
    let envelopesReminded = 0;
    let remindedSigners = 0;
    let queuedEmails = 0;
    let suppressedEmails = 0;
    const remindedEnvelopeIds: string[] = [];

    for (const env of dueEnvelopes) {
      if (!env.expires_at) continue;
      const isDirectLinkEnvelope = env.direct_link_id != null || directGenesisSet.has(env.id);
      const signers = signersByEnvelope.get(env.id) ?? [];

      const eligible = selectPreExpiryEligibleSigners(env.routing_mode, signers, {
        isDirectLinkEnvelope,
        now: sweepNow,
      });
      if (eligible.length === 0) continue;

      const stampedRows = await ctx.trx
        .updateTable('crove_sign.signer')
        .set({ pre_expiry_reminded_at: sweepNow, updated_at: sweepNow })
        .where('org_id', '=', ctx.orgId)
        .where('envelope_id', '=', env.id)
        .where(
          'id',
          'in',
          eligible.map((s) => s.id),
        )
        .where('pre_expiry_reminded_at', 'is', null)
        .where('status', 'in', ['pending', 'viewed'])
        .returning('id')
        .execute();

      const stampedSet = new Set(stampedRows.map((r) => r.id));
      const stampedSigners = eligible.filter((s) => stampedSet.has(s.id));
      if (stampedSigners.length === 0) continue;

      if (orgName === null) {
        const tenant = await ctx.trx
          .selectFrom('crove_kernel.tenant')
          .select('name')
          .where('org_id', '=', ctx.orgId)
          .executeTakeFirstOrThrow();
        orgName = tenant.name;
      }

      const expiresAtIso = new Date(env.expires_at).toISOString();
      let envQueued = 0;
      let envSuppressed = 0;
      for (const s of stampedSigners) {
        if (!s.email) continue;
        const mail = await queueSignInviteEmail(ctx, {
          source: SIGN_PRE_EXPIRY_REMIND_MAIL_SOURCE,
          templateKey: SIGN_REMIND_MAIL_TEMPLATE,
          preExpiry: true,
          orgName,
          envelopeId: env.id,
          signerId: s.id,
          signerRole: s.signer_role === 'approver' ? 'approver' : 'signer',
          to: s.email,
          docTitle: env.title,
          roleLabel: s.role_label,
          expiresAt: expiresAtIso,
        });
        if (mail.status === 'suppressed') {
          envSuppressed += 1;
        } else {
          envQueued += 1;
        }
      }

      await appendSigningEvent(ctx.trx, {
        orgId: ctx.orgId,
        envelopeId: env.id,
        signerId: stampedSigners.length === 1 ? stampedSigners[0]!.id : null,
        eventType: 'signer_pre_expiry_reminded',
        actorType: 'system',
        actorLabel: ctx.actor.type === 'system' ? `system:${ctx.actor.component}` : 'system',
        documentSha256: env.source_sha256,
        payloadJson: {
          signerIds: stampedSigners.map((s) => s.id),
          queuedCount: envQueued,
          suppressedCount: envSuppressed,
          expiresAt: expiresAtIso,
        },
        occurredAt: sweepNow,
      });

      envelopesReminded += 1;
      remindedSigners += stampedSigners.length;
      queuedEmails += envQueued;
      suppressedEmails += envSuppressed;
      remindedEnvelopeIds.push(env.id);
    }

    ctx.audit({
      envelopesReminded,
      remindedSigners,
      queuedEmails,
      suppressedEmails,
    });

    return {
      envelopesReminded,
      remindedSigners,
      queuedEmails,
      suppressedEmails,
      remindedEnvelopeIds,
    };
  },
});
