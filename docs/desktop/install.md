# Installing Ludy Desktop (development build)

Ludy Desktop is a small Windows tray app: sign in once and it sits in the notification area. In this version it **records nothing**; it is the shell that later versions add meeting capture to ([ADR-0055](../adr/0055-three-capture-paths-one-meeting.md)). Vietnamese: [install.vi.md](install.vi.md).

> **This is an unsigned development build.** No code-signing certificate exists yet (the owner has not bought one; see [signing-runbook.md](signing-runbook.md)), so Windows will warn you when you run it. Install it only on a computer you control, and only the build you downloaded yourself from the project's CI run. Signed installers come later.

## 1. Get the installer

1. Open the **desktop-build** workflow in the project's GitHub Actions and pick a green run on the commit you want.
2. Download the artifact **ludy-desktop-unsigned-win32-x64** (kept 7 days) and unzip it. It holds `LudyDesktop-Setup.exe`, a `.nupkg` and `RELEASES`.

## 2. Run it and get past the Windows warning

1. Double-click `LudyDesktop-Setup.exe`.
2. Windows SmartScreen shows "Windows protected your PC" because the file is unsigned. Choose **More info**, then **Run anyway**.
3. The app installs for your user only (no administrator rights) and starts. Look for its dot in the notification area (Win+B, then the arrow keys, then Enter).

## 3. Point it at your Ludy

The app has no built-in address. Set it before the first sign-in, in either place (the environment variable wins):

- an environment variable for your user: `LUDY_URL=https://ludy.your-company.example` (https only; `http://localhost:8080` works for a local test stack), or
- a file `config.json` in `%APPDATA%\ludy-desktop` containing `{ "ludyUrl": "https://ludy.your-company.example" }`.

Optional, for self-updates: `LUDY_DESKTOP_UPDATE_URL` (or `"updateUrl"` in `config.json`), the https folder that holds `RELEASES` and the `.nupkg` of your deployment. Without it, updates are off and the tray says so. Restart the app after changing either.

## 4. Sign in and out

- Tray menu **Đăng nhập** opens your browser at your Ludy. Sign in as usual, pick the organization and press **Cho phép**. The browser returns to the app and the tray dot turns green.
- Tray menu **Đăng xuất** forgets the sign-in on this computer.

The tray menu opens with a click, or with Enter or the Menu key on the focused icon. It shows **Mở Ludy** (opens your Ludy in the browser), **Đăng nhập** or **Đăng xuất**, **Khởi động lại để cập nhật** when an update is ready, and **Thoát**. Hover the icon for the state: grey is signed out, green signed in, blue an update is ready, red a problem (a wrong address, a refused sign-in, a failed update).

## Where the token lives

The sign-in token is stored only as a blob encrypted by Windows (DPAPI, through Electron `safeStorage`, tied to your Windows account) in `%APPDATA%\ludy-desktop`. It is never a plain file, never in a log. If Windows cannot encrypt, nothing is stored and you sign in again after a restart. The token belongs to one organization and one member and holds no feature permission in this version: it can only ask the server who it is.

## Revoking a device

In Ludy open **Cài đặt**, **Thiết bị đã kết nối**: the desktop appears next to your browser extensions with its last use. **Ngắt kết nối** revokes it; the app signs itself out at its next check (at most 15 minutes, or at the next start). Owners and admins can cut off any member's device under the organization's devices.

## Updates

With `LUDY_DESKTOP_UPDATE_URL` set, the app checks at start and every 6 hours. A newer build downloads in the background and the tray offers **Khởi động lại để cập nhật**; nothing restarts by itself. A failed update leaves the version you are running untouched.

## Uninstall

Settings, Apps, **Ludy Desktop**, Uninstall. Revoke the device in Ludy as well, because uninstalling does not tell the server.
