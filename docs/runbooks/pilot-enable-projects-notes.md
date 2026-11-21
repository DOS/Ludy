<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Runbook: turn on Ludy Projects (`projects`) and Ludy Notes (`notes`) on the pilot

Issue #4298 (following #1648, #3531, #3547, and #4213). Enables both `projects` (`Dự án` / Projects) and `notes` (`Ghi chú & Việc của tôi` / Notes & My work) under the `Cộng tác` (`Teamwork`) app alongside the pilot's already-enabled modules through the opt-in CI deploy environment variables (`DEPLOY_MODULES_ENVIRONMENT` and `DEPLOY_CROVE_MODULES`, #3531, [deploy.md](deploy.md#module-settings-in-the-deploy-3531)), with a direct host `.env` fallback when enabling on an already-deployed release.

## Context and scope

- **Module registry and coworker mapping:** Both `projects` and `notes` are registered in `AVAILABLE_MODULES` (`apps/kernel/src/config.ts`, backed by `MODULE_IDS` in `packages/kernel-contract/src/apps.ts`), where `MODULE_CATALOG` maps both to `app: 'teamwork'` (`Cộng tác` / `Teamwork`, `switchable: true`). In `packages/kernel-contract/src/coworkers.ts`, `COWORKER_BY_MODULE` only overrides `finance`, `hr`, `crm`, `conversations`, `social`, and `ads`, while `Vy` (`COWORKER_ROSTER.gm = 'Vy'`) leads across every app and serves as the coworker for both `projects` and `notes`.
- **Union rule (never overwrite active modules):** `tools/deploy/compose.pilot.yml` defaults `CROVE_MODULES` to `finance` for `api`, `worker`, and `prober` until an explicit Production setting adds other modules. Enabling `projects` and `notes` sets `CROVE_MODULES=<existing_modules>,projects,notes` as the union of all modules currently running on the pilot (for example `finance,crm,social,sign,projects,notes`, or adding `,projects,notes` after `hr`, `ads`, or `meetings` if active). Never replace `CROVE_MODULES` with `finance,projects,notes` alone if other lines' modules are already enabled.
- **Release-tag prerequisite (`v0.3.5` vs `main`):** Core `projects` (`#2591`, `#2606`, `#2607`, `#2608`, `#2609`, `#2610`) is already included in `v0.3.5`, whereas the Notes v2 capabilities (`#3558` / PR `#3634`, `#3556` / PR `#3629`, `#3560` / PR `#3696`, `#3559` / PR `#4190`, `#3561` / PR `#4197`, `#3562` / PR `#4199`, plus `#3563` and `#3564` once merged) sit on `main` above `v0.3.5`. To ship both `projects` and the full Notes v2 release on the pilot, cut and deploy a new `v*` release tag from `main` (with green CI per [deploy.md](deploy.md#deploy-a-release)) rather than re-running `v0.3.5`.
- **What changes on the pilot:**
  - `CROVE_MODULES` on the pilot host adds `projects` and `notes` to the union of all active modules for the `api`, `worker`, and `prober` services.
  - Under `Cộng tác` (`Teamwork`) in the app switcher, signed-in members gain navigation entries and routes `/o/<slug>/projects` (plus `/o/<slug>/projects/$id`), `/o/<slug>/my-work`, and `/o/<slug>/notes`:
    - **`owner`, `admin`, and `member`:** full access within role and [ADR-0037](../adr/0037-private-notes-and-todos.md) isolation rules. Members can create and update projects and tasks (project owner, org `owner`, and org `admin` manage project ownership, members, and archiving); private notes, private notebooks/templates, and all personal to-dos and to-do lists remain strictly author-only under PostgreSQL RLS; shared (`visibility = 'org'`) notes, notebooks, and templates are readable across the org and manageable by their author or an org `owner`/`admin`.
    - **`viewer`:** read-only access to projects, shared org notes/notebooks/templates, and any pre-existing own private items if later demoted; cannot create or modify projects, notes, or personal to-dos.
  - **Per-org enablement ([ADR-0053](../adr/0053-per-org-app-enablement.md)):** Org `owner` and `admin` roles can independently toggle `Dự án` (`projects`) and `Ghi chú & Việc của tôi` (`notes`) per org in `Settings > Ứng dụng` (`/o/<slug>/settings/apps`, oRPC `org.apps` / `org.setApp`, command `kernel.org.set_app`).
  - **Browser extension optional capture (`#3560`, PR `#3696`):** Users who authorize the Ludy browser extension with the `notes` scope can run write-only Quick Capture (0 extra browser permissions) and optional 1-click Web Clipper (`activeTab` + `scripting` requested only when toggled on), calling `POST /api/rpc/notes/clip` and `POST /api/rpc/notes/todos/quickCapture` (creating `visibility = 'private'`, `tainted = true` items). Extension tokens are refused (`403 FORBIDDEN`) on all notes read routes and note attachment HTTP routes.
  - **Zero unauthenticated public HTTP routes:** Neither `projects` nor `notes` exposes any unauthenticated public HTTP route or inbound webhook (`apps/kernel/test/invariant/route-coverage.test.ts`). Note attachment routes (`POST /api/notes/:noteId/attachments` and `GET /api/notes/attachments/:id`) require authenticated human browser sessions (`403 FORBIDDEN` for extension tokens).
- **Database migrations parity:** `crove_projects.*` and `crove_notes.*` migrations run on every deploy regardless of `CROVE_MODULES`. Toggling `projects` or `notes` off removes their runtime routes, RPC handlers, UI menus, and regular worker sweeps while leaving `crove_projects.*` and `crove_notes.*` rows, ADR-0037 RLS policies, and attachment blobs intact; legal keeping (trash expiry, departed member private-item purge, PDPL erasure, and `org_purge`) continues per [ADR-0053](../adr/0053-per-org-app-enablement.md).

## Approval rule and public-repo guardrails

- **Production approval gate ([AGENTS.md](../../AGENTS.md), "Production, secret and credential steps", and [contributing.md](../contributing.md#production-secret-and-credential-steps)):** This file is the concrete step list, not the authorization to run it. Zero Production changes run without owner JOY's explicit one-time approval of the concrete step list in the running coordinator / Product Owner chat, and no team lead or worker session executes Production steps.
- **Public repository rule:** No secret, token, Supabase project reference, internal hostname, IP address, or real customer / member data belongs in this runbook, an issue, a pull request, or chat.

## Who does what

- **[OWNER]** (JOY) approves the concrete step list in the running coordinator / Product Owner chat, sets (or approves setting) the `pilot` GitHub environment variables in `Settings -> Environments -> pilot`, and verifies UI behavior if desired.
- **[OPERATOR]** (or the coordinator / Product Owner with JOY's one-time approval) runs pre-flight checks, validates the unioned module list, cuts/triggers the `v*` release deploy (or runs the host `.env` fallback), and verifies endpoints and logs.
- **[CHECK]** must hold before moving to the next step. If any check fails, stop immediately and follow [3. Rollback](#3-rollback).

## 0. Prerequisites and non-blocking operations checks

1. **[CHECK] Inspect the pilot's active release and current `CROVE_MODULES` before changing anything:**

   ```bash
   curl -fsS <PUBLIC_URL>/version
   curl -fsS <PUBLIC_URL>/api/config
   ```

   - Confirm `/version` reports `"migrationsMissing":[]` and verify whether the running `build` commit SHA already sits at or above the target Notes v2 release on `main` (otherwise plan to cut and deploy a new `v*` tag from `main` in Path A).
   - Record every non-`kernel` module currently listed in `/api/config`'s `"modules"` array (and verify against `Settings -> Environments -> pilot` `DEPLOY_CROVE_MODULES` or `/opt/crove/.env` `CROVE_MODULES`).
   - Build `<existing_modules>,projects,notes` as the deduplicated **union** of all currently enabled pilot modules plus `projects` and `notes` (for example `finance,crm,social,sign,projects,notes`), and validate locally:

     ```bash
     bash tools/deploy/deploy.sh check-modules "<existing_modules>,projects,notes"
     ```

2. **[CHECK] Backup and GitHub `pilot` environment readiness:**
   - Confirm last night's sealed backup exists ([backup-and-restore.md](backup-and-restore.md)).
   - Confirm the `pilot` GitHub environment has its deploy secrets (`DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`) and `DEPLOY_PUBLIC_URL` configured ([deploy.md](deploy.md#settings-of-each-github-environment)).
3. **[CHECK] Verify `crove-extract` container health (`#3561` note attachments):**
   - `notes` attachment text extraction for PDF and DOCX files (`PR #4197`) sends file bytes from `worker` over the internal `extract` network (`EXTRACT_URL`; `tools/deploy/compose.pilot.yml` resets `EXTRACT_URL` on `api`) to `crove-extract`.
   - Confirm `crove-extract` is running and healthy (`docker compose ps crove-extract` shows `Up (healthy)` and `docker network inspect crove_extract --format '{{.Internal}}'` returns `true`, per [pilot-readiness.md](pilot-readiness.md)). Note that `projects` does not call `crove-extract`.
4. **[CHECK] Check AI pricing vars if `AI_API_KEY` is configured:**
   - Core `projects` and `notes` workflows run 100% deterministically with AI off ([projects.md](../plan/projects.md), [notes.md](../plan/notes.md), [notes-v2.md](../plan/notes-v2.md)).
   - If `AI_API_KEY` is set on the pilot, confirm `AI_PRICE_INPUT_PER_MTOK` or `AI_PRICE_OUTPUT_PER_MTOK` is non-zero (and `AI_DEFAULT_MONTHLY_BUDGET` if configured) so metered `Vy` features in `projects` (`projects.weekly_status`, `projects.tasks_from_note`, `projects.tasks_from_source`) and `notes` (`notes.summary`, `notes.todo_suggest`, plus `notes.todo_plan` and `notes.organize` once `#3563` merges) enforce per-org daily AI caps (`ORG_LIMIT_AI_COST_PER_DAY`) and monthly AI budgets ([pilot-readiness.md](pilot-readiness.md), [deploy.md](deploy.md#the-pilot-layout)).
5. **S3 lifecycle ops note for `notes/` (optional, non-blocking, from `#4197` / `#4213`):**
   - Isolated note attachments (`<= 25 MB`) live at `notes/<org_id>/<attachment_id>` in `BlobStore` (never in `crove_kernel.file`). When an attachment, note, departed member's private items, PDPL erasure, or `org_purge` removes attachments, the worker deletes those keys via `crove_notes.attachment_blob_doomed` (`sweepNoteAttachmentBlobs`).
   - On versioned S3 buckets (`S3_VERSIONING=required`), Ludy deletes only the current version, leaving a noncurrent version and delete marker unless a bucket lifecycle rule expires them. [provision-pilot.md](provision-pilot.md#4-the-files-bucket) defines the `crove-notes-deleted` lifecycle rule (`Filter: { Prefix: "notes/" }`, `NoncurrentVersionExpiration: { NoncurrentDays: 1 }`, `Expiration: { ExpiredObjectDeleteMarker: true }`).
   - **Non-blocking:** Enabling `projects` and `notes` does not block on applying `crove-notes-deleted` to an existing bucket, because active cleanup runs via `sweepNoteAttachmentBlobs` and no attachments exist under `notes/` until `notes` is used. However, adding `crove-notes-deleted` on an existing Production bucket is recommended defense-in-depth cleanup.
   - **Separate Production approval required:** Because `aws s3api put-bucket-lifecycle-configuration` replaces the entire bucket configuration and requires a bucket-admin credential (never Ludy's application key), updating an existing Production S3 bucket's lifecycle configuration must start from `get-bucket-lifecycle-configuration` (preserving every existing rule) and requires separate owner JOY approval in chat plus Platform PO execution per [provision-pilot.md](provision-pilot.md#4-the-files-bucket).

## 1. Procedure

### Path A (recommended): GitHub Actions environment sync (#3531) and `v*` release deploy

Use this path to deploy the latest Notes v2 code on `main` (above `v0.3.5`) and update `CROVE_MODULES` atomically with no interactive SSH session on the pilot host.

1. **[OPERATOR]** Validate the target comma-separated union list locally:

   ```bash
   bash tools/deploy/deploy.sh check-modules "<existing_modules>,projects,notes"
   ```

   **[CHECK]** Command exits `0` (1 to 10 unique lowercase names from `AVAILABLE_MODULES`, no duplicates, spaces, or shell characters).
2. **[OWNER]** In GitHub repository `Settings -> Environments -> pilot` (define both in the `pilot` environment **only**, never at repository or organization level):
   - Set variable `DEPLOY_MODULES_ENVIRONMENT` = `pilot`
   - Set variable `DEPLOY_CROVE_MODULES` = `<existing_modules>,projects,notes`
3. **[OPERATOR]** Confirm CI is green (`Lint, typecheck, test` and `Playwright on docker compose`, or `DEPLOY_REQUIRED_CHECKS`) on the target `main` commit carrying the Notes v2 slices, then deploy:
   - Cut and push a new `v*` release tag on `main` (for example `git tag v0.3.6 <main_commit_sha>` and `git push origin v0.3.6`, per [deploy.md](deploy.md#deploy-a-release)).
   - If a `v*` tag on `main` already includes all target Notes v2 commits, open `Actions -> deploy -> Run workflow` from that `v*` tag with `environment: pilot` and `action: deploy`.
4. **[CHECK]** Watch the `Deploy to pilot` workflow run:
   - `Release and target` confirms the tag commit is on `main` and required CI checks succeeded.
   - `Prepare the module settings` passes `check-modules` (`Modules given: <existing_modules>,projects,notes`).
   - On the host, `deploy.sh deploy --modules "<existing_modules>,projects,notes"` applies any pending migrations, creates a single mode-`600` dated backup (`<env file>.bak-<UTC time>-<random>`), atomically writes `CROVE_MODULES=<existing_modules>,projects,notes` into `/opt/crove/.env` (preserving inode, owner, and mode `600`), rolls `worker` (`CROVE_WORKER_SETTLE=15` seconds) before `api` and `prober`, and passes loopback smoke checks (`smoke ok: /api/config lists the expected modules`).
   - `Smoke test through the public URL` passes with `SMOKE_EXPECT_MODULES=<existing_modules>,projects,notes`.

### Path B (fallback): direct host `.env` update on an already-deployed release

Use this path **only** when the pilot host already runs a `v*` release carrying the target Notes v2 slices and an operator with SSH access enables `projects,notes` without running an image deploy.

1. **[OPERATOR]** Validate the target list locally (`bash tools/deploy/deploy.sh check-modules "<existing_modules>,projects,notes"`), then on the pilot host in `/opt/crove` inspect the current `CROVE_MODULES` assignment without printing secret values (`grep '^CROVE_MODULES=' .env`) and save a permission-preserving backup:

   ```bash
   cd /opt/crove
   cp -p .env ".env.bak-$(date -u +%Y%m%dT%H%M%SZ)"
   ```

   (Omitting a trailing `-<random>` suffix keeps `deploy.sh` from treating this manual backup as one of its auto-pruned `.bak-<UTC>Z-<random>` files.)
2. **[OPERATOR]** Update `CROVE_MODULES=<existing_modules>,projects,notes` in `/opt/crove/.env` (keeping mode `600`) and verify the syntax and compose config before restarting services:

   ```bash
   ./.deploy/deploy.sh check-modules "<existing_modules>,projects,notes"
   docker compose config --quiet
   ```

   If a repository checkout is present on the host, also run `pnpm pilot:check` against `/opt/crove/.env` ([pilot-readiness.md](pilot-readiness.md)) and confirm zero new `FAIL` lines.
3. **[OPERATOR]** Recreate `worker` first, verify it stays running after 15 seconds, verify `crove-extract` is healthy, then recreate `api` and `prober` (matching `deploy.sh` roll order):

   ```bash
   docker compose up -d --no-deps worker
   sleep 15 && docker compose ps worker
   docker compose ps crove-extract
   docker compose up -d --no-deps api prober
   ```

4. **[CHECK]** Verify `/readyz` and `/api/config`:

   ```bash
   curl -fsS <PUBLIC_URL>/readyz
   curl -fsS <PUBLIC_URL>/api/config
   ```

   If `DEPLOY_MODULES_ENVIRONMENT=pilot` is configured in GitHub Actions, update `DEPLOY_CROVE_MODULES` in `Settings -> Environments -> pilot` to `<existing_modules>,projects,notes` at the same time so the next workflow deploy does not overwrite `.env`.

## 2. Post-deploy verification

1. **[CHECK] Public readiness, build version, and module list:**
   - `GET <PUBLIC_URL>/readyz` returns `{"ready":true}`.
   - `GET <PUBLIC_URL>/version` returns the expected `build` commit SHA and `"migrationsMissing":[]`.
   - `GET <PUBLIC_URL>/api/config` lists `"kernel"`, `"projects"`, `"notes"`, and every previously enabled pilot module in `"modules"`.
2. **[CHECK] UI smoke checks across `Dự án`, `Việc của tôi`, and `Ghi chú`:**
   - Sign in at `<APP_URL>` and open `Cộng tác` (`Teamwork`) in the app switcher:
     - **`Dự án` (`/o/<slug>/projects`, `/o/<slug>/projects/$id`):** verify projects list loads, create a smoke project (or from template), add/move a task on the board/list, and confirm a `viewer` sees read-only views without create/edit actions.
     - **`Việc của tôi` (`/o/<slug>/my-work`):** create a personal to-do via Quick Add (including natural-language date/priority/tag parsing or `Alt+Q`), verify lists/sections/P1-P4/recurrence and completion work, and confirm another member cannot read your private to-dos.
     - **`Ghi chú` (`/o/<slug>/notes`):** create a private note and a smoke shared note (`Dùng chung`), verify notebooks/2-level stacks (`#3559`), starter templates and version history (`#3562`), `[[Note]]` backlinks, and upload/paste a small attachment (`<= 25 MB`, e.g. PDF, text, or image) to verify inline preview and `crove-extract` full-text search indexing (`#3561`). Clean up or archive smoke items afterward if desired.
   - **Deterministic AI-off behavior and metered `Vy` (when `AI_API_KEY` is set):** confirm deterministic project boards, to-dos, notes, and attachments work without AI calls; if `AI_API_KEY` is configured, trigger a `Vy` preview (such as project weekly status or note summary / to-do suggestions) and verify the `"Đề xuất"` tainted state, explicit human confirmation before any write, and `AI_PRICE_*` metering in `Ngân sách AI` (`/o/<slug>/ai-usage`).
   - **Optional browser extension check (`#3560`):** if testing the extension, verify authorizing the `notes` scope lets Quick Capture / Web Clipper create a private `tainted` note or to-do while extension reads stay `403 FORBIDDEN`.
3. **[CHECK] Per-org opt-out ([ADR-0053](../adr/0053-per-org-app-enablement.md)) and container logs:**
   - As `owner` or `admin` in a smoke/test org, open `Settings > Ứng dụng` (`/o/<slug>/settings/apps`) and toggle `Dự án` (`'projects'`) and `Ghi chú & Việc của tôi` (`'notes'`) off for that org:
     - Confirm both disappear immediately from the org's `Cộng tác` navigation (`projects/*` and `notes/*` RPC calls in that org return `404 MODULE_OFF`) while other pilot orgs are unaffected.
     - Toggle `'projects'` and `'notes'` back on and confirm immediate restoration.
   - If running with host access, inspect recent logs (`docker compose logs --since 10m worker api | grep -iE 'error|refused'`) and confirm `crove-extract` remains `Up (healthy)` with no unexpected errors.

## 3. Rollback

### Automatic rollback during Path A deploy

If compose validation, container startup, `/readyz`, the host loopback smoke test, or the public URL smoke test (`SMOKE_EXPECT_MODULES`) fails during `deploy.yml`, `deploy.sh` automatically restores the mode-`600` pre-deploy `.env` backup and rolls back to the previous release.

### Manual rollback after a completed deploy

- **Disable `projects` and/or `notes` while keeping the release (Path A forward sync, recommended):** In `Settings -> Environments -> pilot`, set `DEPLOY_CROVE_MODULES` back to `<existing_modules>` (removing `,projects,notes` or whichever module failed) and trigger `Actions -> deploy -> Run workflow` (`environment: pilot`, `action: deploy`) on the current `v*` tag. Alternatively, remove `DEPLOY_MODULES_ENVIRONMENT` and `DEPLOY_CROVE_MODULES` and run `action: rollback` (note that `deploy.sh rollback` restores the pre-deploy `.env` backup only when the release that wrote it is still the current release and `.env` has not been edited on the host since that deploy).
- **Revert to the previous `v*` release tag:** If the newly tagged release itself introduced a regression, keep `DEPLOY_CROVE_MODULES` at `<existing_modules>` and run `Actions -> deploy -> Run workflow` (`environment: pilot`, `action: deploy`) from the previous `v*` tag (or `action: rollback` from `main`). Remember that database migrations are forward-only ([deploy.md](deploy.md#migrations-are-forward-only)).
- **Via pilot host SSH (Path B):** Restore the pre-change `.env` backup (`cp -p .env.bak-<timestamp> .env`, keeping mode `600`, or remove `,projects,notes` from `CROVE_MODULES`), recreate `worker` then `api` and `prober` (`docker compose up -d --no-deps worker`, wait 15 seconds and check `docker compose ps worker`, then `docker compose up -d --no-deps api prober`), and verify `curl -fsS <PUBLIC_URL>/readyz` returns `{"ready":true}` and `curl -fsS <PUBLIC_URL>/api/config` no longer lists `"projects"` or `"notes"` in `"modules"`.

**Data and RLS preservation:** Turning `projects` or `notes` off removes their runtime routes, RPC handlers, UI menus, and regular worker sweeps while keeping all `crove_projects.*` and `crove_notes.*` rows, ADR-0037 private RLS policies, and `notes/` attachments intact in PostgreSQL and `BlobStore` (and legal keeping such as trash purge, departed member cleanup, PDPL erasure, and `org_purge` continues per [ADR-0053](../adr/0053-per-org-app-enablement.md)). Report what failed and which rollback path ran in the `Projects & Notes Product Owner` chat.
