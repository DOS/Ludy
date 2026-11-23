// SPDX-License-Identifier: AGPL-3.0-only
// What the owner's push-address command makes of the definer's refusals (#4348): a connection revoked or removed between the command's own check and the definer's is CHANNEL_NOT_ACTIVE, and nothing else is turned into it.
import { describe, expect, it } from 'vitest';
import { DomainError } from '@ludy/kernel-runtime';
import { hookSetFailure } from '../src/marketplace-connections.ts';

describe('hookSetFailure', () => {
  it('turns the definer\'s not-found refusal into CHANNEL_NOT_ACTIVE (409)', () => {
    const refusal = hookSetFailure(Object.assign(new Error('MARKETPLACE_HOOK_NOT_FOUND'), { code: '22023' }));
    expect(refusal).toBeInstanceOf(DomainError);
    expect(refusal).toMatchObject({ code: 'CHANNEL_NOT_ACTIVE', status: 409 });
  });
  it('leaves every other failure alone: another refusal of the definer, another error code, a plain error and a non-error', () => {
    expect(hookSetFailure(Object.assign(new Error('MARKETPLACE_HOOK_INVALID'), { code: '22023' }))).toBeNull();
    expect(hookSetFailure(Object.assign(new Error('MARKETPLACE_HOOK_FORBIDDEN'), { code: '42501' }))).toBeNull();
    expect(hookSetFailure(Object.assign(new Error('MARKETPLACE_HOOK_NOT_FOUND'), { code: '40001' }))).toBeNull();
    expect(hookSetFailure(new Error('boom'))).toBeNull();
    expect(hookSetFailure(null)).toBeNull();
    expect(hookSetFailure('MARKETPLACE_HOOK_NOT_FOUND')).toBeNull();
  });
});
