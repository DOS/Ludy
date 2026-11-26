// SPDX-License-Identifier: AGPL-3.0-only
// Mobile native push device registration lifecycle (#4883, ADR-0059):
//   - Registers the device's APNs/FCM token through @ludy/client scoped to the active org and signed-in session.
//   - Respects self-hosted deployments where notifications.nativePush.status returns { enabled: false }.
//   - Never caches or logs raw APNs/FCM tokens; unregisters the current session cleanly on sign-out or disable.
import { createLudyClient, requestHeaders } from '@ludy/client';

export type NativePushPlatform = 'apns' | 'fcm';

export interface NativePushDeviceSummary {
  id: string;
  platform: NativePushPlatform;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  current: boolean;
}

export interface NativePushStatus {
  enabled: boolean;
  registered: boolean;
  devices: NativePushDeviceSummary[];
}

export interface NativePushRpc {
  status(): Promise<NativePushStatus>;
  register(input: { platform: NativePushPlatform; token: string; label?: string }): Promise<{ id: string }>;
  unregister(
    input: { id: string } | { platform: NativePushPlatform; token: string } | { current: true },
  ): Promise<{ removed: number }>;
}

export interface NativePushTokenPort {
  platform(): NativePushPlatform | null;
  requestDeviceToken(): Promise<string | null>;
}

export type SyncNativePushResult =
  | { status: 'disabled'; registered: false; devices: NativePushDeviceSummary[] }
  | { status: 'unavailable'; registered: boolean; devices: NativePushDeviceSummary[] }
  | { status: 'registered'; id: string };

export function createNativePushClient(serverUrl: string, accessToken: string, orgSlug: string): NativePushRpc {
  const client = createLudyClient({
    origin: serverUrl,
    headers: () => requestHeaders(accessToken, orgSlug),
  });
  return {
    status: () => client.notifications.nativePush.status({}),
    register: (input) => client.notifications.nativePush.register(input),
    unregister: (input) => client.notifications.nativePush.unregister(input),
  };
}

export async function syncNativePushRegistration(options: {
  client: NativePushRpc;
  tokenPort: NativePushTokenPort;
  label?: string;
}): Promise<SyncNativePushResult> {
  const current = await options.client.status();
  if (!current.enabled) {
    return { status: 'disabled', registered: false, devices: current.devices };
  }

  const platform = options.tokenPort.platform();
  if (!platform) {
    return { status: 'unavailable', registered: current.registered, devices: current.devices };
  }

  const rawToken = await options.tokenPort.requestDeviceToken();
  const token = typeof rawToken === 'string' ? rawToken.trim() : '';
  if (!token) {
    return { status: 'unavailable', registered: current.registered, devices: current.devices };
  }

  const label = options.label?.trim();
  const { id } = await options.client.register({
    platform,
    token,
    ...(label ? { label } : {}),
  });
  return { status: 'registered', id };
}

export async function disableNativePushForOrg(options: {
  client: NativePushRpc;
  deviceId?: string;
}): Promise<{ removed: number }> {
  if (options.deviceId) {
    return options.client.unregister({ id: options.deviceId });
  }
  return options.client.unregister({ current: true });
}

export async function unregisterNativePushOnSignOut(options: {
  serverUrl: string;
  accessToken: string;
  orgSlugs: readonly string[];
  makeClient?: (serverUrl: string, accessToken: string, orgSlug: string) => NativePushRpc;
}): Promise<number> {
  const factory = options.makeClient ?? createNativePushClient;
  const uniqueSlugs = [...new Set(options.orgSlugs.map((s) => s.trim()).filter(Boolean))];
  let removed = 0;
  for (const slug of uniqueSlugs) {
    try {
      const result = await factory(options.serverUrl, options.accessToken, slug).unregister({ current: true });
      removed += result.removed;
    } catch {
      // Best-effort cleanup per org: server session revocation triggers remove remaining registrations atomically.
    }
  }
  return removed;
}
