# Ludy Desktop (`@ludy/desktop`)

The Windows tray shell of ADR-0055 slice 2 ([#4515](https://github.com/DOS/Ludy/issues/4515)). Owned by the Platform line. **No capture**: it records nothing and never opens the microphone; meeting capture is slice 3 (Meetings line) and fills the empty slot in `src/capture/`.

Install and the unsigned-build warning: [docs/desktop/install.md](../../docs/desktop/install.md) (Vietnamese: [install.vi.md](../../docs/desktop/install.vi.md)). Signing and update hosting (owner actions, not done): [signing-runbook.md](../../docs/desktop/signing-runbook.md).

## What it does

- **Tray only.** No window, no renderer, no remote content. "Mở Ludy" and the sign-in page open in the member's own browser.
- **Sign-in as the member**, the extension's flow: PKCE (S256) in the system browser, a one-time code back to `http://127.0.0.1:<port>/ludy-desktop/callback` (RFC 8252), traded at `POST /api/extension/token` with `client: "desktop"` for a `crx_` token. The token is one org, one member, and holds **no scope** in this slice, so it reaches `/api/extension/me` alone.
- **Token storage:** only as a blob encrypted by Electron `safeStorage` (DPAPI on Windows) in the user data folder. If the OS cannot encrypt, nothing is written and the sign-in lasts until the app quits. The stored session is bound to the configured Ludy address.
- **Revocation:** the token is listed under "thiết bị đã kết nối" next to the extension's devices. The shell checks `GET /api/extension/me` at start and every 15 minutes; a 401 signs it out and deletes the stored token. "Đăng xuất" in the tray removes the token from this computer only (the device stays listed until it is revoked there).
- **Auto-update:** Electron's built-in `autoUpdater` (Squirrel.Windows) against the deployment's own feed, `LUDY_DESKTOP_UPDATE_URL`. Off without that variable. Checks at start and every 6 hours; a downloaded update waits for the member ("Khởi động lại để cập nhật"); a failed update leaves the running version untouched.
- **Capture module slot:** `CaptureModule { start(source, meetingKey), pieces, stop() }`, with a stub that refuses (`CAPTURE_NOT_AVAILABLE`).

## Configuration

| Setting | Environment variable | `config.json` key (in the user data folder) |
|---|---|---|
| The Ludy deployment (an https origin; http only for localhost, 127.0.0.1, [::1]) | `LUDY_URL` | `ludyUrl` |
| The update feed folder (https; http only for loopback test feeds) | `LUDY_DESKTOP_UPDATE_URL` | `updateUrl` |
| A throwaway profile (CI, tests) | `LUDY_DESKTOP_USER_DATA` | none |

There is no default address and no secret in the repository.

## Why Squirrel.Windows and not MSIX

Electron's `autoUpdater` supports Squirrel.Windows natively: the feed is a folder with a `RELEASES` file and the `.nupkg`, so the deployment can serve it from any static host. MSIX updates need a signing certificate that the OS trusts, an App Installer file and, for the Store, a publisher account: all of that is spending and accounts that owner decision 7 of ADR-0055 defers until this slice is approved. Squirrel works unsigned for development builds and takes a certificate later with no code change.

## Security defaults

No window is created, so `contextIsolation`, `nodeIntegration: false` and `sandbox` do not come into play; any web contents that ever appears is locked down anyway (`will-navigate` and `window.open` denied) and every permission request (microphone, camera, screen, the rest) is refused for the default session. The loopback listener accepts one correct callback (state compared in constant time, exact path and Host), then closes, and gives up after 5 minutes. Only the configured Ludy origin is ever opened. The token is sent only to `<ludyUrl>/api/extension/me`, never followed through a redirect, and secrets are redacted from log lines.

## Develop

```bash
pnpm --filter @ludy/desktop typecheck
pnpm vitest run --project unit apps/desktop
```

The Windows installer is built by CI only ([.github/workflows/desktop-build.yml](../../.github/workflows/desktop-build.yml)), never on a shared developer machine: `scripts/package.mjs` refuses to run off Windows. `scripts/build.mjs` strips the types of `src/*.ts` with Node's `stripTypeScriptTypes` (no bundler, no transpiler dependency) into `out/stage/dist`, which is the folder Electron runs.

## Dependencies (all dev, all pinned, in the pnpm catalog)

- `electron` 45.3.4: the runtime of the shell (ADR-0055 decision 3).
- `@electron/packager` 20.3.0: packs the app folder with Electron into `ludy-desktop.exe`.
- `electron-winstaller` 5.4.4: makes the Squirrel.Windows installer, the full `.nupkg` and `RELEASES`.

Nothing is a runtime dependency of the shell: the main process uses Electron and Node only.
