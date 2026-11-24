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
});
