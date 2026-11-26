# Runbook: macOS Developer ID signing, Apple notarization, and publishing Ludy Desktop

**Status: CI wiring and code ready; live signing, notarization, and publishing run only on owner approval.** Per [AGENTS.md](../../AGENTS.md), no worker or team lead executes Production or credential steps. The coordinator runs the exact approved step list and stops at the first failure. Windows signing lives in [signing-runbook.md](signing-runbook.md).

## What is built vs what requires owner approval

| Component | State | Notes |
|---|---|---|
| Unsigned macOS CI build (`arm64` and `x64`) | Automated | [.github/workflows/desktop-build.yml](../../.github/workflows/desktop-build.yml) (`macos-latest`, zero secrets) |
| Signed + notarized macOS build script and verifier | Ready in repo | `apps/desktop/scripts/package-mac.mjs --sign` + `apps/desktop/scripts/macos-signing.mjs` + `apps/desktop/src/codesign.ts` |
| Minimal Hardened Runtime entitlements | Ready in repo | `apps/desktop/entitlements/darwin.plist` (`allow-jit`, `device.audio-input`) and `darwin-helper.plist` (`allow-jit`) |
| Release workflow (dry-run and secret-gated signed release) | Ready in repo | [.github/workflows/desktop-package.yml](../../.github/workflows/desktop-package.yml) (`workflow_dispatch` on `main`) |
| Update feed manifest and shell verification | Ready in repo | `release-manifest.json` + `SHA256SUMS.txt` + `.zip`; HTTPS, DNS-pinned fetch, SSRF, origin pinning, ZIP bounds/symlink checks, `codesign --verify --deep --strict`, Team ID pin, Hardened Runtime, and Gatekeeper (`spctl`) checks in `apps/desktop/src/update-feed.ts` and `apps/desktop/src/codesign.ts` |
| Apple Developer ID certificate and notarization secrets in `desktop-release` | Owner action | Never store `.p12`, `.p8`, passwords, or private keys in the repository |
| Hosted HTTPS update feeds and public release | Owner / coordinator action | Static HTTPS host controlled by the deployment (`darwin-arm64/` and `darwin-x64/`) |

## Step 1. Verify the `desktop-release` GitHub environment (owner)

1. Confirm the `desktop-release` GitHub environment exists (shared with Windows signing in [signing-runbook.md](signing-runbook.md)).
2. Keep **Required reviewers** enabled with the owner as reviewer, **Allow administrators to bypass configured protection rules** disabled, and **Deployment branches and tags** restricted to **Selected branches** -> `main` only.
3. Keep `desktop-build.yml` completely secret-free for pull request and `main` checks.

## Step 2. Export Developer ID certificate and add secrets to `desktop-release` (owner)

1. **Export Developer ID Application `.p12`:**
   - In Apple Developer Portal (**Certificates, Identifiers & Profiles**), confirm a valid **Developer ID Application** certificate exists for your Team ID (note: Apple Developer ID certificates are valid for 5 years; never share the private key outside Keychain Access and CI secrets).
   - On the owner's Mac, open **Keychain Access -> My Certificates**, select the **Developer ID Application: <Organization> (<TEAMID>)** entry (expand to verify the private key is attached underneath), right-click -> **Export...**, save as `.p12` protected by a strong passphrase, and base64-encode to a single line (`base64 -i DeveloperID.p12 | tr -d '\n'`). Delete the temporary `.p12` file locally once stored in GitHub Secrets.
2. **Set signing secrets in `desktop-release`:**
   - `APPLE_DEVELOPER_ID_CERT_P12_BASE64`: single-line base64 of the `.p12` bundle.
   - `APPLE_DEVELOPER_ID_CERT_PASSWORD`: passphrase used to export the `.p12`.
   - `APPLE_TEAM_ID`: 10-character uppercase alphanumeric Apple Team ID (for example `A1B2C3D4E5`).
3. **Add notarization secrets in `desktop-release` (choose ONE mode; configuring both or partial fails closed):**
   - **Option A (Recommended): App Store Connect API Key (`.p8`)**
     - In App Store Connect -> **Users and Access -> Integrations -> App Store Connect API**, generate a Team Key with **Developer** (or **App Manager**) role, download the `.p8` file once, and record the **Key ID** and **Issuer ID** (UUID).
     - `APPLE_NOTARY_API_KEY_P8_BASE64`: single-line base64 of the `.p8` key (`base64 -i AuthKey_XXXXXXXXXX.p8 | tr -d '\n'`).
     - `APPLE_NOTARY_API_KEY_ID`: 8-20 uppercase alphanumeric Key ID.
     - `APPLE_NOTARY_API_ISSUER_ID`: UUID Issuer ID.
   - **Option B: Apple ID + App-Specific Password**
     - `APPLE_ID`: Apple Developer account email address.
     - `APPLE_APP_SPECIFIC_PASSWORD`: App-Specific Password generated at `account.apple.com` (Sign-In and Security -> App-Specific Passwords).

How CI handles credentials safely: `desktop-package.yml` decodes the `.p12` (and `.p8` if Option A) into `0600` files inside `$RUNNER_TEMP`, creates a fresh per-run ephemeral Keychain via `security -i` (never passing passwords on CLI `argv` and refusing to clobber pre-existing keychains), sets `set-key-partition-list`, strips passwords from `process.env` before running `@electron/packager` / `codesign`, notarizes via `xcrun notarytool` without CLI password flags (using `--key` path for Option A or an ephemeral Keychain profile via PTY `store-credentials` for Option B), staples both `Ludy Desktop.app` and the `.dmg`, and removes the ephemeral Keychain and temp secret files in both `package-mac.mjs` `finally` and an `if: always()` CI step (failing closed if cleanup fails).

## Step 3. Run dry-run check first (no secrets)

1. Trigger **desktop-package** (`desktop-package.yml`) manually on `main` with `mode=dry-run`, `platform=macos` (or `all`), and `version=0.1.0` (matching `apps/desktop/package.json`).
2. Confirm `build-mac-dry-run` passes typecheck, unit tests, and outputs `LudyDesktop-0.1.0-darwin-arm64.dmg`, `LudyDesktop-0.1.0-darwin-arm64.zip`, `LudyDesktop-0.1.0-darwin-x64.dmg`, `LudyDesktop-0.1.0-darwin-x64.zip`, `release-manifest.json` (`signed: false`), and `SHA256SUMS.txt`.

## Step 4. Cut and verify a signed and notarized macOS release (owner-approved run)

1. Bump `"version"` in `apps/desktop/package.json` on `main` via a merged PR and confirm `Lint, typecheck, unit tests`, `Windows build (unsigned)`, `Windows install smoke`, and `macOS build (unsigned, arm64 & x64), tests and size` are green on that commit (if the commit did not touch desktop path triggers, run `desktop-build.yml` manually on that commit first).
2. Create and push tag `desktop-vX.Y.Z` on that `main` commit, then trigger **desktop-package** (`desktop-package.yml`) on `main` with `mode=signed`, `platform=all` (or `macos`), and `tag=desktop-vX.Y.Z`.
3. Approve the pending `desktop-release` environment gate in GitHub Actions.
4. Confirm `build-mac-signed` passes every check:
   - `codesign --verify --deep --strict --verbose=2` and `codesign --display --verbose=4` confirm `Identifier=vn.ludy.desktop`, `TeamIdentifier=<APPLE_TEAM_ID>`, Hardened Runtime (`runtime`), SHA-256 CodeDirectory, `Developer ID Application:` chain, and Apple timestamp.
   - `xcrun notarytool submit --wait` returns `status: Accepted` for both the `.app` archive and `.dmg` on both `arm64` and `x64`.
   - `xcrun stapler validate` and `spctl -a -t exec -vv` / `spctl -a -t open --context context:primary-signature -vv` report `accepted` (`source=Notarized Developer ID`).
   - Ephemeral Keychain and temp credential files are deleted and verified absent.
   - `release` verifies `SHA256SUMS.txt`, re-verifies that `desktop-vX.Y.Z` still points to the validated commit SHA, and creates a **draft** GitHub Release (`--draft --latest=false`).

## Step 5. Clean-Mac Gatekeeper and A-to-B update check

Before publishing the draft release or pointing users to a new macOS release:

1. Download the `.dmg` matching the test Mac's CPU (`arm64` for Apple Silicon, `x64` for Intel) and `SHA256SUMS-darwin-<arch>.txt` from the draft release on a clean Mac that does NOT have the Developer ID private key installed.
2. Verify checksum, signature, and Gatekeeper:
   ```bash
   shasum -a 256 -c SHA256SUMS-darwin-arm64.txt
   spctl -a -t open --context context:primary-signature -vv LudyDesktop-X.Y.Z-darwin-arm64.dmg
   ```
3. Open the `.dmg`, drag `Ludy Desktop.app` to `/Applications`, and launch it. Confirm macOS opens it with zero "unidentified developer" or "damaged app" warnings and verify:
   ```bash
   codesign --verify --deep --strict --verbose=2 "/Applications/Ludy Desktop.app"
   spctl -a -t exec -vv "/Applications/Ludy Desktop.app"
   ```
4. Configure `LUDY_URL` and `LUDY_DESKTOP_UPDATE_URL` (and optionally `LUDY_DESKTOP_UPDATE_TEAM_ID`), sign in via the browser PKCE flow, quit and reopen to confirm Keychain persistence (`safeStorage`), and test an A-to-B update over the staging HTTPS feed.

## Step 6. Host the macOS HTTPS update feeds and publish

1. Choose static HTTPS paths under an origin controlled by the deployment, one per CPU architecture:
   - Apple Silicon: `https://updates.example.vn/ludy-desktop/darwin-arm64`
   - Intel Mac: `https://updates.example.vn/ludy-desktop/darwin-x64`
   HTTPS is mandatory (private/SSRF IPs, HTML, redirects, and cross-origin paths are blocked by `apps/desktop/src/update-feed.ts`).
2. Inside each arch directory, upload the `.zip` and `.dmg` **before** updating `release-manifest.json` (and `SHA256SUMS.txt`) so clients never fetch a manifest before its archive is live:
   - `LudyDesktop-X.Y.Z-darwin-<arch>.zip` (from `darwin-<arch>/`)
   - `LudyDesktop-X.Y.Z-darwin-<arch>.dmg` (optional on feed host, keeps archive complete)
   - `release-manifest.json` (note: rename `release-manifest-darwin-<arch>.json` back to `release-manifest.json` if copying from GitHub Release assets, or upload directly from the `ludy-desktop-signed-darwin` workflow artifact)
   - `SHA256SUMS.txt`
3. How macOS client update verification works: `apps/desktop/src/update-feed.ts` and `apps/desktop/src/codesign.ts` fetch `release-manifest.json` over DNS-pinned non-redirecting HTTPS, verify `platform: "darwin"`, `arch`, `signed: true`, `hardenedRuntime: true`, `notarized: true`, `bundleId: "vn.ludy.desktop"`, and matching `teamId` (pinned via `LUDY_DESKTOP_UPDATE_TEAM_ID` or extracted from the running signed `Ludy Desktop.app`), download the `.zip` once, verify streaming SHA-256 + byte size, inspect ZIP central directory bounds/paths, extract with `ditto` into an isolated temp directory, reject escaping symlinks, run `codesign --verify --deep --strict`, `codesign --display` (Team ID + Hardened Runtime + SHA-256 + timestamp), and `spctl -a -t exec -vv`, and only then serve the verified `.zip` to Squirrel.Mac over `127.0.0.1`.
4. Publish the draft GitHub release with the verified checksums.

Stop if `shasum -a 256 -c` fails, `xcrun stapler validate` fails, or `spctl` does not report `Notarized Developer ID`.

## Certificate rotation and rollback

### Roll back a bad macOS release

1. **Immediate halt:** remove `release-manifest.json` from `darwin-arm64/` and `darwin-x64/` on the HTTPS feed host (or atomically restore the prior good version's `.zip`, `release-manifest.json`, and `SHA256SUMS.txt` together). Clients still on the previous version stop seeing an update.
2. **Clients already showing `Khởi động lại để cập nhật`:** tell affected members not to restart into the ready update and reinstall the prior signed `.dmg` from the release page if needed.
3. **Forward fix:** Squirrel.Mac upgrades forward in semver (`X.Y.Z`). Rebuild, sign, and notarize the fixed code as the next higher patch version (`X.Y.(Z+1)`), verify on a clean Mac, and publish.
4. Mark the bad GitHub release superseded or remove it.

### Rotate or revoke a compromised certificate or notarization key

1. Revoke the compromised Developer ID Application certificate in Apple Developer Portal (note: revoking a Developer ID certificate invalidates signatures created with it for Gatekeeper/notarization checks once Apple OCSP updates) or revoke the compromised App Store Connect API Key / App-Specific Password immediately.
2. Remove `release-manifest.json` from the macOS HTTPS feed hosts immediately.
3. Rotate the secrets in `desktop-release` (`APPLE_DEVELOPER_ID_CERT_P12_BASE64`, `APPLE_DEVELOPER_ID_CERT_PASSWORD`, `APPLE_NOTARY_API_KEY_*` or `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` if moving teams).
4. Cut a new signed and notarized `desktop-vX.Y.Z` release. If `APPLE_TEAM_ID` stayed the same, existing healthy clients can update forward once the new certificate is trusted; if `APPLE_TEAM_ID` changed, existing clients pin the old Team ID and reject updates from the new team, so distribute the new `.dmg` out of band and update `LUDY_DESKTOP_UPDATE_TEAM_ID` if set.
5. If user tokens may have been exposed, revoke affected desktop devices under **Cài đặt -> Thiết bị đã kết nối**.
