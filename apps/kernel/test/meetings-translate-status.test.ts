// SPDX-License-Identifier: AGPL-3.0-only
// The price check behind the transcript translation's cost estimate (E2, #3185): a price per million tokens is a decimal string compared as a decimal, so a tiny price still counts as set,
// a zero or a malformed one does not, and the estimate's cost is a decimal string and never a JS number. A stand-in for the runtime answers the module's status.
import { describe, expect, it } from 'vitest';
import type { Runtime, UserActor } from '@crove/kernel-runtime';
import { transcriptTranslationStatusOf } from '../src/member-vy-ports.ts';

const ID = '0197a1c2-7b3e-7c11-9a55-3f2d8e6b4a10';
const status = {
  meetingId: ID,
  stage: 'published',
  enabled: true,
  reason: null,
  from: 'vi',
  to: 'en',
  lines: 10,
  translated: 0,
  stale: 0,
  remaining: 10,
  chunksTotal: 2,
  chunksDone: 0,
  state: 'none',
  runId: null,
  errorCode: null,
  estimate: null,
  bytes: 6000,
};
const runtime = { query: async () => ({ ...status }) } as unknown as Runtime;
const actor = { type: 'user', userId: ID, aal: 'aal1' } as unknown as UserActor;
const estimate = (price: { inputPerMTok: string; outputPerMTok: string } | undefined) => transcriptTranslationStatusOf({ runtime, hasModel: true, price }, ID, actor, ID).then((s) => s.estimate);

describe('the transcript translation estimate prices with decimals', () => {
  it('counts a very small price as set, so the cost is shown', async () => {
    const small = await estimate({ inputPerMTok: '0.0000001', outputPerMTok: '0' });
    expect(small?.cost).toMatch(/^\d+\.\d+$/);
    expect((await estimate({ inputPerMTok: '0', outputPerMTok: '0.0000001' }))?.cost).toMatch(/^\d+\.\d+$/);
    expect((await estimate({ inputPerMTok: '3', outputPerMTok: '15' }))?.cost).toMatch(/^\d+\.\d{6}$/);
  });

  it('shows no cost for no price, a zero price or a value that is not a decimal', async () => {
    expect((await estimate(undefined))?.cost).toBeNull();
    expect((await estimate({ inputPerMTok: '0', outputPerMTok: '0.000' }))?.cost).toBeNull();
    expect((await estimate({ inputPerMTok: 'abc', outputPerMTok: '' }))?.cost).toBeNull();
    expect((await estimate({ inputPerMTok: '-1', outputPerMTok: '0' }))?.cost).toBeNull();
  });

  it('still reports the calls and the tokens when no cost can be shown', async () => {
    const e = await estimate(undefined);
    expect(e?.calls).toBe(2);
    expect(e?.inputTokens).toBeGreaterThan(0);
    expect(e?.outputTokens).toBeGreaterThan(0);
  });
});
