<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Runbook: minutes posted to Slack and Microsoft Teams (Meetings B4)

An owner or admin pastes a **webhook address** under the Meetings tab, "Kênh nhận biên bản": a Slack Incoming Webhook or a Teams Workflows webhook, with a name. The recorder of a meeting with a published result then sees "Gửi vào Slack / Teams" (#3168, plan [section 5.2](../plan/meetings-integrations.md)): they read the exact message, pick a channel and press "Gửi". The click queues the post and the worker's job sends it within a minute or so, once. Ludy reads nothing back from the channel. No Ludy Slack app, no Marketplace listing, no OAuth, no Slack or Teams review, and `docker compose up` needs no outside account.

This runbook is for an operator or a customer's admin. Nothing in the repository runs any step below; the vendor pages could not be read when this was built, so **every fact marked [unverified] is a live check to do once** before telling a customer it works.

## What leaves Ludy, and who reads it

- Only a **published** result, posted by its **recorder's own click**: the meeting's title and day, the summary, the decisions, the action items (title, owner as said, date) and a link back (`<APP_URL>/o/<org>/meetings/<id>`, which opens only for people who can view the meeting).
- **Never** the transcript, the audio, the video or an attendee's contact details. A translation is never posted.
- **Everyone in the channel reads it**, even people who cannot open the meeting. The dialog says so before "Gửi". A posted message cannot be taken back by Ludy: removing a channel from Ludy does not delete what it already posted.
- The org's owner or admin chose the channel by pasting its address; no other member can add one. There is no separate org switch: removing the channel turns B4 off for it.

## What the address is

The address is a secret: anyone holding it can post to the channel. Ludy checks it (https, the service's own host, the shape of the path, the default port), seals it with the credential broker (`CREDENTIAL_KEY`, [credential-key.md](credential-key.md)) bound to the org and the channel, and shows it **once**, while it is pasted. It is never shown again, never logged, never in a command input, an audit row, an event or a job payload (the job carries a post id; the worker opens the sealed address itself). With no `CREDENTIAL_KEY` the card says so and nothing can be saved.

It is opened only by the **worker's job** (ADR-0025: the API seals and never opens), only while the channel stands (below), and used for one request per attempt through the egress guard (https only, public addresses, no redirect followed, the host checked again against the adapter's list, a 4 KB answer cap that is never parsed, 10 s an attempt).

**How a post travels.** The recorder's click runs `meetings.chat.post`: in the recorder's own transaction it rebuilds the message from the published result, stores the post (ids and hashes, never text) and the message (a definer-only row, checked by the database for exactly the allowed keys). Every minute a sweep hands the waiting posts to the queue `kernel-meeting-chat`; the job reads the message, fetches and opens the address, posts, and records the outcome; the database **deletes the message the moment the post settles**, and drops a queued post (and its message) when the published text of the meeting changes or the channel is removed. A post nobody takes up for eight hours (the worker was down) is failed (`POST_EXPIRED`) without a call. With no `CREDENTIAL_KEY`, or without the meetings module, neither the sweep nor the job runs.

**Retries, only when safe.** A failure that proves nothing arrived (the guard refused the address, the name did not resolve, the service said to wait with a 429) is tried again, up to three times with a growing delay. An answer that may have been delivered (a timeout, a dropped connection, a server error) is settled `ambiguous` and is **never** sent again by the job. A repeat is the recorder's own click, with their tick.

**The channel belongs to the person who pasted it.** Recorders can post only while that person is an owner or admin of the org and not disabled. When they are demoted, removed or disabled, a new click says `CHAT_CHANNEL_OWNER_LEFT`, a queued post is dropped (`CHANNEL_NOT_STANDING`), and the address opens for nobody until an owner or admin pastes it again (which makes them its owner). Teams addresses sit on multi-tenant Microsoft hosts and the screen shows only the host, so this keeps a channel from outliving the person who vouched for its destination.

**Key rotation.** The worker's reseal pass ([credential-key.md](credential-key.md)) reseals these addresses like the other sealed stores, for channels whose saver still stands; the others are counted and wait to be pasted again. While `CREDENTIAL_KEY_PREVIOUS` is set, the old key still opens them.

## Setting up a channel (the customer's own admin does this)

- **Slack.** In the customer's Slack workspace make a small app, turn on Incoming Webhooks, add a webhook to the channel and copy its address, `https://hooks.slack.com/services/T.../B.../...`. Paste it in Ludy with a name.
- **Teams.** Office 365 Connectors were retired; use a Workflows flow with the template "Post to a channel when a webhook request is received" [unverified], and copy the address it gives, on a `*.logic.azure.com` or `*.api.powerplatform.com` host. Paste it in Ludy with a name. The flow posts as the person or as Flow bot, as its owner configures it.

Check: the card lists the name, the kind and the host (never the rest). A first real post to the channel is the test: Ludy sends no test message, because one would be a message to the channel's readers.

## Facts to confirm once [unverified]

The build environment could not reach `docs.slack.dev` or `learn.microsoft.com`, so none of these was read from the vendor. Confirm each, write the date and the finding in the issue (#3168), and fix the adapter (`packages/channel/src/minutes-webhook.ts`) if one is wrong.

| # | Fact the adapter assumes | How to check | If wrong |
| --- | --- | --- | --- |
| 1 | Slack still offers Incoming Webhooks to new apps, host `hooks.slack.com`, path `/services/T.../B.../...` | Create one in a test workspace; `SLACK_PATH` in the adapter accepts it | Fix `parseMinutesUrl`; if Incoming Webhooks are gone for new apps, B4's Slack half needs an app (a new decision) |
| 2 | Slack answers 200 `ok`; about one message a second per webhook; a text over 40,000 characters is cut | Post twice quickly; read Slack's rate-limit page | The adapter treats 429 as "thử lại sau N giây" and `CHAT_MESSAGE_MAX_CHARS` is 12,000 either way |
| 3 | Slack shows `text` with `mrkdwn:false`, no unfurl, `&`, `<` and `>` escaped, and cannot ping from the minutes | Post a title like `<!channel> & <@U1>` from a test meeting; it must show as plain text and notify nobody | Escape more or send blocks |
| 4 | Teams Workflows webhook hosts end in `.logic.azure.com` or `.api.powerplatform.com`, path `/workflows/<id>/triggers/<name>/paths/invoke` or `/powerautomate/automations/direct/workflows/<id>/...` | Create the flow in a test tenant and read its address | Add the host suffix or path to `TEAMS_WEBHOOK_HOST_SUFFIXES`, `TEAMS_PATH` |
| 5 | The Teams template needs no Power Automate licence beyond Microsoft 365 | Microsoft's licensing page, and run the flow as a user with no premium licence | Tell the customer before they start; B4's Teams half costs them money |
| 6 | The flow accepts `{"type":"message","attachments":[{"contentType":"application/vnd.microsoft.card.adaptive","content":{...}}]}` with an Adaptive Card of version 1.4, answers 200 or 202 (accepted, not delivered), and takes about 28 KB | Post a long test meeting; read the flow's run history | Change `teamsMinutesBody` (card version or wrapper) and `CHAT_MESSAGE_MAX_CHARS` |
| 7 | A Teams card renders the escaped text (`\*`, `\[`, ...) as plain characters | Post a summary containing `[bấm đây](https://example.com)` and `**đậm**` | Change `teamsEscape` |
| 8 | A Teams flow can fail after answering 202, so the post is recorded `sent` ("Teams đã nhận") but delivery is not confirmed | Break the flow on purpose and post | The screen already says "hãy kiểm tra kênh"; nothing to change |
| 9 | Neither service dedupes a repeated request | Post the same minutes twice | A timeout or a lost answer is `ambiguous` and a repeat needs the recorder's tick; keep that rule |

## When a post goes wrong

| What the recorder sees | Code | Meaning, and what to do |
| --- | --- | --- |
| "Chưa gửi được ... chưa có gì vào kênh" | `CHANNEL_GONE` (404, 410) | The webhook or channel was deleted: the admin makes a new webhook and pastes it |
| | `CHANNEL_REFUSED` (401, 403) | The service refuses the address (revoked, or the app was removed): paste a new one |
| | `CHANNEL_REJECTED` (other 4xx) | The service did not accept the content: check the minutes' length, then the webhook |
| | `CHANNEL_REDIRECTED` (3xx) | The address now redirects; Ludy never follows one with a secret: make the webhook again |
| | `CHANNEL_RATE_LIMITED` (429) | The channel is limiting messages: the job tries again up to three times; after that the post is failed and the recorder can press "Gửi" again |
| | `CHANNEL_UNREACHABLE` | The guard refused the host or the name did not resolve (tried again three times first): a private address, or no DNS from the worker |
| | `CHANNEL_ADDRESS_INVALID` | The saved address is no longer the service's own: paste it again |
| | `CHANNEL_MESSAGE_TOO_LARGE` | A Teams card past about 24 KB once encoded is refused before any call: shorten the summary and share it again |
| | `CHANNEL_NOT_STANDING` (dropped) | The person who saved the channel is no longer an owner or admin, the channel was removed or the org stopped: nothing was sent; an owner or admin pastes the address again |
| | `POST_DROPPED` (dropped) | The minutes' text changed (or was erased) while the post waited: nothing was sent; reopen the dialog |
| | `POST_EXPIRED` | The post waited eight hours with no attempt (the worker was down): failed, nothing sent |
| | `CHANNEL_ADDRESS_UNREADABLE` | The credential key changed or was lost: paste it again (see key rotation) |
| "Không rõ biên bản đã vào ... chưa" | `CHANNEL_TIMEOUT`, `CHANNEL_NO_ANSWER`, `CHANNEL_SERVER_ERROR` | The request left and no usable answer came back. **Look in the channel first.** A new post needs the recorder's tick ("Tôi muốn gửi lại") |

A worker that dies after it began an attempt leaves the post with no outcome; after three minutes the sweep settles it `ambiguous` with `CHANNEL_NO_ANSWER` and never sends it again (the database lets one job begin an attempt, once, before the request leaves). Only a failure that proves nothing arrived (`CHANNEL_UNREACHABLE`, `CHANNEL_RATE_LIMITED`) is retried by the queue.

One post per meeting and channel at a time (`CHAT_POST_BUSY`: a queued post waits), at most six a day per meeting (`CHAT_LIMIT`), and a post is refused when the published result changed since the recorder read it (`STALE_CHAT`): they reopen the dialog and read the new text.

## Removing a channel

Remove it from the same card (an owner or admin). Its sealed address, its queued posts with their messages and the log of posts to it are deleted at once. What it already posted stays in the channel: delete those messages in Slack or Teams. To make the address useless as well, delete the webhook there.
