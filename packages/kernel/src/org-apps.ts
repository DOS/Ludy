// SPDX-License-Identifier: AGPL-3.0-only
// The apps an org's owner or admin turned off for their own company (ADR-0053, issue #3313; slice a of #3307). The
// choice is stored as the list of apps that are OFF (crove_kernel.tenant.apps_off, empty by default), so every app is on
// with no setup and a module shipped later is on until someone turns it off. kernel can not be switched off. Only
// kernel.org.set_app writes it (an owner or admin, R2, audited with the module, its new state and the new version);
// the tenant_apps_guard and tenant_apps_requires_audit triggers refuse any other write. Nothing enforces the choice
// yet: slices b (the runtime), c (worker and routes), e (Vy, Home, MCP) and d (the Settings screen) build on it.
import { z } from 'zod';
import { zOrgApps, zOrgAppSet } from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, entitledTo } from '@crove/kernel-runtime';

// The modules the build ships that an org may switch (kernel is never one of them).
export function switchableApps(shipped: readonly string[]): string[] {
  return shipped.filter((module) => module !== 'kernel');
}

// The effective rule of ADR-0053 section 1 for one module: the deployment runs it, the org holds it and did not turn it
// off. The one function every gate uses.
export function appEffective(input: { module: string; deployment: readonly string[]; entitlements: readonly string[]; appsOff: readonly string[] }): boolean {
  if (input.module === 'kernel') return true;
  return input.deployment.includes(input.module) && entitledTo(input.entitlements, input.module) && !input.appsOff.includes(input.module);
}

export interface OrgAppsOptions {
  // The modules this build ships (AVAILABLE_MODULES), kernel included or not.
  readonly shipped: readonly string[];
  // The modules this deployment runs (CROVE_MODULES, ADR-0031).
  readonly deployment: readonly string[];
  // The org's entitlements, the `billing` port's answer (plan Decision 10).
  readonly entitlements: (orgId: string) => Promise<readonly string[]>;
}

export type OrgApps = z.infer<typeof zOrgApps>;

// The command. `shipped` is the build's module list; without one any well-formed id is accepted (tests that register
// the kernel alone), and the database still holds the shape.
export function setAppCommand(options: { shipped?: readonly string[] } = {}) {
  return defineCommand({
    name: 'kernel.org.set_app',
    input: zOrgAppSet,
    risk: 'R2',
    sideEffect: 'internal',
    access: ['owner', 'admin'],
    handler: async (ctx, input) => {
      if (input.module === 'kernel') throw new DomainError('APP_ALWAYS_ON', 422, 'Lõi của hệ thống luôn bật, không tắt được');
      if (options.shipped && !switchableApps(options.shipped).includes(input.module)) {
        throw new DomainError('UNKNOWN_APP', 422, 'Không có ứng dụng này');
      }
      // The tenant row first, so two switches meet on it and each version is used once.
      const before = await ctx.trx
        .selectFrom('crove_kernel.tenant')
        .select(['apps_off', 'apps_version'])
        .where('org_id', '=', ctx.orgId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const isOff = before.apps_off.includes(input.module);
      const changed = isOff === input.enabled;
      let version = before.apps_version;
      if (changed) {
        const next = input.enabled ? before.apps_off.filter((m) => m !== input.module) : [...before.apps_off, input.module].sort();
        version += 1;
        await ctx.trx.updateTable('crove_kernel.tenant').set({ apps_off: next, apps_version: version }).where('org_id', '=', ctx.orgId).execute();
        await ctx.activity('kernel.tenant', ctx.orgId, 'org.app_changed', input.enabled ? `Bật ứng dụng ${input.module}` : `Tắt ứng dụng ${input.module}`);
        await ctx.emit('kernel.org.apps_changed', { module: input.module, enabled: input.enabled, version });
      }
      // The audit row is written for every run; the database trigger reads module, enabled and version of a change.
      ctx.audit({ module: input.module, enabled: input.enabled, version, changed });
      return { module: input.module, enabled: input.enabled, version };
    },
  });
}

// The read: every member sees which apps the org has, and why one is not available.
export function orgAppsQuery(options: OrgAppsOptions) {
  return defineQuery({
    name: 'kernel.org.apps',
    input: z.object({}),
    access: ['owner', 'admin', 'member', 'viewer'],
    handler: async (ctx) => {
      const tenant = await ctx.trx
        .selectFrom('crove_kernel.tenant')
        .select(['apps_off', 'apps_version'])
        .where('org_id', '=', ctx.orgId)
        .executeTakeFirstOrThrow();
      const entitlements = await options.entitlements(ctx.orgId);
      const apps = switchableApps(options.shipped).map((id) => {
        const deployment = options.deployment.includes(id);
        const entitled = entitledTo(entitlements, id);
        const enabled = !tenant.apps_off.includes(id);
        return { id, deployment, entitled, enabled, effective: appEffective({ module: id, deployment: options.deployment, entitlements, appsOff: tenant.apps_off }) };
      });
      return { apps, version: tenant.apps_version, canChange: ctx.role === 'owner' || ctx.role === 'admin' };
    },
  });
}
