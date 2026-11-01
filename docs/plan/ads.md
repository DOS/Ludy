# Ludy Ads: module plan

> Plan for the Ads module (`ads`, product name "Ludy Ads"), 2026-11-01. Owner request of 2026-11-01 (#2214): "add an Ads module, probably in a Marketing app or line". The Platform PO folded Social and Ads into one Marketing line ([#2215](https://github.com/DOS/Ludy/pull/2215)). Focus per the owner's decision of 2026-10-31: one-person companies and SMEs first, no enterprise features. **Nothing here is built, and nothing is built until the owner approves the first slice** (section 12). Decision record: [ADR-0040](../adr/0040-ads-read-only-sources.md). Vietnamese summary for the owner: [ads.vi.md](ads.vi.md).

How facts are tagged in this plan. Research was done on 2026-11-01 from the platforms' own pages and, where noted, from secondary sources:
- **[C]** stated on an official page that was read.
- **[S]** stated only by a secondary source (an accounting or consultancy blog, a search summary). Never a rule in the software.
- **[U]** could not be confirmed (page not readable, JavaScript-only, 404, or silent). A human checks it in the platform's own console before a build issue relies on it.

Several platform pages were fetched as summaries, so every number below is re-checked against the live page by the build issue that uses it.

## 1. Who it is for, and the problem

A one-person company or a small business in Vietnam spends money on Meta (Facebook and Instagram), Google and TikTok ads. Today the owner sees:
- the spend in three ad consoles, each with its own currency, time zone and definition of a "result";
- the same money again in the books, as card or bank lines and (sometimes) an invoice, weeks later.

Nobody puts the two side by side, so two questions are answered late or never: "what did ads cost me this month, and what did I get for it?" and "is every ad charge in my books, with its invoice?"

Ludy already holds the books (Finance), the bank and card lines, the documents and, through Social, the same platform logins. Ads adds the missing half: the platforms' own numbers, read-only, next to the books.

**Persona.** The owner-operator who runs ads herself (or through a freelancer) and whose accountant (internal or a firm) closes the month. Role fit: owners and admins connect and configure; finance roles and marketing members read. No agency features (client accounts, white-label reports, approval of budgets): those are enterprise work and wait.

## 2. Scope

### v1 (read only)

- Connect an ad account of a platform through OAuth (sealed credential, same channel layer as Social).
- Pull daily **spend, impressions, clicks, reach (where the platform gives it) and results** per ad account and per campaign, in the account's currency and time zone.
- Screens: an account list; month and range totals; spend, results and **cost per result** per campaign; a trend; the latest sync and its health.
- **Next to the books:** per month, the platform's spend beside what the ledger holds on the entity's advertising expense account (section 6). A difference is shown, never fixed by Ads.
- A `sandbox` ad platform (offline, deterministic) so the whole flow runs under `docker compose up` with no platform account.
- Owner and admin can disconnect, and can delete an account's stored history.

### Out of v1 (and stays out until the owner asks)

| Out | Why |
|---|---|
| Creating or editing campaigns, ads, creatives | A write path to money. Needs its own risk model, approvals (R3, four-eyes) and each platform's write review |
| Budgets, bidding, pausing or resuming a campaign | Same: it moves money |
| Audiences, custom audiences, lookalikes, lead forms, conversion APIs, pixels | Personal data (section 9) and, for conversion APIs, sending customer data to a platform |
| Breakdowns by age, gender, region, device, placement | Aggregates, but small cells can single people out; adds nothing the first questions need |
| Invoices and receipts fetched from the platform | Slice D (section 11): the platforms differ (section 6), the first slice does not need them |
| VAT or foreign contractor tax (FCT) figures, declarations | Law changed in 2025 and 2026 and is only confirmed by secondary sources: needs the accountant (section 6, Q5) |
| Agents that read or act on ad data | No agent writes `crove_ads` (the write allowlist of ADR-0029 stays as it is); reading by an agent waits for a use case |
| Agency view (many client accounts, white label) | Not the OPC and SME focus |
| **Boost** (paying to promote an organic post from the composer or the post list) | It writes to the ad account and spends money; it also needs the write review of each platform. Hootsuite lists it next to Ads; Ludy does not in v1 |

### Where Ads sits in the app

Reference (the owner, 2026-11-01, a screenshot of Hootsuite's current dashboard): Ads is not a product of its own on the rail. It is a group inside its publishing product, next to Plan (calendar, drafts, content) and Analytics, with two items, Ads and Boost.

**Recommendation: a group inside the Social (posting) app on the rail, not a rail item of its own.** The same person reads the calendar and the ad numbers, the two share the platform connections (section 5.1), and a fourth or fifth rail item for a module with one or two screens crowds a small business's shell. Each group is shown **only when its module is enabled**: with `ads` out of `CROVE_MODULES` the Ads group does not appear and Social looks as it does today; with `social` out and `ads` in, the app still shows, with the Ads group alone (the shell keeps an app while any of its groups has an installed item), so no rail item of its own is needed.

How: the shell builds its apps, menus and module guard from each module's entry in `MODULE_SCREENS` (`packages/kernel-contract/src/screens.ts`), so Ads declares its own entry, `ADS_SCREENS`, with its routes, nav labels (Vietnamese and English) and permissions; the module guard already hides a module that is not enabled. A module's `nav` can place its items inside another module's app: a nav item declares `{ app, group, path, label }`, and `apps.ts` drops the groups of modules that are not enabled (checked in [conversations.md](conversations.md) section 3, which also covers Service and the app's name). Only the app id of the Social app is renamed, once, for all three groups. The product name stays "Ludy Ads" for the module; the group's label in the app is a copy decision for the owner and not blocking.

## 3. First slice (recommended): Meta ad account, read only, next to the books

**What a person sees after slice A.** An owner connects a Meta ad account. Ludy fetches the last 13 months of daily spend and results per campaign, and keeps them up to date every hour (today and yesterday) and every day (a trailing 28-day window, because Meta revises recent days). The Ads screen shows: this month's spend, results and cost per result; each campaign's share; and a line "Advertising expense in the books: X, platform spend: Y, difference: Z".

**Why Meta first.**
- Most Vietnamese SME ad spend runs on Meta (Facebook and Instagram), and one Marketing API covers both.
- The same Business login the owner already uses in Social (one login, several assets).
- Its docs are readable and its limits are documented (section 5).
- **No review needed for the owner's own ad accounts.** Standard (now "Limited") access is automatic for Business apps and is enough for the app owner's own accounts [C]. So the owner, a self-hoster and the first pilot can use it before any App Review. Only serving other businesses at scale (Ludy Cloud) needs Advanced ("Full") access, App Review and Business Verification [C].

**Why not Google first.** Google's scope `adwords` is **restricted**: a vendor-held OAuth client for many customers needs OAuth app verification and a CASA security assessment [C]. Developer tokens were sunset on 2026-09-09 and access levels now belong to the Cloud project that owns the OAuth client [C, but its own auth pages still show the old header, so the docs disagree]. Google's policy says each end-advertiser needs its own Cloud project and access, and that open-source tools where users bring their own credentials are not restricted [C]. That fits self-hosters well and Ludy Cloud badly. Google is slice B, bring-your-own project (Q3).

**Alternatives for the first slice** (full list in Q1): Google first; Meta and Google together; spend-only (no results).

## 4. Platforms, in order

Checked 2026-11-01. "Cloud" means Ludy Cloud with DOS-owned platform apps; "self-host" means an operator's own apps (ADR-0025 point 7).

| Order | Platform | API | Read-only access | Verdict |
|---|---|---|---|---|
| 1 | **Meta** (Facebook and Instagram ads) | Marketing API, Insights edge `/{ad-account-id}/insights`; `level` account, campaign, adset, ad; `time_range`, `time_increment` [C]. Graph API v26.0 (2026-07-29) is current; the code default is v24.0, so the build issue pins and tests one version [C] | `ads_read`: reports for accounts you own or were granted [C] | Slice A |
| 2 | **Google Ads** (Search, Display, YouTube, Performance Max) | Google Ads API, GAQL, REST and gRPC; v26.1 current [C] | Scope `https://www.googleapis.com/auth/adwords` (restricted) [C]; access level per Cloud project: Test, Explorer (2,880 operations a day), Basic (15,000, brand verification), Standard (unlimited, manual audit and RMF) [C] | Slice B, self-host bring-your-own first |
| 3 | **TikTok Ads** | Marketing API reporting, `GET /open_api/v1.3/report/integrated/get/` [C]; the docs portal is JavaScript-only, so metrics, token life, review and limits are all [U] | Reporting scope (first-level permission) [U] | Slice C, after a human reads the portal |
| 4 | **Zalo Ads** (Adtima) | No public reporting API found. `ads.zalo.me` shows no API or export page [C that it was read]; the developer pages are JavaScript-only [U]. Zalo OA API and ZNS are different products and give no ad spend [C] | none | CSV import or manual entry (slice E); the owner asks Adtima support whether an API exists (Q6) |
| later | Microsoft Advertising (SOAP, async reports, developer token) [C]; LinkedIn Marketing API (`r_ads_reporting`, approval not confirmed [U]) | | | After the first three, B2B only |
| not planned | X Ads (application form, 7-day sync stats, 250 requests per 15 minutes [C]), Pinterest (low use in Vietnam, tiers [U]), Cốc Cốc (no public API found [U]) | | | Revisit on request |

YouTube ads are inside Google Ads, with no separate API [U, not checked on an official page].

### What each platform needs, and who does it

All of this is an `owner-action`: no agent creates a developer app, signs in or submits a review (AGENTS.md).

**Meta** (slice A):
1. A Meta app for ads, with the Marketing API use case (the owner reports on 2026-11-01 that an app made for Pages may not offer other APIs, #2212). The Marketing API has three use cases: capture and manage ad leads, create and manage ads, measure ad performance. **All three carry `ads_management`, `ads_read`, `business_management`, `pages_read_engagement`, `pages_show_list` and `public_profile` and none can be removed** [C]. So even "measure ad performance" asks for write permission (section 8, risk R1). Whether `ads_read` alone can be requested through another app type is [U].
2. Whether one app can carry both Pages publishing and the Marketing API is not stated [U]. The plan assumes a **separate ads app** (`CHANNEL_META_ADS_APP_ID` and `CHANNEL_META_ADS_APP_SECRET`), the same shape as the Instagram app of #2212. A use case cannot be removed after the app is created [C], so the safe default is a new app.
3. A Meta business portfolio (needed when the app reaches data the app owner does not own; it must be verified before running ads) [C].
4. **Self-host and the owner's own accounts:** app in development mode, the owner and testers with a role on the app, no review. Whether Live mode for a non-Consumer app keeps this is [U].
5. **Ludy Cloud, other businesses:** Business Verification of the DOS portfolio, App Review of `ads_read` (and the forced `ads_management`, `business_management`) with a screencast and a privacy policy, a **data deletion callback** (HTTPS URL or instructions page) [C]. Keeping Advanced access later needs at least 500 API calls in 15 days with an error rate under 15% [C], which the hourly sync meets for any real customer.

**Google** (slice B):
1. A Google Cloud project, the Google Ads API enabled, an OAuth client, the consent screen set to External and In production with brand verification, then an access-level application (Basic) from the Cloud Console [C]. No manager account is needed unless several accounts are linked [C].
2. In testing mode, refresh tokens expire after 7 days and there are 100 test users [C]: unusable for a real owner, so even the owner's own account needs the production consent screen.
3. A vendor-held client for many customers needs CASA [C] and, for reporting tools, Standard access and the Required Minimum Functionality rules [C]. Not planned for Cloud in v1 (Q3).
4. Whether one OAuth client can serve Calendar, YouTube, Business Profile and Ads together is [U]. The plan uses a separate client (`CHANNEL_GOOGLE_ADS_CLIENT_ID` and `CHANNEL_GOOGLE_ADS_CLIENT_SECRET`): a restricted scope on a client changes the verification of everything on it.

**TikTok** (slice C): a TikTok for Business developer app, approved for the Reporting scope [U], separate from the content-posting app of Social on `developers.tiktok.com` (whether it must be a separate app is [U]). Token lifetime is unclear: sources conflict (no expiry or 24 hours) [U], so the build issue verifies it against a real token.

**Zalo** (slice E): ask Adtima (its support contact is on its website [C]) whether a reporting API exists for advertisers.

## 5. How data comes in

### 5.1 Adapters and the channel layer

- **A sibling package** `@crove/ad-platform`, built like `@crove/channel` and `@crove/bank-feed` ([ADR-0039](../adr/0039-bank-feed-connectors.md)): small capability interfaces, static capability data, a declared FQDN allowlist the adapter's fetch is bound to, and an offline `sandbox` adapter. It **reuses** `@crove/channel`'s OAuth building blocks (`OAuthConnector`, `newOAuthAttempt`, `allowlistedFetch`, `withCallSignal`) instead of copying them; whether they move to a shared file or are imported is a build detail.
- **Capabilities:** `connect` (authorize and exchange, listing the ad accounts the grant covers), `listAccounts` (id, name, currency, time zone, status), `readDaily` (a window of daily rows for one account at account and campaign level, with a cursor if the platform pages). **No write capability exists in the interface.** An adapter for a platform that also offers writes implements none of them, and review refuses a change that calls a write endpoint.
- **Connections and credentials** are the channel layer's, unchanged (ADR-0025): one `crove_kernel.channel_connection` per ad account (provider ids `meta_ads`, `google_ads`, `tiktok_ads`, `sandbox_ads`; unique per `(org_id, provider, external_account_id)`, ids allow no colon), the token sealed in `crove_kernel.credential` with `CREDENTIAL_KEY`, opened only by the worker, refused once the connecting member leaves. Connect and disconnect are `kernel.channel.connect` and `kernel.channel.disconnect` (R2, owner or admin). If the provider column has a CHECK or an enum, the build adds a migration for the new ids.
- **Self-host and Cloud:** a provider is enabled only when the deployment has its app credentials in env; without them it is hidden and `docker compose up` needs no platform account. The `sandbox` ad platform is on by default in development, as Social's.

### 5.2 Sync

- A worker job `ads.sync` per ad account, on a queue per provider that declares the platform's hosts (job egress invariant, #1653). The command that feeds it (a link or a manual refresh) declares an external effect, R2 at least, as the invariant requires.
- **Windows.** First link: backfill 13 months (Q4). Then: today and yesterday every hour, and a trailing 28-day window every day. Meta's Insights refresh every 15 minutes and stop changing after 28 days [C]; Google's cost has a one-hour target and can be revised for days, conversions for longer (about 3 hours for last-click, 15 hours for others) [C]. A day is **settled** once it is past the platform's revision window; a settled day is not read again.
- **Meta reads** use synchronous `GET` with `time_increment=1`, paged, one account at a time. An async report run is a `POST` that creates a job on Meta's side: allowed only for large windows (the 13-month backfill), listed explicitly, and the adapter's test pins the one `POST`.
- **Writes** into `crove_ads` happen on the command's transaction through `Runtime.execute()` (`ads.sync.record`, system, worker only): one write path (AGENTS.md rules). A sync run and its rows commit together, so a crash leaves the cursor where it was.

### 5.3 Rate limits and errors

- **Meta** [C]: the Development (Limited) tier has a score cap of 60 with a 300 s decay and block; Full has 9,000, a 60 s block. A read scores 1. Errors 17 and 613 mean the account score cap; 80000, 80003, 80004 and 80014 are the per-ad-account hourly limits (category `ads_insights`); error 4 with subcodes 1504022 or 1504039 is the app-level Insights throttle. Headers `X-Ad-Account-Usage`, `X-Business-Use-Case` and `x-fb-ads-insights-throttle` report usage. Insights with `date_preset=maximum` reach back 37 months at most (error 3018 beyond), and hourly breakdowns 13 months [C]. Since 2025-06-10 a breakdown query older than 13 months omits `reach` [C]; v1 uses no breakdown.
- **Google** [C]: `RESOURCE_EXHAUSTED` over the daily operations of the access level (`Search` and `SearchStream` count 1 each); `RESOURCE_TEMPORARILY_EXHAUSTED` over QPS per customer and per project; back off exponentially with jitter. The numbers for QPS and `RATE_EXCEEDED` are [U]. Response size over 64 MB fails [C].
- **Mapping:** errors map to the channel layer's typed errors (`token_expired`, `permission`, `bad_request`, `rate_limited` with a retry time, `transient`, `unknown`), with Vietnamese and English text. A `rate_limited` result delays the account's next run to the retry time; the app never retries in a loop. Budget: at most one hourly run per account, and the total per app stays under the tier's score (the Development tier's 60 allows only a handful of accounts: documented for self-hosters).
- **Token end of life.** Meta user tokens are long-lived (about 60 days), exchanged server-side, with no refresh: a new login is needed [C]. The existing refresh sweep marks the connection `expired` and alerts the owner (as for LinkedIn); the sync pauses, nothing is lost. A system-user token does not expire [C] but belongs to assets of the app owner's own business; pasting one is not v1. Google keeps a refresh token; an expired or revoked one is recorded, not retried [C]; the passkey requirement when generating one [C] is told to the owner on connect.

## 6. Where the money lands in Kế toán

**Ads never posts.** It is a reading module. The ledger's one write path, proposals and four-eyes are unchanged. There are four places the same money appears, and Ads only reads or points:

| Where | Today | What Ads does |
|---|---|---|
| **The platform's figure** (spend per day, in the account's currency) | nowhere in Ludy | stores it (section 7) |
| **The card or bank line** the platform charged | bank import and feeds, categorized by rules (the l10n rule maps text like "ads", "facebook", "google" to 6421) | shows the platform's charges next to the lines in v2 (slice D); v1 compares only totals |
| **The invoice or receipt** | the normal intake: upload, email, e-invoice portal sync | in slice D, says which month has no document; never creates one |
| **The expense in the books** | a voucher the accountant approves | v1 shows the ledger's total for the advertising expense account next to the platform's spend, per month |

**Expense account.** Advertising is a selling expense, but the account differs by regime:
- Circular 133 books (the chart Ludy ships as TT133 2026.1): the combined account 642, **6421** for selling [S]; the existing categorization rule already uses 6421.
- Circular 99/2025 books (TT99, in force from 2026-01-01 and optional for small enterprises): **641** "Chi phí bán hàng", where bought-in services are **6417** [S, chart appendix not read].
- So the account is **a setting per ad account** (`expense_account_code`, default from the legal entity's books regime, checked against that chart), not a constant. Which one is right per customer is the accountant's call (#61).

**Prepaid wallets.** Many SMEs top up a prepaid balance and the platform spends it later. Practice (an advance, then expensed as spent) was not confirmed [U]. v1 does not model it: it compares monthly platform spend with ledger expense, and shows the difference without explaining it.

**Currency.** Each ad account has a currency (`account_currency` on Meta [C]). Figures are stored and shown **in that currency, labeled**. Ads does no conversion. The books convert at the transaction-date rate or a bank rate and book exchange differences to 515 and 635 [S]; Ludy's finance domain owns that (`foreign-currency.ts`). The comparison strip therefore compares directly only for a VND account. For a USD account it shows USD spend and the ledger's VND total with a note that the rate and any card fee make them differ. A VND card paying a USD charge: handling is [U].

**VAT and foreign contractor tax (FCT).** The rules moved a lot in 2025 and 2026, and every statement found came from secondary sources or a vendor page, so **none is a rule in Ludy** and v1 shows no VAT or FCT figure (Q5). What the research found, for the accountant to confirm:

| Supplier | Finding | Source |
|---|---|---|
| Google | Google Vietnam Company Limited invoices Vietnamese-billed VND accounts as reseller from 2025-04-01 (new accounts from 2025-03-01); VAT 10%, 8% until 2026-12-31; a Vietnam tax code is needed for a valid tax invoice | Google Ads help [C] |
| TikTok | TikTok Pte. Ltd. is registered in Vietnam and reports and pays FCT (VAT and CIT) for Vietnam-billed accounts; VAT 10% from 2025-07-01; a tax code entered in Ads Manager shows on the invoice; whether it is a VAT invoice or a receipt is not stated | TikTok Ads help [C] |
| Meta | Contracts with Meta Platforms Ireland Limited outside the US and Canada [C]. Whether a Vietnamese entity or a local "sold by" entity invoices Vietnam is [U]. Blogs say Meta changed how it checks buyers' tax codes in autumn 2026 and that a VAT-deduction-method buyer may have to withhold FCT-VAT and FCT-CIT when Meta does not charge VAT; the start date differs between pages (23 Sep, 26 Sep, 12 Oct 2026) | [S], needs the accountant |
| Deduction | VAT deduction and the CIT expense need non-cash payment from 5 million VND per invoice under 2025 decrees (the older 20 million threshold is superseded) | [S] |
| Agency in Vietnam | A Vietnamese agency issues a domestic e-invoice and the buyer files no FCT | [S] |
| Household businesses | Lump-sum tax abolished from 2026-01-01, with new declaration rules; ad spend and FCT for households not confirmed | [S] / [U] |

Ludy's job in v1 is to hold the facts the accountant needs (supplier, currency, month, amount) and the documents (through the normal intake). The tax treatment waits for the accountant (Q5).

## 7. Architecture and data model

### 7.1 Packages

| Path | Contents |
|---|---|
| `modules/ads` (`@crove/mod-ads`) | `dependsOn: ['kernel']` only. Domain (pure TS: day windows in the account's time zone, settled-day rule, cost per result with decimal strings), commands, queries, the sync job. No network in the module: only the job calls adapters |
| `packages/ad-platform` (`@crove/ad-platform`) | the capability interfaces, adapters (`sandbox`, `meta`, later `google`, `tiktok`), each with its host allowlist |
| `crove_kernel` (migration, if needed) | the new provider ids |
| `apps/app` | `/ads` screens; the books strip is composed here from an Ads query and a Finance query (below) |

**No cross-module reads.** `crove_ads` has no foreign key to `crove_finance` and no query reads Finance tables (tenant conventions, `control-plane-reads.test.ts`). The books strip is **two queries composed by the app**: `ads.spend.summary` and a Finance query for period totals per account (the build issue names the one that exists, or adds one in the same PR if none does).

### 7.2 Tables (`crove_ads`)

Every table has `org_id`, `PRIMARY KEY (org_id, id)` and RLS via `crove_kernel.apply_tenant_rls`; foreign keys are composite, led by `org_id` and backed by an index, and only point into `crove_ads` or `crove_kernel`; money columns are `numeric`; times are `timestamptz`; days are `date` in the account's own time zone. Every table is per legal entity like Finance (restrictive legal-entity scope), so a member limited to one entity reads only that entity's accounts.

| Table | Key columns |
|---|---|
| `ad_account` | `channel_connection_id` -> `crove_kernel.channel_connection` (unique), `provider`, `external_account_id`, `name`, `currency` (ISO 4217), `time_zone` (IANA, the platform's day boundary), `legal_entity_id`, `expense_account_code`, `result_kind` (which action type counts as a "result", chosen by the owner, section 7.3), `status` (`active`, `paused`, `error`), `backfill_from`, `synced_through`, `last_run_at`, `last_error_kind`, `next_run_at` |
| `ad_spend_day` | `ad_account_id`, `level` (`account`, `campaign`), `external_object_id`, `object_name`, `day`, `currency`, `spend numeric`, `impressions bigint`, `clicks bigint`, `reach bigint` (null when not given; **not additive**, never summed across days), `results jsonb` (action type -> count, only the types in the capability list), `fetched_at`, `settled_at`. Unique per `(org_id, ad_account_id, level, external_object_id, day)`; a restated day is updated in place (the latest figure is the one shown) |
| `ad_sync_run` | `ad_account_id`, `window_from`, `window_to`, `status`, `rows_written`, `error_kind`, `error_code`, `retry_at`, `started_at`, `finished_at`. Append-only; pruned after 90 days |

Slice D adds `ad_invoice` (platform invoice id, month, amount, currency, a link to a stored file). Nothing else is planned for v1.

### 7.3 Results and cost per result

Platforms define "result" by campaign objective, and their own cost-per-result figure is not confirmed as an API field [U]. So Ludy does its own: the owner picks, per ad account, which action type counts as a result (for example `purchase`, `lead`, or a messaging conversation started), the action counts come from the platform's `actions` [C], and **cost per result = spend / results**, computed in decimal on read, never stored and never a JS number. A day with no result shows no cost per result, not zero.

### 7.4 Commands and queries

| Command | Risk | Who |
|---|---|---|
| `kernel.channel.connect`, `kernel.channel.disconnect` | R2 | owner, admin (existing) |
| `ads.account.configure` (legal entity, result kind, expense account) | R1 | owner, admin |
| `ads.sync.request` (manual refresh, rate limited per account) | R1, external effect declared | owner, admin, finance and marketing members |
| `ads.account.delete_history` | R2 | owner, admin |
| `ads.sync.record` | system | the sync job only |

Queries: `ads.account.list`, `ads.spend.summary` (range, by month, by campaign, with cost per result), `ads.sync.status`. The roles in `roles.ts` grant nothing for ads yet; v1 reads follow the existing member and viewer rule plus the entity scope, and a dedicated role waits for a need.

### 7.5 Tenancy and agents

- Every row is under RLS and the legal-entity scope; the invariant suite gets matrix rows for the three tables, a redaction test (no token in rows, logs, audit, events or API output) and the entity-stamping rule of activity rows if Ads writes any.
- Agent contexts write no `crove_ads` table: the allowlist of ADR-0029 stays as it is, and the test that enumerates tables from the catalog refuses them.
- Module enablement (ADR-0031): with `ads` out of `CROVE_MODULES`, the kernel, Finance and Social run unchanged.

### 7.6 Egress

Each adapter's fetch is bound to its hosts and follows no redirect (`allowlistedFetch`): `graph.facebook.com` for Meta; `googleads.googleapis.com` and `oauth2.googleapis.com` for Google; `business-api.tiktok.com` for TikTok. The `ads.sync` queue declares them; the commands that feed it declare an external effect. No network from `modules/ads` or `packages/kernel`.

## 8. Credentials and risks specific to Ads

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Meta's token carries write permission** even for "measure ad performance" (`ads_management` cannot be removed) [C]: a leaked token could edit campaigns or spend money | Sealed (ADR-0025), opened only by the worker, never in logs or output; the adapter has read methods only and a test pins that its source calls no write endpoint except the one listed async `POST`; the owner is told on connect which permission the platform forced; disconnect drops the credential at once |
| R2 | Token expiry (Meta about 60 days, no refresh) | The refresh sweep alerts; the screen says what is stale and since when |
| R3 | The platform revises recent days | Settled-day rule and a 28-day trailing window; the screen marks unsettled days |
| R4 | Platform rules or versions change (Graph versions last about 2 years 4 months with a new one every 4 to 5 months [C, derived from the changelog]; a Google version is disabled on its sunset date and all calls fail [C]) | One pinned version per adapter, a version check in the live-check runbook, recorded-answer tests |
| R5 | Review or approval blocks Ludy Cloud (Meta App Review and Business Verification, Google CASA) | Slice A works on the owner's own accounts and self-host with no review; Cloud reviews start only after the owner agrees (Q2, Q3) |
| R6 | Wrong or misleading comparison with the books | The strip only compares like with like (VND), labels everything else, and never edits the books |
| R7 | Platform terms: Meta counts aggregated spend as Platform Data and requires deleting it when no longer needed, when the product stops, or when Meta asks, plus a data deletion callback [C] | Section 9 |
| R8 | Meta app type or use-case confusion (#2212) | A separate ads app by default; written down in the live-check runbook |

## 9. Personal data

- **v1 stores none.** What is stored: account ids and names, campaign ids and names, and daily aggregate numbers. Ad audiences, custom audiences, lookalikes, lead forms, pixel and conversion events are personal data of third parties and are out of v1 (section 2). No Ludy table holds a person's identifier from an ad platform.
- Campaign and ad names are text the owner typed, and may in rare cases contain a person's name. They are classed as ordinary business text in the module manifest (the data classes of #1599); if a customer finds one, the normal erasure path applies.
- **No breakdowns** (age, gender, region) in v1. They are aggregates [U: no platform page states that no person-level rows are returned; the documented shape is aggregates only], but small cells can single people out.
- **Platform terms.** Meta treats spend and other aggregates as Platform Data, excepted from deletion on a user's request only when it cannot be linked to a user, browser or device [C]. Ludy therefore: (1) provides the **data deletion callback** the Meta app needs, which deletes the account's rows through a definer (the org-purge pattern); (2) offers `ads.account.delete_history`; (3) on disconnect keeps the stored figures by default as the org's own accounting record, with a clear choice to delete (Q4). Whether keeping aggregates after disconnect fits Meta's rule for Ludy Cloud is [U] and a legal read before Cloud launch.
- **Google's rules**: a third-party tool needs the client's written consent before transferring account data, must disassociate a client within 3 business days of notice, and loses access after 90 days unused [C]. A retention limit for stored data is [U].
- The privacy page ([docs/legal/privacy.md](../legal/privacy.md)) lists Ads data as a new data category when Ads ships (a docs change in slice A, not here).

## 10. Switched on at two levels

- **The deployment** enables a provider by its app credentials in env (`CHANNEL_META_ADS_APP_ID` and `_APP_SECRET`, `CHANNEL_GOOGLE_ADS_CLIENT_ID` and `_CLIENT_SECRET`, `CHANNEL_TIKTOK_ADS_APP_ID` and `_APP_SECRET`; names fixed in the build issues). Without them the provider is hidden; with `ads` out of `CROVE_MODULES` the module is absent.
- **The org**: an owner or admin connects accounts and maps each to a legal entity.
- `docker compose up` needs no ad platform. The `sandbox` ad platform makes the whole flow work offline.

## 11. Slices (one PR each, end to end), after the owner approves

| Slice | What a user sees | Notes |
|---|---|---|
| **A1** | `docker compose up`, connect the `sandbox` ad platform, see daily spend and results per campaign, month totals, cost per result and the books strip | module, migration, adapter interface, sandbox, screens. Protected paths: the migration, the manifest, the job queue list, `rls-matrix` rows; independent security review |
| **A2** | Connect a real Meta ad account and see real numbers | Meta adapter, OAuth connect through the channel layer, 13-month backfill, hourly and daily sync, errors and limits, recorded-answer tests, an `ads-live-check` runbook like [social-live-check.md](../runbooks/social-live-check.md) (the live run is the PO's with the owner) |
| **A3** | A stale or expired token pauses the account and says so; the owner is alerted; reconnecting resumes | refresh sweep integration, notifications, `delete_history`, the deletion callback |
| **B** | Google Ads, self-host bring-your-own project | adapter, the Cloud-project and consent-screen runbook, access-level notes |
| **C** | TikTok Ads | after a human reads the portal (section 4) |
| **D** | Which month has no invoice or receipt; platform charges beside card lines | `ad_invoice`, Google `ListInvoices` (needs monthly invoicing on the account) [C]; Meta has no invoice edge [C], so Meta documents come through normal intake |
| **E** | Zalo Ads by CSV or manual entry | only if Adtima confirms there is no API (Q6) |

**Exit criteria for v1 (A1 to A3):**
1. On a fresh laptop with `docker compose up`: connect the sandbox ad platform, see spend and cost per result, and the books strip with its difference; Playwright covers it.
2. A restated day is updated in place, and a settled day is not read again.
3. A rate-limited or expired account pauses and recovers with no lost day (the cursor moves only with the rows).
4. Cross-org and cross-entity RLS tests cover every new table; tokens never appear in logs, audit rows, events or API output.
5. The adapter source calls no write endpoint (test), and `ads.sync` declares its hosts (job egress invariant).
6. With `CROVE_MODULES` excluding `ads`, the kernel, Finance and Social run unchanged.

## 12. Questions for JOY

Nothing is built until the first slice is approved. Each question: what is decided, why it matters, the options, my recommendation, and what happens without an answer. One at a time, the first one first.

**Q1. What is the first slice?** (Who acts: JOY.) It decides which platform's review and setup you do first and what the first build issues are.
- **A. Meta ad account, read only, next to the books (recommended).** Works on your own account without any review, covers Facebook and Instagram ads, readable docs.
- B. Google Ads first. Needs a Google Cloud project, production consent screen and brand verification before a real number shows (a restricted scope), and each self-hoster brings their own project.
- C. Meta and Google together. Doubles the setup before anything is seen.
- D. Spend only, no results or cost per result. Smaller, but the "what did I get" question stays open.

Without an answer: no build issue is opened (acceptance of #2214).

**Q2. Start Meta Business Verification and App Review for Ludy Cloud now?** (Who acts: JOY, an `owner-action`.) It decides when other businesses can connect on Ludy Cloud rather than only you and self-hosters.
- **A. Not yet: do it after slice A2 works on your own account (recommended).** The review is easier with a working screen and a screencast, and Meta's rules may change before then.
- B. Start now. Reviews are slow and can be rejected; nothing to show yet.

Without an answer: Cloud customers cannot connect Meta ads; self-hosters and you can.

**Q3. Google Ads on Ludy Cloud: bring-your-own or DOS-held?** (Who acts: JOY.) It decides how heavy Google is.
- **A. Self-host bring-your-own project only in v1 (recommended).** Matches Google's policy for open-source tools; no CASA assessment for DOS.
- B. A DOS-held Cloud project for all Cloud customers. Needs CASA, Standard access and Required Minimum Functionality, and Google's policy says each advertiser needs their own project, so it is the riskier model.

Without an answer: slice B is built bring-your-own only.

**Q4. How much history, and what happens to it on disconnect?** (Who acts: JOY.) It decides storage, privacy wording and what Meta's rules allow.
- **A. 13 months of history, kept after disconnect with a clear "delete" choice (recommended).** The numbers are the org's own accounting record; the owner can erase them.
- B. 13 months, deleted on disconnect. Safest for platform terms, but the books comparison loses its past.
- C. 3 months only. Smaller, but a month-end comparison for last quarter is missing.

Without an answer: A, and a legal read of Meta's terms before Ludy Cloud launches.

**Q5. Tax (VAT and foreign contractor tax) on ad invoices: when?** (Who acts: the accountant, #61, through JOY.) It decides whether Ludy ever shows tax hints on ad spend.
- **A. v1 shows none; the accountant confirms the rules first (recommended).** 2025 and 2026 changes are confirmed only by secondary sources, and the platforms differ.
- B. Show hints from the findings in section 6. Risk of a wrong tax hint in front of an owner.

Without an answer: A.

**Q6. Zalo Ads: ask Adtima whether a reporting API exists?** (Who acts: JOY.) It decides whether Zalo Ads is an adapter or a CSV import.
- **A. Ask Adtima through its support contact on its website (recommended).** One message settles it.
- B. Plan CSV import now, without asking.

Without an answer: slice E waits; Zalo Ads is not covered.
