<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Runbook: live check of a Meta ad account (Ads)

Until now the Meta ad adapter (`packages/ad-platform/src/meta.ts`) ran only against recorded answers. This runbook takes a person with no coding background from nothing to the figures of one real Meta ad account on Ludy's Ads screen, read only, and says what to compare and what to record. It follows [social-live-check.md](social-live-check.md) and [docs/plan/ads.md](../plan/ads.md) sections 4, 5 and 8, and [ADR-0040](../adr/0040-ads-read-only-sources.md).

Public repository rule: no secret, app id, ad account id, token or internal host appears in this file, in an issue, in a PR or in chat. Every value is named by where it comes from.

## Who does what

Every step carries a tag.

- **[PERSON]** only the owner (JOY) can do it: it needs their Facebook, Meta Business or Ads Manager login, or it changes their Meta app. Nobody else does it for them, and no agent signs in.
- **[PO]** the Social Product Owner session runs it, after JOY approved the concrete step list in the PO's chat (AGENTS.md, "Production, secret and credential steps"). This runbook is not that approval.
- **[CHECK]** what must be true before going on, and what to do if it is not.

The app secret goes from the Meta app's settings page into the `.env` file of the stack, typed or pasted by the person at the keyboard. The agent never prints, reads back or sends it.

## Where the check runs

**Default: a throwaway stack from `docker compose up` on the machine of whoever runs the check, at `http://localhost:8080`, with its own database and no customer data.** The sandbox ad platform stays on in that stack (`ADS_SANDBOX` defaults to true under compose), next to the real one, so the screen can be compared.

**Alternative, pending the owner's decision: the deployment's own `PUBLIC_URL`** (for example the pilot instance on its public address). Read "the deployment's `PUBLIC_URL`" wherever the steps below say `http://localhost:8080`. It needs more:

- `PUBLIC_URL` is https, and the Meta app lists `<APP_URL>/channels/oauth/meta_ads/callback` as a valid OAuth redirect URI.
- The module list includes `ads` (`CROVE_MODULES`; the pilot runs `finance` only, so it must be changed first, and Social's routes stay out unless asked for).
- `ADS_SANDBOX=false`: the server refuses `ADS_SANDBOX=true` on a public address when the Ads module runs.
- A credential key is set (`CREDENTIAL_KEY`), as for any connected channel.
- It then reads a real customer-facing instance's books beside real ad spend: nothing here writes to the books or to Meta, but record that decision.

## What is verified in code before you start

- The adapter makes GET requests to `graph.facebook.com` only, with `ads_read` as the one permission asked, and a test pins that its source names no write endpoint.
- The token (a long-lived user token, about 60 days, no refresh) is sealed with `CREDENTIAL_KEY`, opened by the worker alone, and appears in no log, audit row, event or answer (database test).
- A rate limit holds the account back until the time derived from the error code (10 minutes for the score cap codes 17, 32 and 613, an hour for the others), an expired token marks the connection expired, and connecting again resumes the same account with its history and no day lost (database test with recorded answers).

## Before you start

- **[PERSON]** The Meta app: the owner's existing classic app (App type None, products Facebook Login and Marketing API added), managed by the owner's business portfolio. Its Marketing API access tier is **Limited** ("App unapproved for Marketing API Access Tier"): that is enough for the ad accounts the person connecting can see **if** that person has a role on the app and the app is in development mode [C for own accounts, U for this exact app: this check is what proves it].
- **[PERSON]** The Facebook login that will connect has a role on the Meta app (admin, developer or tester) and can see the ad account in Ads Manager.
- **[CHECK]** Docker Desktop runs, and `docker compose up --build` works on this machine (README, "Run it").

## Steps

### 1. Add the redirect address to the Meta app **[PERSON]**

In the Meta app (developers.facebook.com, the app's dashboard): Facebook Login, Settings, "Valid OAuth Redirect URIs": add `http://localhost:8080/channels/oauth/meta_ads/callback` (or the deployment's `<APP_URL>/channels/oauth/meta_ads/callback`). Meta documents Strict Mode (an exact match) and an "Enforce HTTPS" switch; whether `http://localhost` is accepted is [U]: if the dialog refuses it, record the message and use a public https address instead.

In the same app, Settings, Advanced, Security: turn on **"Require App Secret"**. Ludy sends the proof of the app secret (`appsecret_proof`) with every Graph request it makes, so a leaked token alone cannot call the API once this is on; with it off, the proof is sent but not required. **[CHECK]** after turning it on, connecting (step 4) still works; if Meta then refuses, record the error.

The connection also **refuses a token that holds `ads_management` or `business_management`** (a person who granted them to this app before): the screen says so and connects nothing. Pages permissions (`pages_*`, `publish_*`) are accepted, recorded on the connection and shown on the Ads screen as permissions beyond reading reports; a separate Meta app for ads avoids both (step 2).

### 2. Give the server the app **[PERSON]**

From the app's Settings, Basic page take the App ID (digits) and the App Secret ("Show", asks the password). Put them in the `.env` of the stack:

```
CHANNEL_META_ADS_APP_ID=<the App ID>
CHANNEL_META_ADS_APP_SECRET=<the App Secret>
```

The same app may already be set as the Pages app (`CHANNEL_META_APP_ID` and `CHANNEL_META_APP_SECRET`): the same two values go in both places. **Know what that means:** a Meta user token holds every permission the person ever granted that app, not only the one asked for now, so with a shared app the sealed ads token can also hold Pages publishing (`pages_manage_posts`) and, if it was ever granted, `ads_management`. Ludy asks for `ads_read` only and records the full set on the connection; record in the results table which permissions the token held. A separate app avoids it. Both or neither: the server refuses to start with one of the pair, or with an App ID that is not digits.

### 3. Start the stack **[PO]**

`docker compose up --build`, then wait for the app at the address. **[CHECK]** `GET <address>/api/config` lists `meta_ads` under `channels.oauth`; if it does not, the pair is not set or the container was not restarted.

### 4. Connect the ad account **[PERSON]**

Sign in to Ludy, create an org, open Quảng cáo (Ads) in the Social app. As owner or admin the screen offers "Kết nối tài khoản quảng cáo Meta". Meta's dialog asks for one permission, reading ad reports (`ads_read`), and lets the person pick the ad accounts. **[CHECK]** the dialog lists only that permission; if it lists more, record exactly what, since Meta may force more on some app types (plan section 8, R1). Back in Ludy each account picked is listed on the Ads screen, with its currency and time zone, and its first sync starts.

### 5. Compare the figures **[PERSON]** with **[PO]**

The first sync reads 13 months and takes a few minutes ("Làm mới ngay" asks again after a minute). In Meta Ads Manager, for the same ad account, the same days and the account's own currency, compare: the spend of one finished month, the spend of the last 7 days, the results of one campaign, the number of campaigns. Ludy's figures are in the account's currency and time zone; a difference of days at the edges is the time zone. Write each pair in the results table.

### 6. Check the days Meta restates **[PO]**

The newest 28 days are marked "chưa chốt" (not final) and are read again every hour, older days are final. Compare the last day twice, an hour apart: Ludy follows Meta's change, and a final day never changes.

### 7. Check the result and cost per result **[PERSON]**

In the account's settings choose the result action (purchase, lead or message). The summary shows results and cost per result for that action. In Ads Manager read the same action for one campaign and compare. The action types the adapter sums are `omni_purchase`, `lead` and `onsite_conversion.messaging_conversation_started_7d` [U: read from Meta's documentation, not from a live account]; record the action types the account actually reports for its campaigns, from a test request in Graph API Explorer if needed.

### 8. Limits and errors **[PO]**

The Limited tier has a low rate limit [C: score cap, a block of minutes]. Watch the sync history of the account (Ads screen) for a `rate_limited` run and the time it sets for the next try, and record the Meta error code it names. Ludy never retries in a loop: one run an hour at most, and no run before the time the account is held until.

### 9. Expiry and reconnecting **[PERSON]**

In the Facebook account's settings (Apps and Websites), remove the app, or wait for the token to end. At the next sync the connection shows as paused ("hết hạn"), with the reason and the day it stopped; the figures stay, and the owners and admins get a notice in the bell (Notifications) that opens the Ads screen. A member sees that an owner or admin must connect again. Connect again as in step 4 (the screen offers "Kết nối lại với Meta" on the paused account): the same ad account returns with its history and settings, and the sync resumes with no day lost. **[CHECK]** the days between the pause and the reconnect are all there after the next sync, in Ludy and in Ads Manager. Record how long the token lasted if the check ran long enough, against the about 60 days the adapter assumes.

### 10. Disconnect **[PERSON]**

In the account's settings choose "Ngắt kết nối". The stored figures stay readable and the sync stops.

### 11. Delete the stored history **[PERSON]**

In the account's settings choose "Xóa lịch sử đã lưu" and confirm. Every stored figure and the update log of the account go: on a connected account the next sync reads the 13 months again; on a disconnected one the account itself is deleted too, so nothing of it stays. **[CHECK]** the account's figures are gone from the Ads screen, and the books (Kế toán) are unchanged.

### 12. Meta's data deletion callback **[PERSON]** with **[PO]**

In the Meta app's dashboard, Settings, Basic: set "Data Deletion Request URL" to `<PUBLIC_URL>/api/ads/meta/data-deletion` (it must be https and public; Meta also asks for it before App Review). It is the **one** callback of all Meta connections: a request is also fanned out to the conversations of the Pages the person granted when `CHANNEL_META_APP_ID` and `_APP_SECRET` are set ([conversations-data-rights.md](conversations-data-rights.md) section 3). The route exists where `CHANNEL_META_ADS_APP_ID` and `_APP_SECRET` are set with the Ads module on, or `CHANNEL_META_APP_ID` and `_APP_SECRET` are set. With the app's own request tool (App Dashboard, "Test" for the callback, or removing the app from the Facebook account and asking for deletion of its data): **[CHECK]** Meta shows the confirmation code and a status link; the link opens a page that first says the request is being handled and, within a minute or so, that the ad data of the accounts the person granted was deleted; the person's ad accounts are gone from Ludy and their connections are closed. Record only the codes' presence, never the person's id.

What the callback can and cannot do: it finds the accounts by a keyed hash of the Meta user who granted them, stored when the account was connected (since this slice). **An account connected before this slice has no hash**, so a request does not find it until it is connected again; the owner deletes its history by hand (step 11). With a **shared Meta app** (the same app also posts to Pages) the one request erases the ad data and, under the same code, the conversations of the Pages the person granted. Rotating the app secret leaves the stored hashes unmatched, so reconnect the accounts after a rotation.

## Results to record

Record in the issue (#2218) without any id, name or amount of a real account:

| Item | Result |
|---|---|
| Redirect `http://localhost` accepted by Meta (U) | |
| Permissions the dialog asked for | |
| Permissions the token held after connecting (names only; more than ads_read means the app was shared) | |
| Campaigns of an older month add up to the account total (deleted or archived campaigns may be left out of the campaign level, U) | |
| Ad accounts listed by the grant (count only) | |
| Spend of a finished month: Ludy equals Ads Manager | |
| Spend of the last 7 days: equal | |
| Results of one campaign: equal | |
| Action types the account reports (names only) | |
| A day restated, followed by Ludy | |
| A `rate_limited` run: Meta's error code and the next try set | |
| Token lifetime seen | |
| Expired then reconnected: history kept, no day lost; the owners were told in the bell | |
| Stored history deleted: figures gone, books unchanged | |
| Data deletion callback: Meta accepted the URL (U), showed a code and a status page, and the accounts of the test person were erased | |
| Graph version used (`CHANNEL_META_GRAPH_VERSION`) | |
| Anything Meta showed that the plan does not say | |

## When something goes wrong

- **The app will not start:** the pair is incomplete or the App ID is not digits; the log names the variable. On a public address the log can also name `ADS_SANDBOX=true` or a plain http `PUBLIC_URL`.
- **Meta says the redirect URI is not allowed:** the address in step 1 differs from `APP_URL` (else `PUBLIC_URL`) plus `/channels/oauth/meta_ads/callback`, character for character.
- **The connect button is missing:** `/api/config` does not list `meta_ads` (step 3), the Ads module is off, or the person is not an owner or admin.
- **"Không có tài khoản nào" after the dialog:** the person has no ad account on the app's business, or did not tick one; record it.
- **A run fails with `permission` (Meta codes 10, 200 to 299):** the person lost access to the ad account or the app lacks the Marketing API product; the connection stays and the error is shown.
- **A run fails with `token_expired` (190):** connect again (step 9).
- **A run fails with `bad_request` (100):** record the code; the plan's pinned Graph version may be too old or new (`CHANNEL_META_GRAPH_VERSION`).

## Cleanup

`docker compose down -v` removes the throwaway stack and its database (and the sealed token with it). In the Facebook account's settings remove the app's access, and in the Meta app delete the redirect address added for the check, unless it stays in use.
