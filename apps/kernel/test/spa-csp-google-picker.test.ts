// SPDX-License-Identifier: AGPL-3.0-only
// The SPA's Content-Security-Policy with Google Picker (#3174, ADR-0025 amendment of 2026-11-25): off, it is byte for byte what it was; on, it gains only the named Google hosts and Trusted Types policy names,
// nothing wide (no wildcard, no `https:`, no `unsafe-*`), and the requirement of Trusted Types for scripts stays.
import { describe, expect, it } from 'vitest';
import { GOOGLE_PICKER_CONNECT_SRC, GOOGLE_PICKER_FRAME_SRC, GOOGLE_PICKER_SCRIPT_SRC, GOOGLE_PICKER_STYLE_SRC, GOOGLE_PICKER_TRUSTED_TYPES, contentSecurityPolicy } from '../src/http.ts';

const directives = (csp: string) => new Map(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([name, ...values]) => [name, values.join(' ')]));

describe('the SPA policy with Google Picker', () => {
  it('is exactly the old policy when Picker is off, with or without Turnstile', () => {
    for (const turnstile of [false, true]) {
      expect(contentSecurityPolicy('/auth/v1', null, turnstile, null, null, null, false)).toBe(contentSecurityPolicy('/auth/v1', null, turnstile));
    }
    const off = contentSecurityPolicy('/auth/v1', null);
    expect(off).not.toMatch(/google/u);
    expect(off).not.toContain('frame-src');
    expect(directives(off).get('trusted-types')).toBe('ludy-sw');
  });

  it('adds only the named Google hosts and policy names when Picker is on', () => {
    const on = directives(contentSecurityPolicy('/auth/v1', null, false, null, null, null, true));
    expect(on.get('script-src')).toBe(`'self' ${GOOGLE_PICKER_SCRIPT_SRC.join(' ')}`);
    expect(on.get('style-src')).toBe(`'self' ${GOOGLE_PICKER_STYLE_SRC.join(' ')}`);
    expect(on.get('frame-src')).toBe(GOOGLE_PICKER_FRAME_SRC.join(' '));
    expect(on.get('connect-src')).toBe(`'self' http://localhost ${GOOGLE_PICKER_CONNECT_SRC.join(' ')}`);
    expect(on.get('trusted-types')).toBe(`ludy-sw ${GOOGLE_PICKER_TRUSTED_TYPES.join(' ')}`);
    // The rest is unchanged, and Trusted Types are still required for scripts.
    expect(on.get('default-src')).toBe("'self'");
    expect(on.get('require-trusted-types-for')).toBe("'script'");
    expect(on.get('object-src')).toBe("'none'");
    expect(on.get('frame-ancestors')).toBe("'none'");
    expect(on.get('img-src')).toBe("'self' blob: data:");
  });

  it('adds nothing wide: no wildcard, no scheme-only source, no unsafe keyword, no google origin broader than the lists', () => {
    const csp = contentSecurityPolicy('/auth/v1', null, true, null, null, null, true);
    expect(csp).not.toMatch(/\*|unsafe-/u);
    expect(csp).not.toMatch(/(^|[\s;])https:(\s|;|$)/u);
    for (const source of [...GOOGLE_PICKER_SCRIPT_SRC, ...GOOGLE_PICKER_FRAME_SRC, ...GOOGLE_PICKER_CONNECT_SRC, ...GOOGLE_PICKER_STYLE_SRC]) expect(source).toMatch(/^https:\/\/(apis|accounts|docs)\.google\.com(\/gsi\/(client|style)?)?$/u);
    // With Turnstile too: both frames, both policy names, one trusted-types directive.
    const both = directives(csp);
    expect(both.get('frame-src')).toBe(`https://challenges.cloudflare.com ${GOOGLE_PICKER_FRAME_SRC.join(' ')}`);
    expect(both.get('trusted-types')).toBe(`ludy-sw ludy-turnstile ${GOOGLE_PICKER_TRUSTED_TYPES.join(' ')}`);
  });

  it('keeps the Sign page and the other policies without Google (the picker flag is the SPA\'s only)', () => {
    expect(contentSecurityPolicy('/auth/v1', null, false, null, null, null, false)).not.toMatch(/google/u);
  });
});
