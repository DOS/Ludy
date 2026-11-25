// SPDX-License-Identifier: AGPL-3.0-only
// Component, accessibility, and helper tests for /sign/templates UI (#3526).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';
import type { SignTemplateDetail } from '../src/lib/sign-api.ts';
import { buildDirectSigningUrl } from '../src/lib/sign-hash.ts';
import {
  CreateTemplateForm,
  DirectLinkCard,
  InstantiateTemplateForm,
  SignTemplatesPage,
  TemplateRolesCard,
  canAutoSendTemplate,
  completeTemplateInstantiate,
  createTemplateDraftRevisionTracker,
  nextFiltersAfterTemplateCreate,
  shouldApplySavedDraftRevision,
} from '../src/routes/sign-templates.tsx';

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    Link: ({ children, to }: { children?: ReactNode; to: string }) => createElement('a', { href: to }, children),
    useParams: () => ({ slug: 'acme' }),
    useNavigate: () => vi.fn(),
  };
});

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  return {
    orpc: {},
    queryClient: new QC(),
    client: {},
    getCurrentOrg: () => 'acme',
    errorMessage: (e: unknown) => String(e),
    isStepUpRequired: () => false,
  };
});

function makeTemplateDetail(overrides: Partial<SignTemplateDetail> = {}): SignTemplateDetail {
  return {
    template: {
      id: '01900000-0000-7000-8000-000000000010',
      title: 'Hop dong dich vu',
      description: 'Mau dung hang thang',
      routingMode: 'parallel',
      subject: null,
      message: null,
      expiresInHours: 168,
      status: 'active',
      inspectStatus: 'passed',
      inspectError: null,
      sourceFileId: '01900000-0000-7000-8000-000000000011',
      sourceSha256: 'a'.repeat(64),
      pageCount: 1,
      pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0 }],
      version: 1,
      archivedAt: null,
      createdBy: '01900000-0000-7000-8000-000000000012',
      createdAt: '2026-11-17T00:00:00.000Z',
      updatedAt: '2026-11-17T00:00:00.000Z',
    },
    roles: [
      {
        id: '01900000-0000-7000-8000-000000000021',
        roleKey: 'r1',
        signerRole: 'signer',
        roleLabel: 'Khach hang ky',
        routingOrder: 1,
        deliveryMode: 'link',
        requireEmailOtp: false,
      },
      {
        id: '01900000-0000-7000-8000-000000000022',
        roleKey: 'cc1',
        signerRole: 'cc',
        roleLabel: 'Ke toan CC',
        routingOrder: 2,
        deliveryMode: 'email',
        requireEmailOtp: false,
      },
    ],
    fields: [
      {
        id: '01900000-0000-7000-8000-000000000031',
        templateRoleId: '01900000-0000-7000-8000-000000000021',
        roleKey: 'r1',
        fieldType: 'signature',
        pageNumber: 1,
        xNorm: 0.5,
        yNorm: 0.7,
        wNorm: 0.24,
        hNorm: 0.08,
        label: 'Chu ky',
        required: true,
        fontSizePt: null,
      },
    ],
    directLink: {
      id: '01900000-0000-7000-8000-000000000041',
      enabled: true,
      requireEmailOtp: true,
      lastRotatedAt: null,
      createdAt: '2026-11-17T00:00:00.000Z',
      updatedAt: '2026-11-17T00:00:00.000Z',
    },
    ...overrides,
  };
}

function assertPairedLabels(html: string): void {
  const labelForMatches = new Set(Array.from(html.matchAll(/<label[^>]+for="([^"]+)"/g), (m) => m[1]!));
  for (const tagMatch of html.matchAll(/<(input|select|textarea)\b[^>]*>/g)) {
    const tag = tagMatch[0];
    if (tag.includes('type="hidden"')) continue;
    const idMatch = tag.match(/\bid="([^"]+)"/);
    expect(idMatch, `control missing id: ${tag}`).not.toBeNull();
    expect(labelForMatches.has(idMatch![1]!), `control missing paired <label for="${idMatch![1]}">`).toBe(true);
  }
  for (const cbMatch of html.matchAll(/<button[^>]+role="checkbox"[^>]*>/g)) {
    const tag = cbMatch[0];
    const idMatch = tag.match(/\bid="([^"]+)"/);
    expect(idMatch, `checkbox missing id: ${tag}`).not.toBeNull();
    expect(labelForMatches.has(idMatch![1]!), `checkbox missing paired <label for="${idMatch![1]}">`).toBe(true);
  }
}

describe('eSign templates UI components (#3526)', () => {
  it('formats direct signing links strictly in the URL fragment (/-/sign/d#<token>)', () => {
    const token = 'A'.repeat(43);
    const url = buildDirectSigningUrl(token, 'https://app.ludy.vn');
    expect(url).toBe(`https://app.ludy.vn/-/sign/d#${token}`);
    expect(url).not.toContain('?token=');
  });

  it('enforces canAutoSendTemplate rules cleanly for Signer vs Approver roles', () => {
    const ready = makeTemplateDetail();
    expect(canAutoSendTemplate(ready)).toBe(true);

    const noSig = makeTemplateDetail({ fields: [] });
    expect(canAutoSendTemplate(noSig)).toBe(false);

    const approverOnly = makeTemplateDetail({
      roles: [
        {
          id: '01900000-0000-7000-8000-000000000099',
          roleKey: 'r1',
          signerRole: 'approver',
          roleLabel: 'Quan ly',
          routingOrder: 1,
          deliveryMode: 'link',
          requireEmailOtp: false,
        },
      ],
      fields: [],
    });
    expect(canAutoSendTemplate(approverOnly)).toBe(true);

    const uninspected = makeTemplateDetail({
      template: { ...ready.template, inspectStatus: 'pending', pageCount: null },
    });
    expect(canAutoSendTemplate(uninspected)).toBe(false);
  });

  it('renders TemplateRolesCard and DirectLinkCard in vi and en with paired labels and zero secret leaks', () => {
    const detail = makeTemplateDetail();
    const freshToken = 'B'.repeat(43);
    const freshUrl = buildDirectSigningUrl(freshToken, 'https://app.ludy.vn');

    for (const locale of ['vi', 'en'] as const) {
      const rolesHtml = renderToStaticMarkup(
        <IntlProvider locale={locale} messages={catalog(locale)}>
          <TemplateRolesCard
            roles={detail.roles.map((r) => ({ ...r, localId: r.id }))}
            editable={true}
            saving={false}
            onChangeRoles={() => {}}
            onSaveRoles={() => {}}
          />
        </IntlProvider>,
      );
      assertPairedLabels(rolesHtml);
      expect(rolesHtml).toContain('r1');
      expect(rolesHtml).toContain('cc1');

      const directHtml = renderToStaticMarkup(
        <IntlProvider locale={locale} messages={catalog(locale)}>
          <DirectLinkCard
            detail={detail}
            freshDirectUrl={freshUrl}
            pending={false}
            onToggleEnabled={() => {}}
            onToggleOtp={() => {}}
            onRotate={() => {}}
            onCopyUrl={() => {}}
          />
        </IntlProvider>,
      );
      assertPairedLabels(directHtml);
      expect(directHtml).toContain(freshUrl);
      expect(directHtml).not.toContain('token_sha256');
    }

    // Two active non-CC roles show rule hint instead of enable switch.
    const multiRoleDetail = makeTemplateDetail({
      roles: [
        ...detail.roles,
        {
          id: '01900000-0000-7000-8000-000000000023',
          roleKey: 'r2',
          signerRole: 'approver',
          roleLabel: 'Duyet',
          routingOrder: 2,
          deliveryMode: 'email',
          requireEmailOtp: false,
        },
      ],
      directLink: null,
    });
    const blockedHtml = renderToStaticMarkup(
      <IntlProvider locale="vi" messages={catalog('vi')}>
        <DirectLinkCard
          detail={multiRoleDetail}
          freshDirectUrl={null}
          pending={false}
          onToggleEnabled={() => {}}
          onToggleOtp={() => {}}
          onRotate={() => {}}
          onCopyUrl={() => {}}
        />
      </IntlProvider>,
    );
    expect(blockedHtml).not.toContain('sign-tpl-direct-enabled');
  });

  it('renders deterministic PDF tag banner in SignTemplatesPage in vi and en (#3552)', () => {
    const base = makeTemplateDetail({ fields: [] });
    const detailWithTags: SignTemplateDetail = {
      ...base,
      template: {
        ...base.template,
        detectedTags: [
          {
            pageNumber: 1,
            fieldType: 'signature',
            roleOrder: 1,
            roleKey: 'r1',
            required: true,
            label: null,
            xNorm: 0.2,
            yNorm: 0.65,
            wNorm: 0.24,
            hNorm: 0.08,
          },
          {
            pageNumber: 1,
            fieldType: 'date',
            roleOrder: 1,
            roleKey: 'r1',
            required: true,
            label: null,
            xNorm: 0.52,
            yNorm: 0.66,
            wNorm: 0.16,
            hNorm: 0.04,
          },
        ],
      },
    };

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(['sign', 'templates', 'list', 'all', ''], {
      items: [
        {
          id: detailWithTags.template.id,
          title: detailWithTags.template.title,
          description: detailWithTags.template.description,
          routingMode: detailWithTags.template.routingMode,
          subject: null,
          message: null,
          expiresInHours: 168,
          status: 'active',
          inspectStatus: 'passed',
          inspectError: null,
          pageCount: 1,
          roleCount: 2,
          nonCcRoleCount: 1,
          fieldCount: 0,
          directLink: null,
          version: 1,
          archivedAt: null,
          createdAt: detailWithTags.template.createdAt,
          updatedAt: detailWithTags.template.updatedAt,
        },
      ],
    });
    qc.setQueryData(['sign', 'templates', 'detail', detailWithTags.template.id], detailWithTags);

    const viHtml = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <IntlProvider locale="vi" timeZone="Asia/Ho_Chi_Minh" messages={catalog('vi')}>
          <SignTemplatesPage />
        </IntlProvider>
      </QueryClientProvider>,
    );
    assertPairedLabels(viHtml);
    expect(viHtml).toContain('data-testid="sign-tpl-detected-tags-banner"');
    expect(viHtml).toContain('Áp dụng 2 ô từ thẻ tài liệu');

    const enHtml = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <IntlProvider locale="en" timeZone="Asia/Ho_Chi_Minh" messages={catalog('en')}>
          <SignTemplatesPage />
        </IntlProvider>
      </QueryClientProvider>,
    );
    expect(enHtml).toContain('Apply 2 tag fields');
  });

  it('clears searchQuery alongside status tab reset after creating a template (#3566)', () => {
    expect(nextFiltersAfterTemplateCreate('active')).toEqual({ tab: 'all', searchQuery: '' });
    expect(nextFiltersAfterTemplateCreate('archived')).toEqual({ tab: 'all', searchQuery: '' });
    expect(nextFiltersAfterTemplateCreate('draft')).toEqual({ tab: 'draft', searchQuery: '' });
    expect(nextFiltersAfterTemplateCreate('all')).toEqual({ tab: 'all', searchQuery: '' });
  });

  it('guards rolesDraft and fieldsDraft save revisions across A -> B -> A switches and disables role controls while saving (#3566)', () => {
    const tplA = '01900000-0000-7000-8000-000000000010';
    const tplB = '01900000-0000-7000-8000-000000000099';
    expect(
      shouldApplySavedDraftRevision({
        loadedTemplateId: tplA,
        savedTemplateId: tplA,
        currentRevision: 3,
        submittedRevision: 3,
      }),
    ).toBe(true);
    expect(
      shouldApplySavedDraftRevision({
        loadedTemplateId: tplA,
        savedTemplateId: tplA,
        currentRevision: 4,
        submittedRevision: 3,
      }),
    ).toBe(false);
    expect(
      shouldApplySavedDraftRevision({
        loadedTemplateId: tplB,
        savedTemplateId: tplA,
        currentRevision: 3,
        submittedRevision: 3,
      }),
    ).toBe(false);

    // Per-template tracker: switching A -> B -> A while save is in flight does NOT bump A's edit revision,
    // so save completion or v2 detail refresh cleanly updates A without clobbering real concurrent edits.
    const tracker = createTemplateDraftRevisionTracker();
    expect(tracker.onDetailEffect(tplA, 1)).toEqual({ kind: 'switched', syncRoles: true, syncFields: true });
    const submittedRev = tracker.markRolesEdited();
    expect(submittedRev).toBe(1);

    // User switches A -> B -> A (cached v1) before save completes:
    expect(tracker.onDetailEffect(tplB, 1).kind).toBe('switched');
    expect(tracker.onDetailEffect(tplA, 1)).toEqual({ kind: 'switched', syncRoles: true, syncFields: true });
    expect(tracker.getRolesRevision(tplA)).toBe(1);
    expect(tracker.acceptSavedRoles(tplA, submittedRev, 2)).toBe(true);
    expect(tracker.onDetailEffect(tplA, 2)).toEqual({ kind: 'none', syncRoles: false, syncFields: false });

    // If user makes another edit on A while a second save is in flight, neither acceptSavedRoles nor v3 refresh overwrites it:
    const secondSubmitted = tracker.markRolesEdited();
    tracker.markRolesEdited();
    expect(tracker.acceptSavedRoles(tplA, secondSubmitted, 3)).toBe(false);
    expect(tracker.onDetailEffect(tplA, 3)).toEqual({ kind: 'refreshed', syncRoles: false, syncFields: true });

    const detail = makeTemplateDetail();
    const savingHtml = renderToStaticMarkup(
      <IntlProvider locale="en" timeZone="Asia/Ho_Chi_Minh" messages={catalog('en')}>
        <TemplateRolesCard
          roles={detail.roles.map((r) => ({ ...r, localId: r.id }))}
          editable={true}
          saving={true}
          onChangeRoles={() => {}}
          onSaveRoles={() => {}}
        />
      </IntlProvider>,
    );
    assertPairedLabels(savingHtml);
    expect(savingHtml).toContain('Save roles');
    expect(savingHtml).toContain('data-loading=""');
    expect(savingHtml).toContain('aria-busy="true"');
    expect(savingHtml).toMatch(/id="sign-tpl-role-key-0"[^>]*disabled=""/);
    expect(savingHtml).toMatch(/id="sign-tpl-role-label-0"[^>]*disabled=""/);
    expect(savingHtml).toMatch(/data-testid="sign-tpl-add-role-btn"[^>]*disabled=""|disabled=""[^>]*data-testid="sign-tpl-add-role-btn"/);
  });

  it('guards instantiateMutation completion against unmount and org switches across async steps (#3566)', async () => {
    let activeSlug: string | undefined = 'acme';
    let liveOrg: string | null = 'acme';
    let mounted = true;
    const completedCalls: unknown[] = [];
    const navCalls: Array<{ slug: string; envelopeId: string }> = [];
    let closedCount = 0;

    // 1. Page unmounts (e.g. sidebar switchOrg to /o/beta/overview) while activeSlug ref stays 'acme' -> blocks navigation.
    mounted = false;
    liveOrg = 'beta';
    const unmountedOutcome = await completeTemplateInstantiate({
      res: {
        envelopeId: '01900000-0000-7000-8000-000000000700',
        links: [],
      },
      capturedSlug: 'acme',
      isMounted: () => mounted,
      getActiveOrg: () => liveOrg,
      getCurrentSlug: () => activeSlug,
      invalidateEnvelopes: async () => {},
      getEnvelope: async () => null,
      onCompletedLinks: (c) => completedCalls.push(c),
      onCloseDialog: () => {
        closedCount += 1;
      },
      navigateToEnvelope: async (slug, envelopeId) => {
        navCalls.push({ slug, envelopeId });
      },
    });
    expect(unmountedOutcome).toBe('stale');
    expect(navCalls).toEqual([]);
    expect(closedCount).toBe(0);

    // 2. getActiveOrg() changes in router beforeLoad while getEnvelope is awaiting -> blocks one-time link disclosure.
    mounted = true;
    liveOrg = 'acme';
    const staleLinksOutcome = await completeTemplateInstantiate({
      res: {
        envelopeId: '01900000-0000-7000-8000-000000000701',
        links: [{ signerId: '01900000-0000-7000-8000-000000000702', token: 'T'.repeat(43) }],
      },
      capturedSlug: 'acme',
      isMounted: () => mounted,
      getActiveOrg: () => liveOrg,
      getCurrentSlug: () => activeSlug,
      invalidateEnvelopes: async () => {},
      getEnvelope: async () => {
        liveOrg = 'other-org';
        return {
          signers: [{ id: '01900000-0000-7000-8000-000000000702', name: 'Le Van B', roleLabel: 'Ben B' }],
        };
      },
      onCompletedLinks: (c) => completedCalls.push(c),
      onCloseDialog: () => {
        closedCount += 1;
      },
      navigateToEnvelope: async (slug, envelopeId) => {
        navCalls.push({ slug, envelopeId });
      },
    });
    expect(staleLinksOutcome).toBe('stale');
    expect(completedCalls).toEqual([]);
    expect(navCalls).toEqual([]);
    expect(closedCount).toBe(0);

    // 3. Slug switches while invalidateEnvelopes is awaiting -> blocks navigation into the wrong org.
    activeSlug = 'acme';
    liveOrg = 'acme';
    const staleNavOutcome = await completeTemplateInstantiate({
      res: {
        envelopeId: '01900000-0000-7000-8000-000000000703',
        links: [],
      },
      capturedSlug: 'acme',
      isMounted: () => mounted,
      getActiveOrg: () => liveOrg,
      getCurrentSlug: () => activeSlug,
      invalidateEnvelopes: async () => {
        activeSlug = 'other-org';
      },
      getEnvelope: async () => null,
      onCompletedLinks: (c) => completedCalls.push(c),
      onCloseDialog: () => {
        closedCount += 1;
      },
      navigateToEnvelope: async (slug, envelopeId) => {
        navCalls.push({ slug, envelopeId });
      },
    });
    expect(staleNavOutcome).toBe('stale');
    expect(closedCount).toBe(0);
    expect(navCalls).toEqual([]);

    // 4. Mounted and slug/org stay unchanged -> closes dialog and navigates cleanly.
    activeSlug = 'acme';
    liveOrg = 'acme';
    const navOutcome = await completeTemplateInstantiate({
      res: {
        envelopeId: '01900000-0000-7000-8000-000000000704',
        links: [],
      },
      capturedSlug: 'acme',
      isMounted: () => mounted,
      getActiveOrg: () => liveOrg,
      getCurrentSlug: () => activeSlug,
      invalidateEnvelopes: async () => {},
      getEnvelope: async () => null,
      onCompletedLinks: (c) => completedCalls.push(c),
      onCloseDialog: () => {
        closedCount += 1;
      },
      navigateToEnvelope: async (slug, envelopeId) => {
        navCalls.push({ slug, envelopeId });
      },
    });
    expect(navOutcome).toBe('navigated');
    expect(closedCount).toBe(1);
    expect(navCalls).toEqual([{ slug: 'acme', envelopeId: '01900000-0000-7000-8000-000000000704' }]);
  });

  it('renders detailQuery.error with a retry button before selectPrompt when loading a selected template fails (#3566)', async () => {
    const detail = makeTemplateDetail();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
    qc.setQueryData(['sign', 'templates', 'list', 'all', ''], {
      items: [
        {
          id: detail.template.id,
          title: detail.template.title,
          description: detail.template.description,
          routingMode: detail.template.routingMode,
          subject: null,
          message: null,
          expiresInHours: 168,
          status: 'active',
          inspectStatus: 'passed',
          inspectError: null,
          pageCount: 1,
          roleCount: 2,
          nonCcRoleCount: 1,
          fieldCount: 1,
          directLink: null,
          version: 1,
          archivedAt: null,
          createdAt: detail.template.createdAt,
          updatedAt: detail.template.updatedAt,
        },
      ],
    });
    await qc
      .fetchQuery({
        queryKey: ['sign', 'templates', 'detail', detail.template.id],
        queryFn: () => Promise.reject(new Error('Template fetch failed')),
      })
      .catch(() => {});

    const viHtml = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <IntlProvider locale="vi" timeZone="Asia/Ho_Chi_Minh" messages={catalog('vi')}>
          <SignTemplatesPage />
        </IntlProvider>
      </QueryClientProvider>,
    );
    assertPairedLabels(viHtml);
    expect(viHtml).toContain('data-testid="sign-tpl-detail-error"');
    expect(viHtml).toContain('Template fetch failed');
    expect(viHtml).toContain('data-testid="sign-tpl-detail-retry-btn"');
    expect(viHtml).toContain('Thử lại');
    expect(viHtml).not.toContain(catalog('vi').sign.templates.selectPrompt);

    const enHtml = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <IntlProvider locale="en" timeZone="Asia/Ho_Chi_Minh" messages={catalog('en')}>
          <SignTemplatesPage />
        </IntlProvider>
      </QueryClientProvider>,
    );
    expect(enHtml).toContain('Try again');
    expect(enHtml).not.toContain(catalog('en').sign.templates.selectPrompt);
  });

  it('uses <Button loading> with constant action labels across create, instantiate, and rotate buttons (#3566)', () => {
    const detail = makeTemplateDetail();
    const dummyFile = new File(['%PDF-1.4'], 'sample.pdf', { type: 'application/pdf' });

    for (const [locale, expectedCreate, expectedInst, expectedRotate] of [
      ['vi', 'Tạo mẫu', 'Tạo hồ sơ ký', 'Tạo lại liên kết mới'],
      ['en', 'Create template', 'Create envelope', 'Rotate link'],
    ] as const) {
      const createIdle = renderToStaticMarkup(
        <IntlProvider locale={locale} timeZone="Asia/Ho_Chi_Minh" messages={catalog(locale)}>
          <CreateTemplateForm
            title="Mau A"
            description=""
            routingMode="parallel"
            subject=""
            message=""
            file={dummyFile}
            error={null}
            pending={false}
            onChangeTitle={() => {}}
            onChangeDescription={() => {}}
            onChangeRoutingMode={() => {}}
            onChangeSubject={() => {}}
            onChangeMessage={() => {}}
            onChangeFile={() => {}}
            onSubmit={() => {}}
          />
        </IntlProvider>,
      );
      const createBusy = renderToStaticMarkup(
        <IntlProvider locale={locale} timeZone="Asia/Ho_Chi_Minh" messages={catalog(locale)}>
          <CreateTemplateForm
            title="Mau A"
            description=""
            routingMode="parallel"
            subject=""
            message=""
            file={dummyFile}
            error={null}
            pending={true}
            onChangeTitle={() => {}}
            onChangeDescription={() => {}}
            onChangeRoutingMode={() => {}}
            onChangeSubject={() => {}}
            onChangeMessage={() => {}}
            onChangeFile={() => {}}
            onSubmit={() => {}}
          />
        </IntlProvider>,
      );
      assertPairedLabels(createIdle);
      assertPairedLabels(createBusy);
      expect(createIdle).toContain(expectedCreate);
      expect(createBusy).toContain(expectedCreate);
      expect(createBusy).toContain('data-loading=""');
      expect(createBusy).toContain('aria-busy="true"');

      const instBusy = renderToStaticMarkup(
        <IntlProvider locale={locale} timeZone="Asia/Ho_Chi_Minh" messages={catalog(locale)}>
          <InstantiateTemplateForm
            roles={detail.roles}
            title="Hop dong moi"
            recipients={{}}
            autoSend={false}
            autoSendAllowed={true}
            error={null}
            pending={true}
            onChangeTitle={() => {}}
            onChangeRecipient={() => {}}
            onChangeAutoSend={() => {}}
            onSubmit={() => {}}
          />
        </IntlProvider>,
      );
      assertPairedLabels(instBusy);
      expect(instBusy).toContain(expectedInst);
      expect(instBusy).toContain('data-loading=""');
      expect(instBusy).toContain('aria-busy="true"');

      const rotateBusy = renderToStaticMarkup(
        <IntlProvider locale={locale} timeZone="Asia/Ho_Chi_Minh" messages={catalog(locale)}>
          <DirectLinkCard
            detail={detail}
            freshDirectUrl="https://app.ludy.vn/-/sign/d#freshDirectToken000000000000000000000001"
            pending={true}
            rotating={true}
            onToggleEnabled={() => {}}
            onToggleOtp={() => {}}
            onRotate={() => {}}
            onCopyUrl={() => {}}
          />
        </IntlProvider>,
      );
      assertPairedLabels(rotateBusy);
      expect(rotateBusy).toContain(expectedRotate);
      expect(rotateBusy).toContain('data-loading=""');
      expect(rotateBusy).toContain('aria-busy="true"');
      expect(rotateBusy).toMatch(/<button[^>]*max-sm:min-h-11[^>]*>/);
    }
  });
});
