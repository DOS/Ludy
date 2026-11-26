# Ludy Mobile (`@ludy/mobile`)

The Expo (React Native) app of ADR-0059, Phase 2a, first slice ([#4880](https://github.com/DOS/Ludy/issues/4880)). iPhone and Android from one codebase. Owned by the Platform line. Plan: [docs/plan/desktop-mobile-apps.md](../../docs/plan/desktop-mobile-apps.md). Store steps for the owner: [docs/mobile/testflight-play-runbook.md](../../docs/mobile/testflight-play-runbook.md).

## What it does

- **Sign-in with DOS ID**: OAuth authorization code with PKCE (S256) and `state`, a public client, opened in the system browser (ASWebAuthenticationSession, Chrome Custom Tab), never a webview. The kernel accepts the access token only when its `client_id` is the deployment's `AUTH_OAUTH_CLIENT_ID` (ADR-0028, amendment 2026-11-24), so a deployment runs with `AUTH_SIGN_IN=oauth`. The app reads the client id and the endpoints from the server's `/api/config`; nothing per deployment is built in.
- **Exact redirect URI**: `vn.ludy.app://oauth-login/callback`, compared as one string. It must be registered on the deployment's OAuth App (runbook).
- **Tokens**: only the refresh token is stored, in the Keychain / Keystore (`expo-secure-store`, this device only, readable while unlocked). The access token lives in memory. Refresh tokens rotate; the new one is stored before the new access token is used, one refresh runs at a time, and a rejected refresh token signs the phone out. Sign-out clears the secure store.
- **Biometric**: the app opens behind Face ID, fingerprint or the phone's passcode, and locks after 60 seconds in the background. `StepUpGate` asks again before a sensitive action. The kernel's second factor for R3 is not done here (screen: approvals, #4881).
- **Revocation**: a 401 or an org revoke signs the phone out; the home screen asks the server every 5 minutes.
- **Which server**: a Cloud build sets `EXPO_PUBLIC_LUDY_URL` and signs in to that address only (no field). A build for one self-hosting operator sets `EXPO_PUBLIC_LUDY_CUSTOM_SERVER=1` and shows the address field. With neither the app refuses to sign in. Reason: the redirect URI is shared by every deployment, so a build that accepts any typed address could be pointed at a server that names Cloud's provider and client id and would receive Cloud tokens. A custom build must register its redirect URI on its own operator's OAuth App only.
- **Sign-out** ends the session on the server first (best effort, `sessions.revoke`), then clears the phone.

## Develop

```bash
pnpm --filter @ludy/mobile typecheck
pnpm vitest run --project unit apps/mobile
```

The logic is in `src/auth` over ports, tested without a phone; `src/platform` holds the only imports of the Expo native modules. No bundling or device run happens in CI or on shared machines.

## Dependencies (all pinned in the pnpm catalog, all MIT)

`expo`, `react-native`, `react` (the SDK 58 set), `expo-secure-store` (token storage), `expo-web-browser` (system browser), `expo-crypto` (random and SHA-256 for PKCE), `expo-local-authentication` (biometric), `@tanstack/react-query`, `@ludy/client`. Nothing is GPL or AGPL; re-check the licence of each new dependency.
