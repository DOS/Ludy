import type { NavIconName } from '@ludy/ui/components/nav-icon';

// What waits for the user in one org (issue #1249), in the order the overview lists it: files that could not be read, then what is addressed to the
// user. A count of 0 is not listed; a figure not read yet (undefined) is not listed either, so the list never claims "nothing waits" for something it has
// not counted.

export type WaitingKey = 'failedFiles' | 'notifications' | 'tasks';

export interface WaitingCounts {
  failedFiles?: number | undefined;
  notifications?: number | undefined;
  tasks?: number | undefined;
}

// "Hôm nay cần bạn" counts the proposals, the posts to review and the statement lines (#3591), so this list keeps only what it does not:
// one thing is counted once, on the screen and in the summary.
const ORDER: readonly WaitingKey[] = ['failedFiles', 'notifications', 'tasks'];

// Where each card opens.
export const WAITING_LINKS = {
  failedFiles: { to: '/o/$slug/inbox' },
  notifications: { to: '/o/$slug/notifications' },
  tasks: { to: '/o/$slug/tasks' },
} as const satisfies Record<WaitingKey, { to: string }>;

// The unread notifications as the bell and Home count them: a notice that a proposal waits for approval is about a proposal Home's list and the
// Inbox badge already count, so it is left out (the same rule the daily mail applies).
export function unreadNotices(list: { unreadWork: number } | undefined): number | undefined {
  return list?.unreadWork;
}

// The member's open tasks that the "Hôm nay cần bạn" list does not already carry (an overdue or due-today task is one of its items, whose id ends in the task's id).
// Undefined until both are read, so the screen never says "5 tasks" and then "3".
export function tasksNotListed(tasks: readonly { id: string }[] | undefined, today: readonly { app: string; id: string }[] | undefined): number | undefined {
  if (tasks === undefined || today === undefined) return undefined;
  const listed = new Set(today.filter((i) => i.app === 'projects').map((i) => i.id.slice(i.id.indexOf(':') + 1)));
  return tasks.filter((t) => !listed.has(t.id)).length;
}

// The counts the shell menu shows (#2234): what the "Chờ duyệt" tab of Documents holds (proposals, Social work that needs a person,
// failed background jobs) goes on that item; posts waiting for the viewer's review go on Social's own item.
export function shellBadges(counts: { pending: number; attention: number; failedJobs: number; reviews: number }): { inbox: number | null; social: number | null } {
  const inbox = counts.pending + counts.attention + counts.failedJobs;
  return { inbox: inbox > 0 ? inbox : null, social: counts.reviews > 0 ? counts.reviews : null };
}

export function waitingItems(counts: WaitingCounts): { key: WaitingKey; count: number }[] {
  return ORDER.flatMap((key) => {
    const count = counts[key];
    return count !== undefined && count > 0 ? [{ key, count }] : [];
  });
}

// Whether every figure the screen asks for has been read: only then may it say that nothing waits.
export function allCounted(counts: WaitingCounts, asked: readonly WaitingKey[]): boolean {
  return asked.every((key) => counts[key] !== undefined);
}

// The first year whose sales invoice number gaps the Overview shows (#2140): this year's, and last year's through
// March, while its last quarter's VAT return and the year's closing are still being filed.
export function gapsFromYear(now: Date): number {
  return now.getMonth() < 3 ? now.getFullYear() - 1 : now.getFullYear();
}

// What an app's card shows on Home (#3591): a card only for an app with a figure to read or a figure that failed to load; the others are one line of links.
// `zero` is a figure that reads 0 (nothing scheduled, nothing booked), `pending` one still loading.
export interface AppFigureState {
  zero: boolean;
  pending: boolean;
  failed: boolean;
}

export function appsLayout<Id extends string>(apps: readonly { id: Id; figures: readonly AppFigureState[] }[]): { cards: Id[]; line: Id[]; pending: boolean } {
  const cards: Id[] = [];
  const line: Id[] = [];
  let pending = false;
  for (const app of apps) {
    if (app.figures.some((f) => f.failed || (!f.pending && !f.zero))) cards.push(app.id);
    else if (app.figures.some((f) => f.pending)) pending = true;
    else line.push(app.id);
  }
  return { cards, line, pending };
}

export type QuickStartStepId =
  | 'uploadInvoice'
  | 'vatPeriod'
  | 'twoFactor'
  | 'connectChannel'
  | 'addContact'
  | 'createEnvelope'
  | 'configureApps'
  | 'inviteTeam'
  | 'createNote'
  | 'createDeal'
  | 'createTask';

export type QuickStartTarget =
  | '/o/$slug/inbox'
  | '/o/$slug/settings'
  | '/o/$slug/settings/security'
  | '/o/$slug/social/channels'
  | '/o/$slug/contacts'
  | '/o/$slug/sign/envelopes'
  | '/o/$slug/settings/apps'
  | '/o/$slug/settings/members'
  | '/o/$slug/notes'
  | '/o/$slug/deals'
  | '/o/$slug/tasks';

export interface QuickStartStep {
  readonly id: QuickStartStepId;
  readonly to: QuickStartTarget;
  // A section of the target page (the tax profile in Settings).
  readonly hash?: string;
  readonly icon: NavIconName;
}

// Builds up to 3 Day-1 SME quick-start steps filtered strictly to enabled org modules and the caller's role (#4644). With the accounting app on
// the path is the one of the benchmark (docs/research/smb-suite-navigation-benchmark-2026-11.md L3, #4783): the first invoice, the VAT filing
// period (owners and admins, until one is chosen) and two-factor sign-in; nothing in it is setup for its own sake.
export function quickStartSteps({
  modules,
  role,
  vatChosen = false,
}: {
  modules: readonly string[];
  role: 'owner' | 'admin' | 'member' | 'viewer' | undefined;
  // The org already has a VAT filing period, so that step is done.
  vatChosen?: boolean;
}): QuickStartStep[] {
  if (!role || role === 'viewer') return [];
  const has = (m: string) => modules.includes(m);
  const canManage = role === 'owner' || role === 'admin';
  const steps: QuickStartStep[] = [];
  const add = (step: QuickStartStep) => {
    if (steps.length < 3 && !steps.some((existing) => existing.id === step.id)) {
      steps.push(step);
    }
  };

  if (has('finance')) {
    add({ id: 'uploadInvoice', to: '/o/$slug/inbox', icon: 'documents' });
    if (canManage && !vatChosen) add({ id: 'vatPeriod', to: '/o/$slug/settings', hash: 'tax-profile', icon: 'vat' });
    add({ id: 'twoFactor', to: '/o/$slug/settings/security', icon: 'settingsSecurity' });
    if (steps.length >= 3) return steps;
  }

  // Step 1: First concrete value action from the primary enabled business app.
  // Connecting social channels requires owner/admin permission, so members skip channel setup.
  if (has('finance')) add({ id: 'uploadInvoice', to: '/o/$slug/inbox', icon: 'documents' });
  else if (canManage && has('social')) add({ id: 'connectChannel', to: '/o/$slug/social/channels', icon: 'social' });
  else if (has('crm')) add({ id: 'addContact', to: '/o/$slug/contacts', icon: 'contacts' });
  else if (has('sign')) add({ id: 'createEnvelope', to: '/o/$slug/sign/envelopes', icon: 'signEnvelopes' });
  else if (has('notes')) add({ id: 'createNote', to: '/o/$slug/notes', icon: 'notes' });
  else add({ id: 'createTask', to: '/o/$slug/tasks', icon: 'tasks' });

  // Step 2: Organization & app/team setup for owners and admins.
  if (canManage) add({ id: 'configureApps', to: '/o/$slug/settings/apps', icon: 'settingsApps' });

  // Step 3 (and fallback fills): First collaboration or secondary enabled app workflow.
  if (has('notes')) add({ id: 'createNote', to: '/o/$slug/notes', icon: 'notes' });
  if (has('sign')) add({ id: 'createEnvelope', to: '/o/$slug/sign/envelopes', icon: 'signEnvelopes' });
  if (has('crm')) add({ id: 'createDeal', to: '/o/$slug/deals', icon: 'deals' });
  add({ id: 'createTask', to: '/o/$slug/tasks', icon: 'tasks' });
  if (canManage) add({ id: 'inviteTeam', to: '/o/$slug/settings/members', icon: 'settingsMembers' });
  if (canManage && has('social')) add({ id: 'connectChannel', to: '/o/$slug/social/channels', icon: 'social' });

  return steps;
}

export interface Day1EmptyInput {
  todayLoaded: boolean;
  todayCount: number;
  overviewLoaded: boolean;
  lastActivityAt: string | null | undefined;
  taxDuesCount: number;
  pendingProposals: number;
  failedFiles: number;
  waitingLoaded: boolean;
  waitingCount: number;
  sinceResolved: boolean;
  sinceCount: number;
  hasError: boolean;
}

// True only once all overview inputs have settled and the org has zero activity, zero waiting work, and no tax dues clutter (#4644).
export function isDay1Empty(input: Day1EmptyInput): boolean {
  if (input.hasError) return false;
  if (!input.todayLoaded || !input.overviewLoaded || !input.waitingLoaded || !input.sinceResolved) return false;
  return (
    input.todayCount === 0 &&
    input.lastActivityAt === null &&
    input.taxDuesCount === 0 &&
    input.pendingProposals === 0 &&
    input.failedFiles === 0 &&
    input.waitingCount === 0 &&
    input.sinceCount === 0
  );
}
