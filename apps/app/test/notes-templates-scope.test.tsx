// SPDX-License-Identifier: AGPL-3.0-only
// UI tests for note template org-scope visibility gating in branch-scoped writer sessions (#4725).
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_TIME_ZONE } from '@ludy/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';

const testState = vi.hoisted(() => ({
  client: null as unknown as import('@tanstack/react-query').QueryClient,
}));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  testState.client = new QC({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions')
          return (opts?: { input?: unknown }) => ({
            queryKey: [...path, opts?.input ?? {}],
            queryFn: () => Promise.reject(new Error('not fetched')),
          });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  const api = node([]);
  return {
    orpc: api,
    client: api,
    clientForOrg: () => api,
    queryClient: testState.client,
    errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  };
});

vi.mock('../src/i18n/provider.tsx', () => ({
  useFormat: () => ({
    date: (v: string) => v.slice(0, 10),
    dateTime: (v: string) => v,
    number: (v: number | bigint | string) => String(v),
  }),
  useLocaleSetting: () => ({ locale: 'vi', setLocale: () => undefined }),
}));

const {
  TemplateFormFields,
  isEditNoteTemplateVisibilityBlocked,
  isNoteTemplateVisibilityBlocked,
  resolveTemplateInitialVisibility,
  resolveTemplateOrgScope,
} = await import('../src/components/note-templates-history.tsx');

function renderFields(opts: {
  visibility: 'private' | 'org';
  orgScope: 'loading' | 'error' | 'whole_org' | 'branch_only';
  canChangeVisibility?: boolean;
  idPrefix?: string;
}) {
  return renderToStaticMarkup(
    <QueryClientProvider client={testState.client}>
      <IntlProvider locale="vi" timeZone={DEFAULT_TIME_ZONE} messages={catalog('vi')}>
        <TemplateFormFields
          form={{
            name: 'Mẫu thử',
            title: '',
            body: '',
            tags: '',
            visibility: opts.visibility,
          }}
          onChange={() => undefined}
          canChangeVisibility={opts.canChangeVisibility ?? true}
          orgScope={opts.orgScope}
          onRetryOrgScope={() => undefined}
          disabled={false}
          idPrefix={opts.idPrefix ?? 'note-template-test'}
        />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('note template org-scope visibility selector (#4725)', () => {
  it('distinguishes loading, error, whole_org, and confirmed branch_only states', () => {
    expect(resolveTemplateOrgScope({ isPending: true })).toBe('loading');
    expect(resolveTemplateOrgScope({ isError: true })).toBe('error');
    expect(resolveTemplateOrgScope({ isError: true, data: { wholeOrgScope: true } })).toBe('error');
    expect(resolveTemplateOrgScope({ isPending: false, data: {} })).toBe('error');
    expect(resolveTemplateOrgScope({ data: {} })).toBe('error');
    expect(resolveTemplateOrgScope({ data: { wholeOrgScope: true } })).toBe('whole_org');
    expect(resolveTemplateOrgScope({ data: { wholeOrgScope: false } })).toBe('branch_only');
  });

  it('defaults non-whole-org save-as-template visibility to private until whole_org is confirmed', () => {
    expect(resolveTemplateInitialVisibility('org', 'branch_only')).toBe('private');
    expect(resolveTemplateInitialVisibility('org', 'loading')).toBe('private');
    expect(resolveTemplateInitialVisibility('org', 'error')).toBe('private');
    expect(resolveTemplateInitialVisibility('private', 'branch_only')).toBe('private');
    expect(resolveTemplateInitialVisibility('org', 'whole_org')).toBe('org');
    expect(resolveTemplateInitialVisibility('private', 'whole_org')).toBe('private');
  });

  it('blocks saving as org unless whole_org scope is confirmed', () => {
    expect(isNoteTemplateVisibilityBlocked('org', 'branch_only')).toBe(true);
    expect(isNoteTemplateVisibilityBlocked('org', 'loading')).toBe(true);
    expect(isNoteTemplateVisibilityBlocked('org', 'error')).toBe(true);
    expect(isNoteTemplateVisibilityBlocked('private', 'branch_only')).toBe(false);
    expect(isNoteTemplateVisibilityBlocked('private', 'loading')).toBe(false);
    expect(isNoteTemplateVisibilityBlocked('private', 'error')).toBe(false);
    expect(isNoteTemplateVisibilityBlocked('org', 'whole_org')).toBe(false);
    expect(isNoteTemplateVisibilityBlocked('private', 'whole_org')).toBe(false);

    // Non-author admin editing someone else's org template always sends 'org', so non-whole_org scope blocks submit (#4725).
    expect(isEditNoteTemplateVisibilityBlocked(false, 'org', 'branch_only')).toBe(true);
    expect(isEditNoteTemplateVisibilityBlocked(false, 'org', 'loading')).toBe(true);
    expect(isEditNoteTemplateVisibilityBlocked(false, 'org', 'error')).toBe(true);
    expect(isEditNoteTemplateVisibilityBlocked(false, 'private', 'error')).toBe(true);
    expect(isEditNoteTemplateVisibilityBlocked(false, 'org', 'whole_org')).toBe(false);
    expect(isEditNoteTemplateVisibilityBlocked(true, 'private', 'error')).toBe(false);
  });

  it('shows narrowed hint and scope retry when editing a shared template without visibility select (#4725)', () => {
    const nonAuthorOrgError = renderFields({
      canChangeVisibility: false,
      visibility: 'org',
      orgScope: 'error',
      idPrefix: 'note-template-edit',
    });
    expect(nonAuthorOrgError).not.toContain('note-template-edit-visibility"');
    expect(nonAuthorOrgError).toContain('data-testid="note-template-edit-visibility-scope-retry"');
    expect(nonAuthorOrgError).toContain('md:min-h-0');

    const nonAuthorOrgNarrowed = renderFields({
      canChangeVisibility: false,
      visibility: 'org',
      orgScope: 'branch_only',
      idPrefix: 'note-template-edit',
    });
    expect(nonAuthorOrgNarrowed).toContain('data-testid="note-template-edit-visibility-narrowed-hint"');
    expect(nonAuthorOrgNarrowed).toContain('mẫu dùng chung của người khác');
    expect(nonAuthorOrgNarrowed).not.toContain('hãy đổi phạm vi');

    const nonAuthorPrivateError = renderFields({
      canChangeVisibility: false,
      visibility: 'private',
      orgScope: 'error',
      idPrefix: 'note-template-edit',
    });
    expect(nonAuthorPrivateError).not.toContain('note-template-edit-visibility-scope-error');
  });

  it('shows enabled org option only for confirmed whole-org writers and hides it otherwise', () => {
    const wholeOrgHtml = renderFields({ visibility: 'private', orgScope: 'whole_org' });
    expect(wholeOrgHtml).toMatch(/<option[^>]*value="private"[^>]*>/);
    expect(wholeOrgHtml).toMatch(/<option[^>]*value="org"[^>]*>/);
    expect(wholeOrgHtml).not.toMatch(/<option[^>]*value="org"[^>]*disabled/);
    expect(wholeOrgHtml).not.toContain('visibility-narrowed-hint');

    for (const scope of ['branch_only', 'loading', 'error'] as const) {
      const restrictedHtml = renderFields({ visibility: 'private', orgScope: scope });
      expect(restrictedHtml).toMatch(/<option[^>]*value="private"[^>]*>/);
      expect(restrictedHtml).not.toContain('value="org"');
      expect(restrictedHtml).not.toContain('visibility-narrowed-hint');
    }
  });

  it('shows narrowed hint only on confirmed branch_only and shows retry on scope load error', () => {
    const branchScopedExistingOrgHtml = renderFields({ visibility: 'org', orgScope: 'branch_only', idPrefix: 'note-template-edit' });
    expect(branchScopedExistingOrgHtml).toMatch(/<option[^>]*value="private"[^>]*>/);
    expect(branchScopedExistingOrgHtml).toMatch(/<option[^>]*value="org"[^>]*disabled/);
    expect(branchScopedExistingOrgHtml).toContain('data-testid="note-template-edit-visibility-narrowed-hint"');

    const loadingExistingOrgHtml = renderFields({ visibility: 'org', orgScope: 'loading', idPrefix: 'note-template-edit' });
    expect(loadingExistingOrgHtml).toMatch(/<option[^>]*value="org"[^>]*disabled/);
    expect(loadingExistingOrgHtml).not.toContain('visibility-narrowed-hint');
    expect(loadingExistingOrgHtml).toContain('data-testid="note-template-edit-visibility-scope-loading"');

    const errorExistingOrgHtml = renderFields({ visibility: 'org', orgScope: 'error', idPrefix: 'note-template-edit' });
    expect(errorExistingOrgHtml).toMatch(/<option[^>]*value="org"[^>]*disabled/);
    expect(errorExistingOrgHtml).not.toContain('visibility-narrowed-hint');
    expect(errorExistingOrgHtml).toContain('data-testid="note-template-edit-visibility-scope-retry"');
    expect(errorExistingOrgHtml).toContain('min-h-11');
    expect(errorExistingOrgHtml).toContain('md:min-h-0');
    expect(errorExistingOrgHtml).not.toContain('sm:min-h-0');
  });
});
