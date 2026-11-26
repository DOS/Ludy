// SPDX-License-Identifier: AGPL-3.0-only
// LUDY_SHARED_DATABASE and LUDY_SHARED_DATABASE_SWITCH (#2284): the settings, and the one combination the kernel refuses.
import { describe, expect, it } from 'vitest';
import { assertNoRetiredMigrateCredentials, loadConfig } from '../src/config.ts';

const base = { DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'x'.repeat(32), AUTH_ISSUER: 'ludy-auth' };

describe('LUDY_SHARED_DATABASE', () => {
  it('is off when unset or empty (a compose `${VAR:-}`), on only for true, fails closed on non-empty retired CROVE_SHARED_DATABASE, and refuses anything else', () => {
    expect(loadConfig(base).LUDY_SHARED_DATABASE).toBe('false');
    expect(loadConfig({ ...base, LUDY_SHARED_DATABASE: '' }).LUDY_SHARED_DATABASE).toBe('false');
    expect(loadConfig({ ...base, CROVE_SHARED_DATABASE: '  ' }).LUDY_SHARED_DATABASE).toBe('false');
    expect(() => loadConfig({ ...base, CROVE_SHARED_DATABASE: 'true' })).toThrow(/CROVE_SHARED_DATABASE.*LUDY_SHARED_DATABASE/);
    expect(loadConfig({ ...base, LUDY_SHARED_DATABASE: 'true' }).LUDY_SHARED_DATABASE).toBe('true');
    for (const bad of ['TRUE', '1', 'yes']) expect(() => loadConfig({ ...base, LUDY_SHARED_DATABASE: bad }), bad).toThrow(/LUDY_SHARED_DATABASE/);
  });

  it('has a separate switch for changing the recorded mode, off by default', () => {
    expect(loadConfig(base).LUDY_SHARED_DATABASE_SWITCH).toBe('false');
    expect(loadConfig({ ...base, CROVE_SHARED_DATABASE_SWITCH: '' }).LUDY_SHARED_DATABASE_SWITCH).toBe('false');
    expect(() => loadConfig({ ...base, CROVE_SHARED_DATABASE_SWITCH: 'true' })).toThrow(/CROVE_SHARED_DATABASE_SWITCH.*LUDY_SHARED_DATABASE_SWITCH/);
    expect(loadConfig({ ...base, LUDY_SHARED_DATABASE_SWITCH: 'true' }).LUDY_SHARED_DATABASE_SWITCH).toBe('true');
    expect(() => loadConfig({ ...base, LUDY_SHARED_DATABASE_SWITCH: 'maybe' })).toThrow(/LUDY_SHARED_DATABASE_SWITCH/);
  });

  it('refuses the database session check, whose auth-grants step a shared database refuses', () => {
    expect(() => loadConfig({ ...base, LUDY_SHARED_DATABASE: 'true', AUTH_SESSION_CHECK: 'db' })).toThrow(/cannot use AUTH_SESSION_CHECK=db/);
    expect(loadConfig({ ...base, AUTH_SESSION_CHECK: 'db' }).AUTH_SESSION_CHECK).toBe('db');
  });

  it('refuses a URL on port 6543, the transaction-mode pooler of Supabase, and takes the direct and session-mode port', () => {
    for (const name of ['DATABASE_URL', 'WORKER_DATABASE_URL']) {
      expect(() => loadConfig({ ...base, LUDY_SHARED_DATABASE: 'true', [name]: 'postgres://u:p@pooler.example.com:6543/postgres' }), name).toThrow(new RegExp(`${name} points at port 6543`));
    }
    expect(loadConfig({ ...base, LUDY_SHARED_DATABASE: 'true', DATABASE_URL: 'postgres://u:p@pooler.example.com:5432/postgres' }).LUDY_SHARED_DATABASE).toBe('true');
    // An owned database is not touched by the check.
    expect(loadConfig({ ...base, DATABASE_URL: 'postgres://u:p@pooler.example.com:6543/postgres' }).LUDY_SHARED_DATABASE).toBe('false');
  });

  it('refuses a transaction-mode pooler (no reset after a checkout), where temporary objects could outlive a request', () => {
    expect(() => loadConfig({ ...base, LUDY_SHARED_DATABASE: 'true', DB_RESET_ON_RELEASE: 'false' })).toThrow(/needs DB_RESET_ON_RELEASE=true/);
    expect(loadConfig({ ...base, LUDY_SHARED_DATABASE: 'true', DB_RESET_ON_RELEASE: 'true' }).DB_RESET_ON_RELEASE).toBe('true');
    // An owned database may sit behind a transaction-mode pooler, as before.
    expect(loadConfig({ ...base, DB_RESET_ON_RELEASE: 'false' }).DB_RESET_ON_RELEASE).toBe('false');
  });
});

describe('assertNoRetiredMigrateCredentials (#3972)', () => {
  it('allows fresh compose defaults and valid LUDY_* credentials without retired CROVE_* entries', () => {
    expect(() =>
      assertNoRetiredMigrateCredentials({
        LUDY_APP_DB_PASSWORD: 'local-app-password',
        LUDY_WORKER_DB_PASSWORD: 'local-worker-password',
        LUDY_PROBER_DB_PASSWORD: 'local-prober-password',
        LUDY_REPORTER_DB_PASSWORD: 'local-reporter-password',
        LUDY_RETIRED_CREDENTIALS: '   ',
      }),
    ).not.toThrow();

    expect(() =>
      assertNoRetiredMigrateCredentials({
        LUDY_RETIRED_CREDENTIALS: 'CROVE_APP_DB_PASSWORD CROVE_CONTEXT_TOKEN_KEY',
        LUDY_APP_DB_PASSWORD: 'real-app-password',
        LUDY_CONTEXT_TOKEN_KEY: 'real-context-key',
      }),
    ).not.toThrow();
  });

  it('fails closed without leaking secret values when retired CROVE_* credentials are present without non-default LUDY_* values', () => {
    const leaked = 'super-secret-legacy-pw';
    expect(() =>
      assertNoRetiredMigrateCredentials({
        LUDY_RETIRED_CREDENTIALS: 'CROVE_APP_DB_PASSWORD CROVE_CONTEXT_TOKEN_KEY',
        LUDY_APP_DB_PASSWORD: 'local-app-password',
        LUDY_CONTEXT_TOKEN_KEY: '',
      }),
    ).toThrow(/CROVE_APP_DB_PASSWORD->LUDY_APP_DB_PASSWORD, CROVE_CONTEXT_TOKEN_KEY->LUDY_CONTEXT_TOKEN_KEY/);

    try {
      assertNoRetiredMigrateCredentials({
        CROVE_WORKER_DB_PASSWORD: leaked,
        LUDY_WORKER_DB_PASSWORD: 'local-worker-password',
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('CROVE_WORKER_DB_PASSWORD->LUDY_WORKER_DB_PASSWORD');
      expect(msg).not.toContain(leaked);
    }
  });
});
