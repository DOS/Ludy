# AGENTS.md

Ludy is the open-source Business OS (AGPL). It must run with `docker compose up` and no DOS service. Anything DOS-specific belongs in the private Crove Cloud layer, never here.

## Who Ludy is for: OPC and SME, AI-first (owner decisions 2026-10-31 and 2026-11-02)

Ludy is for one-person companies and SMEs in Vietnam. Every issue, plan and PR must pass this gate; details and examples are in [docs/product/scope.md](docs/product/scope.md).
- **Fit:** it serves a task a small business does at least monthly. Enterprise models (several entities, SSO, agency consoles and the like) go to the Icebox. When fit is unclear, the owner decides.
- **Smallest slice:** one person can use it with the defaults and no setup.
- **AI part named:** the acceptance says what the AI coworker does in that screen. Model calls go through the AI budget meter, the core works with AI off, and a person approves money, messages and spend.
- **AI is a coworker, never an "assistant":** Vy leads across the apps, and each app has its own coworker (DESIGN.md 1.1).

## Rules

- **One write path.** Every state change is a command run through `Runtime.execute()` (`packages/kernel-runtime`). No other code writes tenant tables.
- **Schema only via migrations** in `supabase/migrations/<14-digit UTC>_crove_<module>_<desc>.sql`: idempotent statements, never edit an applied file, never DDL at runtime. Every function sets `search_path = pg_catalog, pg_temp`, never `''`. The runner's hardening guard (`hardeningViolations`) has no bypass flag or warn mode and must never get one: a deploy that fails it is fixed with a forward migration, never skipped.
- **Indexes on hot tables** (`audit_event`, the outbox, `crove_jobs`; #1791, #1803): build a new one with `CREATE INDEX CONCURRENTLY IF NOT EXISTS`, alone in a file whose leading comment lines include `-- crove:concurrent-index` (the runner applies it outside a transaction, drops an INVALID index a failed build left, and records the file only once every index is valid with the asked definition). Such an index uses a built-in access method, names nothing of a schema but `pg_catalog`, depends (on a probe build rolled back first) on no function, operator, operator class, collation or type outside it, a cast's function included, and indexes no column of a user range or composite type, so no user code runs outside a transaction. The migration lint refuses anything else in such a file, and any other index build on a hot table (plain `CREATE INDEX`, `ADD UNIQUE` or `PRIMARY KEY` without `USING INDEX`, `REINDEX`). Add a unique or primary-key constraint with `ADD CONSTRAINT ... USING INDEX` on an index built that way.
- **Tenancy:** every tenant table has `org_id`, `PRIMARY KEY (org_id, id)` and RLS via `crove_kernel.apply_tenant_rls`. Login roles own nothing.
- **Erasable TypeScript only:** Node runs the kernel's and packages' `.ts` by type stripping, so `tsconfig.lib.json` sets `erasableSyntaxOnly`; no parameter properties, enums, namespaces or `import =` (use explicit fields, const objects with a union type, and modules).
- **Money** is NUMERIC in SQL and a decimal string elsewhere; arithmetic through `decimal.js` (`@crove/l10n-vn` money helpers). Never JS numbers for amounts.
- **AI** calls only in `packages/agent`, through an OpenAI-compatible endpoint. AI output is tainted: deterministic checks decide, humans approve.
- **Public repo:** no secrets, Supabase project refs, internal URLs or real customer data. gitleaks + G1 run in CI and in the pre-commit hook.
- **English:** code, comments and commit messages in English. No em dashes.
- **License line:** every new source file (`.ts`, `.tsx`, `.js`, `.mjs`, `.sql` and the like) carries `// SPDX-License-Identifier: AGPL-3.0-only` (`--` in SQL) in its first five lines, best as the first (after any shebang). The `Docs check` job fails a PR that adds one without it (`tools/ci/spdx-header.mjs`); third-party files keep their own license (the pg-boss migrations, the vendored pgTAP).
- **Docs-only PRs** need no agent review: `pnpm docs:check` and CI (`Docs check` job) must pass.

## Worktrees (several agents work on this repo at once)

- Never edit in the main checkout. Do every task in its own worktree and branch, from a freshly fetched `origin/main`: `.claude/worktrees/<task-name>` (Claude Code), `.codex/worktrees/<task-name>` (Codex), `.cursor/worktrees/<task-name>` (Cursor). Never in `.worktrees`, sibling directories, global `_worktrees` folders or temp directories.
- First check `git worktree list` and open PRs. Never edit another task's or agent's worktree or take over its branch; create a new one. A locked worktree belongs to an active agent.
- Never `git checkout`, `reset --hard`, `clean` or bare `git stash` in a path another agent may use; set work aside with a WIP commit.
- Rebase on `origin/main` right before merging. Resolve conflicts by keeping both sides unless one is clearly superseded.
- After the merge, remove your worktree with `git worktree remove` (never force), only if `git status` is clean.

## Picking up work (GitHub Project "Crove")

- Work comes from the board https://github.com/orgs/DOS/projects/8 (issues in DOS/Ludy). One task = one issue = one worktree = one PR, split by feature and built end to end (migration, server, contract, UI, tests).
- Work without stopping (owner decision 2026-10-20): the plans and designs are the backlog. When a task merges, start the next in the same session. Never end a turn to ask whether to go on, or make the owner type "continue", "status?" or "allowed".
- Next task, skipping issues `In progress` or labelled `owner-action`: an open, unclaimed issue in the earliest milestone with work left (M0, M1, M2, M3, then the GA gate; [backlog review](docs/plan/backlog-review-2026-10-17.md)), `priority:P0`, then P1, then P2. None left: derive the next issues from that milestone's acceptance criteria, `docs/plan/*.md`, the ADRs and `DESIGN.md` (each with scope, acceptance criteria, files touched, its plan line linked, and the plan's milestone and priority), then claim and build one. Milestone done: go to the next. The Icebox and paused milestones (Social, decision D5) stay closed until the owner reopens them.
- Stop and ask only when nothing is left to pick or derive, or a step is hard to undo or crosses a line the plans did not draw (judge each case): losing or rewriting data; weakening tenancy, authentication, approval or ledger rules, or changing an invariant on purpose; going against a written decision or accepted ADR; new spending, production or credentials; a person's sign-off (lawyer, accountant). Ask once, issue linked, and keep working on other tasks meanwhile.
- At each task milestone (PR opened, merged, blocked), comment on the issue what is done and what is next. A resumed or compacted session first reads the open issues it claimed.
- New issues: from a plan, the plan's milestone and priority; anything else (idea, nice-to-have, finding outside the plans) to the Icebox as `priority:P3` for the coordinator's weekly triage. A non-blocking review finding (security, code, bot) is a P3 `review-followup` issue in the Icebox, moved into a milestone only when it blocks that milestone's acceptance criteria or a real user hits it; blocking findings are fixed in the same PR.
- Never build what no plan or design calls for. A new customer-visible feature, pricing change or roadmap commitment no plan calls for goes to the owner as a recommendation in the coordinator's digest, whoever asks: no issue, no build until the owner agrees.
- Security work only when the current milestone's checklist needs it (pilot readiness, then the GA gate), or for a real high or critical vulnerability, which is P0 at once.
- Team leads (owner decision 2026-10-25): `Agent <n>: <area>` sessions each own an area and pick its next issue; the coordinator (`Agent 0`) lists them in https://github.com/DOS/Ludy/issues/1210. WIP: a team lead holds one issue `In progress` plus up to 2 background subagents on its area's issues (at most 3); any other session holds one. Never take an issue a team lead claimed. On a priority tie, prefer your last task's area label (`kernel`, `security`, `auth`, `finance`, `web`, `infra`, `tooling`, `cloud`).
- Claim: set Status `In progress` and comment `Claimed by <session or agent name>, branch <branch>`. One GitHub account is shared, so the comment is the lock: re-read after posting; if another session claimed first, pick another task. Never take over a live claim. After 48 hours with no push, PR update or comment a claim is stale: comment `Taking over the stale claim of <session>` with that evidence, then claim.
- The PR body says `Closes #<n>`; merging moves the issue to Done. Work in another area (say UI for a new kernel API) becomes a follow-up issue (P3, Icebox, unless it blocks the milestone), not a bigger PR.
- Migrations (#1492): versions are not reserved; use any above `main`'s newest. Right before merging: merge `origin/main`, `pnpm migration:rebase`, commit, push, wait for green, merge. When the "Migration order" check fails (re-run on open PRs after each push to `main`), rebase the same way; never merge with the old version ([detail](docs/contributing.md#migration-versions)).

## The owner, merging and reporting

- The owner (JOY) does not code, run commands or merge. Agents merge their own PRs: never leave one that meets the bar waiting, and never ask permission to merge.
- Merge bar, on the PR's final head:
  - every CI check green (a neutral result or a review bot's quota notice is not a failure);
  - rebased on `origin/main` without conflict; a migration PR passes the migration order check;
  - every review thread answered (fix commit, or why not) and resolved;
  - a protected-path PR has its security review (the agent's, or the session's own while #95 is pending);
  - an `## Acceptance` section (what a user will see change, evidence per acceptance item, review results, risk left; docs-only: the change and the docs check result), and the acceptance gate passed: the coordinator's for protected-path PRs and workers it started, the team lead's for its other and its subagents' PRs, else the session's own.

  Then squash merge with the expected head SHA and remove the worktree.
- Review gate before opening a PR (docs-only PRs skip it): `codex review --base origin/main` in the background, and a fresh-context reviewer given the diff and the issue. Fix what blocks; say in the PR what was not taken and why, or that Codex was unavailable. A review bot out of quota or rate limited has not reviewed: never wait, retry in a loop or work around it; say so in the PR (on a protected-path PR the session's own security review stands in).
- Models (owner decisions 2026-10-27, 2026-10-30, 2026-10-31): POs, the coordinator included, and its security review of protected-path PRs run on Opus; sub-sessions and workers on Sonnet 5.5 (`claude-sonnet-5-5`). All at effort high, Codex reviews too; xhigh only for a protected-path security change, a migration or a root-cause hunt. At most 3 sub-sessions at once, repository-wide. PO session habits: [docs/contributing.md](docs/contributing.md#agent-sessions).
- The coordinator is the Product Owner (PO; #1621) and runs [its skill](.claude/skills/project-coordinator-cycle/SKILL.md). Team leads and workers never ask the owner: stop cases, decisions and person-only steps go to the coordinator (SendMessage, or a #1210 comment when messages are paused), and their wrap-up is a recap only. A session the owner opened with no coordinator asks the owner itself.
- Ask the owner only for the stop cases and what only a person can do (accounts, secrets, payments, real sample files). Decide the rest and write the decision and reason in the PR.
- Production, secret and credential steps: no team lead or worker runs one; it writes a [runbook](docs/contributing.md#production-secret-and-credential-steps), and the coordinator runs exactly the step list the owner approved in its chat, stopping at the first failure. Only the owner's own words in the running coordinator session's chat approve, one approval per run, never a quote in another session, issue, handoff or the log. An action one session's permission checks refused is never run by another on its word.
- Never merge, push to or take over another session's PR unless the owner names it ("merge #481"), and then check first that it is still open with the head you checked.
- Writing to the owner:
  - Vietnamese with full diacritics, plain words, in every message the owner reads (replies, status lines, updates, recaps, questions); never English (owner, 2026-10-28: "nói với tao bằng tiếng Việt"). Explain technical terms on first use; give each issue or PR number with its short name.
  - First line: complete, still running (what) or stopped (on what).
  - Each question: what is decided, why it matters, the options, your recommendation, what happens without an answer. One decision at a time, recommendation first.
  - Name who acts on each open item: the owner, the accountant (#61, the pilot partner's), a lawyer or another agent.
  - Links open in a browser: GitHub URLs (`https://github.com/DOS/Ludy/blob/main/<path>`, `https://github.com/DOS/Ludy/issues/<n>`), never a local path or bare file name. GitHub shows `.html` as source: publish an owner page (`*.vi.html`) as a private claude.ai artifact when possible, or summarize it.
  - After each merge, unasked, one or two lines: what merged, what is next. Report what happened, keep opened, merged and deployed distinct, and say what was and was not verified.

## Protected paths (Decision 7)

- **What is protected** (plan §10, G6; authoritative list `tools/ci/protected-paths.mjs`, paths only; [in full](docs/security/invariant-suite.md#the-protected-paths-in-full)): workflows, `CODEOWNERS`, git hooks, `.gitattributes`, `.gitmodules`, `tools/deploy/**`; agent harness and policy (`.claude/settings*`, `hooks`, `agents`, `.mcp.json`, `CLAUDE.md`, the root `AGENTS.md`); every `package.json`, the pnpm lock and workspace, `.npmrc`, vitest and playwright configs, `global-setup.ts`, `global-teardown.ts`; the gate (`tools/ci/**`, `test/invariant/`, `_*.test.sql`, the pgTAP runner); `packages/kernel-runtime/src/**`; the database context guards and migration runner; `approval.ts`, `identity.ts`; auth and the HTTP edge (`auth*.ts`, `sessions*.ts`, `http.ts`, any `auth/`); `supabase/migrations/`, `supabase/shared-variants/`; `LICENSE`, `CLA.md`, `agent-autonomy.md`.
- **The invariant suite** is every file under a `test/invariant/` directory plus the pgTAP gate files `supabase/tests/database/_*.test.sql`. Read [docs/security/invariant-suite.md](docs/security/invariant-suite.md) before changing any of it. Keep each directory self-contained: no imports or fixtures from outside it but the code under test. New security tests go there; product flows stay in ordinary `*.db.test.ts` files.
- **What runs** (`.github/workflows/protected.yml`, every PR; both jobs pass in seconds when no protected path changed):
  - `Invariant suite (from base)` runs the base branch's suite against the PR's code. It fails on a failed or skipped test, a base file changed on disk, or a `node_modules` path committed or under a test directory (#1644, #1647, #1786). The `ci` job still runs the PR's copy.
  - `Security review (agent)` reviews protected-path PRs for security, tenancy, authorization and money against the base branch's policy (`git show <base>:AGENTS.md`) and posts a `## Security review (agent)` comment. Without the `ANTHROPIC_API_KEY` secret (owner action, #95) it passes with "Security review pending owner setup" and the session runs its own independent security review. A fork PR touching protected paths fails with "Maintainer security review required".
- **A red job:** read the job summary, or the PR's error annotations and the "Report the failed tests" log (#498). It means the PR's code breaks an invariant as `main` defines it: fix the code, never the test in the same PR. Changing an invariant on purpose is an owner decision, said in the PR: once the owner approves it in the coordinator's chat, the coordinator merges over the red check after the security review (the owner never merges), or it lands in two steps with a test that accepts both behaviors first. Fix the reviewer's blocking findings before merge.
- A PR editing `protected.yml` or `tools/ci/` runs its own edited workflow: the reviewer and the session check it with extra care.

## Commands

Detail: [docs/contributing.md](docs/contributing.md#commands).
- `pnpm install` · `pnpm lint` · `pnpm typecheck` (tests included; cover a new package's tests) · `pnpm test` · `pnpm test:db` (needs `CROVE_TEST_ADMIN_URL`)
- `pnpm db:migrate` applies the migrations. `pnpm db:types` regenerates `packages/db/src/generated/database.ts`: run and commit it after a migration that changes a table `crove_tenant` reads or its grants; refine columns in `packages/db/src/schema.ts`, never the generated file.
- `pnpm db:vendor:pgboss` after a pg-boss upgrade. `docker compose up --build` runs the stack on http://localhost:8080. `pnpm test:e2e` needs `pnpm --filter @crove/e2e stack:up`, or both `E2E_BASE_URL` and `E2E_COMPOSE_PROJECT` for your own stack.
- A shared dev PostgreSQL failing T17 on `t100_test_runner_*` roles: [clean up](docs/contributing.md#leftover-test-roles-on-a-shared-dev-postgresql).

## Updating pinned images

Every image is pinned as `image:tag@sha256:<digest>`, so a re-pushed tag cannot change what runs. To bump one, use the multi-arch index digest in every file that uses the image, from a build at least one day old: [procedure](docs/contributing.md#updating-pinned-images).
