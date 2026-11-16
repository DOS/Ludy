// SPDX-License-Identifier: AGPL-3.0-only
// Component and flow tests for Engage quote -> Ludy eSign handoff (#3512, ADR-0050, ADR-0053):
// 'sign' off gating (zero sign.* calls), semantic status badge links, button rules, and PDF->upload->create->signer->navigate flow.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SIGN_BY_SOURCE_MAX, type SignEnvelopeBySourceItem } from '@crove/kernel-contract';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { setActiveLocale } from '../src/i18n/runtime.ts';

const state = vi.hoisted(() => ({
  client: null as unknown as import('@tanstack/react-query').QueryClient,
  modules: ['crm', 'sign'] as string[],
  calls: [] as Array<{ step: string; args: unknown }>,
  pdfBytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]),
  uploadedFileId: '01900000-0000-7000-8000-000000000501',
  createdEnvelopeId: '01900000-0000-7000-8000-000000000601',
  createdSignerId: '01900000-0000-7000-8000-000000000701',
  quoteDetailBuyer: {
    name: 'Nguyen Van Buyer',
    taxCode: null,
    address: null,
    email: 'buyer@example.com',
  } as { name: string; taxCode: string | null; address: string | null; email: string | null } | null,
  signQueryAsked: [] as unknown[],
  signQueryExecuted: [] as unknown[],
  orgAppsQueryExecuted: 0,
  failCreateOnce: false,
  failSignerOnce: false,
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
    ...rest
  }: {
    children?: unknown;
    to: string;
    params?: Record<string, string>;
  }) => {
    const href = to.replace(/\$(\w+)/g, (_m, k: string) => params?.[k] ?? '');
    return (
      <a href={href} {...(rest as object)}>
        {children as never}
      </a>
    );
  },
}));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  state.client = new QC();
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
              queryKey:
                joined === 'sign.envelope.by_source' && args?.input !== undefined ? [...path, args.input] : path,
              queryFn: () => {
                if (joined === 'sign.envelope.by_source') {
                  state.signQueryExecuted.push(args?.input);
                }
                if (joined === 'org.apps') {
                  state.orgAppsQueryExecuted += 1;
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
  const rpcClient = {
    sign: {
      envelope: {
        create: async (input: unknown) => {
          state.calls.push({ step: 'create', args: input });
          if (state.failCreateOnce) {
            state.failCreateOnce = false;
            throw new Error('network lost');
          }
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
          state.calls.push({ step: 'addSigner', args: input });
          if (state.failSignerOnce) {
            state.failSignerOnce = false;
            throw new Error('signer network lost');
          }
          return {
            envelopeId: state.createdEnvelopeId,
            signerId: state.createdSignerId,
            routingOrder: 1,
            status: 'waiting',
            version: 2,
          };
        },
      },
    },
    crm: {
      quotes: {
        get: async (input: unknown) => {
          state.calls.push({ step: 'getQuote', args: input });
          return { buyer: state.quoteDetailBuyer };
        },
      },
    },
  };
  return {
    orpc: node([]),
    client: rpcClient,
    queryClient: state.client,
    errorMessage: (e: unknown) => String(e),
    apiFetch: async (path: string) => {
      state.calls.push({ step: 'pdfFetch', args: path });
      return {
        blob: async () => new Blob([state.pdfBytes], { type: 'application/pdf' }),
      };
    },
  };
});

vi.mock('../src/lib/sign-api.ts', () => ({
  uploadSignPdf: async (file: File) => {
    state.calls.push({
      step: 'uploadSignPdf',
      args: { name: file.name, type: file.type, size: file.size },
    });
    return { fileId: state.uploadedFileId };
  },
}));

const { DealQuotes } = await import('../src/components/deal-quotes.tsx');
const {
  QuoteSignHandoff,
  canStartQuoteSignHandoff,
  createQuoteSignHandoffAttempt,
  isDraftSignEnvelopeStale,
  performQuoteSignHandoff,
  signEnvelopePollMs,
} = await import('../src/components/quote-sign-handoff.tsx');

const DEAL = {
  id: '00000000-0000-4000-8000-000000000010',
  title: 'Hop dong dich vu nam',
  partyId: '00000000-0000-4000-8000-000000000011',
} as never;

const quoteSummary = (n: number, over: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-${String(100 + n).padStart(12, '0')}`,
  dealId: '00000000-0000-4000-8000-000000000010',
  dealTitle: 'Hop dong dich vu nam',
  partyId: '00000000-0000-4000-8000-000000000011',
  partyName: 'Cong ty ABC',
  number: `BG-2026-000${n}`,
  revision: 1,
  revisesId: null,
  status: 'sent' as const,
  expired: false,
  validUntil: '2026-12-31',
  subtotal: '3000000',
  vatAmount: '300000',
  total: '3300000',
  lineCount: 1,
  sentAt: '2026-11-15T02:00:00.000Z',
  sentVia: 'link' as const,
  firstViewedAt: null,
  version: 1,
  createdBy: 'u',
  createdAt: '2026-11-15T02:00:00.000Z',
  updatedAt: '2026-11-15T02:00:00.000Z',
  ...over,
});

const envItem = (quoteId: string, over: Partial<SignEnvelopeBySourceItem> = {}): SignEnvelopeBySourceItem => ({
  sourceId: quoteId,
  envelopeId: '01900000-0000-7000-8000-000000000901',
  title: 'Bao gia BG-2026-0001 - Cong ty ABC',
  status: 'sent',
  sealStatus: null,
  certificateCode: null,
  completedAt: null,
  signerCount: 1,
  signedCount: 0,
  createdAt: '2026-11-16T01:00:00.000Z',
  updatedAt: '2026-11-16T01:00:00.000Z',
  ...over,
});

function renderDealQuotes(opts: {
  modules?: string[];
  signAppEffective?: boolean | null;
  quotes?: ReturnType<typeof quoteSummary>[];
  envelopes?: SignEnvelopeBySourceItem[] | null;
  canEdit?: boolean;
  locale?: 'vi' | 'en';
} = {}): string {
  setActiveLocale(opts.locale ?? 'vi');
  state.modules = opts.modules ?? ['crm', 'sign'];
  state.signQueryAsked.length = 0;
  state.signQueryExecuted.length = 0;
  state.orgAppsQueryExecuted = 0;
  const qc = state.client;
  qc.clear();
  const quotes = opts.quotes ?? [quoteSummary(1)];
  qc.setQueryData(['crm', 'quotes', 'byDeal'], quotes);
  if (opts.signAppEffective !== null) {
    const effective = opts.signAppEffective ?? true;
    qc.setQueryData(['org', 'apps'], {
      apps: [{ id: 'sign', deployment: true, entitled: effective, enabled: effective, effective }],
      version: 1,
      canChange: true,
    });
  }
  if (opts.envelopes !== null) {
    for (let i = 0; i < quotes.length; i += SIGN_BY_SOURCE_MAX) {
      const chunk = quotes.slice(i, i + SIGN_BY_SOURCE_MAX).map((q) => q.id);
      const chunkSet = new Set(chunk);
      qc.setQueryData(['sign', 'envelope', 'by_source', { sourceKind: 'crm_quote', sourceIds: chunk }], {
        items: (opts.envelopes ?? []).filter((e) => chunkSet.has(e.sourceId)),
      });
    }
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <DealQuotes deal={DEAL} canEdit={opts.canEdit ?? true} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('Engage quote -> eSign handoff (#3512)', () => {
  beforeEach(() => {
    state.client.clear();
    state.calls.length = 0;
    state.signQueryAsked.length = 0;
    state.signQueryExecuted.length = 0;
    state.orgAppsQueryExecuted = 0;
    state.failCreateOnce = false;
    state.failSignerOnce = false;
    state.modules = ['crm', 'sign'];
    state.quoteDetailBuyer = {
      name: 'Nguyen Van Buyer',
      taxCode: null,
      address: null,
      email: 'buyer@example.com',
    };
  });

  it('makes zero sign.* queries and renders no eSign controls when sign is off at deployment or org level', () => {
    const deploymentOffHtml = renderDealQuotes({ modules: ['crm'], signAppEffective: null });
    expect(state.orgAppsQueryExecuted).toBe(0);
    expect(state.signQueryExecuted).toEqual([]);
    expect(deploymentOffHtml).not.toContain('quote-send-esign');
    expect(deploymentOffHtml).not.toContain('quote-sign-status');
    expect(deploymentOffHtml).not.toContain('Gửi ký điện tử');

    const orgDisabledHtml = renderDealQuotes({
      modules: ['crm', 'sign'],
      signAppEffective: false,
      envelopes: [envItem(quoteSummary(1).id, { status: 'completed' })],
    });
    expect(state.signQueryExecuted).toEqual([]);
    expect(orgDisabledHtml).not.toContain('quote-send-esign');
    expect(orgDisabledHtml).not.toContain('quote-sign-status');
    expect(orgDisabledHtml).not.toContain('Đã ký kết');

    const standaloneOffHtml = renderToStaticMarkup(
      <QueryClientProvider client={state.client}>
        <I18nProvider>
          <QuoteSignHandoff quote={quoteSummary(1)} canEdit={true} />
        </I18nProvider>
      </QueryClientProvider>,
    );
    expect(standaloneOffHtml).toBe('');
    expect(state.signQueryExecuted).toEqual([]);
  });

  it('renders semantic status badge links and correct button visibility for linked envelopes', () => {
    const qDraftEnv = quoteSummary(1, { status: 'sent' });
    const qActiveEnv = quoteSummary(2, { status: 'sent' });
    const qCompletedEnv = quoteSummary(3, { status: 'accepted' });
    const qDeclinedEnv = quoteSummary(4, { status: 'sent' });
    const qExpiredEnv = quoteSummary(5, { status: 'draft', number: null });
    const qFresh = quoteSummary(6, { status: 'draft', number: null });

    const html = renderDealQuotes({
      quotes: [qDraftEnv, qActiveEnv, qCompletedEnv, qDeclinedEnv, qExpiredEnv, qFresh],
      envelopes: [
        envItem(qDraftEnv.id, { envelopeId: 'env-draft', status: 'draft' }),
        envItem(qActiveEnv.id, { envelopeId: 'env-active', status: 'in_progress' }),
        envItem(qCompletedEnv.id, { envelopeId: 'env-done', status: 'completed', sealStatus: 'sealed' }),
        envItem(qDeclinedEnv.id, { envelopeId: 'env-dec', status: 'declined' }),
        envItem(qExpiredEnv.id, { envelopeId: 'env-exp', status: 'expired' }),
      ],
    });

    expect(state.signQueryAsked).toEqual([
      {
        sourceKind: 'crm_quote',
        sourceIds: [qDraftEnv.id, qActiveEnv.id, qCompletedEnv.id, qDeclinedEnv.id, qExpiredEnv.id, qFresh.id],
      },
    ]);

    expect(html).toContain('Nháp ký');
    expect(html).toContain('Đang chờ ký');
    expect(html).toContain('Đã ký kết');
    expect(html).toContain('Bị từ chối');
    expect(html).toContain('Hết hạn');
    expect(html).toContain('href="/o/acme/sign/envelopes/env-draft"');
    expect(html).toContain('href="/o/acme/sign/envelopes/env-active"');
    expect(html).toContain('href="/o/acme/sign/envelopes/env-done"');
    expect(html).toContain('href="/o/acme/sign/envelopes/env-dec"');
    expect(html).toContain('href="/o/acme/sign/envelopes/env-exp"');
    // No raw hex colors on badges.
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}/);

    // Only declined, expired, and fresh (no envelope) show "Gửi ký điện tử" (3 buttons).
    expect(html.split('data-testid="quote-send-esign"').length - 1).toBe(3);
    expect(html).toContain('Gửi ký điện tử');

    // English locale check.
    const enHtml = renderDealQuotes({
      locale: 'en',
      quotes: [qCompletedEnv, qFresh],
      envelopes: [envItem(qCompletedEnv.id, { envelopeId: 'env-done', status: 'completed' })],
    });
    expect(enHtml).toContain('Signed');
    expect(enHtml).toContain('Send for eSign');

    // Viewer sees status badges, never the create button.
    const viewerHtml = renderDealQuotes({
      canEdit: false,
      quotes: [qCompletedEnv, qFresh],
      envelopes: [envItem(qCompletedEnv.id, { envelopeId: 'env-done', status: 'completed' })],
    });
    expect(viewerHtml).toContain('Đã ký kết');
    expect(viewerHtml).not.toContain('quote-send-esign');
  });

  it('caps batched by_source queries to 50 quotes and applies handoff eligibility rules cleanly', () => {
    const many = Array.from({ length: SIGN_BY_SOURCE_MAX + 2 }, (_, idx) => quoteSummary(idx + 1));
    renderDealQuotes({ quotes: many, envelopes: [] });
    expect((state.signQueryAsked[0] as { sourceIds: string[] }).sourceIds).toHaveLength(SIGN_BY_SOURCE_MAX);

    expect(canStartQuoteSignHandoff({ status: 'draft', expired: false }, null)).toBe(true);
    expect(canStartQuoteSignHandoff({ status: 'sent', expired: false }, null)).toBe(true);
    expect(canStartQuoteSignHandoff({ status: 'accepted', expired: false }, null)).toBe(true);
    expect(canStartQuoteSignHandoff({ status: 'sent', expired: true }, null)).toBe(false);
    expect(canStartQuoteSignHandoff({ status: 'declined', expired: false }, null)).toBe(false);
    expect(canStartQuoteSignHandoff({ status: 'superseded', expired: false }, null)).toBe(false);
    expect(canStartQuoteSignHandoff({ status: 'sent', expired: false }, envItem('q1', { status: 'draft' }))).toBe(false);
    expect(canStartQuoteSignHandoff({ status: 'sent', expired: false }, envItem('q1', { status: 'sent' }))).toBe(false);
    expect(canStartQuoteSignHandoff({ status: 'sent', expired: false }, envItem('q1', { status: 'in_progress' }))).toBe(false);
    expect(canStartQuoteSignHandoff({ status: 'sent', expired: false }, envItem('q1', { status: 'completed' }))).toBe(false);
    expect(canStartQuoteSignHandoff({ status: 'sent', expired: false }, envItem('q1', { status: 'voided' }))).toBe(true);
    expect(canStartQuoteSignHandoff({ status: 'sent', expired: false }, envItem('q1', { status: 'declined' }))).toBe(true);
    expect(canStartQuoteSignHandoff({ status: 'sent', expired: false }, envItem('q1', { status: 'expired' }))).toBe(true);
  });

  it('executes PDF fetch -> uploadSignPdf -> create -> add signer -> navigate in order', async () => {
    const navigated: unknown[] = [];
    const createdIds: string[] = [];
    const invalidateSpy = vi.spyOn(state.client, 'invalidateQueries');
    const qWithEmail = quoteSummary(1, {
      buyerName: 'Cong ty TNHH Khach Hang',
      buyerEmail: 'khach@example.com',
    });

    const envelopeId = await performQuoteSignHandoff({
      quote: qWithEmail,
      slug: 'acme',
      envelopeTitle: 'Bao gia BG-2026-0001 - Cong ty ABC',
      signerRoleLabel: 'Khach hang',
      navigate: (opts) => navigated.push(opts),
      onCreated: (id) => createdIds.push(id),
    });

    expect(envelopeId).toBe(state.createdEnvelopeId);
    expect(createdIds).toEqual([state.createdEnvelopeId]);
    expect(state.calls.map((c) => c.step)).toEqual(['pdfFetch', 'uploadSignPdf', 'create', 'addSigner']);
    expect(state.calls[0]!.args).toBe(`/api/crm/quotes/${qWithEmail.id}/pdf`);
    expect(state.calls[1]!.args).toMatchObject({
      name: 'BG-2026-0001.pdf',
      type: 'application/pdf',
      size: state.pdfBytes.byteLength,
    });
    expect(state.calls[2]!.args).toMatchObject({
      title: 'Bao gia BG-2026-0001 - Cong ty ABC',
      sourceKind: 'crm_quote',
      sourceId: qWithEmail.id,
      sourceFileId: state.uploadedFileId,
    });
    expect(state.calls[3]!.args).toMatchObject({
      envelopeId: state.createdEnvelopeId,
      routingOrder: 1,
      signerRole: 'signer',
      roleLabel: 'Khach hang',
      name: 'Cong ty TNHH Khach Hang',
      email: 'khach@example.com',
      deliveryMode: 'email',
      requireEmailOtp: false,
    });
    expect(invalidateSpy).toHaveBeenCalled();
    expect(navigated).toEqual([
      {
        to: '/o/$slug/sign/envelopes/$id',
        params: { slug: 'acme', id: state.createdEnvelopeId },
      },
    ]);
  });

  it('falls back to link delivery with partyName on drafts and resolves buyer email from crm.quotes.get on sent quotes', async () => {
    const navigated: unknown[] = [];
    const draftQuote = quoteSummary(2, { status: 'draft', number: null, partyName: 'Khach Draft' });
    await performQuoteSignHandoff({
      quote: draftQuote,
      slug: 'acme',
      envelopeTitle: 'Bao gia nhap - Khach Draft',
      signerRoleLabel: 'Khach hang',
      navigate: (opts) => navigated.push(opts),
    });
    expect(state.calls.map((c) => c.step)).toEqual(['pdfFetch', 'uploadSignPdf', 'create', 'addSigner']);
    expect(state.calls[3]!.args).toMatchObject({
      name: 'Khach Draft',
      deliveryMode: 'link',
    });
    expect(state.calls[3]!.args).not.toHaveProperty('email');

    state.calls.length = 0;
    const sentQuote = quoteSummary(3, { status: 'sent', partyName: 'Cong ty XYZ' });
    await performQuoteSignHandoff({
      quote: sentQuote,
      slug: 'acme',
      envelopeTitle: 'Bao gia BG-2026-0003 - Cong ty XYZ',
      signerRoleLabel: 'Khach hang',
      navigate: (opts) => navigated.push(opts),
    });
    expect(state.calls.map((c) => c.step)).toEqual(['pdfFetch', 'uploadSignPdf', 'create', 'getQuote', 'addSigner']);
    expect(state.calls[4]!.args).toMatchObject({
      name: 'Nguyen Van Buyer',
      email: 'buyer@example.com',
      deliveryMode: 'email',
    });
  });

  it('reuses sourceFileId, idempotencyKey, and created envelopeId across retries and polls only while live', async () => {
    const q = quoteSummary(4, { buyerName: 'Buyer Retry', buyerEmail: 'buyer@example.com' });
    const attempt = createQuoteSignHandoffAttempt();
    const navigated: unknown[] = [];

    state.failCreateOnce = true;
    await expect(
      performQuoteSignHandoff({
        quote: q,
        slug: 'acme',
        envelopeTitle: 'Retry Envelope',
        signerRoleLabel: 'Khach hang',
        navigate: (opts) => navigated.push(opts),
        attempt,
      }),
    ).rejects.toThrow('network lost');

    state.failSignerOnce = true;
    await expect(
      performQuoteSignHandoff({
        quote: q,
        slug: 'acme',
        envelopeTitle: 'Retry Envelope',
        signerRoleLabel: 'Khach hang',
        navigate: (opts) => navigated.push(opts),
        attempt,
      }),
    ).rejects.toThrow('signer network lost');

    const finalId = await performQuoteSignHandoff({
      quote: q,
      slug: 'acme',
      envelopeTitle: 'Retry Envelope',
      signerRoleLabel: 'Khach hang',
      navigate: (opts) => navigated.push(opts),
      attempt,
    });

    expect(finalId).toBe(state.createdEnvelopeId);
    expect(state.calls.map((c) => c.step)).toEqual([
      'pdfFetch',
      'uploadSignPdf',
      'create',
      'create',
      'addSigner',
      'addSigner',
    ]);
    const create1 = state.calls[2]!.args as { idempotencyKey: string; sourceFileId: string };
    const create2 = state.calls[3]!.args as { idempotencyKey: string; sourceFileId: string };
    expect(create2.idempotencyKey).toBe(create1.idempotencyKey);
    expect(create2.sourceFileId).toBe(create1.sourceFileId);
    const signer1 = state.calls[4]!.args as { idempotencyKey: string };
    const signer2 = state.calls[5]!.args as { idempotencyKey: string };
    expect(signer2.idempotencyKey).toBe(signer1.idempotencyKey);

    expect(signEnvelopePollMs(undefined)).toBe(false);
    expect(signEnvelopePollMs([])).toBe(false);
    expect(signEnvelopePollMs([envItem('q1', { status: 'completed', sealStatus: 'sealed' })])).toBe(false);
    expect(signEnvelopePollMs([envItem('q1', { status: 'voided' }), envItem('q2', { status: 'declined' })])).toBe(false);
    expect(signEnvelopePollMs([envItem('q1', { status: 'sent' })])).toBe(15_000);
    expect(signEnvelopePollMs([envItem('q1', { status: 'completed', sealStatus: 'pending' })])).toBe(5_000);
  });

  it('flags edited drafts as stale so updated quotes never show a false Signed badge, and chunks >50 quotes', () => {
    const editedDraft = quoteSummary(1, {
      status: 'draft',
      number: null,
      updatedAt: '2026-11-16T02:00:00.000Z',
    });
    const acceptedUpdated = quoteSummary(2, {
      status: 'accepted',
      updatedAt: '2026-11-16T02:00:00.000Z',
    });
    const staleCompletedEnv = envItem(editedDraft.id, {
      envelopeId: 'env-stale',
      status: 'completed',
      sealStatus: 'sealed',
      createdAt: '2026-11-16T01:00:00.000Z',
    });
    const validCompletedEnv = envItem(acceptedUpdated.id, {
      envelopeId: 'env-valid',
      status: 'completed',
      sealStatus: 'sealed',
      createdAt: '2026-11-16T01:00:00.000Z',
    });

    expect(isDraftSignEnvelopeStale(editedDraft, staleCompletedEnv)).toBe(true);
    expect(isDraftSignEnvelopeStale(acceptedUpdated, validCompletedEnv)).toBe(false);
    expect(canStartQuoteSignHandoff(editedDraft, staleCompletedEnv)).toBe(true);
    expect(canStartQuoteSignHandoff(acceptedUpdated, validCompletedEnv)).toBe(false);

    const staleHtml = renderDealQuotes({
      quotes: [editedDraft, acceptedUpdated],
      envelopes: [staleCompletedEnv, validCompletedEnv],
    });
    expect(staleHtml).toContain('data-status="stale"');
    expect(staleHtml).toContain('Báo giá đã sửa sau khi tạo ký');
    // Only the edited draft renders a send button (accepted quote with valid envelope does not).
    expect(staleHtml.split('data-testid="quote-send-esign"').length - 1).toBe(1);

    // > 50 quotes: chunks into [50, 5] and keeps eSign controls active on quote #55.
    const manyQuotes = Array.from({ length: 55 }, (_, i) => quoteSummary(i + 1));
    const lastQuote = manyQuotes[54]!;
    const manyHtml = renderDealQuotes({
      quotes: manyQuotes,
      envelopes: [envItem(lastQuote.id, { envelopeId: 'env-55', status: 'declined' })],
    });
    expect(state.signQueryAsked).toHaveLength(2);
    expect((state.signQueryAsked[0] as { sourceIds: string[] }).sourceIds).toHaveLength(50);
    expect((state.signQueryAsked[1] as { sourceIds: string[] }).sourceIds).toHaveLength(5);
    expect(manyHtml).toContain('href="/o/acme/sign/envelopes/env-55"');
    expect(manyHtml.split('data-testid="quote-send-esign"').length - 1).toBe(55);
  });
});
