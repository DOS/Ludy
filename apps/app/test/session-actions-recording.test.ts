// SPDX-License-Identifier: AGPL-3.0-only
// Signing out with a recording running (#3197): the recording is stopped and saved first, and only then does the sign-out go on, so the
// microphone never outlives the person and the upload still has its session.
import { describe, expect, it, vi } from 'vitest';

const order = vi.hoisted(() => [] as string[]);
vi.mock('../src/lib/api.ts', () => ({ client: {}, orglessClient: {}, orpc: { me: { get: { queryOptions: () => ({}) } } }, queryClient: { fetchQuery: vi.fn() } }));
vi.mock('../src/lib/auth.ts', () => ({ auth: () => ({ getSession: async () => ({ data: { session: null } }), signOut: async () => void order.push('signOut') }) }));
vi.mock('../src/lib/invite.ts', () => ({ forgetInvite: () => void order.push('forgetInvite') }));
vi.mock('../src/lib/push.ts', () => ({ forgetPushDevice: async () => void order.push('forgetPush') }));
vi.mock('../src/lib/social-share.ts', () => ({ forgetShare: () => void order.push('forgetShare') }));
vi.mock('../src/lib/sessions.ts', () => ({ sessionIdFromToken: () => null }));
vi.mock('../src/lib/recording-controller.ts', () => ({
  stopAndSave: async (options: { quiet?: boolean }) => {
    order.push(`save:${options.quiet === true}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    order.push('saved');
  },
}));

const { signOut } = await import('../src/lib/session-actions.ts');

describe('signOut with a recording', () => {
  it('saves the recording quietly before anything else is forgotten or signed out', async () => {
    await signOut();
    expect(order[0]).toBe('save:true');
    expect(order.indexOf('saved')).toBeLessThan(order.indexOf('forgetInvite'));
    expect(order.indexOf('saved')).toBeLessThan(order.indexOf('signOut'));
    expect(order).toContain('signOut');
  });
});
