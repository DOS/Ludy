// SPDX-License-Identifier: AGPL-3.0-only
// Role x Enabled-App fallback layout computation and inline customize draft helpers (#4923 Phase 4, #4928).
// Mirrors packages/kernel/src/home-layout.ts defaults so initial Home paint never flickers empty,
// while server `overview.homeLayout.get` remains authoritative once settled.
import type {
  HomeBlockId,
  HomeLayoutBlock,
  HomeLayoutBlockView,
  HomeLayoutView,
} from '@ludy/kernel-contract';
import type { Role } from './members.ts';
import { canApproveProposals } from './review.ts';

/** True when the org's effective modules allow the backing module(s) for `blockId` (ADR-0053). */
export function isBlockModuleEnabled(blockId: HomeBlockId, modules: readonly string[]): boolean {
  const has = (module: string) => modules.includes(module);
  switch (blockId) {
    case 'finance_tax_deadlines':
    case 'finance_approvals':
      return has('finance');
    case 'teamwork_my_work':
      return true;
    case 'engage_pipeline':
      return has('crm') || has('social');
    case 'hr_pending':
      return has('hr');
    case 'esign_pending':
      return has('sign');
  }
}

/**
 * Derive deterministic Role x Enabled-App fallback blocks when `overview.homeLayout.get` is still pending
 * or unavailable. Viewer's `teamwork_my_work` requires `notes` to be enabled, matching the kernel rule.
 */
export function buildFallbackHomeLayout(input: {
  modules: readonly string[];
  role: Role | undefined;
  permissions?: readonly string[];
}): HomeLayoutView {
  const { modules, role, permissions = [] } = input;
  if (!role) {
    return { customized: false, blocks: [], defaults: [] };
  }
  const has = (module: string) => modules.includes(module);
  const isAdmin = role === 'owner' || role === 'admin';
  const isMemberOrAbove = isAdmin || role === 'member';
  const hasFinancePermission = role !== 'viewer' && canApproveProposals(role, permissions);

  const financeOn = has('finance');
  const notesOn = has('notes');
  const engageOn = has('crm') || has('social');
  const hrOn = has('hr');
  const signOn = has('sign');

  const candidates: Array<HomeLayoutBlockView> = [
    {
      id: 'finance_tax_deadlines',
      visible: isAdmin || hasFinancePermission,
      moduleEnabled: financeOn,
      permitted: isMemberOrAbove || hasFinancePermission,
    },
    {
      id: 'finance_approvals',
      visible: isAdmin || hasFinancePermission,
      moduleEnabled: financeOn,
      permitted: isAdmin || hasFinancePermission,
    },
    {
      id: 'teamwork_my_work',
      visible: role === 'viewer' ? notesOn : true,
      moduleEnabled: role === 'viewer' ? notesOn : true,
      permitted: true,
    },
    {
      id: 'engage_pipeline',
      visible: isMemberOrAbove,
      moduleEnabled: engageOn,
      permitted: isMemberOrAbove,
    },
    {
      id: 'hr_pending',
      visible: isMemberOrAbove,
      moduleEnabled: hrOn,
      permitted: isMemberOrAbove,
    },
    {
      id: 'esign_pending',
      visible: isMemberOrAbove,
      moduleEnabled: signOn,
      permitted: isMemberOrAbove,
    },
  ];

  const defaults = candidates.filter((block) => block.moduleEnabled && block.permitted);
  return {
    customized: false,
    blocks: defaults.map((block) => ({ ...block })),
    defaults,
  };
}

/**
 * Filter a `HomeLayoutView` down to blocks that are eligible (`moduleEnabled && permitted`) and still enabled
 * in the current reactive `modules` set (ADR-0053), preserving server-persisted order.
 */
export function eligibleHomeBlocks(
  layout: HomeLayoutView,
  modules: readonly string[],
  role: Role | undefined,
): HomeLayoutBlockView[] {
  const notesOn = modules.includes('notes');
  return layout.blocks.filter((block) => {
    if (!block.moduleEnabled || !block.permitted) return false;
    if (block.id === 'teamwork_my_work' && role === 'viewer') return notesOn;
    return isBlockModuleEnabled(block.id, modules);
  });
}

/** Visible blocks to display on Home from an eligible block list. */
export function visibleHomeBlocks(eligible: readonly HomeLayoutBlockView[]): HomeLayoutBlockView[] {
  return eligible.filter((block) => block.visible);
}

/** Extract editable `{ id, visible }` draft rows from eligible layout blocks. */
export function toHomeLayoutDraft(eligible: readonly HomeLayoutBlockView[]): HomeLayoutBlock[] {
  return eligible.map(({ id, visible }) => ({ id, visible }));
}

/** Move a block one slot up (`-1`) or down (`1`); returns the unchanged array when out of bounds. */
export function moveHomeBlock(
  blocks: readonly HomeLayoutBlock[],
  index: number,
  delta: -1 | 1,
): HomeLayoutBlock[] {
  const target = index + delta;
  if (index < 0 || index >= blocks.length || target < 0 || target >= blocks.length) {
    return [...blocks];
  }
  const next = [...blocks];
  const moved = next[index]!;
  next[index] = next[target]!;
  next[target] = moved;
  return next;
}

/** Reorder a block by drag-and-drop from `sourceId` to `targetId`. */
export function reorderHomeBlockById(
  blocks: readonly HomeLayoutBlock[],
  sourceId: HomeBlockId,
  targetId: HomeBlockId,
): HomeLayoutBlock[] {
  if (sourceId === targetId) return [...blocks];
  const from = blocks.findIndex((b) => b.id === sourceId);
  const to = blocks.findIndex((b) => b.id === targetId);
  if (from < 0 || to < 0) return [...blocks];
  const next = [...blocks];
  const [moved] = next.splice(from, 1);
  if (!moved) return [...blocks];
  next.splice(to, 0, moved);
  return next;
}

/** Toggle a block's `visible` state in the customize draft. */
export function toggleHomeBlockVisibility(
  blocks: readonly HomeLayoutBlock[],
  id: HomeBlockId,
  visible: boolean,
): HomeLayoutBlock[] {
  return blocks.map((block) => (block.id === id ? { ...block, visible } : block));
}
