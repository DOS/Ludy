// SPDX-License-Identifier: AGPL-3.0-only
// The fixed list of what the extension may ask the browser for (meetings plan section 5.7, ADR-0047 point 10). CI builds
// the package and checks the built manifest against it (scripts/check-manifest.mjs); a permission added to the manifest
// without a change here, which the security review sees, fails the build.

export const BASE_PERMISSIONS = ['identity', 'storage'] as const;
// Asked only when the member turns the meetings feature on, and given back when it is turned off (`activeTab` lets the popup read the active meeting tab URL on click to prevent duplicate capture, #4123).
export const MEETINGS_OPTIONAL_PERMISSIONS = ['offscreen', 'tabCapture', 'activeTab'] as const;
// Asked only when the member enables the Web Clipper toggle inside Notes, and given back when turned off.
export const WEB_CLIPPER_OPTIONAL_PERMISSIONS = ['activeTab', 'scripting'] as const;
export const OPTIONAL_PERMISSIONS = [...new Set([...MEETINGS_OPTIONAL_PERMISSIONS, ...WEB_CLIPPER_OPTIONAL_PERMISSIONS])] as const;
// The Ludy cloud address, granted at install.
export const DEFAULT_HOST_PERMISSIONS = ['https://app.ludy.vn/*'] as const;
// A self-hosted address the member types: asked for that one origin at setup, never granted by default. `localhost`
// (plain http) serves the `docker compose up` stack on the member's own machine; 127.0.0.1 and [::1] are not accepted.
export const OPTIONAL_HOST_PERMISSIONS = ['http://localhost/*', 'https://*/*'] as const;

// The one page a website may navigate to (#4662): the landing page of the sign-in tab, which the app sends the member to with the one-time code. It is listed for the
// cloud address and `localhost` (the docker stack) only, never `https://*/*`, so no page of any other site can reach it; the page does nothing without a pending sign-in
// of this browser session and a matching state. It is not a permission and adds no install or update warning. A self-hosted https address keeps the browser window.
// The manifest may declare no `web_accessible_resources` at all, or exactly this one entry: any other entry, key or match fails.
export const WEB_ACCESSIBLE_PAGE = 'connected.html';
export const WEB_ACCESSIBLE_MATCHES = ['https://app.ludy.vn/*', 'http://localhost/*'] as const;

// Manifest keys that would reach sites or run code outside the package.
const FORBIDDEN_KEYS = ['content_scripts', 'externally_connectable', 'update_url', 'declarative_net_request', 'sandbox'] as const;

const sameSet = (actual: unknown, expected: readonly string[]): boolean =>
  Array.isArray(actual) && actual.length === expected.length && [...actual].map(String).sort().join('\n') === [...expected].sort().join('\n');

// `web_accessible_resources` is absent, or exactly one entry: the sign-in landing page, for the cloud address and localhost, with nothing added (no `extension_ids`, no `use_dynamic_url`).
function webAccessibleViolations(value: unknown): string[] {
  if (value === undefined) return [];
  const expected = `[{ resources: [${WEB_ACCESSIBLE_PAGE}], matches: [${WEB_ACCESSIBLE_MATCHES.join(', ')}] }]`;
  if (!Array.isArray(value) || value.length !== 1) return [`web_accessible_resources must be absent or exactly ${expected}, found ${JSON.stringify(value)}`];
  const entry = value[0] as Record<string, unknown> | null;
  const keys = entry && typeof entry === 'object' ? Object.keys(entry).sort().join(',') : '';
  if (keys !== 'matches,resources' || !sameSet(entry?.resources, [WEB_ACCESSIBLE_PAGE]) || !sameSet(entry?.matches, WEB_ACCESSIBLE_MATCHES)) {
    return [`web_accessible_resources must be absent or exactly ${expected}, found ${JSON.stringify(value)}`];
  }
  return [];
}

// The reasons the manifest breaks the list, empty when it keeps it.
export function manifestViolations(manifest: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (manifest.manifest_version !== 3) problems.push('manifest_version must be 3');
  if (!sameSet(manifest.permissions, BASE_PERMISSIONS)) problems.push(`permissions must be exactly [${BASE_PERMISSIONS.join(', ')}], found ${JSON.stringify(manifest.permissions)}`);
  if (!sameSet(manifest.optional_permissions, OPTIONAL_PERMISSIONS)) {
    problems.push(`optional_permissions must be exactly [${OPTIONAL_PERMISSIONS.join(', ')}], found ${JSON.stringify(manifest.optional_permissions)}`);
  }
  if (!sameSet(manifest.host_permissions, DEFAULT_HOST_PERMISSIONS)) problems.push(`host_permissions must be exactly [${DEFAULT_HOST_PERMISSIONS.join(', ')}], found ${JSON.stringify(manifest.host_permissions)}`);
  if (!sameSet(manifest.optional_host_permissions, OPTIONAL_HOST_PERMISSIONS)) {
    problems.push(`optional_host_permissions must be exactly [${OPTIONAL_HOST_PERMISSIONS.join(', ')}], found ${JSON.stringify(manifest.optional_host_permissions)}`);
  }
  for (const key of FORBIDDEN_KEYS) if (key in manifest) problems.push(`the manifest must not declare ${key}`);
  problems.push(...webAccessibleViolations(manifest.web_accessible_resources));
  const csp = (manifest.content_security_policy as { extension_pages?: unknown } | undefined)?.extension_pages;
  if (typeof csp !== 'string' || /unsafe-eval|unsafe-inline|https?:|\*/.test(csp)) problems.push('content_security_policy.extension_pages must allow scripts from the package only');
  return problems;
}

// The store's limits (Chrome Web Store, confirmed in the dashboard): the item name is at most 75 characters, the short description at most 132.
export const NAME_MAX = 75;
export const DESCRIPTION_MAX = 132;
// The default language of the listing (Vietnamese, the product's market) and the languages the listing offers.
export const DEFAULT_LOCALE = 'vi';
export const LISTING_LOCALES = ['en', 'vi'] as const;

const MESSAGE_REF = /^__MSG_([A-Za-z0-9_@]+)__$/;
type Messages = Record<string, { message?: unknown } | undefined> | null;

// A localized manifest: `default_locale` is set, the name, the description and the toolbar title are `__MSG_key__` references (a hard-coded text would
// show in every language and leave the store with one listing), and each language in the list has a message for every reference, within the store's limits.
// `locales` maps a language folder name to its parsed messages.json. Adds no permission and changes none.
export function localeViolations(manifest: Record<string, unknown>, locales: Record<string, Messages>): string[] {
  const problems: string[] = [];
  const action = manifest.action as { default_title?: unknown } | undefined;
  const refs = { name: manifest.name, description: manifest.description, 'action.default_title': action?.default_title };
  if (typeof manifest.default_locale !== 'string') problems.push('default_locale must be set');
  else if (!Object.hasOwn(locales, manifest.default_locale)) problems.push(`default_locale ${manifest.default_locale} has no _locales/${manifest.default_locale}/messages.json`);
  else if (manifest.default_locale !== DEFAULT_LOCALE) problems.push(`default_locale must be ${DEFAULT_LOCALE} (the store's default listing is Vietnamese), found ${manifest.default_locale}`);
  for (const lang of LISTING_LOCALES) if (!Object.hasOwn(locales, lang)) problems.push(`_locales/${lang}/messages.json is missing`);
  for (const [field, value] of Object.entries(refs)) {
    const key = typeof value === 'string' ? MESSAGE_REF.exec(value)?.[1] : undefined;
    if (key === undefined) {
      problems.push(`${field} must be a __MSG_key__ reference, found ${JSON.stringify(value)}`);
      continue;
    }
    for (const [lang, messages] of Object.entries(locales)) {
      const text = messages?.[key]?.message;
      if (typeof text !== 'string' || text.trim() === '') problems.push(`_locales/${lang} has no message ${key} for ${field}`);
      else if (field === 'description' && text.length > DESCRIPTION_MAX) problems.push(`_locales/${lang} ${key} is ${text.length} characters, over the store's ${DESCRIPTION_MAX}`);
      else if (field === 'name' && text.length > NAME_MAX) problems.push(`_locales/${lang} ${key} is ${text.length} characters, over the store's ${NAME_MAX}`);
    }
  }
  return problems;
}
