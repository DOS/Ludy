# 0041. A conversation core in the kernel: comments, private messages and email in one inbox

- Status: Proposed (2026-11-01), amended 2026-11-03 (#2437) for the owner's decision on the inbox (Decisions 6, 7 and 10). Nothing here is built. The layout, the retention default and the build order are **owner** decisions ([conversations plan](../plan/conversations.md), section 16).
- Date: 2026-11-01
- Deciders: owner (JOY), on the Marketing PO's recommendation
- Builds on:
  - ADR-0025 (channel layer: connections, sealed credentials, adapters with an egress allowlist);
  - ADR-0039 (a public webhook that never names an org, and a worker that finds the connections);
  - ADR-0027 (the open-source core runs without any DOS service);
  - ADR-0029 (agents and their write allowlist);
  - ADR-0031 (module enablement);
  - ADR-0037 (private text, no text in audit rows, personal-data erasure);
  - the job egress invariant (#1653) and the data classes of module manifests (#1599).
- Issue: [#2213](https://github.com/DOS/Ludy/issues/2213)

## Context and problem statement

The owner decided on 2026-11-01: "Trả lời bình luận thì nên trong Social. Tin nhắn riêng trong Service." Replies to comments on the org's own posts belong in Social, private messages (Messenger, Instagram DMs, Zalo OA chat) in Service, and the two should share as much core as possible. That reversed the earlier plan, where Service's inbox took both and Social only published. **On 2026-11-03 the owner decided that the inbox follows Crisp and Intercom, not Zendesk (#2437):** every customer interaction, whether chat, a comment on the org's own posts or customer email, is one conversation shown in one inbox, Hộp thư, with New, Pending and Resolved, and staff reply in the same box. The shared core stands; the split of the screens does not (Decisions 6, 7 and 10).

Today there is no store for platform comments or messages (the kernel keeps `inbound_message` for email, a record of arrival only), and no Service module.

What has to be decided:
1. Where the shared store lives, so that Social and Service can each be sold and run alone.
2. How comments and messages arrive and how replies go out, given what Meta and Zalo offer.
3. Who may read a comment and who may read a private message.
4. How the app's layout shows the inbox, CRM, posting and ads.
5. What personal data of third parties the store holds, for how long, and how it is erased.

Facts that shape the choices (sources and confidence tags in the [plan](../plan/conversations.md)):
- **Meta**: comment webhooks on the Page `feed`, message webhooks on `messages`, a 24-hour reply window (7 days with the human-agent tag), one private reply per comment within 7 days, no history API, retries for only 36 hours, the Conversations API reads at most the 20 most recent messages, and every permission involved needs App Review for other people's Pages.
- **Zalo**: message webhooks and a send API inside a 48-hour window (secondary sources), API only on a paid OA plan, **no comment API found**; the developer pages are not readable without a browser.
- The shell already builds apps and groups from each module's manifest and hides groups of modules that are not enabled.

## Decision drivers

- **Social and Service each run alone.** Neither may need the other installed to read its own items.
- **One write path, tenancy, sealed credentials and egress** stay as ADR-0025 and the Rules set them.
- **Private messages are more sensitive than comments.** The read rule differs by kind.
- **Third parties' personal data.** Minimum stored, erasable, no text in audit rows.
- **OPC and SME first**, a short rail, no enterprise features.
- **Never answer a customer twice, and never lose a message.**

## Decision (proposed)

### 1. The store is in the kernel, with a kind

`crove_kernel.conversation` and `conversation_message`, with `kind` `comment_thread`, `direct` or `email`, next to `channel_connection`, `party`, `task` and `activity`, which every module already shares. A comment thread is one conversation per top-level comment. Social joins its posts to a thread through `(channel_connection_id, external_post_id)` with no foreign key across schemas. Alongside: identities, internal notes, saved replies, AI drafts, read state, a composing marker and member availability (plan section 5.2).

### 2. Intake: a signed webhook enqueues, a worker stores, a poll reconciles

- A public route per provider family verifies the platform's signature (Meta `X-Hub-Signature-256`, Zalo `X-ZEvent-Signature`), caps the body, **only parks it** in a pending table (a definer for the API login, as ADR-0039's pending rows; built in CV1, #2303, instead of a pg-boss queue, whose job history and dead letter queue would keep the body), and answers within the platform's window. It writes no tenant row.
- A worker job finds the connections from the platform's own account id and runs a system command `kernel.conversation.ingest` per active connection of an active org. **The org comes from the stored connection, never from the notice** (ADR-0039).
- **The signed body is stored**, unlike the bank feed, where a pull follows the notice, because these platforms offer no history to pull from (Meta: no history API, 36 hours of retries, 20 messages per conversation; Zalo: no retry on error). Idempotent on `(org, connection, external_message_id)`; ordered by the platform's time.
- A reconcile job per connection (re-subscribe, read recent comments and recent messages) is the safety net, with a visible "events missed" marker when it had to fill a gap.

### 3. Replies go through one exactly-once pipeline

`kernel.conversation.reply` (R2, a person's Send is the confirmation) writes the message and an `external_call` row before the call, as publishing does. Platform send calls have no idempotency key, so a send is `reconcile_only`: an unknown outcome is reconciled by the echo events (Messenger `message_echoes`, Zalo `oa_send_*`) or by reading the thread, never retried blindly. The platform's reply window is checked before the send and the button says why it is disabled. Hide and unhide use the same pipeline; delete is out of v1.

### 4. Permissions follow the kind, in the database

A comment thread is readable like the post it belongs to (owners, admins, and members and viewers who may read the channel). A direct message or an email is readable only by owners, admins and holders of the `desk.agent` role (new permission `conversation.direct.read`), enforced by a restrictive policy on `kind <> 'comment_thread'`, not only in the screen (the permission is `kernel.conversation.direct.read`: a manifest permission carries its module's prefix, and no role holds it until the Service inbox seeds it for `desk.agent`). Social's per-channel member limit (`crove_social.channel_access`) moves to the kernel so the core can apply it.

### 5. Collision, assignment and availability

Assignment is the soft lock; a composing marker with a 60-second expiry shows "X is replying"; the reply command refuses with `CONVERSATION_MOVED` when a newer message exists than the one the sender saw (the guarantee). Availability is a per-member switch used for notification, with no automatic round-robin in v1.

### 6. Every conversation is in Hộp thư; the bridges are explicit

Comments, private messages and email are all conversations in one inbox, Hộp thư, as in Crisp and Intercom (owner, 2026-11-03). A comment also appears under its post, in the post page's Bình luận tab, which is a filtered view of the same conversation: one store and one unread count. "Reply privately" (Meta allows one private message within 7 days) creates a linked direct conversation, and both threads are in Hộp thư. Follow-up work is a task: from any conversation a person creates a `crove_kernel.task` linked to it. An org that has the inbox but not the posting side sees the comments of its connected Pages in Hộp thư (the plan's Q2 is answered).

### 7. One rail app, Ludy Engage, with groups

CRM, the inbox, Social and Ads are **groups of one rail app, Ludy Engage** (app id `social`), each shown only when its module is enabled (data and module switches unchanged), instead of separate rail items. Its groups: **Hộp thư** (every conversation); **Khách hàng & Bán hàng** (Người liên hệ, Công ty, Cơ hội, Lịch hẹn); **Marketing** (Bài đăng, Quảng cáo); **Báo cáo** (one group with a tab per area). The shell already builds apps and groups from the manifests' nav declarations and drops groups of modules that are not enabled; the cost is the app's rename and menu messages and the redirects from the old CRM routes (#2435). The conversation screen is one shared component used by the inbox and the post tab. [ADR-0040](0040-ads-read-only-sources.md) and the Ads plan agree: Ads is a group inside this app.

### 7a. Update of 2026-11-02 (CV3, #2306): one Inbox in the existing Social app, comments and private messages together

The owner's placement decision of 2026-11-02 replaces sections 6 and 7 where they differ. There is **one** app, the existing Social app, which keeps its id and its label; a later rename, if the owner picks one, is a one-line message change. It gets one **Inbox group (Hộp thư)** next to its posting group and Ads: the screen is `social/inbox` (the path `inbox` is the kernel's documents Inbox), shown when the Social module is enabled. It lists **comments and private messages together**, with filters by kind, channel and assignee and a search, in three panes (the list, the thread, the contact panel). A comment shows in the Inbox and under its post (the post page keeps its "Bình luận" tab as a second view of the same conversations), with **one unread mark per conversation**, not two: the `conversation_read` rows are the same. The old comment inbox address redirects. A private message is in the list only for those who read it (owners, admins and holders of `kernel.conversation.direct.read`), which the database decides, not the screen: the list is the same query for everyone.

CV3 seeds `kernel.conversation.direct.read` for the `desk.agent` role (a two-step invariant change: the roles test accepts the seed first, then the migration), so a member holding that role reads and answers private messages; the member's channel limit still applies and a viewer cannot hold the role. The "X is replying" marker (`conversation_composing`, 60 seconds, one write in 20 seconds per thread and member) is read with the screens' six-second poll, not through a stream hint: a hint reaches every member of the org today, so a hint that only readers of a thread get needs its own audience rule and invariant, which is a follow-up. A new conversation is told to the assignee, else the available members who read it, else owners and admins, through the existing notifications (ids only).

CV3's last part adds the **intent label** and the **contact match** (#2306). The label is a person's decision stored on the conversation (`intent`, with who and when), written only by a person (a trigger refuses the system and every other actor), and it routes, assigns, resolves and hides nothing. What an AI coworker suggests is **computed on read** from the customer's words, outside the database transaction and through the AI budget meter, never stored, never an actor, and shown as a suggestion that a click turns into the label; with the model off, spent, busy or failing there is no suggestion and no error. The contact match puts the contact with the phone number the customer wrote first (deterministic) and lets the model only rank the name matches. See `docs/plan/conversations.md`, "CV3 as built, second part".

### 8. AI drafts and taint

Every inbound item is tainted external text. A **draft** reply is written by the **system context**, not by an org-chart agent (#2310): a worker job reads the end of the thread, calls the model in `packages/agent` and records the draft through a system command into `conversation_draft` (always tainted, its text only while live). A person asks for one or the relay does for a new conversation, and a person reads it, edits it and presses Send; the draft is text only and nothing of a send, hide, resolve or contact link is reachable from it. ADR-0029's write allowlist is therefore unchanged: an agent context stays refused on every conversation table (the guard `apply_tenant_rls` installs, and `conversation_access`). No auto-reply to messages in v1. The same job path also records an advisory **intent label** and a **suggested contact** (tainted, never an action: nothing is linked, answered or resolved by them), behind the AI budget meter (#2382); with AI off the inbox works as before. There is no auto-send of any kind.

### 9. Personal data

Names, avatars, external user ids and bodies are classed `pii`. No party is created automatically: a person links or creates a contact. Audit rows, activity and logs carry ids and lengths, never a body or a name. Retention is an org setting (default 24 months after the last message) with a daily purge; `kernel.conversation.erase_contact` (R3) answers a person's request; a platform's removal of a comment or message blanks the body; images are stored (size cap, never rendered as HTML or parsed) as rows of `crove_kernel.conversation_attachment` bound to their message and read through the message's own rule, not as kernel files, because a file is deduplicated by content and cannot belong to one message (CV5c, #2357; the plan's "CV5c as built"); other attachments are links to the platform. **AI drafting is a processing of third-party personal data (#2310):** when Vy drafts a reply (a person asks, or the org's automatic drafting is on, which is the default and which owners and admins can switch off), the last 12 messages of the thread and at most five of the org's saved replies are sent to the deployment's AI endpoint (`AI_BASE_URL`, an OpenAI-compatible service the operator chooses) and nothing else of the customer (no id, no phone number beyond what the messages say); the model's answer is stored as a tainted draft whose text lives only while the draft is live. The settings screen says so in one line, the privacy note of Ludy Cloud lists the AI endpoint as a processor, and the call is rationed by the existing per-minute draft budget (`ai-draft-limit.ts`) and the org's daily AI cost limit. Meta's data deletion callback concerns the app's users, so it disconnects the Ludy member's connections and deletes the data read through them unless the owner takes the connection over first (a cautious reading; a lawyer confirms before Ludy Cloud).

### 10. Email is a conversation channel, and the inbox has no cases, tickets or SLA timers

Customer email, in and out, is a conversation of kind `email` (plan section 6.7): intake through a conversation address of its own per org (the inbound path's machinery, the org found from the stored address, parsing in the sandbox), threading by Message-ID, In-Reply-To and References, the quoted history folded on display, images through the conversation attachment store, and replies through the kernel mail pipeline of [ADR-0034](0034-outbound-email.md) with its suppression check and one send per mail. It is private like a direct message and covered by retention, erasure, export and purge. The inbox follows Crisp and Intercom: a conversation that needs follow-up links to a task, and nothing is a numbered record or counts reply time. Not built; the build item CV10 is not opened.

## Decisions for the owner

The seven questions in [the plan, section 16](../plan/conversations.md#16-questions-for-joy): layout (Q1, answered: one rail app), comments in the inbox (Q2, answered 2026-11-03: yes), the app's name (Q3, answered: Ludy Engage), approval of members' replies (Q4), retention (Q5), Zalo's paid plan (Q6), build order (Q7). Without an answer to the open ones: no approval, 24 months, a clear Zalo plan message, the order of the plan. In every order, **no live channel handles a real customer's messages before retention, erasure, export and purge are built and accepted** (CV6): until then live channels run only on the owner's own accounts.

## Consequences

- Either module can be sold alone; the second adds screens, not data.
- More kernel surface: new tables and commands, public webhook routes, credential use in new jobs. Each PR gets the independent security review, RLS matrix rows, a redaction test and the job egress invariant.
- New personal data of third parties lives in the kernel schema and in a short-lived queue; erasure, retention, export and purge must cover it before any customer uses it.
- Existing Facebook and Instagram connections must be reconnected to grant the inbox scopes (an opt-in on the connect screen); a Messenger use case may need its own Meta app.
- Ludy Cloud serving other businesses on Meta needs App Review and Business Verification for each added permission.
- A rename of the Social app id and its menu messages to Ludy Engage, and redirects from the old CRM routes (#2435), with no other URL change.
- Customer email adds a conversation address per org and a path from the mail parser to the conversation core; it must never reach the invoice extractor (CV10).

## Alternatives considered

- **A module `conversation`** (schema `crove_conversation`) that Social and Service both depend on. Rejected as the default: Service would need the module installed to read anything, and it would be one more module to enable, version and review for what the kernel already does for `party`, `task` and `activity`. Kept as a fallback if the kernel's size becomes the problem.
- **The store inside Service** (as the older plan said). Rejected: the posting side alone would show no comments, and a store owned by one module makes the other depend on it.
- **The store inside Social.** Rejected: a Service-only org would have to install Social to read a message.
- **Comments in Social only, private messages in Service** (the decision of 2026-11-01). Replaced on 2026-11-03: a care person would watch two lists for one customer. One inbox with the post tab as a filtered view keeps one list and one unread count.
- **Comments in two inboxes with their own counts.** Rejected: two unread counts and two people on one comment; the post tab is a view of the same conversation instead.
- **A help-desk model** (Zendesk, Go Desk: numbered records and reply-time timers). Rejected by the owner on 2026-11-03: too heavy for one-person companies and SMEs; the chat model of Crisp and Intercom with a follow-up task is enough.
- **A webhook that only triggers a pull** (the bank-feed rule). Rejected here: the platforms keep no history to pull from, so the signed event is the record.
- **Separate rail items** (Hootsuite style). Kept as option B in the plan: the cost of (a), a rename, is small and the rail stays short.
- **Auto-reply and auto-assignment in v1.** Rejected: customer-visible, and a prompt injection in a customer message would drive it; drafts and a person's Send instead.
- **Storing profile data and phone numbers from the platforms.** Rejected: more personal data than the product needs; the party holds what a person chooses to save.
