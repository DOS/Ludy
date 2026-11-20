# 0054. Rename internal `crove` code, infrastructure, and PostgreSQL identifiers to `ludy` (#1682 Phase 3)

- Status: accepted for the rollout plan and naming contract (owner decision 2026-11-19 in Antigravity popup under [#1682](https://github.com/DOS/Ludy/issues/1682)); engineering choices flagged for Platform PO (`line:platform`) review.
- Date: 2026-11-19
- Deciders: owner (JOY) for full Phase 3 execution including schemas and roles; implementation design in this ADR by session `e05e2bf5` for Platform PO review.
- Builds on: [#1682](https://github.com/DOS/Ludy/issues/1682) (Phase 1 [#1683](https://github.com/DOS/Ludy/issues/1683), Phase 2 [#1685](https://github.com/DOS/Ludy/issues/1685)), [ADR-0053](0053-per-org-app-enablement.md), and [shared-database.md](../runbooks/shared-database.md).
- Issues: [#1682](https://github.com/DOS/Ludy/issues/1682), [#3964](https://github.com/DOS/Ludy/issues/3964) (ADR & plan), [#3965](https://github.com/DOS/Ludy/issues/3965), [#3966](https://github.com/DOS/Ludy/issues/3966), [#3967](https://github.com/DOS/Ludy/issues/3967), [#3969](https://github.com/DOS/Ludy/issues/3969), [#3970](https://github.com/DOS/Ludy/issues/3970), [#3971](https://github.com/DOS/Ludy/issues/3971), [#3972](https://github.com/DOS/Ludy/issues/3972).

## Context and problem statement

Phases 1 and 2 of [#1682](https://github.com/DOS/Ludy/issues/1682) rebranded user-facing UI, the marketing site (`apps/web`), `README.md`, operator runbooks, and `DOS/Ludy` repository naming from Crove to **Ludy** (`Vy` for the AI general manager). Phase 3 (all internal identifiers: workspace packages, environment variables, headers, browser storage keys, compose services, and PostgreSQL schemas/roles/GUCs) was deferred pending an explicit owner decision.

On 2026-11-19, JOY approved executing Phase 3 in full, including renaming PostgreSQL schemas and cluster roles (`crove_kernel`, `crove_finance`, ..., `crove_tenant`, `crove_app`, `crove_worker`, etc.), and moving forward sequentially from a dedicated planning and execution track (`#3964` through `#3972`) with advance rebase notices on [#1210](https://github.com/DOS/Ludy/issues/1210) and Platform PO review on all `shared-core` changes.

Three repository constraints require a formal ADR and strict sequencing before changing any SQL identifier:

1. **`tools/ci/migration-lint.mjs` (`contract-header`)** rejects every `RENAME`, `SET SCHEMA`, or non-internal `DROP` in `supabase/migrations/` unless preceded by `-- crove:contract adr=<id>` (or `-- ludy:contract adr=<id>` after Step 2a) naming an existing ADR file in `docs/adr/`.
2. **`.github/workflows/protected.yml` (`Invariant suite (from base)`)** checks out `origin/main`'s copies of `test/invariant/**`, `vitest.invariant.config.ts`, and `supabase/tests/database/_*.test.sql` and runs them against the PR's code and migrations. Renaming schemas, roles, GUCs, tables, or event triggers in one step fails against `origin/main`'s assertions unless a two-step prep lands first ([AGENTS.md](../../AGENTS.md)).
3. **Immutable history and live pilot data**: applied migrations in `supabase/migrations/` (`2026*` and `2027*`) cannot be edited (`sha256` ledger verification in `packages/db/src/migrate.ts` and `no-edit-applied` in `migration-lint.mjs`), compatibility SQL `VIEW`s with `org_id` are banned by `rls-matrix.db.test.ts`, and sealed rows / WORM archives / pgBackRest backups on live pilot servers must remain readable without data loss.

## Decision drivers

- Eliminate user- and developer-visible `crove` artifacts consistently (`@ludy/*`, `LUDY_*`, `ludy_*`, `x-ludy-*`, `ludy-*`).
- Zero data loss, zero broken decryption/unsealing/WORM verification, and zero unintentional downtime on deployed pilot databases or hosted shared-database instances (`CROVE_SHARED_DATABASE=true`).
- Never relax security, tenancy RLS, `hardeningViolations` (`search_path = pg_catalog, pg_temp`), `no-edit-applied`, or one-write-path invariants.
- Keep `main` buildable and CI-green after every single PR in the chain (`#3964` -> `#3972`).

## Decision

### 1. Target identifier map across layers

| Layer | Legacy identifiers | Target identifiers | Notes |
| --- | --- | --- | --- |
| Workspace packages | `crove-monorepo`, `@crove/*` (33 workspace packages + `spikes/dbos`), `@crove/ui/*` | `ludy-monorepo`, `@ludy/*` (`apps/app` -> `@ludy/app`, etc.), `@ludy/ui/*` | Atomic monorepo PR (`#3965`), preserving external CI job names (`Lint, typecheck, test`, `Playwright on docker compose`, `Docs check`, `Migration order`) referenced by `deploy.yml` / `release-branch.yml` / `migration-recheck.mjs`. |
| Browser storage & IndexedDB | `crove-theme`, `crove-locale`, `crove-auth`, `crove-pending-invite`, `crove.legalEntity.*`, `crove.social.*`, `crove.review.name`, `crove-pending-*`, `crove:social-list`, `crove.oauth.*`, `crove.sign.*`, `crove-org-left`, `crove-meeting-recordings` | `ludy-theme`, `ludy-locale`, `ludy-auth`, `ludy-pending-invite`, `ludy.legalEntity.*`, `ludy.social.*`, `ludy.review.name`, `ludy-pending-*`, `ludy:social-list`, `ludy.oauth.*`, `ludy.sign.*`, `ludy-org-left`, `ludy-meeting-recordings` | Dual-read/migrate on first client access (`#3966`) so active browser sessions, drafts, and IndexedDB recordings are preserved. |
| Browser CSP, DOM, CSS & exports | `crove-sw`, `crove-turnstile`, `crove-csp-meta`, `crove-picker-without-form`, `application/x-crove-todo`, `@keyframes crove-*`, `['crove', 'current-session']`, `crove-*` CSV prefixes, `brandSlug` fallback `'crove'` | `ludy-sw`, `ludy-turnstile`, `ludy-csp-meta`, `ludy-picker-without-form`, `application/x-ludy-todo`, `@keyframes ludy-*`, `['ludy', 'current-session']`, `ludy-*` CSV prefixes, `'ludy'` reserved bio slug | Updated together with Playwright & design-token tests (`#3966`). |
| Environment vars (45) | `CROVE_*` (`CROVE_MODULES`, `CROVE_SHARED_DATABASE`, `CROVE_CONTEXT_TOKEN_KEY`, `CROVE_*_DB_PASSWORD`, `CROVE_TEST_*`, deploy/backup vars) | `LUDY_*` (`LUDY_MODULES`, `LUDY_SHARED_DATABASE`, `LUDY_CONTEXT_TOKEN_KEY`, `LUDY_*_DB_PASSWORD`, `LUDY_TEST_*`, etc.) | Dual-read `LUDY_* ?? CROVE_*` added in `#3967`; legacy `CROVE_*` fallbacks removed only after pilot cutover (`#3972`). |
| HTTP headers, auth issuer & mail | `x-crove-org`, `x-crove-invite`, `x-crove-recipient`, issuer `'crove-auth'`, `SMTP_FROM` local domain `crove.local`, `inbound.crove.test` | `x-ludy-org`, `x-ludy-invite`, `x-ludy-recipient`, issuer `'ludy-auth'`, `SMTP_FROM` local domain `ludy.local`, `inbound.ludy.test` | Server CORS/RPC and JWT validation accept both `ludy*` and `crove*` during transition (`#3967`); Cloudflare Email Worker cut over in `#3972`. |
| Docker, compose & S3 dev buckets | Compose projects `crove*`, services `crove`/`crove-extract`/`crove-media`, markers `/etc/crove-*-image`, buckets `crove-files`/`crove-archive`/`crove-test` | `ludy*` projects, `ludy`/`ludy-extract`/`ludy-media`, `/etc/ludy-*-image`, `ludy-files`/`ludy-archive`/`ludy-test` | Compose adds network aliases during transition (`#3967`); host dir `/opt/ludy`, SSH host, S3 rules, and pgBackRest stanza cut over via `#3972` runbook. |
| Outbound & API metadata | Alert `{ crove: ... }` / `[Crove]`, iCal `PRODID:-//Crove//...`, `'crove-ai'`, `'Crove Sandbox CA'`, portal `void_in_crove` / `CroveInvoice`, `hideCrove` / `hide_crove`, `CrovePublished`, `MadeWithCrove` | Alert `{ ludy: ... }` / `[Ludy]`, `PRODID:-//Ludy//...`, `'ludy-ai'`, `'Ludy Sandbox CA'`, `void_in_ludy` / `LudyInvoice`, `hideLudy` / `hide_ludy`, `LudyPublished`, `MadeWithLudy` | HTKK XML `service: { code: 'LUDY', name: 'Ludy', version: '1.0' }`; DB column `hide_crove` -> `hide_ludy` added/migrated carefully with RPC schema. |
| Postgres schemas (12) | `crove_kernel`, `crove_meta`, `crove_jobs`, `crove_finance`, `crove_social`, `crove_crm`, `crove_notes`, `crove_ads`, `crove_hr`, `crove_meetings`, `crove_projects`, `crove_sign` | `ludy_kernel`, `ludy_meta`, `ludy_jobs`, `ludy_finance`, `ludy_social`, `ludy_crm`, `ludy_notes`, `ludy_ads`, `ludy_hr`, `ludy_meetings`, `ludy_projects`, `ludy_sign` | Forward migrations using `ALTER SCHEMA crove_<x> RENAME TO ludy_<x>` (`#3970` core, `#3971` modules), keeping OIDs/FKs/rows intact without `DROP SCHEMA` or `VIEW`s. |
| Postgres cluster roles (8 active + 1 reserved) | `crove_tenant`, `crove_app`, `crove_worker`, `crove_prober`, `crove_reporter`, `crove_auth_reader`, `crove_definer_tenant`, `crove_definer_einvoice` (`crove_definer_system` reserved in `LUDY_ROLES`) | `ludy_tenant`, `ludy_app`, `ludy_worker`, `ludy_prober`, `ludy_reporter`, `ludy_auth_reader`, `ludy_definer_tenant`, `ludy_definer_einvoice` (`ludy_definer_system` reserved) | Cluster-wide roles created idempotently and aliased during transition (`#3970`), retired after pilot cutover (`#3972`); `hardeningViolations` & `LUDY_ROLES` updated first (`#3969`, `#3970`). |
| Postgres GUCs, triggers, locks & channels | `crove.ctx`, `crove.ctx_seal`, `crove.*`, `crove_ddl_watch*`, `crove_outbox`, `crove_stream`, `crove_try_run_*`, lock ns `1129467734` (`'CROV'`), `-- crove:*` | `ludy.ctx`, `ludy.ctx_seal`, `ludy.*`, `ludy_ddl_watch*`, `ludy_outbox`, `ludy_stream`, `ludy_try_run_*`, lock ns `1280656473` (`'LUDY'`), `-- ludy:*` | Dual GUC reads (`COALESCE(NULLIF(current_setting('ludy.x', true), ''), current_setting('crove.x', true))`) and dual markers supported until `#3972`. |
| Migration filenames & generated types | `<14d>_crove_<mod>_<desc>.sql`, `Crove*Schema` in `generated/database.ts` | New files `<14d>_ludy_<mod>_<desc>.sql`, `Ludy*Schema`; **700 applied `*_crove_*.sql` files never renamed or edited** | Both `migrate.ts` and `migration-lint.mjs` recognize `_crove_` for historical migrations and `_ludy_` going forward (`#3969`). |

### 2. Immutability boundary for data at rest and persisted history

Changing labels inside active code and schemas must **never** corrupt, invalidate, or strand persisted records, ciphertexts, hashes, backups, or migrations already written to databases and object storage:

1. **Historical SQL migrations (`supabase/migrations/2026*`, `supabase/migrations/2027*` pre-cutover, `supabase/shared-variants/`):** stay untouched on disk with their original `*_crove_*.sql` filenames and `sha256` hashes ledgered in `meta.schema_migrations`.
2. **Cryptographic domain separation strings & sealed data-at-rest decoders:**
   - Stored ciphertexts, key-wrapping labels, keyed HMAC hashes (`idempotency_key.input_hash`, blinded search hashes, audit read proofs), sealed subject PII (`'crove:s1:'`, CHECK constraints accepting `^(crove|ludy):s1:...` during/after cutover), encrypted meeting media (`'crove.meeting_media.v1'`, `'crove.meetings.v1|wrap'`), vault credentials (`'crove.credential.v1'`), org export archives (`'crove.org-export.v2'`), WORM archive JSON manifests (`'crove-archive'`, `'crove-restore-ack'`, `'crove-verify-marker'`, `'crove-outbox-archive'`, `'crove-shred-ref'`, `'crove-year-archive-v1'`), backup encryption headers (`'CRB1'`, `'crove.backup.v1|...'`), and issued extension tokens (`'crx_'`, `'crc_'`) contain cryptographic or persisted formats tied to historical secrets/rows.
   - Unless an explicit key rotation / re-wrap migration runs for a domain, readers and verifiers keep decoding these immutable historical version strings (`v1`/`v2`/`CRB1`/`crove:s1:`). New optional version strings (`'ludy:s1:'`, `'ldx_'`, etc.) may be introduced only alongside backward-compatible decoders so zero historical data is lost.
3. **Existing pilot S3 lifecycle rules & pgBackRest backups:** keep existing buckets, S3 prefix layouts (`org/<org_id>/<sha256>`, `archive/...`), and existing pgBackRest stanzas readable through explicit `#3972` owner-approved runbooks before deleting legacy names.

### 3. Two-step invariant & `migrate.db.test.ts` cutover architecture

Because `.github/workflows/protected.yml` runs `origin/main`'s `test/invariant/**` and `_*.test.sql` against every protected-path PR:

1. **Step 2a (`#3969`, lands BEFORE any SQL/runtime rename):**
   - Broadens `tools/ci/migration-lint.mjs`, `packages/db/test/invariant/{migrate,conformance,pgtap-gate}.db.test.ts`, `supabase/tests/database/_{conformance,rls_matrix}.test.sql`, and invariant tests across `apps/kernel`, `modules/*`, and `packages/*` to accept **both** `crove_*` and `ludy_*` catalog/role/GUC/marker states (detecting the active kernel schema via `pg_namespace` without loosening any tenancy, RLS, write-path, or `search_path` rule).
   - Pre-registers `ludy_*` table entries in `PENDING_TABLES` / `PENDING_EXCEPTIONS` where `rls-matrix` / `conformance` compare exact table/trigger lists, and fixes the `ALTER ... SET SCHEMA` blind spot in `migration-lint.mjs`.
   - **Solves historical migration replay in `migrate.db.test.ts`:** once a forward migration renames `crove_kernel` -> `ludy_kernel` (`#3970`) and module schemas (`#3971`), re-executing early files like `20261013120000_crove_kernel_bootstrap.sql` against the migrated DB would re-create `crove_kernel` and `crove_app` and fail `fingerprintDiff`. In `#3969`, `migrate.db.test.ts` establishes an explicit cutover checkpoint boundary:
     - Pre-cutover baseline migrations remain verified by applying on a fresh DB up to the pre-cutover ledger version and checking idempotent replay there.
     - Post-cutover idempotency replays every forward migration at or above the cutover version cleanly and additionally verifies **schema/role/privilege equivalence** between (a) a fresh empty DB running all migrations end-to-end and (b) a DB first migrated up to the pre-cutover snapshot (simulating live pilot) and then upgraded through the `#3970`/`#3971` cutover migrations.
2. **Step 2b & 2c (`#3970` core DB/runtime, `#3971` module schemas):**
   - Use `ALTER SCHEMA crove_<name> RENAME TO ludy_<name>` (preserves all table OIDs, indexes, constraints, composite FKs, and tenant data in place without `DROP SCHEMA`, compatibility `VIEW`s, or table rewrites), preceded by `-- ludy:contract adr=0054` (recognized by `#3969` `migration-lint.mjs`).
   - Restate all SQL routines whose bodies reference `crove_<schema>.*`, `current_setting('crove.*')`, `'crove\_%.%'`, or `pg_notify('crove_*')` with `SET search_path = pg_catalog, pg_temp`, explicit `OWNER TO` (`ludy_definer_tenant` / `ludy_auth_reader` / `ludy_definer_einvoice`), and `REVOKE EXECUTE ... FROM PUBLIC` (respecting `hot-table-retry` `lock_timeout = '2s'` loops whenever locking hot kernel/jobs tables).
   - Register `ludy_*` roles in `LUDY_ROLES` and `ludy_kernel.ddl_watch()` before use so `CROVE_SHARED_DATABASE=true` / `LUDY_SHARED_DATABASE=true` (`isolateFromForeignRoles` and `hardeningViolations`) stay green.
   - Regenerate `packages/db/src/generated/database.ts` via `pnpm db:types` in the same PR as each SQL change.
   - Update `packages/db`, `packages/kernel-runtime`, `apps/kernel`, `modules/*`, `tools/deploy/deploy.sh`, and backup scripts in lockstep.
3. **Zero-downtime deploy caution for `deploy.sh`:**
   - Because `#3970` and `#3971` rename live PostgreSQL schemas that running containers query, rolling releases carrying `#3970` / `#3971` stop `api` and `worker` (short maintenance window in the pilot deploy runbook) while `migrate` applies the schema/role rename, before starting the updated containers and switching `.env` under `#3972`.

### 4. Shared-core governance and coordination

Per [AGENTS.md](../../AGENTS.md) and [docs/product-owner-config.md](../product-owner-config.md):
- Every PR touching `shared-core` files (`package.json` policies where applicable, `.github/workflows/**`, `tools/ci/**`, `tools/deploy/**`, `packages/kernel-runtime/src/**`, `packages/db/**`, kernel SQL / roles, `http.ts` / `auth*` / `sessions*`, or invariant loosening) carries the `shared-core` label and requests Platform PO (`line:platform`) review (`Request: Shared-core review (Platform PO)`).
- Every PR changing protected paths passes an independent security review on final head.
- Advance rebase notices before merging sweeping PRs (`#3965` `@ludy/*` packages, `#3970` core DB, `#3971` module DBs) are posted on [#1210](https://github.com/DOS/Ludy/issues/1210).

## Consequences

- `main` remains clean, deployable, and green on every single PR (`#3964` -> `#3972`) without one giant unreviewable 3,000-file diff.
- Historical data on pilot and sandbox deployments (`subject-vault`, WORM archives, backups, migrations ledger) remains 100% readable.
- External GitHub check-run names already wired into workflows/scripts remain stable until any explicit workflow update decides otherwise, avoiding silent release/merge blocks.
- See [brand-phase3-identifiers.md](../plan/brand-phase3-identifiers.md) for the exact step-by-step execution plan and PR verification gates.
