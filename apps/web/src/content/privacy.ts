// SPDX-License-Identifier: AGPL-3.0-only
// The shape of the privacy page's copy (/privacy, /en/privacy). Both languages are typed from the Vietnamese file, as the
// app pages' are, so a block missing from the English copy fails typecheck. Every claim is something the code or an
// accepted ADR does today (docs/runbooks/extension-store.md "Privacy practices", ADR-0047, docs/plan/meetings.md sections
// 8 and 9, docs/legal/privacy.vi.md); a value the repository does not hold (operator legal name, address, contact email,
// a provider's name or country) is left out, never written as a placeholder.
export type PrivacyBlock =
  | { kind: 'p'; text: string }
  | { kind: 'list'; items: readonly string[] }
  | { kind: 'table'; caption: string; head: readonly [string, string, string]; rows: ReadonlyArray<readonly [string, string, string]> };

export interface PrivacySection {
  id: string;
  title: string;
  blocks: readonly PrivacyBlock[];
}

export interface PrivacyCopy {
  meta: { title: string; description: string };
  ogTitle: string;
  crumbLabel: string;
  title: string;
  lead: string;
  // "Version 1.0, effective 13 November 2026", and the line that the policy is under review.
  versionLine: string;
  reviewNotice: string;
  contentsTitle: string;
  sections: readonly PrivacySection[];
  contact: { emailLead: string };
}
