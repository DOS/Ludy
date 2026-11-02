// SPDX-License-Identifier: AGPL-3.0-only
// The roster of AI coworkers by role, and the default name of an agent installed from a template (#2410).
import { describe, expect, it } from 'vitest';
import { COWORKER_ROLES, COWORKER_ROLE_BY_MODULE, COWORKER_ROSTER, defaultCoworkerName } from '../src/coworkers.ts';

describe('the roster', () => {
  it('has a name for every role, and no name twice', () => {
    expect(Object.keys(COWORKER_ROSTER).sort()).toEqual([...COWORKER_ROLES].sort());
    const names = Object.values(COWORKER_ROSTER);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[A-Z][a-z]+$/);
  });

  it('gives every module a role of the roster, and the general manager none', () => {
    for (const role of Object.values(COWORKER_ROLE_BY_MODULE)) expect(COWORKER_ROLES).toContain(role);
    expect(Object.values(COWORKER_ROLE_BY_MODULE)).not.toContain('gm');
  });
});

describe('defaultCoworkerName', () => {
  it('is the name of the role of the module, whatever the names are', () => {
    expect(defaultCoworkerName('finance')).toBe(COWORKER_ROSTER.finance);
    expect(defaultCoworkerName('social')).toBe(COWORKER_ROSTER.marketing);
    expect(defaultCoworkerName('ads')).toBe(COWORKER_ROSTER.marketing);
    expect(defaultCoworkerName('crm')).toBe(COWORKER_ROSTER.sales);
    expect(defaultCoworkerName('conversations')).toBe(COWORKER_ROSTER.sales);
    expect(defaultCoworkerName('kernel')).toBe(COWORKER_ROSTER.system);
    expect(defaultCoworkerName('system')).toBe(COWORKER_ROSTER.system);
  });

  it('has none for a module without one, and never the general manager', () => {
    expect(defaultCoworkerName('notes')).toBeNull();
    expect(defaultCoworkerName('unknown')).toBeNull();
    expect(defaultCoworkerName('constructor')).toBeNull();
    expect(Object.values(COWORKER_ROLE_BY_MODULE).map((r) => COWORKER_ROSTER[r])).not.toContain(COWORKER_ROSTER.gm);
  });
});
