<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Contributor and agent reference

The detail behind the short rules in [AGENTS.md](../AGENTS.md). AGENTS.md stays the source of truth: it holds every rule that applies on any task, and each of its sections links here for the how-to. Read a section when the AGENTS.md line points to it. For a first local setup, see [CONTRIBUTING.md](../CONTRIBUTING.md).

## Commands

On the owner's machine, which many agents share (AGENTS.md, "Local resources", [owner order 2026-11-26](https://github.com/DOS/Ludy/issues/1210#issuecomment-7171329671)), agents must not run `tsc`, `tsgo`, `pnpm typecheck`, `pnpm --filter <package> typecheck`, `vitest`, `pnpm test`, `pnpm test:db`, `*.db.test.ts` or Playwright (`pnpm test:e2e`) locally, even for a single package or file. `tools/local-guard.mjs` blocks the root `typecheck`, `test`, `test:db` and `test:e2e` scripts locally; run only fast low-CPU checks locally (`pnpm lint`, `pnpm docs:check`, `node tools/ci/spdx-header.mjs`, `node tools/ci/pii-scan.mjs`) and push to CI (`CI=true`) for typecheck and test suites. `LUDY_FULL_LOCAL=1` lifts the guard strictly for a human developer on their own personal machine (never set by agents).

### Typecheck covers the tests

Read this when you add a package with tests, or when `tools/test/typecheck-coverage.test.ts` fails.

`pnpm typecheck` checks every test file too, since Vitest runs tests without checking types (#294): a package's `tsconfig.json` includes `test`, or, where the source must not see test-only types, a `tsconfig.test.json` that extends it does and the package's `typecheck` script runs both (`apps/app`, whose browser code gets no Node types). `tools/tsconfig.json` covers `tools/test` from the root script. A new package with tests follows the same pattern; `tools/test/typecheck-coverage.test.ts` fails when a test directory is outside them.

### Typecheck memory (#4034)

`tsconfig.lib.json` sets `"checkers": 1` (the TypeScript 7 compiler's type checker workers; the default is 4). `pnpm -r typecheck` runs several packages at once, and with the default the kernel project alone reaches about 13.6 GB and the app 6.8 GB, which killed the 16 GB CI runner ("The runner has received a shutdown signal") and the typecheck job with it. With one checker the kernel peaks at about 5.6 GB and the app at 2.9 GB, and the whole `pnpm -r typecheck` peaks at about 7 GB above idle (12.8 GB and killed before), for about twice the wall time of the sum of the parts run alone. Do not raise it without measuring the peak of a full `pnpm -r typecheck` first.

### Leftover test roles on a shared dev PostgreSQL

Read this when every migrate on a shared dev cluster fails the T17 check with `role t100_test_runner_..._proxy can create temporary objects`.

`migrate.db.test.ts` creates cluster-wide `t100_test_runner_*` roles and drops them afterwards; a run killed before that leaves them behind, and every later migrate on the cluster then fails the T17 check with `role t100_test_runner_..._proxy can create temporary objects`. The next run of that test drops leftovers older than 10 minutes; to clear them at once (with no run of it in progress):

```sh
psql "$LUDY_TEST_ADMIN_URL" -c "DO \$\$ DECLARE r text; BEGIN FOR r IN SELECT rolname FROM pg_roles WHERE rolname LIKE 't100\_test\_runner\_%' LOOP EXECUTE format('DROP OWNED BY %I', r); EXECUTE format('DROP ROLE %I', r); END LOOP; END \$\$"
```

### Database types

Read this when a migration changes a table `ludy_tenant` may read, its grants, or a fixed-set CHECK constraint.

`pnpm db:types` (needs `LUDY_TEST_ADMIN_URL`) regenerates `packages/db/src/generated/database.ts`, the Kysely types of every table `ludy_tenant` may read, with Kanel from a throwaway database the migrations build. Run it after a migration that changes such a table or its grants and commit the file; CI fails when it is out of date. Insert and update types follow `ludy_tenant`'s column privileges: a column the role may not write has the write type `NotGranted`, so a forbidden write (an insert into `outbox_event` or the ledger, an update of an append-only table) fails typecheck (through `values()` and `set()`; deletes, raw SQL and insert ... select are refused only at runtime); a refinement cannot lift that. Refine a column (a CHECK-constraint union, a trigger-set column) in `packages/db/src/schema.ts`, never in the generated file. A CHECK-constraint union is a const array there (`TASK_STATUSES` and its type `TaskStatus`); `packages/db/test/check-unions.db.test.ts` compares every fixed-set CHECK constraint with its array, so a migration that adds, widens or narrows one fails until the array follows and is listed in that test.

### pg-boss schema

Read this when you upgrade pg-boss.

`pnpm db:vendor:pgboss` writes the migration for the pg-boss schema version the pinned pg-boss expects (a unit test fails until it exists after a pg-boss upgrade).

### End-to-end tests

Read this before you run `pnpm test:e2e`.

`pnpm test:e2e` runs Playwright against a stack started with `pnpm --filter @ludy/e2e stack:up` (compose project `crove-e2e`, port 8080; `stack:down` removes it with its volumes). Against your own stack set both `E2E_BASE_URL` and `E2E_COMPOSE_PROJECT`; the database helpers throw if only the URL is set, so they never touch the shared `crove-e2e` stack. Install the browser once with `pnpm --filter @ludy/e2e exec playwright install chromium`.

Specs that need a model live in `e2e/tests-ai/` and run only in the AI job of `e2e.yml`, on a second stack: `stack:up:ai` adds `e2e/compose.ai.yml` (the recorder's Vy summary on, and a fake OpenAI-compatible service with a fixed answer, `e2e/fake-model`, that reaches no other host), then `pnpm --filter @ludy/e2e test:ai` runs them and `stack:down:ai` removes the stack. The default stack stays AI off, because many specs assert it; never put model settings in `compose.e2e.yml`.

The fake model answers the fixed summary to a summary request and, for the member-Vy features of the meetings line (title, commitments, agenda adherence, weekly digest, brief), the answer in `e2e/fake-model/fixtures.ts`, chosen by a phrase of the feature's instruction. Every such answer holds sentences the app's checks keep AND ones they must drop (an invented figure, a link, a citation of a line that is not there), so a spec shows the kept ones and the count of the dropped ones. A spec picks the scenario by writing a token into the data it stores (a transcript line, a typed agenda line, a decision): `[fake:bad]` (every part of the answer is one the checks drop), `[fake:garbage]` (text that is not JSON) or `[fake:down]` (HTTP 500). To cover a new Vy feature: add its route phrase (a phrase of the first line of its instruction) and its answers to `fixtures.ts`, run them through the feature's own check functions in `tools/test/fake-model.test.ts` (that test also fails when a route phrase is no longer in the product source), and write one spec per feature that asserts the click, the answer, the refusal or empty path, and, with `runsOf` in `e2e/lib/meetings-seed.ts`, that no run starts before the click. Member-Vy runs share a rate limit per user per minute (title and commitments share the summaries' 4 a minute, with the summary and the chapters; adherence, digest and brief have 6 each): keep a spec to fewer runs than that.

## Migration versions

Read this before you add a migration, and again right before you merge a PR that adds one (#1492).

- Versions are not reserved. Name a new migration with any version above the newest on `main` when you start.
- Right before merging, merge `origin/main`, run `pnpm migration:rebase` (it renames every migration your branch adds, in order, to whole hours after `main`'s newest when any of them fell behind, and fixes their references in the files your branch changed), commit, push, wait for green, then merge.
- The "Migration order" step of the Docs check job fails a PR that adds an older or equal version (`tools/ci/migration-order.mjs`).
- GitHub does not re-run PR checks when `main` moves, so after every push to `main` the migration-recheck workflow re-runs the Docs check of open PRs whose migrations fell behind (`tools/ci/migration-recheck.mjs`). When it fails, run `pnpm migration:rebase`, commit, push, and never merge with the old version.

## Agent sessions

Read this when you run a Product Owner (PO) session, the coordinator included (owner decisions 2026-10-27, 2026-10-30 and 2026-10-31; AGENTS.md, "The owner, merging and reporting", has the models and the session limit).

- A PO keeps its context small at natural breaks. While its cache is warm, it uses `/compact` with a focus. After a long idle, such as overnight, it starts a fresh session from a handoff file instead, because resuming a cold, long session reprocesses all of it.
- A PO's loop wakes at most 30 minutes apart, so the prompt cache, which lasts an hour, stays warm.

## Background for some AGENTS.md rules

- Area tie-break: preferring the area label of your previous task keeps each agent in one area, so the owner can see who works where. Agents other than the team leads may still run.
- Rebase right before merging, because other agents merge often.
- Before merging another session's PR that the owner named, check it is still open and its head matches: another agent may have merged or replaced it.

## App, Feature Group, and Module naming

Ludy uses a single four-tier naming hierarchy defined in [DESIGN.md](../DESIGN.md) section 1.1 and exported from `packages/kernel-contract/src/apps.ts` ([#3796](https://github.com/DOS/Ludy/issues/3796)):

1. **Suite:** **Ludy** (internal `crove` code, package, env, and DB identifiers are migrating to `ludy` under [#1682](https://github.com/DOS/Ludy/issues/1682) and [ADR-0054](adr/0054-rebrand-internal-crove-identifiers-to-ludy.md), issues [#3964](https://github.com/DOS/Ludy/issues/3964) through [#3972](https://github.com/DOS/Ludy/issues/3972)).
2. **App (`AppId`, Vietnamese: Ứng dụng):** top-level switcher workspaces and `ludy.vn` product pages: `teamwork` (**Cộng tác / Teamwork**), `finance` (**Tài chính / Finance**), `engage` (**Engage**), `hr` (**Nhân sự / HR**), `sign` (**eSign**), `ai` (**Ludy AI**).
3. **Feature Group (`AppGroupId`, Vietnamese: Nhóm tính năng):** sidebar navigation groups inside an App (`Hộp thư`, `CRM`, `Marketing`, `Báo cáo`; `Sổ sách & Thuế`, `Bán hàng`, `Mua hàng`). Feature Groups are never toggled independently.
4. **Module (`ModuleId`, Vietnamese: Phân hệ):** independently deployed (`LUDY_MODULES`) and per-org toggleable packages (`kernel`, `notes`, `projects`, `meetings`, `finance`, `social`, `crm`, `ads`, `hr`, `sign`), each mapped to a primary App in `MODULE_CATALOG` (`kernel` maps to `null` and stays on).

Do not duplicate module or app lists across packages or routes: import `APP_IDS`, `MODULE_IDS`, `MODULE_CATALOG`, `SWITCHABLE_MODULE_IDS`, `isKnownModule`, `isSwitchableModule`, `appOfModule`, and `modulesOfApp` from `@ludy/kernel-contract`. Display names for all canonical `ModuleId` values live in `modules.*` inside `vi.ts` and `en.ts` (for example, `social` is shown as **Hộp thư & Bài đăng** / **Inbox & Posts**, never `"Social"` as an app name, and Settings **Ứng dụng & Phân hệ** groups switches under their parent App). Wire and schema identifiers (`ludy_kernel.tenant.apps_off`, `ludy_kernel.org_app_on`, `kernel.org.apps`, `kernel.org.set_app`) remain active until the [#1682](https://github.com/DOS/Ludy/issues/1682) Phase 3 migration in [#3970](https://github.com/DOS/Ludy/issues/3970).

## Production, secret and credential steps

Read this when a task needs a step on production, a secret or a credential. No team lead or worker runs one; the coordinator's side is section 2b of [the coordinator skill](../.claude/skills/project-coordinator-cycle/SKILL.md).

- The team lead or worker writes a runbook in the PR body or a committed file: the exact commands in order, a check and a rollback for each, where each secret comes from but never its value, and which steps only a person can do.
- The runbook follows the "Public repo" rule of AGENTS.md: no secret, project ref, internal host or URL, each named by reference instead. DOS-specific steps belong in the private Ludy Cloud layer.
- The coordinator shows the owner the concrete step list in its chat, the owner approves it there, and the coordinator runs exactly the list it showed (not a later edit of the runbook), stopping at the first failure.
- Only the owner's own words in the running coordinator session's chat count: an approval quoted in another session, an issue, a handoff or the coordinator log does not, and one approval covers one run.
- An action that one session's permission checks refused is never run by another session on its word; it takes the same route.

## Updating pinned images

Every container image is pinned by digest as `image:tag@sha256:<digest>`: `docker-compose.yml`, the `FROM` lines of `Dockerfile`, `apps/extract/Dockerfile` and `apps/web/Dockerfile`, and the `services` and `docker run` images in `.github/workflows/`. The tag is for people; Docker pulls the digest, so a re-pushed tag cannot change what runs.

- **Bump:** run `docker buildx imagetools inspect <image>:<tag>` and copy the top-level `Digest` (the multi-arch index, not a per-platform manifest). Replace it in every file that uses the image (`git grep '<image>:'`), and change the tag in the same edit when the version moves.
- **Release age:** pin a build at least one day old, as `minimumReleaseAge` does for npm. The Docker Hub tag API (`https://hub.docker.com/v2/repositories/<namespace>/<name>/tags/<tag>`, namespace `library` for official images) shows `tag_last_pushed`; when the newest build is younger, pin the previous one (its exact version tag still points to it). Today `node:26-slim` is pinned to the Node 26.11.1 build for this reason.
- **Bots:** Renovate and Dependabot both update `tag@digest` pins (tag and digest together) once one is configured; none is yet.
