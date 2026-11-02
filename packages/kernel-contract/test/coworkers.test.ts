// SPDX-License-Identifier: AGPL-3.0-only
// The default name of an agent installed from a template (#2410): the AI coworker of its module.
import { describe, expect, it } from 'vitest';
import { COWORKER_BY_MODULE, defaultCoworkerName } from '../src/coworkers.ts';

describe('defaultCoworkerName', () => {
  it('names the coworker of each department', () => {
    expect(defaultCoworkerName('finance')).toBe('Ly');
    expect(defaultCoworkerName('social')).toBe('My');
    expect(defaultCoworkerName('ads')).toBe('My');
    expect(defaultCoworkerName('crm')).toBe('Thy');
    expect(defaultCoworkerName('conversations')).toBe('Duy');
    expect(defaultCoworkerName('kernel')).toBe('Hy');
    expect(defaultCoworkerName('system')).toBe('Hy');
  });

  it('has none for a module without one, and never for Vy, who is not a template agent', () => {
    expect(defaultCoworkerName('notes')).toBeNull();
    expect(defaultCoworkerName('unknown')).toBeNull();
    expect(defaultCoworkerName('constructor')).toBeNull();
    expect(Object.values(COWORKER_BY_MODULE)).not.toContain('Vy');
  });
});
