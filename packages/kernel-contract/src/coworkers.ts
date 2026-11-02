// SPDX-License-Identifier: AGPL-3.0-only
// The AI coworkers (DESIGN.md 1.1, issues #2409 and #2410): one roster, keyed by ROLE, never by name, so a name is a change
// of one line here and nothing else. Messages in the app name a coworker through the role's placeholder (`{gm}`,
// `{finance}`, `{sales}`, `{marketing}`, `{system}`, filled in apps/app/src/i18n/brand.ts); the site reads its own roster
// (apps/web/src/content/roster.ts). An agent installed from a template takes the name of its module's role unless the
// installer gives one, and the org chart picker shows that name; the position keeps the template's title (the job title).
// The general manager is not a template agent. Installed agents are never renamed by this table, only the default for the
// next install.
export const COWORKER_ROLES = ['gm', 'finance', 'sales', 'marketing', 'system'] as const;
export type CoworkerRole = (typeof COWORKER_ROLES)[number];

// The names are proposed, not final (owner decision pending, 2026-11-02): Vy is the general manager across every app, Ly the
// CFO of the accounting app, Dy sales and customer care (CRM and the inbox), Uy marketing, brand and ads, and Hy is kept for a
// future app.
export const COWORKER_ROSTER: Readonly<Record<CoworkerRole, string>> = {
  gm: 'Vy',
  finance: 'Ly',
  sales: 'Dy',
  marketing: 'Uy',
  system: 'Hy',
};

// The role of the coworker of each module of the catalog of agent templates.
export const COWORKER_ROLE_BY_MODULE: Readonly<Record<string, CoworkerRole>> = {
  finance: 'finance',
  social: 'marketing',
  ads: 'marketing',
  crm: 'sales',
  conversations: 'sales',
  kernel: 'system',
  system: 'system',
};

// The coworker of a template's module, or null for a module without one (it keeps the template's title as its name).
export function defaultCoworkerName(module: string): string | null {
  const role = Object.hasOwn(COWORKER_ROLE_BY_MODULE, module) ? COWORKER_ROLE_BY_MODULE[module] : undefined;
  return role ? COWORKER_ROSTER[role] : null;
}
