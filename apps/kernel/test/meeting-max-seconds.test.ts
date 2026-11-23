// SPDX-License-Identifier: AGPL-3.0-only
// The in-app recorder stops at MAX_MEETING_SECONDS (#3197); the server refuses a recording longer than the media sandbox's
// limit. The two must be the same number, or a recording that ran to its limit would be refused at upload.
import { MAX_MEETING_SECONDS } from '@ludy/kernel-contract';
import { MEDIA_LIMITS } from '@ludy/media-contract';
import { expect, it } from 'vitest';

it('the recorder stops at the length the media sandbox accepts', () => {
  expect(MAX_MEETING_SECONDS).toBe(MEDIA_LIMITS.maxDurationSeconds);
});
