// SPDX-License-Identifier: AGPL-3.0-only
// The writer of Meta ads (ADR-0043 points 3 to 5, plan docs/plan/ads-write.md sections 5.1 and 9, issue #2296, W2), written from Meta's Marketing and
// Graph API docs. It works with the token of a write connection (`metawrite_ads`, ADR-0025: sealed apart from the read token, opened by the worker
// alone) and, for the revoke only, with the token of a read connection that holds a spend permission. Every call carries the token in the
// Authorization header with `appsecret_proof` (the shared Graph client does it), so a token copied out of Ludy is useless without the app secret
// when the Meta app has "Require App Secret" on; every request goes to graph.facebook.com over https and nowhere else (`graphHostOnly`).
//
// Which methods exist is pinned by a test (the class's own methods and every Graph endpoint its source names), and none deletes an ad object. This
// slice (W2-1) has the two that change nothing about campaigns: `verify` (two GETs) and `revokeToken` (the one call of the writer that is not about
// an ad object: it removes the app's permissions for the person at Meta). The calls that create and change campaigns join in W2-3, each added to
// the pinned list with the live check that confirmed it.
//
// What `DELETE /me/permissions` does [C: Graph API, user permissions]: with no permission named it unauthorizes the app for the person, which
// invalidates every token of that person for the app, in every org that uses the app. That is the point (a Meta permission belongs to the pair of
// the app and the person, so one call removes the permission from the write token and from any read token of the same grant), and the cost the ADR
// accepts. A token Meta no longer accepts (error 190, 102, or the subcodes that say the session ended) has nothing left to revoke: `already_invalid`.
import type { Fetch } from '@crove/channel';
import { Graph, META_DEFAULT_GRAPH_VERSION } from '@crove/channel';
import { AdPlatformError } from './index.ts';
import { ACT_ID, graphHostOnly, metaAdsError } from './meta.ts';
import { META_WRITE_PROVIDER, META_WRITE_SCOPES } from './meta-write-connector.ts';
import type { AdWriter, AdWriterRevocation, AdWriterVerification } from './writer.ts';

// How long one call may take before it is given up on and left to the caller's retry.
const CALL_TIMEOUT_MS = 20_000;

export interface MetaAdWriterOptions {
  // The secret of the Meta app the token belongs to: the write app for a write connection, the read ads app for a read token the revoke closes.
  appSecret: string;
  graphVersion?: string;
  fetch?: Fetch;
  now?: () => Date;
}

// The token inside the sealed secret of a connection (`{ accessToken }`, as the connector seals it).
function tokenOf(secret: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch {
    throw new AdPlatformError('unknown', 'BAD_SECRET');
  }
  const token = (parsed as { accessToken?: unknown } | null)?.accessToken;
  if (typeof token !== 'string' || token === '') throw new AdPlatformError('unknown', 'BAD_SECRET');
  return token;
}

export class MetaAdWriter implements AdWriter {
  readonly provider = META_WRITE_PROVIDER;
  private readonly graph: Graph;
  private readonly now: () => Date;

  constructor(options: MetaAdWriterOptions) {
    this.graph = new Graph(options.appSecret, options.graphVersion ?? META_DEFAULT_GRAPH_VERSION, graphHostOnly(options.fetch));
    this.now = options.now ?? (() => new Date());
  }

  // Whether the token holds the permissions that let it run ads and reaches the account: the permissions it holds now (a person can remove one in
  // Facebook's settings after granting it) and a read of the account itself. Changes nothing.
  async verify(secret: string, account: { externalAccountId: string }): Promise<AdWriterVerification> {
    const token = tokenOf(secret);
    if (!ACT_ID.test(account.externalAccountId)) throw new AdPlatformError('bad_request', 'BAD_ACCOUNT');
    try {
      const answer = await this.graph.call<{ data?: Array<{ permission?: unknown; status?: unknown }> }>('GET', 'me/permissions', { token, timeoutMs: CALL_TIMEOUT_MS });
      const scopes = (answer.data ?? []).filter((p) => p.status === 'granted' && typeof p.permission === 'string').map((p) => p.permission as string).sort();
      const canRunAds = META_WRITE_SCOPES.every((scope) => scopes.includes(scope));
      // The account the token reaches: a token that holds the permissions but not this account is refused here, not at the first create.
      if (canRunAds) await this.graph.call<{ id?: unknown }>('GET', account.externalAccountId, { token, params: { fields: 'id' }, timeoutMs: CALL_TIMEOUT_MS });
      return { canRunAds, scopes };
    } catch (error) {
      throw metaAdsError(error, this.now);
    }
  }

  // Removes the app's permissions for the person at Meta, so no token of the grant can change a campaign any more. Idempotent at Meta: a second
  // call with a token it no longer accepts answers 190, which is the outcome wanted.
  async revokeToken(secret: string): Promise<AdWriterRevocation> {
    const token = tokenOf(secret);
    try {
      const answer = await this.graph.call<{ success?: unknown }>('DELETE', 'me/permissions', { token, timeoutMs: CALL_TIMEOUT_MS });
      // A 200 that does not say success is not a revoke: it is tried again, never recorded as done.
      if (answer.success !== true) throw new AdPlatformError('unknown', 'NOT_REVOKED');
      return { how: 'revoked' };
    } catch (error) {
      const mapped = metaAdsError(error, this.now);
      if (mapped.kind === 'token_expired') return { how: 'already_invalid' };
      throw mapped;
    }
  }
}
