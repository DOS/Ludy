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

- Subject sealing prefixes and AAD constants (`crove:s1:`, `CROVE_SIGN_SIGNER_PLACE`, and sibling `*_PLACE` AAD constants), input/export/archive/backup format tags (`crove.input.v1`, `crove.org-export.v2`, `crove-archive`, `CRB1`, `crove.backup.v1|...`), `crove_sign.playbook_rule:` hash domain, and WORM S3 object keys under `org/<org_id>/<sha256>`.
- Historical SQL migrations on `main` (`*_crove_*.sql`) and their ledger checksums in `ludy_meta.schema_migrations`.
- Existing Docker named volumes (`crove_db-data`, `crove_files`, `crove_caddy-data`, `crove_caddy-config`, `crove_keys`, `crove_archive`, `crove_status`) stay attached in place by pinning `COMPOSE_PROJECT_NAME=crove` in `.env` during Stage 3.

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

1. **[CHECK]** Confirm the target commit on `main` (containing both `9f6cfe18b` and the `#3972` cutover-runbook/`WAL_STANZA` commit) has green required CI checks (`Lint, typecheck, test`, `Playwright on docker compose`, `Docs check`).
2. **[OWNER]** Create and publish the release tag (`v*`, e.g. `v0.3.10`) on `main` (`https://github.com/DOS/Ludy/releases/new?tag=vX.Y.Z&target=main&title=vX.Y.Z`), and wait for `.github/workflows/deploy.yml` job `Build and push the images` to finish pushing digests to GHCR.
3. **[OPERATOR]** Once `Build and push the images` finishes (right before approving `Deploy to pilot` in GitHub Actions), stop the app containers during the short maintenance window while keeping `db`, `auth`, `caddy`, `crove-extract`, and `crove-media` running (include `prober` only if running in Compose):

   ```bash
   cd <DEPLOY_DIR>
   docker compose stop api worker
   docker compose stop prober || true
   ```

4. **[OWNER]** Approve the `Deploy to pilot` job in GitHub Actions (when `Required reviewers` is enabled on `pilot`). `deploy.sh` pulls images by digest, runs `migrate`, runs `auth-grants`, starts `worker`, `api`, and `prober` (if in `COMPOSE_PROFILES`), and runs loopback + public smoke tests.
5. **[CHECK]** After `Deploy to pilot` turns green, verify health, version, and all 12 PostgreSQL schemas:

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
   ```

   Expected output: exactly the 12 `ludy_*` schemas (`ludy_ads`, `ludy_crm`, `ludy_finance`, `ludy_hr`, `ludy_jobs`, `ludy_kernel`, `ludy_meetings`, `ludy_meta`, `ludy_notes`, `ludy_projects`, `ludy_sign`, `ludy_social`), **zero** `crove_*` schemas, and migration count `1`.

6. **Rollback:**
   - If `migrate` fails before committing, PostgreSQL rolls back the transaction cleanly; restart the prior containers (`docker compose start worker api`, plus `prober` if enabled), or run the `deploy.yml` `rollback` workflow targeting `main` (`pilot` environment).
   - Once `20270316140000` commits, schemas are forward-only (`ludy_<module>`). Do not roll back to a pre-`#3971` release binary against renamed schemas; to revert completely after commit, restore the Stage 0 `backup.sh` snapshot or PITR timestamp per [backup-and-restore.md](backup-and-restore.md).

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

## Stage 3: Cut over pilot `.env`, GitHub `pilot` env (and optional `/opt/ludy` directory)

### Part A: Pilot `.env` and GitHub `pilot` environment (`CROVE_*` -> `LUDY_*`)

1. **Docker volume preservation check (critical):**
   Inspect existing volume names on the host:

   ```bash
   docker volume ls --format '{{.Name}}' | grep -E '^(crove|ludy)_' | sort
   ```

   Existing stacks bootstrapped under `name: crove` hold persistent state in `crove_db-data`, `crove_files`, `crove_caddy-data`, `crove_caddy-config`, `crove_keys`, `crove_archive`, and `crove_status`. Add **`COMPOSE_PROJECT_NAME=crove`** explicitly in `.env` so a future cleanup PR changing `docker-compose.yml`'s default `name: crove` to `name: ludy` never detaches or recreates blank `ludy_*` volumes. (Only omit or change `COMPOSE_PROJECT_NAME` during a dedicated offline volume-migration maintenance window.)

2. **[OPERATOR]** In `<DEPLOY_DIR>/.env` (keeping mode `600` and owner matching the deploy user), migrate legacy `CROVE_*` keys (keeping the same credential values from the Stage 0 `.env` and owner's secret store unless rotating jointly) to their `LUDY_*` equivalents:

   | Legacy variable | Target `LUDY_*` variable | Notes |
   | --- | --- | --- |
   | (add if absent) | `COMPOSE_PROJECT_NAME=crove` | Mandatory to keep existing `crove_*` Docker volumes attached across Phase 2 compose rename |
   | `CROVE_DOMAIN` | `LUDY_DOMAIN` | Public pilot domain (`tools/deploy/caddy/Caddyfile`) |
   | `CROVE_UPSTREAM` | `LUDY_UPSTREAM` | Keep unset unless overriding loopback port |
   | `CROVE_MODULES` | `LUDY_MODULES` | Active module list (for example `finance,crm,social,sign`) |
   | `CROVE_APP_DB_PASSWORD` | `LUDY_APP_DB_PASSWORD` | Keep exact password matching `ludy_app` role (or rotate jointly before `migrate`) |
   | `CROVE_WORKER_DB_PASSWORD` | `LUDY_WORKER_DB_PASSWORD` | Keep exact password matching `ludy_worker` role |
   | `CROVE_PROBER_DB_PASSWORD` | `LUDY_PROBER_DB_PASSWORD` | Keep exact password matching `ludy_prober` role |
   | `CROVE_REPORTER_DB_PASSWORD` | `LUDY_REPORTER_DB_PASSWORD` | Keep exact password matching `ludy_reporter` role |
   | `CROVE_CONTEXT_TOKEN_KEY` | `LUDY_CONTEXT_TOKEN_KEY` | Keep existing key so active context tokens remain valid until rotation |
   | `CROVE_SHARED_DATABASE` | `LUDY_SHARED_DATABASE` | Only if set on shared PostgreSQL |
   | `CROVE_ALLOW_ALL_IN_ONE` | `LUDY_ALLOW_ALL_IN_ONE` | Usually unset on split pilot layout |
   | `CROVE_DIR` | `LUDY_DIR` | Only if backup scripts/timers pass stack path explicitly |
   | `CROVE_DEPLOY_DIR` | `LUDY_DEPLOY_DIR` | Only if set for `deploy.sh` |
   | `CROVE_ENV_FILE` | `LUDY_ENV_FILE` | Only if overridden |
   | `CROVE_KEEP_RELEASES` | `LUDY_KEEP_RELEASES` | Release retention count if customized |
   | `CROVE_KEEP_ENV_BACKUPS` | `LUDY_KEEP_ENV_BACKUPS` | `.env` backup retention count if customized |
   | `CROVE_WORKER_SETTLE` | `LUDY_WORKER_SETTLE` | Only if customized |
   | `CROVE_READY_TIMEOUT` | `LUDY_READY_TIMEOUT` | Only if customized |
   | `CROVE_WAIT_TIMEOUT` | `LUDY_WAIT_TIMEOUT` | Only if customized |
   | `CROVE_SMOKE_POLL_SECONDS` | `LUDY_SMOKE_POLL_SECONDS` | Only if customized |

   Also check:
   - If `DATABASE_URL`, `WORKER_DATABASE_URL`, `PROBER_DATABASE_URL`, or `REPORTER_DATABASE_URL` are explicitly defined in `.env`, verify their usernames are `ludy_app`, `ludy_worker`, `ludy_prober`, and `ludy_reporter` (not `crove_*`). Note that bundled `docker-compose.yml` builds those URLs automatically from `LUDY_*_DB_PASSWORD` when omitted.
   - Do **not** switch `AUTH_ISSUER` away from `crove-auth` unless the pilot's `ludy_kernel.user_account.issuer` rows already match or a migration/auth backfill has been verified; when using remote Supabase Auth (`DEPLOY_IDP_ENVIRONMENT=pilot`), `AUTH_ISSUER` already equals the remote HTTPS issuer URL and stays unchanged.
   - Keep `BACKUP_FILES_SERVICE=worker`, `BACKUP_NODE_SERVICE=worker`, and `RESTORE_FILES_SERVICE=worker` as configured for the split pilot layout.

3. **[OWNER]** In GitHub repository `Settings -> Environments -> pilot` (environment level only):
   - If `DEPLOY_MODULES_ENVIRONMENT=pilot` and `DEPLOY_CROVE_MODULES` are configured, add variable `DEPLOY_LUDY_MODULES` with the same active module list, and delete `DEPLOY_CROVE_MODULES` once Part A verification passes.

4. **[CHECK]** Recreate services with `--no-build` (the release images are pinned by digest and `<DEPLOY_DIR>` has no `tools/wal` build context) and verify zero legacy DB sessions or config warnings:

   ```bash
   cd <DEPLOY_DIR>
   docker compose config --quiet
   docker compose up -d --no-build
   curl -fsS https://<your domain>/readyz
   curl -fsS https://<your domain>/api/config
   docker compose exec -T db psql -U postgres -d postgres -Atc \
     "SELECT usename, count(*) FROM pg_stat_activity WHERE usename LIKE 'crove_%' GROUP BY 1;"
   ```

   Confirm `pg_stat_activity` returns 0 rows. Run `pnpm pilot:check -- --url https://<your domain>` from `<SRC_DIR>` using the host settings (never commit `.env`), confirming no unexpected `FAIL`.

5. **Rollback:** Restore the Stage 0 `.env` copy (`cp -p /root/env.pre-phase3-<stamp> <DEPLOY_DIR>/.env && chmod 600 <DEPLOY_DIR>/.env && cd <DEPLOY_DIR> && docker compose up -d --no-build`) and restore `DEPLOY_CROVE_MODULES` in GitHub `pilot` environment variables if removed.

### Part B: Rename `/opt/crove` -> `/opt/ludy` and systemd timer (optional, owner choice)

`deploy.yml` supports a custom `DEPLOY_DIR` variable on the `pilot` environment, so keeping `/opt/crove` (with `DEPLOY_DIR=/opt/crove`) is equally valid if JOY prefers zero host-directory churn. If JOY approves moving the host paths:

1. **[OPERATOR]** Disable old timers first, move directories, add temporary compatibility symlinks, and switch `/etc/systemd/system/crove-backup.*` to `ludy-backup.*`:

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
   ```

   Update `BACKUP_DIR=/var/backups/ludy` in `/opt/ludy/.env` (if moving `/var/backups/crove`). Create `/etc/systemd/system/ludy-backup.service` and `ludy-backup.timer` per [backup-and-restore.md](backup-and-restore.md) with:

   - `WorkingDirectory=/opt/ludy`
   - `Environment=LUDY_DIR=/opt/ludy`
   - `ExecStart=/opt/ludy-src/tools/backup/backup.sh`

   Update any WAL backup cron entries to run `LUDY_DIR=/opt/ludy /opt/ludy-src/tools/backup/wal.sh backup ...`, then reload systemd:

   ```bash
   systemctl daemon-reload
   systemctl enable --now ludy-backup.timer
   systemctl list-timers ludy-backup.timer
   ```

2. **[OWNER]** In GitHub `Settings -> Environments -> pilot`, set variable `DEPLOY_DIR` = `/opt/ludy` (and `DEPLOY_ENV_FILE` = `/opt/ludy/.env` if set previously), then run Actions -> `deploy` -> `Run workflow` (`environment: pilot`, `action: deploy`) on the current release tag to confirm CI deploys cleanly into `/opt/ludy`.
3. **[CHECK]** Confirm the `Deploy to pilot` workflow succeeds and `/opt/ludy/.deploy/current` updates cleanly.
4. **Rollback:** Revert `DEPLOY_DIR` (and `DEPLOY_ENV_FILE`) on GitHub `pilot`, disable `ludy-backup.timer`, restore `/etc/systemd/system/crove-backup.timer`, reverse the renames (`rm -f /opt/crove && mv /opt/ludy /opt/crove`, `rm -f /opt/crove-src && mv /opt/ludy-src /opt/crove-src`, `mv /var/backups/ludy /var/backups/crove`), revert `BACKUP_DIR` in `.env` and WAL cron entries, and re-enable `crove-backup.timer`.

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
   - On `WAL_S3_ACCESS_KEY_ID`: add `s3:ListBucket` / `GetObject` / `PutObject` / `DeleteObject` for `ludy/wal/*` while keeping `crove/wal/*` readable (at minimum `ListBucket` + `GetObject`) during the retention overlap window.
   - On `BACKUP_S3_ACCESS_KEY_ID` (used by `backup.sh`): add permissions on `ludy/*` matching its existing permissions on `crove/*`, keeping `crove/*` intact until old runs age out.
2. **[CHECK]** Verify Stage 2 already placed the updated [`compose.wal.yml`](../../tools/backup/compose.wal.yml) (containing `${WAL_STANZA:-crove}`) in `<DEPLOY_DIR>/compose.wal.yml`, and verify the backup bucket already contains a healthy Stage 0 `backup.sh` run.
3. **[OPERATOR]** In `<DEPLOY_DIR>/.env`, set:

   ```ini
   WAL_STANZA=ludy
   BACKUP_S3_PREFIX=ludy
   ```

   Keep the existing `WAL_ENCRYPTION_KEY` (or store any new key separately in the owner's secret store alongside the old `WAL_ENCRYPTION_KEY` labeled by prefix `crove/`). Recreate only `db` (`--no-deps --no-build` so `migrate` does not re-run and no local build context is needed), initialize stanza `ludy`, take a full base backup + initial nightly run under `ludy/`:

   ```bash
   cd <DEPLOY_DIR>
   docker compose up -d --no-deps --no-build db
   LUDY_DIR=<DEPLOY_DIR> CROVE_DIR=<DEPLOY_DIR> <SRC_DIR>/tools/backup/wal.sh setup
   LUDY_DIR=<DEPLOY_DIR> CROVE_DIR=<DEPLOY_DIR> <SRC_DIR>/tools/backup/backup.sh
   ```

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
   Keep `crove/` and `crove/wal/` in `<backup-bucket>` and keep their keys in the owner's secret store until after the next successful monthly restore drill under `ludy/` (`BACKUP_KEEP_DAYS` / `WAL_RETENTION_FULL` elapsed). To inspect an old `crove/` WAL archive in the meantime on a scratch stack (`wal.sh info` uses `dc exec`, so start the scratch `db` container first), pass `WAL_STANZA=crove BACKUP_S3_PREFIX=crove` with read-only S3 credentials and restore with `--archive-mode off`.

6. **Rollback:** Revert `WAL_STANZA=crove` and `BACKUP_S3_PREFIX=crove` in `<DEPLOY_DIR>/.env`, run `cd <DEPLOY_DIR> && docker compose up -d --no-deps --no-build db`, and run `LUDY_DIR=<DEPLOY_DIR> CROVE_DIR=<DEPLOY_DIR> <SRC_DIR>/tools/backup/wal.sh setup` so PostgreSQL reloads `archive_command = 'pgbackrest --stanza=crove archive-push %p'`. If any WAL segments already pushed to `ludy/` before rolling back, immediately run `wal.sh backup --type full` on stanza `crove` so PITR continuity has no missing segment gap.

---

## Stage 7: Gate before the Phase 2 shim contraction PR

Do **not** open or merge the final contraction PR (removing `CROVE_*` fallbacks, `x-crove-*` headers, `crove-auth` issuer fallback, `crove` / `crove-extract` / `crove-media` service names, `/etc/crove-*-image`, `crove_*` role aliases, and dual-prefix `PENDING_TABLES` entries) until **all** boxes below are checked and confirmed:

- [ ] Stage 1 deployed (`9f6cfe18b` + `#3972` cutover prep live on pilot; 12 `ludy_*` schemas active, 0 `crove_*` schemas).
- [ ] Stage 2 complete (`Caddyfile`, `compose.host.yml`, and `compose.wal.yml` synced on host; Caddy serving cleanly after restart).
- [ ] Stage 3 complete (`LUDY_*` variables and `COMPOSE_PROJECT_NAME=crove` active in pilot `.env`; 0 active `crove_*` PostgreSQL sessions; `DEPLOY_LUDY_MODULES` set if modules CI opt-in is enabled; `pnpm pilot:check` passing; optional `/opt/ludy` + `ludy-backup.timer` switched if selected).
- [ ] Stage 4 complete (Cloudflare Email Worker sends `x-ludy-recipient` and inbound mail test passed).
- [ ] Stage 5 complete (S3 bucket lifecycle rules updated to `ludy-*` with `ludy-retention=expired` and Object Lock preserved).
- [ ] Stage 6 complete (`WAL_STANZA=ludy` + `BACKUP_S3_PREFIX=ludy` live, `wal.sh check` and `wal.sh info` green, `backup.sh` green, old `crove/` keys retained safely during overlap).
- [ ] Owner (JOY) UI sanity check completed on `<PUBLIC_URL>` (sign-in, creating/viewing a record, AI coworker action, inbound mail).
