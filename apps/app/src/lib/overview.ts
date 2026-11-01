// What waits for the user in one org (issue #1249), in the order the overview lists it: what blocks the books first
// (proposals to approve, files that could not be read), then what is addressed to the user, then statement lines to
// match. A count of 0 is not listed; a figure not read yet (undefined) is not listed either, so the list never
// claims "nothing waits" for something it has not counted.

export type WaitingKey = 'proposals' | 'socialReviews' | 'failedFiles' | 'notifications' | 'tasks' | 'bankLines';

export interface WaitingCounts {
  proposals?: number | undefined;
  socialReviews?: number | undefined;
  failedFiles?: number | undefined;
  notifications?: number | undefined;
  tasks?: number | undefined;
  bankLines?: number | undefined;
}

const ORDER: readonly WaitingKey[] = ['proposals', 'socialReviews', 'failedFiles', 'notifications', 'tasks', 'bankLines'];

// Where each card opens. Posts waiting for the user's review open Social's own review tab, not an accounting screen
// (#2234): the reviewer may not read accounting at all.
export const WAITING_LINKS = {
  proposals: { to: '/o/$slug/inbox' },
  socialReviews: { to: '/o/$slug/social', search: { tab: 'review' } },
  failedFiles: { to: '/o/$slug/inbox' },
  notifications: { to: '/o/$slug/notifications' },
  tasks: { to: '/o/$slug/tasks' },
  bankLines: { to: '/o/$slug/bank' },
} as const satisfies Record<WaitingKey, { to: string; search?: Record<string, string> }>;

// The counts the shell menu shows (#2234): what the accounting Inbox holds (proposals, Social work that needs a person,
// failed background jobs) goes on the Inbox item; posts waiting for the viewer's review go on Social's own item.
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
