// The org overview's waiting list (issue #1249): what it lists, in which order, and when it may say nothing waits.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOME_ACTIONS, HOME_ACTIONS_MAX, homeActions, showStartCard } from '../src/lib/home-actions.ts';
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

  it('lists 3 to 4 fixed create actions, only for the apps that are on and never for a viewer (#4783)', () => {
    expect(HOME_ACTIONS.length).toBeGreaterThanOrEqual(3);
    expect(HOME_ACTIONS.length).toBeLessThanOrEqual(HOME_ACTIONS_MAX);
    expect(homeActions(['finance', 'crm'], 'owner').map((a) => a.id)).toEqual(['uploadInvoice', 'recordExpense', 'createSalesInvoice', 'addCustomer']);
    expect(homeActions(['finance'], 'member').map((a) => a.id)).toEqual(['uploadInvoice', 'recordExpense', 'createSalesInvoice']);
    expect(homeActions(['crm'], 'admin').map((a) => a.id)).toEqual(['addCustomer']);
    expect(homeActions(['kernel', 'notes'], 'owner')).toEqual([]);
    expect(homeActions(['finance', 'crm'], 'viewer')).toEqual([]);
    expect(homeActions(['finance', 'crm'], undefined)).toEqual([]);
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
