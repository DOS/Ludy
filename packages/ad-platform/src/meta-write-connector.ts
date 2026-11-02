// SPDX-License-Identifier: AGPL-3.0-only
// Meta ads, the connection that can run ads (ADR-0043 points 3 and 4, plan docs/plan/ads-write.md section 5.1, issue #2294, W0b).
// An ad account gets a second connection beside the read one (ADR-0040): its own provider id (`metawrite_ads`), its own login
// with `ads_read` and `ads_management`, and its own sealed token. With a separate Meta app the token the reports are read with never
// holds the right to spend; with the one shared app of today it can (see below), and that is why switching writing off closes more
// than this connection. This file only logs in and lists the ad accounts the person granted:
// nothing here calls a Graph endpoint that creates or changes anything (a test pins that its source names no write and that every
// call it makes is a GET). The writer that changes campaigns is a later slice (W2), and it is not an ad platform of the readers'
// registry: neither `AD_PLATFORM_PROVIDERS` nor `adPlatforms()` knows this provider.
//
// It lives apart from meta.ts so that file can keep its promise (its source names no write). The helpers it shares with the
// reader are exported from there; the same keyed hash of the Meta user (`platformUserHash`, one label) is kept on both
// connections, so with one app serving both, the platform's data deletion callback finds the accounts of the person on the read
// connection and on this one alike.
//
// The read ads app serves writing too for now (the owner's own account: one classic app holds the products together; the config
// refuses a different write app until it has a data deletion callback of its own). A Meta permission belongs to the pair of the
// app and the person, and a user token carries every permission the person ever granted that app: once the owner grants
// `ads_management` here, the read tokens of the same person for that app can change campaigns as well, though the scopes recorded
// for them still say `ads_read`. So nothing that depends on "the report token cannot spend" holds with a shared app, and the
// switch-off must close the read connections of that person too (W0b-2), and W2's revoke must remove the permission for the pair
// (the permission-revoke call of the Graph API for the pair), not only drop one token. This connection records the whole granted set as its scopes
// and refuses none of them (`ads_management` and `business_management` are what it is for).
import type { AuthorizeInput, ConnectedAccount, ExchangeInput, Fetch, MetaAppConfig, OAuthConnector } from '@crove/channel';
import { MetaLogin, asProviderError } from '@crove/channel';
import { ACT_ID, META_USER_ID, accountName, graphHostOnly, listAdAccounts, platformUserHash } from './meta.ts';

export const META_WRITE_PROVIDER = 'metawrite_ads' as const;
// What the login asks for and requires: reading reports, and changing campaigns. A grant without either is refused.
export const META_WRITE_SCOPES = ['ads_read', 'ads_management'] as const;

// What each ad account's connection seals: the same shape as the read one's, under its own envelope.
interface MetaWriteSecret {
  accessToken: string;
}

// Facebook Login for the permissions that let a token run ads, and the ad accounts the user granted: the OAuth connector of the
// channel layer for the write connection of a Meta ad account. The user token never leaves here; each account's connection seals
// the same long-lived token.
export class MetaWriteConnector implements OAuthConnector {
  readonly provider = META_WRITE_PROVIDER;
  readonly pkce = false;
  private readonly login: MetaLogin;
  private readonly appSecret: string;
  private readonly now: () => Date;

  constructor(app: MetaAppConfig, options: { fetch?: Fetch; now?: () => Date } = {}) {
    this.appSecret = app.appSecret;
    this.login = new MetaLogin(app, META_WRITE_SCOPES, graphHostOnly(options.fetch));
    this.now = options.now ?? (() => new Date());
  }

  authorizeUrl(input: AuthorizeInput): string {
    return this.login.authorizeUrl(input);
  }

  async exchange(input: ExchangeInput): Promise<ConnectedAccount[]> {
    // Both scopes are required by the login: a grant that lacks one (the person declined it in Meta's dialog) ends in a `denied`
    // error with the code MISSING_PERMISSION, the same answer the reader gives for a missing ads_read. `granted` is every
    // permission the token holds, the ones granted to this app earlier included: it is recorded whole, and none is refused.
    const { token, granted } = await this.login.userToken(input);
    let rows: Awaited<ReturnType<typeof listAdAccounts>>;
    let grantedByHash: string | undefined;
    try {
      // Who granted it, as a keyed hash only (the id is kept nowhere), by the function and the label of the read connection.
      // A failed call is only that: the connection is made without a hash, and the link says so (it drops an earlier one).
      const me = await this.login.graph.call<{ id?: unknown }>('GET', 'me', { token, params: { fields: 'id' } }).catch(() => ({}) as { id?: unknown });
      if (typeof me.id === 'string' && META_USER_ID.test(me.id)) grantedByHash = platformUserHash(this.appSecret, me.id);
      rows = await listAdAccounts(this.login.graph, token);
    } catch (error) {
      throw asProviderError(error);
    }
    // A long-lived user token lasts about 60 days and cannot be refreshed: the connection expires on that date and the owner
    // connects again; the writer also learns it from Meta's answer (code 190).
    const expiresAt = new Date(this.now().getTime() + 60 * 86_400_000);
    const accounts: ConnectedAccount[] = [];
    for (const row of rows) {
      if (typeof row.id !== 'string' || !ACT_ID.test(row.id)) continue;
      accounts.push({
        provider: META_WRITE_PROVIDER,
        externalAccountId: row.id,
        displayName: accountName(row.name, row.id),
        scopes: [...granted],
        expiresAt,
        secret: JSON.stringify({ accessToken: token } satisfies MetaWriteSecret),
        ...(grantedByHash ? { grantedByHash } : {}),
      });
    }
    // A login that reaches no ad account is not a missing permission: the caller says so in words of its own.
    return accounts;
  }
}
