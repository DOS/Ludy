// SPDX-License-Identifier: AGPL-3.0-only
// The picture rules of a platform show only for a channel the post has (#3657).
import { describe, expect, it } from 'vitest';
import { mediaRuleProviders } from '../src/lib/social.ts';

describe('mediaRuleProviders (#3657)', () => {
  it('names none when no channel is chosen, so only the general limit shows', () => {
    expect(mediaRuleProviders([])).toEqual([]);
  });

  it('names a platform only when the post has a channel on it, in a fixed order, once', () => {
    expect(mediaRuleProviders(['zalo_oa', 'instagram', 'instagram'])).toEqual(['instagram', 'zalo_oa']);
    expect(mediaRuleProviders(['facebook_page'])).toEqual(['facebook_page']);
  });

  it('ignores platforms with no rule worth naming', () => {
    expect(mediaRuleProviders(['telegram', 'bluesky'])).toEqual([]);
  });
});
