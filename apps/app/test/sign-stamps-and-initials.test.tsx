// SPDX-License-Identifier: AGPL-3.0-only
// Unit & component tests for eSign Slice 4a (#3817):
//   - 1-click Initial All Preceding Pages (pages 1..N-1, bottom-right/bottom-left, idempotent, multi-signer non-overlap)
//   - Stamp field readiness on envelopes and templates
//   - Public ceremony stamp field + 1-click saved signature button
//   - /o/$slug/sign/settings RBAC (owner/admin manage stamps vs plain member read-only notice)
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';
import {
  loadCeremonyWorkspaceProfiles,
  type SignMemberSignatureItem,
  type SignOrgStampItem,
  type SignTemplateDetail,
} from '../src/lib/sign-api.ts';
import {
  SIGN_FIELD_TYPES,
  checkSendReadiness,
  planInitialAllPrecedingPages,
} from '../src/lib/sign-fields.ts';
import {
  SignCeremonyReadyView,
  buildOtpRequiredViewState,
  buildSignSubmitPayload,
  isApproverCeremonyMode,
  isFieldFilled,
  withPreservedCeremonyFieldValues,
} from '../src/routes/sign-ceremony.tsx';
import { SignSettingsPage } from '../src/routes/sign-settings.tsx';
import { canAutoSendTemplate } from '../src/routes/sign-templates.tsx';

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    Link: ({ children, to }: { children?: ReactNode; to: string }) => createElement('a', { href: to }, children),
    useParams: () => ({ slug: 'acme' }),
    useNavigate: () => vi.fn(),
  };
});

vi.mock('../src/components/sign/pdf-canvas-viewer.tsx', async () => {
  const { createElement } = await import('react');
  return {
    PdfCanvasViewer: ({ renderOverlay, pageNumber }: { renderOverlay?: (page: number) => ReactNode; pageNumber: number }) =>
      createElement('div', { 'data-testid': 'mock-pdf-viewer' }, renderOverlay ? renderOverlay(pageNumber) : null),
  };
});

const mockedClientForOrg = vi.fn();
const mockedMeGet = vi.fn();
const mockedAccessToken = vi.fn<() => Promise<string | null>>(async () => null);

vi.mock('../src/lib/auth.ts', () => ({
  accessToken: () => mockedAccessToken(),
}));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  return {
    orpc: {
      org: {
        get: {
          queryOptions: () => ({
            queryKey: ['org', 'get'],
            queryFn: () => Promise.reject(new Error('not fetched in static render')),
          }),
        },
      },
    },
    queryClient: new QC(),
    client: {},
    clientForOrg: (slug: string) => mockedClientForOrg(slug),
    orglessClient: { me: { get: () => mockedMeGet() } },
    getCurrentOrg: () => 'acme-b',
    uploadFiles: vi.fn(),
    fetchFile: vi.fn(),
    errorMessage: (e: unknown) => String(e),
    isStepUpRequired: () => false,
  };
});

const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function renderWithProviders(node: ReactNode, qc?: QueryClient): string {
  const client = qc ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    <IntlProvider locale="vi" messages={catalog('vi')} timeZone="Asia/Ho_Chi_Minh">
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </IntlProvider>,
  );
}

describe('eSign Slice 4a helpers & UI (#3817)', () => {
  it('includes stamp in SIGN_FIELD_TYPES and satisfies signer readiness with a stamp field', () => {
    expect(SIGN_FIELD_TYPES).toEqual([
      'signature',
      'initials',
      'stamp',
      'date',
      'text',
      'checkbox',
      'dropdown',
      'radio',
      'attachment',
    ]);

    expect(
      checkSendReadiness({
        inspectStatus: 'passed',
        signers: [{ id: 's1', signerRole: 'signer' }],
        fields: [{ signerId: 's1', fieldType: 'stamp' }],
      }),
    ).toBeNull();

    const tplDetail: SignTemplateDetail = {
      template: {
        id: '01900000-0000-7000-8000-000000000010',
        title: 'Bien ban dong dau',
        description: null,
        routingMode: 'parallel',
        subject: null,
        message: null,
        expiresInHours: null,
        status: 'active',
        inspectStatus: 'passed',
        inspectError: null,
        sourceFileId: '01900000-0000-7000-8000-000000000011',
        sourceSha256: 'a'.repeat(64),
        pageCount: 2,
        pageDimensions: null,
        version: 1,
        archivedAt: null,
        createdBy: '01900000-0000-7000-8000-000000000012',
        createdAt: '2026-11-21T00:00:00.000Z',
        updatedAt: '2026-11-21T00:00:00.000Z',
      },
      roles: [
        {
          id: '01900000-0000-7000-8000-000000000021',
          roleKey: 'r1',
          signerRole: 'signer',
          roleLabel: 'Van thu dong dau',
          routingOrder: 1,
          deliveryMode: 'link',
          requireEmailOtp: false,
        },
      ],
      fields: [
        {
          id: '01900000-0000-7000-8000-000000000031',
          templateRoleId: '01900000-0000-7000-8000-000000000021',
          roleKey: 'r1',
          fieldType: 'stamp',
          pageNumber: 2,
          xNorm: 0.55,
          yNorm: 0.7,
          wNorm: 0.18,
          hNorm: 0.11,
          label: 'Dau cong ty',
          required: true,
          fontSizePt: null,
        },
      ],
      directLink: null,
    };
    expect(canAutoSendTemplate(tplDetail)).toBe(true);
  });

  it('places aligned initials across pages 1..N-1 idempotently and offsets second signer without overlap', () => {
    expect(
      planInitialAllPrecedingPages({
        signerId: 'party-a',
        pageCount: 1,
        existingFields: [],
      }),
    ).toEqual({ targetPages: 0, added: [], skippedPages: [] });

    const firstPass = planInitialAllPrecedingPages({
      signerId: 'party-a',
      pageCount: 20,
      existingFields: [{ signerId: 'party-a', fieldType: 'signature', pageNumber: 20 }],
      position: 'bottom-right',
    });
    expect(firstPass.targetPages).toBe(19);
    expect(firstPass.added).toHaveLength(19);
    expect(firstPass.skippedPages).toEqual([]);
    expect(firstPass.added.map((f) => f.pageNumber)).toEqual(Array.from({ length: 19 }, (_, idx) => idx + 1));
    expect(firstPass.added[0]).toMatchObject({
      signerId: 'party-a',
      fieldType: 'initials',
      pageNumber: 1,
      xNorm: 0.81,
      yNorm: 0.9,
      wNorm: 0.14,
      hNorm: 0.065,
      required: true,
    });

    // Clicking a second time skips all 19 pages so zero duplicate fields are added.
    const secondPass = planInitialAllPrecedingPages({
      signerId: 'party-a',
      pageCount: 20,
      existingFields: firstPass.added,
      position: 'bottom-right',
    });
    expect(secondPass.added).toEqual([]);
    expect(secondPass.skippedPages).toHaveLength(19);

    // Party B placing initials on the same 20-page contract sits side-by-side without overlapping Party A.
    const partyBPass = planInitialAllPrecedingPages({
      signerId: 'party-b',
      pageCount: 4,
      existingFields: firstPass.added.slice(0, 3),
      position: 'bottom-right',
    });
    expect(partyBPass.added).toHaveLength(3);
    expect(partyBPass.added[0]!.xNorm).toBeLessThan(firstPass.added[0]!.xNorm - firstPass.added[0]!.wNorm);

    const leftPass = planInitialAllPrecedingPages({
      signerId: 'party-c',
      pageCount: 3,
      existingFields: [],
      position: 'bottom-left',
    });
    expect(leftPass.added.map((f) => ({ page: f.pageNumber, x: f.xNorm }))).toEqual([
      { page: 1, x: 0.05 },
      { page: 2, x: 0.05 },
    ]);
  });

  it('renders ceremony stamp fields and 1-click saved signature buttons for signed-in workspace members', () => {
    const stampField = {
      id: '01900000-0000-7000-8000-000000000101',
      fieldType: 'stamp' as const,
      pageNumber: 1,
      xNorm: 0.6,
      yNorm: 0.72,
      wNorm: 0.18,
      hNorm: 0.11,
      label: 'Con dấu công ty',
      required: true,
      fontSizePt: null,
    };
    const sigField = {
      id: '01900000-0000-7000-8000-000000000102',
      fieldType: 'signature' as const,
      pageNumber: 1,
      xNorm: 0.2,
      yNorm: 0.72,
      wNorm: 0.24,
      hNorm: 0.08,
      label: 'Đại diện ký',
      required: true,
      fontSizePt: null,
    };

    expect(isApproverCeremonyMode({ signerRole: 'approver', fields: [stampField] })).toBe(false);
    expect(isFieldFilled(stampField, {})).toBe(false);
    expect(isFieldFilled(stampField, { signaturePngDataUrl: `data:image/png;base64,${TINY_PNG}` })).toBe(true);

    const payload = buildSignSubmitPayload({
      token: 'a'.repeat(43),
      fields: [sigField, stampField],
      answers: {
        [sigField.id]: { signaturePngDataUrl: `data:image/png;base64,${TINY_PNG}`, signatureKind: 'drawn' },
        [stampField.id]: { signaturePngDataUrl: `data:image/png;base64,${TINY_PNG}` },
      },
    });
    expect(payload.fields).toHaveLength(2);
    expect(payload.fields[1]).toMatchObject({
      fieldId: stampField.id,
      signaturePngBase64: `data:image/png;base64,${TINY_PNG}`,
    });

    const savedSig: SignMemberSignatureItem = {
      id: '01900000-0000-7000-8000-000000000201',
      kind: 'signature',
      signatureKind: 'draw',
      signatureTypedText: null,
      signaturePngBase64: TINY_PNG,
      imageSha256: 'b'.repeat(64),
      widthPx: 1,
      heightPx: 1,
      createdAt: '2026-11-21T00:00:00.000Z',
      updatedAt: '2026-11-21T00:00:00.000Z',
    };

    const html = renderWithProviders(
      <SignCeremonyReadyView
        viewState={{
          state: 'ready',
          orgName: 'Cong ty TNHH ABC',
          title: 'Hop dong kinh te',
          message: null,
          signerName: 'Tran Minh',
          roleLabel: 'Giam doc',
          signerRole: 'signer',
          expiresAt: '2026-12-01T00:00:00.000Z',
          pageCount: 1,
          fields: [sigField, stampField],
        }}
        answers={{}}
        pdfBytes={new Uint8Array([0x25, 0x50, 0x44, 0x46])}
        loadingPdf={false}
        pdfError={null}
        viewerRenderError={null}
        pageNumber={1}
        scale={1}
        consentChecked={false}
        canSubmit={false}
        submitting={false}
        submitError={null}
        declineOpen={false}
        declineReason=""
        declining={false}
        declineError={null}
        padFieldId={null}
        savedSignatures={[savedSig]}
        onPageChange={() => {}}
        onScaleChange={() => {}}
        onRenderStatusChange={() => {}}
        onJumpToNext={() => {}}
        onOpenPad={() => {}}
        onUpdateAnswer={() => {}}
        onConsentChange={() => {}}
        onSubmit={() => {}}
        onDeclineOpenChange={() => {}}
        onDeclineReasonChange={() => {}}
        onDeclineSubmit={() => {}}
      />,
    );

    expect(html).toContain('Bấm đóng dấu');
    expect(html).toContain('Dùng mẫu đã lưu');
    expect(html).toContain(`ceremony-quick-saved-btn-${sigField.id}`);
  });

  it('renders /sign/settings with stamp creation form for admins and read-only notice for plain members', () => {
    const stampItem: SignOrgStampItem = {
      id: '01900000-0000-7000-8000-000000000301',
      name: 'Dau tron Cong ty ABC',
      stampKind: 'company',
      fileId: null,
      stampPngBase64: TINY_PNG,
      imageSha256: 'c'.repeat(64),
      widthPx: 1,
      heightPx: 1,
      status: 'active',
      archivedAt: null,
      createdBy: '01900000-0000-7000-8000-000000000001',
      createdAt: '2026-11-21T00:00:00.000Z',
      updatedAt: '2026-11-21T00:00:00.000Z',
    };

    const adminQc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    adminQc.setQueryData(['org', 'get'], { slug: 'acme', role: 'owner' });
    adminQc.setQueryData(['sign', 'member_signature', 'list', 'acme'], { items: [] });
    adminQc.setQueryData(['sign', 'stamp', 'list', 'acme'], { items: [stampItem], canManage: true });
    const adminHtml = renderWithProviders(<SignSettingsPage />, adminQc);
    expect(adminHtml).toContain('org-stamp-create-form');
    expect(adminHtml).toContain(`org-stamp-archive-${stampItem.id}`);
    expect(adminHtml).not.toContain('org-stamp-readonly-notice');
    // Empty preview boxes use theme-aware bg-muted/30 so dark-mode placeholder text passes WCAG contrast;
    // bg-image-surface appears only around rendered <img> previews (here, the single active stamp card).
    expect(adminHtml.match(/bg-image-surface/g)).toHaveLength(1);
    expect(adminHtml.match(/bg-muted\/30/g)).toHaveLength(3);

    const savedSigItem: SignMemberSignatureItem = {
      id: '01900000-0000-7000-8000-000000000209',
      kind: 'signature',
      signatureKind: 'draw',
      signatureTypedText: null,
      signaturePngBase64: TINY_PNG,
      imageSha256: 'd'.repeat(64),
      widthPx: 1,
      heightPx: 1,
      createdAt: '2026-11-21T00:00:00.000Z',
      updatedAt: '2026-11-21T00:00:00.000Z',
    };
    const savedSigQc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    savedSigQc.setQueryData(['org', 'get'], { slug: 'acme', role: 'owner' });
    savedSigQc.setQueryData(['sign', 'member_signature', 'list', 'acme'], { items: [savedSigItem] });
    savedSigQc.setQueryData(['sign', 'stamp', 'list', 'acme'], { items: [stampItem], canManage: true });
    const savedSigHtml = renderWithProviders(<SignSettingsPage />, savedSigQc);
    expect(savedSigHtml.match(/bg-image-surface/g)).toHaveLength(2);
    expect(savedSigHtml.match(/bg-muted\/30/g)).toHaveLength(2);

    const memberQc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    memberQc.setQueryData(['org', 'get'], { slug: 'acme', role: 'member' });
    memberQc.setQueryData(['sign', 'member_signature', 'list', 'acme'], { items: [] });
    memberQc.setQueryData(['sign', 'stamp', 'list', 'acme'], { items: [stampItem], canManage: false });
    const memberHtml = renderWithProviders(<SignSettingsPage />, memberQc);
    expect(memberHtml).toContain('sign-settings-profiles-section');
    expect(memberHtml).toContain('org-stamp-readonly-notice');
    expect(memberHtml).not.toContain('org-stamp-create-form');
    expect(memberHtml).not.toContain(`org-stamp-archive-${stampItem.id}`);

    // Viewer role and pending orgQuery gate out SignMemberSignaturesAndStampsSection so 403 list queries never fire (#4281).
    const viewerQc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    viewerQc.setQueryData(['org', 'get'], { slug: 'acme', role: 'viewer' });
    const viewerHtml = renderWithProviders(<SignSettingsPage />, viewerQc);
    expect(viewerHtml).not.toContain('sign-settings-profiles-section');
    expect(viewerHtml).not.toContain('sign-settings-member-signatures-card');
    expect(viewerHtml).not.toContain('sign-settings-org-stamps-card');

    const pendingQc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const pendingHtml = renderWithProviders(<SignSettingsPage />, pendingQc);
    expect(pendingHtml).not.toContain('sign-settings-profiles-section');
    expect(pendingHtml).not.toContain('sign-settings-member-signatures-card');
    expect(pendingHtml).not.toContain('sign-settings-org-stamps-card');
  });

  it('preserves attachment metadata in quick-saved signature patches and inPerson flag in OTP fallback (#4281, #4331)', () => {
    const existingAttachment = {
      fileId: '01900000-0000-7000-8000-000000000401',
      filename: 'id-front.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 2048,
      sha256: 'e'.repeat(64),
      uploadedAt: '2026-11-24T00:00:00Z',
    };
    const merged = withPreservedCeremonyFieldValues(
      {
        valueText: 'Ghi chú',
        valueChecked: true,
        attachment: existingAttachment,
      },
      {
        signaturePngDataUrl: `data:image/png;base64,${TINY_PNG}`,
        signatureKind: 'drawn',
      },
    );
    expect(merged.attachment).toEqual(existingAttachment);
    expect(merged.valueText).toBe('Ghi chú');
    expect(merged.valueChecked).toBe(true);
    expect(merged.signaturePngDataUrl).toContain(TINY_PNG);

    expect(
      buildOtpRequiredViewState({
        orgName: 'Công ty ABC',
        title: 'Hợp đồng',
        inPerson: true,
      }),
    ).toEqual({
      state: 'otp_required',
      orgName: 'Công ty ABC',
      title: 'Hợp đồng',
      maskedEmail: null,
      inPerson: true,
    });
    expect(
      buildOtpRequiredViewState({
        orgName: 'Công ty ABC',
        title: 'Hợp đồng',
        inPerson: false,
      }),
    ).toEqual({
      state: 'otp_required',
      orgName: 'Công ty ABC',
      title: 'Hợp đồng',
      maskedEmail: null,
    });
  });

  it('prefers orgNameHint over getCurrentOrg() in loadCeremonyWorkspaceProfiles so multi-org stamps never cross workspaces', async () => {
    mockedAccessToken.mockResolvedValueOnce('tok-1');
    mockedMeGet.mockResolvedValueOnce({
      orgs: [
        { slug: 'acme-b', name: 'Cong ty B' },
        { slug: 'acme-a', name: 'Cong ty A' },
      ],
    });
    const calledSlugs: string[] = [];
    mockedClientForOrg.mockImplementation((slug: string) => {
      calledSlugs.push(slug);
      return {
        sign: {
          member_signature: { list: async () => ({ items: [] }) },
          stamp: { list: async () => ({ items: [], canManage: true }) },
        },
      };
    });

    const profile = await loadCeremonyWorkspaceProfiles('Cong ty A');
    expect(profile?.orgSlug).toBe('acme-a');
    expect(calledSlugs).toEqual(['acme-a']);
  });
});
