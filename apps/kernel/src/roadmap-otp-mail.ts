// SPDX-License-Identifier: AGPL-3.0-only
// MailTemplate adapter for Projects Public Roadmap 6-digit email OTP verification (#4399, ADR-0034, ADR-0057).
// Mints the 6-digit code inside `projects.roadmap.otp_mail_data` at send time encrypted under an ephemeral worker-RAM key
// so plaintext OTPs never sit in mail_message.payload or cross Runtime command outputs.
import { zRoadmapOtpMailPayload } from '@ludy/kernel-contract';
import {
  generateEphemeralOtpWrapKey,
  openEphemeralOtpCode,
  renderRoadmapOtpMail,
} from '@ludy/mod-projects';
import type { MailTemplate } from './mail-queue.ts';

export const roadmapOtpMailTemplate: MailTemplate = {
  async render(input) {
    if (!input.subject) return null;
    const parsed = zRoadmapOtpMailPayload.parse(input.payload);
    const wrapKey = generateEphemeralOtpWrapKey();
    const data = await input.execute<{ sealedCode: string; boardTitle: string; expiresAt: string } | null>(
      'projects.roadmap.otp_mail_data',
      { otpId: parsed.otpId, wrapKey },
    );
    if (!data) return null;
    const code = openEphemeralOtpCode(data.sealedCode, wrapKey, `${parsed.boardId}:${parsed.otpId}`);
    const rendered = renderRoadmapOtpMail(parsed, {
      brand: input.brand,
      code,
    });
    return { subject: input.subject, ...rendered };
  },
};
