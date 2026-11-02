# Zalo OA conversations: live check

Settles, on one real Official Account (OA), the Zalo facts the conversation core (issue #2304, [plan](../plan/conversations.md) section 6.5, ADR-0041) was built on without ever seeing a live event. Zalo's developer pages are JavaScript-only and could not be read, so every fact below is tagged **[S]** (a secondary source: an SDK, an adapter's documentation, a community post) or **[U]** (sources conflict or are silent). The code never treats one as truth: each is read in one place, listed here with the file to change if the live answer differs.

**Scope.** Only the owner's own OA and test accounts (the owner's own Zalo accounts that follow the OA). **No real customer's messages** go through a live channel until the retention, erasure, export and purge issue (CV6, #2305) is accepted: the notices of a customer are personal data of a third party, kept here only until stored, and stored without an expiry until CV6.

Markers: **[PERSON]** only a person can do it (the owner: Zalo developer console, the OA manager, phones). **[AGENT]** a Ludy session can do it with the owner's go-ahead. Never paste a secret, a token or a customer's message into chat, an issue or a commit: write what each step showed ("matched", "no match", the error code), not its content.

## 0. What the owner sets up

**[PERSON]** in the Zalo developer console (developers.zalo.me), on the app already used for Social (`CHANNEL_ZALO_APP_ID`, `CHANNEL_ZALO_APP_SECRET`, see [social-live-check.md](social-live-check.md) section on Zalo):

1. The OA must be on a plan **with API integration** [S: Zalo's pricing page lists Standard, Growth and Comprehensive, with API only from Growth; quotas of messages outside the free window (500 a month on Growth, 2,000 on Comprehensive, 55 VND beyond) are [S]]. Record the plan's name and whether the console shows the quota.
2. App > Official Account > **Webhook**: set the webhook URL to `<APP_URL>/api/channels/zalo/webhook` (the one URL, on https, nothing in it names an org), and subscribe the events `user_send_text`, `user_send_image`, `user_send_file`, `user_send_sticker`, `user_send_gif`, `user_send_location`, `user_send_link`, `user_send_audio`, `user_send_video` and the OA's own `oa_send_text` and `oa_send_*` (the echoes of what the OA sent from its own inbox). The follow, unfollow, delivered and seen events may be on: the route answers them 200 and stores nothing.
3. Note the app's **OA secret key** (the same screen). It is a credential and **not** the app secret.

### The OA secret key: where it lives, how it is held, how it is rotated

- **Variable:** `CHANNEL_ZALO_OA_SECRET_KEY`, beside `CHANNEL_ZALO_APP_ID` and `CHANNEL_ZALO_APP_SECRET` (the server refuses to start with the key and no app id, and with a key of fewer than 8 or more than 200 characters or with spaces). With the key set, the route `POST /api/channels/zalo/webhook` exists; without it, the route does not exist.
- **How it is held:** read from the process environment only. It is never written to the database, a file, a log line, an error, an alert, an audit row or an answer, and it is not part of any connection's sealed credential (those are each OA's own access and refresh tokens, sealed by `CREDENTIAL_KEY` as for every channel). The pilot check refuses a sample value (`change-me`) for it.
- **Rotation with no gap (it protects only the check of Zalo's notices, so a rotation loses nothing stored).** Zalo does not retry a notice Ludy refused [S], so the new key must be known to Ludy *before* Zalo starts signing with it. `CHANNEL_ZALO_OA_SECRET_KEY_PREVIOUS` holds the key being replaced, and a notice signed with either is accepted:
  1. **[PERSON]** copy the current value of `CHANNEL_ZALO_OA_SECRET_KEY` into `CHANNEL_ZALO_OA_SECRET_KEY_PREVIOUS` in `.env`, and restart the API (`docker compose up -d`). Nothing changes yet.
  2. **[PERSON]** generate the new OA secret key in the Zalo console, put it in `.env` as `CHANNEL_ZALO_OA_SECRET_KEY` (the old one stays in `_PREVIOUS`), and restart the API at once. From the moment Zalo signs with the new key both are accepted, so no notice is refused.
  3. Check with section 2 below (a test message appears).
  4. **[PERSON]** a day later remove `CHANNEL_ZALO_OA_SECRET_KEY_PREVIOUS` and restart: the old key, which may have leaked, is no longer accepted. (If the old key leaked, do steps 1 to 4 on the same day, and the old key stops being accepted at step 4.)
  4. If the key leaked: rotate as above, then read the API's request log for 401s on the route since the leak (a forged notice with the leaked key is signed, so it is accepted: a leaked key means a forger can add messages to the threads of connected OAs, never read or send anything; look at the last messages of each thread in the inbox).
- **Where the value is never to appear:** chat, issues, pull requests, runbook results. Write "key set" and "key rotated on <date>".

## 1. Results table

Fill one row per fact as it is settled; commit the table with the fixes it caused.

| # | Fact | Tag | Where the code reads it | Result (matched or the live answer) |
|---|---|---|---|---|
| 1 | The signature is `X-ZEvent-Signature: mac=<hex>` with `<hex> = sha256(appId + body + timestamp + oaSecretKey)`, `timestamp` the one in the body | [S, U] | `zaloSignatureOk` in `packages/channel/src/zalo-conversation.ts` | |
| 2 | Event names and payload fields (`event_name`, `timestamp` as string milliseconds, `sender.id`, `recipient.id`, `message.msg_id`, `message.text`) | [S] | `parseZaloNotice` in the same file | |
| 3 | `recipient.id` of a customer's message is the OA's id, the same as the connection's `external_account_id` (`oa_id` of `oa/getoa`) | [U] | `parseZaloNotice` (accountId) and `crove_kernel.conversation_connections_for` | |
| 4 | `sender.id` of a customer is the id `oa/message/cs` takes as `recipient.user_id` | [S] | `ZaloConversations.reply` in `packages/channel/src/zalo.ts` | |
| 5 | `oa_send_text` echoes a reply with the same `msg_id` as the `message_id` of the API's answer | [U] | echo matching in `ingestEvent` (`packages/kernel/src/conversations.ts`), which falls back to the same text | |
| 6 | `POST https://openapi.zalo.me/v3.0/oa/message/cs` with the `access_token` header and body `{recipient:{user_id}, message:{text}}`; the answer is `{error:0, data:{message_id, user_id}}` | [S] | `ZaloConversations.reply` | |
| 7 | A message is free within 48 hours of the customer's last message | [S, U: sources conflict on charging after it and on a 7-day outer limit] | `zalo_oa.windowHours` in `packages/kernel-contract/src/conversations.ts` | |
| 8 | Text up to 2000 characters | [S] | `ZALO_REPLY_MAX`, `zalo_oa.replyMax` | |
| 9 | Error codes: -216 token, -201 parameter, -223 quota, -32 rate limit, -213 not a follower, -232 blocked, and the code of an OA with no API plan | [S] | `conversationError` in `packages/channel/src/zalo.ts`, wording under `conversations.sendError` in the app's messages | |
| 10 | Attachments: the event names and that their address expires after 7 days | [S] | `parseZaloNotice` (placeholders; v1 stores text only) | |
| 11 | No comment API or webhook exists for the OA | [S, "none found" is not proof] | `zalo_oa.kinds` (private chats only) | |
| 12 | The webhook is answered 200 within 2 to 5 seconds, and Zalo does not retry on an error status; it resends after an outage with the original timestamp | [S] | the route's answers; ingest is idempotent on `msg_id` | |
| 13 | The timestamp the signature uses is the first `"timestamp"` key of the raw body (`TIMESTAMP_IN_BODY`): confirm with a real notice that a message text containing the word timestamp in quotes cannot shift it (the signature is over the whole body, so a mismatch is a refusal, not a forgery) | [U] | `zaloSignatureOk` | |

## 2. Steps

All with the OA's connection made in Ludy (Social > channels > Zalo) by an owner, and the `.env` of section 0 in place.

1. **Signature (rows 1, 12).** **[PERSON]** from a test Zalo account that follows the OA, send "kiểm tra 1". **[AGENT]** read the API's log for the route: a 200 means the formula matched; a 401 means it did not. On a 401, with the owner's go-ahead, capture one raw request in a scratch environment (never in the repo) and test the other orders of `appId`, `body`, `timestamp`, `oaSecretKey` against its header; change `zaloSignatureOk` and its test to the one that matches, and write it in row 1.
2. **Inbound (rows 2, 3, 4).** The message appears in the **Hộp thư** of the org within a few seconds (until the Service inbox ships, read it with the owner's own account through the `conversations/list` RPC or the database: one `crove_kernel.conversation` of kind `direct` whose `external_thread_id` is the sender's id, one message with the text). Record whether `recipient.id` equals the connection's account id (row 3). If not, the worker finds no connection and drops the notice: fix `external_account_id` of the connection or the parser.
3. **Reply (rows 4, 5, 6, 8).** Reply from Ludy to that thread. The test account receives it; the message ends `sent`. Record the answer's shape (row 6) and, when the echo `oa_send_text` arrives, whether its `msg_id` equals the answer's `message_id` (row 5). If not, the echo is matched by text (a short window), and a thread then holds one message; if that fails, a second `system` message appears and row 5 needs a fix in `ingestEvent`.
4. **Window (row 7).** **[PERSON]** after more than 48 hours without a message from the test account, try to reply from Ludy: it is refused with the window message and Zalo is not called. Then, from the Zalo OA manager (not Ludy), send a free-text message to that account and record what Zalo does: refuses, charges the quota, or sends. If Zalo allows more than 48 hours, change `windowHours` and the `zalo_oa` rule.
5. **Errors (row 9).** Provoke each one that can be provoked and record the code Zalo returns and the wording Ludy shows: the test account unfollows the OA (not a follower), blocks it (blocked); an expired access token (wait for expiry or revoke the app's access: token); the plan without API integration (a second OA on the Standard plan, if the owner has one). A code Zalo gives that the mapping does not know shows as `ZALO_E<n>`: add it to `conversationError` and the messages.
6. **Attachments (row 10).** Send an image, a file, a sticker and a location. Each shows as its placeholder in the thread ("[Khách gửi ảnh]" and so on) and no address is stored. Record the event names Zalo used; a name `parseZaloNotice` does not know gives "[Khách gửi một tệp đính kèm]".
7. **Follow, seen (row 12).** Unfollow, follow, read a reply: the route answers 200 and no thread or message appears.
8. **Redelivery.** Stop the API for two minutes, send two messages, start it: Zalo's resends arrive (in the original order or not) and each message is in the thread once.
9. **Clean up.** **[PERSON]** delete the test conversations (until CV6 there is no erase button: ask a session to delete the rows of the test thread by id) and rotate the OA secret key if it was ever shown on a screen that was shared.

## 3. What is not built yet (follow-up issues, same plan)

- **History on reconnect** (`listrecentchat`, `conversation`) and the "events missed" marker: Zalo does not retry on an error status [S], so a notice refused while the API was down or its backlog full is not recovered yet. A key rotation no longer refuses any (section 0). A verified notice is never refused for rate (only forged ones are charged to the per-address limit), and the backlog cap is per provider (10000 for Zalo OA, 1000 for the sandbox), so the one thing that still loses a verified notice is a full Zalo backlog of 10000 waiting notices (a worker down for long).
- **Customer images stored as files** (a media address expires after 7 days [S]): v1 stores a placeholder.
- **The customer's name and picture** (`oa/user/detail`): v1 shows "Người dùng ·<last 4 of the id>".
- **Zalo comments**: no API was found.
