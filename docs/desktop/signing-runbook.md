# Runbook: signing, update hosting and publishing Ludy Desktop

**Status: CI wiring and code ready; live signing and publishing run only on owner approval.** Per [AGENTS.md](../../AGENTS.md), no worker or team lead executes Production or credential steps. The coordinator runs the exact approved steps and stops at the first failure. For macOS Developer ID signing and Apple notarization, see [mac-signing-runbook.md](mac-signing-runbook.md).

## What is built vs what requires owner approval

| Component | State | Notes |
|---|---|---|
| Unsigned CI build and A-to-B install smoke | Automated | [.github/workflows/desktop-build.yml](../../.github/workflows/desktop-build.yml) |
| Signed build script and Authenticode verifier | Ready in repo | `apps/desktop/scripts/package.mjs --sign` + `apps/desktop/scripts/signing.mjs` |
| Release workflow (dry-run and secret-gated signed release) | Ready in repo | [.github/workflows/desktop-package.yml](../../.github/workflows/desktop-package.yml) (`workflow_dispatch` on `main`) |
| Update feed manifest and shell verification | Ready in repo | `RELEASES` + `release-manifest.json` + Authenticode-signed `release-manifest.ps1` + `SHA256SUMS.txt`; HTTPS, DNS-pinned fetch, SSRF, origin pinning, and Windows Authenticode checks in `apps/desktop/src/update-feed.ts` and `apps/desktop/src/authenticode.ts` |
| Windows code-signing certificate secrets in `desktop-release` environment | Owner action | Never store certificates, passwords, or private keys in the repository |
| Hosted HTTPS update feed and public release | Owner / coordinator action | Static host controlled by the deployment |

## Step 1. Configure the `desktop-release` GitHub environment (owner)

1. In GitHub repository settings, create an environment named `desktop-release`.
2. Enable **Required reviewers**, add the owner, and disable **Allow administrators to bypass configured protection rules** so no signed build can access signing credentials without explicit owner approval.
3. Restrict **Deployment branches and tags** on `desktop-release` to **Selected branches** -> `main` only (because `desktop-package.yml` dispatches strictly from `refs/heads/main`, so the workflow definition always comes from reviewed `main`).
4. Keep `desktop-build.yml` completely secret-free for pull request and `main` CI checks.

## Step 2. Add certificate secrets to `desktop-release` (owner)

Choose **one** of the supported signing modes in `desktop-release` (configuring more than one fails closed):

### Option A: PFX / PKCS#12 certificate (when holding an exportable `.pfx`)

Set two **Secrets** in the `desktop-release` environment:

- `WINDOWS_CERT_PFX_BASE64`: base64 encoding of the `.pfx` file (single line, no headers).
- `WINDOWS_CERT_PASSWORD`: password to decrypt the `.pfx`.

How CI handles it safely: `desktop-package.yml` decodes `WINDOWS_CERT_PFX_BASE64` into a temporary file, imports it into the ephemeral runner's `Cert:\CurrentUser\My` store via a PowerShell `SecureString`, deletes the `.pfx` immediately, passes only the SHA-1 thumbprint (`WINDOWS_CERT_SHA1`) to `package.mjs --sign`, and removes both the certificate and key (`Remove-Item -DeleteKey`) in an `if: always()` cleanup step. Passwords never appear on a `Squirrel.exe` or `signtool.exe` command line.

### Option B: Cloud HSM / CA signing tool (EV or non-exportable cloud key)

ADR-0055 section 4 notes that Azure Artifact Signing does not list Vietnam, so Vietnamese organizations typically use an OV or EV certificate from a CA (Sectigo, DigiCert, GlobalSign, SSL.com). Most CAs store the private key in a cloud HSM or KSP.

Set **one** of the following in the `desktop-release` environment:

1. **KSP / CSP SignTool parameters**:
   - Secret `WINDOWS_SIGN_WITH_PARAMS`: `signtool.exe` flags selecting the key provider and certificate (for example `/csp "DigiCert Signing Manager KSP" /kc <keypair> /f <cert-path>`). Never pass `/p` or a password in `WINDOWS_SIGN_WITH_PARAMS` (the script rejects `/p`).
   - Optional Variable `WINDOWS_SIGNTOOL_PATH`: path to a custom `signtool.exe` if not using the bundled Windows SDK `signtool.exe`.
   - Any CA-specific API credential secrets required by the provider's KSP must be mapped into the `Build and sign Squirrel.Windows installer` step in `desktop-package.yml`.
2. **Custom hook module**:
   - Secret `WINDOWS_SIGN_HOOK_MODULE_PATH`: path to a `.js`, `.mjs`, or `.cjs` module exporting a signing function `(fileToSign) => Promise<void>` for CA CLIs such as `CodeSignTool` or `smctl`.

### Timestamp server (both options)

- Optional Variable `WINDOWS_TIMESTAMP_SERVER` in `desktop-release`: defaults to `http://timestamp.digicert.com`.
- Both `@electron/packager` (`@electron/windows-sign`) and Squirrel (`signtool.exe`) sign with SHA-256 (`/fd sha256`) and attach an RFC 3161 SHA-256 timestamp (`/tr <server> /td sha256`).
- **Fail closed:** if the timestamp server is unreachable or does not attach a `TimeStamperCertificate`, `package.mjs --sign` rejects the build so untimestamped binaries are never shipped.
- Record the certificate subject, issuer, serial/thumbprint, expiry date (around 460 days since 2026-03-01), and renewal owner in the renewal calendar.

## Step 3. Run dry-run check first (no secrets)

Before touching secrets or tagging a release, verify packaging and manifest generation on `main`:

1. Trigger `desktop-package.yml` manually on `main` with `mode=dry-run` and `version=0.1.0` (matches `apps/desktop/package.json`).
2. Confirm the `build-dry-run` job passes typecheck, unit tests, Win32 native build, and produces `LudyDesktop-Setup.exe`, `RELEASES`, `*-full.nupkg`, `release-manifest.json` (`signed: false`), and `SHA256SUMS.txt`.

## Step 4. Cut and verify a signed release (owner-approved run)

1. Bump `"version"` in `apps/desktop/package.json` on `main` via a merged PR and confirm `Lint, typecheck, test`, `Windows build (unsigned), tests, size and memory`, and `Windows install smoke` are green on that commit (if the tagged commit did not change path-filtered desktop inputs, trigger the `desktop-build` workflow manually on that commit before running `desktop-package.yml`).
2. Create and push tag `desktop-vX.Y.Z` on that commit of `main`, then trigger **desktop-package** (`desktop-package.yml`) via **Run workflow** on branch `main` with `mode=signed` and `tag=desktop-vX.Y.Z`. (`desktop-package.yml` runs strictly on `refs/heads/main`, verifies the tag points to an ancestor of `origin/main` matching `apps/desktop/package.json`, confirms green CI check-runs on that commit, and re-verifies the live tag commit SHA before creating the draft release.)
3. Approve the pending `desktop-release` environment gate in GitHub Actions.
4. Confirm `build-signed` passes all checks:
   - `package.mjs --sign` verifies `Get-AuthenticodeSignature` (`Status: Valid`, matching signer thumbprint, attached RFC 3161 timestamp), CMS `SignedCms` SHA-256 digest + RFC 3161 OID (`1.3.6.1.4.1.311.3.3.1`), and `signtool verify /pa /v` (`Hash of file (sha256)`) across `LudyDesktop-Setup.exe`, `ludy-desktop.exe`, `ludy-wasapi-loopback.exe`, unpacked `.nupkg` binaries including `Squirrel.exe` (`Update.exe`), and the signed `release-manifest.ps1`.
   - `release` re-verifies that `desktop-vX.Y.Z` still points to the validated commit SHA, verifies `sha256sum --check SHA256SUMS.txt`, and creates a **draft** GitHub release (`--draft --latest=false`) containing `LudyDesktop-Setup.exe`, `RELEASES`, `*-full.nupkg`, `release-manifest.json` (`signed: true`), `release-manifest.ps1`, and `SHA256SUMS.txt`.
5. Download the draft artifacts to a clean Windows machine and complete the signed verification checklist in [windows-smoke.md](windows-smoke.md) (SmartScreen publisher display, `Get-AuthenticodeSignature`, and A-to-B update).

## Step 5. Host the HTTPS update feed and publish

1. Choose a static HTTPS origin controlled by the deployment (for example `https://updates.example.vn/ludy-desktop/win32-x64` or under the Ludy deployment domain). HTTPS is mandatory; the Electron shell rejects plain `http://` feeds outside literal loopback test hosts, blocks private/reserved SSRF IPs (using DNS-pinned sockets), blocks HTML/redirects, and refuses cross-origin or HTTP download URLs inside `RELEASES`.
2. Upload **all** feed files together atomically (upload `.nupkg` files before updating `RELEASES`, `release-manifest.json`, and `release-manifest.ps1` so clients never see a half-published manifest):
   - `LudyDesktop-X.Y.Z-full.nupkg` (and `*-delta.nupkg` if kept)
   - `RELEASES`
   - `release-manifest.json`
   - `release-manifest.ps1` (Authenticode-signed integrity script binding the whole `.nupkg` SHA-256)
   - `SHA256SUMS.txt`
3. Why manifest and payload verification is mandatory on HTTPS feeds: before handing an update to Squirrel.Windows, `apps/desktop/src/update-feed.ts` and `apps/desktop/src/authenticode.ts` verify `release-manifest.ps1` against the trusted publisher thumbprint (from `LUDY_DESKTOP_UPDATE_PUBLISHER_SHA1` or the running signed `ludy-desktop.exe`), download the `.nupkg` once over a DNS-pinned non-redirecting fetch, verify streaming SHA-1 and SHA-256 checksums (covering `app.asar`, DLLs, and all bundle assets), and run Windows Authenticode + RFC 3161 + SHA-256 checks on the extracted `.exe` binaries (`ludy-desktop.exe`, `Squirrel.exe`, `ludy-wasapi-loopback.exe`), serving only the locally staged verified package to Squirrel. Missing `release-manifest.json`, missing/invalid `release-manifest.ps1`, `signed: false`, checksum mismatch, or invalid Authenticode fails closed and leaves the running app untouched.
4. Configure clients (managed machines or [install.vi.md](install.vi.md) / [install.md](install.md)):
   - `LUDY_DESKTOP_UPDATE_URL=https://updates.example.vn/ludy-desktop/win32-x64` (or `updateUrl` in `%APPDATA%\ludy-desktop\config.json`).
   - Optional pinning: `LUDY_DESKTOP_UPDATE_ORIGIN` (pins the feed origin) and `LUDY_DESKTOP_UPDATE_PUBLISHER_SHA1` (40-hex certificate SHA-1 thumbprint pin).
5. Publish the draft GitHub release (or update the download page) with the verified `SHA256SUMS.txt` digest and current version number.

Stop if the feed returns 404/HTML for `RELEASES` or `release-manifest.json`, if `sha256sum --check SHA256SUMS.txt` fails, or if `Get-AuthenticodeSignature` is not `Valid`.

## Rollback and revocation

### Roll back a bad desktop release

1. **Immediate halt:**
   - **Block future downloads:** remove `RELEASES`, `release-manifest.json`, and `release-manifest.ps1` from the HTTPS feed host (or atomically restore the previous known-good version's `RELEASES`, `release-manifest.json`, `release-manifest.ps1`, `SHA256SUMS.txt`, and `.nupkg` files together so `release-manifest.ps1` always matches `release-manifest.json`). Clients still on the previous version stop seeing an update.
   - **Clients where the bad update is already marked ready (`Khởi động lại để cập nhật`):** removing or restoring hosted feed metadata does **not** withdraw an update that Squirrel has already downloaded and unpacked locally. Instruct affected members **not** to click **Khởi động lại để cập nhật** and either leave the previous running version open until the forward fix (`0.1.3` below) is published or run a verified clean reinstall of the previous signed installer from the release page.
2. **Forward fix:** Squirrel.Windows only upgrades forward in semver (`X.Y.Z`). To roll members back from `0.1.2` to `0.1.1` automatically, rebuild and sign the fixed source as `0.1.3`, verify it, and publish `0.1.3` to the feed.
3. Unpublish or mark the bad GitHub release as superseded so new downloads do not pick it up.

### Revoke a compromised certificate or feed

1. Contact the CA immediately to revoke the compromised code-signing certificate.
2. Disable the update feed immediately by removing `RELEASES` and `release-manifest.json` on the HTTPS host.
3. Rotate credentials in the `desktop-release` GitHub environment and remove the old secrets.
4. Issue a new certificate, update `desktop-release` secrets, cut a new signed version `desktop-vX.Y.Z`, and publish both the installer and feed.
5. **Client trust recovery across certificate changes:** both explicitly pinned machines (`LUDY_DESKTOP_UPDATE_PUBLISHER_SHA1` / `updatePublisherThumbprint`) and default machines (which implicitly pin the running `ludy-desktop.exe` Authenticode thumbprint via `resolveTrustedThumbprint`) reject updates signed by a different certificate and cannot verify the revoked old binary. For both groups, transfer trust out of band by updating `LUDY_DESKTOP_UPDATE_PUBLISHER_SHA1` if configured and reinstalling `LudyDesktop-Setup.exe` from the newly signed verified installer before expecting automatic HTTPS updates to resume.
6. If host or user credentials may have been exposed, instruct members or admins to revoke desktop devices under **Cài đặt -> Thiết bị đã kết nối**.
