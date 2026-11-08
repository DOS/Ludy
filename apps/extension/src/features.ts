// SPDX-License-Identifier: AGPL-3.0-only
// The features of the shell. A feature shows only when the signed-in org runs its module and the token carries its scope
// (the kernel answers both in /api/extension/me), and it asks the browser for its permissions only when the member turns
// it on. Meetings is the first and, for now, the only one.
export interface Feature {
  id: 'meetings';
  scope: 'meetings';
  // The browser permissions asked when it is turned on, given back when it is turned off. None names a site.
  permissions: readonly string[];
}

export const FEATURES: readonly Feature[] = [{ id: 'meetings', scope: 'meetings', permissions: ['offscreen', 'tabCapture'] }];

export interface Me {
  tokenId: string;
  orgId: string;
  scopes: readonly string[];
  expiresAt: string;
  features: Record<string, boolean>;
}

// The features the member sees: the org runs the module and the token holds the scope.
export function visibleFeatures(me: Pick<Me, 'scopes' | 'features'> | null): Feature[] {
  if (!me) return [];
  return FEATURES.filter((f) => me.scopes.includes(f.scope) && me.features[f.id] === true);
}
