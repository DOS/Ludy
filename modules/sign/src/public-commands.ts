// SPDX-License-Identifier: AGPL-3.0-only
// System worker commands backing ADR-0034 mail_data hydration and edge normalization helpers for Crove eSign Slice 1b (#3324).
// Public unauthenticated HTTP mutations run via runtime.orgless() + crove_sign.public_* SECURITY DEFINER SQL procedures
// because crove_app is deliberately blocked from calling crove_kernel.enter_system_context.
import { sql } from 'kysely';
import { z } from 'zod';
import { tableWrite, zId, type SignPageDimension } from '@crove/kernel-contract';
import { DomainError, defineCommand, type CommandContext } from '@crove/kernel-runtime';
import { signManifest } from './manifest.ts';
import { generateRawSigningToken, hashSigningToken } from './sealing.ts';

const OTP_TTL_MS = 10 * 60_000;
const DEFAULT_LINK_TTL_HOURS = 30 * 24;

function assertSystem(ctx: CommandContext): void {
  if (ctx.actor.type !== 'system') {
    throw new DomainError('FORBIDDEN', 403, 'Only system workers can run this action');
  }
}

function stripControlChars(value: string): string {
  let out = '';
  let inSpaceRun = false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      if (!inSpaceRun) {
        out += ' ';
        inSpaceRun = true;
      }
    } else {
      out += value[i];
      inSpaceRun = false;
    }
  }
  return out.trim();
}

export function cleanUserAgent(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = stripControlChars(value);
  return cleaned.length > 0 ? cleaned.slice(0, 500) : null;
}

export function normalizePageDimensions(raw: unknown): SignPageDimension[] {
  if (!Array.isArray(raw)) return [];
  const out: SignPageDimension[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as Record<string, unknown>;
    const pageNumber =
      typeof obj.pageNumber === 'number'
        ? obj.pageNumber
        : typeof obj.page === 'number'
          ? obj.page
          : Number(obj.pageNumber ?? obj.page ?? 0);
    const widthPt = Number(obj.widthPt ?? 0);
    const heightPt = Number(obj.heightPt ?? 0);
    if (
      Number.isInteger(pageNumber) &&
      pageNumber >= 1 &&
      Number.isFinite(widthPt) &&
      widthPt > 0 &&
      Number.isFinite(heightPt) &&
      heightPt > 0
    ) {
      out.push({ pageNumber, widthPt, heightPt });
    }
  }
  return out;
}

export const publicOtpMailData = defineCommand({
  name: 'sign.public.otp_mail_data',
  input: z.strictObject({
    signerId: zId,
    otpId: zId,
  }),
  risk: 'R2',
  sideEffect: 'internal',
  access: 'system',
  writes: [tableWrite(signManifest.tables, 'crove_sign', 'signing_otp', ['otp_sha256', 'expires_at'])],
  handler: async (ctx, input): Promise<{ code: string; signerName: string; docTitle: string; expiresAt: string } | null> => {
    assertSystem(ctx);
    const minExp = new Date(Math.max(ctx.now.getTime(), Date.now()) + OTP_TTL_MS);

    const { rows } = await sql<{
      data: {
        otpId: string;
        signerId: string;
        envelopeId: string;
        signerName: string;
        title: string;
        code: string;
        expiresAt: string;
      } | null;
    }>`
      SELECT crove_sign.public_otp_issue(
        ${input.otpId}::uuid,
        ${minExp}::timestamptz,
        ${ctx.now}::timestamptz
      ) AS data
    `.execute(ctx.trx);

    const data = rows[0]?.data ?? null;
    if (!data || data.signerId !== input.signerId) {
      return null;
    }
    ctx.audit({ envelopeId: data.envelopeId, signerId: data.signerId, otpId: data.otpId });
    return {
      code: data.code,
      signerName: data.signerName,
      docTitle: data.title,
      expiresAt: data.expiresAt,
    };
  },
});

export const signerMailData = defineCommand({
  name: 'sign.signer.mail_data',
  input: z.strictObject({
    envelopeId: zId,
    signerId: zId,
    messageId: zId.optional(),
  }),
  risk: 'R2',
  sideEffect: 'internal',
  access: 'system',
  writes: [
    tableWrite(signManifest.tables, 'crove_sign', 'signing_token', ['org_id', 'envelope_id', 'signer_id', 'token_sha256', 'expires_at', 'revoked_at', 'revoked_by', 'created_by', 'created_at']),
    tableWrite(signManifest.tables, 'crove_sign', 'signing_otp', ['invalidated_at']),
  ],
  handler: async (
    ctx,
    input,
  ): Promise<{
    token: string | null;
    signerName: string;
    signerRole: 'signer' | 'approver';
    message: string | null;
    expiresAt: string;
  } | null> => {
    assertSystem(ctx);
    if (input.messageId) {
      const defaultExpiry = new Date(Math.max(ctx.now.getTime(), Date.now()) + DEFAULT_LINK_TTL_HOURS * 3_600_000);
      const { rows } = await sql<{
        data: {
          tokenId: string;
          token: string;
          signerName: string;
          message: string | null;
          expiresAt: string;
          minted: boolean;
        } | null;
      }>`
        SELECT crove_sign.public_mail_token_issue(
          ${input.envelopeId}::uuid,
          ${input.signerId}::uuid,
          ${input.messageId}::uuid,
          ${defaultExpiry}::timestamptz,
          ${ctx.now}::timestamptz
        ) AS data
      `.execute(ctx.trx);

      const data = rows[0]?.data ?? null;
      if (!data) {
        return null;
      }
      const signerRow = await ctx.trx
        .selectFrom('crove_sign.signer')
        .select(['signer_role'])
        .where('org_id', '=', ctx.orgId)
        .where('envelope_id', '=', input.envelopeId)
        .where('id', '=', input.signerId)
        .executeTakeFirst();
      ctx.audit({
        envelopeId: input.envelopeId,
        signerId: input.signerId,
        tokenId: data.tokenId,
        idempotent: !data.minted,
      });
      return {
        token: data.token,
        signerName: data.signerName,
        signerRole: signerRow?.signer_role === 'approver' ? 'approver' : 'signer',
        message: data.message,
        expiresAt: data.expiresAt,
      };
    }

    const envelope = await ctx.trx
      .selectFrom('crove_sign.envelope')
      .select(['id', 'status', 'message', 'expires_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.envelopeId)
      .forShare()
      .executeTakeFirst();
    if (!envelope || (envelope.status !== 'sent' && envelope.status !== 'in_progress')) {
      return null;
    }
    if (envelope.expires_at !== null && new Date(envelope.expires_at).getTime() <= ctx.now.getTime()) {
      return null;
    }

    const signer = await ctx.trx
      .selectFrom('crove_sign.signer')
      .select(['id', 'name', 'signer_role', 'status', 'delivery_mode', 'email'])
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', envelope.id)
      .where('id', '=', input.signerId)
      .forUpdate()
      .executeTakeFirst();
    if (
      !signer ||
      signer.signer_role === 'cc' ||
      (signer.status !== 'pending' && signer.status !== 'viewed') ||
      signer.delivery_mode !== 'email' ||
      !signer.email
    ) {
      return null;
    }

    const defaultExpiry = new Date(Math.max(ctx.now.getTime(), Date.now()) + DEFAULT_LINK_TTL_HOURS * 3_600_000);
    const envExp = envelope.expires_at ? new Date(envelope.expires_at) : null;
    const tokenExpiresAt = envExp && envExp.getTime() > Date.now() ? envExp : defaultExpiry;

    const rawToken = generateRawSigningToken();
    const tokenHash = hashSigningToken(rawToken);
    const { rows } = await sql<{ id: string }>`
      SELECT crove_sign.mint_signing_token(
        ${envelope.id}::uuid,
        ${signer.id}::uuid,
        ${tokenHash},
        ${tokenExpiresAt}::timestamptz
      ) AS id
    `.execute(ctx.trx);

    if (!rows[0]?.id) {
      return null;
    }
    ctx.audit({ envelopeId: envelope.id, signerId: signer.id, tokenId: rows[0].id });
    return {
      token: rawToken,
      signerName: signer.name,
      signerRole: signer.signer_role === 'approver' ? 'approver' : 'signer',
      message: envelope.message,
      expiresAt: tokenExpiresAt.toISOString(),
    };
  },
});

export interface SignCompletedMailFileRef {
  key: string;
  generation: string;
  sha256: string;
}

export const envelopeCompletedMailData = defineCommand({
  name: 'sign.envelope.completed_mail_data',
  input: z.strictObject({
    envelopeId: zId,
  }),
  risk: 'R0',
  sideEffect: 'none',
  access: 'system',
  handler: async (
    ctx,
    input,
  ): Promise<{
    certificateCode: string;
    sealedSha256: string;
    completedAtIso: string;
    sealedFile: SignCompletedMailFileRef | null;
    certificateFile: SignCompletedMailFileRef | null;
  } | null> => {
    assertSystem(ctx);
    const envelope = await ctx.trx
      .selectFrom('crove_sign.envelope')
      .select([
        'status',
        'seal_status',
        'certificate_code',
        'sealed_sha256',
        'sealed_storage_key',
        'sealed_generation',
        'certificate_storage_key',
        'certificate_generation',
        'certificate_sha256',
        'completed_at',
      ])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.envelopeId)
      .executeTakeFirst();

    if (
      !envelope ||
      envelope.status !== 'completed' ||
      envelope.seal_status !== 'sealed' ||
      !envelope.certificate_code ||
      !envelope.sealed_sha256 ||
      !envelope.completed_at
    ) {
      return null;
    }
    const sealedFile =
      envelope.sealed_storage_key && envelope.sealed_generation
        ? {
            key: envelope.sealed_storage_key,
            generation: envelope.sealed_generation,
            sha256: envelope.sealed_sha256,
          }
        : null;
    const certificateFile =
      envelope.certificate_storage_key && envelope.certificate_generation && envelope.certificate_sha256
        ? {
            key: envelope.certificate_storage_key,
            generation: envelope.certificate_generation,
            sha256: envelope.certificate_sha256,
          }
        : null;
    return {
      certificateCode: envelope.certificate_code,
      sealedSha256: envelope.sealed_sha256,
      completedAtIso: new Date(envelope.completed_at).toISOString(),
      sealedFile,
      certificateFile,
    };
  },
});

export const signerDelegatedMailData = defineCommand({
  name: 'sign.signer.delegated_mail_data',
  input: z.strictObject({
    envelopeId: zId,
    signerId: zId,
  }),
  risk: 'R0',
  sideEffect: 'none',
  access: 'system',
  handler: async (
    ctx,
    input,
  ): Promise<{
    orgSlug: string;
    fromName: string;
    fromEmail: string | null;
    delegateName: string;
    delegateEmail: string;
    reason: string | null;
  } | null> => {
    assertSystem(ctx);
    const [tenant, signer] = await Promise.all([
      ctx.trx
        .selectFrom('crove_kernel.tenant')
        .select(['slug'])
        .where('org_id', '=', ctx.orgId)
        .executeTakeFirst(),
      ctx.trx
        .selectFrom('crove_sign.signer')
        .select(['name', 'email', 'delegated_from_name', 'delegated_from_email', 'delegation_reason'])
        .where('org_id', '=', ctx.orgId)
        .where('envelope_id', '=', input.envelopeId)
        .where('id', '=', input.signerId)
        .executeTakeFirst(),
    ]);
    if (!tenant || !signer || !signer.delegated_from_name || !signer.email) {
      return null;
    }
    return {
      orgSlug: tenant.slug,
      fromName: signer.delegated_from_name,
      fromEmail: signer.delegated_from_email,
      delegateName: signer.name,
      delegateEmail: signer.email,
      reason: signer.delegation_reason,
    };
  },
});

export const signPublicCommands = [
  publicOtpMailData,
  signerMailData,
  signerDelegatedMailData,
  envelopeCompletedMailData,
] as const;
