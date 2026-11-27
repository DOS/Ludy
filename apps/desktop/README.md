# Ludy Desktop (`@ludy/desktop`)

The desktop tray shell of ADR-0055 slices 2 and 3 ([#4515](https://github.com/DOS/Ludy/issues/4515), [#4516](https://github.com/DOS/Ludy/issues/4516), [#4884](https://github.com/DOS/Ludy/issues/4884), [#4885](https://github.com/DOS/Ludy/issues/4885)), for Windows (`win32-x64`) and macOS (`darwin-arm64`, `darwin-x64`). Owned by the Platform line (`line:platform`), with meeting capture behind the off-by-default `MEETINGS_DESKTOP_CAPTURE` flag.

Install guide: [docs/desktop/install.md](../../docs/desktop/install.md) (Vietnamese: [install.vi.md](../../docs/desktop/install.vi.md)). Windows signing & update hosting: [signing-runbook.md](../../docs/desktop/signing-runbook.md). macOS signing, notarization & update hosting: [mac-signing-runbook.md](../../docs/desktop/mac-signing-runbook.md).

## What it does

- **Tray / menu bar shell:** "Mở Ludy" and browser PKCE sign-in open in the member's own browser; no remote content ever loads inside Electron. Capture windows (`consent.html`, `pill.html`, `worker.html`) load strictly bundled files from `ludy-desktop://ui` with strict CSP, `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`.
- **Sign-in as the member:** PKCE (S256) in the system browser, a one-time code back to `http://127.0.0.1:<port>/ludy-desktop/callback` (RFC 8252), traded at `POST /api/extension/token` with `client: "desktop"` for a `crx_` token. Requests `meetings` / `agenda` scopes only when `MEETINGS_DESKTOP_CAPTURE` is enabled on the deployment.
- **Token storage:** encrypted blob via Electron `safeStorage` (Windows DPAPI or macOS Keychain) in `session.bin` inside the user data folder (`%APPDATA%\ludy-desktop` on Windows, `~/Library/Application Support/ludy-desktop` on macOS).
- **Revocation:** listed under "thiết bị đã kết nối". Checks `GET /api/extension/me` at start and every 15 minutes; a 401 signs out and deletes `session.bin`.
- **Auto-update:** Electron's `autoUpdater` (Squirrel.Windows on Windows; Squirrel.Mac JSON feed on macOS) verified before running by `src/update-feed.ts`, `src/authenticode.ts` (Windows), and `src/codesign.ts` (macOS): HTTPS only outside literal loopback, SSRF IP/host blocks, DNS-pinned fetch, origin pinning, manifest signature/Team ID/thumbprint verification, bounded download, ZIP/PE inspection, fail closed.
- **Meeting capture (`MEETINGS_DESKTOP_CAPTURE` off by default):** Windows per-app WASAPI loopback (`native/ludy-wasapi-loopback.cpp`) on Win10 20348+ / Win11; macOS 14.2+ Core Audio loopback via Electron (`NSAudioCaptureUsageDescription`, `NSMicrophoneUsageDescription`, minimal entitlements in `entitlements/darwin.plist`) with explicit consent gate and one-meeting lock.

## Configuration

| Setting | Environment variable | `config.json` key (in user data folder) |
|---|---|---|
| The Ludy deployment (`https`, or `http` for loopback) | `LUDY_URL` | `ludyUrl` |
| The update feed folder (`https`, or relative path on `LUDY_URL`) | `LUDY_DESKTOP_UPDATE_URL` | `updateUrl` |
| Optional pinned origin for the update feed | `LUDY_DESKTOP_UPDATE_ORIGIN` | `updateOrigin` |
| Optional Windows 40-hex SHA-1 signing certificate thumbprint pin | `LUDY_DESKTOP_UPDATE_PUBLISHER_SHA1` | `updatePublisherThumbprint` |
| Optional macOS 10-character Apple Team ID pin | `LUDY_DESKTOP_UPDATE_TEAM_ID` | `updateTeamId` |
| A throwaway profile (CI, tests) | `LUDY_DESKTOP_USER_DATA` | none |

There is no default address and no secret in the repository.

## Packaging & CI

- **Windows:** `node apps/desktop/scripts/package.mjs [--version X.Y.Z] [--skip-native] [--sign]` (runs on Windows only).
- **macOS:** `node apps/desktop/scripts/package-mac.mjs [--version X.Y.Z] [--arch arm64|x64|all] [--sign]` (runs on macOS only).
- **CI unsigned verification:** [.github/workflows/desktop-build.yml](../../.github/workflows/desktop-build.yml) builds and verifies both Windows and macOS (`arm64` and `x64`) on every desktop PR and `main` commit with zero secrets.
- **CI signed & notarized release:** [.github/workflows/desktop-package.yml](../../.github/workflows/desktop-package.yml) (`workflow_dispatch` on `main`, protected `desktop-release` environment).
- **Build staging:** `scripts/build.mjs` strips TypeScript types with Node's `stripTypeScriptTypes` into `out/stage/dist`.

## Dependencies (all dev, all pinned, in the pnpm catalog)

- `electron` 45.3.4: the runtime of the shell (ADR-0055 decision 3).
- `@electron/packager` 20.3.0: packs the app folder for Windows and macOS (includes `@electron/osx-sign`).
- `electron-winstaller` 5.4.4: makes the Squirrel.Windows installer, the full `.nupkg` and `RELEASES`.

Nothing is a runtime dependency of the shell: the main process uses Electron and Node only.
