// SPDX-License-Identifier: AGPL-3.0-only
// The Expo configuration of Ludy Mobile (issue #4880, docs/mobile/testflight-play-runbook.md). Nothing here is a secret: the store
// accounts, signing keys and the EAS project id are the owner's and live in the owner's Expo account, never in this repository.
import type { ExpoConfig } from 'expo/config';

const config: ExpoConfig = {
  name: 'Ludy',
  slug: 'ludy',
  version: '0.1.0',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  // The private-use URI scheme the sign-in returns to (RFC 8252): src/config.ts REDIRECT_URI, registered on the OAuth App.
  scheme: 'vn.ludy.app',
  ios: {
    bundleIdentifier: 'vn.ludy.app',
    supportsTablet: true,
    config: { usesNonExemptEncryption: false },
    infoPlist: {
      NSFaceIDUsageDescription: 'Ludy dùng Face ID để mở khóa ứng dụng và xác nhận các việc quan trọng. Dữ liệu khuôn mặt không rời khỏi điện thoại.',
    },
  },
  android: {
    package: 'vn.ludy.app',
    // The secure-storage ciphertext must not travel in a cloud backup to another phone, where it could not be opened anyway.
    allowBackup: false,
  },
  plugins: [
    'expo-secure-store',
    'expo-web-browser',
    ['expo-local-authentication', { faceIDPermission: 'Ludy dùng Face ID để mở khóa ứng dụng và xác nhận các việc quan trọng.' }],
  ],
};

export default config;
