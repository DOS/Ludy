# Platform PO handoff, 2026-11-13 (cloud session to local)

The Platform PO ("0: Điều phối") moves from a claude.ai cloud session to a local Claude Code session on the owner's machine (owner, 2026-11-13). The cloud session could not push tags, deploy, or reach the pilot over SSH. Its owner popups were also closed whenever a scheduled check-in or a peer message restarted its worker. A local PO reads this file first, then `AGENTS.md` and [docs/product-owner-config.md](../product-owner-config.md), which hold the standing rules.

The cloud session's hourly check-in routine (`Platform PO check-in`) is disabled, so only one Platform PO merges at a time.

## How the owner wants to be dealt with

- Vietnamese with full diacritics, plain words, in every message JOY reads.
- Ask JOY only through the `AskUserQuestion` popup: one popup that holds every open question (at most four, and a fifth waits for the answers), never as inline text. The recommendation goes first. This is recorded in AGENTS.md and the owner decisions.
- Work without stopping. Merge every PR that meets the merge bar yourself (reviewed, CI green at the reviewed head); do not wait for JOY.
- Production, secrets, credentials and anything irreversible need JOY's approval first.

## Open items for JOY (ask in one popup)

1. **Release v0.3.2.** JOY approved it on 2026-11-13, and the CHANGELOG section is merged (#3112). Before the tag:
   - link the GHCR package `ghcr.io/dos/ludy-media` to the repository once, or the deploy stops at pull;
   - then tag `v0.3.2` from `main`. A local session can push the tag, or JOY creates the release at `https://github.com/DOS/Ludy/releases/new?tag=v0.3.2&target=main`.

   Anything merged after `5c8d3a73` is not in the v0.3.2 section yet. Add it, or leave it for the next release.
2. **Supplier bank accounts and approved supplier payments (#3113), the design questions.** JOY approved the build on 2026-11-13. The four questions below were never answered, because each popup was closed. The recommendation is listed first:
   - Ludy does not move money: it approves the payment and writes the bank file.
   - The ledger posts when the bank line matches, not when the payment is approved.
   - In a company of one: two approvers when there are two or more owners or admins. With only one, a fresh second factor plus a 24-hour hold on a new or changed supplier account.
   - Only owners and admins approve at first.

   The seal key (a subject key for every supplier) is a technical choice: take the recommendation without asking.

## State of the work

- **ADR-0051 (Vy's brain is a DOS Claw agent; Ludy is the gate), Ludy side, merged on `main` (not deployed):**
  - the MCP endpoint;
  - member-bound grants, slices 3a to 3c. Slice 3d (the first private tool) is deferred by JOY because of the risk of exposing private data;
  - sealed contexts for company grants and member grants (3e);
  - the signed wake-up webhook;
  - V4/V5 signals: rules 1 and 2 are live, both on Home and through the `ludy_signals` tool, and the worker sweep wakes Vy on signals (S1 to S6, #3075 to #3093).
- **Rule 3 (a supplier bank account changed while a payment waits)** stays quiet and shows as `not_available` until #3113 lands.
- **The DOS side** is DOS/DOS.AI#7053: the Ludy connector, the work.dos.ai wake-up and per-member memory. It is not started.
- **`org_purge`:** the newest restate on `main` is `20261229030000_crove_kernel_org_purge_live_line.sql`. Every later restate must be built from it. Diff function body against function body, and check that no table drops out.

## Open PRs to watch

- **#3098** (Accounting, marketplace settlement posting). The shared-core review PASSed at `7135b4ba`. Merge order: #2936 first, then #3098. Both belong to the Accounting PO.
- **#2935, #2936, #2937** (Accounting) and **#1862, #1882, #229** (older kernel security drafts). These wait on their owners or on a Production step, as noted on each PR.

## Sessions

These are claude.ai cloud sessions. A local PO reaches them through Remote Control, or archives them and starts fresh ones.

- Platform sub-session: `session_01GbDCpoteRuCmSBG4hUZ4Fz`. It is idle, waiting for its next assignment.
- Meetings PO: `session_01GbDCpq3iQwQeGUsCcMnn4x`. It is running the L4a live-notes line, and it asks Platform for shared-core reviews.
- The Accounting PO and the Engage PO answer on PRs. No cloud session for them was found.

## Review practice

- Shared-core review follows "Shared-core review" in product-owner-config.md. For every restate of a definer, diff it against the newest body on `main`.
- Merge only at the head that was reviewed. When the head moves, re-check the delta first.
- A CI red that is not caused by the PR (a timing flake, an apt mirror) gets a re-run of the failed jobs. A real red goes back to the author with the failing test's name.
- Invariant changes go in two steps: tests on `main` first, then the code that needs them.
