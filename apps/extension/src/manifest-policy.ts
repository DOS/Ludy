// SPDX-License-Identifier: AGPL-3.0-only
// The fixed list of what the extension may ask the browser for (meetings plan section 5.7, ADR-0047 point 10). CI builds
// the package and checks the built manifest against it (scripts/check-manifest.mjs); a permission added to the manifest
// without a change here, which the security review sees, fails the build.

export const BASE_PERMISSIONS = ['identity', 'storage'] as const;
// Asked only when the member turns the meetings feature on, and given back when it is turned off.
export const MEETINGS_OPTIONAL_PERMISSIONS = ['offscreen', 'tabCapture'] as const;
// The Ludy cloud address, granted at install.
export const DEFAULT_HOST_PERMISSIONS = ['https://app.ludy.vn/*'] as const;
// A self-hosted address the member types: asked for that one origin at setup, never granted by default. A loopback
// address serves the `docker compose up` stack on the member's own machine.
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
