# Runbook: TestFlight and Play internal track (owner steps, not run by agents)

For [#4880](https://github.com/DOS/Ludy/issues/4880). These steps use the owner's Apple, Google Play and Expo accounts. No agent runs them, and no key, certificate or token goes into this repository.

## 1. Register the redirect URI on the OAuth App

In the identity provider's OAuth App of the deployment (the one whose client id is `AUTH_OAUTH_CLIENT_ID`), add the redirect URI `vn.ludy.app://oauth-login/callback`, exactly. The deployment runs `AUTH_SIGN_IN=oauth`. Check: opening the app's sign-in must reach the DOS ID page, not an "invalid redirect" error.

## 2. Build settings

- Cloud build: set `EXPO_PUBLIC_LUDY_URL=https://api.ludy.vn` in the EAS build profile (a public address). Self-host builds leave it unset: the app then asks for the server address.
- Bundle id and Android package: `vn.ludy.app` (`apps/mobile/app.config.ts`).
- Add the app icon and splash before a store submission (not in this slice).

## 3. iPhone (TestFlight)

1. Apple Developer Program account, an App Store Connect record for `vn.ludy.app`.
2. `eas login`, `eas build:configure`, then `eas build --platform ios --profile production`; `eas submit --platform ios`.
3. Add internal testers in TestFlight.
4. Apple guideline 4.8 (Sign in with Apple): the app signs in only with the company's own account system (DOS ID), which the guideline exempts; say so in the review notes.

## 4. Android (Play internal track)

1. Google Play Console account and an app record for `vn.ludy.app`.
2. `eas build --platform android --profile production`; upload the AAB to the internal testing track (the first upload is manual in the Console), then `eas submit --platform android`.

## 5. Acceptance on real phones

On an iPhone and an Android phone: sign in once; kill and reopen the app and unlock with the biometric; see the home screen; in Settings, "thiết bị đã kết nối" or the org's sessions, revoke the session and see the phone sign out within 5 minutes (or on the next tap). A phone with no screen lock must refuse to sign in.

## Not decided here

The AGPL question for store distribution is with the lawyer ([#62](https://github.com/DOS/Ludy/issues/62)); do not submit to the public stores before it is answered.
