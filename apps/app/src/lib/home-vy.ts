// SPDX-License-Identifier: AGPL-3.0-only
// Deterministic quick-ask chips and Vy Drawer coordination for the Global Home inline Vy prompt bar (#4928).
// Keeps core workflows deterministic and preserves human approval for money, messages, and spend.
import { isTodayAnnotation, todayCount, type TodayApp, type TodayItem } from '@ludy/kernel-contract';
import type { Role } from './members.ts';

export type HomeVyChipId =
  | 'pendingApprovals'
  | 'planToday'
  | 'openTasks'
  | 'upcomingBookings'
  | 'socialInbox'
  | 'pendingEnvelopes'
  | 'sharedNotes';

export type HomeVyTarget =
  | '/o/$slug/inbox'
  | '/o/$slug/my-work'
  | '/o/$slug/tasks'
  | '/o/$slug/bookings'
  | '/o/$slug/social/inbox'
  | '/o/$slug/sign/envelopes'
  | '/o/$slug/notes';

export interface HomeVyChip {
  readonly id: HomeVyChipId;
  readonly to: HomeVyTarget;
}

export const HOME_VY_CHIPS_MAX = 3;

export const OPEN_VY_DRAWER_EVENT = 'ludy:open-vy-drawer';

export interface OpenVyDrawerDetail {
  readonly prompt?: string;
}

/** Dispatch an event handled by OrgLayout to open the global Vy quick drawer, optionally carrying a prompt. */
export function dispatchOpenVyDrawer(detail: OpenVyDrawerDetail = {}): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(new CustomEvent<OpenVyDrawerDetail>(OPEN_VY_DRAWER_EVENT, { detail }));
}

/**
 * Build 2 to 3 deterministic quick-ask chips filtered by org `modules`, member `role`, and `canApproveFinance`.
 * Never offers disallowed write/approval paths to viewers or disabled modules.
 */
export function buildHomeVyChips(input: {
  modules: readonly string[];
  role: Role | undefined;
  canApproveFinance: boolean;
}): HomeVyChip[] {
  const { modules, role, canApproveFinance } = input;
  if (!role) return [];
  const has = (module: string) => modules.includes(module);
  const chips: HomeVyChip[] = [];
  const push = (chip: HomeVyChip) => {
    if (chips.length < HOME_VY_CHIPS_MAX && !chips.some((c) => c.id === chip.id)) {
      chips.push(chip);
    }
  };

  if (role === 'viewer') {
    if (has('notes')) push({ id: 'sharedNotes', to: '/o/$slug/notes' });
    push({ id: 'openTasks', to: '/o/$slug/tasks' });
    return chips;
  }

  if (has('finance') && canApproveFinance) {
    push({ id: 'pendingApprovals', to: '/o/$slug/inbox' });
  }
  if (has('notes')) {
    push({ id: 'planToday', to: '/o/$slug/my-work' });
  }
  push({ id: 'openTasks', to: '/o/$slug/tasks' });
  if (has('crm')) {
    push({ id: 'upcomingBookings', to: '/o/$slug/bookings' });
  }
  if (has('social')) {
    push({ id: 'socialInbox', to: '/o/$slug/social/inbox' });
  }
  if (has('sign')) {
    push({ id: 'pendingEnvelopes', to: '/o/$slug/sign/envelopes' });
  }

  return chips;
}

function normalizePromptText(prompt: string): string {
  return prompt
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replaceAll('đ', 'd')
    .replaceAll('Đ', 'D')
    .toLowerCase();
}

const TARGET_PATTERNS: ReadonlyArray<{
  chip: HomeVyChip;
  pattern: RegExp;
  apps: readonly TodayApp[];
  eligible: (input: { modules: readonly string[]; role: Role; canApproveFinance: boolean }) => boolean;
}> = [
  {
    chip: { id: 'pendingApprovals', to: '/o/$slug/inbox' },
    pattern: /\b(hoa don|chung tu|duyet|de xuat|thue|vat|invoice|approval|proposal|tax|ledger)\b/,
    apps: ['finance'],
    eligible: ({ modules, canApproveFinance }) => modules.includes('finance') && canApproveFinance,
  },
  {
    chip: { id: 'planToday', to: '/o/$slug/my-work' },
    pattern: /\b(ke hoach|hom nay|tuan|plan|today|schedule|todo)\b/,
    apps: ['projects', 'notes'],
    eligible: ({ modules, role }) => role !== 'viewer' && modules.includes('notes'),
  },
  {
    chip: { id: 'openTasks', to: '/o/$slug/tasks' },
    pattern: /\b(viec|cong viec|task|nhom|du an|project)\b/,
    apps: ['projects'],
    eligible: () => true,
  },
  {
    chip: { id: 'upcomingBookings', to: '/o/$slug/bookings' },
    pattern: /\b(lich hen|khach hang|booking|crm|deal)\b/,
    apps: ['crm'],
    eligible: ({ modules, role }) => role !== 'viewer' && modules.includes('crm'),
  },
  {
    chip: { id: 'socialInbox', to: '/o/$slug/social/inbox' },
    pattern: /\b(tin nhan|hoi thoai|message|inbox|social|chat)\b/,
    apps: ['conversations', 'social', 'ads'],
    eligible: ({ modules, role }) => role !== 'viewer' && modules.includes('social'),
  },
  {
    chip: { id: 'pendingEnvelopes', to: '/o/$slug/sign/envelopes' },
    pattern: /\b(ky|hop dong|ho so ky|esign|sign|envelope)\b/,
    apps: ['sign'],
    eligible: ({ modules, role }) => role !== 'viewer' && modules.includes('sign'),
  },
  {
    chip: { id: 'sharedNotes', to: '/o/$slug/notes' },
    pattern: /\b(ghi chu|note|notes)\b/,
    apps: ['notes'],
    eligible: ({ modules }) => modules.includes('notes'),
  },
];

/** Match a typed prompt deterministically against allowed destinations so the Vy drawer offers relevant next steps. */
export function matchHomeVyTargets(
  prompt: string,
  input: {
    modules: readonly string[];
    role: Role | undefined;
    canApproveFinance: boolean;
  },
): HomeVyChip[] {
  const { modules, role, canApproveFinance } = input;
  if (!role) return [];
  const normalized = normalizePromptText(prompt);
  const base = buildHomeVyChips(input);
  const matched: HomeVyChip[] = [];
  const add = (chip: HomeVyChip) => {
    if (!matched.some((c) => c.id === chip.id)) matched.push(chip);
  };

  for (const rule of TARGET_PATTERNS) {
    if (rule.pattern.test(normalized) && rule.eligible({ modules, role, canApproveFinance })) {
      add(rule.chip);
    }
  }

  for (const chip of base) {
    if (matched.length >= HOME_VY_CHIPS_MAX) break;
    add(chip);
  }
  return matched.slice(0, HOME_VY_CHIPS_MAX);
}

/**
 * Count grounded, permission-scoped `Hôm nay cần bạn` items matching the submitted Vy prompt.
 * Never fabricates answers or reads unpermitted items.
 */
export function countMatchingTodayForPrompt(
  prompt: string,
  todayItems: readonly TodayItem[],
  input: {
    modules: readonly string[];
    role: Role | undefined;
    canApproveFinance: boolean;
  },
): number {
  const { modules, role, canApproveFinance } = input;
  if (!role) return 0;
  const normalized = normalizePromptText(prompt);
  const matchingApps = new Set<TodayApp>();
  for (const rule of TARGET_PATTERNS) {
    if (rule.pattern.test(normalized) && rule.eligible({ modules, role, canApproveFinance })) {
      for (const app of rule.apps) matchingApps.add(app);
    }
  }
  if (matchingApps.size === 0) return todayCount(todayItems);
  const scoped = todayItems.filter((item) => !isTodayAnnotation(item) && matchingApps.has(item.app));
  return todayCount(scoped);
}
