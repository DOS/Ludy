// SPDX-License-Identifier: AGPL-3.0-only
// The sets of the stale-deal next steps are written twice: the database copy in packages/db (which check-unions compares with the CHECK
// constraints) and the contract's in packages/kernel-contract (which the screens and the schemas use). They must stay equal.
import { describe, expect, it } from 'vitest';
import { DEAL_NEXT_STEP_CLOSE_REASONS, DEAL_NEXT_STEP_REASONS, DEAL_NEXT_STEP_STATUSES } from '@crove/db';
import { DEAL_NEXT_STEP_REASONS as CONTRACT_REASONS } from '@crove/kernel-contract';

describe('the next step sets (#2381)', () => {
  it('has one list of reasons in the database package and the contract', () => {
    expect([...CONTRACT_REASONS]).toEqual([...DEAL_NEXT_STEP_REASONS]);
  });

  it('keeps the database sets the screens rely on', () => {
    expect([...DEAL_NEXT_STEP_STATUSES]).toEqual(['open', 'done', 'closed']);
    expect([...DEAL_NEXT_STEP_CLOSE_REASONS]).toEqual(['deal_edited', 'deal_moved', 'deal_closed', 'quote_decided']);
  });
});
