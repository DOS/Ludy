# Facebook Page conversations: live check

Settles, on one real Facebook Page the owner controls, the Meta Graph API and Page webhook facts the Facebook Page comment and Messenger adapter (issues #2307 and #2308, [plan](../plan/conversations.md) sections 6.1-6.3, 7 and 13 CV2 & CV4, ADR-0041) relies on. Every fact tagged **[S]** (secondary source) or **[U]** (unverified against a live Graph v24.0 Page) is read in one place in the code, listed below with the file to update if the live answer differs.

**Scope.** Only the owner's own Facebook Page and test accounts that hold a role on the Meta app (`Admin`, `Developer`, or `Tester`) while the app is in Development mode.

Markers: **[PERSON]** only a person can do it (the owner: Meta App Dashboard, Facebook Page, test accounts). **[AGENT]** a Ludy session can do it with the owner's go-ahead. Never paste a secret, a token or a customer's message into chat, an issue or a commit: write what each step showed ("matched", "no match", the error code), not its content.

## 0. What the owner sets up

**[PERSON]** in the Meta App Dashboard (`developers.facebook.com`), on the Meta app configured for Social (`CHANNEL_META_APP_ID`, `CHANNEL_META_APP_SECRET`, see [social-live-check.md](social-live-check.md)):

1. **Webhooks product (Page object):**
   - Add the **Webhooks** product if not already added, select the **Page** object, and set:
     - **Callback URL:** `<PUBLIC_URL>/api/channels/facebook/webhook` (HTTPS, no org in the path).
     - **Verify Token:** the random token (8 to 200 non-whitespace characters) set in `CHANNEL_META_WEBHOOK_VERIFY_TOKEN`.
   - Subscribe to the **`feed`**, **`messages`**, and **`message_echoes`** fields on the Page webhook.
2. **Data Deletion Request URL (CV6, #2305):**
   - Under **Settings > Basic > Data Deletion Request URL**, confirm `<PUBLIC_URL>/api/ads/meta/data-deletion` is set (shared with the Ads data deletion callback).
3. **Permissions for Page comments and Messenger (`pages_messaging`):**
   - In **Development mode**, accounts with an app role (`Admin`, `Developer`, `Tester`) can grant `pages_read_user_content`, `pages_manage_metadata`, and `pages_messaging` alongside the publishing scopes (`pages_show_list`, `pages_manage_posts`, `pages_read_engagement`, `pages_manage_engagement`) without App Review.
   - Before non-role users connect Pages with comment and Messenger reading enabled in **Live mode**, complete App Review for `pages_read_user_content`, `pages_manage_metadata`, and `pages_messaging` (plus the `HUMAN_AGENT` message tag if replying past 24 hours).
4. **Page Inbox / Handover Protocol (primary receiver vs standby):**
   - Under **Page Settings > Advanced Messaging > App Settings**, when the Meta app is configured as the **Primary Receiver** (or no handover app owns the thread), Meta delivers inbound customer DMs in `entry[].messaging[]`. When Meta Business Suite / Page Inbox holds the primary receiver role and the app is only a secondary receiver, Meta delivers events in `entry[].standby[]`, which `parseFacebookNotices` ignores so Ludy never double-stores or answers while standing by.

### Webhook verify token and app secret rotation

- **Variables:** `CHANNEL_META_WEBHOOK_VERIFY_TOKEN` (the handshake token Meta sends in `hub.verify_token` on `GET /api/channels/facebook/webhook`) and `CHANNEL_META_APP_SECRET` (with optional `CHANNEL_META_APP_SECRET_PREVIOUS` during a rotation). With `CHANNEL_META_APP_ID`, `CHANNEL_META_APP_SECRET`, and `CHANNEL_META_WEBHOOK_VERIFY_TOKEN` set, `GET` and `POST /api/channels/facebook/webhook` are mounted; without them, the route does not exist.
- **Planned rotation of `CHANNEL_META_APP_SECRET`:**
  1. **[PERSON]** copy the current `CHANNEL_META_APP_SECRET` into `CHANNEL_META_APP_SECRET_PREVIOUS` in `.env`, set the new secret in `CHANNEL_META_APP_SECRET`, and restart the API and worker (`docker compose up -d`). Both the current and previous secrets are accepted by `X-Hub-Signature-256`.
  2. **[PERSON]** once Meta signs notices with the new secret, remove `CHANNEL_META_APP_SECRET_PREVIOUS` from `.env` and restart (`pnpm pilot:check` flags `CHANNEL_META_APP_SECRET_PREVIOUS` as a manual reminder until removed).
- **A leaked secret:** never put a leaked secret in `CHANNEL_META_APP_SECRET_PREVIOUS`; rotate immediately in Meta App Dashboard and `.env`, restart, and let hourly reconciliation (`CHANNEL_FACEBOOK_HISTORY=true`) recover any comments missed during the rotation window.

## 1. Results table

Fill one row per fact as it is settled; commit the table with any code adjustments needed.

| # | Fact | Tag | Where the code reads it | Result (matched or the live answer) |
|---|---|---|---|---|
| 1 | `GET /api/channels/facebook/webhook?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=<challenge>` returns `200 text/plain` with `<challenge>` | [S] | `verifyFacebookWebhookChallenge` in `apps/kernel/src/facebook-webhook.ts` | |
| 2 | `POST /api/channels/facebook/webhook` carries `X-Hub-Signature-256: sha256=<64 hex>` (HMAC-SHA256 over raw request bytes with `CHANNEL_META_APP_SECRET`) | [S] | `metaSignatureOk` in `packages/channel/src/meta-conversation.ts` | |
| 3 | Page comment notice shape: `object: "page"`, `entry[].id` (Page id = `external_account_id`), `entry[].changes[]` with `field: "feed"`, `value.item: "comment"`, `value.verb` in `add \| edited \| remove \| hide \| unhide`, `value.comment_id`, `value.post_id`, `value.parent_id`, `value.message`, `value.created_time` (unix seconds), `value.from.{id,name}` | [S, U] | `parseFacebookNotices` in `packages/channel/src/meta-conversation.ts` | |
| 4 | Development mode delivery: `feed` comment webhooks deliver when the Page is subscribed via `POST /{page-id}/subscribed_apps` (`subscribed_fields=feed`) and the commenter holds an app role (`Admin`, `Developer`, `Tester`); confirm whether `value.from.{id,name}` is populated when `pages_read_user_content` is granted | [U] | `parseFacebookNotices` (`fromId` falls back to `comment:{comment_id}` if `from` is omitted) | |
| 5 | Page Inbox / Messenger Handover Protocol does **not** suppress `feed` comment webhooks (it governs `messages` / `messaging_postbacks` only) | [U] | `FacebookPageConnector.exchange` in `packages/channel/src/meta.ts` (`subscribed_fields: 'feed'`) | |
| 6 | `POST /{page-id}/subscribed_apps` with `subscribed_fields=feed` and the Page access token returns `{ success: true }` when `pages_manage_metadata` and `pages_read_user_content` are granted | [S, U] | `FacebookPageConversations.subscribe` in `packages/channel/src/meta-conversation.ts` | |
| 7 | `POST /{parent-id}/comments` with `{ message }` and the Page access token works on both a top-level comment id and a post id, returning `{ id: "<post_id>_<comment_id>" }`; confirm how a reply to a reply threads on Facebook (`parent_id` vs top-level comment id) | [U] | `FacebookPageConversations.reply` in `packages/channel/src/meta-conversation.ts` | |
| 8 | `POST /{comment-id}` with `{ is_hidden: "true" \| "false" }` and the Page access token hides or unhides the comment and returns `{ success: true }`; hiding a Page's own comment returns a Graph error mapped to `NOT_ALLOWED` | [S, U] | `FacebookPageConversations.hide` in `packages/channel/src/meta-conversation.ts` | |
| 9 | Echo of a Page's own comment (`from.id === entry.id`) matches the outbound message sent from Ludy by `external_message_id` (or text within 2 minutes) and does not create a duplicate message or reopen a resolved thread | [U] | `ingestEvent` in `packages/kernel/src/conversations.ts` | |
| 10 | Reconciliation (`GET /{page-id}/published_posts?fields=id&limit=25` and `GET /{post-id}/comments?fields=id,message,from,created_time,parent,is_hidden&limit=50`) returns the same comment `id` format as webhook `value.comment_id`, so idempotent upsert by `(org_id, connection_id, external_message_id)` never duplicates a comment | [U] | `FacebookPageConversations.history` in `packages/channel/src/meta-conversation.ts` | |
| 11 | Messenger `messages` and `message_echoes` notice shape: `object: "page"`, `entry[].id` (Page id), `entry[].messaging[]` with `sender.id`, `recipient.id`, `timestamp` (unix ms), `message.mid`, `message.text`, `message.is_echo`, and `message.attachments[].{type, payload.url}`; `entry[].standby[]` is ignored | [S, U] | `eventFromMessaging` in `packages/channel/src/meta-conversation.ts` | |
| 12 | `POST /{page-id}/subscribed_apps` with `subscribed_fields=feed,messages,message_echoes` returns `{ success: true }` when `pages_manage_metadata`, `pages_read_user_content`, and `pages_messaging` are granted, and falls back to `feed` when `pages_messaging` was not granted | [S, U] | `FacebookPageConversations.subscribe` in `packages/channel/src/meta-conversation.ts` | |
| 13 | Messenger Send API (`POST /{page-id}/messages`): sends `{ recipient: { id: "<psid>" }, messaging_type: "RESPONSE", message: { text } }` within 24 hours of `lastInboundAt`, and `{ recipient: { id: "<psid>" }, messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT", message: { text } }` between 24 hours and 7 days, returning `{ recipient_id, message_id }` | [S, U] | `FacebookPageConversations.reply` in `packages/channel/src/meta-conversation.ts` | |
| 14 | Private reply to a Page comment (`POST /{page-id}/messages` with `{ recipient: { comment_id: "<comment_id>" }, message: { text } }`): allowed once per comment within 7 days of the comment, opens a `direct` conversation linked to the comment thread (`parent_conversation_id`), and when the customer replies in Messenger the conversation continues under their PSID | [S, U] | `conversationReplyPrivately` in `packages/kernel/src/conversations.ts` and `FacebookPageConversations.reply` | |
| 15 | Echo-based reconciliation on `message_echoes`: an outbound Messenger reply or private reply in `sending` or `unknown` state (`external_message_id IS NULL`) that matches the echo's `body` within the timestamp window transitions to `sent` with `external_message_id = message.mid` and marks the `external_call` row `succeeded` | [U] | `ingestEvent` in `packages/kernel/src/conversations.ts` | |
| 16 | Customer Messenger image attachments (`attachments[].type === "image"`): fetched through the egress guard from `FACEBOOK_MEDIA_HOSTS` (`fbcdn.net`, `fbsbx.com`) and stored in org conversation storage | [S, U] | `FACEBOOK_MEDIA_HOSTS` in `packages/channel/src/meta-conversation.ts` and `mediaHostsOf` in `apps/kernel/src/conversation-media.ts` | |

## 2. Steps

1. **Webhook handshake (row 1).** **[PERSON]** in Meta App Dashboard > Webhooks > Page, click **Verify and Save** with `<PUBLIC_URL>/api/channels/facebook/webhook` and the verify token from `.env`. Confirm it saves cleanly (`200`).
2. **Connect the Page with comment and Messenger opt-in (rows 5, 6, 12).** **[PERSON]** in Ludy (`Social > Channels`), check **Đọc và trả lời bình luận cùng tin nhắn Messenger trong Hộp thư** ("Also read and answer comments and Messenger messages in the Inbox"), click **Connect with Facebook**, and grant the Page permissions. Confirm the connected Page shows "Bình luận và tin nhắn Messenger trên Trang này được đưa vào Hộp thư" and `crove_kernel.channel_connection` has `pages_read_user_content`, `pages_manage_metadata`, and `pages_messaging` in `scopes` and a non-null `granted_by_hash`.
3. **Inbound comment, edit, and hide/unhide from Facebook (rows 2, 3, 4).** **[PERSON]** from a second test account with a role on the Meta app, comment on a post of the Page, then edit the comment. Confirm:
   - One `comment_thread` conversation appears in the Inbox, linked to the published post when the post was published from Ludy (`social_post_id`).
   - Editing the comment updates the message in place (`edited_at` set) rather than appending a second message.
4. **Reply from Ludy and echo dedupe (rows 7, 9).** **[PERSON]** reply to the comment thread from the Ludy Inbox. Confirm:
   - The reply appears under the customer's comment on Facebook.
   - The message in Ludy transitions from `queued` to `sent` with the Graph comment id, and the webhook echo from Facebook does not create a second copy.
5. **Hide and unhide from Ludy (row 8).** **[PERSON]** click **Hide comment** on the customer's comment in Ludy, confirm it is hidden on Facebook (`is_hidden = true`), then click **Unhide** and confirm it is visible again.
6. **Reconciliation (row 10).** Trigger or wait for the hourly conversation history sync (`CHANNEL_FACEBOOK_HISTORY=true`), and confirm no duplicate messages are created and any comment posted while the webhook was unreachable is backfilled.
7. **Inbound Messenger DM and image attachment (rows 11, 16).** **[PERSON]** from the test account, send a direct message (and an image) to the Page on Messenger. Confirm:
   - One `direct` conversation appears in Hộp thư (`social/inbox`) with a 7-day `replyWindowUntil` (`lastInboundAt + 168h`), visible only to owners, admins, and holders of `desk.agent` (`kernel.conversation.direct.read`).
   - The image attachment is fetched through the egress guard (`fbcdn.net` / `fbsbx.com`) and rendered in the thread.
8. **Messenger reply and echo reconciliation (rows 13, 15).** **[PERSON]** reply to the Messenger thread from Hộp thư. Confirm:
   - Within 24 hours of the customer's message, `FacebookPageConversations.reply` sends `messaging_type: "RESPONSE"`; past 24 hours (up to 7 days), it sends `messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT"`.
   - The message transitions to `sent` with `m_...` and the `message_echoes` webhook does not duplicate it (or reconciles an `unknown` send to `sent`).
9. **Private reply to a Page comment (row 14).** **[PERSON]** on an inbound customer comment in a `comment_thread` conversation (within 7 days of the comment), click **Trả lời riêng** ("Reply privately"), enter a message, and send. Confirm:
   - A `direct` conversation linked to the comment (`parentId` = the comment thread) is created and the message is sent via `POST /{page-id}/messages` with `recipient: { comment_id }`.
   - The comment shows **Xem tin nhắn riêng** ("View private message"), and attempting a second private reply on the same comment is refused with `PRIVATE_REPLY_ALREADY_SENT`.
10. **Page Inbox Handover Protocol check (row 11).** **[PERSON]** send a message from Meta Business Suite Inbox as the Page, and confirm `message_echoes` appends the Page's message to the thread in Ludy (`direction: "out"`, `authorKind: "system"`) without reopening a resolved conversation.
