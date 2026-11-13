// SPDX-License-Identifier: AGPL-3.0-only
// A stand-in for the crove-media measurer in tests that upload meeting media made of a few fake bytes (#2985): it drains the
// stream it is given, as the real client does, and answers a fixed length. The real client is tested against the real sandbox
// in meetings-measure.test.ts and the media package's own tests.
import type { MediaMeasurer } from '../src/meetings-measure.ts';

export function fakeMediaMeasurer(seconds = 1800): MediaMeasurer & { calls: number } {
  const measurer = {
    configured: true as const,
    calls: 0,
    async measure(_kind: 'audio' | 'video', source: AsyncIterable<Uint8Array>) {
      measurer.calls += 1;
      for await (const piece of source) void piece;
      return seconds;
    },
    async measureBytes() {
      measurer.calls += 1;
      return seconds;
    },
  };
  return measurer;
}
