# 0043. Ads: running ads from Ludy, behind an approval before any spend

- Status: Accepted (2026-11-01) once this PR merges. Amends [ADR-0040](0040-ads-read-only-sources.md) point 2 (read-only by construction), which asked for exactly this record: "any later write needs a new ADR: R3 commands, four-eyes, and an approval that names the amount". The owner answered the [questions](../plan/ads-write.md#11-questions-for-joy) on 2026-11-01 (Q1 A, every other question with its recommendation); the Platform PO reviewed the design and asked for the additions in points 1, 2, 3 and 7a. Build issues W0, W1, W2 open after the merge, in that order.
- Date: 2026-11-01
- Deciders: owner (JOY), on the Marketing PO's recommendation
- Builds on:
  - ADR-0040 (the Ads module, `@crove/ad-platform`, read-only sources);
  - ADR-0025 (connections, sealed credentials, adapters with an egress allowlist);
  - ADR-0029 (agents and their write allowlist);
  - ADR-0027 (the core runs with no DOS service);
  - the kernel's risk levels and approval policy (kernel plan section 4.7: R0 to R3, P08, P10 to P13) and its `external_call` ledger;
  - the job egress invariant (#1653) and the guard of #2275.
- Issue: [#2283](https://github.com/DOS/Ludy/issues/2283). Plan: [ads-write.md](../plan/ads-write.md), summary for the owner: [ads-write.vi.md](../plan/ads-write.vi.md).

## Context and problem statement

ADR-0040 made Ads read-only because moving money needs its own risk model. The owner then said on 2026-11-01 that users should **run ads from Ludy**, with full campaigns ("Chiến dịch đầy đủ"), as Hootsuite Ads does. Running an ad spends the owner's money on a platform, can reach the public, and cannot be undone once spent. What has to be decided before any code:
1. How a command that can spend fits the kernel's risk and approval policy.
2. How write permission on a platform is opened, given that #2275 refuses any token that holds `ads_management`.
3. How the platform calls are made exactly once, and what happens when one is lost.
4. What personal data targeting and audiences involve.
5. In what order the slices are built so that nothing spends before an approved plan.

## Decision drivers

- **Nothing spends without a human approving exactly that plan, within a cap the owner set.**
- **Read-only stays the safe default**: an org that never asks to run ads is unaffected, and its refusal of write scopes holds.
- One write path, tenancy, sealed credentials and the job egress invariant are unchanged (AGENTS.md rules).
- OPC and SME first: the owner's own accounts must work without waiting for a platform review.
- No personal data beyond what a person can already see in the platform's own targeting options.

## Decision (proposed)

### 1. Spend is R3, and goes through a proposal

A command that can start or raise spend (launch, activate or resume, raise a budget, extend a schedule, set or raise a cap, enable writing) declares `sideEffect: 'financial'` and is **R3**: a proposal, an approver who is not an author of it (P10), a fresh second factor (P11), the approver's own permission and legal entity (P12), escalation above the org's money threshold (P08), executed once (P13). What only reduces or stops spend (pause, lower a budget, shorten, archive) is R2 `external`; drafting is R1. The approval **names the largest amount the plan can spend** and binds the input hash of exactly that plan. No new row of the derived-risk table is needed: the existing rule (`financial` is R3) already does it, and the registry test keeps each command at or above it.

**The one-person-company path (P10).** An org whose only eligible human is its owner has nobody to be the second pair of eyes, so P10 lets that owner approve their own plan, and the audit row says `self_approved`. Self-approval relaxes nothing else: P11 still needs a fresh second factor, the approval card still names the largest amount, and the caps of point 2 still bind. An owner with no verified second factor cannot switch writing on (point 3) until they enrol one, so a one-person org never reaches R3 without a factor. The moment a second eligible human joins, P10 applies as for any org and the owner can no longer approve a plan they wrote.

### 2. Per-account and per-org spend caps; none set, no launch

The owner sets a daily and a monthly cap per ad account and per org (R3, owner only, step-up). A launch is refused until caps exist, and again when the committed spend (live and scheduled budgets plus the new plan) would pass one, at approval and at execution. The platform's own spending limit is read and shown; Ludy's caps are a second fence.

- **The execution check is the authoritative one, and it runs under a lock.** The approval-time check only warns early. At execution the launch step takes a per-org transaction advisory lock, recomputes the committed spend from `crove_ads` rows, and in the same transaction writes the plan's commitment before any platform call; the lock is released at commit. Two launches approved at the same moment therefore serialise, and the second sees the first's commitment and is refused if together they would pass a cap. A commitment is released only when its objects are archived or their schedule has ended. A test runs launches in parallel and asserts that the committed spend never passes a cap.
- **Caps have a currency.** A cap is a decimal string in the currency's own units (dong, or dollars with cents, at most two decimals) with an ISO currency code (money rules of AGENTS.md; never a JS number); a platform's minor-unit budgets are converted with decimal.js before they are compared. Each cap carries its own currency. An account cap is in the account's currency. An org cap is in any ISO currency (VND unless the owner sets another). A launch is refused with `ADS_CAP_CURRENCY` unless every org cap that applies is in the account's currency: converting between currencies would add a rate the approver did not see, so it is a later decision with its own amendment.

### 3. Write permission is a separate, explicit, conditional step

- Three layers: the deployment has the platform app (a separate app for writing is recommended); the **org** switches ad writing on (owner, step-up, audited, default off); each **ad account** is enabled for writing (default off) through a **new connection step** that goes through the platform's dialog again.
- **#2275's guard is not removed but made conditional**: with the org switch off the connector refuses any token that holds `ads_management` or `business_management`; with it on, the connector asks for and accepts them and records the full set on the connection. Read-only orgs keep refusing write scopes, with the tests of #2275 plus the switch-on path.
- The Ads screen says per account whether its token can only read or can also run ads.
- **The write token is its own credential.**
  - *Sealed separately.* It is a second sealed credential of the connection (ADR-0025), apart from the read token, opened by the worker alone and only inside a write job. The API and the read jobs never hold it, so a leak of the read path cannot spend.
  - *Require App Secret.* Every write call carries `appsecret_proof`, and the write app has "Require App Secret" switched on at Meta, so a token copied out of Ludy is useless without the app secret.
  - *Revoked at Meta on disconnect or switch-off.* Disconnecting an account or turning the org switch off makes the worker revoke the write token at Meta (the platform's call that removes the app's permissions, the one call of the writer that is not about an ad object) and then delete the sealed copy. A revoke that fails is retried and shown on the Ads screen as not yet revoked; the sealed copy stays until it succeeds.
  - *Queued writes stop when the switch goes off.* The write job checks the org switch and the account's write flag again before each step, not only when it was queued. Turning the switch off cancels every launch that has not started and every step not yet run; a step already in flight finishes and is recorded; objects already created stay paused. Nothing queued can spend after the owner switched writing off.

### 4. A second adapter interface for writing, in separate files

`AdWriter` in `@crove/ad-platform`, one file per platform, offered only where the org switch is on: create campaign, ad set, creative and ad, set status, budget and schedule, read an object's state, and revoke the write token (point 3). **No delete of any ad object** (archive is a status). A test pins the endpoints each writer calls, its host binding and the absence of any other method. The reader interface and its tests are unchanged, so no reader file can acquire a write.

### 5. Exactly once, objects paused first, reconcile before retry

Each platform call is an `external_call` step with a deterministic key (`ads.launch:<launch id>:<step>`). Objects are created **paused** and activated last, so a launch that stops half way has spent nothing. Every created object carries a tag in its name, because Meta offers no idempotency key for creation [U]; an `ambiguous` step starts a reconcile job that lists the account's objects by that tag before anything is retried. A rejected ad is shown with the platform's reason and never re-submitted automatically.

### 6. Personal data: none in targeting, audiences out of the first slices

Targeting by location, age, gender, language, interests and placement stores parameters, not people. **Custom audiences (customer lists), lookalikes, pixel and Conversions API events, and lead forms are personal data of third parties and are out of these slices**; they need a separate amendment and a lawyer's reading under the Law on Personal Data Protection first. Special ad categories are declared as none, and an account the owner marks as running one is refused until a lawyer has read the rules for Vietnam.

### 7. Agents draft, humans launch

An agent may write **drafts** (R1, reaching a human as a proposal); it never launches, activates, resumes, raises, extends, sets a cap or enables writing. This amends the write allowlist of ADR-0029 for the draft commands only; the test that enumerates tables from the catalog and refuses agent writes keeps every other `crove_ads` table closed.

### 7a. A fast kill switch: pause everything Ludy launched

`ads.pause_all` is an **R2** `external` command (owner, admin and marketing members; no proposal and no second factor, because it only stops spend and speed is the point). It pauses every campaign and ad set that Ludy launched in the org, found from the recorded object ids and checked against the `ludy:` name tag, as `external_call` steps with deterministic keys (`ads.pause_all:<run id>:<object>`) so a double click pauses once. It also sets an org flag `launches_blocked`; while the flag is set every launch, activation and resume is refused, and only an owner clears it (R3, step-up). Turning the org switch off runs the same pause first. The screen offers it as one clearly marked button, and it is audited with the number of objects paused and any the platform refused, each with its reason.

### 8. Ads still never posts to the books

Spend reaches Kế toán through intake and the platform invoices (slice D). Ads shows the committed spend beside the actual one and posts nothing.

### 9. Slices

W0 switch, access, caps, kill switch; W1 draft and validate (nothing leaves Ludy); W2 launch on Meta; W3 boost a published post; W4 manage; W5 ads on the Social calendar; W6 Automated Boost, and Google writing in its own ADR. Meta objectives first: Traffic, Engagement, Messages. No slice spends before an approved launch. **Approved to build now: W0, W1, W2, in that order**; W3 to W6 wait.

## Decisions for the owner

The eight questions of [the amendment, section 11](../plan/ads-write.md#11-questions-for-joy): the first slice (Q1), who approves (Q2), the cap default (Q3), the first objectives (Q4), the timing of Meta's Business Verification and App Review (Q5), audiences and customer data (Q6), the Meta app for writing (Q7) and Automated Boost (Q8). **Answered 2026-11-01:** Q1 A (W0, W1, W2 in order) and every other question with its recommendation: approvers owner and admin with the one-person path (Q2 A), no cap no launch (Q3 A), Traffic, Engagement and Messages first (Q4 A), review for Ludy Cloud after W2 works on the owner's own account (Q5 A), no customer-list audiences (Q6 A), the Meta app for writing: the owner's existing classic app is fine for testing on the owner's own account (Q7 B) and a separate write app comes before Ludy serves other businesses (Q7 A), so the write app is its own env pair that may hold the same app as the read or Pages pair, Automated Boost later inside an approved cap (Q8 A). The agent rule in point 7 stands as recommended; the owner may still reverse it.

## Consequences

- Owners can build, approve and launch a Meta campaign from Ludy, see Meta's review state, and change or stop it, with a record of who approved which amount.
- New protected surface in every write slice: migrations, new commands that move money, a new job queue and adapter, OAuth scope changes, new RLS matrix rows. Each PR gets the independent security review and the two-step invariant route.
- Ludy Cloud cannot run other businesses' ads on Meta before Advanced access, App Review and Business Verification (owner steps); the owner's own accounts need none.
- A write adapter is code that can spend a customer's money on a platform: its tests pin its endpoints, and a platform version or rule change is a spending risk, so each writer pins one version with recorded-answer tests and a live check before it is used.
- Meta's review and rate limits shape the user's wait; the screen says so rather than hiding it.

## Alternatives considered

- **One adapter interface for read and write.** Rejected: an interface that can write makes every reader a potential spender and weakens the test that reader files call no write endpoint.
- **Upgrade a read-only connection to write in place.** Rejected: a token's scope would change without the person seeing a dialog; a new explicit connection step is auditable.
- **Remove #2275's guard.** Rejected: read-only orgs should keep refusing write scopes; the guard becomes conditional on the org switch.
- **Activate objects as they are created.** Rejected: a half-finished launch would spend; paused creation with activation last costs one more call.
- **Rely on the platform's own spending limit instead of Ludy's caps.** Rejected as the only fence: it is not Ludy's to set, may be absent, and does not know the plan the approver signed; read and shown beside the caps.
- **A default cap.** Offered as Q3 option B; not recommended: a high default is a surprise bill.
- **Let an agent launch inside a cap.** Rejected for the first slices: an R3 action by a non-user actor is a review (P05) and the owner asked for approval before spend; revisit with Automated Boost (Q8).
- **Customer-list audiences in the first slices.** Rejected: personal data transfer needing a legal basis and a lawyer first.
