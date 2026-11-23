// SPDX-License-Identifier: AGPL-3.0-only
// The Ludy browser extension's tokens (issue #2582, ADR-0047 point 10): the connected-devices list of a member and the
// revoke of one device. The sign-in and the code exchange are HTTP routes (they carry secrets), not procedures.
import { z } from 'zod';
import { zId } from './schemas.ts';

// The scopes an extension token may hold, one per feature of the extension. @ludy/kernel-runtime keeps the list the
// runtime enforces (EXTENSION_SCOPES) and ludy_kernel.extension_token's CHECK the same one; a test pins the two lists.
export const EXTENSION_SCOPE_IDS = ['meetings', 'agenda', 'notes'] as const;
export type ExtensionScopeId = (typeof EXTENSION_SCOPE_IDS)[number];
export const zExtensionScope = z.enum(EXTENSION_SCOPE_IDS);

// An extension's id as Chrome and Edge make it: 32 letters a to p. It is the host of the extension's redirect address
// (https://<id>.chromiumapp.org/).
export const EXTENSION_ID_FORMAT = /^[a-p]{32}$/;
export const zExtensionId = z.string().regex(EXTENSION_ID_FORMAT);

// Who a token was made for (ADR-0055 slice 2, #4515): the browser extension, or Ludy Desktop. The server sets the marker, never a client:
// a desktop sign-in code is bound to DESKTOP_CLIENT_ID, a reserved id that is a valid extension id in form only (the HTTP edge gives
// it to an exchange that carries no browser Origin and says client "desktop"; Chrome and Edge never issue it), and the exchange copies
// the marker to the token. ludy_kernel.extension_token.client's CHECK lists the same two values and the migration the same id.
export const EXTENSION_CLIENTS = ['extension', 'desktop'] as const;
export type ExtensionClient = (typeof EXTENSION_CLIENTS)[number];
export const DESKTOP_CLIENT_ID = 'abababababababababababababababab';

// The ids that may receive a sign-in code when the deployment sets none (EXTENSION_IDS): the Ludy extension's id in the
// Chrome Web Store (#3010, first upload 2026-11-13; an item keeps its id for life, and the id is public, not a secret). The Edge Add-ons
// item has its own id, to be added here the same way once the owner has created it (D2, #3181; docs/runbooks/extension-store.md, step E5).
// Any other id is refused, so an unpacked or self-built extension (its own id, shown at chrome://extensions) needs
// EXTENSION_IDS on the server it connects to, and a server that sets EXTENSION_IDS uses only that list.
export const DEFAULT_EXTENSION_IDS: readonly string[] = Object.freeze(['emfhpcbmdbbeomfkdadbellllngmlhmf']);

// What the sign-in page asks the kernel for: the extension it is signing in (the host of its redirect address), the PKCE
// challenge the extension sent, the scopes and a device name.
export const zExtensionAuthorize = z.strictObject({
  extensionId: zExtensionId,
  codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  codeChallengeMethod: z.literal('S256'),
  // The agenda scope rides with the meetings scope (B2): the token's own exchange is a meetings command, and the card exists to start a recording.
  // At least one scope for the extension; Ludy Desktop (DESKTOP_CLIENT_ID) asks for none and may not ask for any, since its features are not built yet (#4515).
  scopes: z.array(zExtensionScope).max(EXTENSION_SCOPE_IDS.length).refine((scopes) => !scopes.includes('agenda') || scopes.includes('meetings'), 'agenda needs meetings'),
  deviceName: z.string().trim().min(1).max(80),
}).refine((input) => (input.extensionId === DESKTOP_CLIENT_ID ? input.scopes.length === 0 : input.scopes.length >= 1), {
  path: ['scopes'],
  message: 'the extension needs a scope, Ludy Desktop holds none',
});

// One connected device of the member in the org of the request. Never a hash.
export const zExtensionToken = z.strictObject({
  id: zId,
  deviceName: z.string(),
  scopes: z.array(zExtensionScope),
  // Which client the device is (#4515): the browser extension or Ludy Desktop, so the devices screen can tell them apart.
  client: z.enum(EXTENSION_CLIENTS),
  createdAt: z.string(),
  expiresAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type ExtensionTokenView = z.infer<typeof zExtensionToken>;

export const zExtensionTokenRevoke = z.strictObject({ tokenId: zId });
export const zExtensionTokenRevoked = z.strictObject({ tokenId: zId, revoked: z.literal(true) });

// One connected device of any member of the org, for an owner or an admin. Never a hash.
export const zExtensionOrgToken = zExtensionToken.extend({ userId: zId });
export type ExtensionOrgTokenView = z.infer<typeof zExtensionOrgToken>;

export const zExtensionTokenRevokedMember = z.strictObject({ tokenId: zId, userId: zId, revoked: z.literal(true) });
