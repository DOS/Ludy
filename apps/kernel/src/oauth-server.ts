// SPDX-License-Identifier: AGPL-3.0-only
// The embedded OAuth 2.1 authorization server of the MCP endpoint (ADR-0032 decisions 1 to 9, ADR-0051 decision 2, issue #2975).
//
// `oidc-provider` is the protocol engine (PKCE with S256 only, RFC 8707 resource indicators, RFC 9207 `iss`, dynamic client registration,
// OAuth Client ID Metadata Documents, revocation, refresh token rotation with reuse detection). It stores no user: the account id of every
// grant is the `user_account` id of a person who signed in with Supabase Auth, resolved by the consent route below. Nothing here is a
// session of the SPA: the provider's own cookies authorize only an interaction, never /api.
//
// What this file fixes, so a deployment cannot weaken it:
//   - one resource, `PUBLIC_URL/mcp`, one scope, `ludy.read`; any other resource is `invalid_target`, any other scope `invalid_scope`;
//   - public clients only (no client secret, `token_endpoint_auth_method: none`), authorization code with PKCE, refresh token;
//   - access tokens are JWTs (RFC 9068), ES256, 10 minutes, audience exactly the resource, with the grant and org of the live agent_grant
//     as claims; the token is refused at the endpoint the moment the grant is no longer in good standing (crove_kernel.mcp_grant_verify);
//   - a code lives 60 seconds, a refresh token 30 days and rotates (a reused one destroys the grant's tokens), the authorization server's own
//     session 15 minutes, an interaction 10 minutes;
//   - the consent page is the SPA's, on this origin (OAUTH_SERVER=on refuses another APP_URL).
import { sql } from 'kysely';
import { createLocalJWKSet, exportJWK, importJWK, jwtVerify, type JSONWebKeySet, type JWK } from 'jose';
import Provider, { errors, type Configuration } from 'oidc-provider';
import type { Db } from '@crove/db';
import { MCP_SCOPE_IDS } from '@crove/kernel-contract';
import type { Config } from './config.ts';
import { oauthAdapterFor } from './oauth-adapter.ts';

export const MCP_SCOPE = MCP_SCOPE_IDS[0];
export const ACCESS_TOKEN_SECONDS = 600;
const CODE_SECONDS = 60;
const REFRESH_SECONDS = 30 * 24 * 3600;
const SESSION_SECONDS = 900;
const INTERACTION_SECONDS = 600;
const GRANT_SECONDS = 90 * 24 * 3600;

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

type RunDb = <O>(fn: (db: Db) => Promise<O>) => Promise<O>;

// The claims the access token carries beyond the standard ones: the live grant it belongs to and its org.
export const GRANT_CLAIM = 'ludy_grant';
export const ORG_CLAIM = 'ludy_org';

export interface AccessTokenClaims {
  grantId: string;
  orgId: string;
  clientId: string;
  userId: string;
  scopes: string[];
}

export interface OauthServer {
  readonly provider: Provider;
  // The issuer and the one resource, as the metadata names them.
  readonly issuer: string;
  readonly resource: string;
  // Verifies an access token (signature, issuer, audience, expiry and the claims), or null for every refusal alike. It does not look at the
  // grant: the endpoint does, in the database, right after.
  verifyAccessToken(token: string): Promise<AccessTokenClaims | null>;
}

const trimSlash = (url: string): string => url.replace(/\/+$/, '');

export function mcpResourceOf(config: Pick<Config, 'PUBLIC_URL'>): string {
  return `${trimSlash(config.PUBLIC_URL)}/mcp`;
}

// The public half of the signing keys: what the provider publishes and what the endpoint verifies with.
async function publicKeySet(privateSet: JSONWebKeySet): Promise<JSONWebKeySet> {
  const keys = await Promise.all(
    privateSet.keys.map(async (key) => {
      const imported = await importJWK(key, 'ES256', { extractable: true });
      if (imported instanceof Uint8Array) throw new Error('OAUTH_JWKS holds a symmetric key');
      // The private part (`d`) never leaves: only the public coordinates, the id and the algorithm are published.
      const exported = await exportJWK(imported);
      const publicKey: JWK = { kty: exported.kty ?? 'EC', crv: exported.crv ?? 'P-256', x: exported.x ?? '', y: exported.y ?? '', ...(key.kid ? { kid: key.kid } : {}), alg: 'ES256', use: 'sig' };
      return publicKey;
    }),
  );
  return { keys };
}

export async function createOauthServer(config: Config, run: RunDb): Promise<OauthServer> {
  const issuer = trimSlash(config.PUBLIC_URL);
  const resource = mcpResourceOf(config);
  const privateSet = JSON.parse(config.OAUTH_JWKS ?? '{"keys":[]}') as JSONWebKeySet;
  const publicSet = await publicKeySet(privateSet);
  const verifyKeys = createLocalJWKSet(publicSet);
  const allowedOrigins = (config.MCP_ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim()).filter((o) => o.length > 0);
  const cookieKeys = (config.OAUTH_COOKIE_KEYS ?? '').split(',').map((k) => k.trim()).filter((k) => k.length > 0);

  const configuration: Configuration = {
    adapter: oauthAdapterFor(run),
    jwks: privateSet as unknown as Configuration['jwks'],
    cookies: { keys: cookieKeys },
    // Dynamic registration and metadata documents only: no client is configured here.
    clients: [],
    // `ludy.read` is the one resource server's scope (getResourceServerInfo) and is listed here too, because the provider accepts a scope in a client's
    // registration or request only from this list, and the official MCP client registers with the scope the resource metadata advertises. The consent grants it
    // as a resource scope and also as a scope of the provider (see mcp-endpoint.ts), so an authorization that names it does not loop back to the consent page.
    scopes: ['openid', 'ludy.read'],
    claims: {},
    // Public clients only: a client holds no secret, so nothing to steal from its registration.
    clientAuthMethods: ['none'],
    clientDefaults: { grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', id_token_signed_response_alg: 'ES256' },
    pkce: { required: () => true },
    // The registration policy of this deployment, run for every client at registration (the provider's own rules for web and native clients stay): no wildcard in
    // a redirect URI, no user information, plain http only on a loopback address of a native client. The property it hangs on is one no client sets.
    extraClientMetadata: {
      properties: ['ludy_policy'],
      validator: (_ctx, key, value, metadata) => {
        if (value !== undefined) throw new errors.InvalidClientMetadata(`${key} is not a client property`);
        // No URL the server would fetch on a stranger's behalf (the provider reads sector_identifier_uri and jwks_uri itself, with no size bound for the first),
        // no front-channel or back-channel hook, and a registration that stays small: an anonymous client holds a row for a day.
        for (const field of ['sector_identifier_uri', 'jwks_uri', 'jwks', 'request_uris', 'initiate_login_uri', 'backchannel_logout_uri', 'frontchannel_logout_uri', 'post_logout_redirect_uris', 'tls_client_auth_subject_dn']) {
          if ((metadata as Record<string, unknown>)[field] !== undefined) throw new errors.InvalidClientMetadata(`${field} is not accepted`);
        }
        if (JSON.stringify(metadata).length > 4096) throw new errors.InvalidClientMetadata('client metadata is too large');
        if (typeof metadata.client_name === 'string' && metadata.client_name.length > 120) throw new errors.InvalidClientMetadata('client_name is at most 120 characters');
        if (Array.isArray(metadata.redirect_uris) && metadata.redirect_uris.length > 5) throw new errors.InvalidClientMetadata('at most 5 redirect_uris');
        const uris = Array.isArray(metadata.redirect_uris) ? (metadata.redirect_uris as unknown[]) : [];
        for (const uri of uris) {
          const parsed = typeof uri === 'string' ? URL.parse(uri) : null;
          if (!parsed || (uri as string).includes('*') || parsed.username !== '' || parsed.password !== '') throw new errors.InvalidRedirectUri('redirect_uris must be exact addresses, with no wildcard or user information');
          if (parsed.protocol === 'http:' && !(metadata.application_type === 'native' && LOOPBACK_HOSTS.has(parsed.hostname))) {
            throw new errors.InvalidRedirectUri('redirect_uris must use https, or http on a loopback address for a native client');
          }
        }
      },
    },
    // OAuth 2.1 only: the authorization code, nothing on the front channel; no sector identifier is ever fetched.
    responseTypes: ['code'],
    sectorIdentifierUriValidate: () => false,
    fetchResponseBodyLimits: { clientMetadata: 5120, jwks_uri: 16_384, sector_identifier_uri: 4096 } as never,
    // A browser page may call the token and registration endpoints only from an origin the deployment lists (MCP_ALLOWED_ORIGINS), never `*`.
    clientBasedCORS: (_ctx, origin) => allowedOrigins.includes(origin),
    features: {
      dPoP: { enabled: false },
      pushedAuthorizationRequests: { enabled: false },
      rpInitiatedLogout: { enabled: false },
      devInteractions: { enabled: false },
      introspection: { enabled: false },
      userinfo: { enabled: false },
      clientCredentials: { enabled: false },
      deviceFlow: { enabled: false },
      revocation: { enabled: true },
      // Dynamic client registration (RFC 7591) for MCP clients that still register themselves (ADR-0051 decision 1 of #2975). No initial access token: a
      // registered client holds no right until a person consents, and one that never obtains a grant is gone after 30 days (the adapter's default
      // life). Redirect URIs are https, or loopback http for a native client, each matched exactly: the provider's own rules for web and native.
      registration: { enabled: true, initialAccessToken: false },
      // OAuth Client ID Metadata Documents (draft-02, experimental in the library): an https client_id is fetched, through the provider's own
      // fetch, which refuses private, loopback and link-local addresses and answers within 2.5 seconds with a bounded body.
      clientIdMetadataDocument: { enabled: true, ack: 'draft-02' },
      resourceIndicators: {
        enabled: true,
        defaultResource: async () => resource,
        useGrantedResource: async () => true,
        getResourceServerInfo: async (_ctx, indicator) => {
          if (indicator !== resource) throw new errors.InvalidTarget();
          return { scope: MCP_SCOPE, audience: resource, accessTokenTTL: ACCESS_TOKEN_SECONDS, accessTokenFormat: 'jwt', jwt: { sign: { alg: 'ES256' } } };
        },
      },
    },
    ttl: {
      AccessToken: ACCESS_TOKEN_SECONDS,
      AuthorizationCode: CODE_SECONDS,
      RefreshToken: REFRESH_SECONDS,
      Session: SESSION_SECONDS,
      Interaction: INTERACTION_SECONDS,
      Grant: GRANT_SECONDS,
    },
    rotateRefreshToken: () => true,
    // A refresh token for every client that may use one (it asks no `offline_access`): the grant, not the scope string, is the authority.
    issueRefreshToken: async (_ctx, client) => client.grantTypeAllowed('refresh_token'),
    // The consent page is the SPA's, on this origin. The provider scopes its interaction cookie to this path, which the SPA's calls to
    // /oauth/interaction/:uid/... then carry.
    interactions: { url: (_ctx, interaction) => `/oauth/interaction/${interaction.uid}` },
    routes: {
      authorization: '/oauth/authorize',
      token: '/oauth/token',
      registration: '/oauth/register',
      revocation: '/oauth/revoke',
      jwks: '/oauth/jwks',
    },
    // The account of a grant is a person's user_account id. Nothing else is known of them here.
    findAccount: async (_ctx, id) => ({ accountId: id, claims: async () => ({ sub: id }) }),
    // The access token names the live grant and org. Without one (revoked, expired, stopped, the person no longer an owner or admin) no token is
    // signed, so a refresh after a revoke fails here as well as at its destroyed refresh token.
    extraTokenClaims: async (_ctx, token) => {
      const grantId = (token as { grantId?: string }).grantId;
      if (!grantId) throw new errors.InvalidGrant('no grant');
      const { rows } = await run((db) =>
        sql<{ grant_id: string; org_id: string }>`SELECT grant_id, org_id FROM crove_kernel.mcp_grant_for_oauth(${grantId}::text)`.execute(db),
      );
      const row = rows[0];
      if (!row) throw new errors.InvalidGrant('the grant is no longer valid');
      return { [GRANT_CLAIM]: row.grant_id, [ORG_CLAIM]: row.org_id };
    },
    // Errors are JSON with the OAuth error code, never a page: the clients are programs, and nothing of the server's state is shown.
    renderError: async (ctx, out) => {
      ctx.type = 'application/json';
      ctx.body = { error: out.error, error_description: out.error_description };
    },
  };

  const provider = new Provider(issuer, configuration);
  // Behind a TLS-terminating proxy the provider has to read the original scheme and host from the forwarded headers (the same hop count the edge uses).
  if (config.TRUSTED_PROXY_HOPS > 0) provider.proxy = true;

  async function verifyAccessToken(token: string): Promise<AccessTokenClaims | null> {
    try {
      const { payload, protectedHeader } = await jwtVerify(token, verifyKeys, { issuer, audience: resource, algorithms: ['ES256'], typ: 'at+jwt' });
      void protectedHeader;
      const grantId = payload[GRANT_CLAIM];
      const orgId = payload[ORG_CLAIM];
      const clientId = payload.client_id;
      const scope = typeof payload.scope === 'string' ? payload.scope.split(' ') : [];
      if (typeof grantId !== 'string' || typeof orgId !== 'string' || typeof clientId !== 'string' || typeof payload.sub !== 'string') return null;
      if (!scope.includes(MCP_SCOPE)) return null;
      return { grantId, orgId, clientId, userId: payload.sub, scopes: scope.filter((s) => (MCP_SCOPE_IDS as readonly string[]).includes(s)) };
    } catch {
      return null;
    }
  }

  return { provider, issuer, resource, verifyAccessToken };
}
