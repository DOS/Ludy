# Runbook: signing, update hosting and publishing Ludy Desktop

**Status: written, nothing run.** Slice 2 of [ADR-0055](../adr/0055-three-capture-paths-one-meeting.md) ships unsigned development builds only (the `desktop-build` workflow). Everything below is an owner action: accounts, payments, secrets. No worker or team lead runs a step; per [AGENTS.md](../../AGENTS.md) the coordinator runs exactly the step list the owner approved in its chat, one approval per run, and stops at the first failure. Owner decision 7 of ADR-0055: do not buy signing accounts or certificates until the shell (slice 2) is approved.

## What exists and what does not

| Thing | State |
|---|---|
| Unsigned Squirrel.Windows installer, `.nupkg` and `RELEASES` as a CI artifact (7 days) | Built by `.github/workflows/desktop-build.yml` on every change of `apps/desktop` |
| Windows code-signing certificate | Does not exist |
| A hosted update feed | Does not exist; the shell reads `LUDY_DESKTOP_UPDATE_URL` and is off without it |
| Release publishing (a tag, a GitHub release, a download page) | Does not exist |
| macOS build, Apple account, notarization | Out of scope until the capture slice for macOS |

## Step 1. Decide where the signed build is made (owner)

Signing needs a secret (a certificate, or a cloud-signing credential), so it is a **separate, protected workflow** to be reviewed as a security change, never a secret added to `desktop-build.yml`. Record the choice in the issue that tracks it: a new workflow `desktop-release.yml` that runs only on a tag `desktop-vX.Y.Z` of a commit on `main`, with the signing secret held in a GitHub environment that needs approval.

## Step 2. A Windows certificate (owner: account, payment, identity checks)

ADR-0055 section 4 records the findings of 2026-11-19: Azure Artifact Signing does not list Vietnam among the countries open to organizations, so a Vietnamese company will most likely need a certificate from a certificate authority.

1. The owner picks the certificate authority and the type (EV or OV; EV or an HSM or cloud-HSM key, since certificate authorities no longer issue plain downloadable keys for code signing).
2. The owner buys it with the company's details and completes the identity validation (days to weeks).
3. The private key never enters the repository, a chat or a log. It stays in the authority's cloud HSM or a hardware token; CI reaches it through the authority's signing service with a credential held in the protected GitHub environment of step 1.
4. Record the certificate's name, expiry date and the person who renews it (validity is about 460 days since 2026-03-01) in the owner's list of renewals.

Stop if the identity validation is refused or asks for documents: ask the owner.

## Step 3. Sign in CI (after step 2; a code change, reviewed as protected)

1. `electron-winstaller` accepts signing options (`windowsSign`) for the installer, the Setup.exe and the nupkg's `ludy-desktop.exe`; `@electron/packager` can sign the app's executable with `windowsSign` as well. Both call `@electron/windows-sign`.
2. The release workflow passes the signing credential only to that step, as an environment secret, never printed.
3. Verify on a clean Windows machine: `Get-AuthenticodeSignature` reports `Valid` on `LudyDesktop-Setup.exe` and on `ludy-desktop.exe` inside the installed folder, and SmartScreen shows the publisher's name (reputation may still take time to build even with a valid signature; the sources disagree on whether an EV certificate gives it at once).

## Step 4. Host the update feed (owner: server or bucket, DNS, spending)

1. Pick a static host the deployment controls (a bucket behind the deployment's own domain, or the same host that serves Ludy). The feed is a folder holding `RELEASES` and every `*-full.nupkg` (and `*-delta.nupkg` if deltas are kept). https only.
2. Upload the signed release files after each signed build. The update's integrity rests on the signature of the executable Squirrel installs plus https on the feed: an unsigned production feed would let anyone who controls the feed's host run code on members' machines, so the feed is not switched on for members before step 3 is done.
3. Give each deployment its address: the member's `LUDY_DESKTOP_UPDATE_URL` (see [install.md](install.md)). A hosted-Ludy operator sets it for the machines it manages.
4. Check: install the previous signed build, publish the next one to the feed, and see the tray offer "Khởi động lại để cập nhật".

Stop if the feed answers 404 for `RELEASES` or the signature does not verify: do not point members at it.

## Step 5. Publish (owner)

1. Tag the release commit `desktop-vX.Y.Z` (the `apps/desktop/package.json` version is bumped first).
2. Download the signed installer from the release workflow, check its SHA-256, and attach it to a GitHub release or put it on the page members download from.
3. Say plainly on that page which version is current and that the first install of an unsigned build is no longer needed.

## Revoking a leaked certificate or feed

Contact the certificate authority to revoke, stop the update feed (remove `RELEASES`), publish a new build signed with a new certificate, and revoke the affected devices in "thiết bị đã kết nối" if a token may be exposed.
