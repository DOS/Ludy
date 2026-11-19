<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Runbook: live check of managing a running Meta campaign (Ads W4)

W4 (issue [#3835](https://github.com/DOS/Ludy/issues/3835)) lets an owner or an admin pause, resume and archive the campaign, the ad set or an ad of a live launch, lower or raise its daily budget, and shorten or extend its schedule. Until now the Meta side of it (`packages/ad-platform/src/meta-manage.ts`) ran only against recorded answers and the offline sandbox. This runbook takes the owner (JOY) and the Ludy Engage Product Owner session through changing one small live campaign on the owner's own Meta ad account, **after** the launch check in [ads-meta-write-live-check.md](ads-meta-write-live-check.md) (`#2296`) has passed. It follows [docs/plan/ads-write.md](../plan/ads-write.md) sections 3 and 10 and [ADR-0043](../adr/0043-ads-write-running-ads.md).

Public repository rule: no secret, app id, ad account id, token or internal host appears in this file, in an issue, in a PR or in chat. Every value is named by where it comes from. Roles are tagged as in the launch runbook: **[PERSON]** only the owner can do it (their Meta login, their second factor for the approvals); **[PO]** the Engage PO session runs it after JOY approved the concrete step list in the PO's chat; **[CHECK]** what must be true before going on.

## Where it runs

On the same throwaway local stack as the launch check (`docker compose up`, `http://localhost:8080`, `ADS_LIVE_LAUNCH=true`, its own database, no customer data). Start from a **live** launch of one small Traffic campaign with caps set (the end of step 4 of the launch runbook). Keep the daily budget small and the flight at least three days long.

## What is verified in code before you start

- A resume, a raise and an extension are R3 proposals approved like a launch (second factor, the card names the largest amount the launch can spend with the change); a pause, an archive, a lower budget and a shorter schedule are the owner's or an admin's own R2 commands with no approval.
- The caps are checked at the request, at the approval and again before the platform is called (`ads.manage.begin`), under the org's lock, against every other launch; a cap lowered after the approval cancels the change and releases what it held. A queued or unclear raise or extension stays held against the caps; a lower budget or a shorter schedule releases nothing until the platform confirms it.
- With running ads switched off every command but a pause is refused; blocked launches refuse what can start or raise spend. `ACTIVE` is sent only by `meta-activate.ts` (a resume goes through it); `meta-manage.ts` sends the ad set's `daily_budget` in Meta's minor unit and `end_time`.

## Steps

1. **[PERSON]** On the Campaigns screen, open the live launch. **[CHECK]** the Manage section shows the confirmed daily budget and end date, every object active, and the controls (an admin sees them too; a member sees the state only).
2. **[PERSON]** Pause the ad (no approval). **[CHECK]** the change shows "waiting for the platform", then applied; in Meta Ads Manager the ad is `PAUSED` and the campaign still `ACTIVE`.
3. **[PERSON]** Ask to resume it, open the proposal in the Inbox and approve it with the second factor. **[CHECK]** the card names the largest amount before and after (equal for a resume); after approval the ad is `ACTIVE` again.
4. **[PERSON]** Lower the daily budget (no approval). **[CHECK]** Ads Manager shows the new `daily_budget` on the ad set; the Ads screen's committed spend drops only after the change shows applied. Record Meta's unit for the account's currency (the `metaMinorUnits` table is [U] until this step).
5. **[PERSON]** Ask to raise the budget above the first value, approve it. **[CHECK]** the committed spend rises as soon as the request is approved (before the platform confirms), and Ads Manager shows the raised `daily_budget` afterwards.
6. **[PERSON]** Try to raise the budget over a cap you set. **[CHECK]** the request is refused with the numbers (`ADS_SPEND_CAP`); lower the cap under the launch after approving a raise and check the change is cancelled (`cap_lowered`) with nothing changed at Meta.
7. **[PERSON]** Shorten the schedule to tomorrow, then ask to extend it again and approve. **[CHECK]** Ads Manager shows the ad set's `end_time` at the first moment after the chosen day in the account's time zone; the extension cannot pass 90 days from the start.
8. **[PERSON]** Archive the ad. **[CHECK]** it is `ARCHIVED` at Meta and the screen offers no way back.
9. **[PERSON]** Switch running ads off. **[CHECK]** the launch is stopped and paused first (see the launch runbook, step 6); afterwards every control but Pause is refused.

## Results to record on `#3835`

Record without any real account id, token or secret:

| Item | Result |
|---|---|
| Pause and resume of an ad reach Meta once each (`PAUSED`, then `ACTIVE`) | |
| Lowered `daily_budget` matches the approved value in Meta's unit for the currency | |
| Raised `daily_budget` after an approved request matches | |
| `end_time` after a shorter and a longer schedule is the first moment after the last day in the account's zone | |
| Archive reaches Meta as `ARCHIVED` | |
| Meta's exact answer to a `daily_budget` or `end_time` change (field names, any difference from the sandbox) | |
| Any status code or field that differed from the recorded answers | |

## Cleanup

Pause or archive the test campaign in Meta Ads Manager if anything was left by hand, set `ADS_LIVE_LAUNCH=false` in `.env`, and run `docker compose down -v` on the throwaway stack.
