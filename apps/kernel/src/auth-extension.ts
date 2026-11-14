// SPDX-License-Identifier: AGPL-3.0-only
// The Ludy extension token on the HTTP edge (issue #2582, ADR-0047 point 10, meetings plan M8).
//
// The extension never holds the member's password or browser session. It signs in through the app (a browser window
// the member approves for one org), trades a one-time PKCE code for an opaque token, and sends that token as a bearer
// token. `authenticate()` treats it as its own kind of credential:
//   - the token is `crx_` and 43 random base64url characters; only its SHA-256 reaches the database, and only the
//     crove_kernel.verify_extension_token definer can turn that hash back into a (token, org, member, scopes) row;
//   - the row exists only while the token is not revoked or expired, its org is active and its member is still an
//     owner, admin or member who joined before the token was made;
//   - the request then runs as that member in that org, with an actor that carries the token's id and scopes, so the
//     runtime re-checks the token inside each transaction and opens only the commands and queries that declare one of
//     the token's scopes (CommandDef.extension, QueryDef.extension).
// This file also holds the one list of HTTP routes a token may reach, by scope, which http.ts checks before any
// handler runs and which the route enumeration test (#693) reads: a token is refused on every other route.
import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import type { Db } from '@crove/db';
import { EXTENSION_ID_FORMAT } from '@crove/kernel-contract';
import { DomainError, EXTENSION_SCOPES, toDomainError, type ExtensionScope } from '@crove/kernel-runtime';
import { logEvent } from './log.ts';

// The extension id an `Origin` header names: chrome-extension://<32 letters a to p>, nothing else (no path, port, userinfo or other
// scheme). Chrome and Edge send it on the extension's own requests and a web page cannot forge it (#2850). null for anything else.
const EXTENSION_ORIGIN = /^chrome-extension:\/\/([a-p]{32})$/;
export function extensionIdOfOrigin(origin: string | null | undefined): string | null {
  return EXTENSION_ORIGIN.exec(origin ?? '')?.[1] ?? null;
}

export const EXTENSION_TOKEN_PREFIX = 'crx_';
const EXTENSION_CODE_PREFIX = 'crc_';
const SECRET_BODY = '[A-Za-z0-9_-]{43}';
const TOKEN_FORMAT = new RegExp(`^${EXTENSION_TOKEN_PREFIX}${SECRET_BODY}$`);
const CODE_FORMAT = new RegExp(`^${EXTENSION_CODE_PREFIX}${SECRET_BODY}$`);
// RFC 7636: 43 to 128 unreserved characters. A verifier is as long as the extension chose; its challenge is 43.
const VERIFIER_FORMAT = /^[A-Za-z0-9._~-]{43,128}$/;
const CHALLENGE_FORMAT = /^[A-Za-z0-9_-]{43}$/;

export interface ExtensionSecret {
  // The secret as the client holds it: shown once, never stored by the kernel.
  value: string;
  // What the database keeps: the SHA-256 of `value` (32 bytes).
  hash: Buffer;
}

export function hashExtensionSecret(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function newSecret(prefix: string): ExtensionSecret {
  const value = `${prefix}${randomBytes(32).toString('base64url')}`;
  return { value, hash: hashExtensionSecret(value) };
}

export const newExtensionToken = (): ExtensionSecret => newSecret(EXTENSION_TOKEN_PREFIX);
export const newExtensionCode = (): ExtensionSecret => newSecret(EXTENSION_CODE_PREFIX);

export const isExtensionBearer = (token: string): boolean => token.startsWith(EXTENSION_TOKEN_PREFIX);
export const wellFormedExtensionCode = (value: unknown): value is string => typeof value === 'string' && CODE_FORMAT.test(value);
export const wellFormedVerifier = (value: unknown): value is string => typeof value === 'string' && VERIFIER_FORMAT.test(value);
export const wellFormedChallenge = (value: unknown): value is string => typeof value === 'string' && CHALLENGE_FORMAT.test(value);

const invalidToken = () => new DomainError('EXTENSION_TOKEN_INVALID', 401, 'Mã của tiện ích Ludy không còn hiệu lực, hãy đăng nhập lại tiện ích');

// What a verified token proves.
export interface ExtensionIdentity {
  tokenId: string;
  orgId: string;
  userId: string;
  scopes: readonly ExtensionScope[];
  // ISO time the token ends.
  expiresAt: string;
}

// Turns a bearer token into its identity, or refuses it with 401 EXTENSION_TOKEN_INVALID for every reason alike
// (malformed, unknown, revoked, expired, member gone, org not active): the answer never says which.
export async function verifyExtensionBearer(db: Db, token: string): Promise<ExtensionIdentity> {
  if (!TOKEN_FORMAT.test(token)) throw invalidToken();
  let rows: Array<{ token_id: string; org_id: string; user_id: string; scopes: string[]; expires_at: Date }>;
  try {
    ({ rows } = await sql<{ token_id: string; org_id: string; user_id: string; scopes: string[]; expires_at: Date }>`
      SELECT token_id, org_id, user_id, scopes, expires_at FROM crove_kernel.verify_extension_token(${hashExtensionSecret(token)}::bytea, ${null}::text)`.execute(db));
  } catch (error) {
    throw toDomainError(error);
  }
  const row = rows[0];
  if (!row) throw invalidToken();
  const scopes = row.scopes.filter((s): s is ExtensionScope => (EXTENSION_SCOPES as readonly string[]).includes(s));
  // A token holding a scope this build does not know is not trusted with the ones it does: it is refused outright.
  if (scopes.length === 0 || scopes.length !== row.scopes.length) throw invalidToken();
  return { tokenId: row.token_id, orgId: row.org_id, userId: row.user_id, scopes, expiresAt: new Date(row.expires_at).toISOString() };
}

export interface ExtensionExchange {
  // The one-time code the token came from: the audit row of the exchange names it with the token.
  codeId: string;
  tokenId: string;
  orgId: string;
  userId: string;
  scopes: string[];
  expiresAt: string;
}

// Trades a one-time code and its PKCE verifier for a new token, once. Null for every refusal alike (an unknown, used,
// expired or wrong code; a member who left). The raw code and token never reach SQL: only their hashes do, and the
// verifier, which is worthless without the code. The code is bound to the extension it was issued for (#2850): `extensionId`, read by the
// caller from the Origin header, must be that one, or the answer is null and the code is not spent. That is defence in depth against
// an exchange by another extension in the browser: a client outside the browser that holds the code and the verifier can set any Origin. The caller audits the exchange (kernel.extension.token.exchanged), which
// needs the new token's actor: the exchange itself runs with no member context and so cannot write an audit row.
export async function exchangeExtensionCode(db: Db, code: string, verifier: string, extensionId: string): Promise<{ exchange: ExtensionExchange; token: string } | null> {
  if (!CODE_FORMAT.test(code) || !VERIFIER_FORMAT.test(verifier) || !EXTENSION_ID_FORMAT.test(extensionId)) return null;
  const token = newExtensionToken();
  let rows: Array<{ token_id: string; org_id: string; user_id: string; scopes: string[]; expires_at: Date; code_id: string }>;
  try {
    ({ rows } = await sql<{ token_id: string; org_id: string; user_id: string; scopes: string[]; expires_at: Date; code_id: string }>`
      SELECT token_id, org_id, user_id, scopes, expires_at, code_id
      FROM crove_kernel.exchange_extension_auth_code(${hashExtensionSecret(code)}::bytea, ${verifier}::text, ${token.hash}::bytea, ${extensionId}::text)`.execute(db));
  } catch (error) {
    throw toDomainError(error);
  }
  const row = rows[0];
  if (!row) return null;
  return {
    token: token.value,
    exchange: { codeId: row.code_id, tokenId: row.token_id, orgId: row.org_id, userId: row.user_id, scopes: row.scopes, expiresAt: new Date(row.expires_at).toISOString() },
  };
}

// Revokes the token row an exchange just made when the exchange cannot be completed (its audit row failed), so no usable
// row is left that the client never received. By the token's hash, while it has never been used (last_used_at is null); the definer audits
// it as a system revoke. true when a row was revoked. Never throws: the caller is already handling a failure.
export async function voidUndeliveredExtensionToken(db: Db, token: string): Promise<boolean> {
  try {
    const { rows } = await sql<{ voided: boolean }>`SELECT crove_kernel.void_undelivered_extension_token(${hashExtensionSecret(token)}::bytea) AS voided`.execute(db);
    return rows[0]?.voided === true;
  } catch (error) {
    // Never the token or its hash: the class of the failure only.
    logEvent('error', 'extension token void failed', { error: error instanceof Error ? error.name : 'unknown' });
    return false;
  }
}

// One HTTP route a token may reach. `scope` null: any token (the route opens no feature). Everything a route runs
// still declares its own scope on the command or query (the runtime refuses the token otherwise), so this list and the
// declarations must agree for a route to work, and either one alone keeps a token out.
export interface ExtensionRoute {
  method: 'GET' | 'POST';
  // Exact path; `:id` stands for one UUID segment.
  path: string;
  scope: ExtensionScope | null;
  why: string;
}

// The routes an extension token may reach, and nothing else (deny by default). None reads a meeting's content: the
// meetings scope creates a meeting with its consent record, gets an upload grant, finishes the upload of a meeting
// the same token created and reads its status.
export const EXTENSION_ROUTES: readonly ExtensionRoute[] = Object.freeze([
  { method: 'GET', path: '/api/extension/me', scope: null, why: 'who the token is for: org, scopes, end date and the features this deployment runs; no tenant data' },
  { method: 'POST', path: '/api/rpc/meetings/create', scope: 'meetings', why: 'create a meeting with its consent record (meetings.meeting.create)' },
  { method: 'POST', path: '/api/rpc/meetings/extensionStatus', scope: 'meetings', why: "a meeting this token created: its status and whether its audio and video arrived, never its content (meetings.meeting.extension_status)" },
  { method: 'POST', path: '/api/files/uploads', scope: 'meetings', why: 'an upload grant, for the meeting_audio and meeting_video purposes only (the handler refuses any other purpose for a token)' },
  { method: 'POST', path: '/api/meetings/:id/media', scope: 'meetings', why: 'finish the upload of the media of a meeting this token created (meetings.media.record)' },
  { method: 'POST', path: '/api/meetings/:id/live-chunk', scope: 'meetings', why: 'a piece of the recording of a live-notes meeting this token created, sealed and stored by the route (meetings.live.chunk, ADR-0052 L4a)' },
]);

const ROUTE_PATTERNS = EXTENSION_ROUTES.map((route) => ({
  route,
  pattern: new RegExp(`^${route.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(':id', '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}')}$`),
}));

// The route a request names, or null. The path is the raw one of the request URL: a percent-encoded path never
// matches, so nothing a router decodes later can name a procedure the list does not.
export function matchExtensionRoute(method: string, rawPath: string): ExtensionRoute | null {
  if (rawPath.includes('%')) return null;
  for (const { route, pattern } of ROUTE_PATTERNS) {
    if (route.method === method && pattern.test(rawPath)) return route;
  }
  return null;
}

// The edge's check for a request made with an extension token: refused unless it names a listed route whose scope the
// token holds. 403 EXTENSION_SCOPE, said before any handler, body read or database call.
export function refuseOutsideScopes(scopes: readonly string[], method: string, rawPath: string): DomainError | null {
  const route = matchExtensionRoute(method, rawPath);
  if (route && (route.scope === null || scopes.includes(route.scope))) return null;
  return new DomainError('FORBIDDEN', 403, 'Mã của tiện ích Ludy không được dùng cho việc này', { rule: 'extension_scope' });
}
