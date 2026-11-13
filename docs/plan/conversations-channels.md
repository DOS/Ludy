# Hộp thư channels: WhatsApp and the popular messaging channels

> Plan for [#3128](https://github.com/DOS/Ludy/issues/3128), 2026-11-13. Owner decision of 2026-11-13 (the Engage PO's chat, JOY): "Làm whatsapp và tất cả các channel phổ biến đi" (do WhatsApp and every popular channel): Hộp thư takes WhatsApp and the popular channels, not only Messenger, Instagram, Zalo OA and email. This extends [conversations.md](conversations.md) section 6.6 "Later providers" and [ADR-0041](../adr/0041-conversation-core.md). **It is a plan: nothing here is built, no account was created, no credential was used and no platform API was called.** Vietnamese summary for the owner: [conversations-channels.vi.md](conversations-channels.vi.md). The build issues are #3131 to #3135, listed in section 9.

## 1. The answer in one table

Ranked for Vietnamese one-person companies and SMEs ("fit" is how much of their weekly work the channel is), with what stands in the way. The build order (section 9) follows feasibility, not fit alone.

| Rank | Channel | Fit for a Vietnamese OPC or SME | Official API for an inbox | Gate | Who pays | Verdict | Priority |
|---|---|---|---|---|---|---|---|
| 1 | **WhatsApp Business (Cloud API)** | Medium at home, high for exporters, tourism and foreign customers; Zalo and Messenger still lead in Vietnam by reach [S] | Yes: messages in and out, webhooks | A WhatsApp Business Account and a number; Meta business verification and App Review for Ludy Cloud serving other businesses [S] | The business, to Meta, on its own account; free-form replies inside 24 hours are free [S] | **Build** (owner decision) | P1 |
| 2 | **Marketplace buyer chat** (Shopee, Lazada, TikTok Shop) | Very high for hộ kinh doanh that sell on marketplaces | Not confirmed for Shopee and Lazada; TikTok Shop lists customer service endpoints [S] | Partner registration (owner decision #2523), a data security review, buyer data masked and kept about 90 days | Not known; no fee was seen | **Not now**: revisit after #2523 and a seller's own-app trial #2522 (section 8) | none yet |
| 3 | **TikTok** (comments and direct messages) | High: sellers live on TikTok | Business Messaging API for direct messages [S]; comment list for business accounts not found, reply create seen only in an unofficial SDK [S] | API access approval; account region rules [S] | The business's own TikTok Business Account; no per-message fee found [U] | **Build, access-gated** | P2 |
| 4 | **Telegram** (bot chats, then Telegram Business) | Low to medium; strong in some communities, trading and tech | Yes: Bot API, webhook with a secret header | None for a bot; Telegram Premium on the owner's own account for Business mode [S] | Free for the business; Ludy never turns on paid broadcasts [O] | **Build** | P2 |
| 5 | **Threads** (replies) | Low to medium; cheap because it reuses Meta's machinery | Yes: read and manage replies on the business's own posts [O] | New scopes, so a reconnect | Free | **Build** | P2 |
| 6 | **YouTube** (comments) | Medium for creators and product-video sellers | Yes: Data API v3 comments, no push found [U] | Quota: 10,000 units a day per project [O]; a quota extension for Ludy Cloud | Free inside the quota | **Build** | P2 |

Left out, with reasons, in section 8: Zalo personal accounts, Viber, LINE, SMS, Instagram and Facebook (already built), email (built), Telegram groups, WhatsApp templates and marketing broadcasts.

**Nothing in this plan costs Ludy money per message.** Every channel runs on the business's own account with the platform. The one place Ludy's own money could be touched is the AI model call behind a draft, which already goes through the AI budget meter (section 3). A paid thing the plan avoids on purpose is named in each channel: WhatsApp template sends, Telegram paid broadcasts, Zalo's out-of-window messages.

## 2. How facts are tagged, and what this pass could not read

The tags of [conversations.md](conversations.md) are kept ([S], [U]); [C] is replaced by two tags that say honestly what was read.

- **[docs]** the official page was opened and read. **No fact in this plan carries it.** On 2026-11-13 this session's network policy denied the official documentation hosts (`developers.facebook.com`, `core.telegram.org` and `developers.google.com` were tried and refused; the other platforms' hosts were not tried after those three failed). The PO was told. The first step of every build issue is to read the platform's page and upgrade the tags of its section, changing the plan where the page differs. **WhatsApp (#3131, 2026-11-13):** the build session tried `developers.facebook.com` again and the host did not resolve from its container (outside the network allowlist), so the read was not done, nothing in section 4.1 became [docs], and the channel was built from this plan with every [M], [S] and [live] row left to [the live-check runbook](../runbooks/whatsapp-conversations-live-check.md).
- **[O]** an official page was among the search results and the answer quoted it, but the page was not opened. Better than [S], not [docs].
- **[S]** only secondary sources (vendor documentation, SDK documentation, blogs) seen in this pass's search results, usually several that agree. Never a rule in the software until the live check confirms it.
- **[M]** recalled by the author from earlier knowledge of the platform and **not seen in any source of this pass**. Treated as [U] until the page is read; it is the least certain tag, used for field names and call shapes.
- **[U]** not found, or sources conflict.
- **[live]** the fact the live check (section 7) must confirm on a real account before the channel is called done.

Every number below is static capability data per provider (`CONVERSATION_PROVIDER_RULES`, section 3), so a changed rule is a one-line change, not a redesign.

## 3. What every channel reuses (no new tenancy model)

All six channels are **providers** of the conversation core. Nothing about tenancy, permissions, retention, erasure or the reply pipeline changes.

| Part of the core | What a new channel does with it |
|---|---|
| `crove_kernel.conversation`, `conversation_message`, `conversation_identity` ([conversations.md](conversations.md) section 5.2) | A direct channel (WhatsApp, Telegram, TikTok messages) is `kind = direct`; a comment channel (TikTok comments, Threads, YouTube) is `comment_thread`, one conversation per top-level comment. The platform's account id is the connection's `external_account_id`; the customer's id is `conversation_identity.external_user_id` (class `pii`) |
| `channel_connection` and sealed credentials (ADR-0025) | One connection per account (a WhatsApp number, a Telegram bot, a Threads profile, a YouTube channel). The org is found from the stored connection, never from the notice (ADR-0039) |
| Intake: parked body, then worker (`conversation_inbound_enqueue(provider, body)`, [conversations.md](conversations.md) section 6.1) | The route verifies the platform's signature or secret over the raw bytes before anything else, caps the body, parks it and answers 200. The intake table takes any provider name (the cap is per provider), so no migration is needed for it; each provider adds a parser in `packages/channel/src` that turns a verified body into `ConversationNotice` events, as `parseZaloNotice` and `parseFacebookNotices` do |
| Reply: `kernel.conversation.reply`, the `external_call` row, send exactly once, never a blind retry | Each provider adds a `ConversationAdapter` (`reply`, and `hide` or `history` where the platform has them) and a rules entry. No send call below has an idempotency key, so every send is `reconcile_only` or, where the platform offers no way to ask, an `unknown` outcome a person resolves |
| `CONVERSATION_PROVIDER_RULES` (`packages/kernel-contract/src/conversations.ts`) | One entry per provider: `kinds`, `replyMax`, `canHide`, `windowHours`. The window check, the disabled Send button with its reason and the draft rules read it |
| Attachments (CV5c: a row bound to its message, 5 MiB cap, type read from the bytes, never HTML) | Images only in v1 on every channel; anything else is a placeholder line. A channel whose media needs a token (WhatsApp, Telegram) fetches through the connection's sealed credential inside the job, never from a stored address (section 4.1) |
| Retention, erasure, export, purge (CV6, built) | Provider-neutral by construction (they work on the tables), so a new channel needs only a test that its rows are covered. **CV6 is accepted, so a live channel may handle a real customer's messages** once its live check passes |
| Saved replies, `{tên}` placeholder, intent sorting, contact match, reply drafts (CV3, CV8, #3102) | Unchanged and provider-neutral |

**The AI part, the same on every channel (AGENTS.md "AI part named").** Dy, the Engage coworker in Hộp thư, works on the new channel exactly as on Messenger and Zalo: a **reply draft** written by the system context from the tainted thread text (`ConversationWriter` in `packages/agent`, `metered('conversation.draft', ...)` under the AI budget meter; the org's `auto_draft` switch governs the automatic drafts of new conversations, while a draft a member asks for is theirs to ask, as built in CV8), the **saved replies** matched without a model, the **intent label** suggestion and the **likely contacts** list. A draft stays inside the channel's `replyMax` and window, never invents a price or a link, and **a person presses Send**; an agent never sends, hides or resolves, and with AI off the inbox works as before. Each build issue's acceptance names this for its channel.

**The small core changes a channel may need** (each named in its build issue, so no hidden work):
1. a `whatsapp` entry in `CHANNEL_PROVIDERS` (the others exist);
2. a rules entry in `CONVERSATION_PROVIDER_RULES` per provider;
3. a route and a parser per provider that pushes (WhatsApp, Telegram, Threads, TikTok); a reconcile read per provider that polls (YouTube, and the safety net of Threads and TikTok);
4. an opt-in "also read and answer" on a connection that already exists for publishing (Telegram, TikTok, Threads, YouTube), with the extra scopes, as Facebook has;
5. the intake's media cap and host list per provider, and for WhatsApp and Telegram a fetch that uses the sealed token.

## 4. Channel by channel

### 4.1 WhatsApp Business, Cloud API (build, P1)

**Why first.** The owner asked for it, it is the best-known messenger for foreign customers, and it is the cheapest to build well: it is Meta's own platform, so it reuses the Facebook intake (the `X-Hub-Signature-256` check `metaSignatureOk`, the verify-token handshake, the 24-hour window and the `reply_window_until` rule). It also gives the customer's phone number in every message, so the contact match by phone (`crove_kernel.phone_key`) works for the first time without a model. Honest limit: in Vietnam Zalo is first (about 78 million monthly users by Zalo's own figure [S]) and Messenger second by reach [S]; WhatsApp is behind them for Vietnamese consumers, though a 2025 traffic report ranks it second among messaging services and it rose in app downloads when Zalo's new terms came out [S]. It earns its place for businesses with foreign customers and for those who want a second door.

| Need | What | Tag |
|---|---|---|
| Account | A WhatsApp Business Account (WABA) in a Meta business portfolio, with a phone number registered to the Cloud API. A number registered to the API cannot also run in the WhatsApp Business app unless it is onboarded with **coexistence** | [S] |
| Coexistence | A number can stay in the WhatsApp Business app and also use the API, onboarded through Meta's Embedded Signup (version 4 is current; version 2 was to be retired on 2026-10-15 [S]). The app and the API share the number but not billing or the window state; one vendor quotes 20 API messages a second for such a number | [S], [live] |
| Who connects, v1 | The business, by hand: a System User access token for the WABA with the messaging and management permissions, the **phone number id** and the WABA id, pasted into the connect screen and sealed. The connection's `external_account_id` is the **phone number id** | [M], [live] |
| Who connects, later | Embedded Signup inside Ludy, so a business signs in with Meta and picks its number. Needs Ludy registered with Meta as a Tech Provider or similar, which is an owner action with Meta business verification and App Review (time, not money) | [U] |
| Webhook handshake | `GET` with `hub.mode=subscribe`, `hub.verify_token`, `hub.challenge`: compare the token in constant time, answer the challenge as text | [S] |
| Webhook signature | `POST` with `X-Hub-Signature-256: sha256=<hmac>`, HMAC-SHA256 of the **raw bytes** with the Meta app's secret (the guides stress hashing the raw bytes, not re-serialised JSON). Same check as Messenger's | [S], [live] |
| Webhook route | `POST /api/channels/whatsapp/webhook` and its `GET`, on the public route list; its own verify token and app secret (`CHANNEL_WHATSAPP_*`, names fixed in the build issue), because the WhatsApp product's callback is set apart from the Page app's and may be a different Meta app | [U] |
| Subscribe | Subscribe the app to the WABA's `messages` field (`POST /{waba-id}/subscribed_apps`) and set the callback in the app dashboard | [M] |
| Payload | `object = whatsapp_business_account`; `entry[].changes[].value` with `metadata.phone_number_id`, `contacts[].profile.name`, `wa_id` and `user_id`, `messages[]` (`id` starting `wamid.`, `from` and `from_user_id`, `timestamp` as seconds in a string, `type`, `text.body`), and `statuses[]` (`sent`, `delivered`, `read`, `failed` with an error; `recipient_id` or `recipient_user_id`) | [docs] for the user identifiers (messages webhook reference, "User identifiers", read 2026-11-13), [M], [live] for the rest |
| Delivery and retries | Meta retries a failed delivery; the window and the counts are not confirmed, and Messenger's 36 hours is the only figure on file | [U] |
| Message types | `text`, `image`, `audio`, `video`, `document`, `sticker`, `location`, `contacts`, `interactive`, `button`, `reaction`. v1 stores text; images become attachments; every other type is a placeholder line ("[Khách gửi vị trí]") and a reaction opens nothing | [M] |
| Reply | `POST /{phone-number-id}/messages` with `messaging_product: whatsapp`, `to`, `type: text`, `text.body`, optional `context.message_id` to quote; the answer carries the new `wamid`. Text bodies are limited to 4096 characters (`replyMax`) | [M], [live] |
| Window | A customer's message opens a 24-hour window and each new customer message resets it; inside it any free-form message may be sent, outside it only an approved **template**. A free-form message outside the window fails with error **131047**; a message accepted just before the window closes can still fail later | [S], [live] |
| Windows set by ads | Whether a message that starts from a Click-to-WhatsApp ad opens a longer window is not confirmed; the rules table keeps 24 hours until the live check says otherwise | [U] |
| Templates | Business-initiated messages need an approved template, billed per delivered message by category and country; **out of v1** (section 8) | [S] |
| Limits | Business-initiated sends are capped per portfolio by tier (a start of 250 unique customers a day on a new account, tiers above); **replies to a customer who wrote first are not counted** [S]. Throughput per number: the usual quoted figure is not confirmed. A per-user marketing limit has its own error, 131049 [O]. Not a limit v1 can hit | [S], [U] |
| Media in | Inbound media arrives as a **media id**. `GET /{media-id}` returns a short-lived URL; the URL must be fetched with the access token and **expires after 5 minutes**; the id itself is downloadable for **7 days** [O]. Upload ceiling 100 MB [O]; per-type limits [U] | [O], [live] |
| History | No history endpoint for the Cloud API was found; coexistence offers a history sync at onboarding [S]. So there is **no safety net** beyond Meta's retries: a message missed while the webhook was down is not recoverable, and the screen cannot show a gap | [S], [U] |
| Echoes | A message a person sends from the WhatsApp Business app on a coexistence number reaches the API as a separate echo event; the name of the field is not confirmed | [U], [live] |
| Customer name | Arrives in the webhook (`profile.name`), so no profile call is needed | [M], [live] |
| Customer id | `wa_id`, the customer's phone number in digits, when the notice has it. It is the identity (`pii`) and the deterministic contact match. A customer who has adopted a WhatsApp username comes with a **business-scoped user id** (BSUID: `contacts[].user_id`, `messages[].from_user_id`, shaped like `US.13491208655302741918`) and **may come without a phone number**; Meta requires an integration to handle it. The identity is then the BSUID, the phone match finds nothing, and a reply goes to it with `recipient` in place of `to`. A customer first seen by BSUID and later by phone is two threads (no link is stored yet) | [docs], read 2026-11-13 |

**Design on the core.**
- `provider = whatsapp`, `kinds: ['direct']`, `replyMax: 4096`, `canHide: false`, `windowHours: 24`. `reply_window_until` is `last_inbound_at + 24 h`; past it the Send button is disabled with the reason, as on Zalo, **and Ludy does not send a template** (a paid message the business did not mean to buy).
- The adapter has `reply` only. The status webhook maps `failed` to the message's `send_state = failed` with the error code worded for a person; `sent`, `delivered` and `read` are answered 200 and stored nowhere, as Zalo's seen mark.
- An `unknown` send outcome stays `unknown` (no history to reconcile against), shown as "was sent" only, never re-sent by a button.
- Inbound image: the pending attachment row names the **media id** instead of an address, and the worker resolves it with the connection's token in two calls (the URL, then the bytes) inside the 5-minute life of the URL. The job carries ids only; the token never leaves the sealed credential. The Meta media hosts go in the allowlist [live].
- **Contract change this needs** (the build issue's, shared with Telegram): today an inbound image is `{ kind: 'image', url }` with an https `url` (`zConversationEventImage` in `packages/kernel-contract/src/conversations.ts`, `InboundConversationEvent.attachments` in `packages/channel/src/conversation.ts`) and the pending `conversation_attachment` row keeps that address in `source_url` until the bytes are stored. A provider whose media needs a token gets a second shape, `{ kind: 'image', mediaRef }` (exactly one of `url` or `mediaRef`), a provider-scoped reference (the WhatsApp media id, the Telegram `file_id`) that is not a URL and holds no token; the reference travels in the parked notice and the ingest event only until the row is made, exactly as the address does today, and the pending row stores it in the same `pii` column, or a sibling one, under the same rules (cleared when stored, deleted at six days; never in a job's data, an emitted domain event, an audit row or a log); and the fetch job asks the provider's adapter to turn the reference into bytes with the sealed credential instead of fetching a stored address. No token-bearing URL is ever persisted. This is a migration and a protected-path change, so it gets the security review.
- Phone privacy: `wa_id` is the customer's phone number, so it is class `pii`, never in an audit row, a job, an event or a log; the party is still never created automatically.

**What a person sets up** (owner action, no agent signs in): section 6. **Who pays**: the business pays Meta from the payment method on its own WABA, and Ludy pays nothing per message. From 2026-10-01 a free-form reply inside the 24 hours is a Meta "service message": each business phone number has 1,000 free service messages a month (no roll-over), Meta charges the business's own account from the 1,001st delivered one, a reply inside a Click-to-WhatsApp free entry point window (up to 7 days) is free, and a Messaging account with no payment method stops being delivered to after the 1,000 [docs: Meta's pricing page, "Free tier of monthly service messages", read 2026-11-13]. So a business with a lot of WhatsApp traffic pays Meta for the replies beyond 1,000 a month per number, and a business with no payment method loses delivery after them; the connect screen says so in plain words (vi and en). The status webhook's `pricing` object (`billable`, `category`, `type`) says whether a reply was charged; Ludy does not record it yet. Reading the business's own billing page after the test stays a [live] check.

**Built in [#3131](https://github.com/DOS/Ludy/issues/3131)** (what the code does, so the live check reads one place for each fact; the runbook [whatsapp-conversations-live-check.md](../runbooks/whatsapp-conversations-live-check.md) has the rows):
- `whatsapp` in `CHANNEL_PROVIDERS` (it has a publish queue like every provider but never publishes; the connections list leaves it out of every Social picker unless a screen asks with `includeMessaging`); the connection is made by hand on the Channels screen (`channels.connectWhatsApp`: the token is checked once against the phone number, then sealed with the phone number id as `external_account_id`).
- Settings, all optional and none with a value in the repository: `CHANNEL_WHATSAPP_APP_SECRET` (the Meta app's secret: the webhook signature and the Graph `appsecret_proof`), `CHANNEL_WHATSAPP_VERIFY_TOKEN`, `CHANNEL_WHATSAPP_APP_SECRET_PREVIOUS` (rotation), `CHANNEL_WHATSAPP_MEDIA_HOSTS`.
- Route `GET` and `POST /api/channels/whatsapp/webhook` (public list): the handshake, then `X-Hub-Signature-256` over the raw bytes (`metaSignatureOk`), a body cap, a replay window, the park in `conversation_inbound_pending` (`whatsapp`) and 200. The parser (`parseWhatsAppNotices`) turns a customer's text and an image (by media id) into direct events under the `wa_id`, every other type into a placeholder line, a reaction and a system notice into nothing, and a status `failed` into an outbound event with a coded error (`deliveryFailed`); `sent`, `delivered` and `read` store nothing.
- Rules: `kinds: ['direct']`, `replyMax` 4096, `canHide` false, `windowHours` 24. Past the window the reply box says why and offers no Send; the adapter also refuses a stale call without asking Meta. No template and no business-initiated send exists in the code.
- Reply: `POST /{phone-number-id}/messages`, typed errors (131047 window, 131030 recipient, 131026 undeliverable, rate limits, permission, token), an `unknown` outcome stays `unknown`: **`reply_settle` refuses a resend of an unclear WhatsApp message** (a person looks on the phone and marks it sent).
- Media: the contract change of this section is `{ kind: 'image', mediaRef }` beside `{ kind: 'image', url }` (exactly one) in the event and the notice type; the pending row keeps the id in the new `conversation_attachment.source_ref` (class `pii`, check: a token of letters, digits and `._:=-`, never a URL; at most one of `source_url` and `source_ref`), cleared when stored, deleted at six days or five tries, left out of the export; the fetch job opens the sealed token and asks the adapter's `media` call, which makes the two Meta calls inside the job, and every byte of the second one goes through the egress guard (the media hosts only, https, no redirect followed, the token sent to the first host only). No token-bearing address is stored anywhere.
- The contact match by phone uses the `wa_id` when it is digits; Dy's drafts, the saved replies, the intent label and the contact list are the core's and unchanged.
- **Customers with a username (BSUID)**: the parser falls back to `contacts[].user_id` / `messages[].from_user_id` as the thread id when the notice has no phone number, matches several customers in one notice to their own contact, and reads a failed status's `recipient_user_id`; the adapter sends to a BSUID thread with `recipient` and no `to` (a phone thread keeps `to`). Read 2026-11-13 on Meta's pages (pricing, messages webhook reference, business-scoped user IDs, webhooks overview: failed deliveries are retried for up to 7 days): the handshake, the signature, the payload fields, the 24-hour window with error 131047, the text body limit and the media flow agree with this section; `subscribed_apps` for an own app and the media host names stay [live].

### 4.2 Telegram (build, P2)

**Why.** No review, no fee, a plain HTTPS webhook with a secret header; Ludy already holds a Telegram connection (a bot token, for publishing to a channel). A business answers its customers in the same bot it posts with.

| Need | What | Tag |
|---|---|---|
| Account | A bot made in @BotFather (the token) | [M] |
| A customer reaches the business | By opening the bot (`t.me/<bot>`) and writing. **A bot cannot start a conversation**; it can answer a user who wrote or pressed Start | [M], [live] |
| Webhook | `setWebhook` with `url`, `secret_token` (1 to 256 characters of `A-Z a-z 0-9 _ -`) and `allowed_updates`; Telegram then sends `X-Telegram-Bot-Api-Secret-Token` on each request, which the route compares in constant time. Without a secret there is no authentication header at all | [O] |
| Updates used | `message` in private chats (v1); with Business mode also `business_connection`, `business_message`, `edited_business_message`, `deleted_business_messages` | [O] |
| **Which bot sent it** | An update does not name the bot, so one URL for every bot cannot tell whose secret to check. The route needs a **per-connection secret path segment** (an unguessable hook id stored on the connection) beside the secret header, which names a connection and never an org. How this sits with ADR-0039's "a notice names no org" and the route-coverage test is the **first design decision of the build issue**, security-reviewed (protected path) | design |
| Reply | `sendMessage` with `chat_id` and `text`, up to 4096 characters (`TELEGRAM_TEXT_MAX` already in `packages/channel/src/telegram.ts`). In Business mode the same call carries `business_connection_id` and appears as the owner's own message | [M], [S] |
| Window | None: a bot may answer a user who started it at any time (`windowHours: null`). A blocked bot gets a refusal that maps to `permission` | [M], [live] |
| Limits | About one message a second to one chat, 20 a minute to a group, about 30 a second across chats; beyond that 429 errors. **Paid broadcasts** (0.1 Star a message over the free 30 a second) are off by default and Ludy never turns them on | [O] |
| Attachments | `photo` arrives as sizes with a `file_id`; `getFile` gives a `file_path`; the bytes come from `https://api.telegram.org/file/bot<TOKEN>/<file_path>`, **a URL that contains the token**, so it is built inside the job, never stored, logged or put in an event; the ingest event carries the `file_id` as a `mediaRef` until the pending row is made (the contract change of section 4.1). Download limit about 20 MB per file | [M], [live] |
| Names | `from.first_name`, `last_name`, `username` arrive in each update; `from.id` is the identity | [M] |
| History | None for bots. A missed update may be lost: how long Telegram holds undelivered updates and how it retries a failing webhook is not confirmed | [U] |
| Telegram Business mode | An owner with Telegram Premium connects a bot to their **own account** in Telegram's settings (Business, Chatbots); the bot then receives and answers the owner's own customer chats. Each account connects one business bot (one blog [S]). This is the mode that fits a shop owner who already chats with customers from a personal account; the Premium subscription is the owner's own | [S], [live] |

**Design.** `provider = telegram` on the existing connection kind with an opt-in "also answer chats" (it sets the webhook; the connection already holds the token), `kinds: ['direct']`, `replyMax: 4096`, `canHide: false`, `windowHours: null`. The customer id is `from.id`; chat id is the thread (`external_thread_id`). Groups and supergroups are out of v1 (privacy mode, noise, a community is not a customer). The build issue has two slices: bot private chats first, Business mode second (same issue, a second PR).

**Who pays.** Nothing for a bot. Telegram Premium for Business mode is paid by the owner, on their own account.

### 4.3 TikTok: comments and direct messages (build, access-gated, P2)

**Why, and why gated.** TikTok is where a lot of Vietnamese sellers live, so the fit is high; but an inbox needs TikTok's **Business** APIs, not the Content Posting API Ludy's publisher uses (`packages/channel/src/tiktok.ts`).

| Need | What | Tag |
|---|---|---|
| Direct messages | The **TikTok Business Messaging API**: one-to-one conversations between a TikTok user and a TikTok **Business Account**, received by webhook. Integrators apply for access; it needs special permissions and approval | [S] |
| Regions | Messages from accounts registered in the EEA, Switzerland and the UK cannot be retrieved; some sources add the US and India. Vietnam was not listed among the exclusions | [S], [live] |
| Window and content | 48 hours from the customer's last message; a business cannot send video or voice | [S], [live] |
| Comments | The only official comment-list endpoint found is the **Research API** (research.data.basic scope), which is for researchers and **not usable** for a business inbox [O]. A reply-create endpoint under the Business API appears only in an unofficial SDK; a comment list for business accounts was not found | [O], [S], [U] |
| Webhook security | Not found; assume a signature header over the raw body and confirm | [U] |
| Account | A TikTok Business Account (free) and the business's own authorisation of Ludy's app | [S] |
| Cost | No per-message fee found | [U] |

**Design.** If the Business Messaging API is approved: `provider = tiktok`, `kinds: ['direct']` (and `comment_thread` only if a business comment list exists), `windowHours: 48`, `replyMax` from the page, a push route plus a reconcile read. **The first step of the build issue is not code**: read TikTok's Business API pages, apply for Business Messaging access as Ludy's app (an owner action: only a person can sign TikTok's terms), record the regions and the comment endpoints, and stop for the PO if comments have no list endpoint (a direct-message-only slice is still worth building). Until then the issue builds nothing live; it may build the adapter against the sandbox and recorded answers once the page is read.

**Who pays.** The business, on its own TikTok Business Account; no fee found [U]. Approval costs Ludy time only [U].

### 4.4 Threads: replies (build, P2)

**Why.** It reuses Meta's machinery (Meta app, webhook signature, hide model) and Ludy already publishes to Threads (`packages/channel/src/threads.ts`). Threads has replies on the business's own posts, and no private-message API was found [U], so it is a `comment_thread` channel, one conversation per top-level reply, like a Facebook post.

| Need | What | Tag |
|---|---|---|
| Scopes | `threads_basic` for every call, `threads_read_replies` for reading, `threads_manage_replies` for writing and hiding. The existing connection has publishing scopes only, so the inbox is an **opt-in with a reconnect** | [O] |
| Read replies | Replies of a post and its whole conversation are readable (`/{media-id}/replies`, `/{media-id}/conversation`); the reconcile job reads replies of recent posts | [M] |
| Reply | Publishing a reply to a reply or post id. **A profile may publish at most 1,000 API replies in a rolling 24 hours** (readable at `/{user-id}/threads_publishing_limit`) | [O] |
| Hide | `POST /{reply-id}/manage_reply` hides or unhides a top-level reply, and nested replies follow their parent. One guide says the API cannot hide at all; the official page decides | [O], [U], [live] |
| Webhooks | A Threads app can subscribe to reply webhooks; the field names and the signing secret (the Threads product may have its own app secret, as Instagram's does) are not confirmed. Webhook delivery is optional, so polling stays the safety net | [S], [U] |
| Text limit | Threads' own limit of 500 characters a post applies to a reply; confirm | [U] |
| Names | Reply authors arrive as a username and id; the display name needs another call or is absent | [U] |

**Design.** `provider = threads`, `kinds: ['comment_thread']`, `canHide` true once the live check confirms it, `windowHours: null`. The thread is the top-level reply; `external_post_id` is the media id, so the post tab of Social shows them under their post. **Who pays**: nobody; no fee was found [U].

**Built in [#3133](https://github.com/DOS/Ludy/issues/3133)** (2026-11-13), from this plan and recorded answers only: the build session's network denied `developers.facebook.com`, so no official page was read and every [M] and [U] above is still open until the live check ([threads-conversations-live-check.md](../runbooks/threads-conversations-live-check.md)). What the build decided:
- **The webhook shares the Facebook route.** `POST /api/channels/facebook/webhook` also takes a Threads reply notice, with the same verify token, when it is signed with the Threads app's secret (`CHANNEL_THREADS_APP_SECRET`); a Threads object signed with the Pages secret, or a Page object signed with the Threads secret, is acknowledged and never read. No new public route.
- **Opt-in.** `threads_read_replies` is the one new scope (`threads_manage_replies` was already asked for). Threads does not say what was granted, so the connection records it only when `GET /me/replies` works with the new token [M].
- **Authors** are the reply's `@username` (lower-cased as the customer's external id) [U]; the profile's own replies are `out`.
- **Reply** is the publisher's first-comment call (a TEXT container with `reply_to_id`, then `threads_publish`), preceded by a read of the profile's reply cap (`reply_quota_usage`, `reply_config` [M]); a cap that cannot be read does not stop the call, the platform's own refusal is mapped. Never repeated after an unclear answer.
- **Hide** is in the adapter, but `canHide` is false and the Hide button is not shown until row 8 of the runbook is filled. `replyMax` is 500 [U].
- **Reconcile** reads recent posts and each post's whole conversation, hourly, only for a profile that holds `threads_read_replies` (`CHANNEL_THREADS_HISTORY`, default true).

### 4.5 YouTube: comments (build, P2)

**Why, and the quota truth.** The Data API v3 can list, reply to and moderate comments on the business's own channel; Ludy already publishes there (`packages/channel/src/youtube.ts`). The cost model is the problem: the API is **metered in quota units per Google Cloud project**, not per business.

| Need | What | Tag |
|---|---|---|
| Quota | A project has **10,000 units a day** by default, reset at midnight Pacific time. `commentThreads.list` and `comments.list` cost 1 unit; `comments.insert` (a reply), `comments.update`, `comments.setModerationStatus` and `comments.delete` cost **50**. Every request costs at least 1, an invalid one too | [O] |
| What it means | One project can send **at most about 200 replies a day in total** and nothing else. Polling a channel once every 15 minutes for recent threads is about 96 units a day, so a deployment on one project supports about 100 channels' polling and almost no replies. A self-hosted business with its own Google project is fine; **Ludy Cloud needs a quota extension** from Google before many channels connect (an owner action: time, and no fee was found) | [O], [U] |
| Push | No push for comments was found; plan on **polling** (a reconcile job per connection, newest threads of recent videos, an adaptive interval, a daily unit budget per connection that the job respects). A push service for new uploads exists; none for comments was found | [U] |
| Scope | Writing comments needs a broader scope than uploading; the existing connection is reconnected through an opt-in | [S] |
| Reply | `comments.insert` with `parentId` for a reply to a comment; a new top-level comment on a video is `commentThreads.insert` (out of v1) | [O] |
| Moderate | `comments.setModerationStatus` (held for review, published, rejected) is a 50-unit call; "hide" maps to held for review and "unhide" to published, to be confirmed. v1 ships **reply only**; hide is a second step because it acts on someone else's words | [O], [U] |
| Text limit | YouTube's comment limit (10,000 characters) | [U] |
| Names | `authorDisplayName` and the channel id arrive with each comment | [M] |

**Design.** `provider = youtube`, `kinds: ['comment_thread']`, one conversation per top-level comment, `external_post_id` the video id, `canHide: false` in v1, `windowHours: null`. **Who pays**: nobody; quota is the limit, not a fee. The connect screen shows the day's remaining units so a person sees why replies stop.

### 4.6 Shopee, Lazada, TikTok Shop buyer chat (not now)

The fit is the highest of any channel here for hộ kinh doanh (most of their customer talk is inside the marketplace's seller chat), which is exactly why this section is honest about why it is not in this wave.

- **No confirmed official chat API** for Shopee or Lazada: searches found no official page for either's chat endpoints; one connector vendor says Shopee SellerChat integration is not supported, and a vendor note says a reply typed in Shopee's own seller chat is not synchronised back [S]. TikTok Shop's connectors list customer-service operations (get conversations, get messages, send message, read message, end session) [S] and its webhooks are at-least-once with retries [S]; the exact scopes and event names are [U].
- **Access is a partner decision, not a build step.** [stock-and-marketplaces.md](stock-and-marketplaces.md) section 10 already records that connecting a seller needs Ludy registered as a marketplace partner on each platform, with a business licence, a data security review of about 2 weeks and sometimes a compliance review of 3 weeks or more, and that Lazada's terms are ambiguous for a self-hosted install. That is the owner's decision #2523, plus a seller's own-app trial #2522.
- **Buyer data limits conflict with the inbox default.** Buyer personal data is masked and may be kept only about 90 days (Lazada's security guide; Shopee's data protection policy quoted by a partner; TikTok Shop's review asks for a retention schedule), against Hộp thư's default of 24 months. A marketplace channel would need its own 90-day retention default and deletion on disconnect.
- **Revisit** after #2523 answers and #2522 shows which sellers can connect their own app. No build issue now; the PO decides whether an Icebox issue (P3) records the idea.

## 5. Who pays what

| Channel | Who pays | What | Could it cost Ludy? |
|---|---|---|---|
| WhatsApp | The business, to Meta, on its own WABA | Templates per delivered message by category and country (Ludy sends none in v1); a free-form reply inside the window is a service message, **free for the first 1,000 a month per business phone number, charged to the business from the 1,001st**, free inside a Click-to-WhatsApp free entry point window, and delivery stops after the 1,000 when the account has no payment method [docs, 2026-11-13]; the connect screen warns the business | No |
| Telegram | Nobody; Premium (owner's own) for Business mode | Paid broadcasts exist and are never enabled | No |
| TikTok | The business, on its own account | No fee found [U] | No |
| Threads | Nobody | Free | No |
| YouTube | Nobody | Quota, not money; Ludy Cloud needs an extension (time) | No |
| All | **The AI draft**: model tokens through the AI budget meter, as today | A cost per draft, bounded by the org's monthly AI budget and half the daily limit | Only the existing metered AI cost, which the owner already approved |

If any build issue finds a fee that would land on Ludy (an API plan, a partner fee, a per-message charge on Ludy's own account), it stops and the PO asks the owner. Nothing in this plan needs that approval today.

## 6. What a person sets up (owner-action; no agent signs in, signs terms or pays)

- **WhatsApp:** a Meta business portfolio and a WhatsApp Business Account; a **spare number for the live check first** (a number in the WhatsApp Business app cannot be moved to the API without coexistence, and a test must not disturb a real shop); the Meta app with the WhatsApp product, its webhook URL (`<APP_URL>/api/channels/whatsapp/webhook`) and verify token; a System User token. For Ludy Cloud serving other businesses: Meta business verification and App Review.
- **Telegram:** a bot from @BotFather; for Business mode, a Telegram Premium account and the bot connected in its settings.
- **TikTok:** a TikTok Business Account, Ludy's app registered with TikTok and an application for Business Messaging access.
- **Threads and YouTube:** the same apps Ludy already uses, with the extra scopes added and approved (App Review for Threads' reply scopes [U]; Google verification for the comment scope [U]); for YouTube on Ludy Cloud, a quota extension request.
- **Legal:** the lawyer's read of Meta's and TikTok's rules on stored customer messages, already queued in [conversations.md](conversations.md) section 12, before Ludy Cloud serves other businesses.

## 7. The live check

One runbook per channel, `docs/runbooks/<channel>-conversations-live-check.md`, written by its build issue in the shape of [zalo-conversations-live-check.md](../runbooks/zalo-conversations-live-check.md): a results table (fact, tag, the file that reads it, the live answer), the owner's setup, the steps, what is not built. Rules that hold for all of them: only the owner's own accounts and test accounts; never paste a secret, a token or a customer's message into chat, an issue or a commit (write "matched", "no match" and the error code); no real customer's messages until the channel's row of the table is settled.

The rows each runbook must settle (**[PERSON]** acts, **[AGENT]** reads the logs with the owner's go-ahead):

| Channel | Rows that must be settled live |
|---|---|
| WhatsApp | The webhook signature matches the raw body (`metaSignatureOk` with the right app secret); the payload fields and `wamid` ids; a customer's message appears in Hộp thư within seconds, with name and phone; a reply inside 24 hours is delivered and ends `sent`; a reply after 24 hours is refused by Ludy and, tried directly, fails with 131047; the status webhook's `failed`; an image arrives within the 5-minute URL life; the business's billing page shows no charge for the in-window reply (or shows it); the echo of a message sent from the Business app on a coexistence number; retry behaviour after a two-minute outage; whether `wa_id` is the phone number |
| Telegram | The secret header refuses a wrong secret; the per-connection path works with two bots; a private message and a photo arrive; a reply is delivered; a blocked bot's refusal is mapped; Business mode delivers `business_message` and a reply with `business_connection_id` appears as the owner's own message; the file URL never appears in a log |
| TikTok | API access granted; webhook signature; the regions; a direct message in and out inside 48 hours; whether any comment list and reply endpoint exists for a business account |
| Threads | The reply scopes granted; replies read and webhooked; the reply publishing limit; hide and unhide of a top-level reply; the webhook signing secret |
| YouTube | The scope and verification state; units used by one poll and one reply against the day's quota; a reply appears on YouTube; polling interval against the budget |

## 8. What is left out, and why

- **Marketplace buyer chat (Shopee, Lazada, TikTok Shop):** section 4.6.
- **WhatsApp templates, marketing broadcasts and business-initiated messages:** the business is billed per message and a mistaken send costs money and quality rating. Templates are a later slice with their own approval flow and a person's confirmation of the cost; they are not a rule of this plan. Also out: marking messages read, typing indicators, outbound images and documents, WhatsApp groups, calling.
- **Zalo personal accounts:** no official API; Zalo OA is already built (CV5). Zalo's own out-of-window messages stay refused (the plan's rule), and ZNS notification messages are a different, paid product.
- **Viber, LINE, SMS, WeChat, Signal and others:** not researched in this pass. None was in the owner's list, none is a first channel for Vietnamese small businesses by the figures found [S], and some are paid per message (an official Viber Business and SMS bill the sender), which this plan treats as out of scope until the owner names them.
- **Telegram groups and channels' comments:** noise and no customer relationship in v1.
- **Instagram, Facebook Messenger and Page comments, Zalo OA, email:** built; their live checks are the PO's with the owner.
- **Auto-reply on any channel:** none, as everywhere in the core (no auto-send, section 5.6 of [conversations.md](conversations.md)).
- **Deleting or removing others' content on a platform:** out of v1 everywhere (irreversible).

## 9. Build order and the issues

Each channel is one end-to-end issue (migration if any, server, contract, UI, tests, a live-check runbook), claimed and built like any other, Engage line, labels `social` and `line:social-management`. **Priority:** P1 for WhatsApp (the owner's decision), P2 for the rest; the plan argues no change.

| Order | Issue | Why here |
|---|---|---|
| 1 | [#3131](https://github.com/DOS/Ludy/issues/3131) WhatsApp (P1) | The owner's request; reuses the Meta intake; the phone-number match |
| 2 | [#3132](https://github.com/DOS/Ludy/issues/3132) Telegram (P2) | Cheapest and fastest to prove a second push channel; its per-connection secret path decision is reusable by TikTok |
| 3 | [#3133](https://github.com/DOS/Ludy/issues/3133) Threads (P2) | Reuses Meta's machinery and the Social post tab; a comment channel on a second platform |
| 4 | [#3134](https://github.com/DOS/Ludy/issues/3134) YouTube (P2) | Needs the polling reconcile and the quota budget, which is its own design; quota extension in parallel |
| 5 | [#3135](https://github.com/DOS/Ludy/issues/3135) TikTok (P2, access-gated) | Starts when access is granted; its first step is reading the pages and applying (owner action) |
| later | Marketplaces, no issue yet | After #2523 and #2522 (section 4.6) |

Every issue starts by reading the official pages and upgrading the tags of its section (section 2), and ends with its live-check runbook (section 7).

## 10. Official pages to read first

The official pages that appeared in this pass's search results, **listed but not read** (section 2). Each build issue reads its own and upgrades the tags:

- WhatsApp: pricing <https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing>, media <https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media>, per-user marketing limits <https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/marketing-templates/per-user-limits/>, Embedded Signup <https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/version-3-public-preview/>.
- Telegram: Bot API <https://core.telegram.org/bots/api>, Bots FAQ (limits, paid broadcasts) <https://core.telegram.org/bots/faq>.
- Threads: retrieve and manage replies <https://developers.facebook.com/docs/threads/retrieve-and-manage-replies>.
- YouTube: quota costs <https://developers.google.com/youtube/v3/determine_quota_cost>, `comments.insert` <https://developers.google.com/youtube/v3/docs/comments/insert>, `commentThreads.insert` <https://developers.google.com/youtube/data/reference/rest/v3/commentThreads/insert>.
- TikTok: Research API comment query (not usable for an inbox) <https://developers.tiktok.com/doc/research-api-specs-query-video-comments>; the Business Messaging API pages were not among the results.
- Shopee, Lazada, TikTok Shop: no official chat page was among the results.

## 11. Risks

| Risk | Mitigation |
|---|---|
| This plan's platform facts are secondary: **no official page was read** (section 2) | Every build issue begins by reading the official pages and changing the plan where they differ; the live check settles the rest; nothing is [docs] until read |
| A business pays Meta for a message it did not mean to buy (templates, a policy change on service messages) | No template or business-initiated send in v1; the live check reads the real bill; the rules are static data |
| Missed messages with no history API (WhatsApp, Telegram) | Say so on the connect screen; keep the answer to the platform's retry; reconcile where an API exists (YouTube, Threads) |
| A customer's phone number (`wa_id`) leaks into logs or audit | Class `pii`, the redaction test, no number in jobs or events |
| A token in a URL (Telegram file URL, WhatsApp media call) is logged | Built inside the job from the sealed credential, never stored; a test that no log or event holds it |
| YouTube quota exhausted by polling | A per-connection daily budget, an adaptive interval, a visible remaining-units figure, a quota extension for Ludy Cloud |
| One Telegram webhook URL cannot say which bot sent an update | A per-connection secret path segment, designed and security-reviewed first (section 4.2) |
| Access gates (TikTok approval, Meta App Review, Google verification, marketplace partner status) block a channel | Each is an owner action named in section 6; the issue is ready to build against the sandbox and recorded answers, and says so when it waits |
| Buyer-data rules differ by platform (marketplaces about 90 days, WhatsApp and Telegram under the org's default) | Retention per channel is an issue of its own if a platform requires it; marketplaces are out until #2523 |
