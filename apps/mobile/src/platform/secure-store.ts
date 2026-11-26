// SPDX-License-Identifier: AGPL-3.0-only
// The secure storage of the phone (iOS Keychain, Android Keystore-backed storage) as the vault's KeyValue. The item is readable
// only while the phone is unlocked and never leaves this device (no iCloud Keychain sync, no restore onto another phone). This
// is the only file that imports expo-secure-store, and the only place the app keeps a token.
import * as SecureStore from 'expo-secure-store';
import type { KeyValue } from '../auth/vault.ts';

const OPTIONS = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY } as const;

export const secureKeyValue: KeyValue = {
  get: (key) => SecureStore.getItemAsync(key, OPTIONS),
  set: (key, value) => SecureStore.setItemAsync(key, value, OPTIONS),
  remove: (key) => SecureStore.deleteItemAsync(key, OPTIONS),
};
