// SPDX-License-Identifier: AGPL-3.0-only
// Regression guard for #5257 (the cycle left after #4022): importing src/expense-variance.ts or src/unusual-entries.ts directly, without src/index.ts, must not read a constant that is still in its
// temporal dead zone. expense-variance.ts -> conversation.ts -> index.ts -> ... -> unusual-entries.ts used to evaluate `UNUSUAL_ENTRIES_NOTE_MAX = EXPENSE_VARIANCE_NOTE_MAX` while expense-variance.ts was
// still loading. Each case starts from a fresh module registry, so the module under test is the first of the cycle to be entered.
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
});

describe('direct module imports of the two note modules (#5257)', () => {
  it('loads src/unusual-entries.ts on its own from a fresh module registry', async () => {
    vi.resetModules();
    const mod = await import('../src/unusual-entries.ts');
    expect(mod.UNUSUAL_ENTRIES_NOTE_MAX).toBe(220);
    expect(mod.unusualEntriesNotesHaveNews({ hits: [{ rule: 'off_day', sourceKind: 'manual' }] })).toBe(true);
  });

  it('loads src/expense-variance.ts on its own from a fresh module registry, and then the unusual entries one', async () => {
    vi.resetModules();
    const variance = await import('../src/expense-variance.ts');
    expect(variance.EXPENSE_VARIANCE_NOTE_MAX).toBe(220);
    const unusual = await import('../src/unusual-entries.ts');
    expect(unusual.UNUSUAL_ENTRIES_NOTE_MAX).toBe(variance.EXPENSE_VARIANCE_NOTE_MAX);
  });

  it('keeps the two limits in the leaf module and the same through src/index.ts', async () => {
    vi.resetModules();
    const limits = await import('../src/note-limits.ts');
    const index = await import('../src/index.ts');
    expect(limits.EXPENSE_VARIANCE_NOTE_MAX).toBe(index.EXPENSE_VARIANCE_NOTE_MAX);
    expect(limits.UNUSUAL_ENTRIES_NOTE_MAX).toBe(index.UNUSUAL_ENTRIES_NOTE_MAX);
    // The two notes share their text checks, so they share their limit.
    expect(limits.UNUSUAL_ENTRIES_NOTE_MAX).toBe(limits.EXPENSE_VARIANCE_NOTE_MAX);
  });
});
