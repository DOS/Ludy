// SPDX-License-Identifier: AGPL-3.0-only
// Mobile native push registration lifecycle and content-free deep-link routing (#4883, ADR-0059).
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createNativePushClient,
  disableNativePushForOrg,
  parseNativePushRoute,
  syncNativePushRegistration,
  unregisterNativePushOnSignOut,
  type NativePushRpc,
  type NativePushStatus,
} from '../src/push/index.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

const SAMPLE_ID = '01950000-0000-7000-8000-000000000001';
const PROPOSAL_ID = '01950000-0000-7000-8000-000000000002';
const CONVERSATION_ID = '01950000-0000-7000-8000-000000000003';

function rpcJson(payload: unknown): Response {
  return new Response(JSON.stringify({ json: payload }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createNativePushClient', () => {
  it('calls the kernel nativePush oRPC routes with bearer token and org header', async () => {
    const calls: Array<{ url: string; auth: string | null; org: string | null; body: unknown }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const bodyText = await request.text();
      calls.push({
        url: request.url,
        auth: request.headers.get('authorization'),
        org: request.headers.get('x-ludy-org'),
        body: bodyText ? JSON.parse(bodyText) : null,
      });
      if (request.url.endsWith('/notifications/nativePush/status')) {
        return rpcJson({
          enabled: true,
          registered: false,
          devices: [],
        } satisfies NativePushStatus);
      }
      if (request.url.endsWith('/notifications/nativePush/register')) {
        return rpcJson({ id: SAMPLE_ID });
      }
      if (request.url.endsWith('/notifications/nativePush/unregister')) {
        return rpcJson({ removed: 1 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = createNativePushClient('https://app.example.test', 'access-token-abc', 'acme-co');
    expect(await client.status()).toEqual({ enabled: true, registered: false, devices: [] });
    expect(await client.register({ platform: 'apns', token: 'apns-device-token-0123456789', label: 'iPhone 16' })).toEqual({
      id: SAMPLE_ID,
    });
    expect(await client.unregister({ current: true })).toEqual({ removed: 1 });

    expect(calls).toEqual([
      {
        url: 'https://app.example.test/api/rpc/notifications/nativePush/status',
        auth: 'Bearer access-token-abc',
        org: 'acme-co',
        body: { json: {} },
      },
      {
        url: 'https://app.example.test/api/rpc/notifications/nativePush/register',
        auth: 'Bearer access-token-abc',
        org: 'acme-co',
        body: { json: { platform: 'apns', token: 'apns-device-token-0123456789', label: 'iPhone 16' } },
      },
      {
        url: 'https://app.example.test/api/rpc/notifications/nativePush/unregister',
        auth: 'Bearer access-token-abc',
        org: 'acme-co',
        body: { json: { current: true } },
      },
    ]);
  });
});

describe('syncNativePushRegistration', () => {
  it('stops cleanly when self-hosted deployment disables native push without asking OS permissions', async () => {
    const client: NativePushRpc = {
      status: vi.fn(async () => ({ enabled: false, registered: false, devices: [] })),
      register: vi.fn(async () => ({ id: SAMPLE_ID })),
      unregister: vi.fn(async () => ({ removed: 0 })),
    };
    const requestDeviceToken = vi.fn(async () => 'should-not-be-called');

    const result = await syncNativePushRegistration({
      client,
      tokenPort: { platform: () => 'apns', requestDeviceToken },
    });

    expect(result).toEqual({ status: 'disabled', registered: false, devices: [] });
    expect(requestDeviceToken).not.toHaveBeenCalled();
    expect(client.register).not.toHaveBeenCalled();
  });

  it('returns unavailable when OS platform or permission token is missing', async () => {
    const client: NativePushRpc = {
      status: vi.fn(async () => ({ enabled: true, registered: false, devices: [] })),
      register: vi.fn(async () => ({ id: SAMPLE_ID })),
      unregister: vi.fn(async () => ({ removed: 0 })),
    };

    expect(
      await syncNativePushRegistration({
        client,
        tokenPort: { platform: () => null, requestDeviceToken: vi.fn(async () => 'unused-token-012345') },
      }),
    ).toEqual({ status: 'unavailable', registered: false, devices: [] });

    expect(
      await syncNativePushRegistration({
        client,
        tokenPort: { platform: () => 'fcm', requestDeviceToken: vi.fn(async () => '   ') },
      }),
    ).toEqual({ status: 'unavailable', registered: false, devices: [] });

    expect(client.register).not.toHaveBeenCalled();
  });

  it('trims device token and optional label before registering', async () => {
    const register = vi.fn(async () => ({ id: SAMPLE_ID }));
    const client: NativePushRpc = {
      status: vi.fn(async () => ({ enabled: true, registered: false, devices: [] })),
      register,
      unregister: vi.fn(async () => ({ removed: 0 })),
    };

    const res1 = await syncNativePushRegistration({
      client,
      tokenPort: { platform: () => 'fcm', requestDeviceToken: async () => '  fcm-token-0123456789abcdef  ' },
      label: '  Pixel 9  ',
    });
    expect(res1).toEqual({ status: 'registered', id: SAMPLE_ID });
    expect(register).toHaveBeenLastCalledWith({
      platform: 'fcm',
      token: 'fcm-token-0123456789abcdef',
      label: 'Pixel 9',
    });

    await syncNativePushRegistration({
      client,
      tokenPort: { platform: () => 'apns', requestDeviceToken: async () => 'apns-token-0123456789abcdef' },
      label: '   ',
    });
    expect(register).toHaveBeenLastCalledWith({
      platform: 'apns',
      token: 'apns-token-0123456789abcdef',
    });
  });
});

describe('disableNativePushForOrg & unregisterNativePushOnSignOut', () => {
  it('unregisters current session device by default or specific id when given', async () => {
    const unregister = vi.fn(async () => ({ removed: 1 }));
    const client: NativePushRpc = {
      status: vi.fn(async () => ({ enabled: true, registered: true, devices: [] })),
      register: vi.fn(async () => ({ id: SAMPLE_ID })),
      unregister,
    };

    expect(await disableNativePushForOrg({ client })).toEqual({ removed: 1 });
    expect(unregister).toHaveBeenLastCalledWith({ current: true });

    expect(await disableNativePushForOrg({ client, deviceId: SAMPLE_ID })).toEqual({ removed: 1 });
    expect(unregister).toHaveBeenLastCalledWith({ id: SAMPLE_ID });
  });

  it('deduplicates org slugs and tolerates per-org failure during sign-out cleanup', async () => {
    const seen: string[] = [];
    const removed = await unregisterNativePushOnSignOut({
      serverUrl: 'https://app.example.test',
      accessToken: 'token-1',
      orgSlugs: [' acme ', '', '  ', 'acme', 'broken-org', 'beta'],
      makeClient: (_serverUrl, _token, orgSlug) => {
        seen.push(orgSlug);
        return {
          status: async () => ({ enabled: true, registered: true, devices: [] }),
          register: async () => ({ id: SAMPLE_ID }),
          unregister: async () => {
            if (orgSlug === 'broken-org') throw new Error('network down');
            return { removed: 1 };
          },
        };
      },
    });

    expect(seen).toEqual(['acme', 'broken-org', 'beta']);
    expect(removed).toBe(2);
  });
});

describe('parseNativePushRoute', () => {
  it('parses structured kind, orgSlug, and subjectId payloads into deep-link targets', () => {
    expect(
      parseNativePushRoute({
        kind: 'kernel.approval_waiting',
        orgSlug: 'Cong-Ty-A',
        subjectId: PROPOSAL_ID.toUpperCase(),
      }),
    ).toEqual({ kind: 'approval', orgSlug: 'cong-ty-a', proposalId: PROPOSAL_ID });

    expect(
      parseNativePushRoute({
        kind: 'kernel.conversation_new',
        orgSlug: 'cong-ty-a',
        subjectId: CONVERSATION_ID,
      }),
    ).toEqual({ kind: 'conversation', orgSlug: 'cong-ty-a', conversationId: CONVERSATION_ID });

    expect(parseNativePushRoute({ kind: 'kernel.approval_waiting', orgSlug: 'cong-ty-a', subjectId: null })).toEqual({
      kind: 'inbox',
      orgSlug: 'cong-ty-a',
    });

    expect(parseNativePushRoute({ kind: 'kernel.conversation_new', orgSlug: 'cong-ty-a', subjectId: 'not-a-uuid' })).toEqual({
      kind: 'inbox',
      orgSlug: 'cong-ty-a',
    });
  });

  it('parses fallback relative deep-link paths cleanly', () => {
    expect(parseNativePushRoute({ path: `/o/acme/inbox/${PROPOSAL_ID}` })).toEqual({
      kind: 'approval',
      orgSlug: 'acme',
      proposalId: PROPOSAL_ID,
    });
    expect(parseNativePushRoute({ path: '/o/acme/inbox' })).toEqual({ kind: 'inbox', orgSlug: 'acme' });
    expect(parseNativePushRoute({ path: `/o/acme/social/inbox?c=${CONVERSATION_ID}` })).toEqual({
      kind: 'conversation',
      orgSlug: 'acme',
      conversationId: CONVERSATION_ID,
    });
    expect(parseNativePushRoute({ path: '/o/acme/social/inbox?status=new' })).toEqual({ kind: 'inbox', orgSlug: 'acme' });
  });

  it('rejects external URLs, path traversal, and malformed payloads', () => {
    expect(parseNativePushRoute(null)).toBeNull();
    expect(parseNativePushRoute([])).toBeNull();
    expect(parseNativePushRoute('hello')).toBeNull();
    expect(parseNativePushRoute({ kind: 'kernel.approval_waiting', orgSlug: '../etc', subjectId: PROPOSAL_ID })).toBeNull();
    expect(parseNativePushRoute({ path: 'https://evil.example/o/acme/inbox' })).toBeNull();
    expect(parseNativePushRoute({ path: '//evil.example/o/acme/inbox' })).toBeNull();
    expect(parseNativePushRoute({ path: '/o/acme/unknown/screen' })).toBeNull();
    expect(parseNativePushRoute({ path: '/o/acme/../other/inbox' })).toBeNull();
    expect(parseNativePushRoute({ path: '/o/acme/%2e%2e/other/inbox' })).toBeNull();
    expect(parseNativePushRoute({ path: '/o/acme/.\t./other/inbox' })).toBeNull();
    expect(parseNativePushRoute({ path: '/o/acme/..\r/other/inbox' })).toBeNull();
    expect(parseNativePushRoute({ path: '/o/acme\\other/inbox' })).toBeNull();
    expect(parseNativePushRoute({ path: `/o/acme/inbox/${PROPOSAL_ID}/extra` })).toBeNull();
    expect(parseNativePushRoute({ path: '/o/acme/inbox/not-a-uuid' })).toBeNull();
    expect(parseNativePushRoute({ path: '/o/acme/social/inbox/extra' })).toBeNull();
    expect(parseNativePushRoute({ path: '/admin/users' })).toBeNull();
  });
});
