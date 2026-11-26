// SPDX-License-Identifier: AGPL-3.0-only
// The phone's random source and SHA-256 (expo-crypto: SecRandomCopyBytes on iOS, SecureRandom on Android) as the CryptoPort of
// PKCE and the state value.
import * as Crypto from 'expo-crypto';
import type { CryptoPort } from '../auth/pkce.ts';

export const deviceCrypto: CryptoPort = {
  randomBytes: (length) => Crypto.getRandomBytes(length),
  sha256: async (data) => new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, new Uint8Array(data))),
};
