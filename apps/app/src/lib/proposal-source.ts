// SPDX-License-Identifier: AGPL-3.0-only
// The short source tag on a proposal (UI/UX P2-1, #4782; benchmark lesson L7): how the proposal came to be, in four plain
// words, taken only from what the proposal itself recorded, never from model text. A surface that records none of these shows
// no tag. The tag never replaces the plain sentence that says why (DESIGN.md 5.1, "who proposed it"); it sits beside it.
import type { BankMatchedBy } from '@ludy/kernel-contract';

// rule: a rule a person confirmed earlier (a learned bank-line rule). exact: an identifier matched exactly. history: the same
// as the last time (a counter account used before). ai: a model wrote or proposed it.
const PROPOSAL_SOURCE_TAGS = ['rule', 'exact', 'history', 'ai'] as const;
export type ProposalSourceTag = (typeof PROPOSAL_SOURCE_TAGS)[number];

// The matcher's reason a voucher recorded (matchedBy.reason, #2385). A name or a balance match is a looser hint than any of
// the four, so it carries no tag: its sentence already says it. A voucher a person chose by hand (kind 'manual') has none.
export function bankMatchTag(matchedBy: BankMatchedBy | null | undefined): ProposalSourceTag | null {
  if (matchedBy?.kind !== 'suggested') return null;
  switch (matchedBy.reason) {
    case 'tax_code':
    case 'invoice':
      return 'exact';
    case 'learned':
      return 'rule';
    case 'account':
      return 'history';
    default:
      return null;
  }
}
