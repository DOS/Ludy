# Ludy conversations: one core for comments (Social) and private messages (Service)

> Design for a shared conversation core, 2026-11-01 (#2213). Owner decision of 2026-11-01: "Trả lời bình luận thì nên trong Social. Tin nhắn riêng trong Service." (reply to comments in Social, private messages in Service), and share as much core as possible. Focus per the owner's decision of 2026-10-31: one-person companies and SMEs first. **This is a design: nothing here is built, the build issues listed in section 13 are not opened, and nothing is built until the owner approves** (section 15). Decision record: [ADR-0041](../adr/0041-conversation-core.md). Vietnamese summary for the owner: [conversations.vi.md](conversations.vi.md). It changes [social.md](social.md) ("Not in Social") and the kernel plan's Service and Social paragraph to the owner's decision. Where the Ads module sits is [ads.md](ads.md) section 2; section 3 here makes it one story.

How facts are tagged. Research was done on 2026-11-01:
- **[C]** stated on an official page that was read.
- **[S]** stated only by a secondary source (an SDK, an adapter's documentation, a community post). Never a rule in the software until a live check confirms it.
- **[U]** could not be confirmed (page unreadable, silent, or sources conflict). The build issue checks it against a real account.

Meta's official pages were readable (the `.md` form of the `/documentation/` paths returns the text). Zalo's developer pages are JavaScript-only and returned only titles, so almost every Zalo fact is [S]. Every number is re-checked against the live page by the build issue that uses it.

## 1. The decision and what it means

- **Comments on the org's own posts** (a Facebook Page post, an Instagram media): read and answered **in Social**, under the post and in a comment inbox.
- **Private messages** (Messenger, Instagram DMs, Zalo OA chat; WhatsApp later): read and answered **in Service** (shown as Desk), with cases.
- **One core underneath**, so either module can be sold and run alone and the second one adds screens, not a second copy of the data.

Today the plan says the opposite for comments: [social.md](social.md) "Not in Social: comments and messages" and kernel plan section 5.7 "Messages and comments land in Service's inbox; Social only publishes". Both change (section 14).

What exists today: Social publishes and reads metrics, can post a first comment and an auto-reply under its own post, and keeps internal review comments (a different thing, `post_comment`). The kernel has `channel_connection`, sealed credentials, `external_call`, `party`, `task`, `activity` and `inbound_message` (email, a record of arrival only). There is no Service module and no store for platform comments or messages. So this design adds the store, and both modules' screens come after it.

## 2. What is shared, and what is not

| Shared (the core, in the kernel) | Why shared | Owned by one module |
|---|---|---|
| Channel connections and sealed credentials (exist, ADR-0025) | One login per page | |
| The conversation and its messages, one store, with a **kind** (`comment_thread`, `direct`) | Same shape: a thread of messages with an external id, a status and an author | |
| The contact (a `party` link, an identity per platform) | One customer, whichever door they use | |
| Assignment, status (New, Pending, Resolved), read state, internal notes | Same work habits in both | |
| Saved replies | A reply to "how much is shipping?" is the same text on a comment or a message | |
| AI reply drafts (tainted, a person sends) | One drafting path, one set of safety rules | |
| The reply pipeline (one send, exactly once, `external_call`) | Same platform call risks as publishing | |
| The conversation screen (list, thread, contact panel), as one component | One UI to build and test | |
| | | **Social:** posts, the per-post comment tab, the comment inbox, hide and unhide, reply to a comment |
| | | **Service:** the direct-message inbox, cases and tickets, SLA, availability and assignment rules |

## 3. Layout: one story for Social, Service and Ads

**Reference (the owner, 2026-11-01, Hootsuite).** One left rail where each product is its own item: Perch (publishing: Plan, Analytics, Ads, Boost), Nest (social inbox and customer care: Conversations with New and Pending, Resolved, Search, Streams, DM automations), and others. Nest takes comments as well as DMs.

**How Ludy's shell works today.** The shell builds its apps, groups and items from each module's entry in `MODULE_SCREENS` (`packages/kernel-contract/src/screens.ts`). A nav item declares `{ app, group, path, label }` (`NavDeclaration` in `manifest.ts`), `apps.ts` lists an app with its groups, and `installedItems` drops every group whose module the deployment does not run (`CROVE_MODULES`); an app with no group left disappears. The rail has four apps today: home, accounting, social, crm. So "an app with groups, each group shown only when its module is enabled" is how the shell already works, and a module can contribute a group to an app another module also contributes to. (This answers the open point in [ads.md](ads.md): a module's nav can sit inside another module's app, no shell change is needed; only a new app id is, if the app is renamed.)

| | (a) One rail app with groups | (b) Social, Service, Ads as separate rail items (Hootsuite style) |
|---|---|---|
| What the user sees | One app, three groups: posting, inbox, ads | Three items on the rail |
| Fits an SME with one or two people | Yes: one place for "my channels", a short rail | A rail of 6 or 7 items for four jobs; the phone drawer grows |
| Sold and run alone | Yes: a group shows only when its module is enabled; an org with only Service sees an app with one group | Yes: an item shows only when enabled |
| Cost in the shell | Rename the Social app id and label (the app is named after the owner's choice); move Social's items into a group | New app ids `service` and `ads`; no rename |
| Moving between a comment and the private reply it started | Inside one app, one click | Switches app |
| Matches Hootsuite | Partly (Perch holds Plan, Analytics and Ads as groups) | Fully |

**Recommendation: (a), one rail app with three groups.** It is one story for all three: the app holds **Đăng bài** (Social: calendar, posts, comments), **Hộp thư** (Service: private messages and cases) and **Quảng cáo** (Ads), each shown only when its module is enabled, so either module can be sold and run alone and a Service-only org sees only the inbox group. It is the shape Hootsuite itself uses inside Perch (Ads is a group there, not a product), it needs no new shell concept, and it keeps the rail short for the people Ludy is for. The name of the app is the owner's call with the Frontend line (working name **Kênh**, "Channels"; JOY suggested "Ludy Channels"); the groups' names are copy. [ads.md](ads.md) says "a group inside the Social (posting) app": that app is this app, so the two documents agree. The cost of (a) is one rename of the existing Social app id and its menu messages; no URL changes, because routes are `/o/$slug/<screen>` and only the app id in the nav declarations moves.

## 4. Does a comment also show in the Service inbox?

**Recommendation: no, a comment lives only in Social; Service shows private messages.** That is the owner's decision applied as written, and it avoids the same item in two inboxes with two sets of unread counts and two people answering it. Three connections keep the two sides together:

1. **Reply privately.** On a comment, Social offers "reply privately" (Meta allows one private message to the commenter within 7 days of the comment [C]; Instagram likewise [C]). It creates a **direct conversation** linked to the comment thread. From that moment the thread is a private message, so it appears in Service's inbox (and in Social the comment keeps a "continued in a private message" link when the person can read both).
2. **Send to Service.** When both modules are enabled, a comment can be handed to Service as a case (the case links back to the comment). Cases come with Service; until then the button is a task for a person (kernel `task`), linked to the comment.
3. **The contact.** Both threads link to the same party, so the contact panel shows a person's comments and messages together for a user who can read both.

A **Service-only** org gets no comments in v1: it did not enable Social, and the owner's decision puts comment replies in Social. Whether Service should show comments as a filter when Social is off is Q2; the design keeps it cheap (the core already stores them; it would be a screen filter and a permission).

## 5. The core

### 5.1 Where it lives: the kernel

- **Recommendation: kernel tables** (`crove_kernel.conversation` and siblings), next to `channel_connection`, `party`, `task` and `activity`, which the kernel plan already says every module shares. The kernel plan's rule for shared services is the reason: Social and Service must each run without the other, so neither can own the store, and a third module both depend on would force Service to be installed to read a comment.
- **What it costs.** More kernel surface (migrations, protected paths, a security review per PR), personal data in the kernel schema (handled by the org purge, section 10), and a kernel command set that the manifests of both modules reuse. A module-owned store would be less kernel work but would make one module depend on the other.
- **Alternative: a module `conversation`** (schema `crove_conversation`) that Social and Service depend on. Rejected as the default: ADR-0041 explains.

### 5.2 Tables (`crove_kernel`)

Every table has `org_id`, `PRIMARY KEY (org_id, id)`, RLS via `apply_tenant_rls`, composite foreign keys led by `org_id`, `numeric` money (none here), `timestamptz`. Rows are per legal entity where the connection is (a member limited to one entity reads only that entity's conversations).

| Table | Key columns |
|---|---|
| `conversation` | `channel_connection_id`, `kind` (`comment_thread`, `direct`), `external_thread_id` (the platform's thread or the top comment's id), `external_post_id` (comment threads: the platform's post or media id; Social joins it to its own `post_variant` on `(channel_connection_id, external_post_id)`, so there is no foreign key across schemas), `parent_conversation_id` (a private reply points at its comment thread), `contact_identity_id`, `party_id` (set only by a person, section 5.4), `status` (`new`, `pending`, `resolved`), `assignee_user_id`, `last_inbound_at`, `last_message_at`, `reply_window_until` (when the platform's free-reply window closes, from the last inbound message), `opened_at`, `resolved_at`, `resolved_by` |
| `conversation_message` | `conversation_id`, `direction` (`in`, `out`), `external_message_id` (unique per `(org_id, channel_connection_id)`), `sent_at` (the platform's time; ordering uses it), `received_at`, `author_kind` (`contact`, `member`, `agent`, `system`), `author_user_id`, `body`, `attachments` (file ids), `send_state` (`queued`, `sent`, `failed`, `unknown`, for `out`), `hidden_at` and `hidden_by` (a comment hidden on the platform), `platform_removed_at` (the author or platform removed it; the body is blanked, section 10), `tainted` (always true for `in`) |
| `conversation_identity` | `provider`, `external_user_id` (a page-scoped id on Meta, an OA-scoped id on Zalo), `display_name`, `avatar_file_id`, `party_id`, `consent`, unique per `(org_id, provider, external_user_id)`; **every column that names a person is classed `pii`** in the manifest |
| `conversation_note` | `conversation_id`, `author_user_id`, `body`, `created_at`: an internal note, never sent |
| `saved_reply` | `title`, `body`, `shortcut`, `created_by`, `channel_kinds` |
| `conversation_draft` | `conversation_id`, `body`, `origin` (`ai`), `tainted`, `created_by_agent`, `status` (`pending`, `used`, `discarded`): an AI draft, written by an agent, never sent by one |
| `conversation_read` | `conversation_id`, `user_id`, `last_read_message_id` |
| `conversation_composing` | `conversation_id`, `user_id`, `expires_at`: the "you are replying" marker, pruned by a sweep (section 5.5) |
| `member_availability` | `user_id`, `status` (`available`, `away`), `until` |

Assignment, status changes and resolves also write an `activity` row (ids only, no text, section 9).

### 5.3 Statuses

- **New**: the last message is inbound and nobody has replied since. **Pending**: a person replied and the contact has not answered. **Resolved**: closed by a person (comment threads need a person too). A new inbound message on a resolved conversation reopens it as New. These are Hootsuite Nest's states (New and Pending, Resolved) and need no SLA.
- A comment thread is one conversation per **top-level comment** (its replies are its messages), so a busy post does not become one giant thread.

### 5.4 Contact

- The identity is created on first contact (a platform id, and the name and picture the platform gives). **A party is never created automatically**: a person links the conversation to an existing contact or creates one ("Link to contact", "Create contact"), because a comment is not consent to be in a CRM. The contact panel shows the party (name, phone, email, from the kernel `party`, which CRM and Finance share), the identity, and the other conversations of that identity.
- **Names may be missing.** Meta gives a page-scoped id in messages; the profile name and picture need the Business Asset User Profile Access feature, which needs Advanced Access and review [C], and a phone-number Messenger account returns error 2018218 [C]. Comment webhooks list `from.name` in their fields [C] but whether it is filled is [U]. The screen shows "Facebook user ·1234" when there is no name. Zalo gives `display_name` and `avatar` on a user detail call [S] and the phone only if the user shared it [S].

### 5.5 Collision, assignment, availability

The Nest references (a "You are replying" marker, an availability switch, assignment) become:
1. **Assignment is the soft lock.** Opening a New conversation and starting a reply assigns it to the replier unless it is already assigned to someone else (then a banner names them).
2. **Composing marker.** While a person types, an R1 command `kernel.conversation.composing` (at most one per 20 seconds per conversation) upserts `conversation_composing` with a 60-second expiry; the stream drops an invalidation hint to the others who can read the conversation, and the list shows "Linh is replying". A sweep prunes expired rows.
3. **A hard check on send.** `kernel.conversation.reply` carries the id of the last message the sender saw. If a newer message (inbound, or another person's reply, including one sent from the platform's own inbox and seen as an echo) exists, it refuses with `CONVERSATION_MOVED`; the screen shows the new messages and asks again. This is the guarantee; the marker only prevents most clashes.
4. **Availability** is a per-member switch, shown in Service and used to decide whom to notify about an unassigned New conversation (the assignee if there is one, else the available members who can read it, else owners and admins). No automatic round-robin in v1.

### 5.6 Replies, drafts, saved replies

- A person writes, or picks a saved reply (placeholders for the contact's name only), or takes an AI draft and edits it; **a person presses Send**. The command is R2 (visible to customers); for a user it runs on the UI confirmation (the Send button) per the actor table in the kernel plan, with no approval step in v1 (Q4 is whether members' comment replies need one).
- An AI draft is written by an agent into `conversation_draft` (the only conversation table an agent may write, a one-line addition to ADR-0029's write allowlist, which is an invariant change for the security review). The agent's input is the thread, which is tainted external text, so the tainted-agent rule applies: "send tools hidden", the draft is only text, and a person sends it. No auto-reply to messages in v1.
- An agent never sends, hides or resolves.

## 6. How comments and messages arrive

### 6.1 One intake path

- A **public webhook route** per provider family, `POST /api/channels/:provider/webhook` (and, for Meta, the `GET` handshake `hub.mode=subscribe`, `hub.challenge`, `hub.verify_token` [C]), on the reasoned public route list (ADR-0028 enumeration, `route-coverage.test.ts`). It verifies the signature with the deployment's secret, refuses a body over a size limit, and **only parks** the verified body in `crove_kernel.conversation_inbound_pending` (a definer for the API login) before answering 200. As built in CV1 (#2303), it is a parking table and not a pg-boss queue: see the next bullet. It writes no tenant row and does no network call. Meta wants 200 within 5 seconds [C]; Zalo within 2 to 5 seconds [S] and does not retry on an error status [S].
- **Signatures.** Meta: `X-Hub-Signature-256`, HMAC-SHA256 of the payload with the app secret; Meta signs an escaped-Unicode form of the payload, so the check hashes that, not the raw bytes [C]. Zalo: `X-ZEvent-Signature: mac=<hex>` where the hex is `sha256(appId + body + timestamp + oaSecretKey)`; the middle input is ambiguous across sources and the key is the OA secret key, not the app secret [S, [U] until tested on a real event].
- A **worker job** `conversations.ingest` takes the body, finds the **connections from the platform's own account id** (a Page id, an Instagram account id, an OA id) with a definer for the worker login, and for each active connection of an active org runs `kernel.conversation.ingest` (system, through `Runtime.execute()`, R1). **The org comes from the stored connection, never from the notice** (the rule of [ADR-0039](../adr/0039-bank-feed-connectors.md)), so a forged notice cannot write to an org that has no such connection, and the HMAC stops a forged one for a real connection.
- **The body is stored from the webhook**, not re-read, with a difference from ADR-0039 that the data forces: Meta's webhooks have no history API and retry only for 36 hours [C], the Conversations API reads at most the 20 most recent messages [C], and Zalo does not retry on error [S]. So the signed event is the record; the polling job (6.3) is the safety net.
- **Idempotent and unordered.** `UNIQUE (org_id, channel_connection_id, external_message_id)`; a replay is a no-op. Meta does not guarantee order and batches up to 1000 updates [C]; Zalo may resend after an outage with the original timestamp [S]. Order by `sent_at`, store `received_at`.
- **The parked body is personal data**, so it is held only until it is stored, and never in a job. As built in CV1 (#2303) the intake follows ADR-0039's pattern of a pending table and a definer, not a pg-boss queue, because pg-boss keeps job data in its history and copies a failed job's data to the dead letter queue: the worker claims a notice under a lease (`conversation_inbound_claim`), stores its events with `kernel.conversation.ingest`, and deletes it (`conversation_inbound_done`) at once; an unreadable notice is deleted, a notice claimed five times without finishing is deleted with its body, and a notice still waiting after seven days is deleted too (a worker down that long would otherwise hold third parties' bodies indefinitely); a drop the database makes (a poison or an expired notice) is logged and alerted by id and count only, never by text; an unreadable one is logged by id only. The reply and reconcile jobs are pg-boss queues with ids only in their data and declare the platform hosts as their job egress (#1653).

### 6.2 Facebook Page (first)

| Need | What | Status |
|---|---|---|
| Comment events | Subscribe the Page to `feed` (item `comment`; verbs add, edited, remove, hide, unhide); the payload has `comment_id`, `post_id`, `parent_id`, `from` (id, name), `message`, `created_time`. Comments on ad posts do trigger it [C] | [C] |
| Message events | Subscribe to `messages` (and `message_echoes` to see what the Page itself sent, including from Meta's Page Inbox) [C]; the payload has the sender id, `message.mid`, text and attachments | [C] |
| Subscribe | `POST /{page-id}/subscribed_apps?subscribed_fields=...` with a Page token from a person with the right task, plus `pages_manage_metadata` [C] | [C] |
| Read comments (reconcile) | `GET /{post-id}/comments?filter=stream&order=reverse_chronological` with a Page token; comment ids on Page posts need MODERATE rights [C] | [C] |
| Reply to a comment | `POST {parent}/comments` with a Page token (MODERATE) and `pages_manage_engagement` [C]; the node page documents the create call only for videos | [C] edge, [U] node |
| Hide, unhide | `POST /{comment-id}` with `is_hidden` (Page comments only) [C] | [C] |
| Delete | `DELETE /{comment-id}` [C]; irreversible, so not in v1 | out of v1 |
| Reply to a message | Send API `POST /{page-id}/messages`, `messaging_type` RESPONSE inside the 24-hour window, or the `HUMAN_AGENT` tag up to 7 days for a person's reply [C]; whether HUMAN_AGENT needs its own approval is [U] | [C] / [U] |
| Private reply to a comment | `POST /{page-id}/messages` with `recipient.comment_id`, within 7 days, one per commenter, needs `pages_messaging`; further messages only after the person replies [C]. `can_reply_privately` on the comment says whether it is possible [C] | [C] |
| Permissions | `pages_manage_metadata`, `pages_read_engagement`, `pages_read_user_content`, `pages_manage_engagement`, `pages_messaging`, `pages_show_list`; each needs App Review, and Advanced Access plus Business Verification apply to other people's Pages [C] | [C] |
| Rate limits | Page-token calls 4800 x engaged users per 24 hours (error 80001 for the business-use-case limit); Send API 300 a second per Page for text; Conversations API 2 a second; errors 4, 17, 32, 613 are limits, 10 and 200 to 299 permission, 551 person unavailable [C] | [C] |
| Page Inbox | Meta's Page Inbox is "just another connected app" under the handover protocol, and an app that does not own a thread gets `standby` events [C]. Which app is the default owner when Ludy and Page Inbox both read a Page, and whether Ludy must `take` control, is [U] and the first thing the live check settles | [U] |
| Development mode | Customer events reach only people with an app role until Advanced Access; whether `feed` webhooks work in development mode for a Page the owner manages is [U] | [U] |

**Existing connections must be reconnected.** Social's Facebook connector asks for publishing scopes. The inbox needs more (above), so the connect screen gets an opt-in "also read and answer comments and messages" that adds them as optional scopes, and a connection without them shows Social exactly as today. A Meta use case for Messenger may need a different Meta app than the Pages one ([#2212](https://github.com/DOS/Ludy/issues/2212) already found that app types limit what an app can combine); the plan assumes the Pages app first and a separate **Messenger app** if Meta requires it (`CHANNEL_META_MESSENGER_APP_ID`, `CHANNEL_META_MESSENGER_APP_SECRET`, names fixed in the build issue) [U].

### 6.3 Reconcile (the safety net)

A `conversations.reconcile` job per connection: (1) re-subscribe the Page (an idempotent `POST subscribed_apps`; Meta unsubscribes an app after an hour of failed deliveries on Messenger [C]); (2) read comments of recent posts (hourly for posts under 7 days old, daily to 30 days) and store any not seen; (3) read the 20 most recent messages of recent conversations [C] and store any not seen. It runs within the Page-call budget above. A gap longer than the platforms' own memory cannot be recovered, and the screen says "events missed between X and Y" when a re-subscription had to be made.

### 6.4 Instagram (second)

Comments: webhook field `comments` (and `live_comments`), reply `POST /{ig-comment-id}/replies`, hide `POST /{ig-comment-id}?hide=true` [C]; delete only by the media owner [C]. Messaging: webhook `messages`, send `POST /{ig-id}/messages`, the 24-hour window and 7-day Human Agent tag, text up to 1000 bytes [C]; private reply within 7 days, one per commenter, landing in Requests if the person does not follow the account [C]. **Two login models** (Instagram API with Instagram Login on `graph.instagram.com`, with `instagram_business_manage_comments` and `instagram_business_manage_messages`; Instagram API with Facebook Login on `graph.facebook.com`, with `instagram_manage_comments` and `instagram_manage_messages`) [C]; webhooks need the app **Live** [C]; `messages` is not supported under plain Facebook Login [C]. Which model Ludy's existing Instagram connection uses decides the scopes to add (the build issue reads the connector). Profile by IGSID needs the person's consent, which a comment alone does not give [C].

### 6.5 Zalo OA (first, with Facebook; direct messages only)

| Need | What | Status |
|---|---|---|
| Webhook | An OA callback on an https domain; events `user_send_text`, `_image`, `_file`, `_sticker`, `_gif`, `_location`, `_link`, `_audio`, `_video`; `user_received_message` and `user_seen_message`; `follow`, `unfollow`; echoes `oa_send_*`. Payload: `app_id`, `event_name`, `timestamp` (string ms), `user_id_by_app`, `sender.id`, `message.msg_id`, `message.text`, `attachments[].payload.url`. Deduplicate by `msg_id`; re-sends at 30 s, 5, 15, 30 minutes and 1 hour after an outage | [S] |
| Reply | `POST https://openapi.zalo.me/v3.0/oa/message/cs` with `access_token`; text up to 2000 characters, one attachment per message; quote reply with `quote_msg_id` | [S] |
| Free window | A consultation message is free within 48 hours of the user's last interaction; sources conflict on charging after it and on a 7-day outer limit | [S], [U] |
| Plan | The OA needs a plan with API integration: Zalo's pricing page lists Standard, Growth and Comprehensive, with API only from Growth; out-of-window quota 500 a month (Growth) or 2,000 (Comprehensive), 55 VND per message beyond; API rate limit 100 or 2,000 a minute | [C] page, quotas [S] |
| History | `GET /v2.0/oa/listrecentchat`, `GET /v2.0/oa/conversation`; user detail `v3.0/oa/user/detail` (display name, avatar, `is_follower`, shared info); retention unknown | [S] |
| Comments | **No comment API or webhook found.** The only related field is an article's `comment` (`show` or `hide`) set at create or update | [S], "none found" is not proof |
| Errors | -216 token, -201 parameter, -223 quota, -32 rate limit, -213 not a follower, -232 blocked | [S] |

So v1 on Zalo is **direct messages only, in Service**; Zalo comments have no home until an API is found. Zalo's refresh token is single use, and the existing refresh sweep (hourly scan, 6-hour horizon) already handles it.

### 6.6 Later providers

TikTok (comments exist on its Display side; not researched), Threads replies, YouTube comments and WhatsApp: the same core and the same intake; each is an adapter capability (`readInbound`, `reply`) and a build issue of its own.

## 7. How replies go out

- `kernel.conversation.reply` writes a `conversation_message` (`out`, `send_state` queued) and an `external_call` row with the deterministic key `conversation.reply:<message>:<attempt>`, `started`, committed **before** the call, exactly as the publish pipeline does ([social.md](social.md) section 3.4). The worker sends; the adapter answers `accepted` (the platform's message id), `rejected` (typed: `token_expired`, `permission`, `bad_request`, `rate_limited` with a retry time, `transient`) or `unknown`.
- **Never a blind retry**: none of these send calls has an idempotency key, so a send is `reconcile_only`. An `unknown` outcome becomes `unknown` on the message and a reconcile reads the thread: for Messenger the `message_echoes` event for the Page carries the `mid` of what the Page sent [C]; for comments the comment list of the post; for Zalo the `oa_send_*` echo or the conversation history [S]. A person can resolve it by hand.
- **Window check before the send.** `reply_window_until` is computed from `last_inbound_at` (24 hours on Meta, 48 on Zalo [S]). Inside it, send. On Meta past it, only a person's reply with the HUMAN_AGENT tag up to 7 days [C, [U] for approval]; past that, the Send button is disabled with the reason. On Zalo past 48 hours a message may be charged against the OA's quota [S]; v1 refuses it with a message and does not send paid messages.
- **Rate limits and typed errors** as section 6.2 and 6.5; the channel layer's `rate_limited` result delays the job to the retry time. A `token_expired` result sets the connection `expired`, pauses sending, and alerts, as for publishing; inbound events already stored are not lost.
- **Comment replies** have the same pipeline with the comment id as the target; **hide and unhide** are R2 commands with the same pipeline, reversible; **delete** is out of v1.

## 8. Permissions

Kind decides who may read, because a public comment and a private message are different in what they expose.

| Action | Comment thread | Direct message |
|---|---|---|
| Read | owner, admin, member and viewer who may read the channel (the existing per-channel limit applies) | owner, admin, and members holding the `desk.agent` role (a new permission `conversation.direct.read`); the per-channel limit applies; viewers never |
| Reply, hide, resolve, assign, write a note | owner, admin, member who may read it (R2, user confirmation) | owner, admin, `desk.agent` role holders |
| Use an AI draft | those who may reply | those who may reply |
| Link or create a contact | those who may reply, and may edit parties | the same |
| Erase a contact's data (section 10) | owner, admin, R3 | owner, admin, R3 |
| Retention and saved-reply settings, connect the inbox scopes | owner, admin | owner, admin |

- **Roles.** `desk.agent` exists in `BUILTIN_ROLE_KEYS` and grants nothing yet; it gains the direct-message permissions. Social has no role key yet and uses the member rule it has today. The permissions are declared in the manifests, checked by `manifest-permissions.test.ts`, and enforced by the database (a restrictive policy on `kind = 'direct'` that asks the same role-assignment check the finance permissions use), not only in the screen.
- **The per-channel limit moves to the kernel.** Social's `channel_access` (one row per member and channel, #1081) is in `crove_social`, which the kernel cannot read, so the core cannot apply it. A build step copies it to `crove_kernel.channel_access` and Social reads it from there (a one-time migration, no behaviour change). Without it a freelancer limited to one client's channels would read every channel's messages.
- **Customer care roles for a freelancer or an agency:** the client-side reading of conversations is out of v1.

## 9. Tenancy, writes, audit, agents

- **One write path.** Every write is a command through `Runtime.execute()`: `kernel.conversation.ingest` (system, worker only), `reply`, `hide`, `assign`, `resolve`, `reopen`, `link_contact`, `note`, `composing`, `erase_contact`, `purge_expired`, `set_availability`, plus the draft write by an agent. The roles' direct SQL writes are zero.
- **No text in audit rows or activity.** Audit rows and the WORM stream cannot be erased later, so a command's audit target is the conversation and message ids and lengths, never a body or a name (the rule of ADR-0037). Activity rows carry ids only. Logs carry no bodies.
- **Taint.** Every inbound message and comment is tainted external text (`source_trust external`). An agent reading it gets the tainted-run rules: R1 writes go to review, send tools are hidden, and its only conversation write is a draft (section 5.6).
- **Agent allowlist.** Adding `conversation_draft` to the tables agent contexts may write is a deliberate change to ADR-0029's allowlist, an invariant test change the security review and the owner see.
- **Invariants to add** (each a test in the suite, written by the build issue that adds the table): cross-org and cross-entity RLS for every table; a direct message unreadable by a member without the permission and by a limited-channel member; a `conversation_message` body never in audit, activity, events or logs; ingestion writes only through the system command and only for a connection that exists; webhook routes on the public list and each verifying its signature before any enqueue; a notice cannot name an org.
- **Manifest classes** (#1599): body, display name, avatar and external user id are `pii`; phone and email on the party stay `contact`; the build issue checks the P04 rule for any command that writes a `contact` field.
- **Job egress** (#1653): `conversations.reply` and `conversations.reconcile` declare the platform hosts; the commands that feed them declare an external effect.

## 10. Personal data

Comments and messages are **personal data of third parties** under the PDPL (Law 91/2025, Decree 356/2025, as ADR-0037 cites them), and the org is the controller.

- **Retention.** An org setting, default **24 months after a conversation's last message** (Q5), after which a daily job deletes it (`kernel.conversation.purge_expired`, system), with the choices 6, 12, 24 months and "keep until deleted by a person". Notes go with their conversation.
- **Erasure on request.** `kernel.conversation.erase_contact` (R3, owner or admin) deletes an identity's messages, notes, drafts and attachments across both kinds, anonymizes the party link, and writes an audit row with ids only. It is the path a person's PDPL request takes, from the contact panel.
- **Platform removal.** When the platform tells us a comment or message was removed (a `remove` or `delete` verb on a Page comment [C]; Zalo's echo events [S]), the body is blanked and `platform_removed_at` set. Meta's terms require deleting platform data when the user asks or no longer has an account [C].
- **Meta's data deletion callback** (HTTPS `signed_request`, answered with a `url` and a `confirmation_code` [C]) is about the **app's users**, which here means the Ludy member who connected a Page, not the customers who messaged it. Receiving it disconnects that member's connections and **deletes the conversation data read through them** unless the org's owner keeps it by taking over the connection first. This is the cautious reading of Meta's rule; whether a business's own customer-care records fall under it is [U] and a legal read (the lawyer, through the owner) before Ludy Cloud serves other businesses. The same callback serves Ads ([ads.md](ads.md) section 9).
- **Disconnect** keeps the stored conversations by default as the org's service history, with a clear "delete too" choice, as for Ads (Q4 there).
- **Attachments.** Meta's attachment URLs and Zalo's media expire (Zalo keeps media 7 days [S]), so a customer's image must be downloaded when the message arrives. v1 stores **images up to a size cap** as kernel files through the egress guard, never rendered as HTML and never parsed by the extraction pipeline; videos, audio and files show "open on the platform" until a later slice. They are deleted with their message.
- **What is not stored:** the commenter's or sender's profile data beyond the name, picture and id the platform gives; no phone number unless the contact shared it and a person saved it on the party.
- **Export and purge:** conversations are tenant data, so the org export includes them (the export notes they hold personal data of third parties) and the org purge deletes them (a definer for the worker, like the other purges).

## 11. What each module shows

**Social** (group **Đăng bài**): the post page gets a **Bình luận** tab (the thread of each top-level comment, reply, hide, resolve, "reply privately", "send to Service"); a **Hộp bình luận** screen lists comments across posts (New, Pending, Resolved; filter by channel and post; saved replies; AI draft); counts on the post and the calendar chip. Facebook Page and Instagram only in v1; the existing comment counts stay.

**Service** (group **Hộp thư**): the three-pane view from the Nest reference. Left: the conversation list with New, Pending and Resolved tabs, a search box, a "Linh is replying" marker and unread dots. Middle: the thread, a reply box that names the channel and says "private message", the saved replies and the AI draft, a Resolve button, an availability switch. Right: the contact panel (the party, the identity, the other conversations, internal notes, link to contact, erase). Cases and SLA are Service's own later work and link to a conversation.

**Ads** (group **Quảng cáo**) as in [ads.md](ads.md). One shared component renders both inboxes, so the conversation screen is built once and each module passes the kind filter and the permission.

## 12. What the owner sets up

All of this is an `owner-action`: no agent creates a developer app, signs in or submits a review.
- **Meta:** the Page permissions of section 6.2 added to the app (or a Messenger app if Meta requires one), the Messenger and Instagram webhooks pointed at the deployment's callback URL, and, for Ludy Cloud serving other businesses, App Review of `pages_messaging`, `pages_read_user_content` and `pages_manage_engagement` with Business Verification. The app must be Live for Instagram webhooks [C]. Development mode with app-role users works for the owner's own Page [C for Messenger and Instagram events, [U] for `feed`].
- **Zalo:** the OA on a plan with API integration, the callback URL and OA secret key set in the Zalo app, and the app's permissions for messages.
- **Legal:** a lawyer's read of Meta's rule on stored customer messages and the retention default, before Ludy Cloud (the owner arranges).

## 13. Build issues (not opened; each end to end, with acceptance)

Priority P2 for CV1 to CV5, P3 after; the milestone is the Marketing line's current one, set by the PO when the owner approves. Each protected-path piece (migrations, kernel, public routes) gets the independent security review.

| Id | What a user sees | Acceptance |
|---|---|---|
| **CV1** Core, sandbox, comments in Social | On `docker compose up`, the `sandbox` channel produces comments on a post; a member opens the post's **Bình luận** tab, replies, hides, resolves, assigns, adds a note; the comment inbox lists them | Kernel migration and manifest for the tables of section 5.2 (comment kind and the shared tables); `ingest`, `reply`, `hide`, `assign`, `resolve`, `note`; the `external_call` reply pipeline with a killed-worker test (no double send); RLS matrix rows; redaction test; the per-channel access moved to the kernel with Social unchanged; Playwright covers reply and resolve |
| **CV2** Facebook Page comments, live | A real Page's comments appear within seconds and a reply shows on Facebook | Webhook route (signature, enqueue only, public list), connect opt-in scopes, subscribe and reconcile jobs, reply and hide adapters, recorded-answer tests with Meta's payloads, a live-check runbook like [social-live-check.md](../runbooks/social-live-check.md) (the live run is the PO's with the owner); [U] items settled |
| **CV3** The Kênh app and the Service inbox on the sandbox | The rail shows one app with the groups of the enabled modules; Service shows the three-pane inbox for sandbox direct messages with New, Pending, Resolved, assignment, availability, "is replying", contact panel, notes, saved replies | App id rename and menu messages; the shared conversation component; the direct kind and its read permission (`conversation.direct.read`) enforced in the database; `composing` and `CONVERSATION_MOVED`; tests for collision and the permission |
| **CV4** Messenger direct messages, live, and reply privately | A real customer message appears in Service, a person answers it, and "reply privately" on a comment starts a conversation that Service shows | `messages` and `message_echoes` webhooks, Send API with window rules and HUMAN_AGENT, private reply, echo-based reconcile, the Page Inbox ownership question settled, a live-check runbook |
| **CV5** Zalo OA direct messages, live | A Zalo OA chat appears in Service and is answered within the free window | Webhook route with the OA signature (formula tested against a real event), `message/cs`, window and plan errors mapped to clear messages, history on reconnect, a live-check runbook |
| **CV6** Retention, erasure and the deletion callback | The owner sets a retention, a person's data can be erased from the contact panel, Meta's callback disconnects and purges | `purge_expired` job, `erase_contact` (R3), callback route with `signed_request` verification, org purge and export cover the tables, audit rows with ids only, test that no body reaches audit or logs |
| **CV7** Instagram comments and direct messages | Instagram comments in Social, DMs in Service | After the connector's login model is read; webhook `comments` and `messages`, reply, hide, private reply, live-check runbook |
| **CV8** AI reply drafts and saved replies | A draft appears in the reply box, tainted, and a person sends it | `conversation_draft`, the ADR-0029 allowlist addition, `SocialWriter`-style drafting in `packages/agent`, tests that an agent cannot send |
| **CV9** Send to Service as a case, and Service-only comments filter | Depends on Service's tickets and Q2 | Later |

**Order** (Q7): CV1, CV2, CV3, CV4, CV5, CV6, then CV7 to CV9. Zalo can move ahead of Messenger if the owner prefers it. **No live channel (CV2, CV4, CV5) handles a real customer's messages before CV6 is accepted**: until retention, erasure, export and purge exist, those channels run only on the owner's own Page and OA with test accounts, and CV6 can be built in the same sitting as CV2 if the owner wants a customer earlier.

### CV5 as built (#2304)

- The webhook is `POST /api/channels/zalo/webhook` (one URL for every org, nothing in it names an org), enabled by `CHANNEL_ZALO_OA_SECRET_KEY` beside the Zalo app's id and secret. It checks `X-ZEvent-Signature` over the raw body before anything else, caps the body at 64 KiB before reading it, answers every refusal of the signature with the same 401, parks only a verified message (a follow, a delivery or a seen mark is answered 200 and not parked), and writes no tenant row; the worker finds the org from the stored connection by the OA's id.
- A reply is `oa/message/cs` v3.0 through `ZaloConversations`, once, inside the 48-hour window counted from the customer's last message by the platform's own time (`zalo_oa` in `CONVERSATION_PROVIDER_RULES`); Zalo's errors are typed and worded (`conversationError`). An attachment is a placeholder naming its kind. The signature formula, the payload shapes, the window and the error codes stay [S] or [U] until the live check settles them, each read in one place; the facts, their files and the OA secret key's handling and rotation are in [the runbook](../runbooks/zalo-conversations-live-check.md).
- Not in CV5: history on reconnect and the "events missed" marker, customers' images stored as files, and the customer's name and picture: issue CV5b (#2329).

### CV1 as built (#2303)

What differs from the table above, each for a reason found while building:
- **Tables.** CV1 builds `conversation`, `conversation_message`, `conversation_identity`, `conversation_note`, `conversation_read` and the moved `channel_access`. `saved_reply` moves to CV8 (its screens), `conversation_composing` and `member_availability` to CV3 (the commands that use them), so no table ships unused.
- **Rows are org-level.** A channel connection belongs to no legal entity yet, so a conversation does not carry `legal_entity_id`; the channel limit and the kind rule are the policies (`crove_kernel.conversation_access`). Follow-up: `legal_entity_id` and its `le_scope` policy come with the issue that gives connections an entity.
- **The permission is `kernel.conversation.direct.read`** (a manifest permission is prefixed by its module, and the conversation core is the kernel's). No role holds it yet: CV3 seeds it for `desk.agent` (the roles invariant lists the seeded permissions, so that is a two-step change), and until then a private message is read only by owners and admins, so a live Zalo channel (CV5) is safe before the Service inbox exists. The policy is tested now with the permission seeded as a fixture.
- **Hide and unhide** are idempotent calls (`hide_request`, `hide_attempt` on the message), so a job may repeat them; a reply is never repeated after an unclear answer.
- **No activity rows** for assign or resolve yet: an activity row is read by every member of the org, which would show a private message's existence to a member who may not read it. CV3 decides it with the permission.
- **Real-time** is a short poll (six seconds) in the screens; stream hints for conversations wait, since a hint reaches every member of the org.

## 14. Edits to existing documents (in the same PR)

- [social.md](social.md) "Not in Social" now says: comments on the org's own posts are read and answered in Social (this plan), private messages stay in Service, both on one conversation core in the kernel.
- The kernel plan's Service and Social paragraph (section 5.7) says: comments in Social, private messages in Service, one core underneath. The module table row for Service, the Phase 4 scope line, the Phase 5 line and the fork table row are updated to match. ADR-0041 is added to the ADR index.

## 15. Risks

| Risk | Mitigation |
|---|---|
| App Review, Business Verification and Advanced Access block Ludy Cloud (Meta), and the Messenger use case may need its own app | The owner's own Page works in development mode; sandbox first (CV1, CV3) shows the product with no review; reviews start after the owner agrees |
| Lost events (Meta retries 36 hours, Zalo none on error, history reads 20 messages) | Reconcile job, resubscription, a visible "events missed" gap marker |
| Two people answer one customer | Assignment, composing marker, hard check on send |
| Personal data of third parties in the kernel, in a job queue, in logs | Short queue retention, no bodies in audit, activity or logs, classes in the manifest, erasure and retention (section 10) |
| A prompt injection in a message steers an AI draft | Tainted input, drafts only, a person sends, no agent send |
| A freelancer limited to some channels reads other channels' messages | Per-channel access moved to the kernel and enforced by the database |
| Zalo docs are unreadable and facts are secondary | Every Zalo item is tagged [S] or [U]; the live check confirms the signature, windows and plan behaviour before the build is called done |
| Platform price or policy changes (Zalo quotas, Meta tags: three message tags stopped working on 2026-04-27 [C]) | Window rules in static capability data per provider, recorded-answer tests |
| The kernel grows | Only the shared store is in the kernel; the screens and provider rules stay in modules and `@crove/channel` |

## 16. Questions for JOY

Nothing is built until the owner approves. Each question: what is decided, why it matters, the options, my recommendation, and what happens without an answer. One at a time, the first one first.

**Q1. Layout: one rail app with groups, or separate rail items?** (Who acts: JOY, with the Frontend line for the name.) It decides how the app looks to every customer and one rename in the shell.
- **A. One rail app with three groups: posting, inbox, ads, each shown only when its module is enabled (recommended).** The shell already works this way; short rail for an SME; Hootsuite itself holds Ads inside its publishing product.
- B. Separate rail items for Social, Service and Ads, like Hootsuite's rail. Matches the screenshot, but a longer rail and a context switch between a comment and the private reply it started.

Without an answer: A, with the working name "Kênh".

**Q2. Should a comment also appear in the Service inbox?** (Who acts: JOY.) It decides whether care teams see comments.
- **A. No: comments only in Social, with "reply privately" and "send to Service" bridges (recommended).** Your decision as written; one place per item.
- B. Also show comments in Service as a filter, only when Social is not enabled. A Service-only org then sees comments; a small screen change.
- C. Always show comments in both. Two unread counts and two people answering the same comment.

Without an answer: A.

**Q3. What is the app called?** (Who acts: JOY with the Frontend line.) It decides the rail label and the menus. Options: **Kênh** (recommended, short, "channels"), Ludy Channels, a name per customer type. Without an answer: "Kênh" as a working name, changeable later because it is only a label.

**Q4. Do members' public replies to comments need approval?** (Who acts: JOY.) It decides whether replying in the org's name is as fast as in Hootsuite or as controlled as publishing.
- **A. No approval in v1: a member who may read the channel can reply; an AI draft always needs a person to press Send (recommended).** Speed matters in care; owners can limit a freelancer to some channels already.
- B. Replies by members need an owner or admin approval, like posts. Safer for agencies, slow for one-person companies.

Without an answer: A.

**Q5. How long are comments and messages kept?** (Who acts: JOY, a lawyer for the legal side.) It decides storage and what the privacy page promises.
- **A. 24 months after the last message, the owner can choose 6, 12, 24 or keep (recommended).** Long enough for a dispute, short enough to be defensible.
- B. 12 months. Smaller exposure, less history for care.
- C. Keep until deleted by a person. Simplest, the largest pile of third parties' personal data.

Without an answer: A, and a lawyer reads Meta's rule on stored customer messages before Ludy Cloud.

**Q6. Zalo OA messaging needs the customer's paid OA plan with API integration. Accept that?** (Who acts: JOY.) It decides what Ludy tells Zalo customers.
- **A. Yes: show a clear message "your OA plan has no API integration" and document the plan (recommended).** It is Zalo's rule; nothing in Ludy can lift it.
- B. Delay Zalo until its pricing is confirmed on an official page the build issue can read.

Without an answer: A, and the live check confirms the plan names and quotas.

**Q7. In what order do we build?** (Who acts: JOY.) It decides what you can try first.
- **A. Core and comments on the sandbox, Facebook Page comments, the app and Service inbox on the sandbox, Messenger, then Zalo, then retention (recommended).** You see comments in Social first, as decided; each step runs without any platform review.
- B. Zalo OA messages before Messenger, because Zalo is Vietnam's first channel. Needs the Service inbox first (CV3), so the first visible result is later.

Without an answer: A.
