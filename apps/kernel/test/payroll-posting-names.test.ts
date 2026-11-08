// SPDX-License-Identifier: AGPL-3.0-only
// The finance commands that record a pay run's posting and its payments are named by a literal in their modules (the job-egress analyzer reads command names from source), and by
// PAYROLL_POSTING_COMMAND and PAYROLL_PAYMENT_COMMAND in the contract, the approval policy and the proposal preparers table: they must be the same strings.
import { PAYROLL_PAYMENT_COMMAND, PAYROLL_POSTING_COMMAND } from '@crove/kernel-contract';
import { financeCommands } from '@crove/mod-finance';
import { describe, expect, it } from 'vitest';
import { PROPOSAL_CO_AUTHOR_COMMANDS } from '@crove/kernel';

describe('the payroll command names', () => {
  it('are the contract constants in the module, and the only commands that may declare co-authors', () => {
    const names = financeCommands.map((c) => c.name);
    expect(names).toContain(PAYROLL_POSTING_COMMAND);
    expect(names).toContain(PAYROLL_PAYMENT_COMMAND);
    expect(PROPOSAL_CO_AUTHOR_COMMANDS).toEqual([PAYROLL_POSTING_COMMAND, PAYROLL_PAYMENT_COMMAND]);
  });
});
