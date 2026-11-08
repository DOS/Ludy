// SPDX-License-Identifier: AGPL-3.0-only
import type { RuleRef } from './calculator.ts';
import { PAYROLL_RULES } from './rules/index.ts';
import type { PayrollRule } from './rule-types.ts';

export interface RulesUsed {
  /** Every rule the calculations looked at, once each, sorted by id. */
  used: PayrollRule[];
  /** The ones whose status is still `commentary`: the rows that block approving the month, with their sources. */
  commentary: PayrollRule[];
  blocksApproval: boolean;
}

/**
 * The rules a set of calculations (one month's lines) used, and which of them are still `commentary`. The rows come
 * from the rule set by id, so the status is the one now, not the one when the line was calculated: a row the accountant
 * has since confirmed no longer blocks. An id with no row (a line stored under a rule that was removed) is an error,
 * because the month cannot be shown to rest on confirmed rules.
 */
export function listRulesUsed(calculations: readonly { rulesUsed: readonly RuleRef[] }[], rules: readonly PayrollRule[] = PAYROLL_RULES): RulesUsed {
  const byId = new Map(rules.map((row) => [row.id, row]));
  const ids = new Set<string>();
  for (const calculation of calculations) for (const ref of calculation.rulesUsed) ids.add(ref.id);
  const used = [...ids].sort().map((id) => {
    const row = byId.get(id);
    if (row === undefined) throw new Error(`payroll rule ${id} is not in the rule set`);
    return row;
  });
  const commentary = used.filter((row) => row.status === 'commentary');
  return { used, commentary, blocksApproval: commentary.length > 0 };
}
