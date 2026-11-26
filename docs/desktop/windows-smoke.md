# Ludy Desktop: Windows install smoke and signed verification

[#4566](https://github.com/DOS/Ludy/issues/4566), [#4515](https://github.com/DOS/Ludy/issues/4515), and [#4884](https://github.com/DOS/Ludy/issues/4884). There are two verification layers:

1. **Automated CI smoke (unsigned):** runs on every PR touching `apps/desktop/**` or its workflows via `windows-install-smoke` in [desktop-build.yml](../../.github/workflows/desktop-build.yml).
2. **Signed release verification and clean-Windows smoke:** runs in CI inside `build-signed` ([desktop-package.yml](../../.github/workflows/desktop-package.yml)) using `Get-AuthenticodeSignature` and `signtool verify /pa /v`, followed by the operator/clean-Windows verification checklist before publishing the release and switching on the production update feed ([signing-runbook.md](signing-runbook.md)).

## 1. Automated CI smoke (`windows-install-smoke`)

Job: `windows-install-smoke` in [desktop-build.yml](../../.github/workflows/desktop-build.yml). It builds two versions (A `0.1.0`, B `0.1.1`), then `apps/desktop/scripts/smoke-windows.mjs` runs these named steps and stops at the first failure (and supports `--expect-signed` when validating signed A and B installers):

| Step | What it proves |
|---|---|
| `feed-and-installers-present` | both builds have `LudyDesktop-Setup.exe`, `RELEASES`, `release-manifest.json`, and a full `.nupkg` (plus `Valid` timestamped Authenticode on `LudyDesktop-Setup.exe` when `--expect-signed` is passed) |
| `install-version-a-unsigned-silent` | `LudyDesktop-Setup.exe --silent` installs for the user (no admin) under `%LOCALAPPDATA%\LudyDesktop` and writes its "Apps and features" entry |
| `shortcut-made-by-the-squirrel-install-hook` | the `--squirrel-install` startup hook ran `Update.exe --createShortcut` |
| `first-start-reports-version-a` | the installed app starts, says it is packaged and Squirrel-installed (`squirrelInstalled`), checks the feed without finding a newer version, and (with `--expect-signed`) verifies Authenticode on `Update.exe`, `ludy-desktop.exe`, and `ludy-wasapi-loopback.exe` |
| `tray-process-and-menu` | the tray was created with the signed-out menu; exactly one main process |
| `single-instance-lock` | a second launch hands over to the first and exits; the first sees it |
| `sign-in-through-the-system-browser` | the tray's sign-in opens the default browser (`shell.openExternal`) at the fake sign-in page; PKCE S256; the loopback callback; one token exchange |
| `token-stored-with-dpapi-never-plain` | `session.bin` is a Chromium `os_crypt` blob (`v10`), the token is not in it, and `Local State` holds a DPAPI-wrapped key |
| `quit-then-restart-reads-token-back` | after a restart the app is signed in from the stored token without the sign-in page, and the server saw it |
| `corrupt-update-leaves-the-running-version-untouched` | a feed whose package fails its SHA-1/SHA-256 checksum during verification gives "update failed" on the package checksum; the same process and version keep running, still signed in |
| `update-a-to-b-and-restart` | downloads and verifies B from the `127.0.0.1` feed into local staging (`RELEASES` + `release-manifest.json`), hands Squirrel the verified local feed, offers the restart, restarts into B (`running-version.txt`), stays signed in, and (with `--expect-signed`) verifies Authenticode on B's binaries |
| `uninstall` | `Update.exe --uninstall` removes the "Apps and features" entry and the shortcuts (the `--squirrel-uninstall` hook); no Ludy process is left |
| `no-token-in-logs-or-artifacts` | none of the tokens the fake issued, nor a `crx_` marker, is in the logs that are uploaded |

### How the automated smoke is driven

- **Fake Ludy** (`apps/desktop/test/support/fake-ludy.ts`, unit-tested in `test/fake-ludy.test.ts`): `/api/config`, `/-/extension/connect`, `/api/extension/token`, `/api/extension/me`, and `/feed/<file>` on `127.0.0.1`.
- **Smoke channel** (`apps/desktop/src/smoke.ts`): active only when `LUDY_DESKTOP_SMOKE_DIR` is set **and** `LUDY_URL` is a literal loopback host.
- **No secrets, no internet:** `desktop-build.yml` builds unsigned installers, strips secret-shaped runner environment variables before starting the app, and uses loopback networking only.

## 2. Signed release verification (CI + clean Windows machine)

### CI checks in `desktop-package.yml` (`build-signed`)

When `package.mjs --sign` builds a signed release inside the owner-approved `desktop-release` environment, it fails closed unless **every** one of these binaries passes `Get-AuthenticodeSignature` (`Status: Valid`, matching `SignerCertificate.Thumbprint`, attached RFC 3161 `TimeStamperCertificate`) and `signtool verify /pa /v` (`Hash of file (sha256)`):

- `LudyDesktop-Setup.exe`
- `release-manifest.ps1` (Authenticode-signed manifest binding `release-manifest.json` and `.nupkg` SHA-256)
- `ludy-desktop.exe` (both packed app and inside `*-full.nupkg`)
- `ludy-wasapi-loopback.exe` (both packed app and inside `*-full.nupkg`)
- `Squirrel.exe` inside `*-full.nupkg` (installed as `%LOCALAPPDATA%\LudyDesktop\Update.exe`)

It also verifies `RELEASES` SHA-1 and byte size against the actual `.nupkg` and writes `release-manifest.json` (`signed: true`), signed `release-manifest.ps1`, and `SHA256SUMS.txt`.

### Clean Windows machine smoke checklist (before publishing to members)

Run on a clean Windows 10/11 machine (no developer tools, no manually imported test root certificates):

1. **Checksum and SmartScreen check:**
   - Download `LudyDesktop-Setup.exe` over HTTPS (so Windows attaches Mark-of-the-Web `Zone.Identifier`) and verify `Get-FileHash .\LudyDesktop-Setup.exe -Algorithm SHA256` against `SHA256SUMS.txt`.
   - Double-click `LudyDesktop-Setup.exe` and confirm Windows SmartScreen does **not** show an "Unknown publisher" block and shows the expected publisher name from the certificate.
2. **Installed Authenticode signature verification:**
   Run in PowerShell after installation:

   ```powershell
   $root = Join-Path $env:LOCALAPPDATA 'LudyDesktop'
   $appDir = Get-ChildItem $root -Directory -Filter 'app-*' | Sort-Object Name -Descending | Select-Object -First 1
   @(
     "$root\Update.exe",
     "$($appDir.FullName)\ludy-desktop.exe",
     "$($appDir.FullName)\resources\app.asar.unpacked\bin\ludy-wasapi-loopback.exe"
   ) | ForEach-Object {
     $sig = Get-AuthenticodeSignature -LiteralPath $_
     [pscustomobject]@{
       File = $_
       Status = $sig.Status
       Publisher = $sig.SignerCertificate.Subject
       Thumbprint = $sig.SignerCertificate.Thumbprint
       Timestamped = ($null -ne $sig.TimeStamperCertificate)
     }
   } | Format-Table -AutoSize
   ```

   Every row must show `Status = Valid` and `Timestamped = True`.
3. **Signed A-to-B update smoke over HTTPS feed:**
   - Point `LUDY_DESKTOP_UPDATE_URL` at the staging HTTPS feed holding version A, start the installed version A, sign in, and confirm no update is offered.
   - Publish signed version B (`RELEASES`, `release-manifest.json`, `release-manifest.ps1`, `LudyDesktop-<B>-full.nupkg`, `SHA256SUMS.txt`) to the HTTPS feed and restart or trigger an update check.
   - Confirm the tray switches to blue and offers **Khởi động lại để cập nhật**, click it, verify the app restarts into version B while preserving the signed-in DPAPI session, and re-run the `Get-AuthenticodeSignature` check on the new `app-<B>` folder.
   - Also run `node apps/desktop/scripts/smoke-windows.mjs --installer-a <dirA> --installer-b <dirB> --out <logs> --expect-signed` if verifying two signed builds locally in an automated lab.
