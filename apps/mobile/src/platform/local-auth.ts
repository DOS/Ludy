// SPDX-License-Identifier: AGPL-3.0-only
// The phone's own lock (expo-local-authentication): Face ID or Touch ID on iOS, the BiometricPrompt on Android, falling back to
// the phone's passcode when the person has no biometric or it fails. The result is a yes or a no and nothing else: no
// biometric data ever reaches the app.
import * as LocalAuthentication from 'expo-local-authentication';
import type { LocalAuthPort } from '../auth/session.ts';

export const deviceLocalAuth: LocalAuthPort = {
  async level() {
    const level = await LocalAuthentication.getEnrolledLevelAsync();
    if (level === LocalAuthentication.SecurityLevel.NONE) return 'none';
    return level === LocalAuthentication.SecurityLevel.SECRET ? 'passcode' : 'biometric';
  },
  async authenticate(prompt) {
    const result = await LocalAuthentication.authenticateAsync({ promptMessage: prompt, disableDeviceFallback: false });
    return result.success;
  },
};
