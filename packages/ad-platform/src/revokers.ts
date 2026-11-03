// SPDX-License-Identifier: AGPL-3.0-only
// What the revoke worker is given of an ad platform's writer (ADR-0043 point 4, issue #2296, W2-1): one call, the one that removes the app's permissions
// for the person at the platform, and nothing else. The worker opens the sealed copy of a closed connection's token for that alone (ADR-0025's amendment of
// 2026-11-03), so what it holds must not be able to do anything a token can: `verify`, creating or changing an object are not reachable through it, not
// even by a cast, because the view is a new object that has the one method and calls the writer's through a closure. A test pins both the view and the
// source of this file (it names `revokeToken` on a writer and no other member).
import { MetaAdWriter } from './meta-write.ts';
import { sandboxAdWriter } from './sandbox-write.ts';
import type { AdWriter, AdWriterRevocation } from './writer.ts';

export interface AdRevoker {
  // Removes at the platform the permissions the token's person gave the app, so no token of that grant can change a campaign any more. An
  // `AdPlatformError` on failure (`rate_limited` carries the time to wait; `transient` is worth another try).
  revokeToken(secret: string): Promise<AdWriterRevocation>;
}

export function revokerOf(writer: Pick<AdWriter, 'revokeToken'>): AdRevoker {
  return { revokeToken: (secret: string) => writer.revokeToken(secret) };
}

export interface AdRevokerOptions {
  // The offline sandbox's write connection (its token is its own; the call touches no network).
  sandbox: boolean;
  meta?: {
    // The secret of the Meta app that issued a write token (CHANNEL_META_ADS_WRITE_APP_SECRET) and of the one that issued a read token that holds a
    // spend permission (CHANNEL_META_ADS_APP_SECRET): each token is proved with the secret of its own app, so each provider has its own revoker.
    writeAppSecret?: string;
    readAppSecret?: string;
    graphVersion?: string;
  };
}

// The revokers of a deployment, by the provider id of the connection the token belonged to. A provider without one has no entry: a token of it that
// is held is tried and failed, ten times at most, and then the person is told to remove the app at the platform.
export function adRevokers(options: AdRevokerOptions): Readonly<Record<string, AdRevoker>> {
  const revokers: Record<string, AdRevoker> = {};
  if (options.sandbox) revokers[sandboxAdWriter.provider] = revokerOf(sandboxAdWriter);
  const graphVersion = options.meta?.graphVersion;
  const meta = (appSecret: string) => revokerOf(new MetaAdWriter({ appSecret, ...(graphVersion ? { graphVersion } : {}) }));
  if (options.meta?.writeAppSecret) revokers.metawrite_ads = meta(options.meta.writeAppSecret);
  if (options.meta?.readAppSecret) revokers.meta_ads = meta(options.meta.readAppSecret);
  return revokers;
}
