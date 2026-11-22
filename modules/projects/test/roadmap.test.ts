// SPDX-License-Identifier: AGPL-3.0-only
// Unit checks for Projects Public Roadmap contracts, embed origin validation, and OTP email rendering (#4399).
import { describe, expect, it } from 'vitest';
import {
  normalizeRoadmapEmbedOrigin,
  zRoadmapBoardCreateInput,
  zRoadmapEmbedOrigin,
  zRoadmapPublicOtpRequestInput,
  zRoadmapPublicOtpVerifyInput,
  zRoadmapPublicSubmitIdeaInput,
} from '@ludy/kernel-contract';
import {
  generateEphemeralOtpWrapKey,
  openEphemeralOtpCode,
  renderRoadmapOtpMail,
  sealEphemeralOtpCode,
} from '../src/roadmap-mail.ts';

describe('projects roadmap embed origins and contracts (#4399)', () => {
  it('accepts strict HTTPS origins without path, query, fragment, trailing slash, or wildcards and rejects unsafe inputs', () => {
    expect(normalizeRoadmapEmbedOrigin('https://app.example.com')).toBe('https://app.example.com');
    expect(normalizeRoadmapEmbedOrigin('HTTPS://Portal.Example.VN:8443')).toBe('https://portal.example.vn:8443');

    expect(normalizeRoadmapEmbedOrigin('https://app.example.com/')).toBeNull();
    expect(normalizeRoadmapEmbedOrigin('http://app.example.com')).toBeNull();
    expect(normalizeRoadmapEmbedOrigin('https://*.example.com')).toBeNull();
    expect(normalizeRoadmapEmbedOrigin('https://app.example.com/path')).toBeNull();
    expect(normalizeRoadmapEmbedOrigin('https://user@app.example.com')).toBeNull();
    expect(normalizeRoadmapEmbedOrigin('*')).toBeNull();
    expect(normalizeRoadmapEmbedOrigin('javascript:alert(1)')).toBeNull();
    expect(normalizeRoadmapEmbedOrigin('null')).toBeNull();

    expect(zRoadmapEmbedOrigin.parse('HTTPS://portal.example.com')).toBe('https://portal.example.com');
    expect(() => zRoadmapEmbedOrigin.parse('http://insecure.example.com')).toThrow();
    expect(() => zRoadmapEmbedOrigin.parse('https://app.example.com/')).toThrow();
    expect(() => zRoadmapEmbedOrigin.parse('https://*.example.com')).toThrow();
  });

  it('validates board slugs, 6-digit OTP inputs, and trims idea submissions safely', () => {
    const board = zRoadmapBoardCreateInput.parse({
      title: '  Lo trinh san pham 2027  ',
      slug: 'Roadmap-Q1',
      embedAllowedOrigins: ['HTTPS://app.example.com', 'https://docs.example.com:8443'],
    });
    expect(board.title).toBe('Lo trinh san pham 2027');
    expect(board.slug).toBe('roadmap-q1');
    expect(board.embedAllowedOrigins).toEqual(['https://app.example.com', 'https://docs.example.com:8443']);

    expect(() => zRoadmapBoardCreateInput.parse({ title: 'X', slug: 'bad/slug' })).toThrow();

    expect(zRoadmapPublicOtpRequestInput.parse({ email: '  voter@example.test  ' })).toEqual({
      email: 'voter@example.test',
    });
    expect(zRoadmapPublicOtpVerifyInput.parse({ email: 'voter@example.test', code: '048291' }).code).toBe('048291');
    expect(() => zRoadmapPublicOtpVerifyInput.parse({ email: 'voter@example.test', code: 'abc123' })).toThrow();

    const idea = zRoadmapPublicSubmitIdeaInput.parse({
      title: '  Dark mode exports  ',
      summary: '   Please export monthly totals in PDF.   ',
      category: '  Reporting  ',
      displayName: '  Minh  ',
    });
    expect(idea).toEqual({
      title: 'Dark mode exports',
      summary: 'Please export monthly totals in PDF.',
      category: 'Reporting',
      displayName: 'Minh',
    });
  });
});

describe('renderRoadmapOtpMail (#4399)', () => {
  it('renders vi and en emails cleanly while escaping HTML special characters and stripping header newlines', () => {
    const payload = {
      lang: 'vi' as const,
      orgName: 'Cong ty\r\n<script>alert(1)</script>',
      boardId: '00000000-0000-4000-8000-000000000002',
      boardTitle: '<b>Public</b> & "Ideas"',
      otpId: '00000000-0000-4000-8000-000000000003',
      expiresAt: '2027-01-01T00:10:00.000Z',
    };

    const viMail = renderRoadmapOtpMail(payload, { brand: 'Ludy', code: '492817' });
    expect(viMail.text).toContain('492817');
    expect(viMail.text).not.toContain('\r\n<script>');
    expect(viMail.html).toContain('&lt;b&gt;Public&lt;/b&gt; &amp; &quot;Ideas&quot;');
    expect(viMail.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(viMail.html).not.toContain('<script>');
    expect(viMail.html).toContain('492817');

    const enMail = renderRoadmapOtpMail({ ...payload, lang: 'en' }, { brand: 'Ludy', code: '771122' });
    expect(enMail.text).toContain('Your verification code for');
    expect(enMail.text).toContain('771122');
    expect(enMail.html).toContain('Verification code');
    expect(enMail.html).toContain('771122');
  });

  it('seals and opens 6-digit OTPs under ephemeral worker-RAM keys with AAD binding and zero digits in wrapKey', () => {
    const key = generateEphemeralOtpWrapKey();
    expect(key).toMatch(/^[a-p]{64}$/);
    expect(key).not.toMatch(/\d/);

    const aad = 'board-1:otp-1';
    const sealed = sealEphemeralOtpCode('482910', key, aad);
    expect(sealed).not.toContain('482910');
    expect(openEphemeralOtpCode(sealed, key, aad)).toBe('482910');

    expect(() => openEphemeralOtpCode(sealed, key, 'board-1:otp-other')).toThrow();
    expect(() => openEphemeralOtpCode(sealed, generateEphemeralOtpWrapKey(), aad)).toThrow();
  });
});
