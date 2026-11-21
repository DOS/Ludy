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
- Owner decision 2026-11-13 (Platform PO chat, popup): ask JOY only through
  the `AskUserQuestion` popup, one popup with all the open questions
  together (the tool takes four at most; a fifth waits for the answers),
  never as inline text in a message. Each question still names what is
  decided, why it matters, the options, the recommendation (first) and what
  happens without an answer, in Vietnamese with full diacritics (AGENTS.md).
- Owner decision 2026-11-15 (Antigravity chat): "Cái này hardcode tên model
  thì không hợp lý. Nếu được thì quy định model flagship và model yếu hơn 1
  cách generic thôi nhỉ? Vì hết Claude Opus limit thì làm sao? Trong khi
  Antigravity nhiều limit model Gemini hơn. Tự nhiên Carbon phải chờ Opus
  duyệt khá vô lý" and "Nên sửa cấu hình, ít nhất cho Antigravity để dùng
  model phù hợp". Define PO, security-review and worker models by generic
  capability tier (flagship vs worker) rather than hardcoding vendor model
  names, and configure Antigravity to use `Orchestrator (Carbon)` /
  `Gemini 4 Carbon` for PO sessions and workers. Independent security reviews
  of protected-path PRs run only on `Gemini 4 Carbon` or `Claude Opus` (fresh
  context, with no Hydrogen routing), so a PO on `Gemini 4 Carbon` runs its
  own independent security review without waiting on Claude Opus, while a PO
  on `Orchestrator (Carbon)` holds a protected-path PR's security-review gate
  for a `Gemini 4 Carbon` or `Claude Opus` review (or owner acceptance)
  (updated 2026-11-21 below).
- Owner decision 2026-11-18 (eSign PO chat, popup A2): "Sao mày chạy chỉ 1
  subagent? 3-5 subagent/subession cơ mà?" and popup A2 choice "Cập nhật quy
  tắc chung lên tối đa 5 phiên con song song trong tệp cấu hình dự án". Raise
  `sub_sessions_normal` and `sub_sessions_max` to 5 concurrent sub-sessions
  per Product Owner across all lines, superseding the 2026-11-15 and
  2026-11-16 cap of 3 and Engage's 2026-11-08 cap of 4, while keeping the
  2026-11-17 local-resources rules intact (one heavy command at a time per
  session, scoped `--filter` typechecks and touched-file test runs only, and
  the shared `ludy-pg17-shared` Postgres container).
- Owner decision 2026-11-21 (HRM PO chat,
  https://github.com/DOS/Ludy/issues/1210#issuecomment-7048935611): accepted
  merging PR #4191 (#2720) and PR #4194 (#2691) using their fresh-context
  `Orchestrator (Neon)` (`TypeName: "research"`) independent security reviews,
  and directed updating `AGENTS.md` and `docs/product-owner-config.md` ("Chấp
  nhận gộp PR #4191 và PR #4194 bằng bản rà soát Neon này, đồng thời mở thêm 1
  PR sửa AGENTS.md và docs/product-owner-config.md cho phép nhóm Gemini 4 cao
  cấp (kể cả Neon) chạy rà soát bảo mật về sau" and "Hạn mức còn nhiều lắm, xài
  Neon và làm tiếp đi đừng hỏi vụ này nữa"). On Antigravity, PO sessions, the
  coordinator, workers (via `inherit`), and fresh-context independent security
  reviews of protected-path PRs run at flagship capability tier across
  Antigravity's Gemini 4 flagship and Orchestrator models (such as
  `Gemini 4 Carbon`, `Gemini 4 Neon`, `Orchestrator (Carbon)`,
  `Orchestrator (Neon)`) or `Claude Opus`, while independent security reviews
  run in a fresh context (`TypeName: "research"` on Antigravity, no direct
  `Hydrogen` downgrade/bypass) without needing an identical model codename
  when newer Gemini 4 variants are used; on Antigravity, which has no session
  effort API, the security review's stand-in for `xhigh` is a fresh-context
  flagship-tier review via `TypeName: "research"` on Antigravity's Gemini 4
  flagship or Orchestrator models such as `Gemini 4 Carbon`, `Gemini 4 Neon`,
  `Orchestrator (Carbon)`, `Orchestrator (Neon)`, or `Claude Opus`, with no
  direct `Hydrogen` downgrade/bypass.

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
| Platform (the shared backend core: kernel, database, tenancy, authentication and sessions, the command runtime, the WORM archive; Vy, the AI general manager; architecture and ADRs; security reviews; CI, deploy and operations) | `line:platform` | `3d3f0729` | `Platform Product Owner` (the coordinator session; titled `0: Điều phối` until 2026-11-14) |
| eSign (Ludy Ký kết: electronic signatures, envelopes, templates, audit certificates, `modules/sign`) | `line:esign` | `none` | `eSign Product Owner` |
| HRM (Ludy Nhân sự: payroll, employees, employments, dependents, attendance, leave balances, declarations, HR AI coworker Ly, `modules/hr`) | `line:hrm` | `5130d418` | `HRM Product Owner` |
| Projects & Notes (Cộng tác: projects, task board and list, notes, personal to-dos, My work, `modules/projects`, `modules/notes`) | `line:projects` | `d8c18cec` | `Projects & Notes Product Owner` |

- Social is not paused. Decision D5 was answered by JOY on 2026-10-17 as
  "no for Social" (backlog review, Decision 17), and JOY confirmed on
  2026-11-08 that no pause was ever decided. The line is now Ludy Engage:
  Social, Ads, Hộp thư/Help Desk and the CRM folded in on 2026-11-03
  (DESIGN.md). On 2026-11-01 JOY said "Mở lại, làm FB + Zalo" (#236), which set
  the order of work, the Facebook Page and Zalo OA channels first.
- Owner decision 2026-11-08: "Ok, cho Engage chạy 4 phiên con." Allowed the
  Engage line up to 4 sub-sessions when the cap was 3 (superseded by owner
  decision 2026-11-18 raising every PO line to 5; see Sessions below).
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
- Owner decision 2026-11-13 (Platform PO chat, popup): cut release v0.3.2
  (the `CHANGELOG.md` section "v0.3.2 (2026-11-13)", then a tag, pushed by a
  session that can push tags, see "Branches, environments and gates").
- Owner decision 2026-11-13 (Platform PO chat, popup): build supplier bank
  accounts and approved supplier payments now. They give rule 3 of V5 (a
  supplier's bank account changed while a payment waits) the data it needs;
  the rule stays quiet, and `ludy_signals` lists it as not available, until
  they exist. Accounting owns the build; the design starts as an issue with
  the owner decisions it needs, before any code.
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
- Owner decisions 2026-11-15 (eSign PO chat, #3318, #3319, docs/plan/esign.md):
  - Slice 1 ships self-contained Documenso-style electronic signatures (draw/type signature, optional email OTP via ADR-0034, tamper-evident SHA-256 PDF sealing, independent audit certificate) running 100% locally on `docker compose up` with zero external provider accounts; Vietnamese public CAs (`VNPT SmartCA`, `Viettel MySign`, `MISA WeSign`) sit behind a pluggable adapter in Slice 2.
  - Standalone per-org toggleable app `Ký kết` / `eSign` (`'sign'`, ADR-0031, ADR-0053); `Vy` (`gm`) proposes signature/date/text fields and summarizes risky clauses via the `packages/agent` AI budget meter (core works with AI off; humans approve every placement and send).
  - Public signing uses fragment links `/-/sign#<token>` (`Referrer-Policy: no-referrer`, single-use replay rejection, optional email OTP, and no mandatory third-party CAPTCHA per `#203`); templates and Engage quote / HR contract handoffs stay in Slice 2; `Product Line` board option stays `none` so existing option ids are not mutated.
- Owner decisions 2026-11-15 (HRM PO chat, popup, https://github.com/DOS/Ludy/issues/1210#issuecomment-6897161133):
  - `"Vậy mày làm PO line HRM đi"` (`HRM Product Owner`): split HRM onto its own line (`line:hrm`, Project #8 `Product Line` option `5130d418`, preserving all six prior option ids; `#2749` stays on `line:accounting`).
  - Reopen the 3-stage SME HRM roadmap in strict order, moving Stage 1 and Stage 2 into `M3 Paid pilot` (`priority:P2`) while Stage 3 stays in Phase 7 (`when wedge customers pull for it`): Stage 1 (`#2540`: lightweight monthly timekeeping inputs and annual leave balances feeding `hr.payroll.run.*` runs) -> Stage 2 (`#2541`: labor contract tracking, the labor management register and `01/PLI` report data, 13th-month salary, and severance allowance calculation; job-loss allowance and foreign/piece-rate items wait beyond Stage 2, and HTKK tax XML stays gated on `#2536`) -> Stage 3 (Phase 7 HRM departments and lightweight recruiting in `docs/plan/crove-os-kernel.md`).
  - `"Nhân sự thì Ly đi"`: name `Ly` (`hr: 'finance'` in `COWORKER_BY_MODULE`) as the HR AI coworker (`ADR-0046` addendum item 4, merged in `#3327`).
  - Enable `Ludy Nhân sự` (`hr`) by default on Ludy Cloud for every org as the approved product default (`#2538`, merged in `#3327`, combined with the `2026-11-08` salary visibility rule; `tools/deploy/compose.pilot.yml` still defaults `CROVE_MODULES` to `finance`, so changing live pilot `CROVE_MODULES` requires a separate Production runbook and owner approval; `#2536` stays open for lawyer PDPL, retention and HTKK XSD answers).
- Owner decisions 2026-11-16 (Projects & Notes PO chat, https://github.com/DOS/Ludy/issues/1210#issuecomment-6898310263): Projects, Notes, and Personal To-do list (`modules/projects`, `modules/notes`, matching the `#3225` Cộng tác app group) belong to one independent end-to-end PO line: `Projects & Notes` (`line:projects`, option `d8c18cec`, preserving all existing option ids). `AI Meeting Notes` stays on `line:meetings`, CRM stays folded into `Ludy Engage` (`#2435`), and `line:frontend` stays on shared UI / `apps/app` shell / `apps/web` (the legacy `line:notes-crm` row remains above for historical references).

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
- local_reviews: `codex review -c model_reasoning_effort=<subagent_effort> --base origin/main`
  in the background, then a fresh-context subagent given the diff and the
  issue; docs-only PRs skip both and need `pnpm docs:check`. A protected-path
  PR also gets an independent security review before merge, run by its line's
  PO with a fresh-context flagship-model reviewer that did not write the
  change, and a PR that changes the shared core also gets the Platform PO's
  review of those files ("Shared-core review").
- shared_core_review: `line:platform`: the paths in "Shared-core review"
  below.
- agent_model: claude-sonnet-5-5 (Claude Code sub-sessions; Antigravity:
  `inherit` at flagship capability tier; owner decisions 2026-11-15 and
  2026-11-21, see above). On Claude Code, PO sessions and fresh-context
  independent security reviews of protected-path PRs run on a flagship model
  (`Claude Opus`). On Antigravity, PO sessions, the coordinator, workers (via
  `inherit`), and fresh-context independent security reviews of protected-path
  PRs run at flagship capability tier across Antigravity's Gemini 4 flagship
  and Orchestrator models (such as `Gemini 4 Carbon`, `Gemini 4 Neon`,
  `Orchestrator (Carbon)`, `Orchestrator (Neon)`) or `Claude Opus`, while
  independent security reviews run in a fresh context (`TypeName: "research"`
  on Antigravity, no direct `Hydrogen` downgrade/bypass) without needing an
  identical model codename when newer Gemini 4 variants are used.
- agent_effort: high (owner decisions 2026-10-27, 2026-10-30 and 2026-10-31;
  skipped on Antigravity, which has no session effort API). Exception: xhigh
  only for hard work (a protected-path security change, a migration, a
  root-cause hunt); on Antigravity, which has no session effort API, the
  security review's stand-in for `xhigh` is a fresh-context flagship-tier
  review via `TypeName: "research"` on Antigravity's Gemini 4 flagship or
  Orchestrator models such as `Gemini 4 Carbon`, `Gemini 4 Neon`,
  `Orchestrator (Carbon)`, `Orchestrator (Neon)`, or `Claude Opus`, with no
  direct `Hydrogen` downgrade/bypass.
- subagent_effort: high (passed to Codex CLI reviews as
  `-c model_reasoning_effort=high` on every host, Antigravity included).

## Shared-core review

Every line's PO owns its line's security review. One part of the code is
shared by every line, so a change there also gets a review by the line that
owns it, the Platform PO, in the way a code owner reviews a file: it covers
those files only, it is not an approval of the PR, and the PR's own PO keeps
its acceptance gate, its merge and its questions to JOY.

The shared core (owner decision 2026-11-16: only what carries risk for every
line):
- `packages/kernel-runtime/src/**` (the one write path, the blob cipher, the
  egress guard);
- the database context guards and the migration runner (`packages/db`; not
  the generated types in `packages/db/src/generated/`);
- authentication and the HTTP edge: `auth*.ts`, `sessions*.ts`, `http.ts`,
  any `auth/` directory, `approval.ts`, `identity.ts`, and
  `packages/kernel-contract/src/engage-proposals.ts` (the table of Engage
  proposal kinds that the approval policy reads);
- kernel SQL: a migration that creates or replaces a function in
  `crove_kernel` (`apply_tenant_rls`, `org_purge` and the like), changes
  roles or grants on `crove_kernel` objects, or changes another line's
  tables;
- the gate: `.github/workflows/**`, `tools/ci/**`, `tools/deploy/**`, git
  hooks, the pgTAP runner, and any change to an invariant file
  (`test/invariant/`, `supabase/tests/database/_*.test.sql`) that loosens a
  rule;
- the agent harness and policy: `AGENTS.md`, `CLAUDE.md`, `.claude/settings*`,
  hooks, agents, `.mcp.json`.

Not shared core, so the line's PO reviews them alone (they stay protected
paths, with the line PO's security review):
- a line's own migrations, tables, grants on its own tables, module code and
  its own invariant tests, unless the change loosens a rule;
- an invariant change that only tightens a rule (removes an allowance or a
  pending entry), or only adds a two-step pending entry for the line's own
  tables or commands;
- the generated DB types.

The Platform PO is a role, not a person. The owner, 2026-11-16, in the
Meetings PO's chat: "Bản chất PO Platform cũng là 1 agent bình thường thôi
[...] Cái quan trọng ở đây là có 1 agent có role dedicated để nó double check,
review 1 lượt thôi" (the Platform PO is an ordinary agent too; what matters is
one agent with a dedicated role that double-checks, reviewing once). So any
dedicated session that runs it on a flagship model with fresh context, and is neither the
PR's author nor the PR's own PO, may give the shared-core review. What matters
is one independent second agent that checks those files once.

How to ask and how long to wait (owner decision 2026-11-16):
- The PR's PO adds the label `shared-core` and comments on the PR
  `Request: Shared-core review (Platform PO)` with the head SHA and the
  shared-core files it changes. The Platform PO watches that label, so a
  request wakes it.
- A review stays valid for later heads while
  `git diff <reviewed head>..<head> -- <the shared-core files>` is empty:
  a merge of `main`, a migration rename or a module-only fix needs no new
  request.
- If the Platform PO has not answered within 4 hours, the PR's PO runs an
  independent, fresh-context flagship-model reviewer on the shared-core files
  only, posts it as `## Shared-core review (stand-in)`, and may merge. The
  Platform PO reviews it after the merge within 24 hours; a blocking finding
  is a P0 forward fix or a revert. Changing an invariant on purpose stays an
  owner decision.
- Once `Security review (agent)` runs in CI (#95), its comment on the head
  counts as the stand-in review.

The Platform PO answers on the PR with `## Shared-core review (Platform PO)`,
naming the head it reviewed.

## Sessions

- sub_sessions_normal: 5 (owner decision 2026-11-18 in eSign PO chat: "Sao
  mày chạy chỉ 1 subagent? 3-5 subagent/subession cơ mà?", popup A2: "Cập
  nhật quy tắc chung lên tối đa 5 phiên con song song trong tệp cấu hình dự
  án"; each PO keeps up to 5 concurrent sub-sessions running when independent
  tasks are ready, matching `sub_sessions_max: 5` and superseding the
  2026-11-15/2026-11-16 cap of 3, Engage's 2026-11-08 cap of 4, and the
  2026-10-31 default of 1, while keeping AGENTS.md's 2026-11-17
  local-resources rules: one heavy command at a time per session, scoped
  `--filter` typechecks and touched-file tests only)
- sub_sessions_max: 5 (owner decision 2026-11-18 in eSign PO chat, popup A2:
  up to 5 active sub-sessions + 1 PO session per line, superseding the
  2026-11-15 cap of 3 and Engage's 2026-11-08 cap of 4; local-resources
  discipline from 2026-11-17 still applies to every session)

A PO keeps its context small at natural breaks. With a warm cache, it uses
`/compact` with a focus. After a long idle, such as overnight, it starts a
fresh session from a handoff file instead. Its loop wakes at most 30 minutes
apart, inside the one-hour prompt cache (owner decision 2026-10-31).
- check_in_minutes: 30

JOY's standing instructions (work without stopping; the coordinator merges every PR that meets the merge bar) are
in AGENTS.md and the decision log above.
