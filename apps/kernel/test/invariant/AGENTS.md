<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Invariant suite (kernel)

This directory is part of the invariant suite: CI runs the base branch's copy of it on protected-path PRs.

- Read [docs/security/invariant-suite.md](../../../../docs/security/invariant-suite.md) before changing anything here.
- Keep the directory self-contained: no imports or fixtures from outside it but the code under test.
- New security tests go here; product flows stay in the ordinary `*.db.test.ts` files.
- A red invariant job means fix the code, never the test in the same PR. Changing an invariant on purpose is an owner decision, or lands in two steps: first a test that accepts both behaviors, then the change (root `AGENTS.md`, "Protected paths").
