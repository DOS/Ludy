<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Runbook: Phase 3 Production cutover on the pilot (`#3972`)

Parent: [#1682](https://github.com/DOS/Ludy/issues/1682), Step S8: [#3972](https://github.com/DOS/Ludy/issues/3972), [ADR-0054](../adr/0054-rebrand-internal-crove-identifiers-to-ludy.md), [brand-phase3-identifiers.md](../plan/brand-phase3-identifiers.md).

This runbook cuts the live pilot deployment over from legacy `crove_*` / `CROVE_*` infrastructure identifiers to `ludy_*` / `LUDY_*` safely and reversibly **before** the final codebase shim contraction PR removes temporary compatibility fallbacks (`CROVE_*` env vars, `x-crove-*` headers, `crove-auth` JWT issuer fallback, `crove` / `crove-extract` / `crove-media` service names, and `crove_*` database role aliases).

This runbook covers Production, secret, and credential steps ([contributing.md](../contributing.md#production-secret-and-credential-steps)): run each stage only after the owner (JOY) explicitly approves the concrete step list in the running Product Owner or coordinator chat, one approval per run, stopping on the first failed check.

Public repository rule: never put secrets, passwords, API tokens, Supabase project refs, internal hostnames, IP addresses, bucket URLs, or customer data in this file, an issue, a PR, or chat. Reference every secret by its secret-store key name only.

## Who does what

- **[OWNER]** approves the concrete cutover plan in chat, creates or confirms release tags when needed, edits GitHub `pilot` environment variables, updates the Cloudflare Email Worker and S3 bucket policy/lifecycle rules in the provider consoles (or via admin credentials), and performs the final UI verification.
- **[OPERATOR]** (or the coordinator running owner-approved host steps) runs host pre-flight checks, takes backups, syncs host Compose/Caddy/WAL files, updates `.env`, switches pgBackRest `WAL_STANZA`, and verifies database/runtime health.
- **[CHECK]** must pass before advancing to the next stage. If any check fails, stop immediately and execute that stage's **Rollback**.

## Host paths

Per [provision-pilot.md](provision-pilot.md), the pilot server uses two separate directories:

- `<DEPLOY_DIR>` (initially `/opt/crove`): the live Compose stack directory containing `.env`, `docker-compose.yml`, `compose.pilot.yml`, `docker-compose.override.yml`, `Caddyfile`, `compose.host.yml`, `compose.wal.yml`, and `.deploy/`. It does **not** hold `tools/backup/`.
- `<SRC_DIR>` (initially `/opt/crove-src`): the repository checkout containing `tools/backup/`, `tools/deploy/caddy/`, and `tools/wal/`.

Always pass `LUDY_DIR=<DEPLOY_DIR> CROVE_DIR=<DEPLOY_DIR>` when running `<SRC_DIR>/tools/backup/{backup,wal}.sh` so `lib.sh` loads `<DEPLOY_DIR>/.env` and executes `docker compose` inside `<DEPLOY_DIR>` both before and after `#3970`.

## Immutability guarantee (what never changes here)

Per [ADR-0054](../adr/0054-rebrand-internal-crove-identifiers-to-ludy.md) section 2, existing data-at-rest cryptography and history stay intact and readable forever:

- Subject sealing legacy decoders and AAD constants (`crove:s1:`, `CROVE_SIGN_SIGNER_PLACE`, and sibling `*_PLACE` AAD constants; new writes may transition to `ludy:s1:` while `crove:s1:` remains decoded), input/export/archive/backup format tags (`crove.input.v1`, `crove.org-export.v2`, `crove-archive`, `CRB1`, `crove.backup.v1|...`), `crove_sign.playbook_rule:` hash domain, and WORM S3 object keys under `org/<org_id>/<sha256>`.
- Historical SQL migrations on `main` (`*_crove_*.sql`) and their ledger checksums in `ludy_meta.schema_migrations`.
- Existing Docker named volumes (`crove_db-data`, `crove_files`, `crove_caddy-data`, `crove_caddy-config`, `crove_keys`, `crove_archive`, `crove_status`) are migrated cleanly via offline verified volume copies into `ludy_*` (`COMPOSE_PROJECT_NAME=ludy`) by [the pilot cutover workflow](../../.github/workflows/pilot-ludy-cutover.yml) (`tools/deploy/cutover-ludy.sh`), never simply dropped or replaced with blank volumes.

---

## Stage 0: Pre-flight and full pre-cutover backup

Run all checks before changing any release, config, or bucket rule.

1. **[CHECK]** Record the currently running build, readiness, and active modules from outside:

   ```bash
   curl -fsS https://<your domain>/version
   curl -fsS https://<your domain>/readyz
   curl -fsS https://<your domain>/api/config
   ```

   Confirm `/readyz` returns `{"ready":true}` and `/version` reports `"migrationsMissing":[]`.

2. **[OPERATOR]** On the pilot host, save a dated mode-600 copy of `<DEPLOY_DIR>/.env` outside Compose parsing and verify WAL archiving and disk headroom:

   ```bash
   umask 077
   cp -p <DEPLOY_DIR>/.env "/root/env.pre-phase3-$(date -u +%Y%m%dT%H%M%SZ)"
   docker compose --project-directory <DEPLOY_DIR> ps
   LUDY_DIR=<DEPLOY_DIR> CROVE_DIR=<DEPLOY_DIR> <SRC_DIR>/tools/backup/wal.sh check
   LUDY_DIR=<DEPLOY_DIR> CROVE_DIR=<DEPLOY_DIR> <SRC_DIR>/tools/backup/wal.sh info
   df -h
   ```

3. **[OPERATOR]** Take a fresh sealed nightly backup right before cutover so PostgreSQL, roles, and file checksums have a clean restore point (per [backup-and-restore.md](backup-and-restore.md)):

   ```bash
   LUDY_DIR=<DEPLOY_DIR> CROVE_DIR=<DEPLOY_DIR> <SRC_DIR>/tools/backup/backup.sh
   backup_dir="$(sed -n 's/^BACKUP_DIR=//p' <DEPLOY_DIR>/.env | tail -n 1)"
   cat "${backup_dir:-<DEPLOY_DIR>/.data/backups}/last-success"
   ```

   Confirm `backup.sh` prints `done` and `last-success` matches today's UTC run ID.

4. **[OWNER]** Export and keep the current S3 file-bucket lifecycle JSON (using an admin S3 account, never Ludy's restricted runtime key; add `--endpoint-url https://<s3 endpoint>` if not AWS S3):

   ```bash
   aws s3api get-bucket-lifecycle-configuration --bucket <files-bucket> > lifecycle-before.json
   ```

5. **Rollback:** Nothing has changed yet; keep the `.env` copy and `lifecycle-before.json` until cutover finishes cleanly.

---

## Stage 1: Deploy the release carrying `#3971` (9 module schemas -> `ludy_<module>`)

Deploy PR `#4484` (`9f6cfe18b`, `#3971` migrating `crove_finance`, `crove_hr`, `crove_crm`, `crove_social`, `crove_ads`, `crove_notes`, `crove_projects`, `crove_meetings`, `crove_sign` to `ludy_<module>`) and the commit carrying this runbook and `WAL_STANZA` support.

Why a short maintenance window helps ([ADR-0054](../adr/0054-rebrand-internal-crove-identifiers-to-ludy.md) section 3): `20270316140000_ludy_kernel_rebrand_module_schemas.sql` runs `ALTER SCHEMA crove_<module> RENAME TO ludy_<module>` for all 9 modules. While old pre-`#3971` containers run concurrently with or right after `migrate`, they still query `crove_<module>.*`. Stopping `worker` and `api` (plus `prober` if running under `COMPOSE_PROFILES=prober`) right after the CI image build completes limits downtime to roughly 1 to 2 minutes and avoids spurious error alerts during migration.

1. **[CHECK]** Confirm the target commit on `main` (containing both `9f6cfe18b` and the `#3972` cutover-runbook/`WAL_STANZA` commit) has green required CI checks (`Lint, typecheck, test`, `Playwright on docker compose`, `Docs check`). Keep `DEPLOY_MODULES_ENVIRONMENT` and `DEPLOY_IDP_ENVIRONMENT` unchanged during this tag deploy so Stage 1 isolates only the release and schema cutover.
2. **[OWNER]** Create and publish the release tag (`v*`, e.g. `v0.3.10`) on `main` (`https://github.com/DOS/Ludy/releases/new?tag=vX.Y.Z&target=main&title=vX.Y.Z`), and wait for `.github/workflows/deploy.yml` job `Build and push the images` to finish pushing digests to GHCR.
3. **[OPERATOR]** Once `Build and push the images` finishes (right before approving `Deploy to pilot` in GitHub Actions), stop the app containers during the short maintenance window and temporarily move `<DEPLOY_DIR>/.deploy/current` and `.deploy/previous` aside so neither `deploy.sh` `recover` nor `deploy.yml`'s `public-smoke` failure hook can automatically downgrade containers back to a pre-`#3971` release after `20270316140000` commits:

   ```bash
   cd <DEPLOY_DIR>
   docker compose stop api worker
   docker compose stop prober || true
   umask 077
   mkdir -p /root/deploy-state.pre-phase3
   if [ -f .deploy/current ]; then mv .deploy/current /root/deploy-state.pre-phase3/current; fi
   if [ -f .deploy/previous ]; then mv .deploy/previous /root/deploy-state.pre-phase3/previous; fi
   ```

4. **[OWNER]** Approve the `Deploy to pilot` job in GitHub Actions (when `Required reviewers` is enabled on `pilot`). `deploy.sh` pulls images by digest, runs `migrate`, runs `auth-grants`, starts `worker`, `api`, and `prober` (if in `COMPOSE_PROFILES`), and runs loopback + public smoke tests. (Because `.deploy/current` and `.deploy/previous` were moved aside, a post-migration container or public-smoke failure stops cleanly without reactivating incompatible pre-`#3971` containers; diagnose and fix forward with a patch release on `main`.)
5. **[CHECK]** After `Deploy to pilot` turns green, verify health, version, and all 12 PostgreSQL schemas (leave `.deploy/previous` unset so future rollbacks stay post-`#3971`, and remove `/root/deploy-state.pre-phase3` only after Stage 1 passes):

   ```bash
   curl -fsS https://<your domain>/version
   curl -fsS https://<your domain>/readyz
   curl -fsS https://<your domain>/api/config
   ```

   On the pilot host:

   ```bash
   cd <DEPLOY_DIR>
   docker compose exec -T db psql -U postgres -d postgres -Atc \
     "SELECT nspname FROM pg_namespace WHERE nspname ~ '^(crove|ludy)_' ORDER BY 1;"
   docker compose exec -T db psql -U postgres -d postgres -Atc \
     "SELECT count(*) FROM ludy_meta.schema_migrations WHERE version = '20270316140000';"
   rm -rf /root/deploy-state.pre-phase3
   ```

   Expected output: exactly the 12 `ludy_*` schemas (`ludy_ads`, `ludy_crm`, `ludy_finance`, `ludy_hr`, `ludy_jobs`, `ludy_kernel`, `ludy_meetings`, `ludy_meta`, `ludy_notes`, `ludy_projects`, `ludy_sign`, `ludy_social`), **zero** `crove_*` schemas, and migration count `1`.

6. **Rollback:**
   - **Only if `20270316140000` did NOT commit** (`ludy_meta.schema_migrations` count for `'20270316140000'` is `0` and `crove_*` schemas are intact): move `/root/deploy-state.pre-phase3/current` into `<DEPLOY_DIR>/.deploy/previous` and run `bash <DEPLOY_DIR>/.deploy/deploy.sh rollback --dir <DEPLOY_DIR> --env-file <DEPLOY_DIR>/.env` (or re-run `deploy.yml` with `action: rollback`), then restore the prior `.deploy/previous` state file if needed.
   - **Once `20270316140000` commits**, schemas are forward-only (`ludy_<module>`): never downgrade application containers to a pre-`#3971` release against renamed schemas. Fix forward with a new patch release on `main`, or to revert completely across the rename, restore the Stage 0 `backup.sh` snapshot or PITR timestamp per [backup-and-restore.md](backup-and-restore.md) alongside the saved `.deploy/current` release.

---

## Stage 2: Sync host Caddy and WAL overlays

Run this stage **before** removing `CROVE_DOMAIN` from `.env` in Stage 3. Live pilots provisioned before `#3967` carry an older `compose.host.yml` that requires `CROVE_DOMAIN` strictly; syncing the current [Caddyfile](../../tools/deploy/caddy/Caddyfile), [compose.host.yml](../../tools/deploy/caddy/compose.host.yml) (`${LUDY_DOMAIN:-${CROVE_DOMAIN:?...}}`), and [compose.wal.yml](../../tools/backup/compose.wal.yml) (`${WAL_STANZA:-crove}`) first ensures compatibility with both `CROVE_*` and `LUDY_*`, and equips the host for Stage 6's `WAL_STANZA=ludy` transition.

1. **[OPERATOR]** Pull the release tag in `<SRC_DIR>`, inspect diffs against `<DEPLOY_DIR>`, copy the three overlay files, and restart Caddy (`Caddyfile` sets `admin off`, so `docker compose restart caddy` is required for Caddyfile changes to reload even when compose env does not change):

   ```bash
   git -C <SRC_DIR> fetch --tags origin
   git -C <SRC_DIR> checkout <release tag>
   diff -u <DEPLOY_DIR>/Caddyfile <SRC_DIR>/tools/deploy/caddy/Caddyfile || true
   diff -u <DEPLOY_DIR>/compose.host.yml <SRC_DIR>/tools/deploy/caddy/compose.host.yml || true
   diff -u <DEPLOY_DIR>/compose.wal.yml <SRC_DIR>/tools/backup/compose.wal.yml || true
   cp -p <DEPLOY_DIR>/Caddyfile <DEPLOY_DIR>/Caddyfile.pre-phase3
   cp -p <DEPLOY_DIR>/compose.host.yml <DEPLOY_DIR>/compose.host.yml.pre-phase3
   cp -p <DEPLOY_DIR>/compose.wal.yml <DEPLOY_DIR>/compose.wal.yml.pre-phase3
   cp <SRC_DIR>/tools/deploy/caddy/Caddyfile \
      <SRC_DIR>/tools/deploy/caddy/compose.host.yml \
      <SRC_DIR>/tools/backup/compose.wal.yml \
      <DEPLOY_DIR>/
   cd <DEPLOY_DIR>
   docker compose config --quiet
   docker compose up -d --no-build caddy
   docker compose restart caddy
   ```

2. **[CHECK]** Confirm Caddy still serves HTTPS cleanly without losing ACME certificates in `caddy-data`:

   ```bash
   curl -fsSI https://<your domain>/healthz
   ```

3. **Rollback:** Restore the `.pre-phase3` copies in `<DEPLOY_DIR>`, run `docker compose up -d --no-build caddy && docker compose restart caddy`, and re-check `/healthz`.

---

## Stage 3: Cut over Docker volumes (`crove_*` -> `ludy_*`), pilot `.env`, GitHub `pilot`, and `/opt/ludy`

### Part A: Automated stack cutover via `pilot-ludy-cutover.yml` (`crove_*` -> `ludy_*`)

Owner decision (2026-11-24): eliminate all legacy `crove` names on the pilot host, migrating Docker named volumes to `ludy_*` and setting `COMPOSE_PROJECT_NAME=ludy` via the audited one-shot workflow [`.github/workflows/pilot-ludy-cutover.yml`](../../.github/workflows/pilot-ludy-cutover.yml) (running [`tools/deploy/cutover-ludy.sh`](../../tools/deploy/cutover-ludy.sh) over the existing `DEPLOY_SSH_KEY`).

1. **[OWNER / OPERATOR]** Run `Pilot Ludy cutover` (`workflow_dispatch` from `main`, `action: inspect`, blank confirmation) and review the output:
   - Confirms which legacy `CROVE_*` key names exist in `.env` (no secrets printed), current `COMPOSE_PROJECT_NAME`, active `crove_*` volumes, and that all 12 `ludy_*` schemas plus migration `20270316140000` are present with 0 `crove_*` schemas.
2. **[OWNER]** In GitHub repository `Settings -> Environments -> pilot` (environment level only):
   - Set `DEPLOY_LUDY_MODULES` matching the active module list and delete `DEPLOY_CROVE_MODULES`.
3. **[OWNER / OPERATOR]** With JOY's approval for the brief offline volume-copy window (~5 minutes depending on volume size), run `Pilot Ludy cutover` with `action: cutover-stack` and `confirm: cutover-pilot-to-ludy`. The script (`cutover-ludy.sh cutover-stack`) executes these steps atomically under `.deploy/lock`:
   - Verifies all target `ludy_*` volumes are absent or empty (fails closed before touching anything if populated).
   - Saves mode-600 backups of `.env`, `Caddyfile`, `compose.host.yml`, `compose.wal.yml` (if present), and a verified logical `pg_dump` (excluding `ludy_kernel.context_key`) into `<DEPLOY_DIR>/.deploy/cutover-backup-<stamp>/`.
   - Stops all `crove` containers cleanly (non-`db` first, then `stop -t 60 db` so PostgreSQL checkpoints).
   - Creates `ludy_<suffix>` volumes (Compose v2 labels) and copies every `crove_<suffix>` volume (except ephemeral `crove_media-scratch`) via pinned `postgres:17` with `--network none` and `--numeric-owner`, verifying file counts plus `PG_VERSION` and `global/pg_control` on `ludy_db-data`.
   - Removes stopped `crove` containers and bridge networks (`down --remove-orphans`, never `-v`), preserving `crove_*` volumes intact until verification finishes.
   - Syncs `Caddyfile`, `compose.host.yml`, and `compose.wal.yml` (if enabled), and rewrites `.env` in place (converting legacy `CROVE_*` -> `LUDY_*`, keeping existing `LUDY_*` values, rewriting `crove_<role>:` DB URL usernames to `ludy_<role>:`, and setting `COMPOSE_PROJECT_NAME=ludy`):

   | Legacy variable | Target `LUDY_*` variable | Notes |
   | --- | --- | --- |
   | (added/updated) | `COMPOSE_PROJECT_NAME=ludy` | Binds `docker compose` and future `deploy.sh` runs to `ludy_*` volumes |
   | `CROVE_DOMAIN` | `LUDY_DOMAIN` | Public pilot domain (`tools/deploy/caddy/Caddyfile`) |
   | `CROVE_UPSTREAM` | `LUDY_UPSTREAM` | Keep unset unless overriding loopback port |
   | `CROVE_MODULES` | `LUDY_MODULES` | Active module list (or preserved if `LUDY_MODULES` already exists) |
   | `CROVE_APP_DB_PASSWORD` | `LUDY_APP_DB_PASSWORD` | Matches `ludy_app` role password |
   | `CROVE_WORKER_DB_PASSWORD` | `LUDY_WORKER_DB_PASSWORD` | Matches `ludy_worker` role password |
   | `CROVE_PROBER_DB_PASSWORD` | `LUDY_PROBER_DB_PASSWORD` | Matches `ludy_prober` role password |
   | `CROVE_REPORTER_DB_PASSWORD` | `LUDY_REPORTER_DB_PASSWORD` | Matches `ludy_reporter` role password |
   | `CROVE_CONTEXT_TOKEN_KEY` | `LUDY_CONTEXT_TOKEN_KEY` | Keep existing key so active context tokens remain valid |
   | `CROVE_SHARED_DATABASE` | `LUDY_SHARED_DATABASE` | Only if set |
   | `CROVE_ALLOW_ALL_IN_ONE` | `LUDY_ALLOW_ALL_IN_ONE` | Usually unset on split pilot layout |
   | `CROVE_DIR` | `LUDY_DIR` | Only if set |
   | `CROVE_DEPLOY_DIR` | `LUDY_DEPLOY_DIR` | Only if set |
   | `CROVE_ENV_FILE` | `LUDY_ENV_FILE` | Only if set |
   | `CROVE_KEEP_RELEASES` | `LUDY_KEEP_RELEASES` | Release retention count if set |
   | `CROVE_KEEP_ENV_BACKUPS` | `LUDY_KEEP_ENV_BACKUPS` | `.env` backup retention count if set |
   | `CROVE_WORKER_SETTLE` | `LUDY_WORKER_SETTLE` | Only if set |
   | `CROVE_READY_TIMEOUT` | `LUDY_READY_TIMEOUT` | Only if set |
   | `CROVE_WAIT_TIMEOUT` | `LUDY_WAIT_TIMEOUT` | Only if set |
   | `CROVE_SMOKE_POLL_SECONDS` | `LUDY_SMOKE_POLL_SECONDS` | Only if set |

   - Do **not** switch `AUTH_ISSUER` away from `crove-auth` manually in `.env` unless `user_account.issuer` rows already match or a migration backfill has run; remote Supabase Auth (`DEPLOY_IDP_ENVIRONMENT=pilot`) already uses its HTTPS issuer URL.
   - Starts `ludy` stack (`db`, `migrate`, `auth`, `auth-grants`, infra, restarts `caddy`, `worker`, `api`, `prober`), runs loopback `deploy.sh smoke`, verifies 12 `ludy_*` schemas and 0 `crove_*` active PG sessions, and runs public smoke test via `DEPLOY_PUBLIC_URL`.
4. **[CHECK]** Confirm the workflow succeeds, `/readyz` and `/version` answer on `https://<your domain>`, and run `action: inspect` once more to verify `active_project=ludy`, `legacy CROVE_* keys in env: none`, and `Active crove_* sessions: none`.
5. **Prune legacy volumes (only after Stage 3 + Stage 6 + owner UI verification pass):** Run `Pilot Ludy cutover` with `action: prune-old-volumes` and `confirm: prune-crove-volumes` to remove old `crove_*` Docker volumes and unused `crove-db:local` image after confirming zero containers mount them.
6. **Rollback:** `cutover-ludy.sh cutover-stack` automatically tears down `ludy` on failure, deletes newly created partial `ludy_*` volumes, restores `.env` and overlay backups from `<DEPLOY_DIR>/.deploy/cutover-backup-<stamp>/`, and brings the original `crove` stack back up on untouched `crove_*` volumes. Manual emergency restore after success follows the same reverse steps while `crove_*` volumes remain unpruned.

### Part B: Root OS rename (`/opt/crove` -> `/opt/ludy`, timers, `sshd_config.d`, and `SMOKE_ORG`)

These root-owned paths sit outside `DEPLOY_USER`'s SSH permissions and are executed by **[OWNER]** (or host admin) via root SSH:

1. **[OWNER / ADMIN]** Disable old backup timers, rename host directories, update `BACKUP_DIR=/var/backups/ludy` in `/opt/ludy/.env`, move `/etc/ssh/sshd_config.d/10-crove.conf` -> `10-ludy.conf` (reload ssh only after verifying syntax with `sshd -t`), and replace `crove-backup.{service,timer}` with `ludy-backup.{service,timer}` (and update any `WAL` cron paths):

   ```bash
   systemctl disable --now crove-backup.timer || true
   mv /opt/crove /opt/ludy
   ln -s /opt/ludy /opt/crove
   if [ -d /opt/crove-src ] && [ ! -e /opt/ludy-src ]; then
     mv /opt/crove-src /opt/ludy-src
     ln -s /opt/ludy-src /opt/crove-src
   fi
   if [ -d /var/backups/crove ] && [ ! -e /var/backups/ludy ]; then
     mv /var/backups/crove /var/backups/ludy
   fi
   if [ -f /etc/ssh/sshd_config.d/10-crove.conf ] && [ ! -e /etc/ssh/sshd_config.d/10-ludy.conf ]; then
     mv /etc/ssh/sshd_config.d/10-crove.conf /etc/ssh/sshd_config.d/10-ludy.conf
     sshd -t && systemctl reload ssh
   fi
   ```

   Create `/etc/systemd/system/ludy-backup.service` and `ludy-backup.timer` per [backup-and-restore.md](backup-and-restore.md) with:

   - `WorkingDirectory=/opt/ludy`
   - `Environment=LUDY_DIR=/opt/ludy`
   - `ExecStart=/opt/ludy-src/tools/backup/backup.sh`

   Update `BACKUP_DIR=/var/backups/ludy` in `/opt/ludy/.env` and any WAL backup cron entries (`LUDY_DIR=/opt/ludy /opt/ludy-src/tools/backup/wal.sh backup ...`), remove legacy `/etc/systemd/system/crove-backup.*` after enabling `ludy-backup.timer`, then:

   ```bash
   systemctl daemon-reload
   systemctl enable --now ludy-backup.timer
   systemctl list-timers ludy-backup.timer
   ```

2. **[OWNER]** In GitHub `Settings -> Environments -> pilot`:
   - Set variable `DEPLOY_DIR` = `/opt/ludy` (and `DEPLOY_ENV_FILE` = `/opt/ludy/.env` if set previously).
   - Once the smoke organization's slug is updated from `crove-smoke-test` -> `ludy-smoke-test`, update `SMOKE_ORG` = `ludy-smoke-test`.
   - Run Actions -> `deploy` -> `Run workflow` (`environment: pilot`, `action: deploy`) on the current release tag to confirm CI deploys cleanly into `/opt/ludy`.
3. **[CHECK]** Confirm `Deploy to pilot` succeeds, `/opt/ludy/.deploy/current` updates cleanly, then remove temporary symlinks (`rm -f /opt/crove /opt/crove-src`).
4. **Rollback:** Revert `DEPLOY_DIR` (and `DEPLOY_ENV_FILE`, `SMOKE_ORG`) on GitHub `pilot`, disable `ludy-backup.timer`, restore `crove-backup.timer`, reverse renames (`rm -f /opt/crove && mv /opt/ludy /opt/crove`, `rm -f /opt/crove-src && mv /opt/ludy-src /opt/crove-src`, `mv /var/backups/ludy /var/backups/crove`), revert `BACKUP_DIR` in `.env`, and re-enable `crove-backup.timer`.

---

## Stage 4: `[OWNER]` Switch Cloudflare Email Worker (`x-ludy-recipient`)

The repository worker [`tools/inbound-mail/worker.js`](../../tools/inbound-mail/worker.js) already sends `x-ludy-recipient` and Ludy error messages (`Refused by Ludy`, `Ludy did not accept the message`), while the live kernel temporarily accepts both `x-ludy-recipient` and `x-crove-recipient`.

1. **[OWNER]** Open Cloudflare Dashboard -> **Workers & Pages** -> open the inbound email worker (historically `crove-inbound-mail`).
   - Verify **Settings -> Variables and Secrets** still hold `KERNEL_URL` (`https://<your domain>`) and secret `INBOUND_SECRET` (matching pilot `.env`).
   - Paste the exact contents of [`tools/inbound-mail/worker.js`](../../tools/inbound-mail/worker.js) from `main` into the worker editor and click **Deploy**.
   - Optional: create or rename a worker named `ludy-inbound-mail` with the same `KERNEL_URL` and `INBOUND_SECRET`, point Cloudflare **Email Routing -> Routing rules** (`Catch-all address`) to `ludy-inbound-mail`, and retire the old worker after verification.
2. **[CHECK]**
   - Send a synthetic test email from an external mailbox to an org's inbound invoice address (`<token>@<INBOUND_DOMAIN>`): confirm **Email Routing Activity log** shows accepted (`2xx`) and the message appears in that org's Inbox inside Ludy.
   - Send a test email to an unknown address (`nonexistent-check@<INBOUND_DOMAIN>`): confirm SMTP rejection returns `Unknown recipient` cleanly.
3. **Rollback:** In Cloudflare Workers -> **Deployments**, click **Rollback to this deployment** on the previous version (or rebind Email Routing catch-all back to the prior worker).

---

## Stage 5: `[OWNER]` Update S3 bucket lifecycle rules (`crove-*` -> `ludy-*`)

Ludy already tags expired marketplace originals with `ludy-retention=expired` in production code. Only the lifecycle rule **IDs** on the live file bucket still carry `crove-*` names. Applying `put-bucket-lifecycle-configuration` replaces the full rule set, so merge any site-specific rules from Stage 0's `lifecycle-before.json` before applying (include `--endpoint-url https://<s3 endpoint>` on all `aws s3api` commands if not using AWS S3).

1. **[OWNER]** Review `lifecycle-before.json` saved in Stage 0, then prepare `lifecycle-ludy.json` (plus any custom non-Ludy rules preserved from `lifecycle-before.json`):

   ```json
   {
     "Rules": [
       { "ID": "ludy-staging", "Status": "Enabled", "Filter": { "Prefix": "staging/" },
         "Expiration": { "Days": 1 }, "NoncurrentVersionExpiration": { "NoncurrentDays": 1 },
         "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 } },
       { "ID": "ludy-staging-markers", "Status": "Enabled", "Filter": { "Prefix": "staging/" },
         "Expiration": { "ExpiredObjectDeleteMarker": true } },
       { "ID": "ludy-tmp", "Status": "Enabled", "Filter": { "Prefix": "tmp/" },
         "Expiration": { "Days": 1 }, "NoncurrentVersionExpiration": { "NoncurrentDays": 1 } },
       { "ID": "ludy-tmp-markers", "Status": "Enabled", "Filter": { "Prefix": "tmp/" },
         "Expiration": { "ExpiredObjectDeleteMarker": true } },
       { "ID": "ludy-inbound-deleted", "Status": "Enabled", "Filter": { "Prefix": "inbound/" },
         "NoncurrentVersionExpiration": { "NoncurrentDays": 7 }, "Expiration": { "ExpiredObjectDeleteMarker": true } },
       { "ID": "ludy-export-deleted", "Status": "Enabled", "Filter": { "Prefix": "export/" },
         "NoncurrentVersionExpiration": { "NoncurrentDays": 7 }, "Expiration": { "ExpiredObjectDeleteMarker": true } },
       { "ID": "ludy-conversation-deleted", "Status": "Enabled", "Filter": { "Prefix": "conversation/" },
         "NoncurrentVersionExpiration": { "NoncurrentDays": 1 }, "Expiration": { "ExpiredObjectDeleteMarker": true } },
       { "ID": "ludy-notes-deleted", "Status": "Enabled", "Filter": { "Prefix": "notes/" },
         "NoncurrentVersionExpiration": { "NoncurrentDays": 1 }, "Expiration": { "ExpiredObjectDeleteMarker": true } },
       { "ID": "ludy-retention-expired", "Status": "Enabled", "Filter": { "Tag": { "Key": "ludy-retention", "Value": "expired" } },
         "NoncurrentVersionExpiration": { "NoncurrentDays": 1 } },
       { "ID": "ludy-org-markers", "Status": "Enabled", "Filter": { "Prefix": "org/" },
         "Expiration": { "ExpiredObjectDeleteMarker": true } }
     ]
   }
   ```

   Apply with the bucket owner account (never Ludy's restricted key; add `--endpoint-url https://<s3 endpoint>` if needed):

   ```bash
   aws s3api put-bucket-lifecycle-configuration --bucket <files-bucket> --lifecycle-configuration file://lifecycle-ludy.json
   ```

2. **[CHECK]** Verify all 10 `ludy-*` rules are enabled, `ludy-retention=expired` tag filter matches, and bucket Object Lock remains enabled:

   ```bash
   aws s3api get-bucket-lifecycle-configuration --bucket <files-bucket>
   aws s3api get-object-lock-configuration --bucket <files-bucket>
   ```

3. **Rollback:** Re-apply the Stage 0 snapshot immediately:

   ```bash
   aws s3api put-bucket-lifecycle-configuration --bucket <files-bucket> --lifecycle-configuration file://lifecycle-before.json
   ```

---

## Stage 6: Transition pgBackRest stanza (`crove` -> `ludy`) without invalidating old backups

Never overwrite, delete, or change `WAL_ENCRYPTION_KEY` for the existing `crove/` repository prefix until its retention window (`WAL_RETENTION_FULL`, typically 4 weeks) has elapsed. Moving both `WAL_STANZA=ludy` and `BACKUP_S3_PREFIX=ludy` starts a clean pgBackRest repository at `/ludy/wal` alongside the preserved `/crove/wal` archive.

1. **[OWNER]** Update the S3 IAM / bucket policies on `<backup-bucket>` **before** switching `.env`:
   - On `WAL_S3_ACCESS_KEY_ID`: add `s3:ListBucket` / `GetObject` / `PutObject` / `DeleteObject` for `ludy/wal/*` while keeping full write permissions on `crove/wal/*` throughout the cutover rollback window (narrowing `crove/wal/*` to read-only only after Stage 7 sign-off, so a rollback running `wal.sh setup` can still push segments).
   - On `BACKUP_S3_ACCESS_KEY_ID` (used by `backup.sh`): add permissions on `ludy/*` matching its existing permissions on `crove/*`, keeping `crove/*` intact until old runs age out.
2. **[CHECK]** Verify Stage 2 already placed the updated [`compose.wal.yml`](../../tools/backup/compose.wal.yml) (containing `${WAL_STANZA:-crove}`) in `<DEPLOY_DIR>/compose.wal.yml`, and verify the backup bucket already contains a healthy Stage 0 `backup.sh` run.
3. **[OPERATOR]** Either run `Pilot Ludy cutover` (`workflow_dispatch` from `main`, `action: switch-wal`, `confirm: switch-wal-to-ludy`, which builds `ludy-db:local`, sets `WAL_STANZA=ludy`, `BACKUP_S3_PREFIX=ludy`, and `WAL_DB_IMAGE=ludy-db:local` in `.env` with automatic rollback on failure, recreates `db`, and runs `wal.sh setup`, `wal.sh check`, and `wal.sh info`), OR run manually in `<DEPLOY_DIR>/.env`:

   ```ini
   WAL_STANZA=ludy
   BACKUP_S3_PREFIX=ludy
   WAL_DB_IMAGE=ludy-db:local
   ```

   Keep the existing `WAL_ENCRYPTION_KEY` (or store any new key separately in the owner's secret store alongside the old `WAL_ENCRYPTION_KEY` labeled by prefix `crove/`). Recreate only `db` (`--no-deps --no-build` after building `ludy-db:local` from `<SRC_DIR>/tools/wal`), initialize stanza `ludy`, take a full base backup + initial nightly run under `ludy/`:

   ```bash
   cd <DEPLOY_DIR>
   docker build -t ludy-db:local <SRC_DIR>/tools/wal
   docker compose up -d --no-deps --no-build db
   LUDY_DIR=<DEPLOY_DIR> CROVE_DIR=<DEPLOY_DIR> <SRC_DIR>/tools/backup/wal.sh setup
   LUDY_DIR=<DEPLOY_DIR> CROVE_DIR=<DEPLOY_DIR> <SRC_DIR>/tools/backup/backup.sh
   ```

   After verifying a live backup run under `ludy/`, run `LUDY_DIR=<DEPLOY_DIR> CROVE_DIR=<DEPLOY_DIR> <SRC_DIR>/tools/backup/backup.sh` (if using the `switch-wal` workflow) to populate the first nightly run under `ludy/`.

   Note on timing: during the brief seconds between `docker compose up -d --no-deps --no-build db` and `wal.sh setup` finishing, PostgreSQL buffers any closing WAL segment locally (`archive_command` retries cleanly); once `wal.sh setup` reloads `archive_command = 'pgbackrest --stanza=ludy archive-push %p'`, PostgreSQL flushes all pending segments to `/ludy/wal` and `wal.sh setup` takes the first full base backup automatically because `/ludy/wal` starts empty.

4. **[CHECK]** Verify active stanza, archiver state, prober, and fresh backup:

   ```bash
   LUDY_DIR=<DEPLOY_DIR> CROVE_DIR=<DEPLOY_DIR> <SRC_DIR>/tools/backup/wal.sh check
   LUDY_DIR=<DEPLOY_DIR> CROVE_DIR=<DEPLOY_DIR> <SRC_DIR>/tools/backup/wal.sh info
   cd <DEPLOY_DIR>
   docker compose exec -T db psql -U postgres -d postgres -Atc \
     "SELECT name, setting FROM pg_settings WHERE name IN ('archive_mode', 'archive_command');"
   docker compose exec -T db psql -U postgres -d postgres -Atc \
     "SELECT archived_count, last_archived_wal, failed_count, last_failed_wal FROM pg_stat_archiver;"
   docker compose run --rm --no-deps prober prober
   backup_dir="$(sed -n 's/^BACKUP_DIR=//p' <DEPLOY_DIR>/.env | tail -n 1)"
   cat "${backup_dir:-<DEPLOY_DIR>/.data/backups}/last-success"
   ```

   Expected:
   - `wal.sh info` shows `stanza: ludy`, status `ok`, at least one `full` backup, and `wal archive min/max` present.
   - `archive_command` shows `pgbackrest --stanza=ludy archive-push %p`.
   - `prober` prints `[prober] ok: ...` and exits 0 (any WAL lag prints a `wal_archive` failure instead).
   - `last-success` matches the just-completed run ID.

5. **Retire old `crove/` backup objects safely (after ~30 days):**
   Keep `crove/` and `crove/wal/` in `<backup-bucket>` and keep their keys in the owner's secret store until after the next successful monthly restore drill under `ludy/` (`BACKUP_KEEP_DAYS` / `WAL_RETENTION_FULL` elapsed). To inspect the old `crove/` WAL archive on a scratch stack without initializing PostgreSQL into an empty `db-data` volume (leaving the volume ready for `wal.sh restore`), set `WAL_STANZA=crove` and `BACKUP_S3_PREFIX=crove` with read-only S3 credentials and run a one-off container:

   ```bash
   docker compose --project-directory <SCRATCH_DIR> run --rm --no-deps -T -u postgres --entrypoint pgbackrest db info
   ```

   When restoring from that archive onto the scratch stack, always use `--archive-mode off`.

6. **Rollback:** Ensure `WAL_S3_ACCESS_KEY_ID` still has write permissions on `crove/wal/*`. In `<DEPLOY_DIR>/.env`, revert `WAL_STANZA=crove`, `BACKUP_S3_PREFIX=crove`, and `WAL_DB_IMAGE=crove-db:local`, and restore the original `crove/` `WAL_ENCRYPTION_KEY` from Stage 0 (or the owner's secret store) if a new key was set for `ludy/`. Run `cd <DEPLOY_DIR> && docker compose up -d --no-deps --no-build db`, then run `LUDY_DIR=<DEPLOY_DIR> CROVE_DIR=<DEPLOY_DIR> <SRC_DIR>/tools/backup/wal.sh setup` so PostgreSQL reloads `archive_command = 'pgbackrest --stanza=crove archive-push %p'`. If any WAL segments already pushed to `ludy/` before rolling back, immediately run `wal.sh backup --type full` on stanza `crove` so PITR continuity has no missing segment gap.

---

## Stage 7: Gate before the Phase 2 shim contraction PR

Do **not** open or merge the final contraction PR (removing `CROVE_*` fallbacks, `x-crove-*` headers, `crove-auth` issuer fallback, `crove` / `crove-extract` / `crove-media` service names, `/etc/crove-*-image`, `crove_*` role aliases, and dual-prefix `PENDING_TABLES` entries) until **all** boxes below are checked and confirmed:

- [ ] Stage 1 deployed (`v0.3.10` / `#3971` live on pilot; 12 `ludy_*` schemas active, 0 `crove_*` schemas).
- [ ] Stage 2 overlays synced (`Caddyfile`, `compose.host.yml`, and `compose.wal.yml`).
- [ ] Stage 3 complete (`COMPOSE_PROJECT_NAME=ludy`, `ludy_*` Docker volumes, and `LUDY_*` variables active via `cutover-stack`; 0 active `crove_*` PostgreSQL sessions; `DEPLOY_LUDY_MODULES` active; `pnpm pilot:check` passing; old `crove_*` volumes pruned via `prune-old-volumes` after verification; `/opt/ludy`, `ludy-backup.timer`, and `SMOKE_ORG=ludy-smoke-test` updated).
- [ ] Stage 4 complete (Cloudflare Email Worker sends `x-ludy-recipient` and inbound mail test passed).
- [ ] Stage 5 complete (S3 bucket lifecycle rules updated to `ludy-*` with `ludy-retention=expired` and Object Lock preserved).
- [ ] Stage 6 complete (`WAL_STANZA=ludy` + `BACKUP_S3_PREFIX=ludy` + `WAL_DB_IMAGE=ludy-db:local` live, `wal.sh check` and `wal.sh info` green, `backup.sh` green, old `crove/` keys retained safely during overlap).
- [ ] Owner (JOY) UI sanity check completed on `<PUBLIC_URL>` (sign-in, creating/viewing a record, AI coworker action, inbound mail).
