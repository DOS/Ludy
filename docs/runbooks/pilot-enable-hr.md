<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Runbook: turn on Ludy Nhân sự (`hr`) on the pilot

Issue #3547. Enables the `hr` module (`Ludy Nhân sự`) alongside the pilot's already-enabled modules through the opt-in CI deploy environment variables (`DEPLOY_MODULES_ENVIRONMENT` and `DEPLOY_CROVE_MODULES`, #3531, [deploy.md](deploy.md#module-settings-in-the-deploy-3531)), with a direct host `.env` procedure when enabling on an already-deployed release.

## Context and scope

- **Product default versus pilot host config:** Owner decision 2026-11-15 (#2538, PR #3327, [payroll.md](../plan/payroll.md#66-sensitive-data)) enables `Ludy Nhân sự` (`hr`) by default on Ludy Cloud (`hr` is in `AVAILABLE_MODULES` in `apps/kernel/src/config.ts`, with `Ly` mapped as `hr: 'finance'` in `COWORKER_BY_MODULE`). However, `tools/deploy/compose.pilot.yml` still defaults `CROVE_MODULES` to `finance` for `api`, `worker`, and `prober` until an explicit Production step enables `hr` on the pilot host.
- **What changes on the pilot:**
  - `CROVE_MODULES` on the pilot host adds `hr` to the union of all modules already running on the pilot (`api`, `worker`, and `prober` services).
  - Org `owner` and `admin` sessions gain the `Nhân sự` app switcher entry and routes (`/o/<slug>/hr/employees`, `/o/<slug>/hr/payroll`, `/o/<slug>/hr/bank-templates`, `/o/<slug>/hr/declarations`, `/o/<slug>/hr/recruiting`), with per-org opt-out in `Settings > Ứng dụng` ([ADR-0053](../adr/0053-per-org-app-enablement.md)).
  - `hr` exposes zero unauthenticated public HTTP routes and zero inbound webhooks.
  - Database schema state does not change when toggling `CROVE_MODULES`: `crove_hr` migrations run on every deploy regardless of `CROVE_MODULES`, and turning `hr` off leaves `crove_hr.*` rows intact under PostgreSQL row-level security.

## Approval rule and public-repo guardrails

- **Production approval gate ([AGENTS.md](../../AGENTS.md), "Production, secret and credential steps", and [contributing.md](../contributing.md#production-secret-and-credential-steps)):** This file is the concrete step list, not the authorization to execute it. No agent runs any step below without JOY's explicit one-time approval of the concrete step list in the running coordinator / Product Owner chat, and no team lead or worker session executes Production steps.
- **Public repository rule:** No secret, token, Supabase project reference, internal hostname, IP address, or real customer / employee data belongs in this runbook, an issue, a pull request, or chat.

## Who does what

- **[OWNER]** (JOY) approves the concrete step list in the running coordinator / Product Owner chat, sets (or approves setting) the `pilot` GitHub environment variables in `Settings -> Environments -> pilot`, and verifies UI behavior if desired.
- **[OPERATOR]** (or the coordinator / Product Owner with JOY's one-time approval) runs pre-flight checks, validates the unioned module list, triggers the deploy (or runs the host `.env` procedure), and verifies endpoints and logs.
- **[CHECK]** must hold before moving to the next step. If any check fails, stop immediately and follow [3. Rollback](#3-rollback).

## 0. Prerequisites and open external gates

1. **Salary and PII visibility rule (#2538, owner decisions 2026-11-08 and 2026-11-15, [payroll.md](../plan/payroll.md#66-sensitive-data)):**
   - Only org `owner` and `admin` roles can access `Ludy Nhân sự`, read per-person salaries, employee / employment / dependent records, sealed national IDs / tax codes / BHXH numbers / bank accounts, HR declaration exports, or recruiting candidate PII and wage bands (`sensitive` queries write an audit row before reading).
   - Non-admin `member` (including `Kế toán trưởng` holding `finance.proposal.approve`) and `viewer` roles see no `Nhân sự` navigation, receive `403 FORBIDDEN` on `hr/*` RPCs, and see only account-level totals (`334`, `338*`, `3335`, `642*`, and the entity's expense accounts) on accounting proposals and posted journal vouchers (`crove_hr.payroll_run_totals`, #2751).
2. **Open external `owner-action` items (tracked separately and enforced in code):**
   - **#2535 (partner accountant #61 payroll rule-row, posting-map, and worked-example sign-off):** Approving a monthly payroll run (`hr.payroll.run.approve`) and preparing payroll postings or payment vouchers remain blocked in code while any rule row used is still marked `commentary`. Departments, employees, leave balances, monthly draft pay-sheet calculations, declaration worksheet previews, and recruiting work today without bypassing #2535.
   - **#2536 (lawyer review of Personal Data Protection Law processor / cross-border rules, retention periods, and HTKK XSD licensing):** HTKK tax XML generation and #2539 payslip delivery by email remain gated on #2536 and do not run on the pilot.
   - **#2537 (anonymized real monthly payroll sample, bank bulk-salary template, accepted `D02-LT`, and filed quarterly return):** Tracked separately for golden-file calibration; no real employee PII enters the repository.
3. **[CHECK] Inspect the pilot's active release and current `CROVE_MODULES` before changing anything:**

   ```bash
   curl -fsS <PUBLIC_URL>/version
   curl -fsS <PUBLIC_URL>/api/config
   ```

   - Confirm `/version` reports the expected commit `build` on `main` (carrying `hr` and #3531) and `"migrationsMissing":[]`.
   - Record every non-`kernel` module currently listed in `/api/config`'s `"modules"` array (and in `Settings -> Environments -> pilot` `DEPLOY_CROVE_MODULES` or `/opt/crove/.env` `CROVE_MODULES`).
   - Build `<existing_modules>,hr` as the **union** of all currently enabled pilot modules plus `hr` (for example `finance,crm,social,sign,hr`, or `finance,social,ads,crm,notes,meetings,projects,sign,hr` when all current lines are enabled). Never overwrite `CROVE_MODULES` with `finance,hr` alone if other lines' modules (`social`, `ads`, `crm`, `notes`, `meetings`, `projects`, `sign`) are already active.
4. **[CHECK] Backup and AI budget readiness:**
   - Confirm last night's sealed backup exists ([backup-and-restore.md](backup-and-restore.md)).
   - Confirm the `pilot` GitHub environment has its deploy secrets and `DEPLOY_PUBLIC_URL` configured ([deploy.md](deploy.md#settings-of-each-github-environment)).
   - If `AI_API_KEY` is configured on the pilot, confirm `AI_PRICE_INPUT_PER_MTOK` or `AI_PRICE_OUTPUT_PER_MTOK` is set so metered `Ly` calls (`hr: 'finance'`) enforce org daily caps and monthly AI budgets ([pilot-readiness.md](pilot-readiness.md)).

## 1. Procedure

### Path A (recommended): GitHub Actions environment sync (#3531)

Use this path now that #3531 (PR #3537) is on `main`; no interactive SSH session on the pilot host is needed.

1. **[OPERATOR]** Validate the target comma-separated module list locally before updating GitHub variables:

   ```bash
   bash tools/deploy/deploy.sh check-modules "<existing_modules>,hr"
   ```

   **[CHECK]** Command exits `0` with no errors (1 to 10 unique lowercase module names from `AVAILABLE_MODULES`, no spaces or shell characters).
2. **[OWNER]** In GitHub repository `Settings -> Environments -> pilot` (define both in the `pilot` environment **only**, never at repository or organization level):
   - Set variable `DEPLOY_MODULES_ENVIRONMENT` = `pilot`
   - Set variable `DEPLOY_CROVE_MODULES` = `<existing_modules>,hr`
3. **[OPERATOR]** Deploy the `v*` release tag from `main`:
   - Either cut and push a new `v*` release tag on `main`, or open `Actions -> deploy -> Run workflow` on the active `v*` tag with `environment: pilot` and `action: deploy`.
4. **[CHECK]** Watch the `Deploy to pilot` workflow run:
   - `Prepare the module settings` passes `check-modules` (`Modules given: <existing_modules>,hr`).
   - On the host, `deploy.sh deploy --modules "<existing_modules>,hr"` creates a single mode-`600` dated backup (`<env file>.bak-<UTC time>-<random>`), atomically updates `CROVE_MODULES=<existing_modules>,hr` in `/opt/crove/.env` (preserving inode, owner, and mode `600`), rolls `worker` (15-second settle) before `api` and `prober`, and passes loopback smoke checks (`smoke ok: /api/config lists the expected modules`).
   - `Smoke test through the public URL` passes with `SMOKE_EXPECT_MODULES=<existing_modules>,hr`.

### Path B (fallback): direct host `.env` update on an already-deployed release

Use this path only when an operator with SSH access enables `hr` directly on the pilot server without running a full image deploy.

1. **[OPERATOR]** Validate the target list locally (`bash tools/deploy/deploy.sh check-modules "<existing_modules>,hr"`), then on the pilot host in `/opt/crove` inspect the existing `CROVE_MODULES` assignment without printing secret values (`grep '^CROVE_MODULES=' .env`) and save a permission-preserving backup:

   ```bash
   cd /opt/crove
   cp -p .env ".env.bak-$(date -u +%Y%m%dT%H%M%SZ)"
   ```

   (Using `.env.bak-<UTC>Z` without a trailing `-<random>` suffix keeps `deploy.sh` from treating the manual copy as one of its auto-pruned `.bak-<UTC>Z-<random>` files.)
2. **[OPERATOR]** Update `CROVE_MODULES=<existing_modules>,hr` in `/opt/crove/.env` (keeping mode `600`) and check the resolved configuration before restarting containers:

   ```bash
   ./.deploy/deploy.sh check-modules "<existing_modules>,hr"
   docker compose config --quiet
   ```

   If a repository checkout is present on the host, also run `pnpm pilot:check` against `/opt/crove/.env` ([pilot-readiness.md](pilot-readiness.md)) and confirm zero new `FAIL` lines.
3. **[OPERATOR]** Recreate `worker` first, verify it stays running after 15 seconds, then recreate `api` and `prober` (matching `deploy.sh` roll order):

   ```bash
   docker compose up -d --no-deps worker
   sleep 15 && docker compose ps worker
   docker compose up -d --no-deps api prober
   ```

4. **[CHECK]** Verify `/readyz` and `/api/config`:

   ```bash
   curl -fsS <PUBLIC_URL>/readyz
   curl -fsS <PUBLIC_URL>/api/config
   ```

   If `DEPLOY_MODULES_ENVIRONMENT=pilot` is also configured in GitHub Actions, update `DEPLOY_CROVE_MODULES` in `Settings -> Environments -> pilot` to `<existing_modules>,hr` at the same time so the next workflow deploy does not revert `.env`.

## 2. Post-deploy verification (smoke and isolation checks)

1. **[CHECK] Public readiness and module list:**
   - `GET <PUBLIC_URL>/readyz` returns `{"ready":true}` and `GET <PUBLIC_URL>/version` reports `"migrationsMissing":[]`.
   - `GET <PUBLIC_URL>/api/config` includes `"hr"` in `"modules"` alongside `"kernel"` and every previously enabled pilot module.
2. **[CHECK] Owner / admin screens, AI-off determinism, and metered `Ly`:**
   - Sign in as an org `owner` or `admin` at `<APP_URL>`: confirm `Nhân sự` appears in the app switcher and loads `/o/<slug>/hr/employees`, `/o/<slug>/hr/payroll` (including `/o/<slug>/hr/bank-templates`), `/o/<slug>/hr/declarations`, and `/o/<slug>/hr/recruiting`.
   - Confirm deterministic payroll and recruiting flows work with AI off (or without calling AI): employee and department listing, draft monthly pay-sheet calculation (still enforcing the #2535 `commentary` rule gate before approval), declaration worksheet preview, and job openings / candidates.
   - Where AI is configured, confirm `Ly` (`hr: 'finance'`) operates on pseudonymized data only, respects the org's `finance` AI budget controls via `packages/agent` `metered()`, and requires human approval for every payroll approval, posting, and payment.
3. **[CHECK] Non-admin `member` (`Kế toán trưởng`) isolation:**
   - Sign in as a non-admin `member` (such as an accountant under the `Kế toán trưởng` / `accountant` approval preset):
     - Confirm `Nhân sự` navigation links do **not** appear in the app switcher or sidebar.
     - Confirm direct `hr/*` RPC requests (for example `POST <PUBLIC_URL>/api/rpc/hr/payroll/employees/list`, `POST <PUBLIC_URL>/api/rpc/hr/payroll/runs/list`, or `POST <PUBLIC_URL>/api/rpc/hr/recruiting/openings/list`) return HTTP `403` with `FORBIDDEN`.
     - Confirm accounting screens (`Kế toán`) expose only account-level voucher totals (`334`, `338*`, `3335`, `642*`) and never per-employee salary lines.
4. **[CHECK] Per-org opt-out (`ADR-0053`) and container logs:**
   - As `owner` or `admin` of a smoke/test org, open `Settings > Ứng dụng` ([ADR-0053](../adr/0053-per-org-app-enablement.md), oRPC `org.setApp` / command `kernel.org.set_app`, read via `org.apps` / `kernel.org.apps`) and toggle `Nhân sự` (`'hr'`) off for that single org:
     - Confirm `Nhân sự` disappears immediately for that org (`hr/*` calls in that org return `404 MODULE_OFF`) while other pilot orgs remain unaffected.
     - Toggle `'hr'` back on in that smoke/test org and confirm immediate restoration.
   - If running with host access, inspect recent logs (`docker compose logs --since 10m worker api | grep -iE 'error|refused'`) and confirm no unexpected errors.

## 3. Rollback

### Automatic rollback during Path A deploy

If compose validation, container startup, `/readyz`, the host loopback smoke test, or the public URL smoke test (`SMOKE_EXPECT_MODULES`) fails during `deploy.yml`, `deploy.sh` automatically restores the mode-`600` pre-deploy `.env` backup and rolls back to the previous release.

### Manual rollback after a completed deploy

To disable `hr` on the pilot while keeping all other active pilot modules running:

- **Via GitHub Actions (Path A forward sync, recommended):** In `Settings -> Environments -> pilot`, set `DEPLOY_CROVE_MODULES` back to `<existing_modules>` (removing `,hr`) and trigger `Actions -> deploy -> Run workflow` (`environment: pilot`, `action: deploy`) on the current `v*` tag. Alternatively, remove `DEPLOY_MODULES_ENVIRONMENT` and `DEPLOY_CROVE_MODULES` and run `action: rollback` (`deploy.sh rollback` restores the pre-deploy `.env` backup when `.env` has not been edited on the host since that deploy).
- **Via pilot host SSH (Path B):** Restore the pre-change `.env` backup (`cp -p .env.bak-<timestamp> .env`, keeping mode `600`, or remove `,hr` from `CROVE_MODULES`), recreate `worker` then `api` and `prober` (`docker compose up -d --no-deps worker`, wait 15 seconds and check `docker compose ps worker`, then `docker compose up -d --no-deps api prober`), and verify `curl -fsS <PUBLIC_URL>/readyz` returns `{"ready":true}` and `curl -fsS <PUBLIC_URL>/api/config` no longer lists `"hr"` in `"modules"`.

**Data and RLS preservation:** Turning `hr` off removes its runtime routes, RPC handlers, UI menus, and worker sweeps, while all existing `crove_hr.*` rows, per-subject encryption keys, audit trail entries, and `owner_admin` row-level security policies remain intact in PostgreSQL (and legal keeping such as retention, evidence holds, and erasure continues per [ADR-0053](../adr/0053-per-org-app-enablement.md)). Report what failed and which rollback path ran in the `HRM Product Owner` chat.
