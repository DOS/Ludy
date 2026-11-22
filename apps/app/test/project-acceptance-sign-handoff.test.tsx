// SPDX-License-Identifier: AGPL-3.0-only
// Unit, SSR component, PDF 1.4, and ADR-0050 Finance invoice bridge tests for Ludy Du an -> Ludy eSign -> Ludy Ke toan (#3812, Slice 3b):
//   - Pure-TS A4 acceptance PDF 1.4 structure, multi-page pagination, and {{signature, r1}} / {{date, r1}} / {{signature, r2}} tags
//   - Zero sign.* queries and zero UI controls when 'sign' is MODULE_OFF or disabled for the org (ADR-0031, ADR-0053)
//   - Live status badges (Nhap, Dang cho ky, Da ky nghiem thu, Tu choi / Da huy, Het han), sealed PDF download, and Finance invoice link gating
//   - 100% AI-off parity in ProjectAcceptanceDialogBody from completed tasks
//   - SalesInvoicesPage ADR-0050 prefill draft form (human enters amounts/buyer; viewer stays read-only)
//   - performProjectAcceptanceSignHandoff idempotent retry and org-switch guard
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SignEnvelopeBySourceItem } from '@ludy/kernel-contract';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { setActiveLocale } from '../src/i18n/runtime.ts';
import {
  buildProjectAcceptanceFilename,
  buildProjectAcceptancePdfBytes,
  buildSalesInvoiceAcceptanceSearch,
  formatSalesInvoicePrefillDescription,
  parseSalesInvoiceHandoffSearch,
  sanitizeAcceptancePdfUserText,
  toAcceptancePdfAsciiText,
} from '../src/lib/project-acceptance-pdf.ts';
import { planDetectedTagsForSigners } from '../src/lib/sign-fields.ts';

const state = vi.hoisted(() => ({
  client: null as unknown as import('@tanstack/react-query').QueryClient,
  modules: ['projects', 'sign', 'finance'] as string[],
  calls: [] as Array<{ step: string; args: unknown }>,
  uploadedFiles: [] as Array<{ name: string; type: string; size: number; org: string | null | undefined }>,
  uploadedFileId: '01900000-0000-7000-8000-000000000801',
  createdEnvelopeId: '01900000-0000-7000-8000-000000000802',
  createdSignerId: '01900000-0000-7000-8000-000000000803',
  signQueryAsked: [] as unknown[],
  signQueryExecuted: [] as unknown[],
  failSignerOnce: false,
  currentOrg: 'acme' as string | null,
}));

vi.mock('../src/lib/auth.ts', () => ({
  getConfig: () => ({ modules: state.modules }),
}));

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ slug: 'acme' }),
  useNavigate: () => vi.fn(),
  Link: ({
    children,
    to,
    params,
    search,
    ...rest
  }: {
    children?: unknown;
    to: string;
    params?: Record<string, string>;
    search?: Record<string, string>;
  }) => {
    const baseHref = to.replace(/\$(\w+)/g, (_m, k: string) => params?.[k] ?? '');
    const qs = search ? `?${new URLSearchParams(search).toString()}` : '';
    return (
      <a href={`${baseHref}${qs}`} {...(rest as object)}>
        {children as never}
      </a>
    );
  },
}));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  state.client = new QC({ defaultOptions: { queries: { retry: false } } });
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') {
          return (args?: { input?: unknown }) => {
            const joined = path.join('.');
            if (joined === 'sign.envelope.by_source') {
              state.signQueryAsked.push(args?.input);
            }
            return {
              queryKey: args?.input !== undefined ? [...path, args.input] : path,
              queryFn: () => {
                if (joined === 'sign.envelope.by_source') {
                  state.signQueryExecuted.push(args?.input);
                }
                return Promise.reject(new Error(`unexpected query ${joined}`));
              },
            };
          };
        }
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });

  const makeRpcClient = (pinnedOrg: string | null) => ({
    sign: {
      envelope: {
        create: async (input: unknown) => {
          state.calls.push({ step: 'create', args: { input, pinnedOrg } });
          return {
            envelopeId: state.createdEnvelopeId,
            status: 'draft',
            inspectStatus: 'pending',
            version: 1,
          };
        },
      },
      signer: {
        add: async (input: unknown) => {
          state.calls.push({ step: 'addSigner', args: { input, pinnedOrg } });
          if (state.failSignerOnce) {
            state.failSignerOnce = false;
            throw new Error('transient network error');
          }
          return {
            envelopeId: state.createdEnvelopeId,
            signerId: state.createdSignerId,
            routingOrder: 1,
            status: 'pending',
            version: 2,
          };
        },
      },
      acceptance: {
        draft_summary: async (input: unknown) => {
          state.calls.push({ step: 'draftSummary', args: { input, pinnedOrg } });
          return { status: 'off', bullets: [] };
        },
      },
    },
  });

  return {
    orpc: node([]),
    client: makeRpcClient(null),
    clientForOrg: (slug: string) => makeRpcClient(slug),
    queryClient: state.client,
    getCurrentOrg: () => state.currentOrg,
    errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
    uploadFiles: async (files: File[], purpose: string, org?: string | null) => {
      for (const f of files) {
        state.uploadedFiles.push({ name: f.name, type: f.type, size: f.size, org });
      }
      state.calls.push({ step: 'upload', args: { purpose, org } });
      return { files: [{ fileId: state.uploadedFileId }] };
    },
    fetchFile: async () => new Blob(['%PDF-1.4 sealed'], { type: 'application/pdf' }),
    isStepUpRequired: () => false,
    uploadAgreement: async () => 'file-1',
    ClientError: Error,
  };
});

const {
  ProjectAcceptanceDialogBody,
  ProjectAcceptanceSignHandoff,
  buildDeterministicDeliverables,
  completedTasksOfBoard,
  createProjectAcceptanceHandoffAttempt,
  performProjectAcceptanceSignHandoff,
} = await import('../src/components/project-acceptance-sign-handoff.tsx');
const { SalesInvoicesPage } = await import('../src/routes/sales-invoices.tsx');

const PROJECT_ID = '01900000-0000-7000-8000-000000000111';

const SAMPLE_PROJECT = {
  id: PROJECT_ID,
  name: 'Triển khai Website Cà Phê Phố Cổ',
  status: 'active' as const,
};

const COMPLETED_TASKS = [
  { id: '01900000-0000-7000-8000-000000000201', title: 'Thiết kế giao diện trang chủ và giỏ hàng' },
  { id: '01900000-0000-7000-8000-000000000202', title: 'Tích hợp thanh toán QR ngân hàng' },
  { id: '01900000-0000-7000-8000-000000000203', title: 'Bàn giao tài liệu vận hành cho chủ quán' },
];

function makeEnvelope(over: Partial<SignEnvelopeBySourceItem> = {}): SignEnvelopeBySourceItem {
  return {
    sourceId: PROJECT_ID,
    envelopeId: '01900000-0000-7000-8000-000000000901',
    title: 'Biên bản nghiệm thu - Triển khai Website Cà Phê Phố Cổ (2026-11-19)',
    status: 'sent',
    sealStatus: null,
    sealedFileId: null,
    certificateCode: null,
    signerCount: 1,
    signedCount: 0,
    completedAt: null,
    createdAt: '2026-11-19T07:55:00.000Z',
    updatedAt: '2026-11-19T08:00:00.000Z',
    ...over,
  };
}

function render(node: React.ReactNode, locale: 'vi' | 'en' = 'vi'): string {
  setActiveLocale(locale);
  return renderToStaticMarkup(
    <QueryClientProvider client={state.client}>
      <I18nProvider>{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.client.clear();
  state.modules = ['projects', 'sign', 'finance'];
  state.calls = [];
  state.uploadedFiles = [];
  state.signQueryAsked = [];
  state.signQueryExecuted = [];
  state.failSignerOnce = false;
  state.currentOrg = 'acme';
});

describe('project-acceptance-pdf & ADR-0050 search helpers', () => {
  it('generates a valid PDF 1.4 A4 document with {{signature, r1}}, {{date, r1}}, and {{signature, r2}} tags', () => {
    expect(toAcceptancePdfAsciiText('Công ty Đạt Phát - 50.000.000₫')).toBe('Cong ty Dat Phat - 50.000.000VND');
    expect(buildProjectAcceptanceFilename('2026-11-19', PROJECT_ID)).toBe('bien-ban-nghiem-thu-2026-11-19-01900000.pdf');
    expect(sanitizeAcceptancePdfUserText('{\u0300{signature, r1}\u0300}')).toBe('{ {signature, r1} }');
    expect(sanitizeAcceptancePdfUserText('{{{text, r1, required: Gia phat}}}')).toBe('{ { {text, r1, required: Gia phat} } }');
    expect(sanitizeAcceptancePdfUserText('\u4E2D\u6587', '{{{fallback}}}')).not.toContain('{{');
    expect(sanitizeAcceptancePdfUserText('', '{{{fallback}}}')).toBe('{ { {fallback} } }');

    const bytes = buildProjectAcceptancePdfBytes({
      projectName: `${SAMPLE_PROJECT.name} {\u0300{signature, r1}\u0300}`,
      providerName: 'Công ty TNHH Giải Pháp Số Ludy',
      recipientName: 'Nguyễn Minh Anh',
      recipientEmail: 'minhanh@example.com',
      acceptanceDate: '2026-11-19',
      deliverables: [
        ...COMPLETED_TASKS.map((t) => t.title),
        'Mục có thẻ giả {{signature, r9}}',
        'Thẻ dấu kết hợp {\u0300{signature, r1}\u0300}',
        'Thẻ nhiều ngoặc {{{text, r1, required: Gia phat}}}',
      ],
      note: 'Bảo hành kỹ thuật 06 tháng kể từ ngày ký nghiệm thu. {{text, r1}} {{{checkbox, r1}}}',
    });
    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith('%PDF-1.4\n')).toBe(true);
    expect(text).toContain('/MediaBox [0 0 595 842]');
    expect(text).toContain('/Count 1');
    expect(text).toContain('BIEN BAN NGHIEM THU VA BAN GIAO DU AN');
    expect(text).toContain('({{signature, r1}}) Tj');
    expect(text).not.toContain('{{signature, r9}}');
    expect(text).not.toContain('{{text, r1}}');
    expect(text).toContain('({{date, r1}}) Tj');
    expect(text).toContain('({{signature, r2}}) Tj');
    const withoutTemplateTags = text
      .replace('({{signature, r1}}) Tj', '')
      .replace('({{date, r1}}) Tj', '')
      .replace('({{signature, r2}}) Tj', '');
    expect(withoutTemplateTags).not.toContain('{{');
    expect(withoutTemplateTags).not.toContain('}}');
    expect(text).toContain('xref\n');
    expect(text.endsWith('%%EOF\n')).toBe(true);

    // Verify tag compatibility with planDetectedTagsForSigners (Party B = r1, Party A = r2).
    const plan = planDetectedTagsForSigners({
      detectedTags: [
        { roleKey: 'r1', roleOrder: 1, fieldType: 'signature', pageNumber: 1, xNorm: 0.12, yNorm: 0.65, wNorm: 0.24, hNorm: 0.06, label: null, required: true },
        { roleKey: 'r1', roleOrder: 1, fieldType: 'date', pageNumber: 1, xNorm: 0.12, yNorm: 0.72, wNorm: 0.18, hNorm: 0.04, label: null, required: true },
        { roleKey: 'r2', roleOrder: 2, fieldType: 'signature', pageNumber: 1, xNorm: 0.56, yNorm: 0.65, wNorm: 0.24, hNorm: 0.06, label: null, required: true },
      ],
      signers: [{ id: 's-party-b', routingOrder: 1, signerRole: 'signer' }],
      existingFields: [],
      pageCount: 1,
    });
    expect(plan.applicable).toHaveLength(2);
    expect(plan.unmatchedRoleOrders).toEqual([2]);
  });

  it('paginates cleanly across multiple A4 pages when deliverables exceed a single page', () => {
    const manyItems = Array.from({ length: 48 }, (_, i) => `Hạng mục bàn giao chi tiết số ${i + 1} của hệ thống phần mềm`);
    const bytes = buildProjectAcceptancePdfBytes({
      projectName: 'Dự án lớn nhiều giai đoạn',
      providerName: 'Bên A',
      recipientName: 'Bên B',
      acceptanceDate: '2026-11-19',
      deliverables: manyItems,
    });
    const text = new TextDecoder().decode(bytes);
    expect(text).toMatch(/\/Count [2-9]/);
    expect(text).toContain('({{signature, r1}}) Tj');
  });

  it('sanitizes control and zero-width characters in ADR-0050 Finance URL search params', () => {
    const built = buildSalesInvoiceAcceptanceSearch({
      projectName: 'Website\u200B Cà\x00 Phê\r\nPhố Cổ',
      certificateCode: 'CERT-2026-8812\u202E',
      envelopeId: '01900000-0000-7000-8000-000000000901',
    });
    expect(built).toEqual({
      description: 'Nghiệm thu bàn giao dự án: Website Cà Phê Phố Cổ',
      reference: 'CERT-2026-8812',
    });

    const parsed = parseSalesInvoiceHandoffSearch({
      description: '  Nghiệm thu\x1B\uFEFF dự án  ',
      reference: 'CERT-99\uD800',
    });
    expect(parsed).toEqual({
      description: 'Nghiệm thu dự án',
      reference: 'CERT-99',
    });
    expect(formatSalesInvoicePrefillDescription(parsed)).toBe('Nghiệm thu dự án (CERT-99)');
  });
});

describe('ProjectAcceptanceSignHandoff module gating, badges, and Finance link', () => {
  it('renders nothing and asks zero sign.* queries when sign is MODULE_OFF on the deployment', () => {
    state.modules = ['projects', 'finance'];
    const html = render(
      <ProjectAcceptanceSignHandoff
        project={SAMPLE_PROJECT}
        completedTasks={COMPLETED_TASKS}
        canEdit={true}
      />,
    );
    expect(html).toBe('');
    expect(state.signQueryAsked).toHaveLength(0);
    expect(state.signQueryExecuted).toHaveLength(0);
  });

  it('renders nothing and asks zero sign.* queries when sign is disabled for the organization', () => {
    state.client.setQueryData(['org', 'apps'], {
      apps: [
        { id: 'projects', effective: true },
        { id: 'sign', effective: false },
        { id: 'finance', effective: true },
      ],
    });
    const html = render(
      <ProjectAcceptanceSignHandoff
        project={SAMPLE_PROJECT}
        completedTasks={COMPLETED_TASKS}
        canEdit={true}
      />,
    );
    expect(html).toBe('');
    expect(state.signQueryAsked).toHaveLength(0);
  });

  it('shows Lap bien ban nghiem thu button when sign is enabled and no envelope exists yet', () => {
    const html = render(
      <ProjectAcceptanceSignHandoff
        project={SAMPLE_PROJECT}
        completedTasks={COMPLETED_TASKS}
        canEdit={true}
        signEnabled={true}
        financeEnabled={true}
        envelope={null}
      />,
    );
    expect(html).toContain('data-testid="project-acceptance-open-button"');
    expect(html).toContain('Lập biên bản nghiệm thu');
    expect(html).not.toContain('project-acceptance-create-invoice');
  });

  it('renders live status badges across lifecycle states and gates sealed download + Finance invoice link', () => {
    const draftHtml = render(
      <ProjectAcceptanceSignHandoff
        project={SAMPLE_PROJECT}
        completedTasks={COMPLETED_TASKS}
        canEdit={true}
        signEnabled={true}
        financeEnabled={true}
        envelope={makeEnvelope({ status: 'draft' })}
      />,
    );
    expect(draftHtml).toContain('>Nháp<');
    expect(draftHtml).toContain('href="/o/acme/sign/envelopes/01900000-0000-7000-8000-000000000901"');
    expect(draftHtml).not.toContain('project-acceptance-create-invoice');

    const sentHtml = render(
      <ProjectAcceptanceSignHandoff
        project={SAMPLE_PROJECT}
        completedTasks={COMPLETED_TASKS}
        canEdit={true}
        signEnabled={true}
        financeEnabled={true}
        envelope={makeEnvelope({ status: 'in_progress' })}
      />,
    );
    expect(sentHtml).toContain('>Đang chờ ký<');

    const declinedHtml = render(
      <ProjectAcceptanceSignHandoff
        project={SAMPLE_PROJECT}
        completedTasks={COMPLETED_TASKS}
        canEdit={true}
        signEnabled={true}
        financeEnabled={true}
        envelope={makeEnvelope({ status: 'declined' })}
      />,
    );
    expect(declinedHtml).toContain('>Từ chối / Đã hủy<');
    expect(declinedHtml).toContain('Lập lại biên bản nghiệm thu');

    const expiredHtml = render(
      <ProjectAcceptanceSignHandoff
        project={SAMPLE_PROJECT}
        completedTasks={COMPLETED_TASKS}
        canEdit={true}
        signEnabled={true}
        financeEnabled={true}
        envelope={makeEnvelope({ status: 'expired' })}
      />,
    );
    expect(expiredHtml).toContain('>Hết hạn<');

    // Completed while sealing is pending or failed: hides both sealed download and Finance invoice link.
    const completedPendingSealHtml = render(
      <ProjectAcceptanceSignHandoff
        project={SAMPLE_PROJECT}
        completedTasks={COMPLETED_TASKS}
        canEdit={true}
        signEnabled={true}
        financeEnabled={true}
        envelope={makeEnvelope({ status: 'completed', sealStatus: 'pending' })}
      />,
    );
    expect(completedPendingSealHtml).toContain('>Đã ký nghiệm thu<');
    expect(completedPendingSealHtml).not.toContain('project-acceptance-download-sealed');
    expect(completedPendingSealHtml).not.toContain('project-acceptance-create-invoice');

    const completedFailedSealHtml = render(
      <ProjectAcceptanceSignHandoff
        project={SAMPLE_PROJECT}
        completedTasks={COMPLETED_TASKS}
        canEdit={true}
        signEnabled={true}
        financeEnabled={true}
        envelope={makeEnvelope({ status: 'completed', sealStatus: 'failed' })}
      />,
    );
    expect(completedFailedSealHtml).not.toContain('project-acceptance-create-invoice');

    // Lookup error: locks open button so transient errors never spawn duplicate envelopes, and shows retry.
    const lookupErrorHtml = render(
      <ProjectAcceptanceSignHandoff
        project={SAMPLE_PROJECT}
        completedTasks={COMPLETED_TASKS}
        canEdit={true}
        signEnabled={true}
        financeEnabled={true}
        envelopeError={new Error('network timeout')}
        onRetryEnvelope={() => undefined}
      />,
    );
    expect(lookupErrorHtml).not.toContain('project-acceptance-open-button');
    expect(lookupErrorHtml).toContain('data-testid="project-acceptance-retry-status"');

    const completedSealed = makeEnvelope({
      status: 'completed',
      sealStatus: 'sealed',
      sealedFileId: '01900000-0000-7000-8000-000000000999',
      certificateCode: 'CERT-VN-2026',
    });
    const completedHtml = render(
      <ProjectAcceptanceSignHandoff
        project={SAMPLE_PROJECT}
        completedTasks={COMPLETED_TASKS}
        canEdit={true}
        signEnabled={true}
        financeEnabled={true}
        envelope={completedSealed}
      />,
    );
    expect(completedHtml).toContain('>Đã ký nghiệm thu<');
    expect(completedHtml).toContain('data-testid="project-acceptance-download-sealed"');
    expect(completedHtml).toContain('Tải bản đã ký');
    expect(completedHtml).toContain('data-testid="project-acceptance-create-invoice"');
    expect(completedHtml).toContain('Lập hóa đơn từ biên bản nghiệm thu');
    expect(completedHtml).toContain('data-reference="CERT-VN-2026"');

    // Finance app disabled: hides invoice link while keeping status badge & sealed PDF download.
    const financeOffHtml = render(
      <ProjectAcceptanceSignHandoff
        project={SAMPLE_PROJECT}
        completedTasks={COMPLETED_TASKS}
        canEdit={true}
        signEnabled={true}
        financeEnabled={false}
        envelope={completedSealed}
      />,
    );
    expect(financeOffHtml).toContain('data-testid="project-acceptance-download-sealed"');
    expect(financeOffHtml).not.toContain('project-acceptance-create-invoice');

    // Read-only viewer: sees status badge & sealed download, never create/invoice buttons.
    const viewerHtml = render(
      <ProjectAcceptanceSignHandoff
        project={SAMPLE_PROJECT}
        completedTasks={COMPLETED_TASKS}
        canEdit={false}
        signEnabled={true}
        financeEnabled={true}
        envelope={completedSealed}
      />,
    );
    expect(viewerHtml).toContain('>Đã ký nghiệm thu<');
    expect(viewerHtml).toContain('data-testid="project-acceptance-download-sealed"');
    expect(viewerHtml).not.toContain('project-acceptance-create-invoice');
    expect(viewerHtml).not.toContain('project-acceptance-open-button');
  });
});

describe('ProjectAcceptanceDialogBody 100% AI-off parity & SalesInvoicesPage prefill', () => {
  it('populates deliverables directly from completed tasks without calling AI', () => {
    const html = render(
      <ProjectAcceptanceDialogBody
        project={SAMPLE_PROJECT}
        slug="acme"
        completedTasks={COMPLETED_TASKS}
        providerDefaultName="Công ty Cà Phê Việt"
        onCancel={() => undefined}
      />,
    );
    expect(html).toContain('Thiết kế giao diện trang chủ và giỏ hàng');
    expect(html).toContain('Tích hợp thanh toán QR ngân hàng');
    expect(html).toContain('Bàn giao tài liệu vận hành cho chủ quán');
    expect(html).toContain('data-proposed="false"');
    expect(html).toContain('data-testid="project-acceptance-ask-vy"');
    expect(html).toContain('Nhờ Vy tóm tắt hạng mục bàn giao');
    expect(state.calls).toHaveLength(0);
  });

  it('opens SalesInvoicesPage draft form prefilled from acceptance search params for writers, never for viewers', () => {
    state.client.setQueryData(['org', 'get'], { id: 'org-1', name: 'Acme', role: 'owner' });
    state.client.setQueryData(['legalEntities', 'list'], [{ id: 'le-1', name: 'Acme VN', isDefault: true }]);
    state.client.setQueryData(['einvoice', 'series', 'list'], [
      { id: 'ser-1', legalEntityId: 'le-1', provider: 'sandbox', templateNo: '1', symbol: 'C26TAA', description: 'Mặc định', isDefault: true },
    ]);
    state.client.setQueryData(['einvoice', 'status'], { sandbox: true });
    state.client.setQueryData(['einvoice', 'providers'], []);
    state.client.setQueryData(['einvoice', 'drafts', 'list', { legalEntityId: undefined }], []);

    const writerHtml = render(
      <SalesInvoicesPage
        prefill={{
          description: 'Nghiệm thu bàn giao dự án: Triển khai Website Cà Phê Phố Cổ',
          reference: 'CERT-VN-2026',
        }}
      />,
    );
    expect(writerHtml).toContain('data-testid="invoice-form"');
    expect(writerHtml).toContain('data-testid="invoice-acceptance-prefill-note"');
    expect(writerHtml).toContain('CERT-VN-2026');
    expect(writerHtml).toContain('Nghiệm thu bàn giao dự án: Triển khai Website Cà Phê Phố Cổ (CERT-VN-2026)');

    state.client.setQueryData(['org', 'get'], { id: 'org-1', name: 'Acme', role: 'viewer' });
    const viewerHtml = render(
      <SalesInvoicesPage
        prefill={{
          description: 'Nghiệm thu bàn giao dự án: Triển khai Website Cà Phê Phố Cổ',
          reference: 'CERT-VN-2026',
        }}
      />,
    );
    expect(viewerHtml).not.toContain('data-testid="invoice-form"');
  });
});

describe('performProjectAcceptanceSignHandoff idempotency and org-switch guard', () => {
  it('uploads PDF, creates project_acceptance envelope, adds Party B signer, and retries without duplicating envelope', async () => {
    const navigated: unknown[] = [];
    const attempt = createProjectAcceptanceHandoffAttempt();
    state.failSignerOnce = true;

    await expect(
      performProjectAcceptanceSignHandoff({
        project: SAMPLE_PROJECT,
        slug: 'acme',
        acceptanceDate: '2026-11-19',
        providerName: 'Công ty TNHH Ludy',
        recipientName: 'Trần Thị Bích',
        deliveryMode: 'link',
        deliverables: COMPLETED_TASKS.map((t) => t.title),
        note: 'Nghiệm thu đợt 1',
        envelopeTitle: 'Biên bản nghiệm thu - Website (2026-11-19)',
        signerRoleLabel: 'Đại diện Bên B (Khách hàng)',
        navigate: (opts) => navigated.push(opts),
        attempt,
      }),
    ).rejects.toThrow('transient network error');

    expect(state.uploadedFiles).toHaveLength(1);
    expect(state.calls.filter((c) => c.step === 'create')).toHaveLength(1);
    expect(navigated).toHaveLength(0);

    // Retry with same attempt: reuses uploaded fileId and created envelopeId, retrying only signer.add.
    const envelopeId = await performProjectAcceptanceSignHandoff({
      project: SAMPLE_PROJECT,
      slug: 'acme',
      acceptanceDate: '2026-11-19',
      providerName: 'Công ty TNHH Ludy',
      recipientName: 'Trần Thị Bích',
      deliveryMode: 'link',
      deliverables: COMPLETED_TASKS.map((t) => t.title),
      note: 'Nghiệm thu đợt 1',
      envelopeTitle: 'Biên bản nghiệm thu - Website (2026-11-19)',
      signerRoleLabel: 'Đại diện Bên B (Khách hàng)',
      navigate: (opts) => navigated.push(opts),
      attempt,
    });

    expect(envelopeId).toBe(state.createdEnvelopeId);
    expect(state.uploadedFiles).toHaveLength(1);
    expect(state.calls.filter((c) => c.step === 'create')).toHaveLength(1);
    expect(state.calls.filter((c) => c.step === 'addSigner')).toHaveLength(2);
    expect(state.calls.find((c) => c.step === 'create')?.args).toMatchObject({
      pinnedOrg: 'acme',
      input: {
        sourceKind: 'project_acceptance',
        sourceId: PROJECT_ID,
        sourceFileId: state.uploadedFileId,
      },
    });
    expect(navigated).toEqual([
      {
        to: '/o/$slug/sign/envelopes/$id',
        params: { slug: 'acme', id: state.createdEnvelopeId },
      },
    ]);
  });

  it('aborts immediately if active org changes while PDF upload is in flight', async () => {
    const navigated: unknown[] = [];
    await expect(
      performProjectAcceptanceSignHandoff({
        project: SAMPLE_PROJECT,
        slug: 'acme',
        acceptanceDate: '2026-11-19',
        providerName: 'Công ty TNHH Ludy',
        recipientName: 'Trần Thị Bích',
        deliveryMode: 'email',
        recipientEmail: 'bich@example.com',
        deliverables: COMPLETED_TASKS.map((t) => t.title),
        envelopeTitle: 'Biên bản nghiệm thu',
        signerRoleLabel: 'Đại diện Bên B',
        navigate: (opts) => navigated.push(opts),
        uploadPdf: async () => {
          state.currentOrg = 'other-org';
          return { fileId: state.uploadedFileId };
        },
      }),
    ).rejects.toThrow('Organization changed while preparing eSign envelope');

    expect(state.calls.filter((c) => c.step === 'create')).toHaveLength(0);
    expect(navigated).toHaveLength(0);
  });

  it('strips hidden recipientEmail from PDF and signer payload when deliveryMode is link', async () => {
    let uploadedBytes = new Uint8Array();
    await performProjectAcceptanceSignHandoff({
      project: SAMPLE_PROJECT,
      slug: 'acme',
      acceptanceDate: '2026-11-19',
      providerName: 'Công ty TNHH Ludy',
      recipientName: 'Trần Thị Bích',
      deliveryMode: 'link',
      recipientEmail: 'stale-hidden@example.com',
      deliverables: COMPLETED_TASKS.map((t) => t.title),
      envelopeTitle: 'Biên bản nghiệm thu',
      signerRoleLabel: 'Đại diện Bên B',
      navigate: () => undefined,
      uploadPdf: async (file) => {
        uploadedBytes = new Uint8Array(await file.arrayBuffer());
        return { fileId: state.uploadedFileId };
      },
    });

    const pdfText = new TextDecoder().decode(uploadedBytes);
    expect(pdfText).not.toContain('stale-hidden@example.com');
    const signerCall = state.calls.find((c) => c.step === 'addSigner')?.args as { input: Record<string, unknown> };
    expect(signerCall.input.email).toBeUndefined();
    expect(signerCall.input.deliveryMode).toBe('link');
  });
});

describe('the handover copy of completed task titles (#4421)', () => {
  it('shows the invisible characters of a task title an AI coworker wrote instead of carrying them into editable text, and keeps a person\'s title as typed', () => {
    const rows = buildDeterministicDeliverables([
      { id: '01900000-0000-7000-8000-000000000211', title: 'Giao hàng\u202e xong\u200b', tainted: true },
      { id: '01900000-0000-7000-8000-000000000212', title: 'Lắp đặt\u202e', tainted: false },
      { id: '01900000-0000-7000-8000-000000000213', title: 'Nghiệm thu' },
    ]);
    expect(rows.map((r) => r.text)).toEqual(['Giao hàng\u27e8U+202E\u27e9 xong\u27e8U+200B\u27e9', 'Lắp đặt\u202e', 'Nghiệm thu']);
    expect(rows.every((r) => r.proposedByAi === false)).toBe(true);
  });

  it('keeps the taint when a filtered board is read again for the done tasks, so that path marks the title too', () => {
    const done = completedTasksOfBoard([
      { id: '01900000-0000-7000-8000-000000000221', title: 'Bàn giao\u202e', status: 'done', tainted: true },
      { id: '01900000-0000-7000-8000-000000000222', title: 'Đang làm', status: 'in_progress', tainted: true },
      { id: '01900000-0000-7000-8000-000000000223', title: 'Xong\u202e', status: 'done', tainted: false },
    ]);
    expect(done.map((t) => t.id)).toEqual(['01900000-0000-7000-8000-000000000221', '01900000-0000-7000-8000-000000000223']);
    expect(buildDeterministicDeliverables(done).map((r) => r.text)).toEqual(['Bàn giao\u27e8U+202E\u27e9', 'Xong\u202e']);
  });
});
