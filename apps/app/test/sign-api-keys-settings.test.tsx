// SPDX-License-Identifier: AGPL-3.0-only
// Component, RBAC gate, one-time secret banner, MFA step-up prompt, and accessibility tests for SignApiKeysView (#4441, Slice 5c).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';
import type { SignApiKeyRecord } from '../src/lib/sign-api.ts';

interface HookState {
  inTarget: boolean;
  stateIdx: number;
  states: unknown[];
  effectIdx: number;
  effects: Array<{ deps?: unknown[]; cleanup?: () => void }>;
  mutationIdx: number;
  mutationResets: Array<() => void>;
  resetCalls: number;
  secretClearedCalls: number;
}

const hookDriver = vi.hoisted(
  (): HookState => ({
    inTarget: false,
    stateIdx: 0,
    states: [],
    effectIdx: 0,
    effects: [],
    mutationIdx: 0,
    mutationResets: [],
    resetCalls: 0,
    secretClearedCalls: 0,
  }),
);

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: (<S,>(initial?: S | (() => S)) => {
      if (!hookDriver.inTarget) return actual.useState(initial as S);
      const idx = hookDriver.stateIdx++;
      if (idx >= hookDriver.states.length) {
        hookDriver.states.push(typeof initial === 'function' ? (initial as () => S)() : initial);
      }
      const setState = (val: S | ((prev: S) => S)) => {
        const next = typeof val === 'function' ? (val as (p: S) => S)(hookDriver.states[idx] as S) : val;
        if (idx === 0 && next === null) hookDriver.secretClearedCalls += 1;
        hookDriver.states[idx] = next;
      };
      return [hookDriver.states[idx] as S, setState];
    }) as typeof actual.useState,
    useEffect: ((effect: () => void | (() => void), deps?: unknown[]) => {
      if (!hookDriver.inTarget) return actual.useEffect(effect, deps);
      const idx = hookDriver.effectIdx++;
      const prev = hookDriver.effects[idx];
      const changed =
        !prev ||
        !deps ||
        !prev.deps ||
        deps.length !== prev.deps.length ||
        deps.some((d, i) => !Object.is(d, prev.deps![i]));
      if (changed) {
        prev?.cleanup?.();
        const cleanup = effect();
        hookDriver.effects[idx] = {
          ...(deps !== undefined ? { deps } : {}),
          ...(typeof cleanup === 'function' ? { cleanup } : {}),
        };
      }
    }) as typeof actual.useEffect,
  };
});

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQuery: ((opts: Parameters<typeof actual.useQuery>[0]) => {
      if (!hookDriver.inTarget) return actual.useQuery(opts);
      return { data: { items: [] }, isLoading: false, error: null };
    }) as typeof actual.useQuery,
    useMutation: ((opts: Parameters<typeof actual.useMutation>[0]) => {
      if (!hookDriver.inTarget) return actual.useMutation(opts);
      const idx = hookDriver.mutationIdx++;
      const reset = (hookDriver.mutationResets[idx] ??= () => {
        if (idx === 0) hookDriver.resetCalls += 1;
      });
      return {
        isPending: false,
        error: null,
        variables: undefined,
        mutate: vi.fn(),
        reset,
      };
    }) as typeof actual.useMutation,
  };
});

const { SignApiKeysSection, SignApiKeysView, computeApiKeyExpiresAt } = await import(
  '../src/routes/sign-settings.tsx'
);

vi.mock('../src/lib/auth.ts', () => ({
  auth: () => ({ mfa: { listFactors: () => Promise.reject(new Error('not fetched')) } }),
  authErrorText: (e: unknown) => String(e),
  authFailure: (e: unknown) => e,
  verifySecondFactor: () => Promise.reject(new Error('not called')),
}));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  return {
    orpc: {},
    queryClient: new QC(),
    client: {},
    errorMessage: (e: unknown) => String(e),
    isStepUpRequired: (e: unknown) => Boolean(e && typeof e === 'object' && (e as { code?: string }).code === 'STEP_UP_REQUIRED'),
  };
});

function assertPairedLabels(html: string): void {
  const labelForMatches = new Set(Array.from(html.matchAll(/<label[^>]+for="([^"]+)"/g), (m) => m[1]!));
  for (const tagMatch of html.matchAll(/<(input|select|textarea)\b[^>]*>/g)) {
    const tag = tagMatch[0];
    if (tag.includes('type="hidden"')) continue;
    const idMatch = tag.match(/\bid="([^"]+)"/);
    expect(idMatch, `control missing id: ${tag}`).not.toBeNull();
    expect(labelForMatches.has(idMatch![1]!), `control missing paired <label for="${idMatch![1]}">`).toBe(true);
  }
}

function makeKey(overrides: Partial<SignApiKeyRecord> = {}): SignApiKeyRecord {
  return {
    id: '01950000-0000-7000-8000-000000000010',
    name: 'ERP Integration',
    keyPrefix: 'ludy_sk_aaaaaaaa',
    scopes: ['sign:read', 'sign:draft'],
    createdBy: '01950000-0000-7000-8000-000000000001',
    expiresAt: '2027-06-01T00:00:00.000Z',
    revokedAt: null,
    lastUsedAt: '2026-11-22T10:00:00.000Z',
    createdAt: '2026-11-20T08:00:00.000Z',
    updatedAt: '2026-11-22T10:00:00.000Z',
    ...overrides,
  };
}

function renderKeys(
  locale: 'vi' | 'en',
  role: string | null,
  items: readonly SignApiKeyRecord[],
  createdSecret: string | null = null,
  createError: unknown = null,
): string {
  const qc = new QueryClient();
  qc.setQueryData(['auth', 'factors'], {
    totp: [{ id: 'factor-1', factor_type: 'totp', status: 'verified' }],
    all: [],
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale={locale} messages={catalog(locale)} timeZone="Asia/Ho_Chi_Minh">
        <SignApiKeysView
          role={role}
          items={items}
          createdSecret={createdSecret}
          createError={createError}
          onCreate={() => {}}
          onStepUpVerified={() => {}}
          onStepUpCancel={() => {}}
          onDismissSecret={() => {}}
          onRevoke={() => {}}
        />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('SignApiKeysView (/o/$slug/sign/settings, #4441)', () => {
  it('computes deterministic ISO expiry timestamps for presets and null for no-expiry', () => {
    const base = Date.UTC(2026, 10, 22, 0, 0, 0);
    expect(computeApiKeyExpiresAt('none', base)).toBeNull();
    expect(computeApiKeyExpiresAt('30d', base)).toBe('2026-12-22T00:00:00.000Z');
    expect(computeApiKeyExpiresAt('90d', base)).toBe('2027-02-20T00:00:00.000Z');
    expect(computeApiKeyExpiresAt('365d', base)).toBe('2027-11-22T00:00:00.000Z');
  });

  it('renders create form, paired accessible labels, 44px touch targets, and one-time secret banner for owners and admins', () => {
    const secret = `ludy_sk_${'a'.repeat(40)}`;
    const revokedKey = makeKey({
      id: '01950000-0000-7000-8000-000000000011',
      name: 'Old Webhook Script',
      keyPrefix: 'ludy_sk_bbbbbbbb',
      scopes: ['sign:read'],
      revokedAt: '2026-11-21T12:00:00.000Z',
    });

    for (const [locale, role] of [
      ['vi', 'owner'],
      ['en', 'admin'],
    ] as const) {
      const html = renderKeys(locale, role, [makeKey(), revokedKey], secret);
      expect(html).toContain('data-testid="sign-api-keys-section"');
      expect(html).toContain('data-testid="sign-api-key-secret-banner"');
      expect(html).toContain(secret);
      expect(html).toContain('data-testid="sign-api-key-copy-btn"');
      expect(html).toContain('data-testid="sign-api-key-dismiss-btn"');
      expect(html).toContain('data-testid="sign-api-key-create-form"');
      expect(html).toContain('data-testid="sign-api-key-scope-read"');
      expect(html).toContain('data-testid="sign-api-key-scope-draft"');
      expect(html).toContain('ludy_sk_aaaaaaaa...');
      expect(html).toContain('sign:read');
      expect(html).toContain('sign:draft');
      expect(html).toContain('data-testid="sign-api-key-revoke-btn-01950000-0000-7000-8000-000000000010"');
      expect(html).not.toContain('data-testid="sign-api-key-revoke-btn-01950000-0000-7000-8000-000000000011"');
      expect(html).toContain('min-h-11');
      assertPairedLabels(html);
    }
  });

  it('hides API key controls and key list from members and viewers, showing a read-only notice instead', () => {
    for (const role of ['member', 'viewer', null] as const) {
      const hiddenSecret = `ludy_sk_${'c'.repeat(40)}`;
      const html = renderKeys('vi', role, [makeKey()], hiddenSecret);
      expect(html).toContain('data-testid="sign-api-keys-readonly-notice"');
      expect(html).not.toContain('data-testid="sign-api-key-create-form"');
      expect(html).not.toContain('data-testid="sign-api-key-list"');
      expect(html).not.toContain(hiddenSecret);
      expect(html).not.toContain('ludy_sk_aaaaaaaa');
      expect(html).not.toContain('<input');
    }
  });

  it('renders StepUpPrompt outside the create form on STEP_UP_REQUIRED and hides it otherwise', () => {
    const noErrorHtml = renderKeys('vi', 'owner', [], null, null);
    expect(noErrorHtml).not.toContain('data-testid="sign-api-key-step-up"');

    const otherErrorHtml = renderKeys('en', 'owner', [], null, { code: 'SIGN_API_KEY_LIMIT_REACHED' });
    expect(otherErrorHtml).not.toContain('data-testid="sign-api-key-step-up"');

    for (const [locale, expectedAction, expectedTitle, expectedCancel] of [
      ['vi', 'tạo khóa API tích hợp eSign', 'Xác thực lại để tiếp tục', 'Hủy thao tác'],
      ['en', 'create an eSign API key', 'Verify again to continue', 'Cancel'],
    ] as const) {
      const html = renderKeys(locale, 'owner', [], null, { code: 'STEP_UP_REQUIRED' });
      expect(html).toContain('data-testid="sign-api-key-step-up"');
      expect(html).toContain(expectedAction);
      expect(html).toContain(expectedTitle);
      expect(html).toContain(expectedCancel);
      expect(html).toContain('pattern="[0-9]{6}"');
      const formCloseIdx = html.indexOf('</form>');
      const stepUpIdx = html.indexOf('data-testid="sign-api-key-step-up"');
      expect(formCloseIdx).toBeGreaterThan(-1);
      expect(stepUpIdx).toBeGreaterThan(formCloseIdx);
    }
  });

  it('calls createMutation.reset() alongside clearing createdSecret when workspace slug changes (#4510)', () => {
    hookDriver.states = [];
    hookDriver.effects = [];
    hookDriver.mutationResets = [];
    hookDriver.resetCalls = 0;
    hookDriver.secretClearedCalls = 0;

    const renderSection = (slug: string) => {
      hookDriver.inTarget = true;
      hookDriver.stateIdx = 0;
      hookDriver.effectIdx = 0;
      hookDriver.mutationIdx = 0;
      try {
        return renderToStaticMarkup(
          <QueryClientProvider client={new QueryClient()}>
            <IntlProvider locale="en" messages={catalog('en')} timeZone="Asia/Ho_Chi_Minh">
              <SignApiKeysSection slug={slug} role="owner" />
            </IntlProvider>
          </QueryClientProvider>,
        );
      } finally {
        hookDriver.inTarget = false;
      }
    };

    renderSection('org-one');
    expect(hookDriver.resetCalls).toBe(1);
    expect(hookDriver.secretClearedCalls).toBe(1);

    // Same slug re-render should not re-trigger reset.
    renderSection('org-one');
    expect(hookDriver.resetCalls).toBe(1);

    // Switching workspace slug resets both createdSecret and createMutation state.
    renderSection('org-two');
    expect(hookDriver.resetCalls).toBe(2);
    expect(hookDriver.secretClearedCalls).toBe(2);
  });
});
