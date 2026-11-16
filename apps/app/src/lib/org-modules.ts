// SPDX-License-Identifier: AGPL-3.0-only
// The apps the current org has (ADR-0053, slice d of #3307): the deployment's CROVE_MODULES from /api/config, cut by the org's own choice and
// entitlements as `kernel.org.apps` answers them. Every menu, screen and "is this app installed" question inside an org reads installedModules(),
// so a switch-off reaches them all with no line in each. Outside an org (the multi-client table, the share target, onboarding) the deployment's
// list stands, as before. The router fills the store before a screen opens and the shell refills it when the stream says the apps changed.
import { useSyncExternalStore } from 'react';
import { getConfig } from './auth.ts';

// Set by the router when it enters an org and by the shell when the stream says the apps changed; cleared when another org is entered (enterOrg), so
// one org's apps never stand for another's.
let state: { modules: readonly string[] } | null = null;
let version = 0;
const listeners = new Set<() => void>();

// Replaces what the store knows: the org's effective modules, or none (the deployment's stand). The version moves only when the answer changes,
// so a refetch that finds the same apps remounts nothing.
export function setOrgModules(modules: readonly string[] | null): void {
  const before = installedModules().join(',');
  state = modules !== null ? { modules: [...modules] } : null;
  if (installedModules().join(',') === before) return;
  version += 1;
  for (const listener of listeners) listener();
}

// The modules this org runs; the deployment's list until the org's answer is in, and outside an org.
export function installedModules(): string[] {
  return state !== null ? [...state.modules] : getConfig().modules;
}

// A number that changes whenever installedModules() does, for the shell to rebuild its menus and remount its screen.
export function useModulesVersion(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
    () => version,
  );
}
