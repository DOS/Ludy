// SPDX-License-Identifier: AGPL-3.0-only
// Regression coverage for the Ludy eSign public landing page (/esign and /en/esign, #4605, #5109):
// verifies Slices 1 through 6d coverage, bilingual group/visual parity, and DESIGN.md visual/copy rules.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { esignEn } from '../src/content/esign-en';
import { esignVi } from '../src/content/esign-vi';

const WEB_SRC = join(import.meta.dirname, '..', 'src');

describe('Ludy eSign landing page (#4605, #5109)', () => {
  it('covers Slices 1 through 6d capabilities in both Vietnamese and English', () => {
    const viText = JSON.stringify(esignVi);
    const enText = JSON.stringify(esignEn);

    expect(esignVi.groups.items).toHaveLength(6);
    expect(esignEn.groups.items).toHaveLength(6);

    for (const token of [
      '/-/sign#<token>',
      '/-/sign?in_person=1#<token>',
      '/-/sign/d#<token>',
      '/-/sign/p/<orgSlug>',
      '{{signature, r1}}',
      '.docx',
      'Be Vietnam Pro',
      'Track Changes',
      'LibreOffice',
      '.docx -> PDF A4',
      '1-5 PDF',
      '25 MiB',
      '200 trang',
      'sign.packet_consistency',
      'Zalo OA',
      'quét mã QR',
      'VietQR',
      'CK-',
      'zero escrow',
      '10 tính năng',
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
      '/-/sign?in_person=1#<token>',
      '/-/sign/d#<token>',
      '/-/sign/p/<orgSlug>',
      '{{signature, r1}}',
      '.docx',
      'Be Vietnam Pro',
      'Track Changes',
      'LibreOffice',
      '.docx -> PDF A4',
      '1-5 PDFs',
      '25 MiB',
      '200 pages',
      'sign.packet_consistency',
      'Zalo OA',
      'QR scan-to-sign',
      'VietQR',
      'CK-',
      'zero escrow',
      '10 metered',
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
        copy.fragments.templatesAndDrafting.docxCode,
        copy.fragments.templatesAndDrafting.packetCheckCode,
        ...copy.fragments.templatesAndDrafting.tagsDetected,
        ...copy.fragments.handoffs.cards.flatMap((card) => (card.code ? [card.code] : [])),
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
        'card.code',
        'f.apiKeyPrefix',
        'f.certCode',
        'f.docxCode',
        'f.packetCheckCode',
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

  it('keeps home eSign card and module blurb aligned with shipped Slices 2-6 (#4331, #4394, #5109)', async () => {
    const { en } = await import('../src/content/en');
    const { vi } = await import('../src/content/vi');
    expect(en.modules.sign.soon).not.toContain('reusable templates');
    expect(en.modules.sign.soon).not.toContain('direct signing links');
    expect(vi.modules.sign.soon).not.toContain('mẫu tài liệu dùng lại');
    expect(vi.modules.sign.soon).not.toContain('liên kết ký cố định');

    const enSignCard = en.appCards.items.find((item) => item.key === 'sign');
    const viSignCard = vi.appCards.items.find((item) => item.key === 'sign');
    expect(enSignCard?.body).toContain('.docx');
    expect(enSignCard?.body).toContain('1-5 PDF');
    expect(enSignCard?.body).toContain('Zalo OA');
    expect(enSignCard?.body).toContain('QR scan-to-sign');
    expect(enSignCard?.body).toContain('VietQR');
    expect(viSignCard?.body).toContain('.docx');
    expect(viSignCard?.body).toContain('1-5');
    expect(viSignCard?.body).toContain('Zalo OA');
    expect(viSignCard?.body).toContain('quét mã QR');
    expect(viSignCard?.body).toContain('VietQR');

    expect(en.modules.sign.body).toContain('.docx');
    expect(en.modules.sign.body).toContain('VietQR');
    expect(en.modules.sign.body).toContain('QR scan-to-sign');
    expect(vi.modules.sign.body).toContain('Zalo OA');
    expect(vi.modules.sign.body).toContain('quét mã QR');
    expect(vi.modules.sign.body).toContain('1-5');

    const numbersSource = readFileSync(join(WEB_SRC, 'components', 'landing', 'numbers.tsx'), 'utf8');
    expect(numbersSource).toContain('md:grid-cols-5');
    expect(numbersSource).toContain('md:text-base');
    expect(numbersSource).toContain('lg:text-2xl');
  });
});
