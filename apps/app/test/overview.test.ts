// The org overview's waiting list (issue #1249) and Role x Enabled-App modular Home helpers (#4928).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROPOSAL_APPROVE_PERMISSION } from '@ludy/kernel-contract';
import { showStartCard } from '../src/lib/home-actions.ts';
import {
  buildFallbackHomeLayout,
  eligibleHomeBlocks,
  isBlockModuleEnabled,
  moveHomeBlock,
  reorderHomeBlockById,
  toHomeLayoutDraft,
  toggleHomeBlockVisibility,
  visibleHomeBlocks,
} from '../src/lib/home-layout.ts';
import { buildHomeVyChips, countMatchingTodayForPrompt, matchHomeVyTargets } from '../src/lib/home-vy.ts';
import { WAITING_LINKS, allCounted, appsLayout, gapsFromYear, isDay1Empty, quickStartSteps, shellBadges, tasksNotListed, unreadNotices, waitingItems } from '../src/lib/overview.ts';

describe('org overview', () => {
  it('lists what waits that the "Hôm nay cần bạn" list does not count, and leaves out counts of 0', () => {
    expect(waitingItems({ tasks: 2, failedFiles: 1, notifications: 0 })).toEqual([
      { key: 'failedFiles', count: 1 },
      { key: 'tasks', count: 2 },
    ]);
    expect(waitingItems({})).toEqual([]);
    // The proposals, posts to review and statement lines are counted once, in that list (#3591).
    expect(Object.keys(WAITING_LINKS)).toEqual(['failedFiles', 'notifications', 'tasks']);
  });

  it('says nothing waits only once every asked figure is read', () => {
    expect(allCounted({ failedFiles: 0, tasks: 0 }, ['failedFiles', 'tasks'])).toBe(true);
    expect(allCounted({ failedFiles: 0 }, ['failedFiles', 'tasks'])).toBe(false);
  });

  it('counts the bell and the notices without the approvals, which are the proposals already counted (#3591)', () => {
    // Seven invoices wait: seven "approval waiting" notices are unread, and the member also has two other notices; the server counts the two.
    expect(unreadNotices({ unreadWork: 2 })).toBe(2);
    expect(unreadNotices({ unreadWork: 0 })).toBe(0);
    expect(unreadNotices(undefined)).toBeUndefined();
  });

  it('counts a task once: the ones the today list already carries are not counted again (#3591)', () => {
    const tasks = [{ id: 't1' }, { id: 't2' }, { id: 't3' }];
    const today = [
      { app: 'projects', id: 'overdue:t1' },
      { app: 'projects', id: 'due:t2' },
      // Another app's item whose id merely looks alike is not a task.
      { app: 'finance', id: 'vat:t3' },
    ];
    expect(tasksNotListed(tasks, today)).toBe(1);
    expect(tasksNotListed(tasks, [])).toBe(3);
    // Not read yet: no figure, so the screen never says one number and then another.
    expect(tasksNotListed(tasks, undefined)).toBeUndefined();
    expect(tasksNotListed(undefined, today)).toBeUndefined();
  });

  it('draws a card only for an app with a figure to read, and puts the others on one line (#3591)', () => {
    const none = { zero: true, pending: false, failed: false };
    const some = { zero: false, pending: false, failed: false };
    expect(
      appsLayout([
        { id: 'finance', figures: [some] },
        // Engage with 0 posts and 0 bookings: nothing to read.
        { id: 'engage', figures: [none, none] },
        // An app that only links.
        { id: 'teamwork', figures: [] },
        // One of Engage's two figures has a number, so the card shows.
        { id: 'sales', figures: [none, some] },
        // A figure that failed to load keeps its card, with its retry.
        { id: 'social', figures: [{ zero: false, pending: false, failed: true }] },
        // Still loading: neither a card nor the line until it is known.
        { id: 'ai', figures: [{ zero: false, pending: true, failed: false }] },
      ]),
    ).toEqual({ cards: ['finance', 'sales', 'social'], line: ['engage', 'teamwork'], pending: true });
    // A new org: no card at all.
    expect(appsLayout([{ id: 'finance', figures: [none] }, { id: 'hr', figures: [] }]).cards).toEqual([]);
  });

  it('reads sales invoice number gaps from this year on, and from last year through March (#2140)', () => {
    expect(gapsFromYear(new Date(2026, 0, 15))).toBe(2025);
    expect(gapsFromYear(new Date(2026, 2, 31))).toBe(2025);
    expect(gapsFromYear(new Date(2026, 3, 1))).toBe(2026);
    expect(gapsFromYear(new Date(2026, 9, 31))).toBe(2026);
  });

  it("counts posts to review on Social's menu item and never on the Inbox's (#2234)", () => {
    expect(shellBadges({ pending: 0, attention: 0, failedJobs: 0, reviews: 4 })).toEqual({ inbox: null, social: 4 });
    expect(shellBadges({ pending: 2, attention: 1, failedJobs: 3, reviews: 0 })).toEqual({ inbox: 6, social: null });
    // A reviews total moves only the Social badge.
    const without = shellBadges({ pending: 2, attention: 1, failedJobs: 0, reviews: 0 });
    expect(shellBadges({ pending: 2, attention: 1, failedJobs: 0, reviews: 9 }).inbox).toBe(without.inbox);
  });

  it('lists no post to review in the accounting Inbox (#2234)', () => {
    // The Inbox screen is too wired to the router and the stream to render here; its source must not ask for the
    // reviews at all, in either of the two ways it could (the inbox of reviews, or the review stage of the post list).
    const inbox = readFileSync(join(import.meta.dirname, '..', 'src', 'routes', 'inbox.tsx'), 'utf8');
    expect(inbox).not.toMatch(/reviewInbox|SocialReviews|stage:\s*['"]review['"]/);
  });

  it('builds up to 3 Day-1 quick-start steps gated strictly by enabled org modules and role (#4644)', () => {
    expect(
      quickStartSteps({ modules: ['finance', 'notes', 'sign', 'social', 'crm'], role: 'owner' }).map((s) => s.id),
    ).toEqual(['uploadInvoice', 'vatPeriod', 'twoFactor']);

    expect(
      quickStartSteps({ modules: ['finance', 'sign'], role: 'admin' }).map((s) => s.id),
    ).toEqual(['uploadInvoice', 'vatPeriod', 'twoFactor']);

    // The VAT period is chosen already: that step is done, and the next fill takes its place (#4783).
    expect(
      quickStartSteps({ modules: ['finance', 'notes'], role: 'owner', vatChosen: true }).map((s) => s.id),
    ).toEqual(['uploadInvoice', 'twoFactor', 'configureApps']);

    // Finance disabled: never recommends uploading invoices.
    expect(
      quickStartSteps({ modules: ['social', 'crm', 'sign'], role: 'owner' }).map((s) => s.id),
    ).toEqual(['connectChannel', 'configureApps', 'createEnvelope']);

    // Kernel only: falls back to task creation, app settings, and member invite.
    expect(
      quickStartSteps({ modules: ['kernel'], role: 'owner' }).map((s) => s.id),
    ).toEqual(['createTask', 'configureApps', 'inviteTeam']);

    // Member skips owner/admin settings and social channel-connect steps; viewer gets no write CTAs.
    expect(
      quickStartSteps({ modules: ['finance', 'notes'], role: 'member' }).map((s) => s.id),
    ).toEqual(['uploadInvoice', 'twoFactor', 'createNote']);
    expect(
      quickStartSteps({ modules: ['kernel', 'social'], role: 'member' }).map((s) => s.id),
    ).toEqual(['createTask']);
    expect(
      quickStartSteps({ modules: ['kernel', 'social', 'crm', 'sign'], role: 'member' }).map((s) => s.id),
    ).toEqual(['addContact', 'createEnvelope', 'createDeal']);
    expect(quickStartSteps({ modules: ['finance', 'notes'], role: 'viewer' })).toEqual([]);
  });

  it('keeps the VAT step to owners and admins, with its own settings section (#4783)', () => {
    const owner = quickStartSteps({ modules: ['finance'], role: 'owner' }).find((s) => s.id === 'vatPeriod');
    expect(owner).toMatchObject({ to: '/o/$slug/settings', hash: 'tax-profile' });
    expect(quickStartSteps({ modules: ['finance'], role: 'member' }).map((s) => s.id)).not.toContain('vatPeriod');
  });

  it('detects Day-1 empty orgs only once reads settle with zero activity, waiting items, or tax dues (#4644)', () => {
    const base = {
      todayLoaded: true,
      todayCount: 0,
      overviewLoaded: true,
      lastActivityAt: null,
      taxDuesCount: 0,
      pendingProposals: 0,
      failedFiles: 0,
      waitingLoaded: true,
      waitingCount: 0,
      sinceResolved: true,
      sinceCount: 0,
      hasError: false,
    };
    expect(isDay1Empty(base)).toBe(true);
    expect(isDay1Empty({ ...base, todayLoaded: false })).toBe(false);
    expect(isDay1Empty({ ...base, waitingLoaded: false })).toBe(false);
    expect(isDay1Empty({ ...base, sinceResolved: false })).toBe(false);
    expect(isDay1Empty({ ...base, hasError: true })).toBe(false);
    expect(isDay1Empty({ ...base, lastActivityAt: '2026-11-23T09:00:00Z' })).toBe(false);
    expect(isDay1Empty({ ...base, todayCount: 1 })).toBe(false);
    expect(isDay1Empty({ ...base, taxDuesCount: 1 })).toBe(false);
    expect(isDay1Empty({ ...base, waitingCount: 1 })).toBe(false);
    expect(isDay1Empty({ ...base, sinceCount: 1 })).toBe(false);
  });

  it('shows the day-1 start card by the first approved invoice, a close, and the empty-org rule where finance is off (#4783)', () => {
    const base = { steps: 3, stored: null, financeOn: true, firstInvoiceApproved: false, orgEmpty: false } as const;
    expect(showStartCard(base)).toBe(true);
    // Not before the read answers, and not after the first approved invoice.
    expect(showStartCard({ ...base, firstInvoiceApproved: undefined })).toBe(false);
    expect(showStartCard({ ...base, firstInvoiceApproved: true })).toBe(false);
    // Closed, or done on this device.
    expect(showStartCard({ ...base, stored: 'dismissed' })).toBe(false);
    expect(showStartCard({ ...base, stored: 'done' })).toBe(false);
    // No steps for this role.
    expect(showStartCard({ ...base, steps: 0 })).toBe(false);
    // Accounting off: no invoice to wait for, so only an empty org sees it.
    expect(showStartCard({ ...base, financeOn: false, firstInvoiceApproved: undefined, orgEmpty: true })).toBe(true);
    expect(showStartCard({ ...base, financeOn: false, firstInvoiceApproved: undefined, orgEmpty: false })).toBe(false);
  });
});

describe('Role x Enabled-App Home layout & customize helpers (#4928)', () => {
  const ALL_MODULES = ['kernel', 'finance', 'notes', 'projects', 'meetings', 'social', 'crm', 'ads', 'hr', 'sign'];

  it('computes deterministic Role x Enabled-App fallback defaults mirroring kernel policy', () => {
    const owner = buildFallbackHomeLayout({ modules: ALL_MODULES, role: 'owner' });
    expect(owner.blocks.map((b) => [b.id, b.visible])).toEqual([
      ['finance_tax_deadlines', true],
      ['finance_approvals', true],
      ['teamwork_my_work', true],
      ['engage_pipeline', true],
      ['hr_pending', true],
      ['esign_pending', true],
    ]);

    const financeMember = buildFallbackHomeLayout({
      modules: ALL_MODULES,
      role: 'member',
      permissions: [PROPOSAL_APPROVE_PERMISSION],
    });
    expect(financeMember.blocks.map((b) => [b.id, b.visible])).toEqual([
      ['finance_tax_deadlines', true],
      ['finance_approvals', true],
      ['teamwork_my_work', true],
      ['engage_pipeline', true],
      ['hr_pending', true],
      ['esign_pending', true],
    ]);

    const regularMember = buildFallbackHomeLayout({ modules: ALL_MODULES, role: 'member' });
    expect(regularMember.blocks.map((b) => [b.id, b.visible])).toEqual([
      ['finance_tax_deadlines', false],
      ['teamwork_my_work', true],
      ['engage_pipeline', true],
      ['hr_pending', true],
      ['esign_pending', true],
    ]);

    const viewerNotesOn = buildFallbackHomeLayout({ modules: ALL_MODULES, role: 'viewer' });
    expect(viewerNotesOn.blocks.map((b) => [b.id, b.visible])).toEqual([['teamwork_my_work', true]]);

    const viewerNotesOff = buildFallbackHomeLayout({ modules: ['kernel', 'finance', 'hr'], role: 'viewer' });
    expect(viewerNotesOff.blocks).toEqual([]);

    expect(buildFallbackHomeLayout({ modules: ALL_MODULES, role: undefined }).blocks).toEqual([]);
  });

  it('filters eligible and visible blocks strictly by server flags and ADR-0053 reactive modules', () => {
    expect(isBlockModuleEnabled('engage_pipeline', ['kernel', 'ads'])).toBe(false);
    expect(isBlockModuleEnabled('engage_pipeline', ['kernel', 'crm'])).toBe(true);
    expect(isBlockModuleEnabled('hr_pending', ['kernel', 'hr'])).toBe(true);
    expect(isBlockModuleEnabled('esign_pending', ['kernel'])).toBe(false);

    const serverLayout = {
      customized: true,
      blocks: [
        { id: 'esign_pending' as const, visible: true, moduleEnabled: true, permitted: true },
        { id: 'finance_approvals' as const, visible: true, moduleEnabled: false, permitted: true },
        { id: 'hr_pending' as const, visible: true, moduleEnabled: true, permitted: false },
        { id: 'teamwork_my_work' as const, visible: false, moduleEnabled: true, permitted: true },
        { id: 'engage_pipeline' as const, visible: true, moduleEnabled: true, permitted: true },
      ],
      defaults: [],
    };
    // Even if server cache still had sign enabled, disabling `sign` locally hides esign_pending at once.
    const eligible = eligibleHomeBlocks(serverLayout, ['kernel', 'crm'], 'member');
    expect(eligible.map((b) => [b.id, b.visible])).toEqual([
      ['teamwork_my_work', false],
      ['engage_pipeline', true],
    ]);
    expect(visibleHomeBlocks(eligible).map((b) => b.id)).toEqual(['engage_pipeline']);
  });

  it('reorders via Move Up / Move Down, drag-drop, and Switch visibility without losing bounds', () => {
    const draft = toHomeLayoutDraft(buildFallbackHomeLayout({ modules: ALL_MODULES, role: 'owner' }).blocks);
    expect(moveHomeBlock(draft, 0, -1).map((b) => b.id)).toEqual(draft.map((b) => b.id));
    expect(moveHomeBlock(draft, draft.length - 1, 1).map((b) => b.id)).toEqual(draft.map((b) => b.id));

    const movedUp = moveHomeBlock(draft, 1, -1);
    expect(movedUp.slice(0, 2).map((b) => b.id)).toEqual(['finance_approvals', 'finance_tax_deadlines']);

    const movedDown = moveHomeBlock(movedUp, 0, 1);
    expect(movedDown.slice(0, 2).map((b) => b.id)).toEqual(['finance_tax_deadlines', 'finance_approvals']);

    const dragged = reorderHomeBlockById(draft, 'esign_pending', 'finance_approvals');
    expect(dragged.map((b) => b.id)).toEqual([
      'finance_tax_deadlines',
      'esign_pending',
      'finance_approvals',
      'teamwork_my_work',
      'engage_pipeline',
      'hr_pending',
    ]);

    const toggled = toggleHomeBlockVisibility(dragged, 'hr_pending', false);
    expect(toggled.find((b) => b.id === 'hr_pending')?.visible).toBe(false);
    expect(toggled.find((b) => b.id === 'esign_pending')?.visible).toBe(true);
  });

  it('filters inline Vy quick-ask chips and prompt matches by modules, role, and permissions', () => {
    expect(
      buildHomeVyChips({
        modules: ['kernel', 'finance', 'notes', 'crm'],
        role: 'owner',
        canApproveFinance: true,
      }).map((c) => c.id),
    ).toEqual(['pendingApprovals', 'planToday', 'openTasks']);

    expect(
      buildHomeVyChips({
        modules: ['kernel', 'finance', 'notes', 'crm'],
        role: 'member',
        canApproveFinance: false,
      }).map((c) => c.id),
    ).toEqual(['planToday', 'openTasks', 'upcomingBookings']);

    expect(
      buildHomeVyChips({
        modules: ['kernel', 'finance', 'notes'],
        role: 'viewer',
        canApproveFinance: false,
      }).map((c) => c.id),
    ).toEqual(['sharedNotes', 'openTasks']);

    expect(
      matchHomeVyTargets('duyet hoa don thang 11', {
        modules: ['kernel', 'finance', 'notes'],
        role: 'owner',
        canApproveFinance: true,
      })[0]?.id,
    ).toBe('pendingApprovals');

    // Viewers typing finance approval words never receive approval shortcut chips.
    expect(
      matchHomeVyTargets('duyet hoa don', {
        modules: ['kernel', 'finance', 'notes'],
        role: 'viewer',
        canApproveFinance: false,
      }).map((c) => c.id),
    ).not.toContain('pendingApprovals');

    // Short tokens like `ky` or `vat` use word boundaries and never trigger on substrings like `kyc` or `vatexample`.
    expect(
      matchHomeVyTargets('vatexample task list', {
        modules: ['kernel', 'finance', 'projects'],
        role: 'owner',
        canApproveFinance: true,
      })[0]?.id,
    ).toBe('openTasks');
    expect(
      matchHomeVyTargets('kyc task check', {
        modules: ['kernel', 'sign', 'projects'],
        role: 'member',
        canApproveFinance: false,
      })[0]?.id,
    ).toBe('openTasks');

    // Grounded count matches caller's scoped today items cleanly.
    expect(
      countMatchingTodayForPrompt(
        'Toi co bao nhieu hoa don cho duyet?',
        [
          { app: 'finance', kind: 'proposal', id: 'p1', count: 3, title: { key: 'finance.vendor' }, href: '/inbox' },
          { app: 'finance', kind: 'flag', id: 'f1', annotates: 'proposal', count: 1, title: { key: 'finance.flag' }, href: '/inbox' },
          { app: 'projects', kind: 'deadline', id: 't1', count: 2, title: { key: 'projects.due' }, href: '/tasks' },
        ],
        { modules: ['kernel', 'finance', 'projects'], role: 'owner', canApproveFinance: true },
      ),
    ).toBe(3);
  });
});
