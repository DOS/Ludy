// SPDX-License-Identifier: AGPL-3.0-only
// The fixed list of what the extension may ask the browser for (meetings plan section 5.7, ADR-0047 point 10). CI builds
// the package and checks the built manifest against it (scripts/check-manifest.mjs); a permission added to the manifest
// without a change here, which the security review sees, fails the build.

export const BASE_PERMISSIONS = ['identity', 'storage'] as const;
// Asked only when the member turns the meetings feature on, and given back when it is turned off.
export const MEETINGS_OPTIONAL_PERMISSIONS = ['offscreen', 'tabCapture'] as const;
// The Ludy cloud address, granted at install.
export const DEFAULT_HOST_PERMISSIONS = ['https://app.ludy.vn/*'] as const;
// A self-hosted address the member types: asked for that one origin at setup, never granted by default. `localhost`
// (plain http) serves the `docker compose up` stack on the member's own machine; 127.0.0.1 and [::1] are not accepted.
export const OPTIONAL_HOST_PERMISSIONS = ['http://localhost/*', 'https://*/*'] as const;

// Manifest keys that would reach sites or run code outside the package.
const FORBIDDEN_KEYS = ['content_scripts', 'externally_connectable', 'web_accessible_resources', 'update_url', 'declarative_net_request', 'sandbox'] as const;

const sameSet = (actual: unknown, expected: readonly string[]): boolean =>
  Array.isArray(actual) && actual.length === expected.length && [...actual].map(String).sort().join('\n') === [...expected].sort().join('\n');

// The reasons the manifest breaks the list, empty when it keeps it.
export function manifestViolations(manifest: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (manifest.manifest_version !== 3) problems.push('manifest_version must be 3');
  if (!sameSet(manifest.permissions, BASE_PERMISSIONS)) problems.push(`permissions must be exactly [${BASE_PERMISSIONS.join(', ')}], found ${JSON.stringify(manifest.permissions)}`);
  if (!sameSet(manifest.optional_permissions, MEETINGS_OPTIONAL_PERMISSIONS)) {
    problems.push(`optional_permissions must be exactly [${MEETINGS_OPTIONAL_PERMISSIONS.join(', ')}], found ${JSON.stringify(manifest.optional_permissions)}`);
  }
  if (!sameSet(manifest.host_permissions, DEFAULT_HOST_PERMISSIONS)) problems.push(`host_permissions must be exactly [${DEFAULT_HOST_PERMISSIONS.join(', ')}], found ${JSON.stringify(manifest.host_permissions)}`);
  if (!sameSet(manifest.optional_host_permissions, OPTIONAL_HOST_PERMISSIONS)) {
    problems.push(`optional_host_permissions must be exactly [${OPTIONAL_HOST_PERMISSIONS.join(', ')}], found ${JSON.stringify(manifest.optional_host_permissions)}`);
  }
  for (const key of FORBIDDEN_KEYS) if (key in manifest) problems.push(`the manifest must not declare ${key}`);
  const csp = (manifest.content_security_policy as { extension_pages?: unknown } | undefined)?.extension_pages;
  if (typeof csp !== 'string' || /unsafe-eval|unsafe-inline|https?:|\*/.test(csp)) problems.push('content_security_policy.extension_pages must allow scripts from the package only');
  return problems;
}

// The store's limits (Chrome Web Store, confirmed in the dashboard): the item name is at most 75 characters, the short description at most 132.
export const NAME_MAX = 75;
export const DESCRIPTION_MAX = 132;
// The languages the store listing offers: the default (Vietnamese) and English.
export const LISTING_LOCALES = ['en', 'vi'] as const;

const MESSAGE_REF = /^__MSG_([A-Za-z0-9_@]+)__$/;
type Messages = Record<string, { message?: unknown } | undefined>;

// A localized manifest: `default_locale` is set, the name, the description and the toolbar title are `__MSG_key__` references (a hard-coded text would
// show in every language and leave the store with one listing), and each language in the list has a message for every reference, within the store's limits.
// `locales` maps a language folder name to its parsed messages.json. Adds no permission and changes none.
export function localeViolations(manifest: Record<string, unknown>, locales: Record<string, Messages>): string[] {
  const problems: string[] = [];
  const action = manifest.action as { default_title?: unknown } | undefined;
  const refs = { name: manifest.name, description: manifest.description, 'action.default_title': action?.default_title };
  if (typeof manifest.default_locale !== 'string') problems.push('default_locale must be set');
  else if (!(manifest.default_locale in locales)) problems.push(`default_locale ${manifest.default_locale} has no _locales/${manifest.default_locale}/messages.json`);
  for (const lang of LISTING_LOCALES) if (!(lang in locales)) problems.push(`_locales/${lang}/messages.json is missing`);
  for (const [field, value] of Object.entries(refs)) {
    const key = typeof value === 'string' ? MESSAGE_REF.exec(value)?.[1] : undefined;
    if (key === undefined) {
      problems.push(`${field} must be a __MSG_key__ reference, found ${JSON.stringify(value)}`);
      continue;
    }
    for (const [lang, messages] of Object.entries(locales)) {
      const text = messages[key]?.message;
      if (typeof text !== 'string' || text.trim() === '') problems.push(`_locales/${lang} has no message ${key} for ${field}`);
      else if (field === 'description' && text.length > DESCRIPTION_MAX) problems.push(`_locales/${lang} ${key} is ${text.length} characters, over the store's ${DESCRIPTION_MAX}`);
      else if (field === 'name' && text.length > NAME_MAX) problems.push(`_locales/${lang} ${key} is ${text.length} characters, over the store's ${NAME_MAX}`);
    }
  }
  return problems;
}
