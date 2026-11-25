// SPDX-License-Identifier: AGPL-3.0-only
// Pure Node unit tests (zero React imports) for eSign Zalo OA Engage composer helpers (#4720).
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hasNamePlaceholder } from '@ludy/kernel-contract';
import {
  SIGN_ZALO_DRAFT_MAX,
  buildSignZaloDraft,
  buildSignZaloPreviewDraft,
  canOfferSignZaloHandoff,
  getEligibleSignZaloSigners,
  isConfidentialSignSourceKind,
  zaloDirectThreadsOf,
} from '../src/lib/sign-zalo-handoff.ts';

const activeSigner = { id: 's1', signerRole: 'signer', status: 'pending' };
const activeApprover = { id: 's2', signerRole: 'approver', status: 'viewed' };
const ccSigner = { id: 's3', signerRole: 'cc', status: 'pending' };
const waitingSigner = { id: 's4', signerRole: 'signer', status: 'waiting' };
const signedSigner = { id: 's5', signerRole: 'signer', status: 'signed' };

describe('sign-zalo-handoff pure helpers (#4720)', () => {
  it('contains zero React or DOM runtime imports so it remains unit-testable in pure Node', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, '../src/lib/sign-zalo-handoff.ts'), 'utf8');
    expect(source).not.toMatch(/from\s+['"]react['"]/);
    expect(source).not.toMatch(/from\s+['"]react-dom['"]/);
  });

  it('strictly excludes confidential hr_contract and meeting_minutes source kinds', () => {
    expect(isConfidentialSignSourceKind('hr_contract')).toBe(true);
    expect(isConfidentialSignSourceKind('meeting_minutes')).toBe(true);
    expect(isConfidentialSignSourceKind('standalone')).toBe(false);
    expect(isConfidentialSignSourceKind('crm_quote')).toBe(false);
    expect(isConfidentialSignSourceKind('crm_order')).toBe(false);
    expect(isConfidentialSignSourceKind('project_acceptance')).toBe(false);

    for (const confidential of ['hr_contract', 'meeting_minutes'] as const) {
      expect(
        canOfferSignZaloHandoff({
          sourceKind: confidential,
          status: 'sent',
          signers: [activeSigner],
          canManageLinks: true,
          socialInstalled: true,
        }),
      ).toBe(false);
    }

    for (const allowedKind of ['standalone', 'crm_quote', 'crm_order', 'project_acceptance'] as const) {
      expect(
        canOfferSignZaloHandoff({
          sourceKind: allowedKind,
          status: 'sent',
          signers: [activeSigner],
          canManageLinks: true,
          socialInstalled: true,
        }),
      ).toBe(true);
    }
  });

  it('enforces envelope status, expiry, permissions, social module flag, and active non-CC signer checks', () => {
    expect(
      canOfferSignZaloHandoff({
        sourceKind: 'standalone',
        status: 'in_progress',
        signers: [ccSigner, waitingSigner, activeApprover],
      }),
    ).toBe(true);
    expect(
      canOfferSignZaloHandoff({
        sourceKind: 'standalone',
        status: 'draft',
        signers: [activeSigner],
      }),
    ).toBe(false);
    expect(
      canOfferSignZaloHandoff({
        sourceKind: 'standalone',
        status: 'completed',
        signers: [signedSigner],
      }),
    ).toBe(false);
    expect(
      canOfferSignZaloHandoff({
        sourceKind: 'standalone',
        status: 'sent',
        signers: [ccSigner, waitingSigner, signedSigner],
      }),
    ).toBe(false);
    expect(
      canOfferSignZaloHandoff({
        sourceKind: 'standalone',
        status: 'sent',
        signers: [activeSigner],
        socialInstalled: false,
      }),
    ).toBe(false);
    expect(
      canOfferSignZaloHandoff({
        sourceKind: 'standalone',
        status: 'sent',
        signers: [activeSigner],
        canManageLinks: false,
      }),
    ).toBe(false);
    expect(
      canOfferSignZaloHandoff({
        sourceKind: 'standalone',
        status: 'sent',
        expiresAt: '2026-11-24T00:00:00.000Z',
        now: Date.parse('2026-11-24T00:00:01.000Z'),
        signers: [activeSigner],
      }),
    ).toBe(false);

    expect(getEligibleSignZaloSigners([ccSigner, waitingSigner, signedSigner, activeSigner, activeApprover])).toEqual([
      activeSigner,
      activeApprover,
    ]);
  });

  it('filters to direct zalo_oa threads, deduplicates, and prioritizes CRM-linked threads then newest activity', () => {
    const result = zaloDirectThreadsOf({
      linkedLists: [
        [
          {
            id: 't-crm-old',
            kind: 'direct',
            channel: { provider: 'zalo_oa', displayName: 'OA Bán hàng' },
            lastMessageAt: '2026-11-20T08:00:00.000Z',
          },
          {
            id: 't-fb',
            kind: 'direct',
            channel: { provider: 'facebook_page', displayName: 'FB Page' },
            lastMessageAt: '2026-11-24T12:00:00.000Z',
          },
          {
            id: 't-comment',
            kind: 'comment_thread',
            channel: { provider: 'zalo_oa', displayName: 'OA Bán hàng' },
            lastMessageAt: '2026-11-24T12:00:00.000Z',
          },
        ],
      ],
      recentDirectList: [
        {
          id: 't-recent',
          kind: 'direct',
          status: 'new',
          channel: { provider: 'zalo_oa', displayName: 'OA Hỗ trợ' },
          lastMessageAt: '2026-11-24T11:00:00.000Z',
          contact: { partyName: 'Công ty Minh Anh', displayName: 'Minh Anh', idTail: '1234' },
        },
        {
          id: 't-crm-old',
          kind: 'direct',
          status: 'pending',
          channel: { provider: 'zalo_oa', displayName: 'OA Bán hàng' },
          lastMessageAt: '2026-11-21T09:00:00.000Z',
          replyWindowUntil: '2026-11-23T09:00:00.000Z',
          contact: { partyName: 'Anh Nam', displayName: 'Nam Zalo', idTail: '5678' },
        },
      ],
    });

    expect(result.map((t) => t.id)).toEqual(['t-crm-old', 't-recent']);
    expect(result[0]).toMatchObject({
      id: 't-crm-old',
      linkedToContact: true,
      contactName: 'Anh Nam',
      lastMessageAt: '2026-11-21T09:00:00.000Z',
      replyWindowUntil: '2026-11-23T09:00:00.000Z',
    });
    expect(result[1]).toMatchObject({
      id: 't-recent',
      linkedToContact: false,
      contactName: 'Công ty Minh Anh',
    });
  });

  it('builds deterministic Vietnamese drafts within Zalo limits, keeps URLs intact, and strips placeholder braces', () => {
    const tokenUrl = `https://app.ludy.vn/-/sign#${'A'.repeat(43)}`;
    const draft = buildSignZaloDraft({
      envelopeTitle: 'Hợp đồng dịch vụ 2026 {tên}',
      signerName: 'Nguyễn Văn {Tên} An\n\u0007',
      signingUrl: tokenUrl,
      requireEmailOtp: true,
      expiresAtText: '30/11/2026 17:00',
    });

    expect(draft.fits).toBe(true);
    expect(draft.max).toBe(SIGN_ZALO_DRAFT_MAX);
    expect(draft.length).toBe(draft.text.length);
    expect(draft.text).toContain('Kính gửi Nguyễn Văn Tên An,');
    expect(draft.text).toContain('Hợp đồng dịch vụ 2026 tên');
    expect(draft.text).toContain(tokenUrl);
    expect(draft.text).toContain('OTP 6 chữ số');
    expect(draft.text).toContain('Hạn ký: 30/11/2026 17:00.');
    expect(hasNamePlaceholder(draft.text)).toBe(false);
    expect(draft.text).not.toMatch(/[\u2013\u2014]/);

    // Never silently slices the signing URL when exceeding max length: marks fits=false instead.
    const oversized = buildSignZaloDraft({
      envelopeTitle: 'Hợp đồng '.repeat(30),
      signerName: 'Nguyễn Văn B',
      signingUrl: tokenUrl,
      max: 120,
    });
    expect(oversized.fits).toBe(false);
    expect(oversized.text).toContain(tokenUrl);

    const missingUrl = buildSignZaloDraft({
      envelopeTitle: 'Hợp đồng',
      signerName: 'Nguyễn Văn B',
      signingUrl: '   ',
    });
    expect(missingUrl.fits).toBe(false);
    expect(missingUrl.text).toBe('');
  });

  it('guards SignZalo preview against worst-case minted signing URL exceeding SIGN_ZALO_DRAFT_MAX (#4729)', () => {
    const placeholder = '[liên kết ký bảo mật sẽ được tạo khi mở Hộp thư]';
    const longWorstCaseUrl = `https://${'a'.repeat(1750)}.example.vn/-/sign#${'X'.repeat(43)}`;
    const preview = buildSignZaloPreviewDraft({
      envelopeTitle: 'Hợp đồng dịch vụ',
      signerName: 'Nguyễn Thị Lan',
      mintedUrl: null,
      placeholderUrl: placeholder,
      worstCaseUrl: longWorstCaseUrl,
      requireEmailOtp: true,
      expiresAtText: '30/11/2026 17:00',
    });

    expect(preview.text).toContain(placeholder);
    expect(preview.text).not.toContain('X'.repeat(43));
    expect(preview.fits).toBe(false);
    expect(preview.length).toBeGreaterThan(SIGN_ZALO_DRAFT_MAX);
    expect(preview.max).toBe(SIGN_ZALO_DRAFT_MAX);

    // When a minted URL already exists, exact minted URL length controls fits and text.
    const shortMintedUrl = `https://app.ludy.vn/-/sign#${'Y'.repeat(43)}`;
    const mintedPreview = buildSignZaloPreviewDraft({
      envelopeTitle: 'Hợp đồng dịch vụ',
      signerName: 'Nguyễn Thị Lan',
      mintedUrl: shortMintedUrl,
      placeholderUrl: placeholder,
      worstCaseUrl: longWorstCaseUrl,
    });
    expect(mintedPreview.fits).toBe(true);
    expect(mintedPreview.text).toContain(shortMintedUrl);
    expect(mintedPreview.length).toBe(mintedPreview.text.length);
  });
});
