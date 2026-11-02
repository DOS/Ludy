// SPDX-License-Identifier: AGPL-3.0-only
// The AI coworkers (DESIGN.md 1.1, issue #2410): Vy is the general manager across every app, and each department has one
// coworker. An agent installed from a template takes the name of its module's coworker unless the installer gives one,
// and the org chart picker shows that name; the position keeps the template's title (the job title). Vy is not a
// template agent. Installed agents are never renamed by this table, only the default for the next install.
export const COWORKER_BY_MODULE: Readonly<Record<string, string>> = {
  finance: 'Ly',
  social: 'My',
  ads: 'My',
  crm: 'Thy',
  conversations: 'Duy',
  kernel: 'Hy',
  system: 'Hy',
};

// The coworker of a template's module, or null for a module without one (it keeps the template's title as its name).
export function defaultCoworkerName(module: string): string | null {
  return Object.hasOwn(COWORKER_BY_MODULE, module) ? (COWORKER_BY_MODULE[module] ?? null) : null;
}
