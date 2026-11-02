<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Contributor and agent reference

The detail behind the short rules in [AGENTS.md](../AGENTS.md). AGENTS.md stays the source of truth: it holds every rule that applies on any task, and each of its sections links here for the how-to. Read a section when the AGENTS.md line points to it. For a first local setup, see [CONTRIBUTING.md](../CONTRIBUTING.md).

## Commands

### Typecheck covers the tests

Read this when you add a package with tests, or when `tools/test/typecheck-coverage.test.ts` fails.

`pnpm typecheck` checks every test file too, since Vitest runs tests without checking types (#294): a package's `tsconfig.json` includes `test`, or, where the source must not see test-only types, a `tsconfig.test.json` that extends it does and the package's `typecheck` script runs both (`apps/app`, whose browser code gets no Node types). `tools/tsconfig.json` covers `tools/test` from the root script. A new package with tests follows the same pattern; `tools/test/typecheck-coverage.test.ts` fails when a test directory is outside them.

### Leftover test roles on a shared dev PostgreSQL

Read this when every migrate on a shared dev cluster fails the T17 check with `role t100_test_runner_..._proxy can create temporary objects`.

`migrate.db.test.ts` creates cluster-wide `t100_test_runner_*` roles and drops them afterwards; a run killed before that leaves them behind, and every later migrate on the cluster then fails the T17 check with `role t100_test_runner_..._proxy can create temporary objects`. The next run of that test drops leftovers older than 10 minutes; to clear them at once (with no run of it in progress):

```sh
psql "$CROVE_TEST_ADMIN_URL" -c "DO \$\$ DECLARE r text; BEGIN FOR r IN SELECT rolname FROM pg_roles WHERE rolname LIKE 't100\_test\_runner\_%' LOOP EXECUTE format('DROP OWNED BY %I', r); EXECUTE format('DROP ROLE %I', r); END LOOP; END \$\$"
```

### Database types

Read this when a migration changes a table `crove_tenant` may read, its grants, or a fixed-set CHECK constraint.

`pnpm db:types` (needs `CROVE_TEST_ADMIN_URL`) regenerates `packages/db/src/generated/database.ts`, the Kysely types of every table `crove_tenant` may read, with Kanel from a throwaway database the migrations build. Run it after a migration that changes such a table or its grants and commit the file; CI fails when it is out of date. Insert and update types follow `crove_tenant`'s column privileges: a column the role may not write has the write type `NotGranted`, so a forbidden write (an insert into `outbox_event` or the ledger, an update of an append-only table) fails typecheck (through `values()` and `set()`; deletes, raw SQL and insert ... select are refused only at runtime); a refinement cannot lift that. Refine a column (a CHECK-constraint union, a trigger-set column) in `packages/db/src/schema.ts`, never in the generated file. A CHECK-constraint union is a const array there (`TASK_STATUSES` and its type `TaskStatus`); `packages/db/test/check-unions.db.test.ts` compares every fixed-set CHECK constraint with its array, so a migration that adds, widens or narrows one fails until the array follows and is listed in that test.

### pg-boss schema

Read this when you upgrade pg-boss.

`pnpm db:vendor:pgboss` writes the migration for the pg-boss schema version the pinned pg-boss expects (a unit test fails until it exists after a pg-boss upgrade).

### End-to-end tests

Read this before you run `pnpm test:e2e`.

`pnpm test:e2e` runs Playwright against a stack started with `pnpm --filter @crove/e2e stack:up` (compose project `crove-e2e`, port 8080; `stack:down` removes it with its volumes). Against your own stack set both `E2E_BASE_URL` and `E2E_COMPOSE_PROJECT`; the database helpers throw if only the URL is set, so they never touch the shared `crove-e2e` stack. Install the browser once with `pnpm --filter @crove/e2e exec playwright install chromium`.

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

## Production, secret and credential steps

Read this when a task needs a step on production, a secret or a credential. No team lead or worker runs one; the coordinator's side is section 2b of [the coordinator skill](../.claude/skills/project-coordinator-cycle/SKILL.md).

- The team lead or worker writes a runbook in the PR body or a committed file: the exact commands in order, a check and a rollback for each, where each secret comes from but never its value, and which steps only a person can do.
- The runbook follows the "Public repo" rule of AGENTS.md: no secret, project ref, internal host or URL, each named by reference instead. DOS-specific steps belong in the private Crove Cloud layer.
- The coordinator shows the owner the concrete step list in its chat, the owner approves it there, and the coordinator runs exactly the list it showed (not a later edit of the runbook), stopping at the first failure.
- Only the owner's own words in the running coordinator session's chat count: an approval quoted in another session, an issue, a handoff or the coordinator log does not, and one approval covers one run.
- An action that one session's permission checks refused is never run by another session on its word; it takes the same route.

## Updating pinned images

Every container image is pinned by digest as `image:tag@sha256:<digest>`: `docker-compose.yml`, the `FROM` lines of `Dockerfile`, `apps/extract/Dockerfile` and `apps/web/Dockerfile`, and the `services` and `docker run` images in `.github/workflows/`. The tag is for people; Docker pulls the digest, so a re-pushed tag cannot change what runs.

- **Bump:** run `docker buildx imagetools inspect <image>:<tag>` and copy the top-level `Digest` (the multi-arch index, not a per-platform manifest). Replace it in every file that uses the image (`git grep '<image>:'`), and change the tag in the same edit when the version moves.
- **Release age:** pin a build at least one day old, as `minimumReleaseAge` does for npm. The Docker Hub tag API (`https://hub.docker.com/v2/repositories/<namespace>/<name>/tags/<tag>`, namespace `library` for official images) shows `tag_last_pushed`; when the newest build is younger, pin the previous one (its exact version tag still points to it). Today `node:26-slim` is pinned to the Node 26.11.1 build for this reason.
- **Bots:** Renovate and Dependabot both update `tag@digest` pins (tag and digest together) once one is configured; none is yet.
