// SPDX-License-Identifier: AGPL-3.0-only
// Fakes for the app's ports, shared by the tests: node:crypto for PKCE, a Map for the secure storage, a scripted fetch.
import { createHash, randomBytes } from 'node:crypto';
import { REDIRECT_URI } from '../src/config.ts';
import type { OauthEndpoints } from '../src/auth/oauth.ts';
import type { CryptoPort } from '../src/auth/pkce.ts';
import type { BrowserPort, LocalAuthPort } from '../src/auth/session.ts';
import type { KeyValue } from '../src/auth/vault.ts';

export const CLIENT_ID = '3f2b8c1e-5d4a-4e7b-9a10-2c6d8e0f1a23';
export const SERVER = 'https://api.example.test';
export const ENDPOINTS: OauthEndpoints = { clientId: CLIENT_ID, authorizeUrl: 'https://id.example.test/auth/v1/oauth/authorize', tokenUrl: 'https://id.example.test/auth/v1/oauth/token' };

export const nodeCrypto: CryptoPort = {
  randomBytes: (n) => new Uint8Array(randomBytes(n)),
  sha256: async (data) => new Uint8Array(createHash('sha256').update(data).digest()),
};

// A deterministic source for the tests that need to know the verifier.
export function counterCrypto(): CryptoPort {
  let n = 0;
  return {
    randomBytes: (length) => {
      n += 1;
      return new Uint8Array(length).fill(n);
    },
    sha256: nodeCrypto.sha256,
  };
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

export function jwt(claims: Record<string, unknown>): string {
  return `${b64({ alg: 'ES256', typ: 'JWT' })}.${b64(claims)}.c2ln`;
}

export function accessToken(options: { clientId?: string; expSeconds: number; tag?: string }): string {
  return jwt({ sub: 'u1', client_id: options.clientId ?? CLIENT_ID, exp: options.expSeconds, jti: options.tag ?? 'a' });
}

export function tokenResponse(options: { access: string; refresh: string; tokenType?: string }): Response {
  return new Response(JSON.stringify({ access_token: options.access, refresh_token: options.refresh, token_type: options.tokenType ?? 'bearer', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function memoryStore(): KeyValue & { data: Map<string, string>; failSet: boolean; failRemove: boolean; failGet: boolean } {
  const data = new Map<string, string>();
  const store = {
    data,
    failSet: false,
    failRemove: false,
    failGet: false,
    async get(key: string) {
      if (store.failGet) throw new Error('keychain locked');
      return data.get(key) ?? null;
    },
    async set(key: string, value: string) {
      if (store.failSet) throw new Error('keychain full');
      data.set(key, value);
    },
    async remove(key: string) {
      if (store.failRemove) throw new Error('keychain busy');
      data.delete(key);
    },
  };
  return store;
}

export interface Recorded {
  url: string;
  init: RequestInit;
}

// A fetch that answers from a script, in order per path, and records what it was sent.
export function scriptedFetch(script: Record<string, Array<Response | (() => Response | Promise<Response>) | Error>>) {
  const calls: Recorded[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const queue = script[url];
    const next = queue?.shift();
    if (next === undefined) throw new Error(`no scripted answer for ${url}`);
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  }) as typeof fetch;
  return { fn, calls };
}

export function callbackFor(pendingUrl: string, params: Record<string, string> = {}): string {
  const state = new URL(pendingUrl).searchParams.get('state');
  const query = new URLSearchParams({ code: 'one-time-code-0123456789abcdef', ...(state ? { state } : {}), ...params });
  return `${REDIRECT_URI}?${query.toString()}`;
}

export function fakeLocalAuth(options: { level?: 'none' | 'passcode' | 'biometric'; answers?: boolean[] } = {}): LocalAuthPort & { prompts: string[] } {
  const answers = options.answers ?? [];
  const prompts: string[] = [];
  return {
    prompts,
    level: async () => options.level ?? 'biometric',
    authenticate: async (prompt) => {
      prompts.push(prompt);
      return answers.length > 0 ? (answers.shift() as boolean) : true;
    },
  };
}

export function fakeBrowser(handler: (url: string) => Promise<{ type: 'success'; url: string } | { type: 'cancel' }>): BrowserPort & { opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    open: async (url) => {
      opened.push(url);
      return handler(url);
    },
  };
}
