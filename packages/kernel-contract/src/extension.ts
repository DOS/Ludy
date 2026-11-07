// SPDX-License-Identifier: AGPL-3.0-only
// The Ludy browser extension's tokens (issue #2582, ADR-0047 point 10): the connected-devices list of a member and the
// revoke of one device. The sign-in and the code exchange are HTTP routes (they carry secrets), not procedures.
import { z } from 'zod';
import { zId } from './schemas.ts';

// The scopes an extension token may hold, one per feature of the extension. @crove/kernel-runtime keeps the list the
// runtime enforces (EXTENSION_SCOPES) and crove_kernel.extension_token's CHECK the same one; a test pins the two lists.
export const EXTENSION_SCOPE_IDS = ['meetings'] as const;
export type ExtensionScopeId = (typeof EXTENSION_SCOPE_IDS)[number];
export const zExtensionScope = z.enum(EXTENSION_SCOPE_IDS);

// What the sign-in page asks the kernel for: the PKCE challenge the extension sent, the scopes and a device name.
export const zExtensionAuthorize = z.strictObject({
  codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  codeChallengeMethod: z.literal('S256'),
  scopes: z.array(zExtensionScope).min(1).max(EXTENSION_SCOPE_IDS.length),
  deviceName: z.string().trim().min(1).max(80),
});

// One connected device of the member in the org of the request. Never a hash.
export const zExtensionToken = z.strictObject({
  id: zId,
  deviceName: z.string(),
  scopes: z.array(zExtensionScope),
  createdAt: z.string(),
  expiresAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type ExtensionTokenView = z.infer<typeof zExtensionToken>;

export const zExtensionTokenRevoke = z.strictObject({ tokenId: zId });
export const zExtensionTokenRevoked = z.strictObject({ tokenId: zId, revoked: z.literal(true) });
