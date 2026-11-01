# 0041. A conversation core in the kernel: comments answered in Social, private messages in Service

- Status: Proposed (2026-11-01). Nothing here is built. The layout, the retention default and the build order are **owner** decisions ([conversations plan](../plan/conversations.md), section 16).
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

The owner decided on 2026-11-01: "Trả lời bình luận thì nên trong Social. Tin nhắn riêng trong Service." Replies to comments on the org's own posts belong in Social, private messages (Messenger, Instagram DMs, Zalo OA chat) in Service, and the two should share as much core as possible. That reverses the earlier plan, where Service's inbox took both and Social only published.

Today there is no store for platform comments or messages (the kernel keeps `inbound_message` for email, a record of arrival only), and no Service module.

What has to be decided:
1. Where the shared store lives, so that Social and Service can each be sold and run alone.
2. How comments and messages arrive and how replies go out, given what Meta and Zalo offer.
3. Who may read a comment and who may read a private message.
4. How the app's layout shows Social, Service and Ads.
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

`crove_kernel.conversation` and `conversation_message`, with `kind` `comment_thread` or `direct`, next to `channel_connection`, `party`, `task` and `activity`, which every module already shares. A comment thread is one conversation per top-level comment. Social joins its posts to a thread through `(channel_connection_id, external_post_id)` with no foreign key across schemas. Alongside: identities, internal notes, saved replies, AI drafts, read state, a composing marker and member availability (plan section 5.2).

### 2. Intake: a signed webhook enqueues, a worker stores, a poll reconciles

- A public route per provider family verifies the platform's signature (Meta `X-Hub-Signature-256`, Zalo `X-ZEvent-Signature`), caps the body, **only parks it** in a pending table (a definer for the API login, as ADR-0039's pending rows; built in CV1, #2303, instead of a pg-boss queue, whose job history and dead letter queue would keep the body), and answers within the platform's window. It writes no tenant row.
- A worker job finds the connections from the platform's own account id and runs a system command `kernel.conversation.ingest` per active connection of an active org. **The org comes from the stored connection, never from the notice** (ADR-0039).
- **The signed body is stored**, unlike the bank feed, where a pull follows the notice, because these platforms offer no history to pull from (Meta: no history API, 36 hours of retries, 20 messages per conversation; Zalo: no retry on error). Idempotent on `(org, connection, external_message_id)`; ordered by the platform's time.
- A reconcile job per connection (re-subscribe, read recent comments and recent messages) is the safety net, with a visible "events missed" marker when it had to fill a gap.

### 3. Replies go through one exactly-once pipeline

`kernel.conversation.reply` (R2, a person's Send is the confirmation) writes the message and an `external_call` row before the call, as publishing does. Platform send calls have no idempotency key, so a send is `reconcile_only`: an unknown outcome is reconciled by the echo events (Messenger `message_echoes`, Zalo `oa_send_*`) or by reading the thread, never retried blindly. The platform's reply window is checked before the send and the button says why it is disabled. Hide and unhide use the same pipeline; delete is out of v1.

### 4. Permissions follow the kind, in the database

A comment thread is readable like the post it belongs to (owners, admins, and members and viewers who may read the channel). A direct message is readable only by owners, admins and holders of the `desk.agent` role (new permission `conversation.direct.read`), enforced by a restrictive policy on `kind = 'direct'`, not only in the screen (the permission is `kernel.conversation.direct.read`: a manifest permission carries its module's prefix, and no role holds it until the Service inbox seeds it for `desk.agent`). Social's per-channel member limit (`crove_social.channel_access`) moves to the kernel so the core can apply it.

### 5. Collision, assignment and availability

Assignment is the soft lock; a composing marker with a 60-second expiry shows "X is replying"; the reply command refuses with `CONVERSATION_MOVED` when a newer message exists than the one the sender saw (the guarantee). Availability is a per-member switch used for notification, with no automatic round-robin in v1.

### 6. A comment shows in Social only; the bridges are explicit

Comments appear under their post and in Social's comment inbox, not in Service's. "Reply privately" (Meta allows one private message within 7 days) creates a linked direct conversation that Service shows; "send to Service" hands a comment to Service as a case or, before cases exist, a task. A Service-only org gets no comments in v1 (the plan's Q2).

### 7. One rail app with groups

Social, Service and Ads are **groups of one rail app** (working name "Kênh"), each shown only when its module is enabled, instead of three rail items. The shell already builds apps and groups from the manifests' nav declarations and drops groups of modules that are not enabled; the cost is renaming the Social app id and its menu messages. The conversation screen is one shared component used by both inboxes. [ADR-0040](0040-ads-read-only-sources.md) and the Ads plan agree: Ads is a group inside this app.

### 8. AI drafts and taint

Every inbound item is tainted external text. An agent may write a **draft** into `conversation_draft` (a one-line addition to ADR-0029's write allowlist, flagged for the security review); it never sends, hides, resolves or links a contact. A person presses Send. No auto-reply to messages in v1.

### 9. Personal data

Names, avatars, external user ids and bodies are classed `pii`. No party is created automatically: a person links or creates a contact. Audit rows, activity and logs carry ids and lengths, never a body or a name. Retention is an org setting (default 24 months after the last message) with a daily purge; `kernel.conversation.erase_contact` (R3) answers a person's request; a platform's removal of a comment or message blanks the body; images are stored (size cap, never rendered as HTML or parsed), other attachments are links to the platform. Meta's data deletion callback concerns the app's users, so it disconnects the Ludy member's connections and deletes the data read through them unless the owner takes the connection over first (a cautious reading; a lawyer confirms before Ludy Cloud).

## Decisions for the owner

The seven questions in [the plan, section 16](../plan/conversations.md#16-questions-for-joy): layout (Q1), comments in Service (Q2), the app's name (Q3), approval of members' replies (Q4), retention (Q5), Zalo's paid plan (Q6), build order (Q7). Without an answer: one rail app, comments only in Social, the working name "Kênh", no approval, 24 months, a clear Zalo plan message, the order of the plan. In every order, **no live channel handles a real customer's messages before retention, erasure, export and purge are built and accepted** (CV6): until then live channels run only on the owner's own accounts.

## Consequences

- Either module can be sold alone; the second adds screens, not data.
- More kernel surface: new tables and commands, public webhook routes, credential use in new jobs. Each PR gets the independent security review, RLS matrix rows, a redaction test and the job egress invariant.
- New personal data of third parties lives in the kernel schema and in a short-lived queue; erasure, retention, export and purge must cover it before any customer uses it.
- Existing Facebook and Instagram connections must be reconnected to grant the inbox scopes (an opt-in on the connect screen); a Messenger use case may need its own Meta app.
- Ludy Cloud serving other businesses on Meta needs App Review and Business Verification for each added permission.
- A rename of the Social app id and its menu messages, with no URL change.

## Alternatives considered

- **A module `conversation`** (schema `crove_conversation`) that Social and Service both depend on. Rejected as the default: Service would need the module installed to read anything, and it would be one more module to enable, version and review for what the kernel already does for `party`, `task` and `activity`. Kept as a fallback if the kernel's size becomes the problem.
- **The store inside Service** (as the older plan said). Rejected: Social alone would have no comments, which is the owner's decision reversed.
- **The store inside Social.** Rejected: a Service-only org would have to install Social to read a message.
- **Comments in both inboxes.** Rejected: two unread counts and two people on one comment; the bridges give the connection without the duplication.
- **A webhook that only triggers a pull** (the bank-feed rule). Rejected here: the platforms keep no history to pull from, so the signed event is the record.
- **Separate rail items** (Hootsuite style). Kept as option B in the plan: the cost of (a), a rename, is small and the rail stays short.
- **Auto-reply and auto-assignment in v1.** Rejected: customer-visible, and a prompt injection in a customer message would drive it; drafts and a person's Send instead.
- **Storing profile data and phone numbers from the platforms.** Rejected: more personal data than the product needs; the party holds what a person chooses to save.
