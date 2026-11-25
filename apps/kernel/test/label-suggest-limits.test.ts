// SPDX-License-Identifier: AGPL-3.0-only
// The label suggestion's two sides agree on the limits (#5010): the agent package does not import the contract, so the count it clamps `dropped` at is its own constant, and this test ties it to the contract's ceiling so
// an answer the checks accept can never fail the route's output schema.
import { LABEL_SUGGEST_LIMITS } from '@ludy/agent/member-vy';
import { LABEL_SUGGEST_DROPPED_MAX, LABEL_SUGGEST_MAX, MEETING_LABELS_IN_USE_MAX } from '@ludy/kernel-contract';
import { describe, expect, it } from 'vitest';

describe('label suggestion limits (#5010)', () => {
  it('has the agent clamp the dropped count at the ceiling of the answer shape and show as many suggestions as the shape allows', () => {
    expect(LABEL_SUGGEST_LIMITS.droppedReported).toBe(LABEL_SUGGEST_DROPPED_MAX);
    expect(LABEL_SUGGEST_LIMITS.suggestions).toBe(LABEL_SUGGEST_MAX);
    expect(LABEL_SUGGEST_LIMITS.inUse).toBeLessThanOrEqual(MEETING_LABELS_IN_USE_MAX);
  });
});
