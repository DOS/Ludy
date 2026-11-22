// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { checkEnvPair, readEnvPair } from '../src/env.ts';

describe('env pair resolution (#3967)', () => {
  it('prefers primary LUDY_* and falls back to legacy CROVE_* when unset or blank', () => {
    expect(checkEnvPair({ LUDY_MODULES: 'finance', CROVE_MODULES: '' }, 'LUDY_MODULES', 'CROVE_MODULES')).toEqual({
      ok: true,
      value: 'finance',
      source: 'primary',
    });
    expect(checkEnvPair({ LUDY_MODULES: '   ', CROVE_MODULES: 'hr' }, 'LUDY_MODULES', 'CROVE_MODULES')).toEqual({
      ok: true,
      value: 'hr',
      source: 'legacy',
    });
    expect(checkEnvPair({ LUDY_MODULES: ' finance ', CROVE_MODULES: 'finance' }, 'LUDY_MODULES', 'CROVE_MODULES')).toEqual({
      ok: true,
      value: 'finance',
      source: 'both',
    });
    expect(checkEnvPair({}, 'LUDY_MODULES', 'CROVE_MODULES')).toEqual({
      ok: true,
      value: undefined,
      source: 'unset',
    });
  });

  it('fails closed without echoing secret values when both variables differ', () => {
    const result = checkEnvPair(
      { LUDY_CONTEXT_TOKEN_KEY: 'super-secret-a', CROVE_CONTEXT_TOKEN_KEY: 'super-secret-b' },
      'LUDY_CONTEXT_TOKEN_KEY',
      'CROVE_CONTEXT_TOKEN_KEY',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('LUDY_CONTEXT_TOKEN_KEY');
      expect(result.error).toContain('CROVE_CONTEXT_TOKEN_KEY');
      expect(result.error).not.toContain('super-secret-a');
      expect(result.error).not.toContain('super-secret-b');
    }
    expect(() =>
      readEnvPair(
        { LUDY_SHARED_DATABASE: 'true', CROVE_SHARED_DATABASE: 'false' },
        'LUDY_SHARED_DATABASE',
        'CROVE_SHARED_DATABASE',
      ),
    ).toThrow(/conflicting values/);
  });
});
