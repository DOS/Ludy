// SPDX-License-Identifier: AGPL-3.0-only
// Regression tests for Wave P2-1 (#4643): shared ProposalSurface and CoworkerAttribution across AI coworker panels
// and Sheet drawer wiring for Vy clause review.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CashVoucherProposal,
  ConversationDetail,
  JournalVoucherProposal,
  TodayItem,
} from '@ludy/kernel-contract';

const cache = vi.hoisted(() => ({
  current: null as unknown as import('@tanstack/react-query').QueryClient,
  aiEnabled: true,
}));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  cache.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  const client = new Proxy({}, { get: () => new Proxy({}, { get: () => () => Promise.resolve({}) }) });
  return { orpc: node([]), client, queryClient: cache.current, errorMessage: (e: unknown) => String(e) };
});

vi.mock('../src/lib/auth.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/auth.ts')>();
  return {
    ...original,
    getConfig: () => ({
      authUrl: 'http://localhost:54321',
      authAnonKey: 'test-anon-key',
      aiEnabled: cache.aiEnabled,
    }),
  };
});

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    useParams: () => ({ slug: 'acme' }),
    Link: ({ children, to, params, ...rest }: { children?: ReactNode; to: string; params?: Record<string, string> }) =>
      createElement('a', { ...rest, href: to.replace(/\$(\w+)/g, (_match, name: string) => params?.[name] ?? '') }, children),
  };
});

vi.mock('@ludy/ui/components/sheet', async () => {
  const { createElement } = await import('react');
  return {
    Sheet: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
      (open === false ? null : createElement('div', { 'data-mock-sheet': 'true' }, children)),
    SheetContent: ({ children, side, closeLabel, ...rest }: { children?: ReactNode; side?: string; closeLabel?: string }) =>
      createElement('section', { 'data-sheet-side': side ?? 'right', 'data-close-label': closeLabel, ...rest }, children),
    SheetHeader: ({ children, ...rest }: { children?: ReactNode }) => createElement('header', rest, children),
    SheetTitle: ({ children, ...rest }: { children?: ReactNode }) => createElement('h2', rest, children),
    SheetDescription: ({ children, ...rest }: { children?: ReactNode }) => createElement('p', rest, children),
    SheetBody: ({ children, ...rest }: { children?: ReactNode }) => createElement('div', rest, children),
    SheetFooter: ({ children, ...rest }: { children?: ReactNode }) => createElement('footer', rest, children),
  };
});

const { ProposalSurface, CoworkerAttribution } = await import('../src/components/proposal-badges.tsx');
const { ReversalCard, VoucherCard, JournalVoucherCard } = await import('../src/components/proposal-detail.tsx');
const { DraftPanel } = await import('../src/components/conversation-drafts.tsx');
const { TodayBrief } = await import('../src/components/today-brief.tsx');
const { VyClauseTrigger, VyClauseSheet, VyClausePanel } = await import('../src/components/sign/vy-clause-panel.tsx');
const { briefDay, briefStorageKey, listFingerprint } = await import('../src/lib/today-brief.ts');
const { I18nProvider } = await import('../src/i18n/provider.tsx');
const { setActiveLocale } = await import('../src/i18n/runtime.ts');

function renderTree(node: ReactNode, locale: 'vi' | 'en' = 'vi'): string {
  setActiveLocale(locale);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache.current}>
      <I18nProvider>{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

const sampleVoucher = (over: Partial<CashVoucherProposal> = {}): CashVoucherProposal => ({
  type: 'bank_debit',
  date: '2026-11-20',
  cashAccount: '1121',
  party: { id: '00000000-0000-4000-8000-000000000010', name: 'Công ty TNHH Hoa Mai', taxCode: '0100000000' },
  personName: null,
  description: 'Thanh toán tiền hàng tháng 11',
  lines: [{ account: '331', amount: '2500000' }],
  total: '2500000',
  bankLineId: '00000000-0000-4000-8000-000000000011',
  matchedBy: { kind: 'suggested', reason: 'learned' },
  ...over,
});

const sampleJournalVoucher = (over: Partial<JournalVoucherProposal> = {}): JournalVoucherProposal => ({
  date: '2026-11-20',
  description: 'Kết chuyển chi phí thuê văn phòng',
  lines: [
    { account: '6422', party: null, debit: '5000000', credit: '0' },
    {
      account: '331',
      party: { id: '00000000-0000-4000-8000-000000000010', name: 'Công ty B', taxCode: null },
      debit: '0',
      credit: '5000000',
    },
  ],
  total: '5000000',
  ...over,
});

const sampleConversationDetail = (over: Partial<ConversationDetail> = {}): ConversationDetail => ({
  conversation: {
    id: '00000000-0000-4000-8000-000000000020',
    kind: 'direct',
    status: 'new',
    channel: { connectionId: '00000000-0000-4000-8000-000000000021', provider: 'telegram', displayName: 'Ludy Shop' },
    postId: null,
    contact: {
      identityId: '00000000-0000-4000-8000-000000000022',
      displayName: 'Lan Nguyễn',
      idTail: '0022',
      partyId: null,
      partyName: null,
    },
    assigneeUserId: null,
    lastSeq: 1,
    lastMessageAt: '2026-11-24T04:00:00.000Z',
    lastInboundAt: '2026-11-24T04:00:00.000Z',
    replyWindowUntil: null,
    preview: 'Sản phẩm này còn hàng không?',
    unread: true,
    composing: [],
    intent: null,
  },
  messages: [],
  notes: [],
  parentId: null,
  reply: { allowed: true, reason: null },
  gap: null,
  draft: {
    id: '00000000-0000-4000-8000-000000000023',
    state: 'live',
    source: 'auto',
    body: 'Dạ chào chị Lan, mẫu này bên em hiện còn sẵn hàng ạ.',
    tainted: true,
  },
  suggestions: [],
  others: [],
  ...over,
});

describe('ProposalSurface and CoworkerAttribution (#4643)', () => {
  beforeEach(() => {
    cache.current.clear();
    cache.aiEnabled = true;
  });

  it('renders dashed semantic proposal styling without shadows or rings, and solid styling when already posted', () => {
    const pendingHtml = renderTree(
      <ProposalSurface as="section" data-testid="surface-pending">
        <p>Pending output</p>
      </ProposalSurface>,
    );
    expect(pendingHtml).toContain('<section');
    expect(pendingHtml).toContain('border-dashed');
    expect(pendingHtml).toContain('border-proposal/60');
    expect(pendingHtml).toContain('bg-proposal/5');
    expect(pendingHtml).not.toMatch(/\bshadow-/);
    expect(pendingHtml).not.toMatch(/\bring-/);

    const postedHtml = renderTree(
      <ProposalSurface as="li" proposed={false} data-testid="surface-posted">
        <p>Posted output</p>
      </ProposalSurface>,
    );
    expect(postedHtml).toContain('<li');
    expect(postedHtml).toContain('border-border');
    expect(postedHtml).toContain('bg-card');
    expect(postedHtml).not.toContain('border-dashed');
    expect(postedHtml).not.toMatch(/\bshadow-/);
    expect(postedHtml).not.toMatch(/\bring-/);
  });

  it('enforces DESIGN.md coworker naming in vi and en with custom coworker rename and provenance', () => {
    const gmVi = renderTree(
      <CoworkerAttribution
        coworker="gm"
        name="Bảo"
        label="Từ Bảo"
        labelTestId="gm-label"
        badgeLabel="Đề xuất"
        badgeTestId="gm-badge"
        source="Quy tắc đã học"
        sourceTestId="gm-source"
      />,
      'vi',
    );
    expect(gmVi).toContain('data-testid="gm-label">Từ Bảo<');
    expect(gmVi).toContain('Tổng quản AI');
    expect(gmVi).toContain('Quy tắc đã học');
    expect(gmVi.toLowerCase()).not.toContain('trợ lý');
    expect(gmVi.toLowerCase()).not.toContain('assistant');

    const lyEn = renderTree(
      <CoworkerAttribution
        coworker="finance"
        badgeLabel="Proposal"
        source="Matched from learned bank rule"
      />,
      'en',
    );
    expect(lyEn).toContain('Ly');
    expect(lyEn).toContain('Finance AI coworker');
    expect(lyEn).toContain('Matched from learned bank rule');
    expect(lyEn.toLowerCase()).not.toContain('assistant');
  });

  it('applies ProposalSurface and CoworkerAttribution across VoucherCard, ReversalCard, and JournalVoucherCard', () => {
    const pendingVoucher = renderTree(
      <VoucherCard
        voucher={sampleVoucher()}
        code={null}
        slug="acme"
        accountName={(c) => `TK ${c}`}
        attribution={{ pending: true }}
      />,
    );
    expect(pendingVoucher).toContain('border-dashed');
    expect(pendingVoucher).toContain('border-proposal/60');
    expect(pendingVoucher).toContain('Ly');
    expect(pendingVoucher).toContain('Đồng nghiệp AI Tài chính');
    expect(pendingVoucher).toContain('quy tắc đã học');
    expect(pendingVoucher).not.toMatch(/\bshadow-/);

    const manualPendingVoucher = renderTree(
      <VoucherCard
        voucher={sampleVoucher({ matchedBy: { kind: 'manual' } })}
        code={null}
        slug="acme"
        accountName={(c) => `TK ${c}`}
        attribution={{ pending: true }}
      />,
    );
    expect(manualPendingVoucher).toContain('border-dashed');
    expect(manualPendingVoucher).toContain('Thành viên lập');
    expect(manualPendingVoucher).not.toContain('Đồng nghiệp AI');

    const postedVoucher = renderTree(
      <VoucherCard
        voucher={sampleVoucher({ matchedBy: { kind: 'manual' } })}
        code="UNC-001"
        slug="acme"
        accountName={(c) => `TK ${c}`}
        attribution={{ pending: false }}
      />,
    );
    expect(postedVoucher).toContain('border-border');
    expect(postedVoucher).not.toContain('border-dashed');

    const mcpVoucher = renderTree(
      <VoucherCard
        voucher={sampleVoucher({ matchedBy: undefined })}
        code={null}
        slug="acme"
        accountName={(c) => `TK ${c}`}
        attribution={{
          pending: true,
          requestedByMcp: { client: 'Claude Desktop', host: 'desktop' },
        }}
      />,
      'en',
    );
    expect(mcpVoucher).toContain('border-dashed');
    expect(mcpVoucher).toContain('Claude Desktop');
    expect(mcpVoucher).toContain('desktop');

    const reversalHtml = renderTree(
      <ReversalCard
        reversal={{ entryId: '00000000-0000-4000-8000-000000000030', entryDate: '2026-11-01', reason: 'Sai tài khoản' }}
        slug="acme"
        attribution={{ pending: true }}
      />,
    );
    expect(reversalHtml).toContain('border-dashed');
    expect(reversalHtml).toContain('Đề xuất, chưa ghi sổ');
    expect(reversalHtml).toContain('Đề xuất đảo bút toán');
    expect(reversalHtml).not.toMatch(/\bshadow-/);

    const journalManualHtml = renderTree(
      <JournalVoucherCard
        voucher={sampleJournalVoucher()}
        code={null}
        slug="acme"
        accountName={(c) => `TK ${c}`}
        proposalId="00000000-0000-4000-8000-000000000040"
        attribution={{ pending: true }}
      />,
    );
    expect(journalManualHtml).toContain('border-dashed');
    expect(journalManualHtml).toContain('Đề xuất, chưa ghi sổ');
    expect(journalManualHtml).toContain('Thành viên lập');
    expect(journalManualHtml).not.toMatch(/\bshadow-/);

    const journalAgentHtml = renderTree(
      <JournalVoucherCard
        voucher={sampleJournalVoucher()}
        code={null}
        slug="acme"
        accountName={(c) => `TK ${c}`}
        proposalId="00000000-0000-4000-8000-000000000041"
        attribution={{
          pending: true,
          requestedByAgent: { id: 'agent-1', name: 'Sổ sách tự động' },
        }}
      />,
    );
    expect(journalAgentHtml).toContain('border-dashed');
    expect(journalAgentHtml).toContain('Sổ sách tự động');
    expect(journalAgentHtml).toContain('Tác tử AI');
    expect(journalAgentHtml).not.toMatch(/\bshadow-/);
  });

  it('shows a plain source tag from what the proposal recorded, and none where it recorded nothing', () => {
    const tagged = (reason: 'tax_code' | 'learned' | 'account' | 'name') =>
      renderTree(
        <VoucherCard
          voucher={sampleVoucher({ matchedBy: { kind: 'suggested', reason } })}
          code={null}
          slug="acme"
          accountName={(c) => `TK ${c}`}
          attribution={{ pending: true }}
        />,
      );
    expect(tagged('tax_code')).toContain('data-source-tag="exact">Khớp chính xác<');
    expect(tagged('learned')).toContain('data-source-tag="rule">Theo quy tắc<');
    expect(tagged('account')).toContain('data-source-tag="history">Giống lần trước<');
    expect(tagged('name')).not.toContain('data-testid="proposal-source-tag"');

    const manual = renderTree(
      <VoucherCard
        voucher={sampleVoucher({ matchedBy: { kind: 'manual' } })}
        code={null}
        slug="acme"
        accountName={(c) => `TK ${c}`}
        attribution={{ pending: true }}
      />,
    );
    expect(manual).not.toContain('data-testid="proposal-source-tag"');

    const agent = renderTree(
      <ReversalCard
        reversal={{ entryId: '00000000-0000-4000-8000-000000000030', entryDate: '2026-11-01', reason: 'Sai tài khoản' }}
        slug="acme"
        attribution={{ pending: true, requestedByAgent: { id: 'agent-1', name: 'Sổ sách tự động' } }}
      />,
      'en',
    );
    expect(agent).toContain('data-source-tag="ai">AI suggested<');

    const draft = renderTree(<DraftPanel detail={sampleConversationDetail()} onUse={() => {}} onUseSaved={() => {}} />);
    expect(draft).toContain('data-source-tag="ai">AI đề xuất<');
  });

  it('shows the org’s current name of a coworker, never "assistant", wherever a roster key is given', () => {
    cache.current.setQueryData(['chart', 'get'], {
      agents: [
        { id: 'a-1', templateKey: 'finance.bookkeeper', displayName: 'Hoa', status: 'active' },
        { id: 'a-2', templateKey: 'crm.sales', displayName: 'Bảo', status: 'active' },
      ],
    });
    cache.current.setQueryData(['chart', 'templates'], [
      { key: 'finance.bookkeeper', module: 'finance' },
      { key: 'crm.sales', module: 'crm' },
    ]);
    const voucher = renderTree(
      <VoucherCard
        voucher={sampleVoucher()}
        code={null}
        slug="acme"
        accountName={(c) => `TK ${c}`}
        attribution={{ pending: true }}
      />,
    );
    expect(voucher).toContain('>Hoa<');
    expect(voucher).not.toContain('>Ly<');
    const draft = renderTree(<DraftPanel detail={sampleConversationDetail()} onUse={() => {}} onUseSaved={() => {}} />);
    expect(draft).toContain('>Bảo<');
    expect(draft).not.toContain('>Dy<');
    expect(`${voucher}${draft}`.toLowerCase()).not.toMatch(/trợ lý|assistant/);
  });

  it('applies ProposalSurface and Dy CoworkerAttribution in Conversation DraftPanel', () => {
    const html = renderTree(
      <DraftPanel detail={sampleConversationDetail()} onUse={() => {}} onUseSaved={() => {}} />,
      'vi',
    );
    expect(html).toContain('data-testid="conversation-draft"');
    expect(html).toContain('border-dashed');
    expect(html).toContain('border-proposal/60');
    expect(html).toContain('data-testid="conversation-draft-tainted"');
    expect(html).toContain('Dy');
    expect(html).toContain('Đồng nghiệp AI Bán hàng');
    expect(html.toLowerCase()).not.toContain('trợ lý');
  });

  it('uses ProposalSurface dashed when TodayBrief is written by Vy and solid when template', () => {
    const items: TodayItem[] = [
      {
        kind: 'proposal',
        app: 'finance',
        id: 'p-1',
        title: { key: 'today.inboxCount', params: { count: 2 } },
        count: 2,
        href: '/inbox',
      },
    ];
    const fp = listFingerprint(items);
    const day = briefDay();

    cache.current.setQueryData(['today', 'brief', briefStorageKey('acme', day, 'vi', fp)], {
      writtenBy: 'vy',
      sentences: ['Có 2 chứng từ cần duyệt hôm nay.'],
      budgetSpent: false,
      final: true,
    });
    const vyHtml = renderTree(<TodayBrief slug="acme" items={items} name="Bảo" />, 'vi');
    expect(vyHtml).toContain('data-testid="today-brief"');
    expect(vyHtml).toContain('border-dashed');
    expect(vyHtml).toContain('border-proposal/60');
    expect(vyHtml).toContain('data-testid="today-brief-coworker">Từ Bảo<');
    expect(vyHtml).toContain('<h3');

    cache.current.setQueryData(['today', 'brief', briefStorageKey('acme', day, 'en', fp)], {
      writtenBy: 'template',
      sentences: ['Open the approval inbox to review pending items.'],
      budgetSpent: false,
      final: true,
    });
    const tplHtml = renderTree(<TodayBrief slug="acme" items={items} name="Vy" />, 'en');
    expect(tplHtml).toContain('border-border');
    expect(tplHtml).not.toContain('border-dashed');
    expect(tplHtml).toContain('data-testid="today-brief-coworker">From Vy<');
  });

  it('renders VyClauseTrigger with 44px mobile touch target and VyClauseSheet inside right-hand Sheet with AI-off fallback', () => {
    const triggerRef = { current: null };
    const triggerHtml = renderTree(
      <VyClauseTrigger open={false} onToggle={() => {}} buttonRef={triggerRef} proposalCount={2} />,
      'vi',
    );
    expect(triggerHtml).toContain('data-testid="vy-clause-trigger"');
    expect(triggerHtml).toContain('max-md:min-h-11');
    expect(triggerHtml).toContain('aria-expanded="false"');
    expect(triggerHtml).toContain('2');

    const sheetHtml = renderTree(
      <VyClauseSheet
        open
        onClose={() => {}}
        triggerRef={triggerRef}
        aiAnalysis={{
          status: 'disabled',
          summaryText: null,
          riskLevel: null,
          proposedFields: [
            {
              proposalId: '00000000-0000-4000-8000-000000000051',
              signerId: '00000000-0000-4000-8000-000000000052',
              fieldType: 'signature',
              pageNumber: 1,
              xNorm: 0.1,
              yNorm: 0.2,
              wNorm: 0.3,
              hNorm: 0.08,
              label: 'Chữ ký',
              required: true,
              proposedByAi: true,
            },
          ],
          riskClauses: [],
        }}
        pendingProposals={[
          {
            proposalId: '00000000-0000-4000-8000-000000000051',
            signerId: '00000000-0000-4000-8000-000000000052',
            fieldType: 'signature',
            pageNumber: 1,
            xNorm: 0.1,
            yNorm: 0.2,
            wNorm: 0.3,
            hNorm: 0.08,
            label: 'Chữ ký',
            required: true,
            proposedByAi: true,
          },
        ]}
        editable
        analyzing={false}
        onAnalyze={() => {}}
        onJumpToPage={() => {}}
        onApplyAllProposals={() => {}}
      />,
      'vi',
    );
    expect(sheetHtml).toContain('data-sheet-side="right"');
    expect(sheetHtml).toContain('data-testid="vy-clause-sheet"');
    expect(sheetHtml).toContain('data-testid="vy-clause-panel"');
    expect(sheetHtml).toContain('data-testid="vy-ai-off-notice"');
    expect(sheetHtml).toContain('border-dashed');
    expect(sheetHtml).toContain('Vy');
    expect(sheetHtml).toContain('Tổng quản AI');

    const standaloneHtml = renderTree(
      <VyClausePanel
        aiAnalysis={{
          status: 'completed',
          summaryText: 'Tóm tắt hợp đồng dịch vụ.',
          riskLevel: 'low',
          proposedFields: [
            {
              proposalId: '00000000-0000-4000-8000-000000000051',
              signerId: '00000000-0000-4000-8000-000000000052',
              fieldType: 'signature',
              pageNumber: 1,
              xNorm: 0.1,
              yNorm: 0.2,
              wNorm: 0.3,
              hNorm: 0.08,
              label: 'Chữ ký',
              required: true,
              proposedByAi: true,
            },
          ],
          riskClauses: [],
        }}
        pendingProposals={[
          {
            proposalId: '00000000-0000-4000-8000-000000000051',
            signerId: '00000000-0000-4000-8000-000000000052',
            fieldType: 'signature',
            pageNumber: 1,
            xNorm: 0.1,
            yNorm: 0.2,
            wNorm: 0.3,
            hNorm: 0.08,
            label: 'Chữ ký',
            required: true,
            proposedByAi: true,
          },
        ]}
        editable
        analyzing={false}
        onAnalyze={() => {}}
        onJumpToPage={() => {}}
        onApplyAllProposals={() => {}}
      />,
      'vi',
    );
    expect(standaloneHtml.match(/border-dashed/g)).toHaveLength(1);
  });
});
