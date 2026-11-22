// SPDX-License-Identifier: AGPL-3.0-only
// Shared validation, coordinate normalization, file lookup, and envelope send helpers for @ludy/mod-sign.
import { sql } from 'kysely';
import { z } from 'zod';
import type { MemberRole } from '@ludy/db';
import { kernelManifest } from '@ludy/kernel';
import {
  SIGN_MAX_DETECTED_TAGS,
  SIGN_MAX_PAGES,
  SIGN_NORM_SCALE,
  SIGN_SHARED_KEY_TERMS_MAX,
  SIGN_SHARED_SUMMARY_MAX_CHARS,
  tableWrite,
  zSignDetectedTag,
  zSignEnvelopePageDimension,
  zSignFieldOptions,
  zSignSharedSummary,
  type SignDetectedTag,
  type SignSharedKeyTerm,
  type SignSharedSummary,
} from '@ludy/kernel-contract';
import { DomainError, type CommandContext, type QueryContext } from '@ludy/kernel-runtime';
import { appendSigningEvent } from './events.ts';
import { signManifest } from './manifest.ts';
import { generateRawSigningToken, hashSigningToken } from './sealing.ts';
import { SIGN_INVITE_MAIL_SOURCE, SIGN_INVITE_MAIL_TEMPLATE, queueSignInviteEmail } from './sign-mail.ts';
import { WEBHOOK_DELIVERY_ENQUEUE_WRITE, enqueueSignWebhookEvent } from './webhooks.ts';

export { WEBHOOK_DELIVERY_ENQUEUE_WRITE };

export const SIGN_WRITERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
export const SIGN_READERS: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
export const SIGN_MAX_LINK_HOURS = 30 * 24;
export const SIGN_MAX_LINK_TTL_MS = SIGN_MAX_LINK_HOURS * 3_600_000;

export function assertValidEnvelopeExpiry(expiresAt: Date | null, now: Date): void {
  if (expiresAt === null) return;
  const nowMs = now.getTime();
  const expMs = expiresAt.getTime();
  if (!Number.isFinite(expMs) || expMs <= nowMs) {
    throw new DomainError('SIGN_INVALID_EXPIRY', 422, 'expiresAt must be in the future');
  }
  if (expMs > nowMs + SIGN_MAX_LINK_TTL_MS) {
    throw new DomainError('SIGN_INVALID_EXPIRY', 422, 'expiresAt cannot exceed 30 days (720 hours)');
  }
}

export interface IssuedSigningLink {
  signerId: string;
  tokenId: string;
  token: string;
  expiresAt: string;
}

export const ENVELOPE_VERSION_WRITE = tableWrite(signManifest.tables, 'crove_sign', 'envelope', ['version', 'updated_at']);

export const SIGNING_EVENT_WRITE = tableWrite(signManifest.tables, 'crove_sign', 'signing_event', [
  'org_id',
  'envelope_id',
  'signer_id',
  'host_user_id',
  'seq',
  'event_type',
  'actor_type',
  'actor_id',
  'actor_label',
  'document_sha256',
  'prev_event_hash',
  'event_hash',
  'payload_json',
  'ip_hash',
  'user_agent',
  'occurred_at',
]);

export const SIGNING_TOKEN_WRITE = tableWrite(signManifest.tables, 'crove_sign', 'signing_token', [
  'org_id',
  'envelope_id',
  'signer_id',
  'token_sha256',
  'expires_at',
  'revoked_at',
  'revoked_by',
  'in_person_host_user_id',
  'created_by',
  'created_at',
]);

export const SIGNING_OTP_INVALIDATE_WRITE = tableWrite(signManifest.tables, 'crove_sign', 'signing_otp', ['invalidated_at']);

export const MAIL_MESSAGE_WRITE = tableWrite(kernelManifest.tables, 'ludy_kernel', 'mail_message', [
  'org_id',
  'stream',
  'source',
  'source_id',
  'template_key',
  'to_address',
  'to_hash',
  'subject',
  'payload',
  'message_id_header',
  'status',
  'error_code',
  'created_by',
]);

export function userIdOf(ctx: CommandContext): string {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'User context required');
  return ctx.actor.userId;
}

export function assertSystemCommand(ctx: CommandContext): void {
  if (ctx.actor.type !== 'system') {
    throw new DomainError('FORBIDDEN', 403, 'System actor context required');
  }
}

export function assertUserQuery(ctx: QueryContext): void {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'User context required');
}

export function assertSystemQuery(ctx: QueryContext): void {
  if (ctx.actor.type !== 'system') {
    throw new DomainError('FORBIDDEN', 403, 'System actor context required');
  }
}

export function actorLabelOfCtx(ctx: CommandContext): string {
  if (ctx.actor.type === 'user') return `user:${ctx.actor.userId}`;
  if (ctx.actor.type === 'system') return 'system';
  return `${ctx.actor.type}:${ctx.actor.agentId}`;
}

export function toSignMicroNorm(value: number): number {
  return Math.round(value * SIGN_NORM_SCALE);
}

export function formatSignMicroNorm(micro: number): string {
  return (micro / SIGN_NORM_SCALE).toFixed(6);
}

export function normalizeNormalizedFieldBoxes<
  T extends { xNorm: number; yNorm: number; wNorm: number; hNorm: number; pageNumber: number },
>(fields: readonly T[], pageCount: number | null): Array<T & { xStr: string; yStr: string; wStr: string; hStr: string }> {
  return fields.map((f) => {
    const x = toSignMicroNorm(f.xNorm);
    const y = toSignMicroNorm(f.yNorm);
    const w = toSignMicroNorm(f.wNorm);
    const h = toSignMicroNorm(f.hNorm);
    if (x < 0 || x >= SIGN_NORM_SCALE || y < 0 || y >= SIGN_NORM_SCALE) {
      throw new DomainError('SIGN_INVALID_FIELD', 422, 'Field normalized coordinates must stay in [0, 1)');
    }
    if (w < 1 || w > SIGN_NORM_SCALE || h < 1 || h > SIGN_NORM_SCALE) {
      throw new DomainError('SIGN_INVALID_FIELD', 422, 'Field normalized dimensions must stay in (0, 1]');
    }
    if (x + w > SIGN_NORM_SCALE || y + h > SIGN_NORM_SCALE) {
      throw new DomainError('SIGN_FIELD_OUT_OF_BOUNDS', 422, 'Normalized field exceeds page bounds [0, 1]');
    }
    if (pageCount !== null && f.pageNumber > pageCount) {
      throw new DomainError(
        'SIGN_FIELD_OUT_OF_BOUNDS',
        422,
        `Field pageNumber ${f.pageNumber} exceeds document page count ${pageCount}`,
      );
    }
    return {
      ...f,
      xStr: formatSignMicroNorm(x),
      yStr: formatSignMicroNorm(y),
      wStr: formatSignMicroNorm(w),
      hStr: formatSignMicroNorm(h),
    };
  });
}

export interface SignSourceFileRow {
  id: string;
  storage_key: string;
  generation: string;
  sha256: string;
}

export async function requireSignSourceFile(ctx: CommandContext, sourceFileId: string): Promise<SignSourceFileRow> {
  const file = await ctx.trx
    .selectFrom('ludy_kernel.file')
    .select(['id', 'source', 'content_type', 'storage_key', 'generation', 'sha256'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', sourceFileId)
    .executeTakeFirst();
  if (!file) throw new DomainError('SIGN_FILE_NOT_FOUND', 404, 'Source file not found');
  if (
    (file.source === 'sign_document' ||
      file.source === 'sign_sealed' ||
      file.source === 'sign_certificate' ||
      file.source === 'sign_attachment') &&
    ctx.actor.type !== 'system'
  ) {
    const { rows } = await sql<{ allowed: boolean }>`
      SELECT crove_sign.can_read_sign_file(${file.id}::uuid) AS allowed
    `.execute(ctx.trx);
    if (!rows[0]?.allowed) {
      throw new DomainError('SIGN_FILE_NOT_FOUND', 404, 'Source file not found');
    }
  }
  if (file.source !== 'sign_document') {
    throw new DomainError('SIGN_INVALID_SOURCE_FILE', 422, 'Source file must have source sign_document');
  }
  if (file.content_type !== 'application/pdf') {
    throw new DomainError('SIGN_INVALID_FILE_TYPE', 422, 'Source file must be application/pdf');
  }
  if (!file.generation) {
    throw new DomainError('SIGN_INVALID_SOURCE_FILE', 422, 'Source file is missing storage generation');
  }
  return {
    id: file.id,
    storage_key: file.storage_key,
    generation: file.generation,
    sha256: file.sha256,
  };
}

export const zSignInspectPageDimensions = z
  .array(
    z.strictObject({
      page: z.number().int().min(1).max(SIGN_MAX_PAGES),
      widthPt: z.number().positive(),
      heightPt: z.number().positive(),
      rotation: z.number().int().default(0),
    }),
  )
  .min(1)
  .max(SIGN_MAX_PAGES);

export function parsePageDimensions(raw: unknown): Array<{ page: number; widthPt: number; heightPt: number; rotation: number }> | null {
  const schema = z.array(zSignEnvelopePageDimension).min(1).max(SIGN_MAX_PAGES);
  if (Array.isArray(raw)) {
    const parsed = schema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }
  if (typeof raw === 'string') {
    try {
      const json = JSON.parse(raw) as unknown;
      const parsed = schema.safeParse(json);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
  return null;
}

export const zSignInspectDetectedTags = z.array(zSignDetectedTag).max(SIGN_MAX_DETECTED_TAGS).default([]);

export function parseDetectedTags(raw: unknown, pageCount?: number | null): SignDetectedTag[] {
  let candidate: unknown = raw;
  if (typeof raw === 'string') {
    try {
      candidate = JSON.parse(raw) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(candidate) || candidate.length === 0) return [];
  const out: SignDetectedTag[] = [];
  for (const entry of candidate) {
    if (out.length >= SIGN_MAX_DETECTED_TAGS) break;
    const parsed = zSignDetectedTag.safeParse(entry);
    if (!parsed.success) continue;
    if (typeof pageCount === 'number' && parsed.data.pageNumber > pageCount) continue;
    out.push(parsed.data);
  }
  return out;
}

const SHARED_SUMMARY_CONTROL_RE = /\p{Cf}+/gu;

function cleanSummaryText(raw: string, max: number, singleLine: boolean): string {
  const base = raw
    .replace(SHARED_SUMMARY_CONTROL_RE, '')
    .replace(/(?![\t\n\r])\p{Cc}/gu, ' ')
    .replace(/[\u2013\u2014]/g, '-');
  const collapsed = singleLine ? base.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ') : base;
  const trimmed = collapsed.trim();
  if (trimmed.length <= max) return trimmed;
  return Array.from(trimmed).slice(0, max).join('').trimEnd();
}

export function sanitizeSharedSummaryForWrite(
  raw: SignSharedSummary | null | undefined,
  pageCount: number | null,
): SignSharedSummary | null {
  if (!raw) return null;
  const summaryTextRaw = typeof raw.summaryText === 'string' ? cleanSummaryText(raw.summaryText, SIGN_SHARED_SUMMARY_MAX_CHARS, false) : '';
  const summaryText = summaryTextRaw.length > 0 ? summaryTextRaw : null;

  const keyTerms: SignSharedKeyTerm[] = [];
  for (const item of raw.keyTerms.slice(0, SIGN_SHARED_KEY_TERMS_MAX)) {
    const label = cleanSummaryText(item.label, 160, true);
    const value = cleanSummaryText(item.value, 600, true);
    if (!label || !value) continue;
    const pageNumber = item.pageNumber ?? null;
    if (pageNumber !== null) {
      if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > SIGN_MAX_PAGES) {
        throw new DomainError('SIGN_FIELD_OUT_OF_BOUNDS', 422, 'Summary key term pageNumber must stay in 1..200');
      }
      if (pageCount !== null && pageNumber > pageCount) {
        throw new DomainError(
          'SIGN_FIELD_OUT_OF_BOUNDS',
          422,
          `Summary key term pageNumber ${pageNumber} exceeds document page count ${pageCount}`,
        );
      }
    }
    const quoteRaw = typeof item.quoteExcerpt === 'string' ? cleanSummaryText(item.quoteExcerpt, 1000, false) : '';
    keyTerms.push({
      label,
      value,
      pageNumber,
      quoteExcerpt: quoteRaw.length > 0 ? quoteRaw : null,
    });
  }

  if (summaryText === null && keyTerms.length === 0) {
    return null;
  }
  return { summaryText, keyTerms };
}

export function parseSharedSummary(raw: unknown, pageCount?: number | null): SignSharedSummary | null {
  if (raw === null || raw === undefined) return null;
  let candidate: unknown = raw;
  if (typeof raw === 'string') {
    try {
      candidate = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  const parsed = zSignSharedSummary.safeParse(candidate);
  if (!parsed.success) return null;
  const summaryTextRaw = parsed.data.summaryText
    ? cleanSummaryText(parsed.data.summaryText, SIGN_SHARED_SUMMARY_MAX_CHARS, false)
    : '';
  const summaryText = summaryTextRaw.length > 0 ? summaryTextRaw : null;
  const keyTerms: SignSharedKeyTerm[] = [];
  for (const item of parsed.data.keyTerms.slice(0, SIGN_SHARED_KEY_TERMS_MAX)) {
    const label = cleanSummaryText(item.label, 160, true);
    const value = cleanSummaryText(item.value, 600, true);
    if (!label || !value) continue;
    let pageNumber = item.pageNumber ?? null;
    if (pageNumber !== null && typeof pageCount === 'number' && pageCount >= 1 && pageNumber > pageCount) {
      pageNumber = null;
    }
    const quoteRaw = item.quoteExcerpt ? cleanSummaryText(item.quoteExcerpt, 1000, false) : '';
    keyTerms.push({
      label,
      value,
      pageNumber,
      quoteExcerpt: quoteRaw.length > 0 ? quoteRaw : null,
    });
  }
  if (summaryText === null && keyTerms.length === 0) return null;
  return { summaryText, keyTerms };
}

export function parseFieldOptions(raw: unknown): string[] | null {
  let candidate: unknown = raw;
  if (candidate === null || candidate === undefined) return null;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      return null;
    }
  }
  const parsed = zSignFieldOptions.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function serializeFieldOptionsForType(
  fieldType: string,
  options: readonly string[] | null | undefined,
): string | null {
  const isChoice = fieldType === 'dropdown' || fieldType === 'radio';
  if (!isChoice) {
    if (options !== undefined && options !== null) {
      throw new DomainError('SIGN_INVALID_FIELD', 422, 'Field options are only supported on dropdown and radio fields');
    }
    return null;
  }
  const parsed = zSignFieldOptions.safeParse(options);
  if (!parsed.success) {
    throw new DomainError(
      'SIGN_INVALID_FIELD',
      422,
      parsed.error.issues[0]?.message ?? 'Dropdown and radio fields require between 1 and 50 unique options',
    );
  }
  return JSON.stringify(parsed.data);
}

export async function sendDraftEnvelope(
  ctx: CommandContext,
  input: {
    envelope: {
      id: string;
      title: string;
      routing_mode: string;
      inspect_status: string;
      page_count: number | null;
      expires_at: Date | string | null;
      source_sha256: string;
      version: number;
    };
    signers: ReadonlyArray<{
      id: string;
      routing_order: number;
      signer_role: string;
      role_label: string;
      email: string | null;
      delivery_mode: string;
      created_at: Date | string;
    }>;
    fields: ReadonlyArray<{
      id: string;
      signer_id: string;
      field_type: string;
      page_number: number;
    }>;
    userId: string;
  },
): Promise<{
  envelopeId: string;
  status: 'sent';
  version: number;
  links: IssuedSigningLink[];
}> {
  const { envelope: row, signers, fields, userId } = input;
  if (row.inspect_status !== 'passed' || row.page_count === null) {
    throw new DomainError('SIGN_DOCUMENT_NOT_INSPECTED', 409, 'Document must pass PDF inspection before sending');
  }
  if (row.expires_at !== null && new Date(row.expires_at).getTime() <= ctx.now.getTime()) {
    throw new DomainError('SIGN_ENVELOPE_EXPIRED', 409, 'Envelope expiry timestamp is already in the past');
  }

  const activeRoleSigners = signers.filter((s) => s.signer_role !== 'cc');
  if (activeRoleSigners.length === 0) {
    throw new DomainError('SIGN_NO_SIGNERS', 409, 'Envelope requires at least one signer or approver before sending');
  }

  const sigCountBySigner = new Map<string, number>();
  for (const f of fields) {
    if (f.page_number > row.page_count) {
      throw new DomainError(
        'SIGN_FIELD_OUT_OF_BOUNDS',
        409,
        `Field ${f.id} references page ${f.page_number}, exceeding document page count ${row.page_count}`,
      );
    }
    if (f.field_type === 'signature' || f.field_type === 'stamp') {
      sigCountBySigner.set(f.signer_id, (sigCountBySigner.get(f.signer_id) ?? 0) + 1);
    }
  }
  for (const s of activeRoleSigners) {
    if (s.signer_role === 'signer' && (sigCountBySigner.get(s.id) ?? 0) < 1) {
      throw new DomainError('SIGN_SIGNATURE_FIELD_REQUIRED', 409, `Signer ${s.id} requires at least one signature or stamp field`);
    }
  }

  const sortedActive = [...activeRoleSigners].sort((a, b) => {
    if (a.routing_order !== b.routing_order) return a.routing_order - b.routing_order;
    const timeDiff = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    if (timeDiff !== 0) return timeDiff;
    return a.id.localeCompare(b.id);
  });
  const minOrder = sortedActive[0]!.routing_order;
  const dueNow = row.routing_mode === 'parallel' ? sortedActive : sortedActive.filter((s) => s.routing_order === minOrder);
  const dueIds = dueNow.map((s) => s.id);

  const nextVersion = row.version + 1;
  await ctx.trx
    .updateTable('crove_sign.envelope')
    .set({
      status: 'sent',
      sent_at: ctx.now,
      version: nextVersion,
      updated_at: ctx.now,
    })
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', row.id)
    .execute();

  await ctx.trx
    .updateTable('crove_sign.signer')
    .set({ status: 'pending', updated_at: ctx.now })
    .where('org_id', '=', ctx.orgId)
    .where('envelope_id', '=', row.id)
    .where('id', 'in', dueIds)
    .execute();

  const defaultExpiry = new Date(ctx.now.getTime() + SIGN_MAX_LINK_TTL_MS);
  const tokenExpiresAt = row.expires_at
    ? new Date(Math.min(new Date(row.expires_at).getTime(), defaultExpiry.getTime()))
    : defaultExpiry;

  const links: IssuedSigningLink[] = [];
  let orgName: string | null = null;
  for (const signer of dueNow) {
    if (signer.delivery_mode === 'email' && signer.email) {
      if (orgName === null) {
        const tenant = await ctx.trx
          .selectFrom('ludy_kernel.tenant')
          .select('name')
          .where('org_id', '=', ctx.orgId)
          .executeTakeFirstOrThrow();
        orgName = tenant.name;
      }
      await queueSignInviteEmail(ctx, {
        source: SIGN_INVITE_MAIL_SOURCE,
        templateKey: SIGN_INVITE_MAIL_TEMPLATE,
        orgName,
        envelopeId: row.id,
        signerId: signer.id,
        signerRole: signer.signer_role === 'approver' ? 'approver' : 'signer',
        to: signer.email,
        docTitle: row.title,
        roleLabel: signer.role_label,
        expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
      });
      continue;
    }
    const rawToken = generateRawSigningToken();
    const tokenHash = hashSigningToken(rawToken);
    const { rows: minted } = await sql<{ id: string }>`
      SELECT crove_sign.mint_signing_token(
        ${row.id}::uuid,
        ${signer.id}::uuid,
        ${tokenHash},
        ${tokenExpiresAt}::timestamptz
      ) AS id
    `.execute(ctx.trx);
    const tokenId = minted[0]?.id;
    if (!tokenId) throw new Error('mint_signing_token returned no id');
    links.push({
      signerId: signer.id,
      tokenId,
      token: rawToken,
      expiresAt: tokenExpiresAt.toISOString(),
    });
  }

  await appendSigningEvent(ctx.trx, {
    orgId: ctx.orgId,
    envelopeId: row.id,
    eventType: 'envelope_sent',
    actorType: 'user',
    actorId: userId,
    actorLabel: actorLabelOfCtx(ctx),
    documentSha256: row.source_sha256,
    payloadJson: { routingMode: row.routing_mode, activeSignerIds: dueIds },
    occurredAt: ctx.now,
  });
  await enqueueSignWebhookEvent(ctx, {
    envelopeId: row.id,
    eventType: 'sign.envelope.sent',
    status: 'sent',
    occurredAt: ctx.now,
  });
  ctx.audit({ envelopeId: row.id, routingMode: row.routing_mode, mintedCount: links.length });
  return {
    envelopeId: row.id,
    status: 'sent' as const,
    version: nextVersion,
    links,
  };
}
