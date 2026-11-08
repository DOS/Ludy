# Instagram conversations: live check

Settles, on one real Instagram Business or Creator account linked to a Facebook Page the owner controls, the Meta Graph API and Instagram webhook facts the Instagram comment and direct-message adapter (issue #2309, [plan](../plan/conversations.md) sections 6.4 and 13 CV7, ADR-0041) relies on. Every fact tagged **[S]** (secondary source) or **[U]** (unverified against a live Graph v24.0 Instagram Professional account) is read in one place in the code, listed below with the file to update if the live answer differs.

**Scope and Meta Live-mode rule.** Meta's Instagram webhook documentation states that Instagram webhooks (`object: "instagram"`) are delivered only when the Meta app is switched to **Live mode** (`developers.facebook.com`, App Mode toggle), even for accounts that hold an app role (`Admin`, `Developer`, `Tester`). While the Meta app is in Development mode, hourly comment reconciliation (`CHANNEL_FACEBOOK_HISTORY=true`) and outbound replies still reach Graph API for app-role accounts, whereas live webhook delivery requires switching the app to Live mode (with a published Privacy Policy URL and the Data Deletion Request URL `<PUBLIC_URL>/api/ads/meta/data-deletion` configured).

Markers: **[PERSON]** only a person can do it (the owner: Meta App Dashboard, Instagram Business/Creator account, linked Facebook Page, test accounts). **[AGENT]** a Ludy session can do it with the owner's go-ahead. Never paste a secret, a token or a customer's message into chat, an issue or a commit: write what each step showed ("matched", "no match", the error code), not its content.

## 0. What the owner sets up

**[PERSON]** in the Meta App Dashboard (`developers.facebook.com`), on the Meta app configured for Social (`CHANNEL_META_APP_ID`, `CHANNEL_META_APP_SECRET`, see [social-live-check.md](social-live-check.md) and [facebook-conversations-live-check.md](facebook-conversations-live-check.md)):

1. **Webhooks product (Instagram object):**
   - Under **Webhooks**, select the **Instagram** object and set the same callback and handshake token used for the Page object:
     - **Callback URL:** `<PUBLIC_URL>/api/channels/facebook/webhook` (HTTPS, no org in the path).
     - **Verify Token:** the random token (8 to 200 non-whitespace characters) set in `CHANNEL_META_WEBHOOK_VERIFY_TOKEN`.
   - Subscribe to the **`comments`**, **`live_comments`**, **`messages`**, and **`messaging_postbacks`** fields on the Instagram webhook.
2. **Connected Tools toggle on Instagram:**
   - In the Instagram mobile app or Meta Business Suite for the Instagram Professional account, open **Settings > Messages and story replies > Message controls > Connected tools** and enable **Allow access to messages** so Meta forwards Instagram direct messages to connected apps.
3. **Permissions for Instagram comments and messages:**
   - `instagram_basic` and `instagram_content_publish` (publishing), plus opt-in `instagram_manage_comments`, `instagram_manage_messages`, and `pages_manage_metadata` (for `POST /{page-id}/subscribed_apps`).
   - Before non-role users connect Instagram accounts with comment and message reading enabled, complete Meta App Review for `instagram_manage_comments`, `instagram_manage_messages`, and `pages_manage_metadata` (plus `HUMAN_AGENT` if replying past 24 hours).
4. **Instagram User Profile API consent constraint:**
   - Meta restricts reading an Instagram user's profile (`name`, `username`) to users who have given consent by messaging or interacting with the account, and comment webhooks carry `value.from.{id, username}` directly. Ludy takes `from.username` from comment webhooks when present and falls back to `Người dùng ·<4-char tail>` for direct messages without calling the User Profile endpoint unsolicited.

## 1. Results table

Fill one row per fact as it is settled; commit the table with any code adjustments needed.

| # | Fact | Tag | Where the code reads it | Result (matched or the live answer) |
|---|---|---|---|---|
| 1 | `POST /api/channels/facebook/webhook` receives Instagram events with `object: "instagram"` and `entry[].id` equal to the Instagram Professional account id (`instagram_business_account.id` = `external_account_id`), signed with `X-Hub-Signature-256` using `CHANNEL_META_APP_SECRET` | [S, U] | `acceptFacebookWebhook` in `apps/kernel/src/facebook-webhook.ts` and `parseInstagramNotices` in `packages/channel/src/meta-conversation.ts` | |
| 2 | Instagram comment notice shape: `object: "instagram"`, `entry[].id` (`ig-user-id`), `entry[].changes[]` with `field: "comments"` or `"live_comments"`, `value.id` (comment id), `value.text`, `value.timestamp` (unix seconds or ISO), `value.from.{id, username}`, `value.media.id` (media id = `external_post_id`), `value.parent_id` (when replying to a comment) | [S, U] | `eventFromInstagramChange` in `packages/channel/src/meta-conversation.ts` | |
| 3 | `POST /{page-id}/subscribed_apps` with the linked Page access token (`subscribed_fields=feed,messages,message_echoes` when `instagram_manage_messages` is granted, or `feed` when only `instagram_manage_comments` is granted) enables webhook delivery for the Page's linked Instagram account | [S, U] | `InstagramConnector.exchange` in `packages/channel/src/instagram.ts` and `InstagramConversations.subscribe` in `packages/channel/src/meta-conversation.ts` | |
| 4 | Comment reply (`POST /{comment-id}/replies` with `message=<text>`, up to 2200 chars, using the Page token stored in the connection) posts a public reply under the Instagram comment and returns `{ id: "<reply_comment_id>" }` | [S, U] | `InstagramConversations.reply` in `packages/channel/src/meta-conversation.ts` | |
| 5 | Comment hide/unhide (`POST /{comment-id}?hide=true\|false` with the Page token) hides or unhides the comment on Instagram and returns `{ success: true }` | [S, U] | `InstagramConversations.hide` in `packages/channel/src/meta-conversation.ts` | |
| 6 | Hourly comment reconciliation (`GET /{ig-id}/media?fields=id&limit=25` and `GET /{media-id}/comments?fields=id,text,timestamp,username,from,hidden,replies{id,text,timestamp,username,from,hidden}&limit=50`) returns the same comment `id` as webhook `value.id`, so idempotent upsert by `(org_id, connection_id, external_message_id)` never duplicates a comment | [S, U] | `InstagramConversations.history` in `packages/channel/src/meta-conversation.ts` | |
| 7 | Instagram direct message notice shape: `object: "instagram"`, `entry[].id` (`ig-user-id`), `entry[].messaging[]` with `sender.id` (IGSID), `recipient.id`, `timestamp` (unix ms), `message.mid`, `message.text`, `message.is_echo`, `message.is_deleted` / `message.is_unsupported`, and `message.attachments[].{type, payload.url}`; `entry[].standby[]` is ignored | [S, U] | `parseInstagramNotices` and `eventFromMessaging` in `packages/channel/src/meta-conversation.ts` | |
| 8 | Instagram DM reply (`POST /{ig-id}/messages` with `{ recipient: { id: "<igsid>" }, message: { text } }` within 24 hours of `lastInboundAt`, or with `messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT"` between 24 hours and 7 days, up to 1000 chars) sends the DM and returns `{ recipient_id, message_id }` | [S, U] | `InstagramConversations.reply` in `packages/channel/src/meta-conversation.ts` | |
| 9 | Private reply to an Instagram comment (`POST /{ig-id}/messages` with `{ recipient: { comment_id: "<comment_id>" }, message: { text } }`, up to 1000 chars): allowed once per comment within 7 days of the comment, opens a `direct` conversation linked to the comment thread (`parent_conversation_id`), and continues when the customer answers in Instagram Direct | [S, U] | `conversationReplyPrivately` in `packages/kernel/src/conversations.ts` and `InstagramConversations.reply` in `packages/channel/src/meta-conversation.ts` | |
| 10 | Customer Instagram DM image attachments (`attachments[].type === "image"`): fetched through the egress guard from `INSTAGRAM_MEDIA_HOSTS` (`fbcdn.net`, `fbsbx.com`, `cdninstagram.com`) and stored in org conversation storage | [S, U] | `INSTAGRAM_MEDIA_HOSTS` in `packages/channel/src/meta-conversation.ts` and `mediaHostsOf` in `apps/kernel/src/conversation-media.ts` | |

## 2. Steps

1. **Connect Instagram with comment and message opt-in (row 3).** **[PERSON]** in Ludy (`Social > Channels`), check **Đọc và trả lời bình luận cùng tin nhắn Instagram trong Hộp thư** ("Also read and answer Instagram comments and messages in the Inbox"), click **Connect with Instagram**, and grant the permissions. Confirm the connected Instagram account shows "Bình luận và tin nhắn trên tài khoản Instagram này được đưa vào Hộp thư" and `crove_kernel.channel_connection` has `instagram_manage_comments`, `instagram_manage_messages`, and `pages_manage_metadata` in `scopes`, `pageId` in the sealed credential, and a non-null `granted_by_hash`.
2. **Inbound Instagram comment (rows 1, 2).** **[PERSON]** with the Meta app in Live mode (or via reconciliation with `CHANNEL_FACEBOOK_HISTORY=true` while in Development mode), post a comment from a second Instagram account on a media item of the connected Instagram account. Confirm:
   - One `comment_thread` conversation appears in Hộp thư (`social/inbox`) and under the published post's **Bình luận** tab when the post was published from Ludy (`social_post_id`).
   - The commenter's `@username` (or `Người dùng ·<tail>` when omitted) is shown as the thread contact.
3. **Public reply to an Instagram comment (row 4).** **[PERSON]** reply to the comment thread from Hộp thư (up to 2200 characters). Confirm:
   - The reply appears under the customer's comment on Instagram via `POST /{comment-id}/replies`.
   - The message in Ludy transitions from `queued` to `sent` with the Graph reply id, and the webhook echo does not duplicate it.
4. **Hide and unhide an Instagram comment (row 5).** **[PERSON]** click **Ẩn** ("Hide") on the customer's comment in Hộp thư, confirm it is hidden on Instagram (`POST /{comment-id}?hide=true`), then click **Hiện lại** ("Show again") and confirm it is visible again (`hide=false`).
5. **Hourly comment reconciliation (row 6).** **[AGENT]** with `CHANNEL_FACEBOOK_HISTORY=true`, run or wait for the hourly conversation history sync on the Instagram connection, and confirm `GET /{ig-id}/media` and `GET /{media-id}/comments` backfill any missed comment or reply without duplicating existing messages.
6. **Inbound Instagram DM and image attachment (rows 7, 10).** **[PERSON]** send a direct message and an image from the second Instagram account to the connected Instagram Business/Creator account. Confirm:
   - One `direct` conversation appears in Hộp thư (`social/inbox`) with a 7-day `replyWindowUntil` (`lastInboundAt + 168h`), visible only to owners, admins, and holders of `desk.agent` (`kernel.conversation.direct.read`).
   - The image attachment is fetched through the egress guard (`cdninstagram.com` / `fbcdn.net` / `fbsbx.com`) and rendered in the thread.
7. **Reply to an Instagram DM and echo reconciliation (row 8).** **[PERSON]** reply to the Instagram DM thread from Hộp thư (up to 1000 characters). Confirm:
   - Within 24 hours of the customer's last message, `InstagramConversations.reply` sends a standard response; between 24 hours and 7 days, it sends `messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT"`.
   - The message transitions to `sent` and the `is_echo: true` webhook event does not duplicate it (or reconciles an `unknown` send to `sent`).
8. **Private reply to an Instagram comment (row 9).** **[PERSON]** on an inbound customer comment in an Instagram `comment_thread` conversation (within 7 days of the comment), click **Trả lời riêng** ("Reply privately"), enter a message (up to 1000 characters), and send. Confirm:
   - A `direct` conversation linked to the comment (`parentId` = the comment thread) is created and the message is sent via `POST /{ig-id}/messages` with `recipient: { comment_id }`.
   - The comment shows **Xem tin nhắn riêng** ("View private message"), and attempting a second private reply on the same comment is refused with `PRIVATE_REPLY_ALREADY_SENT`.
