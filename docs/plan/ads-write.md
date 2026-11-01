# Ludy Ads: running ads from Ludy (plan amendment)

> Amendment of the [Ads plan](ads.md) and [ADR-0040](../adr/0040-ads-read-only-sources.md), 2026-11-01, issue [#2283](https://github.com/DOS/Ludy/issues/2283). Owner decision (JOY, 2026-11-01): "Đọc quảng cáo là sao, user chạy quảng cáo trên Ludy luôn cơ mà", and, offered a first write slice or full campaigns, "Chiến dịch đầy đủ". Proposed decision record: [ADR-0043](../adr/0043-ads-write-running-ads.md). Vietnamese summary for JOY: [ads-write.vi.md](ads-write.vi.md). **Docs only: nothing here is built.** JOY answered section 11 on 2026-11-01: Q1 A, and every other question with its recommendation ("Nhận hết", recorded on #2283), so W0, W1 and W2 are built in that order (section 10); W3 to W6 wait. The Platform PO reviewed the design and asked for the five additions now in section 3.2, 3.3, 3.6 and 5.1.

Facts are tagged as in the [Ads plan](ads.md): **[C]** stated on an official page that was read, **[S]** only a secondary source, **[U]** could not be confirmed and is checked in the platform's console before a build issue relies on it. Research was done on 2026-11-01; Meta's pages were read through search summaries, so every number is re-checked by the build issue that uses it.

## 1. What changes, and what does not

The approved v1 ([ads.md](ads.md) section 2, ADR-0040 point 2) is read only: Ludy shows spend and results next to the books. The owner now wants the owner-operator to **run ads from Ludy**: build a campaign with its ad sets and ads from Ludy's own posts and media library, launch it, watch it, change its budget, pause it. Hootsuite Ads is the reference: create and manage Facebook, Instagram, LinkedIn and X ads, a manual Boost of a published post, an Automated Boost, and ads on the content calendar.

What stays as decided and is **not reopened**:
- The Ads module (`ads`), the sibling package `@crove/ad-platform`, the connection and credential layer of ADR-0025, tenancy, the one write path and the job egress invariant.
- **Ads never posts to the books.** Spend still reaches Kế toán through intake (card and bank lines, and the platform invoices of slice D) and the books strip; Ludy only adds the *planned* spend beside the actual one (section 8).
- The read side and its adapters stay read only: the reader files keep their tests that no write endpoint is called (#2218). Writing is a separate adapter interface in a separate file with its own pinned endpoint list (section 9).

What changes: ADR-0040 point 2 ("read-only by construction", "any later write needs a new ADR: R3 commands, four-eyes, and an approval that names the amount") is answered by this amendment and ADR-0043, in the way that sentence asked for.

## 2. Scope and order

Meta first, then the rest; each slice is one end-to-end build issue (section 10). **No slice spends money before an approved launch.**

| Slice | What a person can do | Spends? |
|---|---|---|
| **W0 Switch, access and caps** | An owner turns on ad writing for the org, then connects (or reconnects) an ad account **with write permission**; roles for drafting, approving, managing; the spend caps (default: none can launch). The sandbox ad platform gains its write side so everything runs offline | No platform call |
| **W1 Draft and validate** | Build a campaign draft: objective, ad sets (budget, schedule, location, age, gender, interests, placements), ads (creative from a Social post or the media library), checked locally against Meta's rules; shown as a preview; submitted for approval | No: nothing leaves Ludy |
| **W2 Launch on Meta** | After approval, Ludy creates the campaign, ad sets, creatives and ads on the platform, **paused**, then activates them; shows Meta's review state (in review, rejected, active) and reasons | **Yes, only after the approval of exactly this plan** |
| **W3 Boost a published post** | From a published Social post: goal, budget, days, audience preset, then the same approval and launch | Yes, same gate |
| **W4 Manage** | Pause and resume a campaign, ad set or ad; raise or lower a budget; extend or shorten a schedule; archive | Raise, resume and extend are approved like a launch; lower, pause and shorten are not |
| **W5 Ads on the Social calendar** | An ad flight shows on the Social calendar next to posts; scheduling a flight is a launch with a start date in the future | As W2 |
| **W6 Automated Boost, then Google** | Rules that boost posts that do well, inside a spend cap the owner approved; Google Ads writing in its own ADR after Google reading (slice B) | Bounded by an approved rule |

Order inside Meta: **Traffic, then Engagement (a post), then Messages (click to Messenger)** are the first objectives, because they need no pixel or customer data and Messenger is how a Vietnamese small business is contacted (recommendation, Q4). Sales and Leads objectives follow once the conversion and lead-form questions (section 6) are decided.

### What stays out, and why

| Out | Why |
|---|---|
| Custom audiences, lookalikes, customer lists, lead forms, pixel and Conversions API | Personal data of third parties sent to or collected by a platform: its own decision (section 6, Q6) |
| Sales and Leads objectives | They depend on a pixel, the Conversions API or a lead form (the line above) |
| Special ad categories (credit, employment, housing, social issues, elections and politics, and similar) | Meta requires a declaration and restricts targeting [C]; Ludy lets the owner declare **none** and refuses to launch an account the owner marks as running a regulated category, until a lawyer reads the rules for Vietnam |
| Automated rules on the platform side, Advantage+ campaigns, catalog and dynamic ads, app install ads | Platform automation changes spend without Ludy's approval; the first slices keep every spend change a Ludy command |
| Editing a live ad's creative | A creative edit restarts review and can change what is shown; first slices create a new ad instead (W4 later) |
| Paying Meta, adding or changing payment methods, raising the account spending limit | Billing stays in the platform; the owner does it there |
| Agency features, many client accounts | Not the OPC and SME focus (ads.md section 2) |
| LinkedIn, X, TikTok, Google writing | After Meta works; each its own ADR |

## 3. Money and approval

**Principle: nothing that can spend runs unless a human approved exactly that plan, within a cap the owner set, with a record.** The kernel's policy already has the pieces ([kernel plan](crove-os-kernel.md) section 4.7: R0 to R3, the derived-risk rule, P08, P10 to P13); this section maps the ads commands onto them.

### 3.1 Risk of each command

An action that can **start or raise spend** declares `sideEffect: 'financial'`, so it is **R3** by the derived-risk rule: it goes through a proposal, a human approver who is not an author of it (P10), a fresh second factor (P11) and the approver's own permission and legal entity (P12); above the org's money threshold it escalates one level (P08). What only reduces spend or changes nothing at the platform is R2 `external` or R1.

| Command | Risk | Who may run it | Notes |
|---|---|---|---|
| `ads.campaign.draft_save`, `draft_edit`, `draft_discard` | R1 | owner, admin, marketing | Local only, reversible |
| `ads.campaign.submit` (ask for approval) | R1, creates the proposal | owner, admin, marketing | Freezes the draft and its input hash |
| `ads.campaign.launch` (create and activate) | **R3 financial**, proposal | approver per P10 to P12 | The approval card names the amounts (3.2). Executed once (P13) |
| `ads.campaign.activate` / resume | **R3 financial** | approver | Spend restarts |
| `ads.budget.raise`, `ads.schedule.extend` | **R3 financial** | approver | Anything that raises the money a plan can spend |
| `ads.budget.lower`, `ads.schedule.shorten`, pause, archive | R2 external | owner, admin, marketing | Reduces or stops spend; no approval, always audited |
| `ads.pause_all` (kill switch, 3.6) | R2 external | owner, admin, marketing | Pauses everything Ludy launched in the org and blocks new launches until an owner clears the flag |
| `ads.cap.set` (spend caps, 3.3) | **R3**, owner only, `aal2` | owner | A cap raised is spend raised |
| `ads.write.enable` (org switch, 5.1), `ads.account.enable_write` | R3 | owner | Opens the write path at all |

A command that moves money declared below R3 fails registration (the derived-risk rule); the job egress invariant requires every command that feeds the write queue to declare an external effect.

### 3.2 What the approver sees and signs

The proposal's card (the approval screens of the kernel) shows, for every ad set: the objective, the **daily or lifetime budget in the account's currency**, the schedule, therefore the **largest amount the plan can spend** (lifetime budget, or daily budget times the days, summed over the ad sets), the audience summary (location, age, gender, interests), the placements, and a preview of each ad. The approval binds the **input hash** of this plan (the command's input is hashed under the deployment's key, #1732): any change to a budget, a date or a creative after submission is a new proposal. Approving does not give Ludy a standing right to spend: only to run this plan once (P13).

Four-eyes (P10) applies when two or more eligible humans exist. **The one-person-company path:** an org whose only eligible human is the owner may approve its own plan, and the audit row says `self_approved`; nothing else is relaxed: a fresh second factor (P11) is still required, the card still names the largest amount, and the caps still bind. An owner with no verified second factor cannot switch writing on (5.1) until they enrol one. Once a second eligible human joins, the owner can no longer approve a plan they wrote. An agent never approves (ADR-0029).

### 3.3 Spend caps

Per ad account and per org: a **daily cap** and a **monthly cap**, in the account's currency, set by the owner (`ads.cap.set`, step-up). **The default is no cap and therefore no launch**: until the owner sets caps, every launch is refused with `ADS_SPEND_CAP_NOT_SET` (recommendation, Q3). At approval time and again at execution the command computes the **committed spend**: for every live or scheduled campaign of the account, its daily budget times the days left in the period, or its lifetime budget left, plus this plan's. A plan that would exceed a cap is refused (`ADS_SPEND_CAP`) with the numbers. Meta's own account spending limit is read and shown beside Ludy's caps [U: the field and its permission]; Ludy's caps are a second fence, never a replacement of the platform's.

**The execution check runs under a lock.** The check at approval only warns early; the one at execution is authoritative. The launch step takes a per-org transaction advisory lock, recomputes the committed spend from `crove_ads` rows and, in the same transaction, writes the plan's commitment before any platform call. Two launches approved together serialise: the second sees the first's commitment and is refused if both would pass a cap. A commitment is released only when its objects are archived or their schedule has ended. A test launches in parallel and asserts that committed spend never passes a cap.

**Caps have a currency.** A cap is a decimal string in the currency's own units (dong, or dollars with cents: the units a person types and the Ads screen shows, at most two decimals), with an ISO 4217 currency code, never a JS number; the launch converts a platform's minor-unit budgets with decimal.js before it compares. Each cap carries its own currency. An account cap is in the account's currency (refused at `ads.cap.set` otherwise, and before the account's first update, when its currency is unknown). An org cap is in any ISO currency (VND by habit); a launch is refused with `ADS_CAP_CURRENCY` unless every org cap that applies is in the account's currency, since converting would add a rate the approver did not see, so it is a later amendment. The currency of an org cap can be changed by setting the cap again.

### 3.4 Exactly-once calls to the platform, and reconcile

Every platform call that creates or changes something goes through the kernel's `external_call` ledger with a **deterministic key** (`ads.launch:<launch id>:<step>`, steps in order: campaign, each ad set, each creative, each ad, then the activation), the same pipeline as publishing a post. A step runs at most once per attempt; a timeout or a lost answer leaves it `ambiguous`, and a **reconcile job asks the platform before anything is retried**.

- Meta has no idempotency key for creating campaign objects [U], so every object Ludy creates carries a tag in its name (`ludy:<short id>`), and reconcile lists the account's objects by that tag to find one that was created but not recorded.
- Objects are created **paused**, so a launch that stops half way has spent nothing; activation is the last step and its own call.
- A failed or stopped launch shows which step it stopped at; **retry continues from there**, discard archives the paused objects (R2).

### 3.5 Audit, undo and agents

- Every command writes an audit row with the ids, the amounts and the states, never the creative text (the campaign and ad names are business text; they follow the data classes of the manifest).
- There is no undo of money already spent: the controls are the approval before, the caps, the pause (always allowed), and the platform's own limit.
- **What an agent may do:** write **drafts** (R1), which reach a human as a proposal like any agent work; **never launch, activate, resume, raise or extend, set a cap, or enable writing.** This amends the write allowlist of ADR-0029 for the draft commands only (ADR-0043 point 7, the Marketing PO's recommendation, which the owner may reverse).

### 3.6 The kill switch

`ads.pause_all` (R2, owner, admin and marketing members, no proposal and no second factor, because it only stops spend) pauses every campaign and ad set Ludy launched in the org, found from the recorded object ids and checked against the `ludy:` name tag, as `external_call` steps keyed `ads.pause_all:<run id>:<object>` so a double click pauses once. It sets the org flag `launches_blocked`: while set, every launch, activation and resume is refused, and only an owner clears it (R3, step-up). Turning the org switch off (5.1) runs the same pause first. The Ads screen offers it as one clearly marked button; the audit row counts the objects paused and lists any the platform refused with its reason.

## 4. Meta's objects, states and limits

[C] unless tagged. A campaign is created with a name, an objective and `special_ad_categories` (required; `NONE` when none), under `POST /act_<id>/campaigns`; an ad set with its budget, schedule, targeting, optimization goal and billing event under the ad set edge; an ad creative (for a post-based ad from a published post, the story of that post [U: whether `object_story_id` is supported for every objective and placement; one Meta page says it is not supported for Click-to-Messenger]) and an ad under the ads edge. The current objective names are the "outcome" ones (`OUTCOME_TRAFFIC`, `OUTCOME_ENGAGEMENT`, `OUTCOME_LEADS`, `OUTCOME_SALES` and others) [C]. Budgets are in the account currency's smallest unit and have a minimum per currency [U].

**States.** An object's `effective_status` moves through `IN_PROCESS` (post-processing after a create or edit), `PENDING_REVIEW`, `ACTIVE`, `PAUSED`, `WITH_ISSUES` and `DISAPPROVED`, with the reasons in `review_feedback` and `issues_info` [C]. Ludy reads them back with the existing hourly sync (a new read of object states, never a write) and shows each ad as in review, rejected (with Meta's reason, in words) or active. A rejected ad is never re-submitted automatically. How long a review takes is [U]; the screen says "in review" and when Ludy last asked.

**Rate limits.** Write calls count against the same tier caps as reads, and the Limited tier's are low [C for the score cap, U for how many creates one launch may make an hour] (ads.md section 5.3): a launch of one campaign with a few ad sets and ads is about ten calls. Ludy spaces the steps, backs off for the time a limit names, and the app never retries in a loop.

**Access.** See section 5.2. On the Limited tier writes to the owner's **own** ad accounts are allowed with `ads_management` [C]; whether the tier's write limits are enough for a real launch is [U] and the first thing the W2 live check records.

## 5. Permissions and access

### 5.1 The org switch, which replaces the refusal guard

A read-only connection and a read-write one are different things, so write access is a **separate, explicit step**, in three layers:

1. **Deployment:** the platform app. The same Meta app may serve (as for reading), but a **separate app for writing is the recommendation** (Q7 of ADR-0043): `ads_management` on the app that also posts to Pages widens what a leaked Pages token can do, and a failed App Review for writing must not block reading.
2. **Org switch** `ads.write` (off by default; `ads.write.enable`, owner, step-up, audited). Off: the connector keeps the guard of #2275 and **refuses any token that holds `ads_management` or `business_management`** (read-only orgs keep refusing write scopes). On: the connector for that org asks Meta for `ads_read` and `ads_management` (and the Page permissions a post-based ad needs [U]) and **accepts** them, recording the full set on the connection.
3. **Ad account:** `write_enabled` per ad account (owner), default off, so one account can stay read-only inside an org that writes. Connecting for write is a **new connection step** ("Cho phép Ludy chạy quảng cáo trên tài khoản này"), never an upgrade of a connection in place: the person goes through Meta's dialog again and the screen shows the account as able to write.

**The write token is its own credential:**
- *Sealed separately:* a second sealed credential of the connection (ADR-0025), apart from the read token, opened by the worker alone and only inside a write job, so a leak of the read path cannot spend.
- *Require App Secret:* every write call carries `appsecret_proof`, and the write app has "Require App Secret" on at Meta, so a copied token is useless without the app secret.
- *Revoked at Meta on disconnect or switch-off:* the worker removes the app's permissions at Meta (the writer's one call that is not about an ad object, named in its endpoint list) and then deletes the sealed copy. A failed revoke is retried and shown as not yet revoked; the sealed copy stays until it succeeds.
- *Queued writes stop when the switch goes off:* the write job re-checks the org switch and the account's write flag before every step. Switching off cancels every launch not started and every step not run; a step in flight finishes and is recorded; created objects stay paused.

The guard of #2275 is therefore not removed but **made conditional on the org switch**; its tests stay and gain the switch-on path. The Ads screen shows, per account, whether the token can only read or can also run ads (the `extraScopes` line of #2275 becomes a clear "read only / can run ads" state).

### 5.2 Meta access, and what only JOY can do

All of this is an `owner-action` (AGENTS.md): no agent signs in or submits a review.

- **Own ad accounts, the owner's classic app, Limited tier:** standard access to `ads_read` and `ads_management` is enough for an app that manages only its owner's accounts [C]. Needed: the person connecting has a role on the app, the app is in development mode or its permissions are live for that person, and the ad account has a payment method on Meta's side. This is what JOY can do **today** with the existing app, after W0 to W2 are built.
- **Other businesses' accounts (Ludy Cloud):** Advanced access to `ads_management` (and `business_management` if used) through **App Review**, which needs **Business Verification** of the portfolio behind the app, a screencast of the whole create-and-launch flow, a privacy policy URL, a data deletion callback (already planned for reading, ads.md section 9), and a usage history (Meta's older guidance: 1,500 calls in 15 days, a newer page says 500 [C, disagree]) [C]. Whether Ludy's approval step (a human approves before spend) helps the review is [U]. Steps for JOY, in order: (1) decide Q5 on timing; (2) confirm the business portfolio is verified; (3) create the separate write app (Q7) with the Marketing API product; (4) record the screencast from the W2 build on the owner's own account; (5) submit; (6) answer Meta's follow-up.
- **Meta's advertising policies and ad review** apply to every ad the owner makes; Ludy shows Meta's rejection reasons and never tries to evade a review.
- **Vietnamese advertising law** (the Law on Advertising and its decrees: restricted products and claims, content rules) [S, not read here] applies to the owner's ads; Ludy does not check ad content against it. A lawyer reads it before Ludy offers templates or suggests wording (the AI-written ad copy of a later slice, if any).

### 5.3 Roles

New permissions, none granted today (`roles.ts` grants nothing for ads): `ads.campaign.draft` (owner, admin, marketing members), `ads.campaign.approve` (owner, admin; the holders of the approval permission, P12), `ads.campaign.manage` (pause, lower, archive: owner, admin, marketing), `ads.cap.set` and the two switches (owner only). The author of a plan cannot approve it (P10); finance roles and viewers read.

## 6. Personal data

- **Targeting stores none.** Location (country, region, city and a radius), age range, gender, language, interests (Meta's interest ids and names) and placements are **parameters of an audience, not people**; no table holds a person. They are classed as ordinary business text in the module manifest. The audience size estimate Meta returns is an aggregate.
- **Creatives** are the org's own posts and media (already stored by Social and the file store); Ludy copies the text and the file ids into the draft, and the platform stores the rest.
- **Custom audiences are personal data and are a separate decision (Q6).** A customer list (emails, phones) uploaded to Meta is a transfer of third parties' personal data to a platform, under the Law on Personal Data Protection (Law 91/2025/QH15, Decree 356/2025/NĐ-CP, as the [privacy notice](../legal/privacy.md) cites them): it needs a legal basis, a notice, a processor agreement and a lawyer's reading. **Recommendation: out of the first slices.** Lookalikes depend on them; Conversions API and pixel events send customer events to Meta and are out for the same reason; **lead ad forms collect personal data on the platform and are out**. If JOY wants them, a further amendment and ADR open with the lawyer first.
- **No breakdowns** of results by age, gender or region (ads.md section 9) stay out: the aggregates a campaign reports are what the screens show.
- The privacy notice gains the new data category (campaign drafts and targeting parameters) with the wording of [#2247](https://github.com/DOS/Ludy/issues/2247).

## 7. Tenancy, credentials, egress

- The same rules as reading: every table has `org_id`, `PRIMARY KEY (org_id, id)`, RLS and the legal-entity scope; no foreign key outside `crove_ads` and `crove_kernel`; no cross-module read (the creative comes from the app, composed from a Social query, and is **copied into the draft at submission**, so Ads reads no Social table).
- **Credentials:** the write token is the connection's sealed token (ADR-0025), opened by the **worker alone**; the API never calls the platform. The write adapter is handed the token only inside the launch job.
- **Egress:** the write queue (`ads-write`) declares the same `provider:ad_platform` target; every command that feeds it declares R2 or R3 and an external effect (the job egress invariant). The write adapter's fetch is bound to `graph.facebook.com` over https exactly as the reader (#2275).
- The invariant suite grows rows for the new tables (RLS matrix, as in #2237 and #2265), a test that **no agent context writes** the launch tables, a redaction test (no token anywhere), and a test that the write adapter's source names only the endpoint list of section 9.

## 8. Books

Spend still lands in Kế toán the way [section 6 of the Ads plan](ads.md#6-where-the-money-lands-in-kế-toán) says: card and bank lines, the platform invoices (slice D), the expense account per ad account. Ads **does not post**. What changes on screen: next to the actual spend, Ludy shows **committed spend** (the money the live and scheduled plans can still spend this month, from 3.3), so the owner sees what is about to reach the books. The comparison strip is unchanged.

## 9. Data model, commands and the write adapter

Tables of `crove_ads`, all tenant tables per section 7 (names are proposals for the build issues):

| Table | Holds |
|---|---|
| `ad_campaign_draft`, `ad_set_draft`, `ad_draft` | The plan being built: objective, budgets (numeric, account currency), schedule, targeting parameters (jsonb of known keys), creative snapshot (text, file ids, link), status `draft`, `submitted`, `approved`, `launching`, `live`, `stopped`, `discarded`; the proposal id once submitted; a revision counter |
| `ad_launch` | One launch attempt of an approved plan: the step list with each step's `external_call` key and state, the committed amount, `started_at`, `finished_at` |
| `ad_object` | The mapping to the platform: level (campaign, ad set, creative, ad), external id, name tag, `effective_status`, `review_reason` code, `settled_at`-like `last_seen_at` |
| `ad_spend_cap` | Scope (org or ad account), period (daily, monthly), amount, who set it and when (append-only history) |
| `ad_account` gains | `write_enabled`, `platform_spending_limit` read from the platform |

Commands are those of section 3.1 plus `ads.object.sync_state` (system, the sync's read of object states). Queries: the drafts, a launch and its steps, the committed spend, the caps.

**The write adapter** is a second interface, `AdWriter`, in `@crove/ad-platform`, in its own file per platform (`meta-write.ts`), implemented only where the org switch is on: `createCampaign`, `createAdSet`, `createCreative`, `createAd`, `setStatus` (activate, pause, archive), `setBudget`, `setSchedule`, `readObjectStatus`, and `revokeToken` (removes the app's permissions at Meta, 5.1). **There is no delete of any ad object.** A test pins the exact endpoints it calls (POST to the four create edges and to an object's own edge to change status, budget and schedule; GET for status), the host binding and the absence of any other method, as for the reader. The reader files keep their own test unchanged.

## 10. Build issues (W0, W1, W2 approved by JOY on 2026-11-01, built in this order; the Marketing PO opens them after this amendment merges)

W3 to W6 stay unopened. Each is end to end (contract, server, UI, tests) with the live check on JOY's own account for the ones that call Meta. Acceptance items are the ones the sections above state.

1. **W0 Switch, access and caps.** Org switch and `write_enabled`, the write connection step, the conditional guard and its tests both ways, roles and permissions, `ads.cap.set` with caps and committed spend, the `extraScopes` line becomes "read only / can run ads", the sandbox writer, the separately sealed write token with Require App Secret and its revoke on disconnect or switch-off, the `launches_blocked` flag and `ads.pause_all` (3.6), the one-person path of 3.2, cap currencies (3.3). Acceptance: with the switch off a token holding `ads_management` is refused as today; with it on it connects and the screen says it can run ads; no platform call exists yet.
2. **W1 Draft and validate.** The draft tables and commands, the builder screens (objective, ad sets, ads from a Social post or the media library), local validation, the approval card with the maximum spend, the proposal. Acceptance: a draft submits for approval and an approver sees the amounts; nothing leaves Ludy; an agent can draft but not submit.
3. **W2 Launch on Meta.** `AdWriter` for Meta, the launch job with `external_call` steps and reconcile, the object-state read, review states on screen, the caps checked at approval and, under the per-org lock, at execution (3.3), queued steps stopping when the switch goes off (5.1). Acceptance: on the sandbox the whole flow runs offline; on JOY's own account one small approved campaign runs and pauses; a killed job reconciles without a duplicate object; a plan over a cap is refused; two launches approved together cannot pass a cap between them; switching writing off stops queued steps and pauses what was launched.
4. **W3 Boost a published post.** From the Social post, the same approval and launch.
5. **W4 Manage.** Pause, resume, budget and schedule changes with the R2/R3 split of 3.1.
6. **W5 Ads on the Social calendar.**
7. **W6 Automated Boost** (its own approval policy for rules) and, separately, **Google Ads writing** (its own ADR).

**W0 is four kinds of PR (#2294):** the invariant rows of the new tables (the step-one PRs), **W0a-1** (the stops, the state and the database guards, below), **W0a-2** (the opening commands as proposals, below) and **W0b** (the write connection, its sealed token, the conditional guard, the sandbox writer).

**W0a-1 as built (the state, the stops, the guards).** Two tables, `crove_ads.ad_org_setting` (the org's `write_enabled` and `launches_blocked`, one row per org by a unique key; the commands also take a lock on first use) and `crove_ads.ad_spend_cap` (a row per cap change: scope `org` or `account`, period, amount, currency, who set it and when; append-only), and `ad_account.write_enabled`. Org-wide, so neither table names a legal entity; owners and admins read them through `ads.write.state`. Direct commands, all of them what only stops spend: `ads.write.disable` (R2, owner: every account flag off and launches blocked), `ads.account.disable_write` (R2, owner) and `ads.pause_all` (R2, owner and admin: blocks launches at once; **there is nothing launched to pause yet**, the pausing of objects comes with the launch, W2). What opens the way to spend (the org switch on, an account enabled, a cap set or raised, launches opened again) is a proposal with P10 and the one-person path, as ADR-0043 point 1 says, and comes with W0a-2; **no direct command does it, and a test pins that none exists**. The database guards the tables whatever path reaches them (`crove_ads.switch_guard`, `cap_guard`, fired for every role): a write switch turned on, on a row made or changed, or launches unblocked, needs a signed-in owner **or the execution of the approved proposal of its own command** (`crove_ads.approved_execution`, a second branch that is present but **stubbed closed** in W0a-1 and opened by W0a-2 behind the approval gate's marker, with tests both ways; never a plain admin or member context); turning one off or blocking launches, an owner or admin; an agent, the system or any other context is refused either way; the switches stamp who changed them and when, and a cap row is inserted by a signed-in owner alone with its id, who set it and when stamped by the server, so "the latest cap" is the newest server-stamped id and a crafted future id cannot stay the cap for good. A live agent run cannot do any of it (a test enters an agent context as the worker does). The module permissions of 5.3 are not defined yet: the commands use the base roles (owner, admin) until W1's drafting and approving commands give a permission something to name. Nothing calls a platform; the Ads screen shows the switches, the per-account flags and the caps, and holds the stop controls, for owners and admins.

**W0a-2 (the opening, as proposals).** The commands that open the way to spend, `ads.write.enable`, `ads.account.enable_write`, `ads.cap.set` (set or raise) and `ads.launches.unblock`, are R3 `financial` **proposals** with their prepare commands, the approval policy in `approval.ts` mirrored by the database gate and its parity test, and the Inbox rendering of each proposal; lowering a cap is a direct R2 `ads.cap.lower`. It is its own protected PR, after W0a-1.

The App Review work of section 5.2 is not a build issue; it is the owner's, timed by Q5.

## 11. Questions for JOY

**Answered on 2026-11-01: Q1 A, and "Nhận hết" for Q2 to Q8, that is every recommendation (recorded on #2283):** Q1 A (W0, W1, W2 in order), Q2 A, Q3 A (no cap, no launch), Q4 A (Traffic, Engagement, Messages), Q5 A (review after W2 works on JOY's own account), Q6 A (no customer-list audiences), Q7 B for JOY's own account (the existing classic app, shared with reading and Pages) and A, a separate Meta app for ad writing, before Ludy serves other businesses (corrected by the Marketing PO on 2026-11-02: the recommendation was A, the answer for the owner's own testing is the default B). The write app is its own env pair, `CHANNEL_META_ADS_WRITE_APP_ID` and `_SECRET`, which may hold the same app as the read or Pages pair: no check makes them differ, Q8 A (Automated Boost later, as rules inside an approved cap). The text below is kept as asked.

Each says what is decided, why it matters, the options, the recommendation, and what happens without an answer. The Vietnamese summary is [ads-write.vi.md](ads-write.vi.md); the ADR carries the decisions that are architecture.

**Q1. Which write slice first, and may W0 to W2 be opened?** (Who acts: JOY.) It decides whether any build starts.
- **A. W0, W1, W2 in this order: set up, draft and approve with nothing spending, then launch one campaign (recommended).** The owner sees and approves before the first spend, and the first launch is on her own account.
- **B. Boost a published post first** (the shortest path to spending, less to approve). One Boost needs the same switch, caps and approval, so it is W3 on the same ground; building it first means building W0 and most of W2 anyway.
- **C. Stay read only.** Not what was asked.
Without an answer no build issue opens.

**Q2. Who approves a launch?** (Who acts: JOY.) It decides who can start spending.
- **A. Owner and admin, never the person who wrote the plan; an org with one human lets the owner approve her own, flagged (recommended; it is the kernel's rule P10).**
- **B. Also a named marketing approver** chosen by the owner.
Without an answer: A.

**Q3. Spend caps: none by default?** (Who acts: JOY.) It decides whether a first launch can run before limits exist.
- **A. No cap, no launch: the owner must set a daily and a monthly cap per ad account first (recommended).**
- **B. A default cap** (for example a daily amount) that the owner may change. Less friction, a surprise bill if the default is high.
Without an answer: A.

**Q4. Which objectives first?** (Who acts: JOY.)
- **A. Traffic, Engagement (a post) and Messages to Messenger (recommended):** they need no pixel or customer data.
- **B. Add Sales and Leads now:** they need a pixel, the Conversions API or a lead form, which are personal data (Q6).
Without an answer: A.

**Q5. When to start Meta's Business Verification and App Review for writing (Ludy Cloud, other businesses)?** (Who acts: JOY, an owner step.) Review takes time and a screencast of a working flow.
- **A. After W2 works on JOY's own account (recommended):** the screencast shows the real flow.
- **B. Now,** in parallel: faster for Cloud, but the review looks at a flow that is not built.
Without an answer: A. JOY's own accounts need no review.

**Q6. Custom audiences (customer lists), lookalikes, pixel, lead forms?** (Who acts: JOY and a lawyer.) They are personal data of third parties.
- **A. Out of these slices; a later amendment opens them with the lawyer first (recommended).**
- **B. Include customer-list audiences in W2.** Needs a legal basis, a notice, a processor agreement and a lawyer's reading first.
Without an answer: A.

**Q7. Which Meta app for writing?** (Who acts: JOY, an owner step.) It decides how much a leaked token can do.
- **A. A separate Meta app only for ads writing (recommended):** `ads_management` and Pages publishing never share one token, and a review problem on one does not block the other.
- **B. The one classic app JOY has,** shared with Pages and reading. No new app to create; the token then also holds the Pages permissions (the screen says so, #2275).
Without an answer: B for JOY's own testing, A before Ludy Cloud.

**Q8. Automated Boost (W6)?** (Who acts: JOY.)
- **A. Yes, later, as rules inside a cap the owner approved, with every spend inside the cap still logged (recommended).**
- **B. Never:** Boost stays manual.
Without an answer it waits.
