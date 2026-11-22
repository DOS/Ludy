// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { buildCvExtractDraft, inferSuggestedSource } from '../src/recruiting-intake.ts';

describe('modules/hr recruiting-intake Stage 5D (#4446)', () => {
  it('validates exact allowed URL hostnames, hostname 253/254 bounds, and 200k-dot inputs without ReDoS (CWE-1333)', async () => {
    expect(inferSuggestedSource('Profile: https://zalo.me./contact')).toBe('zalo_oa');
    expect(inferSuggestedSource('Profile: https://m.fb.com/candidate')).toBe('facebook');
    expect(inferSuggestedSource('Profile: https://evil.example/?next=fb.com')).toBe('direct');

    const mkHost = (prefixLen: number, suffix: string) => {
      const labels: string[] = [];
      let rem = prefixLen;
      while (rem > 0) {
        const take = Math.min(60, rem);
        labels.push('a'.repeat(take));
        rem -= take;
        if (rem > 0) rem -= 1; // dot separator
      }
      return `${labels.join('.')}.${suffix}`;
    };
    const domain253 = mkHost(253 - 'zalo.me'.length - 1, 'zalo.me');
    const domain254 = `${mkHost(253 - 'zalo.me'.length - 1, 'zalo.me')}.`;
    const domainOver254 = `${mkHost(254 - 'zalo.me'.length - 1, 'zalo.me')}`;
    expect(domain253.length).toBe(253);
    expect(domain254.length).toBe(254);
    expect(domainOver254.length).toBe(254); // without trailing dot -> > 253 stripped
    expect(inferSuggestedSource(`https://${domain253}/u`)).toBe('zalo_oa');
    expect(inferSuggestedSource(`https://${domain254}/u`)).toBe('zalo_oa');
    expect(inferSuggestedSource(`https://${domainOver254}/u`)).toBe('direct');

    const hostileUrlText = `http://${'.'.repeat(199_000)}a/`;
    expect(inferSuggestedSource(hostileUrlText)).toBe('direct');

    const draft = await buildCvExtractDraft({
      text: hostileUrlText,
      sourceKind: 'pdf_text',
      openingId: null,
      openingTitle: null,
      requiredSkills: ['MISA AMIS', 'Excel'],
    });
    expect(draft.suggestedSource).toBe('direct');
    expect(draft.email).toBeNull();
  });
});
