// SPDX-License-Identifier: AGPL-3.0-only
// The features of the shell. A feature shows only when the signed-in org runs its module and the token carries its scope
// (the kernel answers both in /api/extension/me), and it asks the browser for its permissions only when the member turns
// it on. Meetings is the first and, for now, the only one.
export type FeatureId = 'meetings' | 'notes';

export interface Feature {
  id: FeatureId;
  scope: FeatureId;
  // The browser permissions asked when the feature itself turns on; Quick Capture needs none (Web Clipper opts in separately).
  permissions: readonly string[];
}

export const FEATURES: readonly Feature[] = [
  { id: 'meetings', scope: 'meetings', permissions: ['offscreen', 'tabCapture'] },
  { id: 'notes', scope: 'notes', permissions: [] },
];

export interface Me {
  tokenId: string;
  orgId: string;
  scopes: readonly string[];
  expiresAt: string;
  // `agenda` (B2) is set when the token holds the agenda scope and the org runs meetings; it is not a Feature of the shell.
  features: Record<string, boolean>;
}

// The features the member sees: the org runs the module and the token holds the scope.
export function visibleFeatures(me: Pick<Me, 'scopes' | 'features'> | null): Feature[] {
  if (!me) return [];
  return FEATURES.filter((f) => me.scopes.includes(f.scope) && me.features[f.id] === true);
}
