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
export function unreadNotices(list: { unread: number; unreadApprovals: number } | undefined): number | undefined {
  return list === undefined ? undefined : Math.max(0, list.unread - list.unreadApprovals);
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
