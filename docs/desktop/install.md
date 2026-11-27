# Installing Ludy Desktop (Windows & macOS)

Ludy Desktop is a small tray / menu bar app: sign in once in your browser and it stays ready in the notification area (Windows) or menu bar (macOS). Vietnamese: [install.vi.md](install.vi.md).

> **Signed & notarized release vs development build:**
> - **Signed release:** downloaded from an official `desktop-v*` release or your deployment's download page. Windows builds are Authenticode-signed ([signing-runbook.md](signing-runbook.md)); macOS builds are Developer ID signed and Apple notarized ([mac-signing-runbook.md](mac-signing-runbook.md)), so SmartScreen and Gatekeeper accept the verified publisher without "Unknown publisher" or unidentified-developer blocks.
> - **Unsigned CI development build:** downloaded from the `desktop-build` workflow artifacts (`ludy-desktop-unsigned-win32-x64` or `ludy-desktop-unsigned-darwin`) for internal testing only. Windows SmartScreen and macOS Gatekeeper will warn or block unsigned builds.

## 1. Download and verify the installer

### Windows (x64)

1. Download `LudyDesktop-Setup.exe` (and `SHA256SUMS.txt` if published) from the official release page.
2. Verify the SHA-256 hash in PowerShell:

```powershell
Get-FileHash .\LudyDesktop-Setup.exe -Algorithm SHA256
```

3. Verify the Authenticode signature (`Properties -> Digital Signatures`, or `Get-AuthenticodeSignature .\LudyDesktop-Setup.exe` reports `Status: Valid`).

### macOS (Apple Silicon `arm64` and Intel `x64`)

1. Pick the `.dmg` for your Mac:
   - Apple Silicon (M1, M2, M3, M4 or newer): `LudyDesktop-<version>-darwin-arm64.dmg`
   - Intel Mac: `LudyDesktop-<version>-darwin-x64.dmg`
2. Verify the SHA-256 checksum and Apple Gatekeeper notarization in Terminal before opening:

```bash
shasum -a 256 LudyDesktop-<version>-darwin-arm64.dmg
spctl -a -t open --context context:primary-signature -vv LudyDesktop-<version>-darwin-arm64.dmg
```

Confirm `spctl` reports `accepted` and `source=Notarized Developer ID`.

### Unsigned CI builds (testing only)

1. Open the **desktop-build** workflow in GitHub Actions and pick a green run.
2. Download `ludy-desktop-unsigned-win32-x64` or `ludy-desktop-unsigned-darwin` (kept 7 days) and extract it. Install only on a machine you trust.

## 2. Install and run

### Windows

1. Double-click `LudyDesktop-Setup.exe`.
2. On a signed release, SmartScreen shows the verified publisher with no "Unknown publisher" block. (On an unsigned CI build, choose **More info**, then **Run anyway**.)
3. The app installs for your user only (no administrator rights) under `%LOCALAPPDATA%\LudyDesktop` and starts in the notification area (`Win+B`, arrow keys, `Enter`).

### macOS

1. Open `LudyDesktop-<version>-darwin-<arch>.dmg` and drag **Ludy Desktop.app** into **Applications**.
2. Launch **Ludy Desktop** from `/Applications`. On a signed and notarized release, Gatekeeper opens it cleanly after the standard downloaded-app prompt with zero unidentified-developer warnings.
3. Optional verification after copying to `/Applications`:

```bash
codesign --verify --deep --strict --verbose=2 "/Applications/Ludy Desktop.app"
spctl -a -t exec -vv "/Applications/Ludy Desktop.app"
```

4. Find Ludy Desktop's status dot in the top-right macOS menu bar.

## 3. Point it at your Ludy

The app has no built-in address. Set it before the first sign-in using environment variables or `config.json` (environment variables win):

- Environment variable: `LUDY_URL=https://ludy.your-company.example` (`https` only; `http://localhost:8080` works for a local test stack)
- Configuration file `config.json`:
  - **Windows:** `%APPDATA%\ludy-desktop\config.json`
  - **macOS:** `~/Library/Application Support/ludy-desktop/config.json`

```json
{
  "ludyUrl": "https://ludy.your-company.example",
  "updateUrl": "https://updates.your-company.example/ludy-desktop/darwin-arm64"
}
```

Use `.../win32-x64` on Windows, `.../darwin-arm64` on Apple Silicon Macs, or `.../darwin-x64` on Intel Macs.

Optional auto-update settings:

- `LUDY_DESKTOP_UPDATE_URL` (or `"updateUrl"` in `config.json`): `https` folder holding the deployment's update feed (or a relative `/...` path on `LUDY_URL`). Without it, updates are off and the tray says so.
- `LUDY_DESKTOP_UPDATE_ORIGIN` (or `"updateOrigin"`): pins the update feed origin.
- **Windows:** `LUDY_DESKTOP_UPDATE_PUBLISHER_SHA1` (or `"updatePublisherThumbprint"`): pins the 40-hex SHA-1 thumbprint of the Windows signing certificate.
- **macOS:** `LUDY_DESKTOP_UPDATE_TEAM_ID` (or `"updateTeamId"`): pins the 10-character Apple Developer Team ID.
- Restart the app after changing configuration.

## 4. Sign in, permissions, and tray status

- Menu **Đăng nhập** opens your browser at your Ludy. Sign in, pick the organization and press **Cho phép**. The browser returns to the app and the icon turns green.
- Menu **Đăng xuất** forgets the sign-in on this computer.
- **macOS meeting capture permissions (when enabled by server):** on macOS 14.2+, recording calls requires allowing **Microphone** and **System Audio Recording Only** (or Screen & System Audio Recording) under **System Settings -> Privacy & Security** when prompted. Recording starts only after you confirm the meeting notice and click start.

Icon colors: grey is signed out, green signed in, red with dot recording, blue an update is ready, solid red a problem.

## Where the token lives

The sign-in token is stored only as a blob encrypted by the OS (`safeStorage`: Windows DPAPI or macOS Keychain) in `session.bin` inside the user data folder (`%APPDATA%\ludy-desktop\session.bin` on Windows, `~/Library/Application Support/ludy-desktop/session.bin` on macOS). It is never plain text and never in logs. If the OS key store is unavailable, nothing is written to disk and you sign in again after a restart.

## Revoking a device

In Ludy open **Cài đặt -> Thiết bị đã kết nối**: the desktop appears next to your browser extensions with its last use. **Ngắt kết nối** revokes it; the app signs itself out at its next check (at most 15 minutes, or at the next start).

## Updates

With `LUDY_DESKTOP_UPDATE_URL` set, the app checks at start and every 6 hours. Before installing, it verifies HTTPS (no SSRF private IPs, no redirects, no plain HTTP outside loopback test hosts), verifies `release-manifest.json` against the platform signature pin (Authenticode + RFC 3161 on Windows; SHA-256 + ZIP safety + `codesign --verify --deep --strict` + Hardened Runtime + Apple Team ID + Gatekeeper `spctl` on macOS). A newer build downloads in the background and the tray offers **Khởi động lại để cập nhật**; a failed or tampered feed leaves the running version untouched.

## Uninstall

- **Windows:** Settings -> Apps -> **Ludy Desktop** -> Uninstall.
- **macOS:** Quit Ludy Desktop from the menu bar, drag **Ludy Desktop.app** from `/Applications` to Trash, and optionally remove `~/Library/Application Support/ludy-desktop`.
- Revoke the device in Ludy (**Cài đặt -> Thiết bị đã kết nối**) as well, because uninstalling does not notify the server.
