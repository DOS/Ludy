// SPDX-License-Identifier: AGPL-3.0-only
// Regression coverage for the Ludy eSign public landing page (/esign and /en/esign, #4605):
// verifies Slices 1 through 5 coverage, bilingual group/visual parity, and DESIGN.md visual/copy rules.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { esignEn } from '../src/content/esign-en';
import { esignVi } from '../src/content/esign-vi';

const WEB_SRC = join(import.meta.dirname, '..', 'src');

describe('Ludy eSign landing page (#4605)', () => {
  it('covers Slices 1 through 5 capabilities in both Vietnamese and English', () => {
    const viText = JSON.stringify(esignVi);
    const enText = JSON.stringify(esignEn);

    expect(esignVi.groups.items).toHaveLength(6);
    expect(esignEn.groups.items).toHaveLength(6);

    for (const token of [
      '/-/sign#<token>',
      '/-/sign/d#<token>',
      '/-/sign/p/<orgSlug>',
      '{{signature, r1}}',
      'SHA-256',
      'PAdES-LTV',
      '337/2025/NĐ-CP',
      'Điều 301',
      'whsec_',
      'ludy.read',
      'ludy_sk_*',
      '/api/v1/sign/*',
      'sign:draft',
      'VNPT SmartCA',
      'Viettel MySign',
      'MISA WeSign',
    ]) {
      expect(viText, `vi missing ${token}`).toContain(token);
    }

    for (const token of [
      '/-/sign#<token>',
      '/-/sign/d#<token>',
      '/-/sign/p/<orgSlug>',
      '{{signature, r1}}',
      'SHA-256',
      'PAdES-LTV',
      '337/2025/ND-CP',
      'Article 301',
      'whsec_',
      'ludy.read',
      'ludy_sk_*',
      '/api/v1/sign/*',
      'sign:draft',
      'VNPT SmartCA',
      'Viettel MySign',
      'MISA WeSign',
    ]) {
      expect(enText, `en missing ${token}`).toContain(token);
    }
  });

  it('wires every eSign feature group id to a visual in esign-page.tsx without DESIGN.md violations', () => {
    const pageSource = readFileSync(join(WEB_SRC, 'components', 'apps', 'esign-page.tsx'), 'utf8');
    const visualsSource = readFileSync(join(WEB_SRC, 'components', 'apps', 'esign-visuals.tsx'), 'utf8');

    for (let i = 0; i < esignVi.groups.items.length; i++) {
      expect(pageSource).toContain(`copy.groups.items[${i}]!.id`);
    }

    expect(visualsSource).not.toContain('shadow-2xl');
    expect(visualsSource).not.toMatch(/size-(?:11|12)\b[^"]*rounded-xl|rounded-xl[^"]*size-(?:11|12)\b/);
    expect(visualsSource).not.toMatch(/<h[1-6]\b/);
    expect(visualsSource).not.toMatch(/[\u2013\u2014]/);
  });

  it('keeps every font-mono token strictly ASCII so unpreloaded JetBrains Mono subsets never download', () => {
    const ASCII_ONLY = /^[\x20-\x7E]*$/;
    for (const [lang, copy] of [
      ['vi', esignVi],
      ['en', esignEn],
    ] as const) {
      const monoTokens = [
        ...copy.fragments.templatesAndDrafting.tagsDetected,
        ...copy.fragments.ceremony.urls,
        copy.fragments.sealing.certCode,
        copy.fragments.sealing.sourceHash,
        copy.fragments.sealing.sealedHash,
        copy.fragments.integrations.webhookUrl,
        copy.fragments.integrations.webhookSecretPrefix,
        ...copy.fragments.integrations.mcpTools,
        copy.fragments.integrations.apiKeyPrefix,
        ...copy.fragments.integrations.apiScopes.flatMap((scope) =>
          scope.route ? [scope.code, scope.route] : [scope.code],
        ),
      ];
      for (const token of monoTokens) {
        expect(token, `${lang} mono token "${token}" must be pure ASCII`).toMatch(ASCII_ONLY);
      }
    }

    const visualsSource = readFileSync(join(WEB_SRC, 'components', 'apps', 'esign-visuals.tsx'), 'utf8');
    const monoExprs = [...visualsSource.matchAll(/font-mono[^>]*>\s*\{([^}]+)\}/g)].map((m) => m[1]!.trim());
    expect(monoExprs.sort()).toEqual(
      [
        'f.apiKeyPrefix',
        'f.certCode',
        'f.sealedHash',
        'f.sourceHash',
        'f.webhookSecretPrefix',
        'f.webhookUrl',
        'scope.code',
        'scope.route',
        'tag',
        'tool',
        'url',
      ].sort(),
    );
  });

  it('keeps home eSign module blurb and landing counter tablet sizing aligned with shipped Slices 2-5 (#4331, #4394)', async () => {
    const { en } = await import('../src/content/en');
    const { vi } = await import('../src/content/vi');
    expect(en.modules.sign.soon).not.toContain('reusable templates');
    expect(en.modules.sign.soon).not.toContain('direct signing links');
    expect(vi.modules.sign.soon).not.toContain('mẫu tài liệu dùng lại');
    expect(vi.modules.sign.soon).not.toContain('liên kết ký cố định');

    const numbersSource = readFileSync(join(WEB_SRC, 'components', 'landing', 'numbers.tsx'), 'utf8');
    expect(numbersSource).toContain('md:grid-cols-5');
    expect(numbersSource).toContain('md:text-base');
    expect(numbersSource).toContain('lg:text-2xl');
  });
});
