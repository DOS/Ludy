// SPDX-License-Identifier: AGPL-3.0-only
// Client helpers and SSR checks for Projects Public Roadmap Portal & Moderation Panel (#4399, ADR-0057).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { RoadmapBoardDetailResult, RoadmapBoardListResult } from '@ludy/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';
import {
  forgetRoadmapVoterToken,
  loadRoadmapVoterToken,
  readRoadmapUnsubscribeTokenFromHash,
  rememberRoadmapVoterToken,
} from '../src/lib/roadmap-api.ts';

const authState = vi.hoisted(() => ({ modules: ['projects', 'notes'] as string[] }));

vi.mock('../src/lib/auth.ts', () => ({
  getConfig: () => ({ modules: authState.modules }),
  accessToken: () => null,
}));

const queryClientState = vi.hoisted(() => ({ current: null as unknown as QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  queryClientState.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') {
          return (args?: { input?: unknown }) => ({
            queryKey: [...path, args?.input ?? {}],
            queryFn: () => Promise.reject(new Error('not fetched in unit test')),
          });
        }
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'call') return () => Promise.resolve({});
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { clientForOrg: () => node([]), orpc: node([]), queryClient: queryClientState.current, errorMessage: String };
});

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    useParams: () => ({ slug: 'demo-org', orgSlug: 'demo-org', boardSlug: 'roadmap', id: '00000000-0000-4000-8000-000000000001' }),
    useNavigate: () => () => Promise.resolve(),
    Link: ({ children, to, ...rest }: { children?: ReactNode; to: string; 'data-testid'?: string; className?: string }) =>
      createElement('a', { href: to, 'data-testid': rest['data-testid'], className: rest.className }, children),
  };
});

const { ProjectRoadmapPanel } = await import('../src/components/project-roadmap-panel.tsx');
const { SafeRoadmapMarkdown } = await import('../src/components/roadmap-markdown.tsx');
const { PublicRoadmapPage, initialRoadmapTab, isRoadmapEmbedQuery } = await import('../src/routes/public-roadmap.tsx');
const { ProjectsPage } = await import('../src/routes/projects.tsx');

const wrap = (locale: 'vi' | 'en', node: ReactNode) => (
  <QueryClientProvider client={queryClientState.current}>
    <IntlProvider locale={locale} timeZone="Asia/Ho_Chi_Minh" messages={catalog(locale)}>
      {node}
    </IntlProvider>
  </QueryClientProvider>
);

describe('Projects Public Roadmap client helpers (#4399)', () => {
  it('stores and forgets voter tokens isolated per (orgSlug, boardSlug)', () => {
    forgetRoadmapVoterToken('Org-One', 'Main');
    forgetRoadmapVoterToken('Org-One', 'Beta');
    expect(loadRoadmapVoterToken('Org-One', 'Main')).toBeNull();

    rememberRoadmapVoterToken('Org-One', 'Main', 'rm1.abc.def');
    expect(loadRoadmapVoterToken('org-one', 'main')).toBe('rm1.abc.def');
    expect(loadRoadmapVoterToken('org-one', 'beta')).toBeNull();

    forgetRoadmapVoterToken('org-one', 'main');
    expect(loadRoadmapVoterToken('org-one', 'main')).toBeNull();
  });

  it('extracts valid unsubscribe tokens from URL fragments and ignores invalid ones', () => {
    const valid = 'aB1234567890_cdefghijklmnop';
    expect(readRoadmapUnsubscribeTokenFromHash(`#unsubscribe=${encodeURIComponent(valid)}`)).toBe(valid);
    expect(readRoadmapUnsubscribeTokenFromHash(`#tab=roadmap&unsubscribe=${valid}&x=1`)).toBe(valid);
    expect(readRoadmapUnsubscribeTokenFromHash('')).toBeNull();
    expect(readRoadmapUnsubscribeTokenFromHash('#unsubscribe=short')).toBeNull();
    expect(readRoadmapUnsubscribeTokenFromHash('#unsubscribe=bad!char$here12345678')).toBeNull();
  });

  it('detects ?embed=1 strictly', () => {
    expect(isRoadmapEmbedQuery('?embed=1')).toBe(true);
    expect(isRoadmapEmbedQuery('?foo=bar&embed=1')).toBe(true);
    expect(isRoadmapEmbedQuery('?embed=0')).toBe(false);
    expect(isRoadmapEmbedQuery('')).toBe(false);
  });
});

describe('PublicRoadmapPage & ProjectRoadmapPanel SSR (#4399)', () => {
  it('renders ProjectsPage workspace switcher and ProjectRoadmapPanel empty state + queue in vi and en', () => {
    queryClientState.current.clear();

    const projectsPageHtml = renderToStaticMarkup(wrap('vi', <ProjectsPage />));
    expect(projectsPageHtml).toContain('data-testid="projects-workspace-tabs"');
    expect(projectsPageHtml).toContain('data-testid="projects-roadmap-tab"');

    const emptyBoards: RoadmapBoardListResult = {
      boards: [],
      orgSlug: 'demo-org',
      projects: [],
      seats: [],
      canWrite: true,
      canManageBoard: true,
    };
    queryClientState.current.setQueryData(['projects', 'roadmap', 'boards', {}], emptyBoards);
    const emptyPanelHtml = renderToStaticMarkup(wrap('vi', <ProjectRoadmapPanel orgSlug="demo-org" />));
    expect(emptyPanelHtml).toContain('data-testid="roadmap-admin-toggle-enabled-btn"');
    expect(emptyPanelHtml).toContain('data-testid="roadmap-admin-new-board-btn"');

    const boardId = '10000000-0000-4000-8000-000000000001';
    const boardsData: RoadmapBoardListResult = {
      boards: [
        {
          id: boardId,
          slug: 'roadmap',
          title: 'Product Roadmap',
          description: 'Share what ships next',
          enabled: true,
          projectId: null,
          projectName: null,
          allowSubmissions: true,
          allowVoting: true,
          requireModeration: true,
          embedAllowedOrigins: ['https://portal.example.com'],
          pendingCount: 1,
          publishedCount: 0,
          createdAt: '2027-01-01T00:00:00.000Z',
          updatedAt: '2027-01-01T00:00:00.000Z',
        },
      ],
      orgSlug: 'demo-org',
      projects: [{ id: '20000000-0000-4000-8000-000000000001', name: 'Core App', status: 'active' }],
      seats: [],
      canWrite: true,
      canManageBoard: true,
    };
    const detailData: RoadmapBoardDetailResult = {
      board: boardsData.boards[0]!,
      items: [
        {
          id: '30000000-0000-4000-8000-000000000001',
          boardId,
          linkedTaskId: null,
          linkedTaskStatus: null,
          linkedProjectId: null,
          linkedProjectName: null,
          source: 'public_submission',
          moderationStatus: 'pending',
          mergedIntoItemId: null,
          stage: 'under_review',
          category: 'Export',
          publicTitle: 'Export PDF invoices in bulk',
          publicSummary: 'Would help month-end closing.',
          voteCount: 4,
          tainted: true,
          submitterDisplayName: 'Minh',
          createdAt: '2027-01-01T00:00:00.000Z',
          updatedAt: '2027-01-01T00:00:00.000Z',
        },
      ],
      announcements: [
        {
          id: '40000000-0000-4000-8000-000000000001',
          boardId,
          title: 'Release March 2027',
          bodyMd: '## Highlights\n- Shipped PDF bulk export',
          status: 'published',
          publishedAt: '2027-03-15T10:00:00.000Z',
          linkedItemIds: [],
          linkedItems: [],
          notificationsSentAt: null,
          createdAt: '2027-03-15T09:00:00.000Z',
          updatedAt: '2027-03-15T10:00:00.000Z',
        },
      ],
      activeSubscriberCount: 3,
      canWrite: true,
      canManageBoard: true,
    };
    queryClientState.current.setQueryData(['projects', 'roadmap', 'boards', {}], boardsData);
    queryClientState.current.setQueryData(['projects', 'roadmap', 'boardDetail', { boardId }], detailData);

    const enPanelHtml = renderToStaticMarkup(wrap('en', <ProjectRoadmapPanel orgSlug="demo-org" />));
    expect(enPanelHtml).toContain('Export PDF invoices in bulk');
    expect(enPanelHtml).toContain('External submission');
    expect(enPanelHtml).toContain('4 votes');
    expect(enPanelHtml).toContain('Release March 2027');
    expect(enPanelHtml).toContain('Notify subscribers (3)');
    expect(enPanelHtml).toContain('data-testid="roadmap-admin-vy-dedupe-btn"');
    expect(enPanelHtml).toContain('data-testid="roadmap-admin-changelog-card"');
  });

  it('parses ?tab=changelog and sanitizes markdown without raw HTML or javascript: links (#4400)', () => {
    expect(initialRoadmapTab('?tab=changelog')).toBe('changelog');
    expect(initialRoadmapTab('?tab=roadmap&embed=1')).toBe('roadmap');
    expect(initialRoadmapTab('')).toBe('ideas');

    const rendered = renderToStaticMarkup(
      <SafeRoadmapMarkdown
        markdown={[
          '## New release',
          '- **Fast filters** with `CSV` and [docs](https://docs.example.com/v2)',
          '- Bad link [click](javascript:alert(1)) and <script>alert(2)</script>',
        ].join('\n')}
      />,
    );
    expect(rendered).toContain('<h3');
    expect(rendered).toContain('Fast filters</strong>');
    expect(rendered).toContain('href="https://docs.example.com/v2"');
    expect(rendered).not.toContain('href="javascript:');
    expect(rendered).toContain('[click](javascript:alert(1))');
    expect(rendered).not.toContain('<script>');
    expect(rendered).toContain('&lt;script&gt;alert(2)&lt;/script&gt;');
  });

  it('renders PublicRoadmapPage cleanly in standalone and ?embed=1 modes without user session', () => {
    queryClientState.current.clear();
    const standaloneHtml = renderToStaticMarkup(wrap('vi', <PublicRoadmapPage orgSlug="demo-org" boardSlug="roadmap" />));
    expect(standaloneHtml.length).toBeGreaterThan(0);

    const embedHtml = renderToStaticMarkup(wrap('en', <PublicRoadmapPage orgSlug="demo-org" boardSlug="roadmap" embed />));
    expect(embedHtml.length).toBeGreaterThan(0);
  });
});
