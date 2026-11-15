<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Runbook: minutes posted to Slack and Microsoft Teams (Meetings B4)

An owner or admin pastes a **webhook address** under the Meetings tab, "Kênh nhận biên bản": a Slack Incoming Webhook or a Teams Workflows webhook, with a name. The recorder of a meeting with a published result then sees "Gửi vào Slack / Teams" (#3168, plan [section 5.2](../plan/meetings-integrations.md)): they read the exact message, pick a channel and press "Gửi". Ludy posts once and reads nothing back from the channel. No Ludy Slack app, no Marketplace listing, no OAuth, no Slack or Teams review, and `docker compose up` needs no outside account.

This runbook is for an operator or a customer's admin. Nothing in the repository runs any step below; the vendor pages could not be read when this was built, so **every fact marked [unverified] is a live check to do once** before telling a customer it works.

## What leaves Ludy, and who reads it

- Only a **published** result, posted by its **recorder's own click**: the meeting's title and day, the summary, the decisions, the action items (title, owner as said, date) and a link back (`<APP_URL>/o/<org>/meetings/<id>`, which opens only for people who can view the meeting).
- **Never** the transcript, the audio, the video or an attendee's contact details. A translation is never posted.
- **Everyone in the channel reads it**, even people who cannot open the meeting. The dialog says so before "Gửi". A posted message cannot be taken back by Ludy: removing a channel from Ludy does not delete what it already posted.
- The org's owner or admin chose the channel by pasting its address; no other member can add one. There is no separate org switch: removing the channel turns B4 off for it.

## What the address is

The address is a secret: anyone holding it can post to the channel. Ludy checks it (https, the service's own host, the shape of the path, the default port), seals it with the credential broker (`CREDENTIAL_KEY`, [credential-key.md](credential-key.md)) bound to the org and the channel, and shows it **once**, while it is pasted. It is never shown again, never logged, never in a command input, an audit row, an event or a job (there is no job). With no `CREDENTIAL_KEY` the card says so and nothing can be saved.

It is opened only by the API process, only for the recorder's own post in flight (a `started` row made under two minutes ago), and used for exactly one request through the egress guard (https only, public addresses, no redirect followed, the host checked again against the adapter's list, a 4 KB answer cap).

**Key rotation.** Unlike a channel connection or a team chat alert, these addresses are **not** resealed by the worker's rotation pass (there is no worker for them). After a `CREDENTIAL_KEY` rotation that drops the old key, a saved address stops opening and a post says "Không mở được địa chỉ đã lưu của kênh"; an owner or admin pastes the address again. While `CREDENTIAL_KEY_PREVIOUS` is set, the old key still opens it. (A reseal pass is a P3 follow-up.)

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
| | `CHANNEL_RATE_LIMITED` (429) | "Đợi N giây rồi thử lại": the recorder presses "Gửi" again; nothing is retried by Ludy |
| | `CHANNEL_UNREACHABLE` | The guard refused the host or the name did not resolve: a private address, or no DNS from the server |
| | `CHANNEL_ADDRESS_INVALID` | The saved address is no longer the service's own: paste it again |
| | `CHANNEL_ADDRESS_UNREADABLE` | The credential key changed or was lost: paste it again (see key rotation) |
| "Không rõ biên bản đã vào ... chưa" | `CHANNEL_TIMEOUT`, `CHANNEL_NO_ANSWER`, `CHANNEL_SERVER_ERROR` | The request left and no usable answer came back. **Look in the channel first.** A new post needs the recorder's tick ("Tôi muốn gửi lại"). A post whose request died before it recorded an outcome (a restart) reads as ambiguous after two minutes |

One post per meeting at a time (`CHAT_POST_BUSY`), at most six a day per meeting (`CHAT_LIMIT`), and a post is refused when the published result changed since the recorder read it (`STALE_CHAT`): they reopen the dialog and read the new text.

## Removing a channel

Remove it from the same card (an owner or admin). Its sealed address and the log of posts to it are deleted at once. What it already posted stays in the channel: delete those messages in Slack or Teams. To make the address useless as well, delete the webhook there.
