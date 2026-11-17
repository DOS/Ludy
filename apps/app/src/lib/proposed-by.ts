// SPDX-License-Identifier: AGPL-3.0-only
// What chose the accounts of a proposed invoice, as the proposal's header says who proposed it (DESIGN.md §5.1, #3599): one source when it was the same for every
// line that has an account ("Đề xuất bởi Ly (theo từ khóa có sẵn)"), none when the lines differ or none has one (the header then names only who proposed).
export type ProposalSource = 'learned' | 'vendor_default' | 'builtin' | 'user';

const SOURCES: readonly string[] = ['learned', 'vendor_default', 'builtin', 'user'];

export function proposalSource(lines: ReadonlyArray<{ debitAccount: string; accountRule?: { source: string } | null | undefined }>, unclassifiedAccount: string): ProposalSource | null {
  // A line with an account and no rule has no known source: the result is then none, never the source of the others.
  const sources = new Set(lines.filter((l) => l.debitAccount !== unclassifiedAccount).map((l) => (l.accountRule?.source === 'unclassified' ? 'user' : (l.accountRule?.source ?? 'unknown'))));
  const only = sources.size === 1 ? [...sources][0] : undefined;
  return only !== undefined && SOURCES.includes(only) ? (only as ProposalSource) : null;
}
