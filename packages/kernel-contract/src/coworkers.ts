// SPDX-License-Identifier: AGPL-3.0-only
// The AI coworkers (DESIGN.md 1.1, issues #2409 and #2410): one roster, keyed by what each coworker COVERS, never by name, so a
// name is a change of one line here and nothing else. The owner's decision (2026-11-02, logged on #1210): Ludy CRM folds into
// Ludy Engage, and the coworkers are Vy, Ly, Dy, Uy and a reserved Hy, with default names an org can rename. Messages in the app
// name a coworker through the key's placeholder (`{gm}`, `{finance}`, `{sales}`, `{marketing}`, `{system}`, filled in
// apps/app/src/i18n/brand.ts); the site reads its own roster (apps/web/src/content/roster.ts). An agent installed from a
// template takes the name of its module's coworker unless the installer gives one, and the org chart picker shows that name; the
// position keeps the template's title (the job title). The general manager is not a template agent. Installed agents are never
// renamed by this table, only the default for the next install.
export const COWORKER_KEYS = ['gm', 'finance', 'sales', 'marketing', 'system'] as const;
export type CoworkerKey = (typeof COWORKER_KEYS)[number];

// gm: Vy, the general manager across every app (the Home brief, routing, the command bar) and Ludy Notes. finance: Ly, Ludy Kế
// toán. sales: Dy, Engage's Inbox and its customers and sales (the conversations inbox, the contacts, the deals and the
// bookings of Ludy CRM). marketing: Uy, Engage's marketing (publishing and Ads). system: Hy, reserved and shown nowhere yet.
export const COWORKER_ROSTER: Readonly<Record<CoworkerKey, string>> = {
  gm: 'Vy',
  finance: 'Ly',
  sales: 'Dy',
  marketing: 'Uy',
  system: 'Hy',
};

// The coworker of each module of the catalog of agent templates. The system coworker is hidden: no module has it yet.
export const COWORKER_BY_MODULE: Readonly<Record<string, CoworkerKey>> = {
  finance: 'finance',
  crm: 'sales',
  conversations: 'sales',
  social: 'marketing',
  ads: 'marketing',
};

// The coworker of a template's module, or null for a module without one (it keeps the template's title as its name).
export function defaultCoworkerName(module: string): string | null {
  const key = Object.hasOwn(COWORKER_BY_MODULE, module) ? COWORKER_BY_MODULE[module] : undefined;
  return key ? COWORKER_ROSTER[key] : null;
}
