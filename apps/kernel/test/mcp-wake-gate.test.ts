// SPDX-License-Identifier: AGPL-3.0-only
// The gate on the signal wake-ups (ADR-0051, #2975, steps S3 to S5). It was closed while the worker had no entry into a grant's sealed context; step S5 gave the worker its own entry for a
// company grant (`enter_mcp_wake_company_context`, the worker login's alone) and opened it, and this test changed with the flag, which is the review that had to happen. What it pins now:
// the sweep asks exactly the rules that declare `mcp`. That it never enters a member-bound grant's context is pinned against a real database in mcp-wake-sweep.db.test.ts.
import { describe, expect, it } from 'vitest';
import { kernelQueries } from '@crove/kernel';
import { WAKE_RULES } from '../src/mcp-wake-body.ts';
import { SIGNAL_WAKE_WORKER_ENTRY, declaredRules } from '../src/mcp-wake-sweep.ts';

describe('the signal wake-up gate', () => {
  const declaring = kernelQueries({ inboundDomain: null }) as readonly { name: string; mcp?: unknown }[];

  it('is open, now that the worker has its own entry into a company grant\'s context (step S5)', () => {
    expect(SIGNAL_WAKE_WORKER_ENTRY).toBe(true);
  });

  it('asks exactly the rules that declare mcp, and never one that does not', () => {
    for (const rule of WAKE_RULES) expect(declaring.find((q) => q.name === rule)?.mcp, rule).toBeDefined();
    expect(declaredRules(declaring).sort()).toEqual([...WAKE_RULES].sort());
    expect(declaredRules([{ name: WAKE_RULES[0], mcp: { scope: 'ludy.read' } }, { name: WAKE_RULES[1] }])).toEqual([WAKE_RULES[0]]);
    // The gate can still be shut by the caller, and then asks nothing.
    expect(declaredRules(declaring, false)).toEqual([]);
  });
});
