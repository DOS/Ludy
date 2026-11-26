// SPDX-License-Identifier: AGPL-3.0-only
// PKCE (RFC 7636, S256) and the `state` value (issue #4880). The phone's random source and SHA-256 come in through CryptoPort
// (expo-crypto in the app, node:crypto in tests); nothing here keeps a value.

export interface CryptoPort {
  // Cryptographically secure random bytes (the platform's CSPRNG).
  randomBytes(length: number): Uint8Array;
  sha256(data: Uint8Array): Promise<Uint8Array>;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

// Base64 without padding in the URL alphabet (RFC 4648 section 5). Written out: a phone's JS has no Buffer.
export function base64url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    out += ALPHABET[a >> 2];
    out += ALPHABET[((a & 3) << 4) | (b >> 4)];
    if (i + 1 < bytes.length) out += ALPHABET[((b & 15) << 2) | (c >> 6)];
    if (i + 2 < bytes.length) out += ALPHABET[c & 63];
  }
  return out;
}

export function base64urlDecode(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const bytes: number[] = [];
  let bits = 0;
  let acc = 0;
  for (const ch of text) {
    acc = (acc << 6) | ALPHABET.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 255);
    }
  }
  return Uint8Array.from(bytes);
}

// 32 random bytes as 43 characters: the length of a PKCE challenge and well inside RFC 7636's 43 to 128 for a verifier. Used for
// the verifier and the state alike.
export function randomToken(crypto: CryptoPort): string {
  const bytes = crypto.randomBytes(32);
  if (bytes.length !== 32) throw new Error('the random source returned the wrong number of bytes');
  return base64url(bytes);
}

export async function pkceChallenge(crypto: CryptoPort, verifier: string): Promise<string> {
  return base64url(await crypto.sha256(new TextEncoder().encode(verifier)));
}
