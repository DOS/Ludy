// SPDX-License-Identifier: AGPL-3.0-only
// The roster of AI coworkers by what they cover, and the default name of an agent installed from a template (#2410).
import { describe, expect, it } from 'vitest';
import { COWORKER_BY_MODULE, COWORKER_KEYS, COWORKER_ROSTER, defaultCoworkerName } from '../src/coworkers.ts';

describe('the roster', () => {
  it('has a name for every key, and no name twice', () => {
    expect(Object.keys(COWORKER_ROSTER).sort()).toEqual([...COWORKER_KEYS].sort());
    const names = Object.values(COWORKER_ROSTER);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[A-Z][a-z]+$/);
  });

  it('gives every module a coworker of the roster, and neither the general manager nor the hidden system one', () => {
    for (const key of Object.values(COWORKER_BY_MODULE)) expect(COWORKER_KEYS).toContain(key);
    expect(Object.values(COWORKER_BY_MODULE)).not.toContain('gm');
    expect(Object.values(COWORKER_BY_MODULE)).not.toContain('system');
  });
});

describe('defaultCoworkerName', () => {
  it('is the name of the coworker of the module’s app, whatever the names are', () => {
    expect(defaultCoworkerName('finance')).toBe(COWORKER_ROSTER.finance);
    for (const module of ['crm', 'conversations']) expect(defaultCoworkerName(module), module).toBe(COWORKER_ROSTER.sales);
    for (const module of ['social', 'ads']) expect(defaultCoworkerName(module), module).toBe(COWORKER_ROSTER.marketing);
  });

  it('has none for a module without one, such as Notes (Vy covers it) or the kernel (Hy is hidden)', () => {
    for (const module of ['notes', 'kernel', 'system', 'unknown', 'constructor']) expect(defaultCoworkerName(module), module).toBeNull();
  });
});
