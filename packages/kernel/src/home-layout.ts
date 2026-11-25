// SPDX-License-Identifier: AGPL-3.0-only
// Per-member, per-org customizable Global Home layout (#4923 Phase 1, #4925).
// Stores each member's block order and visibility in ludy_kernel.member_home_layout under a restrictive own-member
// policy; computes deterministic Role x Enabled-App defaults server-side and filters out disabled modules or
// unpermitted blocks without mutating saved preferences. Non-user actors (agents, system) are always refused.
import { z } from 'zod';
import {
  HOME_BLOCK_IDS,
  zHomeLayoutSaveInput,
  zStoredHomeLayout,
  type HomeBlockId,
  type HomeLayoutBlock,
  type HomeLayoutBlockView,
  type HomeLayoutView,
  type StoredHomeLayout,
} from '@ludy/kernel-contract';
import type { MemberRole } from '@ludy/db';
import { DomainError, defineCommand, defineQuery, entitledTo, type CommandContext, type QueryContext } from '@ludy/kernel-runtime';
import { offAppsOf, type OrgAppsOptions } from './org-apps.ts';
import { myPermissions } from './roles.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

const FINANCE_PERMISSIONS = ['finance.proposal.approve', 'finance.period.unlock', 'finance.vat.file'] as const;
const FINANCE_APPROVAL_ROLE_KEYS = [
  'finance.chief_accountant',
  'finance.accountant',
  'finance.entity_chief_accountant',
] as const;
const FINANCE_TAX_ROLE_KEYS = [
  ...FINANCE_APPROVAL_ROLE_KEYS,
  'finance.viewer',
  'external_accountant',
] as const;

export type HomeLayoutAppsOptions = Pick<OrgAppsOptions, 'deployment' | 'entitlements'>;

export interface HomeBlockEligibility {
  readonly id: HomeBlockId;
  readonly moduleEnabled: boolean;
  readonly permitted: boolean;
  readonly defaultVisible: boolean;
}

function requireUser(ctx: Pick<QueryContext, 'actor' | 'role'>): { userId: string; role: MemberRole } {
  if (ctx.actor.type !== 'user' || ctx.role === null) {
    throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  }
  return { userId: ctx.actor.userId, role: ctx.role };
}

/**
 * Compute per-block module enablement, permission eligibility, and default visibility for a member in an org.
 */
export function computeHomeBlockEligibility(input: {
  role: MemberRole;
  permissions: ReadonlySet<string>;
  roleKeys: ReadonlySet<string>;
  isModuleOn: (module: string) => boolean;
}): HomeBlockEligibility[] {
  const { role, permissions, roleKeys, isModuleOn } = input;
  const isAdmin = role === 'owner' || role === 'admin';
  const isMemberOrAbove = isAdmin || role === 'member';
  const hasFinancePermission = FINANCE_PERMISSIONS.some((p) => permissions.has(p));
  const hasFinanceApprovalRole = FINANCE_APPROVAL_ROLE_KEYS.some((k) => roleKeys.has(k));
  const hasFinanceTaxRole = FINANCE_TAX_ROLE_KEYS.some((k) => roleKeys.has(k));

  const financeOn = isModuleOn('finance');
  const notesOn = isModuleOn('notes');
  const engageOn = isModuleOn('crm') || isModuleOn('social');
  const hrOn = isModuleOn('hr');
  const signOn = isModuleOn('sign');

  return [
    {
      id: 'finance_tax_deadlines',
      moduleEnabled: financeOn,
      permitted: isMemberOrAbove || hasFinancePermission || hasFinanceTaxRole,
      defaultVisible: isAdmin || hasFinancePermission || hasFinanceTaxRole,
    },
    {
      id: 'finance_approvals',
      moduleEnabled: financeOn,
      permitted: isAdmin || hasFinancePermission || (isMemberOrAbove && hasFinanceApprovalRole),
      defaultVisible: isAdmin || hasFinancePermission || (isMemberOrAbove && hasFinanceApprovalRole),
    },
    {
      id: 'teamwork_my_work',
      moduleEnabled: role === 'viewer' ? notesOn : true,
      permitted: true,
      defaultVisible: role === 'viewer' ? notesOn : true,
    },
    {
      id: 'engage_pipeline',
      moduleEnabled: engageOn,
      permitted: isMemberOrAbove,
      defaultVisible: isMemberOrAbove,
    },
    {
      id: 'hr_pending',
      moduleEnabled: hrOn,
      permitted: isMemberOrAbove,
      defaultVisible: isMemberOrAbove,
    },
    {
      id: 'esign_pending',
      moduleEnabled: signOn,
      permitted: isMemberOrAbove,
      defaultVisible: isMemberOrAbove,
    },
  ];
}

/**
 * Merge a saved layout (when present) with deterministic Role x Enabled-App defaults.
 * Disabled modules and unpermitted blocks are excluded; newly eligible blocks append in canonical order.
 */
export function mergeHomeLayout(eligibility: readonly HomeBlockEligibility[], saved: StoredHomeLayout | null): HomeLayoutView {
  const defaults: HomeLayoutBlockView[] = eligibility
    .filter((block) => block.moduleEnabled && block.permitted)
    .map((block) => ({
      id: block.id,
      visible: block.defaultVisible,
      moduleEnabled: true,
      permitted: true,
    }));

  if (!saved) {
    return {
      customized: false,
      blocks: defaults.map((block) => ({ ...block })),
      defaults,
    };
  }

  const eligibleById = new Map<HomeBlockId, HomeLayoutBlockView>(defaults.map((block) => [block.id, block]));
  const seen = new Set<HomeBlockId>();
  const merged: HomeLayoutBlockView[] = [];

  for (const entry of saved.blocks) {
    if (!eligibleById.has(entry.id) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    merged.push({
      id: entry.id,
      visible: entry.visible,
      moduleEnabled: true,
      permitted: true,
    });
  }

  for (const def of defaults) {
    if (seen.has(def.id)) continue;
    merged.push({ ...def });
  }

  return {
    customized: true,
    blocks: merged,
    defaults,
  };
}

const ENTITLEMENT_TTL_MS = 60_000;
const ENTITLEMENT_TIMEOUT_MS = 3_000;
const ENTITLEMENT_RETRY_MS = 10_000;
const ENTITLEMENT_CACHE_MAX = 5_000;

type EntitlementsPort = (orgId: string) => Promise<readonly string[]>;

/**
 * Wraps a billing entitlements port with ADR-0053 resilience: 60s per-org cache, inflight dedupe,
 * 3s timeout, and fail-open fallback to the last cached answer (or ['full'] when none exists),
 * retrying after 10s so billing outages never hang DB transactions or fail Home loads/saves.
 */
export function createEntitlementsReader(
  port: EntitlementsPort,
  clock: () => number = () => Date.now(),
): EntitlementsPort {
  const cache = new Map<string, { keys: readonly string[]; at: number; failed: boolean }>();
  const inflight = new Map<string, Promise<readonly string[]>>();
  let lastLoggedAt = 0;

  const remember = (orgId: string, keys: readonly string[], at: number, failed: boolean) => {
    cache.delete(orgId);
    cache.set(orgId, { keys, at, failed });
    if (cache.size > ENTITLEMENT_CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  };

  return async (orgId: string): Promise<readonly string[]> => {
    const now = clock();
    const cached = cache.get(orgId);
    if (cached && now - cached.at < ENTITLEMENT_TTL_MS) return cached.keys;
    const running = inflight.get(orgId);
    if (running) return running;

    const call = (async (): Promise<readonly string[]> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const answer = await Promise.race([
          port(orgId),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('entitlements timeout')), ENTITLEMENT_TIMEOUT_MS);
          }),
        ]);
        if (!Array.isArray(answer) || !answer.every((k) => typeof k === 'string')) {
          throw new Error('invalid entitlements payload');
        }
        const keys: readonly string[] = Object.freeze([...answer]);
        remember(orgId, keys, clock(), false);
        return keys;
      } catch (error) {
        const errAt = clock();
        if (errAt - lastLoggedAt > 60_000) {
          lastLoggedAt = errAt;
          console.error('[home-layout] ENTITLEMENTS_UNAVAILABLE', {
            orgId,
            reason: error instanceof Error ? error.name.slice(0, 40) : 'unknown',
            haveLastAnswer: cached !== undefined,
          });
        }
        const fallback = cached?.keys ?? ['full'];
        remember(orgId, fallback, errAt - ENTITLEMENT_TTL_MS + ENTITLEMENT_RETRY_MS, true);
        return fallback;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    })().finally(() => {
      inflight.delete(orgId);
    });

    inflight.set(orgId, call);
    return call;
  };
}

/**
 * Preserve saved order/visibility for any saved blocks absent from inputBlocks (e.g. disabled modules,
 * unpermitted blocks, or modules re-enabled concurrently between read and save), anchored to their
 * preceding saved block when possible.
 */
export function mergeSavedBlocks(
  inputBlocks: readonly HomeLayoutBlock[],
  saved: StoredHomeLayout | null,
): HomeLayoutBlock[] {
  if (!saved) return inputBlocks.map((b) => ({ id: b.id, visible: b.visible }));
  const inputIds = new Set<HomeBlockId>(inputBlocks.map((b) => b.id));
  const pendingByAnchor = new Map<HomeBlockId | null, HomeLayoutBlock[]>();

  let lastAnchor: HomeBlockId | null = null;
  for (const entry of saved.blocks) {
    if (inputIds.has(entry.id)) {
      lastAnchor = entry.id;
      continue;
    }
    const bucket = pendingByAnchor.get(lastAnchor) ?? [];
    bucket.push({ id: entry.id, visible: entry.visible });
    pendingByAnchor.set(lastAnchor, bucket);
  }

  const merged: HomeLayoutBlock[] = [...(pendingByAnchor.get(null) ?? [])];
  for (const block of inputBlocks) {
    merged.push({ id: block.id, visible: block.visible });
    const trailing = pendingByAnchor.get(block.id);
    if (trailing) merged.push(...trailing);
  }
  return merged;
}

type ResolvedAppsOptions = {
  readonly deployment: readonly string[];
  readonly readEntitlements: EntitlementsPort;
};

function resolveAppsOptions(apps?: HomeLayoutAppsOptions): ResolvedAppsOptions | undefined {
  if (!apps) return undefined;
  return {
    deployment: apps.deployment,
    readEntitlements: createEntitlementsReader(apps.entitlements),
  };
}

async function loadHomeLayoutState(
  ctx: QueryContext,
  apps?: ResolvedAppsOptions,
): Promise<{ userId: string; eligibility: HomeBlockEligibility[]; saved: StoredHomeLayout | null }> {
  const { userId, role } = requireUser(ctx);
  const entitlements = apps ? await apps.readEntitlements(ctx.orgId) : null;
  const offApps = new Set(await offAppsOf(ctx.trx, ctx.orgId));
  const deployment = apps?.deployment ?? [];
  const isModuleOn = (module: string): boolean => {
    if (module === 'kernel') return true;
    if (!ctx.installed(module) || offApps.has(module)) return false;
    if (deployment.length > 0 && !deployment.includes(module)) return false;
    if (entitlements !== null && !entitledTo(entitlements, module)) return false;
    return true;
  };

  const permissionList = await myPermissions(ctx);
  const assignments = await ctx.trx
    .selectFrom('ludy_kernel.role_assignment')
    .select('role_key')
    .where('org_id', '=', ctx.orgId)
    .where('user_id', '=', userId)
    .execute();
  const row = await ctx.trx
    .selectFrom('ludy_kernel.member_home_layout')
    .select('layout_json')
    .where('org_id', '=', ctx.orgId)
    .where('user_id', '=', userId)
    .executeTakeFirst();

  const parsed = row ? zStoredHomeLayout.safeParse(row.layout_json) : null;
  const saved = parsed?.success ? parsed.data : null;
  const eligibility = computeHomeBlockEligibility({
    role,
    permissions: new Set(permissionList),
    roleKeys: new Set(assignments.map((a) => a.role_key)),
    isModuleOn,
  });

  // Preserve canonical ordering from HOME_BLOCK_IDS if computeHomeBlockEligibility ever expands.
  const orderedEligibility = HOME_BLOCK_IDS.flatMap((id) => eligibility.filter((e) => e.id === id));
  return { userId, eligibility: orderedEligibility, saved };
}

async function resolveHomeLayout(ctx: QueryContext, apps?: ResolvedAppsOptions): Promise<HomeLayoutView> {
  const state = await loadHomeLayoutState(ctx, apps);
  return mergeHomeLayout(state.eligibility, state.saved);
}

export function homeLayoutGetQuery(options: { apps?: HomeLayoutAppsOptions } = {}) {
  const resolvedApps = resolveAppsOptions(options.apps);
  return defineQuery({
    name: 'kernel.member.home_layout.get',
    input: z.strictObject({}),
    access: ALL,
    handler: async (ctx): Promise<HomeLayoutView> => resolveHomeLayout(ctx, resolvedApps),
  });
}

export function homeLayoutSaveCommand(options: { apps?: HomeLayoutAppsOptions } = {}) {
  const resolvedApps = resolveAppsOptions(options.apps);
  return defineCommand({
    name: 'kernel.member.home_layout.save',
    input: zHomeLayoutSaveInput,
    risk: 'R1',
    sideEffect: 'internal',
    access: ALL,
    handler: async (ctx: CommandContext, input): Promise<HomeLayoutView> => {
      const { userId } = requireUser(ctx);
      const isReset = 'reset' in input;

      if (isReset) {
        await ctx.trx
          .deleteFrom('ludy_kernel.member_home_layout')
          .where('org_id', '=', ctx.orgId)
          .where('user_id', '=', userId)
          .execute();
        ctx.audit({ reset: true, blockCount: 0 });
        await ctx.emit('kernel.member.home_layout_updated', { userId, reset: true, blockCount: 0 });
        return resolveHomeLayout(ctx, resolvedApps);
      }

      const state = await loadHomeLayoutState(ctx, resolvedApps);
      const mergedBlocks = mergeSavedBlocks(input.blocks, state.saved);
      const nextSaved: StoredHomeLayout = { v: 1, blocks: mergedBlocks };
      const payloadJson = JSON.stringify(nextSaved);
      await ctx.trx
        .insertInto('ludy_kernel.member_home_layout')
        .values({
          org_id: ctx.orgId,
          user_id: userId,
          layout_json: payloadJson,
          updated_at: ctx.now,
        })
        .onConflict((oc) =>
          oc.columns(['org_id', 'user_id']).doUpdateSet({
            layout_json: payloadJson,
            updated_at: ctx.now,
          }),
        )
        .execute();

      ctx.audit({ reset: false, blockCount: mergedBlocks.length });
      await ctx.emit('kernel.member.home_layout_updated', { userId, reset: false, blockCount: mergedBlocks.length });
      return mergeHomeLayout(state.eligibility, nextSaved);
    },
  });
}

export function homeLayoutQueries(options: { apps?: HomeLayoutAppsOptions } = {}) {
  return [homeLayoutGetQuery(options)];
}

export function homeLayoutCommands(options: { apps?: HomeLayoutAppsOptions } = {}) {
  return [homeLayoutSaveCommand(options)];
}
