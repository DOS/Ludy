// SPDX-License-Identifier: AGPL-3.0-only
// UI rendering, accessibility, RBAC, and i18n copy tests for SME contract playbook (Slice 5d, #4442).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viCatalog } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';
import type { SignPlaybookGetResult, SignPlaybookRulesListResult } from '../src/lib/sign-api.ts';

interface DrivenMutationSlot {
  isPending: boolean;
  error: unknown;
  variables: unknown;
  inFlight: Promise<void> | null;
}

const cache = vi.hoisted(() => ({ current: null as unknown as QueryClient }));
const invalidateQueriesSpy = vi.hoisted(() => vi.fn());
const toastSpy = vi.hoisted(() => vi.fn());
const hookDriver = vi.hoisted(() => ({
  inTargetComponent: false,
  states: [] as unknown[],
  stateCursor: 0,
  mutations: [] as DrivenMutationSlot[],
  mutationCursor: 0,
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: (<S,>(initialState?: S | (() => S)) => {
      if (!hookDriver.inTargetComponent) return actual.useState(initialState as S);
      const idx = hookDriver.stateCursor++;
      if (idx >= hookDriver.states.length) {
        hookDriver.states.push(typeof initialState === 'function' ? (initialState as () => S)() : initialState);
      }
      const setState = (action: S | ((prev: S) => S)) => {
        const prev = hookDriver.states[idx] as S;
        hookDriver.states[idx] = typeof action === 'function' ? (action as (p: S) => S)(prev) : action;
      };
      return [hookDriver.states[idx] as S, setState];
    }) as typeof actual.useState,
  };
});

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQuery: ((options: { queryKey: readonly unknown[] }) => {
      if (!hookDriver.inTargetComponent) {
        return actual.useQuery(options as Parameters<typeof actual.useQuery>[0]);
      }
      return {
        data: cache.current.getQueryData(options.queryKey),
        error: null,
        isPending: false,
      };
    }) as typeof actual.useQuery,
    useMutation: ((options: {
      mutationFn?: (variables: unknown) => Promise<unknown>;
      onSuccess?: (data: unknown, variables: unknown) => Promise<unknown> | unknown;
      onError?: (err: unknown, variables: unknown) => Promise<unknown> | unknown;
    }) => {
      if (!hookDriver.inTargetComponent) {
        return actual.useMutation(options as Parameters<typeof actual.useMutation>[0]);
      }
      const idx = hookDriver.mutationCursor++;
      if (idx >= hookDriver.mutations.length) {
        hookDriver.mutations.push({ isPending: false, error: null, variables: undefined, inFlight: null });
      }
      const slot = hookDriver.mutations[idx]!;
      return {
        isPending: slot.isPending,
        error: slot.error,
        variables: slot.variables,
        reset: () => {
          slot.isPending = false;
          slot.error = null;
          slot.variables = undefined;
        },
        mutate: (variables?: unknown) => {
          slot.isPending = true;
          slot.error = null;
          slot.variables = variables;
          slot.inFlight = (async () => {
            try {
              const data = await options.mutationFn?.(variables);
              await options.onSuccess?.(data, variables);
              slot.isPending = false;
            } catch (err) {
              slot.error = err;
              await options.onError?.(err, variables);
              slot.isPending = false;
            }
          })();
        },
      };
    }) as typeof actual.useMutation,
  };
});

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  cache.current = new QC();
  const origInvalidate = cache.current.invalidateQueries.bind(cache.current);
  cache.current.invalidateQueries = ((...args: Parameters<typeof origInvalidate>) => {
    invalidateQueriesSpy(...args);
    return origInvalidate(...args);
  }) as typeof cache.current.invalidateQueries;
  return {
    orpc: {},
    queryClient: cache.current,
    client: {},
    errorMessage: (e: unknown) => String(e),
    isStepUpRequired: () => false,
    apiFetch: vi.fn(),
    fetchFile: vi.fn(),
    uploadFiles: vi.fn(),
  };
});

vi.mock('../src/lib/toast.ts', () => ({
  toast: toastSpy,
}));

const { signApi } = await import('../src/lib/sign-api.ts');
const { PlaybookRulesCard, parseKeywordsCsv } = await import('../src/components/sign/playbook-rules-card.tsx');
const { EnvelopePlaybookCard } = await import('../src/components/sign/envelope-playbook-card.tsx');

function collectByTestId(
  node: ReactNode,
  testId: string,
  out: ReactElement<Record<string, unknown>>[] = [],
): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) {
    for (const item of node) collectByTestId(item, testId, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  const props = node.props as Record<string, unknown>;
  if (props['data-testid'] === testId) {
    out.push(node as ReactElement<Record<string, unknown>>);
  }
  if (props.children !== undefined) {
    collectByTestId(props.children as ReactNode, testId, out);
  }
  return out;
}

function requireByTestId(
  node: ReactNode,
  testId: string,
  index = 0,
): ReactElement<Record<string, unknown>> {
  const found = collectByTestId(node, testId)[index];
  if (!found) throw new Error(`missing testId ${testId} at index ${index}`);
  return found;
}

function renderInLocale(locale: 'vi' | 'en', node: ReactNode, client = new QueryClient()): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <IntlProvider locale={locale} messages={catalog(locale)} timeZone="Asia/Ho_Chi_Minh">
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
}

const RULE_1_ID = '01900000-0000-4000-8000-000000000101';
const RULE_2_ID = '01900000-0000-4000-8000-000000000102';
const ENV_ID = '01900000-0000-7000-8000-000000000201';
const FILE_ID = '01900000-0000-7000-8000-000000000301';

describe('sign.playbook i18n hygiene (#4442)', () => {
  it('contains zero em dashes or en dashes in English and Vietnamese playbook copy', () => {
    const collectStrings = (obj: Record<string, unknown>): string[] =>
      Object.values(obj).flatMap((v) =>
        typeof v === 'string' ? [v] : v && typeof v === 'object' ? collectStrings(v as Record<string, unknown>) : [],
      );

    for (const [locale, cat] of [
      ['en', en.sign.playbook],
      ['vi', viCatalog.sign.playbook],
    ] as const) {
      for (const str of collectStrings(cat as unknown as Record<string, unknown>)) {
        expect(str, locale).not.toMatch(/[\u2013\u2014]/);
      }
    }
    expect(en.aiMeter.features.sign_playbook_check).not.toMatch(/[\u2013\u2014]/);
    expect(viCatalog.aiMeter.features.sign_playbook_check).not.toMatch(/[\u2013\u2014]/);
  });

  it('deduplicates and trims comma-separated match keywords cleanly', () => {
    expect(parseKeywordsCsv(' phạt vi phạm , 8%, Phạt Vi Phạm,  , điều 301 ')).toEqual([
      'phạt vi phạm',
      '8%',
      'điều 301',
    ]);
  });
});

describe('PlaybookRulesCard (/o/$slug/sign/settings, #4442)', () => {
  const sampleRules: SignPlaybookRulesListResult = {
    canManage: true,
    isSeeded: false,
    items: [
      {
        id: RULE_1_ID,
        title: 'Giới hạn phạt vi phạm tối đa 8%',
        guidance: 'Theo Điều 301 Luật Thương mại 2005, mức phạt không vượt quá 8%.',
        severity: 'critical',
        matchKeywords: ['phạt vi phạm', '8%'],
        active: true,
        isDefault: true,
        createdBy: null,
        createdAt: '2027-01-01T00:00:00.000Z',
        updatedAt: '2027-01-01T00:00:00.000Z',
      },
      {
        id: RULE_2_ID,
        title: 'Thời hạn thanh toán không quá 30 ngày',
        guidance: 'Thanh toán trong vòng 30 ngày.',
        severity: 'warn',
        matchKeywords: ['thanh toán', '30 ngày'],
        active: false,
        isDefault: false,
        createdBy: '01900000-0000-7000-8000-000000000011',
        createdAt: '2027-01-02T00:00:00.000Z',
        updatedAt: '2027-01-02T00:00:00.000Z',
      },
    ],
  };

  it('renders owner/admin management actions with 44px touch targets and hides write controls for members', () => {
    const ownerQc = new QueryClient();
    ownerQc.setQueryData(['sign', 'playbook-rules', 'acme'], sampleRules);
    const ownerHtml = renderInLocale('vi', <PlaybookRulesCard slug="acme" role="owner" />, ownerQc);

    expect(ownerHtml).toContain('data-testid="playbook-add-rule-btn"');
    expect(ownerHtml).toContain('data-testid="playbook-restore-defaults-btn"');
    expect(ownerHtml).toContain(`data-testid="playbook-edit-btn-${RULE_1_ID}"`);
    expect(ownerHtml).toContain(`data-testid="playbook-delete-btn-${RULE_1_ID}"`);
    expect(ownerHtml).toContain('min-h-11');
    expect(ownerHtml).toContain('Mặc định VN SME');
    expect(ownerHtml).not.toContain('data-testid="playbook-readonly-notice"');

    const memberQc = new QueryClient();
    memberQc.setQueryData(['sign', 'playbook-rules', 'acme'], { ...sampleRules, canManage: false });
    const memberHtml = renderInLocale('en', <PlaybookRulesCard slug="acme" role="member" />, memberQc);

    expect(memberHtml).toContain('data-testid="playbook-readonly-notice"');
    expect(memberHtml).not.toContain('data-testid="playbook-add-rule-btn"');
    expect(memberHtml).not.toContain(`data-testid="playbook-edit-btn-${RULE_1_ID}"`);
  });
});

describe('EnvelopePlaybookCard (/o/$slug/sign/envelopes/$id, #4442)', () => {
  const sampleCheck: SignPlaybookGetResult = {
    canEdit: true,
    activeRulesCount: 6,
    check: {
      id: '01900000-0000-7000-8000-000000000401',
      envelopeId: ENV_ID,
      sourceSha256: 'a'.repeat(64),
      revision: 'rev-1',
      isStale: false,
      mode: 'ai',
      promptVersion: 'sign-playbook-v1',
      createdBy: '01900000-0000-7000-8000-000000000011',
      createdAt: '2027-02-01T00:00:00.000Z',
      updatedAt: '2027-02-01T00:00:00.000Z',
      findings: [
        {
          ruleId: RULE_1_ID,
          ruleTitle: 'Giới hạn phạt vi phạm tối đa 8%',
          severity: 'critical',
          verdict: 'fail',
          rationale: 'Mức phạt 15% vượt trần 8% theo Điều 301 Luật Thương mại 2005.',
          pageNumber: 2,
          quoteExcerpt: 'Bên vi phạm chịu mức phạt 15% giá trị hợp đồng.',
          suggestedRedline: 'Mức phạt vi phạm tối đa không vượt quá 8% giá trị phần nghĩa vụ bị vi phạm.',
          proposedByAi: true,
          manualNote: null,
          overriddenBy: null,
          overriddenAt: null,
        },
        {
          ruleId: RULE_2_ID,
          ruleTitle: 'Thời hạn thanh toán không quá 30 ngày',
          severity: 'warn',
          verdict: 'pass',
          rationale: 'Thanh toán trong 15 ngày.',
          pageNumber: 1,
          quoteExcerpt: 'Thanh toán trong vòng 15 ngày.',
          suggestedRedline: null,
          proposedByAi: false,
          manualNote: 'Đã thống nhất với kế toán',
          overriddenBy: '01900000-0000-7000-8000-000000000011',
          overriddenAt: '2027-02-01T01:00:00.000Z',
        },
      ],
    },
  };

  it('renders tainted AI proposal badge, page jump buttons, redline copy button, and accessible override labels', () => {
    const qc = new QueryClient();
    qc.setQueryData(['sign', 'playbook-check', ENV_ID], sampleCheck);
    const html = renderInLocale(
      'vi',
      <EnvelopePlaybookCard
        envelopeId={ENV_ID}
        sourceFileId={FILE_ID}
        inspectStatus="passed"
        pdfBytes={null}
        onJumpToPage={vi.fn()}
      />,
      qc,
    );

    expect(html).toContain('data-testid="playbook-run-rule-btn"');
    expect(html).toContain('data-testid="playbook-run-ai-btn"');
    expect(html).toContain('1 đạt · 0 cần xem · 1 không đạt');
    expect(html).toContain(`data-testid="playbook-ai-badge-${RULE_1_ID}"`);
    expect(html).toContain('Đề xuất');
    expect(html).toContain(`data-testid="playbook-jump-page-${RULE_1_ID}"`);
    expect(html).toContain('Trang 2');
    expect(html).toContain(`data-testid="playbook-copy-redline-${RULE_1_ID}"`);
    expect(html).toContain(`for="playbook-verdict-${RULE_1_ID}"`);
    expect(html).toContain(`for="playbook-note-${RULE_1_ID}"`);
    expect(html).toContain('[&amp;_select]:min-h-11');
    expect(html).toContain('min-w-0 break-words');

    const overriddenAiQc = new QueryClient();
    overriddenAiQc.setQueryData(['sign', 'playbook-check', ENV_ID], {
      ...sampleCheck,
      check: {
        ...sampleCheck.check!,
        mode: 'manual',
        findings: [
          {
            ...sampleCheck.check!.findings[0]!,
            verdict: 'pass',
            overriddenBy: '01900000-0000-7000-8000-000000000011',
            overriddenAt: '2027-02-01T02:00:00.000Z',
          },
        ],
      },
    });
    const overriddenAiHtml = renderInLocale(
      'en',
      <EnvelopePlaybookCard
        envelopeId={ENV_ID}
        sourceFileId={FILE_ID}
        inspectStatus="passed"
        pdfBytes={null}
        onJumpToPage={vi.fn()}
      />,
      overriddenAiQc,
    );
    expect(overriddenAiHtml).toContain(`data-testid="playbook-ai-badge-${RULE_1_ID}"`);
    expect(overriddenAiHtml).toContain(`data-testid="playbook-overridden-badge-${RULE_1_ID}"`);
    expect(overriddenAiHtml).toContain('Proposed');
    expect(overriddenAiHtml).toContain('Human verified');

    const viewerQc = new QueryClient();
    viewerQc.setQueryData(['sign', 'playbook-check', ENV_ID], { ...sampleCheck, canEdit: false });
    const viewerHtml = renderInLocale(
      'en',
      <EnvelopePlaybookCard
        envelopeId={ENV_ID}
        sourceFileId={FILE_ID}
        inspectStatus="passed"
        pdfBytes={null}
        onJumpToPage={vi.fn()}
      />,
      viewerQc,
    );

    expect(viewerHtml).not.toContain('data-testid="playbook-run-rule-btn"');
    expect(viewerHtml).not.toContain(`data-testid="playbook-override-save-${RULE_1_ID}"`);
    expect(viewerHtml).toContain(`data-testid="playbook-jump-page-${RULE_1_ID}"`);
    expect(viewerHtml).toContain('Đã thống nhất với kế toán');
  });

  describe('overrideDrafts optimistic lock & lifecycle', () => {
    beforeEach(() => {
      cache.current.clear();
      invalidateQueriesSpy.mockReset();
      toastSpy.mockReset();
      hookDriver.inTargetComponent = false;
      hookDriver.states = [];
      hookDriver.stateCursor = 0;
      hookDriver.mutations = [];
      hookDriver.mutationCursor = 0;
    });

    it('locks draft checkRevision across background refetches, clears saved draft on success, and resets drafts on SIGN_PLAYBOOK_STALE_CHECK', async () => {
      const overrideSpy = vi.spyOn(signApi, 'overridePlaybookFinding').mockResolvedValue(sampleCheck.check!);

      let capturedTree: ReactNode = null;
      function Probe(props: Parameters<typeof EnvelopePlaybookCard>[0]) {
        hookDriver.inTargetComponent = true;
        hookDriver.stateCursor = 0;
        hookDriver.mutationCursor = 0;
        try {
          const rendered = EnvelopePlaybookCard(props);
          capturedTree = rendered;
          return rendered;
        } finally {
          hookDriver.inTargetComponent = false;
        }
      }

      const renderProbe = (locale: 'vi' | 'en' = 'vi') =>
        renderInLocale(
          locale,
          <Probe
            envelopeId={ENV_ID}
            sourceFileId={FILE_ID}
            inspectStatus="passed"
            pdfBytes={null}
            onJumpToPage={vi.fn()}
          />,
          cache.current,
        );

      // 1. Open draft on rev-1 for RULE_1_ID and modify both verdict and note.
      cache.current.setQueryData(['sign', 'playbook-check', ENV_ID], sampleCheck);
      renderProbe();

      (requireByTestId(capturedTree, `playbook-override-select-${RULE_1_ID}`).props.onChange as (e: {
        target: { value: string };
      }) => void)({ target: { value: 'pass' } });

      renderProbe();
      (requireByTestId(capturedTree, `playbook-override-note-${RULE_1_ID}`).props.onChange as (e: {
        target: { value: string };
      }) => void)({ target: { value: 'Approved after legal call' } });

      // 2. Simulate background refetch rotating check.revision from rev-1 -> rev-2 while draft is open.
      const rev2Check: SignPlaybookGetResult = {
        ...sampleCheck,
        check: {
          ...sampleCheck.check!,
          revision: 'rev-2',
          findings: [
            {
              ...sampleCheck.check!.findings[0]!,
              verdict: 'warn',
              manualNote: 'Server rev-2 note',
            },
            sampleCheck.check!.findings[1]!,
          ],
        },
      };
      cache.current.setQueryData(['sign', 'playbook-check', ENV_ID], rev2Check);
      renderProbe();

      // Draft still displays unsaved user edits AND keeps original checkRevision ('rev-1').
      expect(requireByTestId(capturedTree, `playbook-override-select-${RULE_1_ID}`).props.value).toBe('pass');
      expect(requireByTestId(capturedTree, `playbook-override-note-${RULE_1_ID}`).props.value).toBe(
        'Approved after legal call',
      );

      (requireByTestId(capturedTree, `playbook-override-save-${RULE_1_ID}`).props.onClick as () => void)();
      const overrideSlot = hookDriver.mutations[1]!;
      await overrideSlot.inFlight;

      expect(overrideSpy).toHaveBeenCalledTimes(1);
      expect(overrideSpy).toHaveBeenLastCalledWith({
        envelopeId: ENV_ID,
        ruleId: RULE_1_ID,
        checkRevision: 'rev-1',
        verdict: 'pass',
        manualNote: 'Approved after legal call',
      });
      expect(invalidateQueriesSpy).toHaveBeenCalledWith({ queryKey: ['sign', 'playbook-check', ENV_ID] });

      // 3. After save resolves, RULE_1_ID's draft was deleted so server rev-2 values show without masking.
      renderProbe();
      expect(requireByTestId(capturedTree, `playbook-override-select-${RULE_1_ID}`).props.value).toBe('warn');
      expect(requireByTestId(capturedTree, `playbook-override-note-${RULE_1_ID}`).props.value).toBe(
        'Server rev-2 note',
      );

      // 4. Open drafts on RULE_1_ID and RULE_2_ID, then simulate 409 SIGN_PLAYBOOK_STALE_CHECK error.
      (requireByTestId(capturedTree, `playbook-override-note-${RULE_2_ID}`).props.onChange as (e: {
        target: { value: string };
      }) => void)({ target: { value: 'Unsaved rule 2 note' } });
      renderProbe();
      (requireByTestId(capturedTree, `playbook-override-select-${RULE_1_ID}`).props.onChange as (e: {
        target: { value: string };
      }) => void)({ target: { value: 'fail' } });
      renderProbe();

      overrideSpy.mockRejectedValueOnce(
        Object.assign(new Error('Check changed concurrently'), {
          code: 'SIGN_PLAYBOOK_STALE_CHECK',
          status: 409,
        }),
      );
      invalidateQueriesSpy.mockClear();

      (requireByTestId(capturedTree, `playbook-override-save-${RULE_1_ID}`).props.onClick as () => void)();
      await overrideSlot.inFlight;

      expect(toastSpy).toHaveBeenCalledWith(expect.any(String), 'error');
      expect(invalidateQueriesSpy).toHaveBeenCalledWith({ queryKey: ['sign', 'playbook-check', ENV_ID] });

      renderProbe();
      expect(requireByTestId(capturedTree, `playbook-override-select-${RULE_1_ID}`).props.value).toBe('warn');
      expect(requireByTestId(capturedTree, `playbook-override-note-${RULE_2_ID}`).props.value).toBe(
        'Đã thống nhất với kế toán',
      );
      overrideSpy.mockRestore();
    });
  });
});
