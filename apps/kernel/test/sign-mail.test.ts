// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BlobTooLargeError, type BlobStore } from '@ludy/kernel-runtime';
import type { MailTemplateInput } from '../src/mail-queue.ts';
import { configureOpsAlerts, flushOpsAlerts } from '../src/ops-alert.ts';
import { signMailTemplates } from '../src/sign-mail.ts';
import {
  SIGN_COMPLETED_MAIL_TEMPLATE,
  SIGN_DELEGATED_MAIL_TEMPLATE,
  SIGN_INVITE_MAIL_TEMPLATE,
  SIGN_REMIND_MAIL_TEMPLATE,
} from '@ludy/mod-sign';

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

  afterEach(() => {
    configureOpsAlerts(null);
    vi.restoreAllMocks();
  });

  it('alerts without PII via opsAlert and sends fallback notice without throwing on BlobIntegrityError', async () => {
    const sealedBytes = Buffer.from('%PDF-1.7\n%corrupt\n', 'utf8');
    const certBytes = Buffer.from('{"certificateCode":"SIG-2026-AB12CD"}', 'utf8');
    const sealedHash = sha256Hex(sealedBytes);
    const posted: string[] = [];
    configureOpsAlerts({
      target: {
        webhookUrl: 'https://alert.example.test/hook',
        webhookFormat: 'generic',
        telegramChatId: undefined,
        instance: 'sign-mail.test',
      },
      repeatSeconds: 0,
      flushMs: 0,
      post: async (msg) => {
        posted.push(msg.text);
        return { channel: 'webhook', ok: true };
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const store: BlobStore = {
      async put() {
        return 'content:v1';
      },
      async get(key) {
        if (key.includes(sealedHash)) {
          return Buffer.from('corrupted-sealed-bytes', 'utf8');
        }
        return certBytes;
      },
      async delete() {},
    };

    const rendered = await signMailTemplates[SIGN_COMPLETED_MAIL_TEMPLATE]!.render(makeInput(store, sealedBytes, certBytes));
    await flushOpsAlerts();

    expect(rendered).not.toBeNull();
    expect(rendered?.attachments?.map((a) => a.filename)).toEqual(['chung-thu-kiem-toan.json']);
    expect(rendered?.text).toContain('khong the dinh kem trong email nay');
    expect(rendered?.html).toContain('khong the dinh kem trong email nay');
    expect(rendered?.text).not.toContain('18 MB');
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('[sign-mail] ALERT evidence integrity');
    expect(posted[0]).not.toMatch(/Cong ty ABC|Hop dong|org\/|0198f3a2/);
    expect(errLog).toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(' ')).toContain('sealed_blob_unreadable: integrity_mismatch');
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/Cong ty ABC|Hop dong|0198f3a2/);
  });

  it('sends fallback notice without throwing when sealed PDF store read fails with a transient error', async () => {
    const sealedBytes = Buffer.from('%PDF-1.7\n%offline\n', 'utf8');
    const certBytes = Buffer.from('{"certificateCode":"SIG-2026-AB12CD"}', 'utf8');
    const sealedHash = sha256Hex(sealedBytes);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const store: BlobStore = {
      async put() {
        return 'content:v1';
      },
      async get(key) {
        if (key.includes(sealedHash)) {
          throw new Error('storage offline for Hop dong dich vu 2026');
        }
        return certBytes;
      },
      async delete() {},
    };

    const rendered = await signMailTemplates[SIGN_COMPLETED_MAIL_TEMPLATE]!.render(makeInput(store, sealedBytes, certBytes));
    expect(rendered).not.toBeNull();
    expect(rendered?.attachments?.map((a) => a.filename)).toEqual(['chung-thu-kiem-toan.json']);
    expect(rendered?.text).toContain('khong the dinh kem trong email nay');
    const logged = warn.mock.calls.flat().join(' ');
    expect(logged).toContain('sealed_blob_unreadable: store_error');
    expect(logged).not.toContain('Hop dong');
  });

  it('does not claim JSON certificate is attached when only the sealed PDF attaches', async () => {
    const sealedBytes = Buffer.from('%PDF-1.7\n%sealed-ok\n', 'utf8');
    const certBytes = Buffer.from('{"certificateCode":"SIG-2026-AB12CD"}', 'utf8');
    const sealedHash = sha256Hex(sealedBytes);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const store: BlobStore = {
      async put() {
        return 'content:v1';
      },
      async get(key) {
        if (key.includes(sealedHash)) {
          return sealedBytes;
        }
        throw new Error('certificate blob missing');
      },
      async delete() {},
    };

    const rendered = await signMailTemplates[SIGN_COMPLETED_MAIL_TEMPLATE]!.render(makeInput(store, sealedBytes, certBytes));
    expect(rendered).not.toBeNull();
    expect(rendered?.attachments?.map((a) => a.filename)).toEqual(['tai-lieu-da-niem-phong.pdf']);
    expect(rendered?.text).toContain('Ban PDF da niem phong duoc dinh kem trong email nay. Tep chung thu kiem toan dang JSON khong the dinh kem');
    expect(rendered?.text).not.toContain('va chung thu kiem toan dang JSON duoc dinh kem');
    expect(warn.mock.calls.flat().join(' ')).toContain('certificate_blob_unreadable: store_error');

    // Certificate exceeding 18 MB is also logged cleanly without suppressing the sealed PDF attachment.
    warn.mockClear();
    const oversizedCertStore: BlobStore = {
      async put() {
        return 'content:v1';
      },
      async get(key, _gen, maxBytes) {
        if (key.includes(sealedHash)) {
          return sealedBytes;
        }
        throw new BlobTooLargeError(key, maxBytes ?? 18 * 1024 * 1024);
      },
      async delete() {},
    };
    const renderedLargeCert = await signMailTemplates[SIGN_COMPLETED_MAIL_TEMPLATE]!.render(
      makeInput(oversizedCertStore, sealedBytes, certBytes),
    );
    expect(renderedLargeCert?.attachments?.map((a) => a.filename)).toEqual(['tai-lieu-da-niem-phong.pdf']);
    expect(renderedLargeCert?.text).toContain('Tep chung thu kiem toan dang JSON khong the dinh kem');
    expect(warn.mock.calls.flat().join(' ')).toContain('certificate_blob_unreadable: too_large');
  });

  it('renders approver invite and reminder copy and rewrites SQL-queued signer subjects for approvers (#3528)', async () => {
    const signerId = '0198f3a2-7b1c-7d2e-8f3a-123456789ccc';
    const rawToken = 'A'.repeat(43);

    const inviteInput: MailTemplateInput = {
      messageId: '0198f3a2-7b1c-7d2e-8f3a-123456789ccd',
      subject: 'Moi ky: Hop dong dich vu 2026',
      payload: {
        lang: 'vi',
        orgName: 'Cong ty ABC',
        envelopeId: ENV_ID,
        signerId,
        docTitle: 'Hop dong dich vu 2026',
        roleLabel: 'Ke toan truong',
        expiresAt: '2027-02-01T00:00:00.000Z',
      },
      publicUrl: 'https://app.example.test',
      inboundAddress: null,
      brand: 'Ludy',
      execute: (async () => ({
        token: rawToken,
        signerName: 'Le Thi B',
        signerRole: 'approver',
        message: 'Vui long duyet truoc thu 6',
      })) as MailTemplateInput['execute'],
    };

    const invite = await signMailTemplates[SIGN_INVITE_MAIL_TEMPLATE]!.render(inviteInput);
    expect(invite?.subject).toBe('Moi duyet: Hop dong dich vu 2026');
    expect(invite?.text).toContain('xem va phe duyet tai lieu');
    expect(invite?.html).toContain('Xem va phe duyet tai lieu');

    const remind = await signMailTemplates[SIGN_REMIND_MAIL_TEMPLATE]!.render({
      ...inviteInput,
      subject: `Nhac ky: ${'X'.repeat(295)}`,
    });
    expect(remind?.subject).toBe(`Nhac duyet: ${'X'.repeat(288)}`);
    expect(remind?.subject.length).toBe(300);
    expect(remind?.text).toContain('nhac ban phe duyet tai lieu');
  });

  it('hydrates sign.delegated mail data at send time without PII in queued payload (#3819)', async () => {
    const signerId = '0198f3a2-7b1c-7d2e-8f3a-123456789ddd';
    const executedCommands: Array<{ name: string; input: unknown }> = [];

    const delegatedInput: MailTemplateInput = {
      messageId: '0198f3a2-7b1c-7d2e-8f3a-123456789dde',
      subject: 'Uy quyen ky: Hop dong dich vu 2026',
      payload: {
        lang: 'vi',
        orgName: 'Cong ty ABC',
        envelopeId: ENV_ID,
        signerId,
        docTitle: 'Hop dong dich vu 2026',
        roleLabel: 'Giam doc Ben B',
        delegationCount: 1,
      },
      publicUrl: 'https://app.example.test',
      inboundAddress: null,
      brand: 'Ludy',
      execute: (async (name: string, input: unknown) => {
        executedCommands.push({ name, input });
        return {
          orgSlug: 'cong-ty-abc',
          fromName: 'Tran Van Cu',
          fromEmail: 'cu@example.com',
          delegateName: 'Le Thi Moi',
          delegateEmail: 'moi@example.com',
          reason: 'Di cong tac nuoc ngoai',
        };
      }) as MailTemplateInput['execute'],
    };

    const renderedVi = await signMailTemplates[SIGN_DELEGATED_MAIL_TEMPLATE]!.render(delegatedInput);
    expect(executedCommands).toEqual([
      {
        name: 'sign.signer.delegated_mail_data',
        input: { envelopeId: ENV_ID, signerId },
      },
    ]);
    expect(renderedVi).not.toBeNull();
    expect(renderedVi?.text).toContain('Tran Van Cu (cu@example.com)');
    expect(renderedVi?.text).toContain('Le Thi Moi (moi@example.com)');
    expect(renderedVi?.text).toContain('Di cong tac nuoc ngoai');
    expect(renderedVi?.text).toContain(`https://app.example.test/o/cong-ty-abc/sign/envelopes/${ENV_ID}`);
    expect(renderedVi?.html).toContain(`https://app.example.test/o/cong-ty-abc/sign/envelopes/${ENV_ID}`);
    expect(renderedVi?.html).toContain('Le Thi Moi');

    const renderedNoEmailOrReason = await signMailTemplates[SIGN_DELEGATED_MAIL_TEMPLATE]!.render({
      ...delegatedInput,
      payload: { ...delegatedInput.payload, delegationCount: 2 },
      execute: (async () => ({
        orgSlug: 'cong-ty-abc',
        fromName: 'Tran Van Cu',
        fromEmail: null,
        delegateName: 'Le Thi Moi',
        delegateEmail: 'moi@example.com',
        reason: null,
      })) as MailTemplateInput['execute'],
    });
    expect(renderedNoEmailOrReason?.text).toContain('Nguoi uy quyen: Tran Van Cu\n');
    expect(renderedNoEmailOrReason?.text).not.toContain('Ly do uy quyen:');

    const skipped = await signMailTemplates[SIGN_DELEGATED_MAIL_TEMPLATE]!.render({
      ...delegatedInput,
      execute: (async () => null) as MailTemplateInput['execute'],
    });
    expect(skipped).toBeNull();
  });
});
