<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Runbook: live check of a Google Ads account (Ads, slice B)

Until now the Google Ads read adapter (`packages/ad-platform/src/google.ts`) ran only against recorded answers. This runbook takes a person with no coding background from nothing to the figures of one real Google Ads account on Ludy's Ads screen, read only, and says what to compare and what to record. It follows [ads-live-check.md](ads-live-check.md), [docs/plan/ads.md](../plan/ads.md) sections 4, 5, 8 and 11 (slice B), and [ADR-0040](../adr/0040-ads-read-only-sources.md).

Public repository rule: no secret, client id, customer id, token or internal host appears in this file, in an issue, in a PR or in chat. Every value is named by where it comes from.

## Who does what

Every step carries a tag.

- **[PERSON]** only the owner (JOY) or the self-host operator can do it: it needs their Google Cloud Console or Google Ads login, or it changes their Google Cloud project. Nobody else does it for them, and no agent signs in.
- **[PO]** the Product Owner session runs it, after JOY approved the concrete step list in the PO's chat (AGENTS.md, "Production, secret and credential steps"). This runbook is not that approval.
- **[CHECK]** what must be true before going on, and what to do if it is not.

The client secret goes from the Google Cloud Console OAuth client page into the `.env` file of the stack, typed or pasted by the person at the keyboard. The agent never prints, reads back or sends it.

## Where the check runs

**Default: a throwaway stack from `docker compose up` on the machine of whoever runs the check, at `http://localhost:8080`, with its own database and no customer data.** The sandbox ad platform stays on in that stack (`ADS_SANDBOX` is on under compose for a local address), next to Google Ads, so the screen can be compared.

**Alternative, pending the owner's decision: the deployment's own `PUBLIC_URL`** (for example the pilot instance on its public address). Read "the deployment's `PUBLIC_URL`" wherever the steps below say `http://localhost:8080`. It needs more:

- `PUBLIC_URL` is https, and the Google OAuth web client lists `<APP_URL>/channels/oauth/google_ads/callback` as an Authorized redirect URI.
- The module list includes `ads` (`CROVE_MODULES`).
- `ADS_SANDBOX=false`: the server refuses `ADS_SANDBOX=true` on a public address when the Ads module runs.
- A credential key is set (`CREDENTIAL_KEY`), as for any connected channel.

## What is verified in code before you start

- The adapter makes requests to `googleads.googleapis.com` and `oauth2.googleapis.com` only, using API version `v26` (`customers:listAccessibleCustomers` and `googleAds:searchStream`), and a test pins that its source names no write endpoint and sends no `developer-token` header (sunset by Google in September 2026).
- The refresh token is sealed with `CREDENTIAL_KEY`, opened by the worker alone to mint short-lived access tokens in memory, and appears in no log, audit row, event or answer (database test).
- A Google Cloud consent screen left in Testing mode returns `refresh_token_expires_in` (7 days): Ludy stores that expiry on the connection (`connectionExpiresAt`) and warns on the Ads screen before the token lapses.

## Before you start

- **[PERSON]** The Google account that will connect has **2-Step Verification or a passkey** enabled (Google requires it on Google Ads accounts) and has **direct access** to the target Google Ads account (not only through a Manager / MCC account: accounts reachable only through a manager account require `login-customer-id` and are refused with `OAUTH_GOOGLE_MANAGER_ONLY`).
- **[CHECK]** Docker Desktop runs, and `docker compose up --build` works on this machine (README, "Run it").

## Steps

### 1. Create or configure the Google Cloud project and Ads API access **[PERSON]**

Each deployment brings its own Google Cloud project (owner decision Q3 on `#2214`; DOS holds no shared project):

1. Open Google Cloud Console (`console.cloud.google.com`), create or select your project, and enable the **Google Ads API** (`APIs & Services` -> `Library` -> `Google Ads API` -> `Enable`).
2. In the Google Ads API quotas / access page of that project, check the project's access level:
   - **Test access** reaches only Google Ads test accounts (a production account fails with `CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION`, which Ludy surfaces as `OAUTH_GOOGLE_PROJECT_TEST_ONLY`).
   - Apply for **Explorer access** (2,880 operations per day on production accounts, automated review, no brand verification required) before connecting a real production Google Ads account.
3. Configure the **OAuth consent screen** (`APIs & Services` -> `Google Auth platform` / `OAuth consent screen`):
   - Add the scope `https://www.googleapis.com/auth/adwords`. Because Google classes `adwords` as a restricted scope, an unverified project used for your own account shows Google's "Google hasn't verified this app" screen during sign-in (continue via **Advanced** -> **Go to ... (unsafe)** for your own project).
   - **Publishing status**: while the consent screen is in **Testing** mode, add your Google account under Test users, and note that Google expires refresh tokens after **7 days** (Ludy shows a warning banner with the expiry date on the account card). For a connection that does not expire every 7 days, set the publishing status to **In production** (for your own personal/internal use you do not need to submit for brand verification if you continue through the unverified-app prompt on your own account).
4. Create an **OAuth 2.0 Web application client** (`Clients` / `Credentials` -> `Create credentials` -> `OAuth client ID` -> `Web application`):
   - Under **Authorized redirect URIs**, add `http://localhost:8080/channels/oauth/google_ads/callback` (or `<APP_URL>/channels/oauth/google_ads/callback` on a public deployment).

### 2. Give the server the OAuth client **[PERSON]**

From the OAuth client page copy the Client ID (`<digits>-<alphanumeric>.apps.googleusercontent.com`) and the Client Secret, and put them in the `.env` of the stack:

```
CHANNEL_GOOGLE_ADS_CLIENT_ID=<the Client ID>
CHANNEL_GOOGLE_ADS_CLIENT_SECRET=<the Secret>
```

Both or neither: the server refuses to start with only one of the pair, or with a Client ID that does not match `<digits>-<id>.apps.googleusercontent.com`. When neither is set, Google Ads is hidden on the Ads screen.

### 3. Start the stack **[PO]**

`docker compose up --build`, then wait for the app at the address. **[CHECK]** `GET <address>/api/config` lists `google_ads` under `channels.oauth`; if it does not, the pair is not set or the container was not restarted.

### 4. Connect the Google Ads account **[PERSON]**

Sign in to Ludy, open Quảng cáo (Ads) in the Social app. As owner or admin the screen offers "Kết nối tài khoản Google Ads" (`Connect a Google Ads account`), stating that Google's single `https://www.googleapis.com/auth/adwords` scope grants read and write on Google's side while Ludy calls only the read endpoints (`customers:listAccessibleCustomers` and `googleAds:searchStream`).

Complete Google's sign-in and consent dialog. **[CHECK]** back in Ludy, each enabled non-manager Google Ads account you can reach directly is listed on the Ads screen with its currency and time zone, its card states that Ludy uses the connection read-only, and (if the consent screen was in Testing mode) the 7-day refresh-token expiry warning is shown.

### 5. Compare the figures and the 7-day comparison note **[PERSON]** with **[PO]**

1. Wait for the first sync to finish (13 months, 30-day revision window). In Google Ads, for the same account, the same days and the account's own currency, compare:
   - the spend of one finished month (`cost_micros` converted exactly to decimal currency units);
   - the spend of the last 7 completed days;
   - the conversions (`conversion` result kind) and cost per result after selecting **Chuyển đổi (Conversions)** in the account's settings;
   - the campaign list and campaign spend.
2. With both a Meta Ads account (or sandbox account) and the Google Ads account synced through yesterday in the same currency, check **Ghi chú so sánh 7 ngày của Uy** (`Uy's 7-day comparison`) on the Ads screen:
   - **[CHECK]** it shows the last 7 completed days vs the 7 days before side by side per platform (spend change and cost-per-result change) and names the campaign whose spend moved the most across the connected platforms.

### 6. Disconnect and delete history **[PERSON]**

1. In the account's settings choose "Ngắt kết nối" (`Disconnect`): the stored figures stay readable and the sync stops.
2. Choose "Xóa lịch sử đã lưu" (`Delete stored history`) and confirm: the stored figures, sync runs, and disconnected account row are removed, and the accounting books are untouched.

## Results to record

Record in the issue (`#2220`) without any id, name or amount of a real account:

| Check | Expected | Observed |
|---|---|---|
| Cloud project access level | Explorer (or Test against a Google Ads test account) | |
| Consent screen publishing status | Testing (7-day warning shown) or In production (no expiry warning) | |
| Connected account currency and time zone | Matches Google Ads account settings | |
| Finished month spend: Ludy vs Google Ads | Exact match in account currency | |
| Conversions and cost per result | Matches Google Ads `metrics.conversions` and `spend / conversions` | |
| Uy's 7-day comparison note | Side-by-side platform breakdown and top-moving campaign shown | |
| Disconnect and delete history | Figures and closed account removed, books untouched | |
