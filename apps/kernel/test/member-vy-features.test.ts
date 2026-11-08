// SPDX-License-Identifier: AGPL-3.0-only
// The member-Vy feature table lives twice, as pure data in packages/agent (what a feature module reads) and in the kernel (what its
// commands check); they must not differ (ADR-0049, issue #2782).
import { describe, expect, it } from 'vitest';
import { MEMBER_VY_FEATURES } from '@crove/kernel';
import { MEMBER_VY_FEATURE_TABLE } from '../../../packages/agent/src/member-vy/features.ts';

describe('member-Vy features', () => {
  it('are the same table in the agent package and in the kernel', () => {
    expect(MEMBER_VY_FEATURES).toEqual(MEMBER_VY_FEATURE_TABLE);
  });
});
