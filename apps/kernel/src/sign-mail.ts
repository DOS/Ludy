// SPDX-License-Identifier: AGPL-3.0-only
// MailTemplate adapters for Crove eSign Slice 1b outbound mail (ADR-0034, #3324).
// Hydrates short-lived signing links and 6-digit email OTPs in memory at dispatch time via system commands,
// so raw tokens and OTP codes never sit in crove_kernel.mail_message.payload.
import { BlobIntegrityError, BlobTooLargeError, readVerified } from '@ludy/kernel-runtime';
import type { MailAttachment } from '@ludy/mail';
import {
  SIGN_COMPLETED_MAIL_TEMPLATE,
  SIGN_DELEGATED_MAIL_TEMPLATE,
  SIGN_DIRECT_OTP_MAIL_TEMPLATE,
  SIGN_INVITE_MAIL_TEMPLATE,
  SIGN_OTP_MAIL_TEMPLATE,
  SIGN_REMIND_MAIL_TEMPLATE,
  renderSignCompletedMail,
  renderSignDelegatedMail,
  renderSignDirectOtpMail,
  renderSignInviteMail,
  renderSignOtpMail,
  zSignCompletedMailPayload,
  zSignDelegatedMailPayload,
  zSignDirectOtpMailPayload,
  zSignInviteMailPayload,
  zSignOtpMailPayload,
} from '@ludy/mod-sign';
import type { MailTemplate, MailTemplates } from './mail-queue.ts';
import { opsAlert } from './ops-alert.ts';

const MAX_SIGN_COMPLETED_ATTACHMENT_BYTES = 18 * 1024 * 1024;

function logCompletedBlobReadFailure(kind: 'certificate' | 'sealed', error: unknown): void {
  if (error instanceof BlobIntegrityError) {
    opsAlert('[sign-mail] ALERT evidence integrity: a stored file does not match its recorded sha256', error);
    console.warn(`[sign-mail] ${kind}_blob_unreadable: integrity_mismatch`);
    return;
  }
  if (error instanceof BlobTooLargeError) {
    console.warn(`[sign-mail] ${kind}_blob_unreadable: too_large`);
    return;
  }
  console.warn(`[sign-mail] ${kind}_blob_unreadable: store_error`);
}

const signInviteTemplate = (isReminder: boolean): MailTemplate => ({
  async render(input) {
    if (!input.subject) return null;
    const parsed = zSignInviteMailPayload.parse(input.payload);
    const data = await input.execute<{
      token: string | null;
      signerName: string;
      signerRole?: 'signer' | 'approver';
      message: string | null;
    } | null>('sign.signer.mail_data', {
      envelopeId: parsed.envelopeId,
      signerId: parsed.signerId,
      messageId: input.messageId,
    });
    if (!data?.token) return null;
    const signerRole = data.signerRole ?? parsed.signerRole ?? 'signer';
    const rendered = renderSignInviteMail(parsed, {
      publicUrl: input.publicUrl,
      brand: input.brand,
      token: data.token,
      signerName: data.signerName,
      signerRole,
      message: data.message,
      isReminder,
    });
    let subject = input.subject;
    if (signerRole === 'approver') {
      if (subject.startsWith('Moi ky: ')) {
        subject = `Moi duyet: ${subject.slice('Moi ky: '.length)}`.slice(0, 300);
      } else if (subject.startsWith('Nhac ky: ')) {
        subject = `Nhac duyet: ${subject.slice('Nhac ky: '.length)}`.slice(0, 300);
      }
    }
    return { subject, ...rendered };
  },
});

const signOtpTemplate: MailTemplate = {
  async render(input) {
    if (!input.subject) return null;
    const parsed = zSignOtpMailPayload.parse(input.payload);
    const data = await input.execute<{
      code: string;
      signerName: string;
    } | null>('sign.public.otp_mail_data', {
      signerId: parsed.signerId,
      otpId: parsed.otpId,
    });
    if (!data) return null;
    const rendered = renderSignOtpMail(parsed, {
      brand: input.brand,
      code: data.code,
      signerName: data.signerName,
    });
    return { subject: input.subject, ...rendered };
  },
};

const signCompletedTemplate: MailTemplate = {
  async render(input) {
    if (!input.subject) return null;
    const parsed = zSignCompletedMailPayload.parse(input.payload);
    const verified = await input.execute<{
      certificateCode: string;
      sealedSha256: string;
      completedAtIso: string;
      sealedFile: { key: string; generation: string; sha256: string } | null;
      certificateFile: { key: string; generation: string; sha256: string } | null;
    } | null>('sign.envelope.completed_mail_data', {
      envelopeId: parsed.envelopeId,
    });
    if (!verified) return null;

    const attachments: MailAttachment[] = [];
    let certAttached = false;
    let sealedAttached = false;
    let pdfOmittedForSize = false;
    let certSize = 0;
    if (input.store) {
      if (verified.certificateFile) {
        try {
          const certBytes = await readVerified(input.store, verified.certificateFile, MAX_SIGN_COMPLETED_ATTACHMENT_BYTES);
          certSize = certBytes.byteLength;
          attachments.push({
            filename: 'chung-thu-kiem-toan.json',
            contentType: 'application/json',
            content: certBytes,
          });
          certAttached = true;
        } catch (error) {
          logCompletedBlobReadFailure('certificate', error);
        }
      }
      if (verified.sealedFile) {
        const remaining = MAX_SIGN_COMPLETED_ATTACHMENT_BYTES - certSize;
        if (remaining <= 0) {
          pdfOmittedForSize = true;
        } else {
          try {
            const sealedBytes = await readVerified(input.store, verified.sealedFile, remaining);
            attachments.unshift({
              filename: 'tai-lieu-da-niem-phong.pdf',
              contentType: 'application/pdf',
              content: sealedBytes,
            });
            sealedAttached = true;
          } catch (error) {
            if (error instanceof BlobTooLargeError) {
              pdfOmittedForSize = true;
            } else {
              logCompletedBlobReadFailure('sealed', error);
            }
          }
        }
      }
    }

    const pdfAttached = sealedAttached ? true : pdfOmittedForSize ? undefined : false;
    const rendered = renderSignCompletedMail(
      {
        ...parsed,
        certificateCode: verified.certificateCode,
        sealedSha256: verified.sealedSha256,
        completedAtIso: verified.completedAtIso,
      },
      {
        publicUrl: input.publicUrl,
        brand: input.brand,
        ...(pdfAttached !== undefined ? { pdfAttached, certAttached } : {}),
      },
    );

    const sizeNotice =
      certSize > 0
        ? 'Luu y: Tep PDF da niem phong vuot qua gioi han dung luong dinh kem email (18 MB) nen khong duoc dinh kem truc tiep. Vui long lien he nguoi gui hoac to chuc gui tai lieu de nhan ban PDF va doi chieu ma SHA-256 voi tep chung thu chung-thu-kiem-toan.json dinh kem.'
        : 'Luu y: Tep PDF da niem phong vuot qua gioi han dung luong dinh kem email (18 MB) nen khong duoc dinh kem truc tiep. Vui long lien he nguoi gui hoac to chuc gui tai lieu de nhan ban PDF va doi chieu ma SHA-256 o tren.';
    const text = pdfOmittedForSize ? `${rendered.text}\n\n${sizeNotice}` : rendered.text;
    let html = rendered.html;
    if (pdfOmittedForSize) {
      const noticeHtml = `<p style="margin:16px 0 0;font-size:13px;line-height:1.5;color:#475569">${sizeNotice}</p>`;
      const injected = rendered.html.replace(/(<\/div>\s*<\/body>)/i, `${noticeHtml}$1`);
      html = injected !== rendered.html ? injected : `${rendered.html}${noticeHtml}`;
    }

    return {
      subject: input.subject,
      text,
      html,
      ...(attachments.length > 0 ? { attachments } : {}),
    };
  },
};

const signDirectOtpTemplate: MailTemplate = {
  async render(input) {
    if (!input.subject) return null;
    const parsed = zSignDirectOtpMailPayload.parse(input.payload);
    const data = await input.execute<{
      code: string;
      docTitle: string;
      expiresAt: string;
    } | null>('sign.direct.otp_mail_data', {
      directLinkId: parsed.directLinkId,
      otpId: parsed.otpId,
    });
    if (!data) return null;
    const rendered = renderSignDirectOtpMail(parsed, {
      brand: input.brand,
      code: data.code,
    });
    return { subject: input.subject, ...rendered };
  },
};

const signDelegatedTemplate: MailTemplate = {
  async render(input) {
    if (!input.subject) return null;
    const parsed = zSignDelegatedMailPayload.parse(input.payload);
    const data = await input.execute<{
      orgSlug: string;
      fromName: string;
      fromEmail: string | null;
      delegateName: string;
      delegateEmail: string;
      reason: string | null;
    } | null>('sign.signer.delegated_mail_data', {
      envelopeId: parsed.envelopeId,
      signerId: parsed.signerId,
    });
    if (!data) return null;
    const rendered = renderSignDelegatedMail(parsed, {
      publicUrl: input.publicUrl,
      brand: input.brand,
      orgSlug: data.orgSlug,
      fromName: data.fromName,
      fromEmail: data.fromEmail,
      delegateName: data.delegateName,
      delegateEmail: data.delegateEmail,
      reason: data.reason,
    });
    return { subject: input.subject, ...rendered };
  },
};

export const signMailTemplates: MailTemplates = {
  [SIGN_INVITE_MAIL_TEMPLATE]: signInviteTemplate(false),
  [SIGN_REMIND_MAIL_TEMPLATE]: signInviteTemplate(true),
  [SIGN_OTP_MAIL_TEMPLATE]: signOtpTemplate,
  [SIGN_DIRECT_OTP_MAIL_TEMPLATE]: signDirectOtpTemplate,
  [SIGN_COMPLETED_MAIL_TEMPLATE]: signCompletedTemplate,
  [SIGN_DELEGATED_MAIL_TEMPLATE]: signDelegatedTemplate,
};
