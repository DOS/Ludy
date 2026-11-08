<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Runbook: live check of launching a Meta campaign (Ads W2-5)

Until now the Meta write, pause, activate and revoke adapters (`packages/ad-platform/src/meta-write.ts` and `meta-activate.ts`) ran only against recorded answers and the offline sandbox. This runbook takes the owner (JOY) and the Ludy Engage Product Owner session through launching, activating and stopping one small approved campaign on the owner's own Meta ad account, within spend caps, and says what to check and what to record on `#2296`. It follows [ads-live-check.md](ads-live-check.md), [docs/plan/ads-write.md](../plan/ads-write.md) sections 3, 4, 5, 6 and 10, and [ADR-0043](../adr/0043-ads-write-running-ads.md).

Public repository rule: no secret, app id, ad account id, token or internal host appears in this file, in an issue, in a PR or in chat. Every value is named by where it comes from.

## Who does what

Every step carries a tag.

- **[PERSON]** only the owner (JOY) can do it: it needs their Facebook, Meta Business or Ads Manager login, their second factor (MFA, P11) for R3 approvals, or it changes their Meta app. Nobody else does it for them, and no agent signs in.
- **[PO]** the Ludy Engage Product Owner session runs it, after JOY approved the concrete step list in the PO's chat (AGENTS.md, "Production, secret and credential steps"). This runbook is not that approval.
- **[CHECK]** what must be true before going on, and what to do if it is not.

## Where the check runs

Run on a throwaway local stack from `docker compose up` on the owner's machine, at `http://localhost:8080`, with its own database and no customer data (the server refuses `ADS_LIVE_LAUNCH=true` on a public `PUBLIC_URL`).

Environment variables required in `.env`:

- `CHANNEL_META_ADS_APP_ID` and `CHANNEL_META_ADS_APP_SECRET` (from the Meta read app's Basic settings)
- `CHANNEL_META_ADS_WRITE_APP_ID` and `CHANNEL_META_ADS_WRITE_APP_SECRET` (from the Meta write app's Basic settings)
- `ADS_LIVE_LAUNCH=true`

## What is verified in code before you start

- Every create call (`campaigns`, `adsets`, `adcreatives`, `ads`) sends `status=PAUSED` and carries the launch's deterministic tag (`[ludy:<10-hex>]`) in its name; `ACTIVE` is sent only by the separate activation adapter (`meta-activate.ts`) after every object of the plan is recorded and the database guard (`crove_ads.launch_guard`) checks the executed `ads.campaign.launch` proposal, the plan hash, the switches, and the flight dates.
- Spend caps are checked at submission (`ads.campaign.prepare_launch`), at approval (`ads.campaign.launch`), before every create step (`ads.launch.begin`), and before every activation step (`ads.activate.begin`) under the org's lock (`lockedSetting`).
- Stopping a started launch (`ads.launch.stop`, `ads.pause_all`, `ads.write.disable`, `ads.account.disable_write`, `ads.account.disconnect`) commits immediately in Ludy with the commitment held to at least today in the account's time zone, and queues `ads-pause` to pause every created object (campaign first, found by tag as well as by `crove_ads.ad_object`). On a switch-off, the pause runs before the sealed token copy is revoked at Meta (`DELETE /me/permissions`).

## Steps

### 1. Start the local stack with `ADS_LIVE_LAUNCH=true` **[PO]**

Start `docker compose up --build` and wait for `http://localhost:8080/api/config`.
- **[CHECK]** `/api/config` lists `meta_ads` and `metawrite_ads` under `channels.oauth`, and the worker starts without configuration errors.
- **Rollback:** set `ADS_LIVE_LAUNCH=false` and restart the worker (`docker compose up -d worker`).

### 2. Connect the ad account for reading and enable running ads **[PERSON]**

1. Sign in as the org owner (with a verified MFA factor, `aal2`), open **Quảng cáo (Ads)**, and connect the Meta ad account for reading ([ads-live-check.md](ads-live-check.md) step 4). Wait for the first sync so the account has its currency and time zone.
2. On the Ads screen, request and approve (in **Chứng từ chờ duyệt / Inbox** with MFA) the three R3 setup proposals in order:
   - Enable running ads for the org (`ads.write.enable`).
   - Enable running ads for the ad account (`ads.account.enable_write`).
   - Set a small daily spend cap and monthly spend cap in the account's currency (`ads.cap.set`) - for example, a daily cap just above Meta's minimum daily budget for the currency.
3. Click **Connect to run ads** (`metawrite_ads`) on the ad account and complete Meta's OAuth dialog (`ads_read`, `ads_management`).
- **[CHECK]** the ad account card shows **Can run ads** (`Có thể chạy quảng cáo`) and the daily and monthly caps in force.

### 3. Draft, validate, and approve one small Traffic campaign **[PERSON]**

1. Open **Chiến dịch (Campaigns)** (`/o/<slug>/ads/campaigns`).
2. Create a draft with:
   - Objective: **Traffic** (`Lượt truy cập`).
   - Daily budget: a small amount within the daily cap (above Meta's minimum daily budget).
   - Start date: **today** in the ad account's time zone (so activation runs right after creation) or **tomorrow** (if you want to inspect the paused objects in Ads Manager before activation).
   - End date: 2 days after start date.
   - Targeting: country `VN`, age `22-45`, gender `All`.
   - Link URL: an `https://` page owned by the business, and one text variant (headline, primary text, call to action `Learn more`).
3. Save the draft.
- **[CHECK]** the builder shows `Nothing to fix` (`Không có gì cần sửa`) and the one-sentence maximum spend (`dailyBudget × days`).
4. Click **Ask for approval** (`Gửi duyệt`), open the proposal in the Inbox, and approve it with MFA.
- **[CHECK]** on the Campaigns screen the draft is marked **Approved** (`Đã duyệt`) and its launch state moves from `Queued` (`Đang chờ chạy`) to `Launching` (`Đang tạo`).

### 4. Verify paused creation and activation on Meta **[PERSON]** with **[PO]**

1. Watch the launch card on the Campaigns screen as the worker runs `ads-launch` and `ads-activate`:
   - Every created object (`Campaign`, `Ad set`, `Creative`, `Ad`) appears under **Created on the ad platform** (`Đã tạo trên nền tảng quảng cáo`) with its name carrying `[ludy:<10-hex>]` and its platform ID.
   - If the start date is in the future, the launch rests in `Created (paused)` (`step = 'paused'`) with every object `PAUSED` in Meta Ads Manager.
   - If today is within the flight dates, `ads-activate` switches on the ad, the ad set, and the campaign last, and the launch state becomes **Live** (`Đang chạy`).
2. **[CHECK]** In Meta Ads Manager, verify:
   - Exactly one campaign, one ad set, one creative, and one ad exist with the `[ludy:<10-hex>]` suffix.
   - The campaign has `OUTCOME_TRAFFIC`, `DAILY_BUDGET` equal to the plan's daily budget (in Meta's minor unit for USD or whole unit for VND), and `spend_cap` equal to the plan's maximum spend (`dailyBudget × days`).
   - No duplicate objects were created.

### 5. Stop the launch and verify wind-down at Meta **[PERSON]**

1. On the Campaigns screen, click **Stop this launch** (`Dừng lần chạy này`) and confirm.
- **[CHECK]** the launch immediately shows **Stopped** (`Đã dừng`), its commitment stays held until today ends (`commitUntil = today`), and the wind-down line moves from `Its ads are being paused at the ad platform` to `Its ads are paused at the ad platform` (`wound_down_at` set).
2. **[CHECK]** In Meta Ads Manager, refresh and confirm that the campaign, the ad set, and the ad are all `PAUSED`.

### 6. Switch running ads off and verify pause-before-revoke **[PERSON]**

1. On the Ads screen, click **Turn off running ads** (`Tắt chạy quảng cáo` / `ads.write.disable`) and confirm.
- **[CHECK]** the write connection is closed, any spend-capable read connection is closed with the prompt to reconnect read-only after revoking, and the `ads-revoke` sweep revokes the app permission at Meta (`DELETE /me/permissions`) within a minute.
- **[CHECK]** on the Ads screen, the revoke status settles as completed, and in Facebook Settings -> Business Integrations the app is removed (or reconnecting for reading asks for `ads_read` again).

## Results to record on `#2296`

Record without any real account id, token, or secret:

| Item | Result |
|---|---|
| Write OAuth (`metawrite_ads`) granted `ads_read` + `ads_management` | |
| Campaign, ad set, creative, and ad created `PAUSED` with `[ludy:<tag>]` | |
| Campaign `daily_budget` and `spend_cap` in Ads Manager match the approved plan | |
| Activation order (`ad` -> `ad_set` -> `campaign`) reached `live` (or stayed `paused` for a future start date) | |
| `Stop this launch` paused all objects in Ads Manager and kept today's commitment | |
| Switching writing off revoked the token permission at Meta (`DELETE /me/permissions`) | |
| Any Meta Graph API field or status code that differed from the sandbox | |

## Cleanup

Pause or archive the test campaign in Meta Ads Manager if anything was left by hand, set `ADS_LIVE_LAUNCH=false` in `.env`, and run `docker compose down -v` on the throwaway stack.
