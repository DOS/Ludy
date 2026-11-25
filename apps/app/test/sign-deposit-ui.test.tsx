// SPDX-License-Identifier: AGPL-3.0-only
// Component rendering & safety checks for Slice 6d VietQR deposit UI (#4723):
//   - SignDepositConfigCard (confidential sourceKind exclusion, frozen snapshot + signer notice display)
//   - SignCeremonyDepositCard (optional post-sign card, EMVCo SVG QR rendering, no-BIN manual fallback, notice status)
//   - BankSignDepositLine (renders credit proposal button & match reason cleanly without auto-posting)
import { readFileSync } from 'node:fs';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { activeLocale, catalog, setActiveLocale } from '../src/i18n/runtime.ts';
import { publicSignApi, PublicSignError } from '../src/lib/sign-api.ts';
import { parsePngDimensions, readPngFileAsDataUrl } from '../src/lib/sign-signature.ts';

const testState = vi.hoisted(() => ({
  qc: null as unknown as QueryClient,
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...rest }: { children?: unknown; to?: string; [k: string]: unknown }) => (
    <a href={typeof to === 'string' ? to : '#'} {...rest}>
      {children as never}
    </a>
  ),
}));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  testState.qc = new QC({ defaultOptions: { queries: { retry: false } } });
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') {
          return (options?: { input?: unknown }) => ({
            queryKey: options?.input === undefined ? path : [...path, options.input],
            queryFn: () => Promise.reject(new Error('not fetched')),
          });
        }
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return {
    orpc: node([]),
    queryClient: testState.qc,
    client: {},
    clientForOrg: () => ({}),
    orglessClient: {},
    getCurrentOrg: () => 'demo',
    errorMessage: (e: unknown) => String(e),
    isStepUpRequired: () => false,
    apiFetch: vi.fn(),
    fetchFile: vi.fn(),
    uploadFiles: vi.fn(),
  };
});

const { SignCeremonyDepositCard, resolveNoticeErrorMessage } = await import(
  '../src/components/sign/sign-ceremony-deposit-card.tsx'
);
const { SignDepositConfigCard, shouldSyncDepositConfigForm, signEnvelopeDetailQueryKey } = await import(
  '../src/components/sign/sign-deposit-config-card.tsx'
);
const {
  SignDepositProfileSettingsCard,
  canRemoveDepositProfileQr,
  didDepositDestinationChange,
  normalizeDepositDestination,
  shouldSyncDepositProfileForm,
} = await import('../src/components/sign/sign-deposit-profile-card.tsx');
const { BankSignDepositLine } = await import('../src/components/bank-sign-deposit-line.tsx');
const { submitCeremonyWithGenerationGuard } = await import('../src/routes/sign-ceremony.tsx');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function wrap(node: React.ReactElement, locale: 'vi' | 'en' = 'vi', qc = testState.qc) {
  const prevLocale = activeLocale();
  setActiveLocale(locale);
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <I18nProvider>{node}</I18nProvider>
      </QueryClientProvider>,
    );
  } finally {
    setActiveLocale(prevLocale);
  }
}

describe('eSign Slice 6d deposit UI components (#4723)', () => {
  it('hides SignDepositConfigCard completely on hr_contract and meeting_minutes envelopes', () => {
    const hrHtml = wrap(
      <SignDepositConfigCard
        slug="demo"
        envelopeId="01900000-0000-7000-8000-000000000010"
        envelopeStatus="draft"
        sourceKind="hr_contract"
        canEditDraft={true}
        deposit={null}
      />,
    );
    const mmHtml = wrap(
      <SignDepositConfigCard
        slug="demo"
        envelopeId="01900000-0000-7000-8000-000000000011"
        envelopeStatus="draft"
        sourceKind="meeting_minutes"
        canEditDraft={true}
        deposit={null}
      />,
    );
    expect(hrHtml).toBe('');
    expect(mmHtml).toBe('');
  });

  it('renders immutable frozen snapshot details and signer proof download on sent/completed envelopes', () => {
    const html = wrap(
      <SignDepositConfigCard
        slug="demo"
        envelopeId="01900000-0000-7000-8000-000000000012"
        envelopeStatus="completed"
        sourceKind="standalone"
        canEditDraft={false}
        deposit={{
          id: '01900000-0000-7000-8000-000000000099',
          orgId: '01900000-0000-7000-8000-000000000001',
          envelopeId: '01900000-0000-7000-8000-000000000012',
          amount: '5000000',
          currency: 'VND',
          memoToken: 'CK-XYZ123',
          dueDays: 3,
          depositProfileId: '01900000-0000-7000-8000-000000000050',
          note: 'Transfer milestone deposit',
          snapshotFrozenAt: '2026-11-24T10:00:00.000Z',
          snapshotBankCode: 'vcb',
          snapshotBankName: 'Vietcombank',
          snapshotAccountNumber: '0123456789',
          snapshotAccountHolder: 'CONG TY TNHH TEST',
          snapshotFinanceBankAccount: '1121',
          snapshotVietqrFileId: null,
          snapshotEmvcoPayload: null,
          signerNoticeAt: '2026-11-24T11:30:00.000Z',
          signerNoticeNote: 'Sent at 11:25 via VCB',
          signerProofFileId: '01900000-0000-7000-8000-000000000077',
          signerProofFilename: 'receipt.png',
          signerProofSha256: 'a'.repeat(64),
          createdBy: '01900000-0000-7000-8000-000000000002',
          updatedBy: '01900000-0000-7000-8000-000000000002',
          createdAt: '2026-11-24T09:00:00.000Z',
          updatedAt: '2026-11-24T11:30:00.000Z',
        }}
        onDownloadFile={vi.fn()}
      />,
      'en',
    );
    expect(html).toContain('CK-XYZ123');
    expect(html).toContain('Vietcombank');
    expect(html).toContain('0123456789');
    expect(html).toContain('₫5,000,000');
    expect(html).not.toContain('₫ VND');
    expect(html).not.toContain('5,000,000 VND');
    expect(html).not.toContain('5.000.000 VND');
    expect(html).toContain('CONG TY TNHH TEST');
    expect(html).toContain('receipt.png');
    expect(html).toContain('Transfer reported');
  });

  it('renders non-blocking post-sign SignCeremonyDepositCard with offline SVG QR or manual transfer instructions', () => {
    const withEmvco = wrap(
      <SignCeremonyDepositCard
        token="raw-public-token-placeholder"
        deposit={{
          amount: '5000000',
          currency: 'VND',
          memoToken: 'CK-QRS456',
          dueDays: 5,
          note: 'Optional advance deposit',
          bankCode: 'vcb',
          bankName: 'Vietcombank',
          accountNumber: '0123456789',
          accountHolder: 'CONG TY TNHH TEST',
          hasQrPng: false,
          emvcoPayload:
            '00020101021238540010A00000072701240006970436011001234567890208QRIBFTTA5303704540750000005802VN62130809CK-QRS4566304ABCD',
          signerNoticeAt: null,
          signerNoticeNote: null,
          signerProofFilename: null,
          signerProofSha256: null,
        }}
      />,
      'en',
    );
    expect(withEmvco).toContain('sign-ceremony-deposit-qr-svg');
    expect(withEmvco).toContain('CK-QRS456');
    expect(withEmvco).toContain('₫5,000,000');
    expect(withEmvco).not.toContain('5.000.000 VND');
    expect(withEmvco).toContain('Non-blocking after signing');

    const manualOnly = wrap(
      <SignCeremonyDepositCard
        token="raw-public-token-placeholder"
        deposit={{
          amount: '2500000',
          currency: 'VND',
          memoToken: 'CK-MAN789',
          dueDays: null,
          note: null,
          bankCode: 'vcb',
          bankName: 'Vietcombank',
          accountNumber: '9876543210',
          accountHolder: 'CONG TY TNHH TEST',
          hasQrPng: false,
          emvcoPayload: null,
          signerNoticeAt: '2026-11-24T12:00:00.000Z',
          signerNoticeNote: 'Transferred online',
          signerProofFilename: 'proof.jpg',
          signerProofSha256: 'b'.repeat(64),
        }}
      />,
      'vi',
    );
    expect(manualOnly).toContain('sign-ceremony-deposit-manual-notice');
    expect(manualOnly).toContain('sign-ceremony-deposit-noticed');
    expect(manualOnly).not.toContain('sign-ceremony-deposit-notice-form');
    expect(manualOnly).toContain('CK-MAN789');
    expect(manualOnly).toMatch(/2\.500\.000[\s\u00a0]₫/);
    expect(manualOnly).not.toContain('2.500.000 VND');
    expect(manualOnly).toContain('proof.jpg');
  });

  it('renders BankSignDepositLine match candidate and credit proposal action cleanly', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const lineId = '01900000-0000-7000-8000-000000000333';
    qc.setQueryData(['bank', 'signDepositMatch', { bankLineId: lineId }], {
      bankLineId: lineId,
      date: '2026-11-24',
      candidates: [
        {
          envelopeId: '01900000-0000-7000-8000-000000000444',
          title: 'Hop dong thiet ke',
          completedAt: '2026-11-24T08:00:00.000Z',
          amount: '5000000',
          currency: 'VND',
          memoToken: 'CK-QRS456',
          financeBankAccount: '1121',
          signerName: 'Nguyen Van A',
          signerNoticeAt: '2026-11-24T09:00:00.000Z',
          reason: 'amount_memo',
          voucherType: 'bank_credit',
          suggestedDebitAccount: '1121',
          suggestedCreditAccount: '131',
        },
      ],
    });

    const html = wrap(
      <BankSignDepositLine
        line={{
          id: lineId,
          date: '2026-11-24',
          description: 'CK-QRS456 dat coc',
          amount: '5000000',
          balance: '10000000',
          reference: 'FT999',
          importId: '01900000-0000-7000-8000-000000000222',
          ambiguous: false,
          state: { status: 'open' },
        }}
        onPrepareProposal={vi.fn()}
      />,
      'en',
      qc,
    );
    expect(html).toContain('bank-sign-deposit-candidate');
    expect(html).toContain('CK-QRS456');
    expect(html).toContain('Prepare credit proposal');
    expect(html).toContain('Signer reported transfer');
  });

  it('renders an inline live status region + unique copy labels on SignCeremonyDepositCard and mounts Toaster at rootRoute', () => {
    const html = wrap(
      <SignCeremonyDepositCard
        token="raw-token"
        deposit={{
          bankCode: 'vcb',
          bankName: 'Vietcombank',
          accountNumber: '0123456789',
          accountHolder: 'CONG TY DEMO',
          amount: '5000000',
          currency: 'VND',
          memoToken: 'CK-A11Y01',
          dueDays: 3,
          note: null,
          hasQrPng: false,
          emvcoPayload: null,
          signerNoticeAt: null,
          signerNoticeNote: null,
          signerProofFilename: null,
          signerProofSha256: null,
        }}
      />,
      'vi',
    );
    expect(html).toContain('data-testid="sign-ceremony-deposit-copy-status"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-label="Sao chép Số tài khoản"');
    expect(html).toContain('aria-label="Sao chép Số tiền"');
    expect(html).toContain('aria-label="Sao chép Nội dung chuyển khoản"');
    expect(html.toLowerCase()).toContain('tabindex="-1"');
    expect(html).toContain('aria-hidden="true"');

    const routerSrc = readFileSync(new URL('../src/router.tsx', import.meta.url), 'utf8');
    const orgLayoutSrc = readFileSync(new URL('../src/routes/org-layout.tsx', import.meta.url), 'utf8');
    expect(routerSrc).toContain('<Toaster');
    expect(orgLayoutSrc).not.toContain('Toaster');
  });

  it('invalidates the exact sign-envelope-detail query key and preserves dirty form state across refetches', () => {
    const envelopeId = '01900000-0000-7000-8000-000000000999';
    expect(signEnvelopeDetailQueryKey(envelopeId)).toEqual(['sign', 'envelope', envelopeId]);
    const detailSrc = readFileSync(new URL('../src/routes/sign-envelope-detail.tsx', import.meta.url), 'utf8');
    expect(detailSrc).toContain("queryKey: ['sign', 'envelope', id]");

    expect(
      shouldSyncDepositConfigForm({ prevEnvelopeId: envelopeId, envelopeId, dirty: true }),
    ).toBe(false);
    expect(
      shouldSyncDepositConfigForm({ prevEnvelopeId: envelopeId, envelopeId, dirty: false }),
    ).toBe(true);
    expect(
      shouldSyncDepositConfigForm({
        prevEnvelopeId: envelopeId,
        envelopeId: '01900000-0000-7000-8000-000000000998',
        dirty: true,
      }),
    ).toBe(true);
  });

  it('translates PublicSignError codes for transfer notices in both Vietnamese and English without raw English leaks', () => {
    const viMsgs = catalog('vi').sign.ceremonyDeposit;
    const enMsgs = catalog('en').sign.ceremonyDeposit;
    const tVi = (key: keyof typeof viMsgs) => viMsgs[key];
    const tEn = (key: keyof typeof enMsgs) => enMsgs[key];

    const cases: Array<[number, string, keyof typeof viMsgs & keyof typeof enMsgs]> = [
      [415, 'UNSUPPORTED_TYPE', 'invalidProofType'],
      [415, 'SIGN_INVALID_SIGNATURE_PNG', 'invalidProofType'],
      [413, 'TOO_LARGE', 'proofTooLarge'],
      [413, 'SIGN_DEPOSIT_PROOF_TOO_LARGE', 'proofTooLarge'],
      [503, 'SIGN_ATTACHMENT_BUSY', 'noticeBusy'],
      [429, 'RATE_LIMITED', 'noticeRateLimited'],
      [409, 'FILE_SOURCE_CONFLICT', 'noticeFileConflict'],
      [403, 'SIGN_CONFIDENTIAL_DEPOSIT_FORBIDDEN', 'noticeConfidentialForbidden'],
      [404, 'NOT_FOUND', 'noticeNotFound'],
      [500, 'UNEXPECTED_RAW_CODE', 'noticeFailed'],
    ];

    for (const [status, code, expectedKey] of cases) {
      const err = new PublicSignError(status, code, 'Raw English server message should never surface in Vietnamese UI');
      expect(resolveNoticeErrorMessage(err, tVi)).toBe(tVi(expectedKey));
      expect(resolveNoticeErrorMessage(err, tVi)).not.toContain('Raw English server message');
      expect(resolveNoticeErrorMessage(err, tEn)).toBe(tEn(expectedKey));
    }
  });

  it('ignores stale ceremony submit success and error callbacks when generation advances', async () => {
    let gen = 1;
    let onSuccessCalled = false;
    let onErrorCalled = false;
    let onSettledCalled = false;

    await submitCeremonyWithGenerationGuard({
      getGeneration: () => gen,
      runSubmit: async () => {
        gen += 1;
        return { ok: true };
      },
      onSuccess: () => {
        onSuccessCalled = true;
      },
      onError: () => {
        onErrorCalled = true;
      },
      onSettled: () => {
        onSettledCalled = true;
      },
    });
    expect(onSuccessCalled).toBe(false);
    expect(onErrorCalled).toBe(false);
    expect(onSettledCalled).toBe(false);

    await submitCeremonyWithGenerationGuard({
      getGeneration: () => gen,
      runSubmit: async () => {
        gen += 1;
        throw new Error('stale failure');
      },
      onSuccess: () => {
        onSuccessCalled = true;
      },
      onError: () => {
        onErrorCalled = true;
      },
      onSettled: () => {
        onSettledCalled = true;
      },
    });
    expect(onSuccessCalled).toBe(false);
    expect(onErrorCalled).toBe(false);
    expect(onSettledCalled).toBe(false);

    await submitCeremonyWithGenerationGuard({
      getGeneration: () => gen,
      runSubmit: async () => ({ ok: true }),
      onSuccess: () => {
        onSuccessCalled = true;
      },
      onError: () => {
        onErrorCalled = true;
      },
      onSettled: () => {
        onSettledCalled = true;
      },
    });
    expect(onSuccessCalled).toBe(true);
    expect(onErrorCalled).toBe(false);
    expect(onSettledCalled).toBe(true);
  });

  it('hardens SignDepositProfileSettingsCard (maxLength 31, non-tabbable file input, QR remove state, dirty/slug sync) and avoids duplicate VND in readonly SignDepositConfigCard', () => {
    expect(shouldSyncDepositProfileForm({ prevSlug: 'org-a', slug: 'org-a', dirty: true })).toBe(false);
    expect(shouldSyncDepositProfileForm({ prevSlug: 'org-a', slug: 'org-a', dirty: false })).toBe(true);
    expect(shouldSyncDepositProfileForm({ prevSlug: 'org-a', slug: 'org-b', dirty: true })).toBe(true);

    expect(canRemoveDepositProfileQr({ savedFileId: 'f1', clearStoredQr: false, pendingPngBase64: null })).toBe(true);
    expect(canRemoveDepositProfileQr({ savedFileId: 'f1', clearStoredQr: true, pendingPngBase64: null })).toBe(false);
    expect(canRemoveDepositProfileQr({ savedFileId: null, clearStoredQr: true, pendingPngBase64: 'b64' })).toBe(true);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(['sign', 'deposit-profile', 'demo'], {
      canEdit: true,
      profile: {
        id: '01900000-0000-7000-8000-000000000050',
        orgId: '01900000-0000-7000-8000-000000000001',
        bankCode: 'VCB',
        bankName: 'Vietcombank',
        accountNumber: '0123456789',
        accountHolder: 'CONG TY TNHH TEST',
        financeBankAccount: '1121.VCB',
        vietqrFileId: '01900000-0000-7000-8000-000000000088',
        hasQrPng: true,
        isDefault: true,
        createdAt: '2026-11-24T09:00:00.000Z',
        updatedAt: '2026-11-24T09:00:00.000Z',
      },
    });
    const profileHtml = wrap(<SignDepositProfileSettingsCard slug="demo" />, 'vi', qc);
    expect(profileHtml.toLowerCase()).toContain('maxlength="31"');
    expect(profileHtml.toLowerCase()).toContain('tabindex="-1"');
    expect(profileHtml).toContain('aria-hidden="true"');
    expect(profileHtml).toContain('data-testid="sign-deposit-qr-clear-btn"');

    const readonlyDraftHtml = wrap(
      <SignDepositConfigCard
        slug="demo"
        envelopeId="01900000-0000-7000-8000-000000000013"
        envelopeStatus="draft"
        sourceKind="standalone"
        canEditDraft={false}
        deposit={{
          id: '01900000-0000-7000-8000-000000000100',
          orgId: '01900000-0000-7000-8000-000000000001',
          envelopeId: '01900000-0000-7000-8000-000000000013',
          amount: '5000000',
          currency: 'VND',
          memoToken: 'CK-DRAFT1',
          dueDays: null,
          depositProfileId: '01900000-0000-7000-8000-000000000050',
          note: null,
          snapshotFrozenAt: null,
          snapshotBankCode: null,
          snapshotBankName: null,
          snapshotAccountNumber: null,
          snapshotAccountHolder: null,
          snapshotFinanceBankAccount: null,
          snapshotVietqrFileId: null,
          snapshotEmvcoPayload: null,
          signerNoticeAt: null,
          signerNoticeNote: null,
          signerProofFileId: null,
          signerProofFilename: null,
          signerProofSha256: null,
          createdBy: '01900000-0000-7000-8000-000000000002',
          updatedBy: '01900000-0000-7000-8000-000000000002',
          createdAt: '2026-11-24T09:00:00.000Z',
          updatedAt: '2026-11-24T09:00:00.000Z',
        }}
      />,
      'vi',
      qc,
    );
    expect(readonlyDraftHtml).toContain('CK-DRAFT1');
    expect(readonlyDraftHtml).toMatch(/5\.000\.000[\s\u00a0]₫/);
    expect(readonlyDraftHtml).not.toContain('₫ VND');

    // Destination normalization and change detection for clearing mismatched pending QR PNGs
    const normalizedBase = normalizeDepositDestination(' vcb ', ' 0123 456 789 ');
    expect(normalizedBase).toEqual({ bankCode: 'VCB', accountNumber: '0123456789' });
    expect(
      didDepositDestinationChange(normalizedBase, normalizeDepositDestination('VCB', '0123456789')),
    ).toBe(false);
    expect(
      didDepositDestinationChange(normalizedBase, normalizeDepositDestination('TCB', '0123456789')),
    ).toBe(true);
    expect(
      didDepositDestinationChange(normalizedBase, normalizeDepositDestination('VCB', '0999888777')),
    ).toBe(true);

    // Keeps ProfileFormBody mounted alongside inline error when cached data exists and background refetch errored
    const bgErrorQc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    bgErrorQc.setQueryData(['sign', 'deposit-profile', 'demo'], {
      canEdit: true,
      profile: {
        id: '01900000-0000-7000-8000-000000000050',
        orgId: '01900000-0000-7000-8000-000000000001',
        bankCode: 'VCB',
        bankName: 'Vietcombank',
        accountNumber: '0123456789',
        accountHolder: 'CONG TY TNHH TEST',
        financeBankAccount: '1121.VCB',
        vietqrFileId: null,
        hasQrPng: false,
        isDefault: true,
        createdAt: '2026-11-24T09:00:00.000Z',
        updatedAt: '2026-11-24T09:00:00.000Z',
      },
    });
    const bgQuery = bgErrorQc.getQueryCache().find({ queryKey: ['sign', 'deposit-profile', 'demo'] });
    bgQuery?.setState({ status: 'error', error: new Error('Background refetch timeout'), fetchStatus: 'idle' });
    const bgErrorHtml = wrap(<SignDepositProfileSettingsCard slug="demo" />, 'vi', bgErrorQc);
    expect(bgErrorHtml).toContain('Background refetch timeout');
    expect(bgErrorHtml).toContain('data-testid="sign-deposit-profile-form"');

    // Hidden QR file input must not be target of <Label htmlFor> when tabIndex=-1 & aria-hidden=true (#4837 item 18).
    const hiddenInputTagMatch = bgErrorHtml.match(
      /<input[^>]*data-testid="sign-deposit-qr-file-input"[^>]*>/,
    );
    const hiddenInputIdMatch = hiddenInputTagMatch?.[0]?.match(/\sid="([^"]+)"/);
    expect(hiddenInputIdMatch?.[1]).toBeTruthy();
    expect(bgErrorHtml).not.toContain(`for="${hiddenInputIdMatch![1]!}"`);
    const uploadBtnTag = bgErrorHtml.match(/<button[^>]*data-testid="sign-deposit-qr-upload-btn"[^>]*>/)?.[0] ?? '';
    expect(uploadBtnTag).toContain('aria-describedby=');
  });

  it('handles HTTP 413 plain-text multipart responses as proofTooLarge without shared-core http changes (#4837 item 12)', async () => {
    const viMsgs = catalog('vi').sign.ceremonyDeposit;
    const enMsgs = catalog('en').sign.ceremonyDeposit;
    const raw413 = new PublicSignError(413, 'SIGN_DEPOSIT_NOTICE_FAILED', 'Payload Too Large');
    expect(resolveNoticeErrorMessage(raw413, (k) => viMsgs[k])).toBe(viMsgs.proofTooLarge);
    expect(resolveNoticeErrorMessage(raw413, (k) => enMsgs[k])).toBe(enMsgs.proofTooLarge);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Payload Too Large', { status: 413 })),
    );
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'big.png', { type: 'image/png' });
    await expect(
      publicSignApi.depositNotice({ token: 'tok-413', file }),
    ).rejects.toMatchObject({ status: 413, code: 'TOO_LARGE' });
  });

  it('pre-validates VietQR PNG pixel dimensions against SIGN_SIGNATURE_PNG_MAX_* before upload (#4837 item 14)', async () => {
    const makePngBytes = (width: number, height: number): Uint8Array<ArrayBuffer> => {
      const buf = new ArrayBuffer(64);
      const out = new Uint8Array(buf);
      out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
      const view = new DataView(buf);
      view.setUint32(8, 13, false);
      out.set([0x49, 0x48, 0x44, 0x52], 12);
      view.setUint32(16, width, false);
      view.setUint32(20, height, false);
      return out;
    };

    expect(parsePngDimensions(makePngBytes(2000, 1000))).toEqual({ width: 2000, height: 1000 });
    expect(parsePngDimensions(makePngBytes(2001, 500))).toBeNull();
    expect(parsePngDimensions(makePngBytes(500, 1001))).toBeNull();

    const oversizedFile = new File([makePngBytes(2001, 500)], 'wide.png', { type: 'image/png' });
    await expect(readPngFileAsDataUrl(oversizedFile)).rejects.toThrow('SIGN_INVALID_SIGNATURE_PNG');

    const okFile = new File([makePngBytes(400, 400)], 'ok.png', { type: 'image/png' });
    const dataUrl = await readPngFileAsDataUrl(okFile);
    expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('renders BankSignDepositLine with batched prefetched candidates without firing per-line fetch (#4837 item 8)', () => {
    const emptyQc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const html = wrap(
      <BankSignDepositLine
        line={{
          id: '01900000-0000-7000-8000-000000000399',
          importId: '01900000-0000-7000-8000-000000000398',
          date: '2026-11-24',
          reference: 'FT-BAT999',
          description: 'CK-BAT999 Thanh toan dat coc',
          amount: '5000000',
          balance: '10000000',
          ambiguous: false,
          state: { status: 'open' },
        }}
        candidates={[
          {
            envelopeId: '01900000-0000-7000-8000-000000000499',
            title: 'Hop dong batched',
            completedAt: '2026-11-24T08:00:00.000Z',
            amount: '5000000',
            currency: 'VND',
            memoToken: 'CK-BAT999',
            financeBankAccount: '1121.VCB',
            signerName: 'Tran B',
            signerNoticeAt: null,
            reason: 'amount_memo',
            voucherType: 'bank_credit',
            suggestedDebitAccount: '1121.VCB',
            suggestedCreditAccount: '131',
          },
        ]}
        onPrepareProposal={vi.fn()}
      />,
      'vi',
      emptyQc,
    );
    expect(html).toContain('Hop dong batched');
    expect(html).toContain('CK-BAT999');
    expect(html).toContain('Tạo đề xuất Báo Có');
    expect(emptyQc.getQueryCache().getAll().some((q) => q.state.fetchStatus === 'fetching')).toBe(false);
  });
});
