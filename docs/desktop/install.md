# Installing Ludy Desktop on Windows

Ludy Desktop is a small Windows tray app: sign in once in your browser and it stays in the notification area. Vietnamese: [install.vi.md](install.vi.md).

> **Signed release vs development build:**
> - **Signed release:** downloaded from an official `desktop-v*` release or your deployment's download page. Signed with the publisher's Windows code-signing certificate ([signing-runbook.md](signing-runbook.md)), so Windows SmartScreen displays the verified publisher instead of an "Unknown publisher" block.
> - **Unsigned CI development build:** downloaded from the `desktop-build` workflow artifact (`ludy-desktop-unsigned-win32-x64`) for internal testing only. Windows SmartScreen warns before running it.

## 1. Download and verify the installer

### Signed release

1. Download `LudyDesktop-Setup.exe` (and `SHA256SUMS.txt` if published) from the release page.
2. Check the SHA-256 hash in PowerShell:

```powershell
Get-FileHash .\LudyDesktop-Setup.exe -Algorithm SHA256
```

3. Verify the Authenticode signature (`Properties -> Digital Signatures`, or `Get-AuthenticodeSignature .\LudyDesktop-Setup.exe` reports `Status: Valid`).

### Unsigned CI build (testing only)

1. Open the **desktop-build** workflow in GitHub Actions and pick a green run.
2. Download **ludy-desktop-unsigned-win32-x64** (kept 7 days) and unzip it. Install only on a machine you trust.

## 2. Run it

1. Double-click `LudyDesktop-Setup.exe`.
2. On a signed release, SmartScreen shows the verified publisher with no "Unknown publisher" block. (On an unsigned CI build, choose **More info**, then **Run anyway**.)
3. The app installs for your user only (no administrator rights) under `%LOCALAPPDATA%\LudyDesktop` and starts. Find its dot in the notification area (`Win+B`, arrow keys, `Enter`).

## 3. Point it at your Ludy

The app has no built-in address. Set it before the first sign-in in either place (the environment variable wins):

- User environment variable: `LUDY_URL=https://ludy.your-company.example` (https only; `http://localhost:8080` works for a local test stack), or
- File `config.json` in `%APPDATA%\ludy-desktop`:

```json
{
  "ludyUrl": "https://ludy.your-company.example",
  "updateUrl": "https://updates.your-company.example/ludy-desktop/win32-x64"
}
```

Optional auto-update settings:

- `LUDY_DESKTOP_UPDATE_URL` (or `"updateUrl"` in `config.json`): https folder holding `RELEASES`, `release-manifest.json`, and the `.nupkg` files (or a relative `/...` path on `LUDY_URL`). Without it, updates are off and the tray says so.
- Optional pinning: `LUDY_DESKTOP_UPDATE_ORIGIN` (or `"updateOrigin"`) pins the update feed origin, and `LUDY_DESKTOP_UPDATE_PUBLISHER_SHA1` (or `"updatePublisherThumbprint"`) pins the 40-hex SHA-1 thumbprint of the signing certificate.
- Restart the app after changing configuration.

## 4. Sign in and out

- Tray menu **Đăng nhập** opens your browser at your Ludy. Sign in, pick the organization and press **Cho phép**. The browser returns to the app and the tray dot turns green.
- Tray menu **Đăng xuất** forgets the sign-in on this computer.

Open the tray menu with a click, or with `Enter` or the Menu key on the focused icon. Hover for status: grey is signed out, green signed in, blue an update is ready, red a problem.

## Where the token lives

The sign-in token is stored only as a blob encrypted by Windows (DPAPI, through Electron `safeStorage`, tied to your Windows account) in `%APPDATA%\ludy-desktop\session.bin`. It is never plain text and never in logs. If Windows cannot encrypt, nothing is stored and you sign in again after a restart.

## Revoking a device

In Ludy open **Cài đặt -> Thiết bị đã kết nối**: the desktop appears next to your browser extensions with its last use. **Ngắt kết nối** revokes it; the app signs itself out at its next check (at most 15 minutes, or at the next start).

## Updates

With `LUDY_DESKTOP_UPDATE_URL` set, the app checks at start and every 6 hours. Before calling Squirrel, it verifies that the feed uses HTTPS (no SSRF private IPs, no redirects, no plain HTTP or cross-origin download URLs inside `RELEASES`) and that `RELEASES` matches a signed `release-manifest.json` (and any pinned thumbprint). A newer build downloads in the background and the tray offers **Khởi động lại để cập nhật**; a failed or tampered feed leaves the running version untouched.

## Uninstall

Settings -> Apps -> **Ludy Desktop** -> Uninstall. Revoke the device in Ludy as well, because uninstalling does not tell the server.
