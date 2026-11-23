// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { slugify } from '../src/identity.ts';

describe('slugify (#4121)', () => {
  it('transliterates Vietnamese diacritics and đ/Đ into lowercase hyphenated slugs', () => {
    expect(slugify('Công ty TNHH Đặng & Cộng sự')).toBe('cong-ty-tnhh-dang-cong-su');
    expect(slugify('Đà Nẵng')).toBe('da-nang');
  });

  it('strips leading/trailing non-alphanumerics and collapses repeated separators', () => {
    expect(slugify('---Acme---Corp---')).toBe('acme-corp');
    expect(slugify('   ***Hello___World!!!   ')).toBe('hello-world');
  });

  it('caps slugs at 40 characters and strips any trailing hyphen introduced by slicing', () => {
    expect(slugify(`${'a'.repeat(39)} bbb`)).toBe('a'.repeat(39));
    expect(slugify('a'.repeat(50))).toBe('a'.repeat(40));
  });

  it('falls back to a random org-* slug when fewer than 3 ASCII alphanumerics remain', () => {
    expect(slugify('')).toMatch(/^org-[a-z0-9]{1,6}$/);
    expect(slugify('ab')).toMatch(/^org-[a-z0-9]{1,6}$/);
    expect(slugify('---')).toMatch(/^org-[a-z0-9]{1,6}$/);
  });

  it('handles adversarial long hyphen runs in linear time', () => {
    const start = performance.now();
    expect(slugify(`${'-'.repeat(50_000)}acme`)).toBe('acme');
    expect(slugify(`acme${'-'.repeat(50_000)}`)).toBe('acme');
    expect(slugify('-'.repeat(50_000))).toMatch(/^org-[a-z0-9]{1,6}$/);
    expect(performance.now() - start).toBeLessThan(200);
  });
});
