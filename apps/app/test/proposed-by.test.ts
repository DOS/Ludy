// SPDX-License-Identifier: AGPL-3.0-only
// What the proposal's header says chose the accounts (#3599): one source when it was the same for every line that has an account, none otherwise.
import { describe, expect, it } from 'vitest';
import { proposalSource } from '../src/lib/proposed-by.ts';

const U = 'UNCLASSIFIED';
const line = (debitAccount: string, source?: string) => ({ debitAccount, accountRule: source ? { source } : null });

describe('proposalSource', () => {
  it('names the source when every line with an account has the same one', () => {
    expect(proposalSource([line('6422', 'builtin'), line('6421', 'builtin')], U)).toBe('builtin');
    expect(proposalSource([line('6422', 'learned')], U)).toBe('learned');
    expect(proposalSource([line('6422', 'vendor_default')], U)).toBe('vendor_default');
  });
  it('reads a source the person set as "user"', () => {
    expect(proposalSource([line('6422', 'user')], U)).toBe('user');
    expect(proposalSource([line('6422', 'unclassified')], U)).toBe('user');
  });
  it('leaves out lines still unclassified, and names nothing when sources differ or none is known', () => {
    expect(proposalSource([line('6422', 'builtin'), line(U, 'unclassified')], U)).toBe('builtin');
    expect(proposalSource([line('6422', 'builtin'), line('6421', 'learned')], U)).toBeNull();
    expect(proposalSource([line(U, 'unclassified')], U)).toBeNull();
    expect(proposalSource([line('6422')], U)).toBeNull();
    // An account with no rule behind it has an unknown source: it is not left out, so it keeps the others' source from being named.
    expect(proposalSource([line('6422', 'builtin'), line('6421')], U)).toBeNull();
    expect(proposalSource([], U)).toBeNull();
  });
});
