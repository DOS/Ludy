// SPDX-License-Identifier: AGPL-3.0-only
// The gate on the signal wake-ups (ADR-0051, #2975, steps S3 to S5): the kernel's rules declare `mcp` for the pull tool, but the worker's sweep may not ask them until the worker has its own
// entry into a grant's sealed context (step S5; a company grant's entry is the API login's alone). So the sweep makes no rule call while SIGNAL_WAKE_WORKER_ENTRY is false, whatever the
// rules declare. Flipping the flag is S5's change and changes this test with it, which is the review that must happen.
import { describe, expect, it } from 'vitest';
import { kernelQueries } from '@crove/kernel';
import { WAKE_RULES } from '../src/mcp-wake-body.ts';
import { SIGNAL_WAKE_WORKER_ENTRY, declaredRules } from '../src/mcp-wake-sweep.ts';

describe('the signal wake-up gate', () => {
  const declaring = kernelQueries({ inboundDomain: null }) as readonly { name: string; mcp?: unknown }[];

  it('is closed until the worker can enter a grant\'s context (step S5)', () => {
    expect(SIGNAL_WAKE_WORKER_ENTRY).toBe(false);
  });

  it('asks no rule while it is closed, although the real rules declare mcp', () => {
    // The pull tool needs the rules to declare it, so they do today: the gate is what keeps the sweep quiet.
    for (const rule of WAKE_RULES) expect(declaring.find((q) => q.name === rule)?.mcp, rule).toBeDefined();
    expect(declaredRules(declaring)).toEqual([]);
    expect(declaredRules([{ name: WAKE_RULES[0], mcp: { scope: 'ludy.read' } }])).toEqual([]);
  });

  it('asks exactly the rules that declare mcp once it is open, and never one that does not', () => {
    expect(declaredRules(declaring, true).sort()).toEqual([...WAKE_RULES].sort());
    expect(declaredRules([{ name: WAKE_RULES[0], mcp: { scope: 'ludy.read' } }, { name: WAKE_RULES[1] }], true)).toEqual([WAKE_RULES[0]]);
  });
});
