// SPDX-License-Identifier: AGPL-3.0-only
// The oRPC client of the kernel, built the same way for the web app and the mobile app (issue #4880). The caller says where
// the API is and which headers each request carries (the bearer token and the org); nothing here reads storage, a cookie or
// a global, and no token is kept: `headers` is asked for on every request, so a refreshed token is used at once.
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { ORG_HEADER, type contract } from '@ludy/kernel-contract';

export type LudyClient = ContractRouterClient<typeof contract>;

export interface LudyClientOptions {
  // The API's origin without a trailing slash: `https://api.example.com`, or '' for the page's own origin (the web app).
  origin: string;
  headers: () => Promise<Record<string, string>> | Record<string, string>;
}

// The request headers for the kernel. `org` is null for org-less calls (the user's own sign-out revoke is one, so an org
// that refuses this session cannot swallow it: the kernel picks an org that can run it, or none).
export function requestHeaders(token: string | null, org: string | null): Record<string, string> {
  return {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(org ? { [ORG_HEADER]: org } : {}),
  };
}

export function createLudyClient(options: LudyClientOptions): LudyClient {
  return createORPCClient(new RPCLink({ url: `${options.origin}/api/rpc`, headers: options.headers }));
}
