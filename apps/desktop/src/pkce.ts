// SPDX-License-Identifier: AGPL-3.0-only
// PKCE (RFC 7636, S256) for the desktop sign-in, the same shape the extension uses: a 43-character verifier the shell keeps, its
// SHA-256 challenge the sign-in page receives, and a random state that ties the browser's answer to this sign-in.
import { createHash, randomBytes } from 'node:crypto';

export interface Pkce {
  verifier: string;
  challenge: string;
  state: string;
}

export function newPkce(random: (size: number) => Uint8Array = randomBytes): Pkce {
  const verifier = Buffer.from(random(32)).toString('base64url');
  const challenge = createHash('sha256').update(verifier, 'utf8').digest('base64url');
  const state = Buffer.from(random(16)).toString('base64url');
  return { verifier, challenge, state };
}
