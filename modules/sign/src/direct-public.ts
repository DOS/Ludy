// SPDX-License-Identifier: AGPL-3.0-only
// System worker command backing ADR-0034 mail_data hydration for Crove eSign Slice 2a A1 (#3551).
// Public unauthenticated HTTP mutations on /api/sign/direct/* run via runtime.orgless() + crove_sign.public_direct_*
// SECURITY DEFINER SQL procedures (matching #3432) because crove_app is blocked from calling crove_kernel.enter_system_context.
import { sql } from 'kysely';
import { z } from 'zod';
import { tableWrite, zId } from '@ludy/kernel-contract';
import { defineCommand } from '@ludy/kernel-runtime';
import { signManifest } from './manifest.ts';
import { assertSystemCommand } from './shared.ts';

const OTP_TTL_MS = 10 * 60_000;

export const directOtpMailData = defineCommand({
  name: 'sign.direct.otp_mail_data',
  input: z.strictObject({
    directLinkId: zId,
    otpId: zId,
  }),
  risk: 'R2',
  sideEffect: 'internal',
  access: 'system',
  // Returns transient 6-digit OTP code strictly to the worker mail dispatcher; never cache in idempotency_key.
  noIdempotency: true,
  writes: [tableWrite(signManifest.tables, 'crove_sign', 'signing_otp', ['otp_sha256', 'expires_at'])],
  handler: async (ctx, input): Promise<{ code: string; docTitle: string; expiresAt: string } | null> => {
    assertSystemCommand(ctx);
    const minExp = new Date(Math.max(ctx.now.getTime(), Date.now()) + OTP_TTL_MS);

    const { rows } = await sql<{
      data: {
        otpId: string;
        directLinkId: string;
        templateId: string;
        email: string;
        title: string;
        code: string;
        expiresAt: string;
      } | null;
    }>`
      SELECT crove_sign.public_direct_otp_issue(
        ${input.otpId}::uuid,
        ${minExp}::timestamptz,
        ${ctx.now}::timestamptz
      ) AS data
    `.execute(ctx.trx);

    const data = rows[0]?.data ?? null;
    if (!data || data.directLinkId !== input.directLinkId) {
      return null;
    }
    ctx.audit({ templateId: data.templateId, directLinkId: data.directLinkId, otpId: data.otpId });
    return {
      code: data.code,
      docTitle: data.title,
      expiresAt: data.expiresAt,
    };
  },
});

export const signDirectPublicCommands = [directOtpMailData] as const;
