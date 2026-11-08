// SPDX-License-Identifier: AGPL-3.0-only
// What the revoke worker is given of an ad platform's writer (ADR-0043 point 4, issue #2296, W2-1): one call, the one that removes the app's permissions
// for the person at the platform, and nothing else. The worker opens the sealed copy of a closed connection's token for that alone (ADR-0025's amendment of
// 2026-11-03), so what it holds must not be able to do anything a token can: `verify`, creating or changing an object are not reachable through it, not
// even by a cast, because the view is a new, frozen object that has the one method and calls the writer's through a closure. A test pins both the view and
// the source of this file (it names `revokeToken` on a writer and no other member).
import { MetaAdWriter } from './meta-write.ts';
import { pauserOf, type AdPauser } from './pausers.ts';
import { sandboxAdWriter } from './sandbox-write.ts';
import type { AdWriter, AdWriterRevocation } from './writer.ts';

// The revoke worker's view: the revoke, and the pause that must come before it on a switch-off (W2-4a). A switch-off closes the write connection in its own
// transaction and drops its live token, so the only token left to pause what a launch made is the sealed copy the revoke worker opens; it pauses with it first,
// then revokes (ADR-0043 point 4), with the same narrowed pause the pause job has (pausers.ts) and nothing more: it still cannot create, activate or verify.
export interface AdRevoker extends AdPauser {
  // Removes at the platform the permissions the token's person gave the app, so no token of that grant can change a campaign any more. An
  // `AdPlatformError` on failure (`rate_limited` carries the time to wait; `transient` is worth another try; `token_expired` means the token cannot revoke
  // anything and the grant may still stand).
  revokeToken(secret: string): Promise<AdWriterRevocation>;
}

export function revokerOf(writer: Pick<AdWriter, 'revokeToken' | 'findByTag' | 'setStatus'>): AdRevoker {
  const pauser = pauserOf(writer);
  return Object.freeze({ revokeToken: (secret: string) => writer.revokeToken(secret), pauseLaunch: pauser.pauseLaunch });
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
// is held is tried and failed, ten times at most, and then the person is told to remove the app at the platform. The map is frozen too.
export function adRevokers(options: AdRevokerOptions): Readonly<Record<string, AdRevoker>> {
  const revokers: Record<string, AdRevoker> = {};
  if (options.sandbox) revokers[sandboxAdWriter.provider] = revokerOf(sandboxAdWriter);
  const graphVersion = options.meta?.graphVersion;
  const meta = (appSecret: string) => revokerOf(new MetaAdWriter({ appSecret, ...(graphVersion ? { graphVersion } : {}) }));
  if (options.meta?.writeAppSecret) revokers.metawrite_ads = meta(options.meta.writeAppSecret);
  if (options.meta?.readAppSecret) revokers.meta_ads = meta(options.meta.readAppSecret);
  return Object.freeze(revokers);
}
