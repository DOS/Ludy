<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Runbook: turn on Ludy eSign (`sign`) on the pilot

Issue #3531. Enables the `sign` module (`Ludy eSign` / `Ký kết`) alongside the pilot's existing modules (`finance,crm,social`) through the opt-in CI deploy environment variables (`DEPLOY_MODULES_ENVIRONMENT` and `DEPLOY_CROVE_MODULES`) documented in [deploy.md](deploy.md#module-settings-in-the-deploy-3531). No manual SSH session on the pilot host is needed.

This runbook is a Production environment configuration step ([contributing.md](../contributing.md#production-secret-and-credential-steps)): run it only after the owner approves this step list in the running Product Owner chat.

Public repository rule: no secret, token, internal host, IP address or customer data belongs in this file, an issue, a PR or chat.

## Who does what

- **[OWNER]** approves the Production change in the PO chat and sets (or approves setting) the GitHub environment variables in `Settings -> Environments -> pilot`, then verifies the UI after deploy.
- **[OPERATOR]** (or the coordinator/PO with owner approval) verifies prerequisites, triggers or tags the release, and checks the deploy log and endpoints.
- **[CHECK]** must hold before moving to the next step. If any check fails, stop and follow [Roll back](#3-roll-back).

## What changes

- `CROVE_MODULES` on the pilot host updates from `finance,crm,social` to `finance,crm,social,sign` for the `api`, `worker` and `prober` services.
- The `api` and `worker` enable Ludy eSign (`sign`) routes, commands, jobs and app-switcher entry (`Ký kết` / `eSign`), with per-org enablement controlled under Settings.
- Public signing uses fragment URLs (`/-/sign#<token>`) with `Referrer-Policy: no-referrer`, single-use token consumption, optional email OTP, and SHA-256 PDF sealing. No external CA credentials or CAPTCHA accounts are required in Slice 1.
- The database schema does not change for module toggling: `crove_sign` migrations already apply on every deploy regardless of `CROVE_MODULES`. Turning `sign` off leaves `crove_sign` data intact.

## 0. Prerequisites

1. **[CHECK]** Confirm the target release on `main` includes Ludy eSign (`sign`) and the `#3531` deploy workflow changes (`DEPLOY_MODULES_ENVIRONMENT` / `DEPLOY_CROVE_MODULES` support in `.github/workflows/deploy.yml` and `tools/deploy/deploy.sh`).
2. **[CHECK]** Inspect the currently serving version and modules before changing anything:

   ```bash
   curl -s <PUBLIC_URL>/version
   curl -s <PUBLIC_URL>/api/config
   ```

   Verify `/version` reports the expected `build` commit SHA with `"migrationsMissing":[]`, and `/api/config` currently lists the expected modules (for example `["crm","finance","kernel","social"]`).
3. **[CHECK]** Confirm the latest sealed backup exists ([backup-and-restore.md](backup-and-restore.md)) and `crove-extract` is running as part of the pilot stack (required for PDF parsing during envelope creation).
4. **[CHECK]** Confirm the `pilot` GitHub environment has the deploy secrets (`DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`) and `DEPLOY_PUBLIC_URL` configured ([deploy.md](deploy.md#settings-of-each-github-environment)).

## 1. Set environment variables and deploy

1. **[OWNER]** In GitHub repository `Settings -> Environments -> pilot` (define these in the `pilot` environment **only**, never at repository or organization level):
   - Add or update variable `DEPLOY_MODULES_ENVIRONMENT` = `pilot`
   - Add or update variable `DEPLOY_CROVE_MODULES` = `finance,crm,social,sign`
2. **[OPERATOR]** Trigger the `deploy` workflow on a `v*` tag whose commit is on `main`:
   - Either tag a new release on `main` (`v*`), or open Actions -> `deploy` -> `Run workflow` from the existing release tag `v*` (`environment: pilot`, `action: deploy`).
3. **[CHECK]** Watch the `Deploy to pilot` job in GitHub Actions:
   - `Prepare the module settings` succeeds (`Modules given: finance,crm,social,sign`).
   - `Deploy, or roll back, on the host` logs:
     - `module settings written to ...: CROVE_MODULES=finance,crm,social,sign`
     - `smoke ok: /api/config lists the expected modules`
   - `Smoke test through the public URL` succeeds with `SMOKE_EXPECT_MODULES=finance,crm,social,sign` (`smoke ok: /api/config lists the expected modules`).
   - `Summary` notes `- module settings: updated for CROVE_MODULES=finance,crm,social,sign (when changed; see host log)`.

## 2. Verify

1. **[CHECK]** Confirm the public `/version`, `/readyz`, and `/api/config` endpoints after the deploy finishes:

   ```bash
   curl -s <PUBLIC_URL>/version
   curl -s <PUBLIC_URL>/readyz
   curl -s <PUBLIC_URL>/api/config
   ```

   - `/version` returns the deployed `build` SHA and `"migrationsMissing":[]`.
   - `/readyz` returns `{"ready":true}`.
   - `/api/config`'s `"modules"` array contains `"kernel"`, `"finance"`, `"crm"`, `"social"` and `"sign"`.
2. **[OWNER]** Sign in at `<APP_URL>`:
   - Confirm `Ký kết` (`eSign`) appears in the app switcher (and can be enabled/disabled per org in org app settings).
   - Smoke-test creating a draft envelope with a sample PDF, placing a signature field, and verifying the document preview loads without error.

## 3. Roll back

### Automatic rollback during deploy

If compose validation fails, the worker or API fails to start or reach `/readyz`, or either the loopback smoke test or the public smoke test fails (`/api/config` does not match `{kernel, finance, crm, social, sign}`), `deploy.sh` automatically restores the dated pre-deploy `.env` copy (`CROVE_MODULES=finance,crm,social`) and rolls back to the previous release.

### Manual rollback after a good deploy

To turn `sign` off again after a successful deploy:

- **Option A (recommended, forward sync):** Update `DEPLOY_CROVE_MODULES` in the `pilot` GitHub environment back to `finance,crm,social`, then run the `deploy` workflow (`action: deploy`) from the current `v*` tag.
- **Option B (workflow rollback to the previous release):** Remove `DEPLOY_MODULES_ENVIRONMENT` and `DEPLOY_CROVE_MODULES` from the `pilot` environment, then run the `deploy` workflow from `main` with `environment: pilot` and `action: rollback`. Note that `deploy.sh rollback` restores the pre-deploy `.env` backup only when the release that wrote `CROVE_MODULES` is still the current release and `.env` has not been edited manually on the host since that deploy.

Data safety: existing envelopes, signers, and sealed documents stay in `crove_sign` if `sign` is disabled and remain accessible when `sign` is enabled again.
