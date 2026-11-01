# 0040. Ads: read-only ad platform sources in a module of their own, on the channel layer

- Status: Accepted (owner, 2026-11-01, answers to Q1 to Q6 of the [ads plan](../plan/ads.md#12-questions-for-joy), comments on [#2214](https://github.com/DOS/Ludy/issues/2214)). Proposed 2026-11-01. The first slice is built in #2217.
- Date: 2026-11-01
- Deciders: owner (JOY), on the Marketing PO's recommendation
- Builds on:
  - ADR-0025 (channel layer: connections, sealed credentials, adapters with an egress allowlist);
  - ADR-0039 (a sibling adapter package for a read-only data source, the model for this one);
  - ADR-0027 (the open-source core runs without any DOS service);
  - ADR-0029 (agents, and their write allowlist);
  - ADR-0031 (module enablement);
  - the job egress invariant (#1653);
  - the data classes of module manifests (#1599).
- Issue: [#2214](https://github.com/DOS/Ludy/issues/2214)

## Context and problem statement

The owner asked on 2026-11-01 for an Ads module, in the Marketing line next to Social. A one-person company or SME runs ads on Meta, Google and TikTok, sees the spend in each platform's console, and sees the same money in the books weeks later as card lines and invoices. Ludy can show the two side by side.

What has to be decided before any code:
1. Where Ads lives: inside Social, inside the channel package, or as its own module.
2. Whether v1 may write to a platform (create or edit campaigns, budgets), or only read.
3. How platform connections, tokens and apps are shared with Social without breaking ADR-0025.
4. How Ads meets the books without breaking Finance's one write path or the module boundaries.
5. What personal data Ads may store.

Facts that shape the choices (details, sources and confidence tags in the [plan](../plan/ads.md)):
- **Meta**: the Marketing API's use cases all carry `ads_management` (write permission), even "measure ad performance", and none can be removed. Standard access covers the app owner's own ad accounts with no review; other businesses need Advanced access, App Review and Business Verification. User tokens last about 60 days with no refresh. Meta treats aggregated spend as Platform Data and requires a data deletion callback.
- **Google**: the `adwords` scope is restricted. Access levels now belong to the Cloud project; the policy says each advertiser needs its own project, except open-source tools where users bring their own credentials.
- **TikTok and Zalo**: TikTok's docs are not readable without a browser; no public Zalo Ads reporting API was found.

## Decision drivers

- **Read-only first.** Moving money needs its own risk model; the owner asked for visibility.
- **ADR-0027.** `docker compose up` runs with no platform account and no DOS service; each platform is enabled by the deployment's own app credentials.
- **One write path, tenancy and the sealed context** (AGENTS.md rules) are unchanged.
- **OPC and SME first.** The first slice must work for the owner's own account without waiting for a platform review.
- **No personal data in v1.**

## Decision (proposed)

### 1. A module of its own: `ads`, in the Marketing line

`modules/ads` (`@crove/mod-ads`, schema `crove_ads`), `dependsOn: ['kernel']` only. It is not part of Social: users, permissions, cadence (reading numbers, not posting), platform reviews and apps differ, and each can be switched on alone. Social and Ads share the connection and credential layer of ADR-0025 and the Marketing line's PO, not tables.

### 2. Read-only by construction

- The adapter interface has `connect`, `listAccounts` and `readDaily`, and **no write capability**. An adapter for a platform that also offers writes implements none of them, and review refuses a change that calls a write endpoint.
- A test pins each adapter's source to read endpoints (Meta's one async report `POST`, used for the backfill, is listed by name).
- The token may still carry write permission (Meta forces `ads_management`), so the mitigations are those of ADR-0025 (sealed, opened only by the worker, never in output) plus telling the owner at connect which permission the platform forced, and dropping the credential at disconnect.
- Creating or editing campaigns, budgets, bidding, audiences, lead forms and conversion APIs are out of v1. Any later write needs a new ADR: R3 commands, four-eyes, and an approval that names the amount.

### 3. A sibling adapter package on the channel layer

- `@crove/ad-platform`, built like `@crove/channel` and `@crove/bank-feed`: capability interfaces, static capability data, a declared FQDN allowlist the adapter's fetch is bound to, an offline `sandbox` adapter. It reuses `@crove/channel`'s OAuth building blocks (`OAuthConnector`, `newOAuthAttempt`, `allowlistedFetch`, `withCallSignal`).
- **Connections are the kernel's**: one `crove_kernel.channel_connection` per ad account (provider ids `meta_ads`, `google_ads`, `tiktok_ads`, `sandbox_ads`), the token sealed in `crove_kernel.credential`, opened only by the worker, refused once the connecting member leaves. Connect and disconnect stay `kernel.channel.connect` and `kernel.channel.disconnect` (R2, owner or admin).
- **Separate platform apps by default.** A Meta ads app (`CHANNEL_META_ADS_APP_ID`, `CHANNEL_META_ADS_APP_SECRET`) apart from the Pages and Instagram apps; a Google OAuth client for Ads (`CHANNEL_GOOGLE_ADS_CLIENT_ID`, `CHANNEL_GOOGLE_ADS_CLIENT_SECRET`) apart from the Calendar, YouTube and Business Profile client; TikTok's likewise. Reasons: Meta use cases cannot be removed once chosen and combining Pages with the Marketing API is not documented; a restricted Google scope on a client changes the verification of everything on it. Env names are fixed in the build issues.

### 4. Facts, not postings: daily aggregates in the account's own terms

- `crove_ads.ad_account` (settings per connected ad account: legal entity, currency, time zone, the action type that counts as a "result", the expense account), `ad_spend_day` (daily aggregates per account and campaign) and `ad_sync_run`. Tenant conventions as in AGENTS.md: `(org_id, id)` keys, RLS, composite foreign keys only into `crove_ads` or `crove_kernel`, `numeric` money, `timestamptz`, restrictive legal-entity scope.
- **Currency and day are the platform's**: stored in the account's currency and time zone, labeled, never converted by Ads.
- **A restated day is updated in place**; a day past the platform's revision window is **settled** and not read again. A sync run and its rows commit in one transaction, so the cursor moves only with its rows.
- **Cost per result is computed on read**, `spend / results` in decimal, from the action type the owner chose; never stored, never a JS number.
- Syncs are worker jobs on queues that declare the platform's hosts; the commands feeding them declare an external effect (#1653). Rows are written only by `ads.sync.record` (system), through `Runtime.execute()`.

### 5. Ads never posts; it meets the books through queries

- No foreign key or query reads `crove_finance`. The books strip is two queries composed by the app: Ads' spend summary and a Finance period total for the advertising expense account.
- The expense account is a setting per ad account (6421 under Circular 133 books, 641 or 6417 under Circular 99 books per secondary sources), defaulted from the entity's books regime and checked against that chart.
- Platform invoices and receipts enter the books through the normal intake and bank matching; Ads only says which month has none (a later slice). Ads creates no voucher, proposal or document.
- **No tax rule.** VAT and foreign contractor tax on ad invoices changed in 2025 and 2026 and is confirmed only by secondary sources; v1 shows no tax figure until the accountant (#61) confirms.

### 6. Personal data: none in v1

Stored: account and campaign ids and names and daily aggregates. No audiences, lead forms, pixel or conversion events, and no breakdowns by age, gender or region. Meta counts aggregates as Platform Data, so the Meta app provides the **data deletion callback** (through a definer, the org-purge pattern), `ads.account.delete_history` exists, and disconnect keeps the figures by default with a clear delete choice (the plan's Q4).

### 7. Switched on at two levels

A provider is enabled by the deployment's app credentials in env and hidden without them; the `sandbox` ad platform is on by default in development, so `docker compose up` works with no platform account. An owner or admin connects accounts and maps each to a legal entity. With `ads` out of `CROVE_MODULES`, the kernel, Finance and Social run unchanged. No agent writes `crove_ads` (ADR-0029's allowlist is unchanged).

## Decisions for the owner

The six questions in [the plan, section 12](../plan/ads.md#12-questions-for-joy): the first slice (Q1), when to start Meta's review for Ludy Cloud (Q2), Google on Cloud (Q3), history and disconnect (Q4), tax (Q5) and Zalo Ads (Q6). Without an answer, no build issue is opened.

## Consequences

- Owners see ad spend and cost per result next to the books, with no spreadsheet.
- New protected surface when built: a migration, the module manifest, new job queues, OAuth routes for new providers, credential opening in a new job. Each PR gets the independent security review, RLS matrix rows, a redaction test and the job egress invariant.
- Ludy Cloud cannot serve other businesses on Meta before App Review and Business Verification, and not on Google before CASA; self-hosters and the owner's own accounts work without either.
- The platforms' versions and rules move: each adapter pins one version and has recorded-answer tests.

## Alternatives considered

- **Ads inside Social or `@crove/channel`.** Rejected: the roles, data, review needs and screens differ, and `@crove/channel` is about publishing; sharing the connection layer already gives the benefit.
- **A third-party connector service** for reporting (a hosted data pipeline). Rejected: a DOS or vendor dependency in the core (ADR-0027) and a cost per customer; the platform APIs are readable.
- **Manual or CSV entry only.** Kept for Zalo Ads if no API exists; too much work for platforms that have one.
- **Write support in v1** (create campaigns, set budgets). Rejected: moving money needs its own risk model, approvals and platform write reviews, and the owner asked for visibility.
- **One shared Meta app for Pages, Instagram and Ads.** Rejected as the default: use cases cannot be removed, combining is not documented, and a review failure on ads would block publishing. Revisit if Meta documents that they combine.
- **System-user tokens** (Meta tokens that do not expire). Not v1: they belong to the app owner's own business assets and would mean an owner pastes a long-lived secret; the per-customer OAuth flow fits Ludy's model.
- **A vendor-held Google Cloud project for all customers.** Rejected for v1: needs CASA, Standard access and Required Minimum Functionality, against Google's one project per advertiser policy.
- **Reading the platforms' own "cost per result".** Rejected: defined by campaign objective and not confirmed as an API field; Ludy computes it from an action type the owner chooses.
