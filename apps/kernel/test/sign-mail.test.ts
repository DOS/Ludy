// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BlobTooLargeError, type BlobStore } from '@crove/kernel-runtime';
import type { MailTemplateInput } from '../src/mail-queue.ts';
import { signMailTemplates } from '../src/sign-mail.ts';
import { SIGN_COMPLETED_MAIL_TEMPLATE } from '@crove/mod-sign';

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const ORG_ID = '0198f3a2-7b1c-7d2e-8f3a-123456789aaa';
const ENV_ID = '0198f3a2-7b1c-7d2e-8f3a-123456789bbb';

const basePayload = {
  lang: 'vi',
  orgName: 'Cong ty ABC',
  envelopeId: ENV_ID,
  docTitle: 'Hop dong dich vu 2026',
  certificateCode: 'SIG-2026-AB12CD',
  sealedSha256: 'a'.repeat(64),
  completedAtIso: '2026-11-16T08:00:00.000Z',
  signerCount: 2,
};

function makeInput(store: BlobStore, sealedBytes: Uint8Array, certBytes: Uint8Array): MailTemplateInput {
  const sealedHash = sha256Hex(sealedBytes);
  const certHash = sha256Hex(certBytes);
  const sealedKey = `org/${ORG_ID}/sign/sealed-${sealedHash}`;
  const certKey = `org/${ORG_ID}/sign/cert-${certHash}`;

  return {
    messageId: '0198f3a2-7b1c-7d2e-8f3a-123456789abd',
    subject: 'Hoan tat ky: Hop dong dich vu 2026',
    payload: basePayload,
    publicUrl: 'https://app.example.test',
    inboundAddress: null,
    brand: 'Ludy',
    store,
    execute: (async () => ({
      ...basePayload,
      sealedFile: { key: sealedKey, generation: 'content:v1', sha256: sealedHash },
      certificateFile: { key: certKey, generation: 'content:v1', sha256: certHash },
    })) as MailTemplateInput['execute'],
  };
}

describe('sign completed mail template attachments', () => {
  it('attaches both sealed PDF and JSON certificate when under the 18 MB limit', async () => {
    const sealedBytes = Buffer.from('%PDF-1.7\n%small\n', 'utf8');
    const certBytes = Buffer.from('{"certificateCode":"SIG-2026-AB12CD"}', 'utf8');
    const sealedHash = sha256Hex(sealedBytes);
    const certHash = sha256Hex(certBytes);
    const store: BlobStore = {
      async put() {
        return 'content:v1';
      },
      async get(key) {
        return key.includes(sealedHash) ? sealedBytes : certBytes;
      },
      async delete() {},
    };

    const rendered = await signMailTemplates[SIGN_COMPLETED_MAIL_TEMPLATE]!.render(makeInput(store, sealedBytes, certBytes));
    expect(rendered).not.toBeNull();
    expect(rendered?.attachments?.map((a) => [a.filename, a.contentType])).toEqual([
      ['tai-lieu-da-niem-phong.pdf', 'application/pdf'],
      ['chung-thu-kiem-toan.json', 'application/json'],
    ]);
    expect(rendered?.text).not.toContain('18 MB');
    expect(rendered?.html).not.toContain('18 MB');
    expect(certHash).toHaveLength(64);
  });

  it('keeps the audit certificate attached and explains the 18 MB limit when the sealed PDF is too large', async () => {
    const sealedBytes = Buffer.from('%PDF-1.7\n%oversized\n', 'utf8');
    const certBytes = Buffer.from('{"certificateCode":"SIG-2026-AB12CD"}', 'utf8');
    const sealedHash = sha256Hex(sealedBytes);
    const store: BlobStore = {
      async put() {
        return 'content:v1';
      },
      async get(key, _gen, maxBytes) {
        if (key.includes(sealedHash)) {
          throw new BlobTooLargeError(key, maxBytes ?? 18 * 1024 * 1024);
        }
        return certBytes;
      },
      async delete() {},
    };

    const rendered = await signMailTemplates[SIGN_COMPLETED_MAIL_TEMPLATE]!.render(makeInput(store, sealedBytes, certBytes));
    expect(rendered).not.toBeNull();
    expect(rendered?.attachments?.map((a) => a.filename)).toEqual(['chung-thu-kiem-toan.json']);
    expect(rendered?.text).toContain('18 MB');
    expect(rendered?.text).toContain('chung-thu-kiem-toan.json');
    expect(rendered?.html).toContain('18 MB');
    expect(rendered?.html).toContain('chung-thu-kiem-toan.json');
  });
});
