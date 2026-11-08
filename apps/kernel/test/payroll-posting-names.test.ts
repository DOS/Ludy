// SPDX-License-Identifier: AGPL-3.0-only
// The finance command that records a pay run's posting is named by a literal in its module (the job-egress analyzer reads command names from source), and by PAYROLL_POSTING_COMMAND in the
// contract, the approval policy and the proposal preparers table: they must be the same string.
import { PAYROLL_POSTING_COMMAND } from '@crove/kernel-contract';
import { financeCommands } from '@crove/mod-finance';
import { describe, expect, it } from 'vitest';
import { PROPOSAL_CO_AUTHOR_COMMANDS } from '@crove/kernel';

describe('the payroll posting command name', () => {
  it('is the contract constant in the module, and the one command that may declare co-authors', () => {
    expect(financeCommands.map((c) => c.name)).toContain(PAYROLL_POSTING_COMMAND);
    expect(PROPOSAL_CO_AUTHOR_COMMANDS).toEqual([PAYROLL_POSTING_COMMAND]);
  });
});
