# 0025. Channel layer: social and messaging connections in the kernel

- Status: accepted (owner, 2026-10-16, in chat: "Làm đi" to the S2 proposal)
- Date: 2026-10-16
- Deciders: owner (JOY)
- Builds on: plan §4.9 (outbox, jobs, `external_call`), §5.7 (Service and Social share the channel layer), §7.4 (credentials and bindings), §7.7 (egress), ADR-0030 (composition root, `CredentialBroker` port)
- Tracking: [Social plan](../plan/social.md) step S2

## Context and problem statement

Social (publishing) starts now (plan Decision 17), and Service (inbound messages and comments) later. Both need the same thing: an org connects a Facebook Page, an Instagram account, a LinkedIn page or a Zalo OA once, and Crove holds its tokens, refreshes them, and calls the platform from jobs. The kernel has a `CredentialBroker` port with no implementation and no table for connections. If Social builds connections inside `crove_social`, Service would either read another module's tables (banned, §5.4) or connect every page a second time.

## Decision

1. **Connections live in the kernel.** `crove_kernel.channel_connection` (one row per connected page or account, unique per `(org_id, provider, external_account_id)`) with `provider`, `display_name`, `scopes`, `status` (`active`, `expired`, `revoked`, `error`), `credential_id`, `connected_by`, `expires_at`. Modules reference it by composite FK `(org_id, channel_connection_id)`; the kernel module role writes it, others only read.
2. **Credentials: the `crove-local` broker.** `crove_kernel.credential` holds tokens envelope-encrypted: a random AES-256-GCM data key per credential, wrapped by the deployment key `CREDENTIAL_KEY` (Crove Cloud: KMS). Rows carry the key id for rotation. Decryption happens only in provider jobs; the API and the OAuth callback seal, they never open. Tokens never reach the SPA, logs, audit rows, events or query output. The `dos-broker` adapter (plan §7.4) stays a later Cloud option behind the same port.
3. **Providers are adapters in `@crove/channel`.** Small capability interfaces (`Connector`, `Publisher`, `Reconciler`, `MediaUploader`, `MetricsReader`; Social plan §3.6) plus static capability data (limits, media rules). Publish steps declare their retry safety (`safe`, `idempotent`, `reconcile_only`, `never`). Each adapter declares its FQDN allowlist and its fetch is bound to it. The core ships `sandbox` (no network, always available in development and tests) and the platform adapters; a provider is enabled only when the deployment has its app credentials.
4. **OAuth connect in the HTTP edge.** `start` writes a single-use `crove_kernel.oauth_state` (org, user, nonce, PKCE verifier where supported, 10 minute expiry); `callback` consumes it, exchanges the code through the adapter, encrypts the tokens and runs `kernel.channel.connect` through `execute()` (R2, owner or admin, permission `kernel.connection.bind`). Handlers keep doing no network I/O; the exchange happens in the route, before the command.
5. **Outbound calls go through `crove_kernel.external_call`.** A deterministic key per intended effect; states `started`, `succeeded`, `failed`, `ambiguous`. A call found `started` on retry is never repeated blindly: it becomes `ambiguous` and a reconciliation job asks the provider (plan §4.9).
6. **Token lifecycle.** A daily schedule refreshes tokens ahead of expiry. An expired or revoked token sets the connection `expired`, modules pause work queued for it, and the owner is alerted. On every use the connecting user must still be a member; otherwise the job stops and the connection needs reconnecting.
7. **Self-host and Cloud.** Self-hosters register their own platform apps and set their credentials in env; Crove Cloud uses DOS-owned platform-approved apps through configuration in `crove-cloud`. Same code, no DOS dependency in the core.

## Implementation (S2, issue #232)

- `packages/kernel-runtime/src/vault.ts`: `CredentialVault` (the `crove-local` broker) and the `CredentialBroker` port it implements: `seal(secret, binding)` and `open(sealed, binding)`, both authenticated with the binding (org, provider, account), not the connection id, so a token can be sealed before its connection row exists and a reconnect keeps the row. `apps/kernel/src/credentials.ts` keys it from `CREDENTIAL_KEY`, else `CREDENTIAL_KEY_FILE` (created when missing), plus `CREDENTIAL_KEY_PREVIOUS` during a rotation (`docs/runbooks/credential-key.md`).
- `crove_kernel.credential` is definer-only machinery: no Crove role holds a grant on it. `credential_put` and `credential_drop` accept owners and admins of the org in context or the system; `credential_get` is granted to `crove_worker` only, answers in a system context only, and refuses once the member who connected the account has left the org.
- `kernel.channel.connect` (R2, owners and admins) receives the envelope, never the token, and takes no idempotency key: every seal differs, and connecting a connected account again is already a reconnect of the same row. `kernel.channel.disconnect` revokes the row and drops the credential; `kernel.channel.list` never returns a credential; `kernel.channel.credential` is the system query provider jobs use.
- `@crove/channel` holds the provider list and the offline `sandbox` provider; the RPC `channels.connectSandbox` makes and seals a sandbox token (on unless `CHANNEL_SANDBOX=false`).
- A reconnect by another owner or admin replaces the token and makes them the connector; the credential then lives on their membership. `credential_get` also refuses once the connector is no longer an owner or admin, or is disabled.
- Deferred to the steps that need them: `oauth_state` and the OAuth routes (S6), `external_call` and the refresh schedule (S4), a reseal command for rotations.

## Consequences

- Service reuses connections, tokens and `external_call` without touching Social's schema.
- New protected-path surface: two migrations, an HTTP route pair and decryption code. Each PR gets an independent security review, RLS matrix rows for the new tables and a redaction test.
- `CREDENTIAL_KEY` becomes a required secret once any provider other than `sandbox` is enabled; losing it means every connection must be reconnected (documented in a runbook).
- The full egress policy (ADR-0016) is still to write; until then the per-adapter allowlist is the control.

## Alternatives considered

- **Connections inside each module.** Rejected: Service would reconnect every page or read Social's tables.
- **Tokens in plain columns protected only by RLS.** Rejected: a database dump or a backup would expose every page token.
- **Code exchange in a job instead of the callback.** Rejected for v1: the user waits on the redirect either way, and a job adds a pending state to the connect screen; revisit if a provider's exchange is slow.

## Amendment (2026-11-03): a sealed copy of an ads token that outlives a disconnect, only to revoke it

Owner decision, 2026-11-03, in the Platform PO's chat ("Đồng ý"), for [#2296](https://github.com/DOS/Ludy/issues/2296) (W2 of running ads, [ADR-0043](0043-ads-write-running-ads.md) point 4). The rule above, that a disconnect leaves nothing to decrypt, has one deliberate exception, the same kind as the calendar's (a disconnecting calendar connection hands its credential to the worker so it can revoke at the provider, #2144).

- **Why.** Closing an ads write connection (or an ads read connection whose token holds a spend permission) used to drop the sealed token in the same transaction. The permissions the person gave the app at Meta then stayed valid until they expired or the person removed the app, and the pause of what Ludy had launched (ADR-0043 point 7a: a switch-off pauses first) could not run at all, since both calls need the token.
- **What may be kept.** A sealed copy of that one token, in `crove_ads.ad_token_seal`, made inside the transaction that closes the connection by a definer function, **for at most seven days**. It is the same envelope the credential table holds (same key, same binding to org, provider and account); the kernel's `crove_kernel.credential` is dropped as before. The copying definer is owned by the owner of `crove_kernel.credential` (the migration owner), the only role that can read that table.
- **Who opens it.** Only the revoke and wind-down worker, through a worker-only definer function, for two calls and no others: `DELETE /me/permissions` and the call that pauses an object. No command, query, API route or login role reads it; the table has no grant to any Crove role. The worker is given a narrowed view of the platform's writer that has those calls alone (W2-1 adds the test that pins both the view and the source that names it).
- **Which providers.** Meta's ads providers (`metawrite_ads`, and `meta_ads` with a recorded spend permission) and the offline sandbox. The owner approved this for Meta; another platform needs its own decision, and a provider outside that list gets no copy.
- **The membership rule.** Decision 6 and `credential_get` refuse a credential once the member who connected it has left the org or is no longer an owner or admin. Unlike `credential_get`, the copy opens whatever became of that member, only for these calls and only within its seven days, since ending the access is its only use: a member's removal must not leave the permission valid at the platform, so the revoke runs after the removal and before the copy is wiped.
- **When it ends.** Wiped when the revoke worked (or the platform no longer accepts the token), after ten attempts or seven days, whichever comes first (the screen then says to revoke by hand: remove the app in the platform's settings), and at once by the org's purge. A member's removal does not wipe it unrevoked: the revoke is tried first, and only then is it wiped. It never appears in an audit row, an event, a log line or the data of a job (ids and states only).
- **Where it is proved.** `apps/kernel/test/invariant/channel-credentials.db.test.ts` names every table that holds a sealed envelope and accepts this one under a dated allowance (expires 2026-12-31) until the change that adds the table (W2-1) pins the behaviour in its own tests; the RLS matrix lists both new tables as pending until W2-1 lands them, the seal as definer-only machinery (no grant to any role) and the revoke state as a table tenant roles read and only the system context and definers write.
