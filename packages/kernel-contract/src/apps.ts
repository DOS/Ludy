// SPDX-License-Identifier: AGPL-3.0-only
// Canonical hierarchy across Ludy (Suite -> App -> Feature Group -> Module):
// - App (AppId): a top-level user workspace in the shell switcher and on ludy.vn.
// - Feature Group: a sidebar section inside an App (defined in screens.ts / apps.ts).
// - Module (ModuleId): an independently deployed (CROVE_MODULES) and org-toggleable (ADR-0053) unit.

// The six Apps in switcher order (#3225): Teamwork, Finance, Engage, HR, eSign, Ludy AI.
export const APP_IDS = ['teamwork', 'finance', 'engage', 'hr', 'sign', 'ai'] as const;
export type AppId = (typeof APP_IDS)[number];

// Every Module the build ships (plan Decision 12, ADR-0031). `kernel` is always on; the rest can be left out per deployment or toggled per org.
export const MODULE_IDS = ['kernel', 'finance', 'social', 'ads', 'crm', 'notes', 'hr', 'meetings', 'projects', 'sign'] as const;
export type ModuleId = (typeof MODULE_IDS)[number];

export type SwitchableModuleId = Exclude<ModuleId, 'kernel'>;

export interface ModuleCatalogEntry {
  // Primary App where this module's switches and screens live (`null` for `kernel`, which spans core, Teamwork tasks, Finance inbox, and Ludy AI).
  readonly app: AppId | null;
  readonly switchable: boolean;
}

// Authoritative mapping from each technical Module to its primary App.
export const MODULE_CATALOG: Readonly<Record<ModuleId, ModuleCatalogEntry>> = {
  kernel: { app: null, switchable: false },
  notes: { app: 'teamwork', switchable: true },
  projects: { app: 'teamwork', switchable: true },
  meetings: { app: 'teamwork', switchable: true },
  finance: { app: 'finance', switchable: true },
  social: { app: 'engage', switchable: true },
  crm: { app: 'engage', switchable: true },
  ads: { app: 'engage', switchable: true },
  hr: { app: 'hr', switchable: true },
  sign: { app: 'sign', switchable: true },
};

// Switchable modules ordered by App (APP_IDS) and menu placement within each App.
export const SWITCHABLE_MODULE_IDS = ['notes', 'projects', 'meetings', 'finance', 'social', 'crm', 'ads', 'hr', 'sign'] as const satisfies readonly SwitchableModuleId[];

// Guard against catalog flags and SWITCHABLE_MODULE_IDS drifting out of lockstep at runtime.
if (new Set(SWITCHABLE_MODULE_IDS).size !== SWITCHABLE_MODULE_IDS.length) {
  throw new Error('SWITCHABLE_MODULE_IDS contains duplicate module IDs');
}
for (const id of SWITCHABLE_MODULE_IDS) {
  if (!MODULE_CATALOG[id].switchable) throw new Error(`Switchable module ${id} is marked non-switchable in MODULE_CATALOG`);
}
for (const id of MODULE_IDS) {
  if (MODULE_CATALOG[id].switchable && !(SWITCHABLE_MODULE_IDS as readonly string[]).includes(id)) {
    throw new Error(`Module ${id} is switchable in MODULE_CATALOG but missing from SWITCHABLE_MODULE_IDS`);
  }
}

/** Return true when `id` is a canonical module shipped by the codebase, regardless of whether it is enabled in `CROVE_MODULES`. */
export function isKnownModule(id: string): id is ModuleId {
  return (MODULE_IDS as readonly string[]).includes(id);
}

/** Return true when `id` is a per-org switchable module (any known module except `kernel`). */
export function isSwitchableModule(id: string): id is SwitchableModuleId {
  return (SWITCHABLE_MODULE_IDS as readonly string[]).includes(id);
}

/** Return the primary App for `moduleId`, or `null` for `kernel` or unknown modules. */
export function appOfModule(moduleId: string): AppId | null {
  return isKnownModule(moduleId) ? MODULE_CATALOG[moduleId].app : null;
}

/** Return the switchable modules that belong to `appId`, in canonical display order. */
export function modulesOfApp(appId: AppId): SwitchableModuleId[] {
  return SWITCHABLE_MODULE_IDS.filter((id) => MODULE_CATALOG[id].app === appId);
}
