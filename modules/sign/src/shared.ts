// SPDX-License-Identifier: AGPL-3.0-only
// Shared validation, coordinate normalization, file lookup, and envelope send helpers for @crove/mod-sign.
import { sql } from 'kysely';
import { z } from 'zod';
import type { MemberRole } from '@crove/db';
import { kernelManifest } from '@crove/kernel';
import {
  SIGN_MAX_DETECTED_TAGS,
  SIGN_MAX_PAGES,
  SIGN_NORM_SCALE,
  tableWrite,
  zSignDetectedTag,
  zSignEnvelopePageDimension,
  type SignDetectedTag,
} from '@crove/kernel-contract';
import { DomainError, type CommandContext, type QueryContext } from '@crove/kernel-runtime';
import { appendSigningEvent } from './events.ts';
import { signManifest } from './manifest.ts';
import { generateRawSigningToken, hashSigningToken } from './sealing.ts';
import { SIGN_INVITE_MAIL_SOURCE, SIGN_INVITE_MAIL_TEMPLATE, queueSignInviteEmail } from './sign-mail.ts';

export const SIGN_WRITERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
export const SIGN_READERS: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
export const DEFAULT_SIGN_LINK_TTL_HOURS = 30 * 24;

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
  'created_by',
  'created_at',
]);

export const SIGNING_OTP_INVALIDATE_WRITE = tableWrite(signManifest.tables, 'crove_sign', 'signing_otp', ['invalidated_at']);

export const MAIL_MESSAGE_WRITE = tableWrite(kernelManifest.tables, 'crove_kernel', 'mail_message', [
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
    .selectFrom('crove_kernel.file')
    .select(['id', 'source', 'content_type', 'storage_key', 'generation', 'sha256'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', sourceFileId)
    .executeTakeFirst();
  if (!file) throw new DomainError('SIGN_FILE_NOT_FOUND', 404, 'Source file not found');
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
    if (f.field_type === 'signature') {
      sigCountBySigner.set(f.signer_id, (sigCountBySigner.get(f.signer_id) ?? 0) + 1);
    }
  }
  for (const s of activeRoleSigners) {
    if (s.signer_role === 'signer' && (sigCountBySigner.get(s.id) ?? 0) < 1) {
      throw new DomainError('SIGN_SIGNATURE_FIELD_REQUIRED', 409, `Signer ${s.id} requires at least one signature field`);
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

  const defaultExpiry = new Date(ctx.now.getTime() + DEFAULT_SIGN_LINK_TTL_HOURS * 3_600_000);
  const tokenExpiresAt = row.expires_at ? new Date(row.expires_at) : defaultExpiry;

  const links: IssuedSigningLink[] = [];
  let orgName: string | null = null;
  for (const signer of dueNow) {
    if (signer.delivery_mode === 'email' && signer.email) {
      if (orgName === null) {
        const tenant = await ctx.trx
          .selectFrom('crove_kernel.tenant')
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
  ctx.audit({ envelopeId: row.id, routingMode: row.routing_mode, mintedCount: links.length });
  return {
    envelopeId: row.id,
    status: 'sent' as const,
    version: nextVersion,
    links,
  };
}
