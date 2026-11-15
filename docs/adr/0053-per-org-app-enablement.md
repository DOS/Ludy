# 0053. Per-org app enablement: an owner or admin turns apps on and off for their own company

- Status: accepted for slice (a) and the contract; slices (b) to (e) are built from it (owner decision, 2026-11-15, Platform PO chat, popup answer "Làm bật tắt theo công ty"). The three points in "Open points for the Platform PO" are this ADR's own choices, flagged for the PO's acceptance.
- Date: 2026-11-15
- Deciders: owner (JOY) for the feature; the engineering choices by the session that wrote it, for the Platform PO
- Amends: [ADR-0031](0031-module-enablement.md) (it left per-org access to entitlements and did not enforce them)
- Builds on: [ADR-0030](0030-composition-root.md) (the `billing` port), [ADR-0007](0007-tenancy-and-context.md), [ADR-0029](0029-agents-positions-and-org-chart.md), plan Decision 10 (entitlements) and Decision 12 in [crove-os-kernel.md](../plan/crove-os-kernel.md)
- Issue: [#3307](https://github.com/DOS/Ludy/issues/3307)

## Context and problem statement

[ADR-0031](0031-module-enablement.md) turns modules on and off **per deployment** with `CROVE_MODULES`: a module that is off registers no command, query, job, route or menu, and keeps its data. On a shared deployment (Crove Cloud) that is the wrong grain: one deployment serves many companies, and every org sees every module the deployment runs. The `Billing.entitlements(orgId)` port exists in `apps/kernel/src/kernel.ts`, but nothing enforces it (self-host answers `['full']`).

The owner wants each company's owner or admin to switch off the apps the company does not use (Social, Nhân sự, Cuộc họp...) from Settings. A one-person company that never posts to social media should not see Social in its menu, in Home, or in what Vy says. The defaults keep every app on with no setup, and switching one back on restores everything, data included.

The scope gate ([scope.md](../product/scope.md)) is met: it is a task a small business does once or twice, the smallest slice is one switch per app with every app on, and the AI coworker here does nothing (Vy only stops mentioning an app that is off; every change is a person's).

## Decision drivers

- The rule that decides must be **one function** used by every gate, and the same one the entitlements port feeds, so a paid app that is not held and an app the owner switched off are one answer, not two checks.
- The owner's choice takes effect **at once and in the same transaction** as the call it affects: an app turned off is never reachable a minute later through a cache.
- Turning off must be **reversible and lose nothing**: data, connections and queued work come back as they were, except work whose time has passed, which never runs on its own.
- Legal keeping continues for an app that is off: retention, evidence holds, erasure and export are not "work" and do not stop.
- One write path ([AGENTS.md](../../AGENTS.md)): the choice is written by one kernel command and nothing else.
- A module added later is on by default for every org, with no migration of choices.

## Decision

### 1. The effective set

For an org, an app (module) `m` is **effective** when all of these hold:

```
effective(m) = m == 'kernel'
            OR ( m in CROVE_MODULES            -- the deployment runs it (ADR-0031, unchanged)
                 AND entitled(org, m)          -- the org holds it (plan Decision 10)
                 AND m not in org.apps_off )   -- the org did not switch it off
```

- `kernel` is always effective and cannot be switched off. A module needs no other module (Decision 12: modules run when others are off), so switching one off never forces another off.
- `entitled(org, m)` is true when `Billing.entitlements(org)` returns `full` or `m`. Self-host answers `['full']`, so it is always true there.
- `Runtime.installed(m)` keeps its meaning: the deployment level, a registry fact, used when routes and jobs are registered at boot. A new `Runtime.effectiveModules(orgId)` returns the org's set; it is the only place the three parts are combined.

### 2. Where the choice is stored

A column on the tenant row, in a migration, written by one command:

- `crove_kernel.tenant.apps_off text[] NOT NULL DEFAULT '{}'` and `crove_kernel.tenant.apps_version integer NOT NULL DEFAULT 1` (the same pattern as `approval_preset` and `approval_policy_version`, #1402). The default is **the list of apps that are off**, empty for every org, new or existing: no backfill, and a module shipped later is on everywhere until someone turns it off. A column rather than a table because the choice is a short list read on every call with the tenant row, the history lives in the audit log, and a per-app table would add a second row read to the hot path.
- A guard trigger (`tenant_apps_guard`, `BEFORE INSERT OR UPDATE OF apps_off, apps_version`) refuses any change not made by an owner or admin user context of that org, an element that is `kernel` or not shaped like a module id (`^[a-z][a-z0-9_]*$`), a duplicate, and a version that does not grow by exactly one with the change. A constraint trigger (`tenant_apps_requires_audit`, deferred) lets the commit through only with that command's `ok` audit row naming the module and the new state. Staff (a superuser or the migration runner's role) may change it for support. This copies `tenant_approval_policy_guard` and `tenant_approval_policy_requires_audit`; every function sets `search_path = pg_catalog, pg_temp`.
- The database stores any well-formed module id, so removing a module from a later build breaks nothing. The command refuses an id the build does not ship (`AVAILABLE_MODULES`) and `kernel`.
- `crove_kernel.org_app_on(p_org uuid, p_module text) RETURNS boolean` (`STABLE`, `SECURITY DEFINER`, `search_path = pg_catalog, pg_temp`) answers `p_module = 'kernel' OR NOT (p_module = ANY (apps_off))` for sweeps, the outbox relay and public pages, which run without a tenant context. It reads the choice only. EXECUTE goes to the roles that need it and nobody else (the grants are decided and tested in slice (a), as for the other `crove_kernel` helpers).
- The command: `kernel.org.set_app` with input `{ module, enabled }`, one app per call, `access: ['owner', 'admin']`, risk R2 (a settings change that affects the whole company, reversible, moves no money; R3 and its second factor are kept for what cannot be undone), `sideEffect: 'internal'`. It locks the tenant row (`FOR UPDATE`) so two switches meet on it, changes the list and the version only when the state changes (setting the state it already has is a no-op with no audit row and no event), writes `ctx.audit({ module, enabled, version })` and `ctx.activity`, and emits `kernel.org.apps_changed` (`{ module, enabled, version }`) for the live app (section 5) and for held work (section 4). An agent actor and an MCP grant cannot run it (the role check refuses them, covered by a negative test), so no AI changes a switch.
- The read: `kernel.org.apps` (any member) returns, per app the build ships, `{ id, deployment, entitled, enabled, effective }` and whether the caller may change it, so Settings can say why an app is off ("chưa có trong gói" versus "đã tắt").

### 3. Where it is enforced

Every gate asks the one function. The check comes **after** the session check and the membership check, so someone who is not a member of the org learns nothing about its apps (the pre-membership refusals stay as they are).

| Point | Answer when the app is off for the org |
|---|---|
| `Runtime.execute` (all actors: user, agent, system), the nested commands of `ctx.command`, and an approved proposal that runs a command | `DomainError` `MODULE_OFF`, status 404, with `module` in its details and a Vietnamese message naming the app. 404 keeps the parity with ADR-0031's deployment case (clients treat it as "not there"); the typed code carries the reason. The enclosing transaction rolls back, so nothing is half done. |
| `Runtime.query` and `Runtime.stream` | The same `MODULE_OFF`. |
| `ctx.query` (so Home, signals, links between apps) | `{ status: 'not_installed', module }`, the same typed answer as ADR-0031 section 4, so every caller that already handles an app the deployment leaves out handles this with no change. |
| Worker sweeps and jobs | Skip the org: a sweep adds `org_app_on(org_id, '<module>')` to the query that finds work; a job that starts for an off org ends without work and without a retry (section 4). |
| HTTP routes and public pages of the app (the booking page, the bio page, client review and report links, calendar feeds, the extension and upload endpoints of Meetings) | The ordinary not-found answer, identical in body and timing to an address that does not exist, so a public visitor cannot tell "off" from "never existed". |
| Inbound webhooks of the app (the Facebook and bank-feed ones) | Signature checked, then **acknowledged and dropped** (200), never 404: a provider that sees errors retries and then disables the subscription. What was dropped is recovered by the app's own catch-up sync after it is turned back on (section 4). |
| Vy, Home (`kernel.today`), signals, the weekly digest and MCP | The app is left out: its `<module>.today` and signal lines do not run, its tools are not listed (`activeTools` is user permissions ∩ entitlements ∩ the effective set, plan section 8), its coworkers do not wake, and a tool call into it answers `MODULE_OFF` as an MCP `isError`. Vy's prompt names only effective apps. |
| The SPA | The org's effective set comes from `kernel.org.apps` (not from `/api/config`, which stays per deployment); menus use `installedItems` and screens use `screenInstalled`/`outsideInstalled` with that set, so an off app's screen opened by URL redirects as ADR-0031 section 3 says. |

Rules that keep the gate honest:

- **Keeping is not work.** Retention, evidence holds, erasure and crypto-shredding, the org export and offboarding, and the purge keep running for an app that is off, with its data. They run as kernel commands or `SECURITY DEFINER` functions keyed by org, not as the module's own commands. A module command that must run while the app is off declares `runsWhenOff: true` with a one-line reason; the default is refused, and a test lists every such command so a new one is a visible, reviewed addition.
- **Every sweep and job is classed.** A new sweep or job of a module declares whether it is `work` (skipped when off) or `keeping`. A test walks the worker's registered sweeps and fails on one with no class.
- **No cache on the choice.** The runtime reads `apps_off` in the call's own transaction (one primary-key read of the tenant row, or carried by the context-entry function; slice (b) measures and picks). Only the entitlement answer may be cached, for up to 60 seconds per org in each process, because it comes from a port that can be remote.
- **Entitlement failures fail open to the last answer.** If the port cannot answer, the runtime uses its last known answer for the org, and `full` when it has none, and records a security event. Entitlement is a commercial limit, not a safety one; taking every paid app down on a billing outage is the worse failure. The deployment list and the owner's choice still apply.

### 4. Queued work, live connections, and turning back on

The principle: **the database row is the truth and a queued job is only a hint**. Every module's work is found by a sweep over rows, so a job dropped while the app is off is found again later; events that cannot be re-found are held, not dropped.

- **Pending outbox events** of the app's types for an off org stay in `outbox_pending`: the relay's claim excludes them (`org_app_on`), so they do not block other orgs, and they flow in order when the app is on again (the `kernel.org.apps_changed` event wakes the relay). There is no expiry in this slice. The number of held rows is measured, and a limit is a follow-up issue if it grows.
- **Queued pg-boss jobs** of an off org complete without work and without retry. Their rows are found again by the sweep.
- **Time-sensitive work never runs late on its own.** A post planned for a time that has passed by more than 60 minutes (the grace) by the moment the app is back on is not published. It is shown as late and waits for a person (the module's existing late state if it has one; slice (c) checks Social's and adds one if not). A meeting join or recording planned for a time that passed is dropped. The reason is the same as everywhere else: a person approves messages, and a stale public post is a harm that cannot be undone. Posts still inside the grace go out normally.
- **Connections are kept, not revoked.** Sealed OAuth tokens (channels, ads, bank feeds, calendar, meeting platforms) stay in the vault. Refresh and sync jobs skip the org, and Settings shows the connection as "paused, the app is off". A token that expires while paused shows as "needs reconnecting" when the app is back on. To remove a connection the owner uses the app's own disconnect before switching off; the switch's confirmation says so and lists the connections.
- **Webhooks** of the app are acknowledged and dropped while off (section 3); the app's catch-up sync runs when the app is on again and covers the gap. Slice (c) checks each webhook provider for such a sync (a cursor poll) and records any that has none, so the gap is known before the switch ships.
- **Open sessions.** The invalidation stream stops pushing events of the app's entities and the client refetches `kernel.org.apps` on `kernel.org.apps_changed`, so every open tab updates its menus within seconds. MCP grants and extension sessions stay authorized; their calls into the app answer `MODULE_OFF`. A Vy run in progress ends at its next call into the app with `MODULE_OFF`; each command is one transaction, so nothing is partial.
- **A recording in progress is not cut off.** `kernel.org.set_app` refuses to turn Meetings off (`APP_BUSY`, 409, "Đang ghi âm một cuộc họp, hãy dừng ghi âm trước") while a recording is open, because the audio would be lost. A module declares such a probe in its manifest (`busy(ctx)` returning a reason or `null`); only Meetings has one today (slice (c)).
- **Proposals and Inbox items of an off app** are kept with their own expiry, hidden from the lists with one line ("N việc đang chờ ở ứng dụng đã tắt"), and cannot be approved (`MODULE_OFF`).
- **Turning back on** changes one column. The data was never touched, the registered commands, routes and jobs were never removed, so everything is visible at once. Held outbox events flow, sweeps find the rows, connections resume, and late items wait for a person as above. Nothing is replayed that had a time.

### 5. Tests

- **Slice (a)'s own invariants** in `apps/kernel/test/invariant/` (a protected directory, so the file lands with the migration PR): the guard and audit triggers refuse a direct write by a member, an agent, a user of another org, a duplicate, `kernel`, a version jump, and a write with no audit row; the command refuses members and viewers, agents and MCP grants; the default is empty for new and existing orgs; another org's list is untouched; `org_app_on`'s grants. The file looks up each object it tests and runs its cases when it exists, as `member-vy-private.db.test.ts` does, so it passes in the base-copy run before the feature merges.
- **Slice (b) is a protected path built in two steps** (`packages/kernel-runtime/src/**`; the base-copy job deletes the PR's invariant files and runs the base's against the PR's code, so a strict test cannot ship with the change it pins):
  1. a tests-only PR adds `org-app-gate.db.test.ts`, whose cases for `MODULE_OFF`, `not_installed` and the audit accept **both** behaviors (an off app may still run, or answer `MODULE_OFF`) and pin what must already hold: a non-member learns nothing, `kernel` is never refused, another org is unaffected, entitlement failure fails open;
  2. a runtime PR adds the check; the base copy from step 1 passes against it. A third tests-only PR then makes step 1's file strict (`MODULE_OFF` required), because the runtime PR cannot edit a base file. The strict cases: a command, a query, a stream, a nested command and an approved proposal of an off app each answer `MODULE_OFF`; `ctx.query` answers `not_installed`; a system and an agent actor are refused like a user; the `runsWhenOff` list and the sweep-class list are exact; switching off and on restores the same rows.
- **Slice (c)** adds ordinary `*.db.test.ts` cases: a sweep skips the off org and serves another; a held event flows when back on; a late post waits for a person; a public page answers the not-found response with the same body as an unknown address; a webhook is acknowledged and dropped.
- **Slice (e)** adds: Home, signals, Vy's tool list and MCP's tool list omit the app and `tools/call` answers `MODULE_OFF`.
- CI keeps running the kernel alone ([ADR-0031](0031-module-enablement.md) section 5); a case boots two orgs on one deployment with one app off for one of them.

## Slice plan

Each becomes its own issue in milestone "M3 Paid pilot", label `line:platform`, one PR each. Build order may overlap, but **(d) merges last**, because it is what makes the feature visible and nothing the owner sees should promise a gate that is not there yet.

| Slice | What | Protected |
|---|---|---|
| (a) | The migration (column, guard and audit triggers, `org_app_on`), the command `kernel.org.set_app`, the query `kernel.org.apps`, the entitlement mapping in `Billing`, `pnpm db:types`, the slice's invariants and tests. | Yes (migration, `test/invariant/`): the PO's security review. |
| (b) | `Runtime.effectiveModules`, `MODULE_OFF` in `execute`, `query`, `stream` and nested commands, `not_installed` in `ctx.query`, `runsWhenOff`, the two-step invariant tests. | Yes (`packages/kernel-runtime/src/**`, `test/invariant/`). |
| (c) | The worker's sweeps and jobs (classed), the outbox relay, HTTP routes, public pages and webhooks, the Meetings `busy` probe, held and late work. | Partly (`http.ts`, auth-adjacent routes). |
| (e) | Vy's tools and prompt, Home (`kernel.today`), signals and the weekly digest, MCP. | No. |
| (d) | Settings "Ứng dụng": a switch per app with the reason an app is not available, the confirmation that lists connections and busy work, the menus and screens from the org's effective set. | No. |

## Open points for the Platform PO

1. **Entitlement outage fails open** (section 3). The alternative, fail closed, takes every paid app down when the billing service is down. Chosen: fail open to the last answer and record a security event.
2. **Turning Meetings off is refused while a recording is open** (section 4), instead of letting the audio upload end. Chosen for safety; it costs the owner one step.
3. **The 60-minute grace for late posts** (section 4) is a number picked here. It is one constant in slice (c), changeable without a new decision.

## Consequences

- On a shared deployment an owner can run Ludy with only the apps the company uses; the defaults change nothing.
- Every call path pays one read of a tenant row it mostly reads already; slice (b) measures it before merge.
- The entitlements port, for the first time, is enforced, through the same gate, so Crove Cloud can sell apps one by one without a second mechanism.
- Every new module's sweeps, jobs, routes, public pages and webhooks must declare whether they are work or keeping, and must ask the org's gate, not only `Runtime.installed`. The two tests make a miss a red build.
- Data is never deleted by turning off. An org that wants an app's data gone uses the existing erasure and offboarding commands.
- Not decided here: a module-level limit on how long held events may wait, a per-member (rather than per-company) choice of apps, and the order of Vy's first-run suggestions.
