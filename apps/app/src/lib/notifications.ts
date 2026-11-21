// In-app notifications of the kernel, finance, notes, projects and meetings (#671): the kinds the settings list, what an item opens, and how
// a VAT period reads. Social's are apart (lib/social-notifications.ts, #637). No React imports, so it is unit tested.

// The kinds a member can turn off, by module, in the order the settings list them.
export const NOTIFICATION_KINDS = {
  // A task given or moved to my seat (#2588); a task that came to me because its holder can no longer read its legal entity (#1799); an original e-invoice attached
  // to a posted invoice that differs from it or is not verified (#2335).
  // A conversation that is New and needs an answer (CV3, #2306): told to the assignee, else the available members who read it, else owners and admins.
  kernel: ['kernel.approval_waiting', 'kernel.file_unreadable', 'kernel.task_assigned', 'kernel.task_rerouted', 'kernel.original_flagged', 'kernel.ai_budget', 'kernel.conversation_new'],
  finance: ['finance.bank_attention', 'finance.portal_attention', 'finance.period_closing'],
  // A to-do's reminder (#1675): it holds no text, the to-do shows in My work.
  notes: ['notes.todo_due'],
  // An ad account whose connection stopped, so its updates are paused until an owner or admin connects it again (#2219).
  ads: ['kernel.channel_expired'],
  // A project weekly status mailed to members (#2609).
  projects: ['projects.weekly_status'],
  // About 30 minutes before the next meeting of a series: how many of my items from the previous meeting are still open (#3542). It holds a count and the previous meeting, no title.
  // And the recorder's "minutes draft ready" notice (#3730): it holds no text of the draft, and the same switch turns off its email. And the opt-in "meetings today" notice (#3955): a count and a link, no title; the same switch turns off its email.
  meetings: ['meetings.series_open_items', 'meetings.summary_ready', 'meetings.morning'],
} as const;
export type KnownNotificationKind = (typeof NOTIFICATION_KINDS)[keyof typeof NOTIFICATION_KINDS][number];

// The kinds of the modules this deployment runs.
export function notificationKinds(modules: readonly string[]): KnownNotificationKind[] {
  return Object.entries(NOTIFICATION_KINDS).flatMap(([module, kinds]) => (module === 'kernel' || modules.includes(module) ? [...kinds] : []));
}

// The message key of a kind ('kernel.approval_waiting' is kinds.kernel_approval_waiting).
type Underscored<K extends string> = K extends `${infer M}.${infer N}` ? `${M}_${N}` : never;
export const kindKey = (kind: KnownNotificationKind) => kind.replace('.', '_') as Underscored<KnownNotificationKind>;

// Kinds shown but never turned off, so not in the settings: a notice an action waits on (#1678: a personal-data erasure
// deletes the private items it names once their authors were told; #4069: an AI app connected before its Engage reads existed can now read the Hộp thư, bookings and ads, and its owner is
// told once whatever they muted, because it is about their own consent).
export const REQUIRED_NOTIFICATION_KINDS = ['kernel.personal_data_notice', 'kernel.mcp_engage_reads'] as const;
type ShownNotificationKind = KnownNotificationKind | (typeof REQUIRED_NOTIFICATION_KINDS)[number];

export const isKnownKind = (kind: string): kind is ShownNotificationKind =>
  (REQUIRED_NOTIFICATION_KINDS as readonly string[]).includes(kind) || Object.values(NOTIFICATION_KINDS).some((kinds) => (kinds as readonly string[]).includes(kind));

export type NotificationTarget =
  | { to: 'proposal'; id: string }
  | { to: 'inbox' }
  | { to: 'bank'; account?: string }
  | { to: 'portal'; sale?: true }
  | { to: 'ledger' }
  | { to: 'myWork' }
  | { to: 'task'; id: string }
  | { to: 'conversation'; id: string }
  | { to: 'conversations' }
  | { to: 'tasks' }
  | { to: 'project'; id: string }
  | { to: 'projects' }
  | { to: 'meeting'; id: string }
  | { to: 'meetings' }
  | { to: 'ads' }
  | { to: 'agents' }
  | { to: 'aiConnections' };

// What an item opens: the proposal waiting for approval, the Inbox (where a file that failed to read is listed), the
// bank account with lines to look at, the tax-portal check, the ledger, where the period is locked, or My work, where
// the reminded to-do is, or the task that came to me (else the task list).
export function notificationTarget(item: { kind: string; subjectId: string | null; detail: Record<string, string> }): NotificationTarget | null {
  switch (item.kind) {
    case 'kernel.approval_waiting':
    case 'kernel.original_flagged':
      return item.subjectId ? { to: 'proposal', id: item.subjectId } : { to: 'inbox' };
    case 'kernel.file_unreadable':
      return { to: 'inbox' };
    case 'kernel.task_assigned':
    case 'kernel.task_rerouted':
      return item.subjectId ? { to: 'task', id: item.subjectId } : { to: 'tasks' };
    // The thread that needs an answer opens in the Inbox, else the Inbox's New tab.
    case 'kernel.conversation_new':
      return item.subjectId ? { to: 'conversation', id: item.subjectId } : { to: 'conversations' };
    case 'finance.bank_attention':
      return item.detail.bankAccount ? { to: 'bank', account: item.detail.bankAccount } : { to: 'bank' };
    case 'finance.portal_attention':
      // A sales list's notification (#2141) opens the sales tab.
      return item.detail.direction === 'sale' ? { to: 'portal', sale: true } : { to: 'portal' };
    case 'finance.period_closing':
      return { to: 'ledger' };
    case 'notes.todo_due':
      return { to: 'myWork' };
    case 'projects.weekly_status':
      return item.subjectId ? { to: 'project', id: item.subjectId } : { to: 'projects' };
    // The previous meeting, where its items are listed (a person who read it can open it; the notice was only sent to one who can).
    case 'meetings.series_open_items':
    // The meeting whose draft is ready: the recorder's own, opened where the draft is reviewed.
    case 'meetings.summary_ready':
      return item.subjectId ? { to: 'meeting', id: item.subjectId } : null;
    // The morning notice opens the meetings page, where the day's meetings and their briefs are (#3955).
    case 'meetings.morning':
      return { to: 'meetings' };
    case 'kernel.channel_expired':
      return { to: 'ads' };
    // The AI budget's notice (#2382) opens the page with this month's use and the budgets, where an owner raises one.
    case 'kernel.ai_budget':
      return { to: 'agents' };
    // The Engage reads notice (#4069) opens the AI connections screen, where each connected app is listed and can be disconnected.
    case 'kernel.mcp_engage_reads':
      return { to: 'aiConnections' };
    default:
      return null;
  }
}

// The kinds a run of which shows as one row (NT-2, #3592): each has a list screen that holds all of them (the Inbox for proposals and unreadable files, the task list, the Inbox's New tab),
// so one row with a count and a link says what seven rows said. Every other kind keeps a row per event: they name different things (a bank account, a period, a meeting).
export const GROUPABLE_KINDS = ['kernel.approval_waiting', 'kernel.file_unreadable', 'kernel.task_assigned', 'kernel.conversation_new'] as const;
export type GroupableKind = (typeof GROUPABLE_KINDS)[number];
const isGroupable = (kind: string): kind is GroupableKind => (GROUPABLE_KINDS as readonly string[]).includes(kind);

// The list read returns the newest 30 (the kernel's NOTIFICATION_LIST_LIMIT): a group that runs to the end of a full list may stand for more than it holds, so its count reads "30+".
export const NOTIFICATION_LIST_LIMIT = 30;

export type NotificationRow<T> = { type: 'one'; item: T } | { type: 'group'; kind: GroupableKind; items: T[] };

// The list as rows, in the order it came (newest first): two or more UNREAD notifications of a groupable kind that follow each other become one group row, so a different event between them
// keeps the order the person read them in. A read one stays a plain row: the server marks a proposal's notice read once it is decided, so a group of read ones would claim a need that is gone,
// and the count of a group is then the count of what still waits. A run of one stays a plain row.
export function groupNotifications<T extends { kind: string; read: boolean }>(items: readonly T[]): NotificationRow<T>[] {
  const rows: NotificationRow<T>[] = [];
  let i = 0;
  while (i < items.length) {
    const first = items[i]!;
    let end = i + 1;
    const groupable = isGroupable(first.kind) && !first.read;
    if (groupable) while (end < items.length && items[end]!.kind === first.kind && !items[end]!.read) end++;
    if (groupable && end - i >= 2) {
      rows.push({ type: 'group', kind: first.kind as GroupableKind, items: items.slice(i, end) });
    } else rows.push({ type: 'one', item: first });
    i = end;
  }
  return rows;
}

// How many things a group stands for: a file that failed to read in two versions, or a task given to me twice, is two notices of one thing, so the count is of subjects (a notice without
// one counts for itself).
export function groupSubjectCount(items: readonly { id: string; subjectId: string | null }[]): number {
  return new Set(items.map((n) => n.subjectId ?? n.id)).size;
}

// The ids of a group's unread items, in chunks the read command takes (100 at most).
export function unreadIdChunks(items: readonly { id: string; read: boolean }[], size = 100): string[][] {
  const ids = items.filter((n) => !n.read).map((n) => n.id);
  const chunks: string[][] = [];
  for (let at = 0; at < ids.length; at += size) chunks.push(ids.slice(at, at + size));
  return chunks;
}

// A VAT period key as people write it: '2026-09' is 09/2026, '2026-Q3' is Q3/2026 (the caller puts the word for quarter).
export function periodParts(period: string): { kind: 'month' | 'quarter'; label: string } | null {
  const month = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (month) return { kind: 'month', label: `${month[2]}/${month[1]}` };
  const quarter = /^(\d{4})-Q([1-4])$/.exec(period);
  if (quarter) return { kind: 'quarter', label: `${quarter[2]}/${quarter[1]}` };
  return null;
}
