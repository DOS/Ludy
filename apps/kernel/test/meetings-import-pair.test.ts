// SPDX-License-Identifier: AGPL-3.0-only
// The two suggestions of one meeting (ADR-0055: the start of one entry is refused while the other is on its way or imported): the contract's rule for which keys form a pair, and its agreement with the Teams adapter that writes
// the transcript's key, so the start command's check (modules/meetings/src/import.ts) looks for the very key the adapter makes.
import { describe, expect, it } from 'vitest';
import { TEAMS_TRANSCRIPT_KEY_SUFFIX } from '@ludy/channel';
import { PLATFORM_TRANSCRIPT_KEY_SUFFIX, platformPairKeys } from '@ludy/kernel-contract';

describe('the pair of suggestions of one meeting', () => {
  it('uses one suffix in the Teams adapter and the contract', () => {
    expect(TEAMS_TRANSCRIPT_KEY_SUFFIX).toBe(PLATFORM_TRANSCRIPT_KEY_SUFFIX);
  });

  it('gives the same two keys from either suggestion of the pair, and a plain key its own pair', () => {
    const video = 'MSo1N2Y5ZGFjYy1BQUFB~1794880800~1794884400';
    const transcript = `${video}${PLATFORM_TRANSCRIPT_KEY_SUFFIX}`;
    expect(platformPairKeys(video)).toEqual([video, transcript]);
    expect(platformPairKeys(transcript)).toEqual([video, transcript]);
    // The suffix only counts at the end; one in the middle of a key is not a pair marker.
    expect(platformPairKeys(`a${PLATFORM_TRANSCRIPT_KEY_SUFFIX}b`)).toEqual([`a${PLATFORM_TRANSCRIPT_KEY_SUFFIX}b`, `a${PLATFORM_TRANSCRIPT_KEY_SUFFIX}b${PLATFORM_TRANSCRIPT_KEY_SUFFIX}`]);
  });
});
