// SPDX-License-Identifier: AGPL-3.0-only
// CROVE_SHARED_DATABASE and CROVE_SHARED_DATABASE_SWITCH (#2284): the settings, and the one combination the kernel refuses.
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';

const base = { DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'x'.repeat(32), AUTH_ISSUER: 'crove-auth' };

describe('CROVE_SHARED_DATABASE', () => {
  it('is off when unset or empty (a compose `${VAR:-}`), on only for true, and refuses anything else', () => {
    expect(loadConfig(base).CROVE_SHARED_DATABASE).toBe('false');
    expect(loadConfig({ ...base, CROVE_SHARED_DATABASE: '' }).CROVE_SHARED_DATABASE).toBe('false');
    expect(loadConfig({ ...base, CROVE_SHARED_DATABASE: 'true' }).CROVE_SHARED_DATABASE).toBe('true');
    for (const bad of ['TRUE', '1', 'yes']) expect(() => loadConfig({ ...base, CROVE_SHARED_DATABASE: bad }), bad).toThrow(/CROVE_SHARED_DATABASE/);
  });

  it('has a separate switch for changing the recorded mode, off by default', () => {
    expect(loadConfig(base).CROVE_SHARED_DATABASE_SWITCH).toBe('false');
    expect(loadConfig({ ...base, CROVE_SHARED_DATABASE_SWITCH: 'true' }).CROVE_SHARED_DATABASE_SWITCH).toBe('true');
    expect(() => loadConfig({ ...base, CROVE_SHARED_DATABASE_SWITCH: 'maybe' })).toThrow(/CROVE_SHARED_DATABASE_SWITCH/);
  });

  it('refuses a transaction-mode pooler (no reset after a checkout), where temporary objects could outlive a request', () => {
    expect(() => loadConfig({ ...base, CROVE_SHARED_DATABASE: 'true', DB_RESET_ON_RELEASE: 'false' })).toThrow(/needs DB_RESET_ON_RELEASE=true/);
    expect(loadConfig({ ...base, CROVE_SHARED_DATABASE: 'true', DB_RESET_ON_RELEASE: 'true' }).DB_RESET_ON_RELEASE).toBe('true');
    // An owned database may sit behind a transaction-mode pooler, as before.
    expect(loadConfig({ ...base, DB_RESET_ON_RELEASE: 'false' }).DB_RESET_ON_RELEASE).toBe('false');
  });
});
