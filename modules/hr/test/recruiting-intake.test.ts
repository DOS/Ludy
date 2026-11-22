// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { buildCvExtractDraft, inferSuggestedSource } from '../src/recruiting-intake.ts';

describe('modules/hr recruiting-intake Stage 5D (#4446)', () => {
  it('validates exact allowed URL hostnames without trailing-dot ReDoS (CWE-1333)', async () => {
    expect(inferSuggestedSource('Profile: https://zalo.me./contact')).toBe('zalo_oa');
    expect(inferSuggestedSource('Profile: https://m.fb.com/candidate')).toBe('facebook');
    expect(inferSuggestedSource('Profile: https://evil.example/?next=fb.com')).toBe('direct');

    const hostileUrlText = `http://${'.'.repeat(199_000)}a/`;
    const t0 = performance.now();
    const source = inferSuggestedSource(hostileUrlText);
    const sourceMs = performance.now() - t0;
    expect(source).toBe('direct');
    expect(sourceMs).toBeLessThan(50);

    const t1 = performance.now();
    const draft = await buildCvExtractDraft({
      text: hostileUrlText,
      sourceKind: 'pdf_text',
      openingId: null,
      openingTitle: null,
      requiredSkills: ['MISA AMIS', 'Excel'],
    });
    const draftMs = performance.now() - t1;
    expect(draft.suggestedSource).toBe('direct');
    expect(draft.email).toBeNull();
    expect(draftMs).toBeLessThan(50);
  });
});
