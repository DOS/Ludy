# Product Owner config: DOS/Ludy

Repository-specific values for the shared `product-owner` and `task-claim` skills of the cc-po plugin, the same
skills DOS/DOS.AI and DOS/DOS.Me use. The keys and their defaults are in the plugin's
`product-owner/config-schema.md`; check this file with its `check-config.mjs`. Sessions read this file at run time
and it carries JOY's authority, so a change to it is a change to agent instructions, not a docs-only change.

## Owner and reporting

- owner_name: JOY
- owner_profile: the repository owner, a non-coder who does not code, run
  commands, read diffs or merge. Agents own technical decisions and merge
  their own PRs once they meet the merge bar; they bring JOY only material
  product, business, risk and Production decisions, one at a time, in plain
  words.
- report_language: Vietnamese with full diacritics, in plain words; explain
  a technical term in Vietnamese the first time it is used, and give every
  issue or PR number with its short name. The first line says whether the
  work is done, still running (and what) or stopped (and on what). Code,
  comments, commits, PRs, issues and messages to other agents stay in
  English, with no em dashes.
- agent_account: every runtime posts as the JOY GitHub account, so
  Assignees stay empty; the claim comment is the lock (AGENTS.md).
- Owner decision 2026-11-10 (Platform PO chat, relayed by the Platform PO to
  this record): "Tại sao phải chờ tao? Tao có biết code đâu mà chờ?" (Why
  wait for me? I do not know the code.) A PO merges its line's PRs itself
  once its own review passes and CI is green on the final head, and does not
  ask JOY first, a Vy hardening PR included. Unchanged: Production, secret
  and credential steps still need JOY's own approval in the coordinator's
  chat, one approval per run (AGENTS.md), for example granting a bucket key a
  new permission such as `s3:PutObjectTagging` or applying a lifecycle rule
  to a real bucket. A sub-session still does not merge.

## Board

- project_url: https://github.com/orgs/DOS/projects/8 (Ludy)
- project_owner: DOS
- project_number: 8
- project_id: PVT_kwDOA388Vc4BhIzl
- product_line_field: PVTSSF_lADOA388Vc4BhIzlzhn4WEI (options in Lines)
- priority_field: none (priority is the `priority:P0` to `priority:P3`
  labels, see AGENTS.md)
- sprint_field: none
- bot_owned_fields: none

JOY chose 7-day sprints on 2026-10-30. The board has only an old 14-day
`Iteration` field, and creating a new 7-day `Sprint` iteration field from a
session was refused by its permission check. Once JOY or a session with that
permission adds it, set `sprint_field` to `<field id>; Sprint, 7 days` and
turn on `sprint_review` with `line_scopes`.

## Lines

| Line | Label | Product Line option id | PO session |
| --- | --- | --- | --- |
| Accounting (Ludy Kế toán: ledger, VAT, invoices, bank feeds, MISA, `modules/finance`) | `line:accounting` | `c6def6cf` | `Accounting Product Owner` |
| Frontend (UI/UX: the app in `apps/app`, `packages/ui`, the landing page ludy.vn in `apps/web`, the logo) | `line:frontend` | `b395d36d` | `Frontend Product Owner` |
| Notes & CRM (notes, to-dos, bookings and calendar) | `line:notes-crm` | `b8743ac2` | `Notes & CRM Product Owner` |
| Engage (Ludy Engage: Social in `modules/social`, Ads, Hộp thư/Help Desk and the CRM folded in, DESIGN.md 2026-11-03) | `line:social-management` | `735657ce` | `Ludy Engage Product Owner` |
| AI Meeting Notes | `line:meetings` | `8c4c0494` | AI Meeting Notes Product Owner |
| Platform (the shared backend core: kernel, database, tenancy, authentication and sessions, the command runtime, the WORM archive; Vy, the AI general manager; architecture and ADRs; security reviews; CI, deploy and operations) | `line:platform` | `3d3f0729` | `0: Điều phối` (the coordinator session) |

- Social is not paused. Decision D5 was answered by JOY on 2026-10-17 as
  "no for Social" (backlog review, Decision 17), and JOY confirmed on
  2026-11-08 that no pause was ever decided. The line is now Ludy Engage:
  Social, Ads, Hộp thư/Help Desk and the CRM folded in on 2026-11-03
  (DESIGN.md). On 2026-11-01 JOY said "Mở lại, làm FB + Zalo" (#236), which set
  the order of work, the Facebook Page and Zalo OA channels first.
- Owner decision 2026-11-08: "Ok, cho Engage chạy 4 phiên con." The Engage
  line may run up to 4 sub-sessions at once, an exception to the
  repository-wide cap of 3 above for this line.
- Platform owns what every line builds on, not the features: a line's own
  feature stays with that line even when it adds a migration or a kernel
  command. Platform owns the shared core itself, the architecture (ADRs),
  CI, deploy and operations. Its PO reviews the shared-core files of any
  line's PR (below); it does not review or approve the rest of another
  line's PR.
- Owner decision 2026-11-10 (Platform PO chat): "Vy thuộc Platform nha."
  Vy, the AI general manager across every app (DESIGN.md 1.1), belongs to
  the Platform line: the agent core (`packages/agent`, the kernel's agents,
  runs, metering and budgets), member-scoped Vy (ADR-0049, `vy.use`) and
  Vy's own cross-app work. A line's feature that uses Vy (for example
  the meeting summary, or Ly's invoice drafts) stays with that line.
- Owner decisions 2026-11-10 on Vy's architecture and packaging (ADR-0051):
  Vy's agent brain is a DOS Claw agent on work.dos.ai and Ludy is the gate
  (MCP endpoint, deterministic signal rules, signed wake-up webhook); Ludy
  Cloud includes one Vy by default, and the other AI coworkers are paid
  per-org add-ons.
- Owner decision 2026-11-13: slice 3d of the member-bound MCP grant (the first private tool
  and signal for member grants) is deferred, because of the risk of exposing private
  data. No private tool is built; the member catalog stays empty and the scope
  `ludy.member.read` stays dark until the owner reopens it.
- Owner decision 2026-11-11 (Platform PO chat, popup "Đồng ý"): an AI app
  connected over MCP sees full customer and invoice data like a HubSpot or
  Twenty MCP does (person names, email, phone, address, tax code, invoice
  lines), within what the consenting owner or admin can see. Salaries,
  separately stored bank account records and member-private notes stay out.
  The consent screen says so.
- Owner request 2026-11-12: the landing page `apps/web` below the hero is
  visual and plain-language (no accounting jargon), and its numbers band and
  the README's are counted from the repository by `tools/readme-assets.mjs`
  (`--check` in CI keeps them true). Frontend owns the page; the Platform PO
  built it while Frontend had no live PO session.
- Line POs are peers (JOY, Platform PO chat, 2026-11-07: "Tại sao PO khác
  lại phải qua mày mà ko làm việc với tao trực tiếp. Mày chỉ ngang hàng thôi
  mà", then option 1 of the PO's recommendation: "Cách 1 mày đề xuất đi").
  Each PO works with JOY directly and runs the security review and the
  acceptance gate of its own line's PRs, protected-path ones included.
- Each line owns its feature's behavior and data; Frontend owns presentation
  and UX across the apps.

## Issue fields

The DOS organization ids are the same in every DOS repository.

- issue_types: Task `IT_kwDOA388Vc4As2J7`, Bug `IT_kwDOA388Vc4As2J9`,
  Feature `IT_kwDOA388Vc4As2KA`
- org_priority_field: `IFSS_kgDOAOxu8w`; Urgent `IFSSO_kgDOAZ2tDA`, High
  `IFSSO_kgDOAZ2tDQ`, Medium `IFSSO_kgDOAZ2tDg`, Low `IFSSO_kgDOAZ2tDw`
- org_effort_field: `IFSS_kgDOAOxu9g`; High `IFSSO_kgDOAZ2tEA`, Medium
  `IFSSO_kgDOAZ2tEQ`, Low `IFSSO_kgDOAZ2tEg`
- issue_notes: every issue also carries its milestone and a `priority:P*`
  label as AGENTS.md gives them; review follow-ups go to the Icebox as
  `priority:P3` and `review-followup`.

## Rule documents

- agent_instructions: `AGENTS.md`
- task_scope: `AGENTS.md`, "Picking up work" (one task, one issue, one
  worktree, one PR; split by feature).
- tracking_doc: `AGENTS.md`, "Picking up work" (Status `In progress` plus
  the claim comment `Claimed by <session>, branch <branch>`; stale after 48
  hours).
- review_rules: `AGENTS.md`, "The owner, merging and reporting" and
  "Protected paths"; `CONTRIBUTING.md`.
- domain_rules: `AGENTS.md`, "Rules"; `DESIGN.md` for UI and brand;
  `docs/adr/` for accepted decisions.
- roadmap_sources: `docs/plan/backlog-review-2026-10-17.md` (milestones M0
  to M3 and the GA gate), `docs/plan/*.md`, `DESIGN.md`.
- decision_log: https://github.com/DOS/Ludy/issues/1210 (the coordinator
  log; owner decisions are also written into AGENTS.md with their date).

## Branches, environments and gates

- integration_branch: main
- integration_merge: squash
- default_branch: main
- draft_pr_first: no
- production_branch: none
- production_effect: two things ship from `main`.
  - Every merge into `main` deploys the landing page (`apps/web`) to
    Vercel Production on ludy.vn and ludy.so within minutes.
  - The app reaches the pilot instance only through `deploy.yml` on a `v*`
    tag of `main`. Pushing that tag is a Production step that JOY approves
    in the coordinator's chat (AGENTS.md, "Production, secret and
    credential steps").
  - Who pushes the tag (learned 2026-11-11): a cloud session cannot. Its
    git proxy allows writes only to its own branch and pull requests (the
    GitHub API answers "Write access to this GitHub API path is not
    permitted", and `git push` of a tag gets 403), and auto mode refuses a
    Production deploy anyway. So JOY creates the release, or a local
    session on JOY's machine does it with his approval: open
    `https://github.com/DOS/Ludy/releases/new?tag=vX.Y.Z&target=main&title=vX.Y.Z`
    and press Publish. Tag `main` itself: a coordinator that wants an older
    commit pushes it to its own branch first and passes that branch as
    `target`, since the form cannot find a commit by its short SHA.
  - One-time step before the first deploy of a release that carries #2991
    (every tag after `v0.3.1`): link the GHCR package `ghcr.io/dos/ludy-media`
    to the repository (Package settings, "Manage Actions access", as
    `-extract` is), so the read-only deploy token can pull it. Until then
    that deploy fails at pull and changes nothing; rerun it after linking.
  - Release history: `CHANGELOG.md` at the repository root, one section per
    `v*` tag, written by the coordinator when the tag is cut.
- test_environment: none yet (a beta instance from a `dev` branch is
  planned in plan §3.5).

## Checks and review

- required_checks: every CI check green on the final head, including
  "Invariant suite (from base)", which runs the base branch's copy of the
  invariant suite on protected-path PRs; the migration order check for PRs
  with a migration; all review threads resolved. A review bot out of quota
  is not a failure.
- claim_gate: none
- external_review_app: none
- local_reviews: `codex review --base origin/main` in the background, then
  a fresh-context subagent given the diff and the issue; docs-only PRs skip
  both and need `pnpm docs:check`. A protected-path PR also gets an
  independent security review before merge, run by its line's PO with a
  fresh-context Opus reviewer that did not write the change, and a PR that
  changes the shared core also gets the Platform PO's review of those files
  ("Shared-core review").
- shared_core_review: `line:platform`: the paths in "Shared-core review"
  below.
- agent_effort: high. PO sessions run on Opus at effort high. Every sub-session
  runs on Sonnet 5.5 (`claude-sonnet-5-5`) at effort high, and at xhigh only
  for hard work (a protected-path security change, a migration, a root-cause
  hunt). The security review of a protected-path PR runs on
  Opus; Codex reviews at effort high (AGENTS.md, owner decisions 2026-10-27,
  2026-10-30 and 2026-10-31).

## Shared-core review

Every line's PO owns its line's security review. One part of the code is
shared by every line, so a change there also gets a review by the line that
owns it, the Platform PO, in the way a code owner reviews a file: it covers
those files only, it is not an approval of the PR, and the PR's own PO keeps
its acceptance gate, its merge and its questions to JOY.

The shared core:
- `packages/kernel-runtime/src/**` (the one write path, the blob cipher);
- the database context guards and the migration runner (`packages/db`);
- authentication and the HTTP edge: `auth*.ts`, `sessions*.ts`, `http.ts`,
  any `auth/` directory, `approval.ts`, `identity.ts`;
- tenancy and kernel SQL: a migration that creates or replaces a function in
  `crove_kernel` (`apply_tenant_rls`, `org_purge` and the like), changes
  grants or roles, or touches another line's tables;
- the gate: `.github/workflows/**`, `tools/ci/**`, `tools/deploy/**`, git
  hooks, every `test/invariant/` directory outside the PR's own module,
  `supabase/tests/database/_*.test.sql`, the pgTAP runner;
- the agent harness and policy: `AGENTS.md`, `CLAUDE.md`, `.claude/settings*`,
  hooks, agents, `.mcp.json`.

A line's own migrations, tables, module code and its own invariant tests are
not shared core, even though they are protected paths: its PO reviews them.

To ask, the PR's PO comments on the PR `Security review requested (Platform
PO)` with the head SHA and the shared-core files it changes. The Platform PO
answers on the PR with `## Shared-core review (Platform PO)`, naming the head
it reviewed, and repeats it if those files change again.

## Sessions

- sub_sessions_normal: 1 (JOY caps the repository at 3 sub-sessions at
  once, across every line; owner decision 2026-10-31)
- sub_sessions_max: 2

A PO keeps its context small at natural breaks. With a warm cache, it uses
`/compact` with a focus. After a long idle, such as overnight, it starts a
fresh session from a handoff file instead. Its loop wakes at most 30 minutes
apart, inside the one-hour prompt cache (owner decision 2026-10-31).
- check_in_minutes: 30

JOY's standing instructions (work without stopping; the coordinator merges every PR that meets the merge bar) are
in AGENTS.md and the decision log above.
