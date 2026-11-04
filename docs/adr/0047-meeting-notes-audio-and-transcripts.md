# 0047. Meeting notes: capture and the Ludy extension, audio and video storage, the provider boundary, consent, retention and who reads a meeting

- Status: Accepted (owner, 2026-11-04: "Đồng ý"; Q1 to Q6 of [meetings.md](../plan/meetings.md) section 14 as recommended, Q7, the video default, decided the same day). Proposed 2026-11-03 and revised for the browser extension and optional video. Nothing here is built. The transcription and summary steps (M4, M6) depend on ADR-0049, the member-scoped Vy (PR [#2572](https://github.com/DOS/Ludy/pull/2572)), which still waits for the Platform PO's acceptance; the consent points (point 6) need the lawyer (#62); the tables, definers and the blob cipher are protected paths and get the Platform PO's security review.
- Date: 2026-11-04 (proposed 2026-11-03)
- Deciders: owner (JOY), for the readers (Q2), the retention defaults (Q3), the consent step (Q4) and the Cloud provider (Q5); the engineering choices below by the Claude Code session that wrote the plan
- Builds on: ADR-0013 (files: staged uploads, content address, versioned buckets), ADR-0017 (crypto-shredding design, the restore replay), ADR-0018 (untrusted content), ADR-0025 (the credential vault's envelope), ADR-0029 (tasks and agents, the write allowlist #285), ADR-0031 (module enablement), ADR-0032 (the proposed OAuth server, which the extension may later use), ADR-0037 (private notes: restrictive policies, definers that return no text), the owner's per-member Vy rule of 2026-11-03 ([#1677](https://github.com/DOS/Ludy/issues/1677)), ADR-0049 (the member-scoped Vy, PR [#2572](https://github.com/DOS/Ludy/pull/2572)), the AI budget meter (#2382), the kill switches (#886)
- Issue: [#932](https://github.com/DOS/Ludy/issues/932); the plan is [meetings.md](../plan/meetings.md)

## Context and problem statement

A meeting recording is the most personal data a small business will put into Ludy: voices of members and of outsiders (customers, suppliers, candidates), talk about pay, prices and people. The module must turn it into a transcript, a summary, decisions and action items with AI, and then let it go.

What the code gives today, and what it does not:

- **Files** (`crove_kernel.file`) are content-addressed and written create-only to versioned buckets; Crove holds no permission to delete an old object version (ADR-0013). File rows are readable by every member of the org. Deleting audio there cannot reach every copy.
- **Crypto-shredding** is designed (ADR-0017: per-subject keys wrapped under the deployment key, a replay after restores) but not built; the vault's envelope exists for channel credentials (ADR-0025).
- **The parsing sandbox** (`crove-extract`, T12) runs no child process and no native code, so it cannot run an audio transcoder.
- **The AI layer** has one OpenAI-compatible endpoint behind `metered()`; the meter counts tokens, while transcription is billed by audio length.
- **Per-user privacy** exists for private notes (ADR-0037); the member's own Vy (#1677) is decided by the owner; its mechanism is drafted as ADR-0049 (PR [#2572](https://github.com/DOS/Ludy/pull/2572)) and not built.

The owner chose on 2026-11-03 how online meetings are captured: "Tao thấy option extension là ổn nhất mà, không cần bot, không cần cài app mà ghi âm, record video đều được" (a browser extension, no bot, no app, audio and video). No extension exists, and the OAuth authorization server of ADR-0032 that would issue tokens to software other than the app is proposed, not built.

What has to be decided: how a meeting is captured and how the extension authenticates; who reads a meeting; how audio and video are stored so that it can really be erased; where media is parsed; how the transcription provider is chosen and bounded; what the consent record is; retention of audio and text; and how Vy's work fits the per-member rule.

## Decision drivers

- Erasure must reach every copy the org controls, or the docs must name the copy that stays and for how long.
- Participants who are not members cannot log in; their protection is the org's notice and the product's limits.
- One write path, tenancy, the sealed context and the agents' allowlist stay as they are.
- The core works with AI off; AI output is tainted; a person approves every task.
- Lean: one module, the smallest number of settings, reuse of the vault, the meter, the kill switches and the task helper.

## Options for who reads a meeting

**A. The recorder only.** Like a private note. Simple, but the attendees who were in the room cannot read the notes of their own meeting. Rejected.

**B. The recorder and the member attendees; the recorder may share with the org (recommended).** Owners and admins see that a meeting exists and may delete it, not read it, unless it is shared with the org.
- Good: the people in the room read it; a pay talk stays between those who had it; the same shape as ADR-0037 and the per-member Vy rule.
- Bad: an owner cannot read a meeting they were not part of. Mitigated by the share-with-org choice and by the owner's delete for personal-data requests.

**C. Every member.** Like tasks and documents. Rejected: a recording of a one-to-one would be read by the whole team.

**D. B, plus owners and admins always.** Rejected for the reason ADR-0037 rejected its option B: people stop recording what matters.

## Decision

### 1. A module, `meetings`

Schema `crove_meetings`, package `@crove/mod-meetings`, enabled through `CROVE_MODULES` (ADR-0031), shown as a "Cuộc họp" tab of Ludy Notes. It references `crove_kernel` only. Tables (each `PRIMARY KEY (org_id, id)`, `apply_tenant_rls`, the agent write guard of #285 unchanged):

| Table | Holds |
|---|---|
| `meeting` | title, language, started and ended times, length, `recorder_user_id` (set by the command to the caller, never changed), `visibility` (`attendees` or `org`), status, the consent record (point 6), the two retention dates (point 7) |
| `meeting_reader` | the member attendees (`user_id`) |
| `audio_segment` | the order, offsets and length of each normalized segment and its `kernel.file` reference |
| `meeting_video` | the kept video's `kernel.file` reference and length, only when the member ticked video |
| `transcript_segment` | start and end times, the speaker label, the text, and `stage` (`draft` or `published`, point 3) |
| `meeting_result` | summary and decisions, the feature that wrote them, `stage`, `tainted` |
| `action_item` | title, who and when as drafted and as parsed, the transcript time, `stage`, status (`suggested`, `accepted`, `dismissed`), flags, the task created, `tainted` |
| `media_key` | the meeting's wrapped data keys, one row per kind (`audio`, `video`); no grant to any login role |

The extension's tokens (point 10) serve every app, so they live in the kernel, in `crove_kernel.extension_token`, not in this module.

### 2. Readers, enforced by the database

- Restrictive policies beside `tenant_isolation`, in the style of `crove_notes`: a row of a meeting (a `draft` result row excepted, point 3) is read when the context's user (`ctx_user_id()`, the sealed context T11) is its recorder, or is in `meeting_reader`, or the meeting's `visibility` is `org` and the user's base role is owner, admin or member with the whole-org scope. Writes follow the same readers, and the commands limit what each may change (a reader corrects text and speaker names; the recorder changes readers and visibility).
- Owners and admins get the existence of every meeting (id, date, length, recorder, retention dates) through a definer that returns no text, and an owner deletes any meeting (R3, fresh second factor) without reading it.
- Viewers, org-chart agent contexts and the worker's system context read and write nothing. The worker reaches meetings only through `SECURITY DEFINER` functions with `search_path = pg_catalog, pg_temp`, EXECUTE for the worker login alone: `meetings_due(limit)` (ids and dates past a retention), `meeting_shred(org, meeting)` and `meeting_text_purge(org, meeting, before)`. The org purge runs as the table owner.
- The invariant suite gets `meetings-readers.db.test.ts`; the RLS matrix lists the tables with a readers-only exception to its system-context controls, as it does for notes.

### 3. Vy and agents

- **The mechanism is ADR-0049** (the member-scoped Vy, Proposed in PR [#2572](https://github.com/DOS/Ludy/pull/2572); the file lands with that PR), built once for notes N8, meetings and projects and owned by the Platform PO. Meetings uses its background run (stage B): the worker enters `enter_member_vy_context` for the recorder's own `member_vy` agent and one run, never the system context. The run carries the recorder's rights at most, `max_risk` R1, the feature key, the meeting as its subject and an expiry the feature declares; it ends at once when the recorder leaves the org, a kill switch engages or the budget is spent. Its declared reads are the one meeting's audio and the attendees' names; a test fails on any other query. The model has no tools.
- **The output lands in the recorder's own Vy result** (option (a), the Platform PO's ruling of 2026-11-04). Transcription, summary, decisions and action items are written as `draft` rows of the meeting's result tables, whose policy admits only the recorder (`recorder_user_id = ctx_acting_user_id()`), so only the recorder reads them, and the recorder's Vy writes them through its catalog (`crove_kernel.member_vy_table`, the meetings tables added by the meetings migration). No attendee, owner, admin, org-chart agent or system context reads a draft. Drafts expire with ADR-0049's 30-day rule for results.
- **The recorder publishes with one click.** "Chia sẻ với người dự họp" runs `meetings.result.publish`, the recorder's own command in the recorder's own session, which takes the draft's id, refuses unless `confirmed: true`, and copies the reviewed draft into `published` rows that the meeting's readers read (point 2), `tainted` while the AI text is unedited and with a `source_ref` to the run. It is listed in ADR-0049's `MEMBER_VY_SINKS`. Before publishing, the recorder may correct the transcript and edit the summary; a recorder who never publishes keeps the result to themselves.
- **Nothing goes straight to a subject-audience sink.** No Vy run writes a row an attendee reads, a task, a notification with text, a mail or a proposal. The `private_read` flag of ADR-0049 is set for a meeting whose visibility is `attendees`, so its result also never reaches an org-visible sink except through the recorder's click.
- Org-chart agents keep no access (as notes decision N-6). Org-wide outputs (team brief, digests, proposals others approve) carry no meeting content; "Vy đã xong, chờ bạn xem" appears on the recorder's own Home only, and a published meeting on its readers' Home.

### 4. Audio and video storage: ciphertext, one key per meeting and kind

- Audio is a `kernel.file` of a new purpose `meeting_audio`, with its own size cap and a neutral name; a kept video is a file of purpose `meeting_video`, encrypted the same way under the meeting's separate video key. The claim step encrypts the bytes as they stream from staging: AES-256-GCM in fixed-size chunks under a random 32-byte data key of the meeting; the stored object, its sha256 and its generation are those of the ciphertext, so ADR-0013's integrity rules hold unchanged.
- Each data key is wrapped with the vault's envelope under `CREDENTIAL_KEY` (`CREDENTIAL_KEY_PREVIOUS` during a rotation; the reseal pass gains `media_key`), its AAD binding the domain `crove.meeting_media.v1`, the org, the meeting and the kind. The wrapped keys live in `media_key`, reached only through definers that check the caller is a reader in the sealed context, or the worker's shred.
- The generic file download refuses both purposes; playback goes through a module route that checks the reader, decrypts in the API process and streams. Audio and video playback are `sensitive` queries (the audit row before the read).
- The blob cipher lives in `@crove/kernel-runtime` beside the vault, so a later build of ADR-0017 reuses it.
- The original upload is deleted after normalization (point 5): the normalized audio is kept, and the video only when the member ticked "Ghi cả video" for that meeting, a checkbox in the extension and in the in-app recorder, off by default. The owner decided this on 2026-11-04 (plan Q7): "Có option cho cái extension là được mà? mặc định voice only, có thêm nút check record video thôi". Without the tick, the sandbox drops the video track and no video is ever stored.

### 5. Media parsing and the provider boundary

- **Media is parsed only in `crove-media`**, a new sandbox image: ffmpeg and a small server, no network (an internal compose network), no secrets, an environment allowlist, a read-only root, no capabilities, CPU, memory, process and time limits, the CI checks of `crove-extract`. It probes the length, extracts the audio track of a video, normalizes the audio to mono Opus and splits it into segments of at most 10 minutes; a kept video is repackaged, not re-encoded. Transcription always uses the audio. The worker sends it decrypted bytes and encrypts what it returns; its answers are validated as untrusted.
- **Transcription goes through `packages/agent`** under `metered('meetings.transcribe')`, as the OpenAI-compatible `/audio/transcriptions` request, with a deployment setting for the model and an optional base URL of its own. A self-hoster may point it at a self-hosted Whisper-class server; the open-source core needs no DOS service. The provider gets the audio segments and the language hint only. The summary uses the existing text model under `metered('meetings.summary')` and gets the transcript text, the meeting date and the attendees' names.
- **Which provider Ludy Cloud uses** is an owner decision made in the private Cloud layer (plan Q5); the module stays off there until then.

### 6. Consent

- A meeting accepts audio only after its consent record is written: who confirmed, when, the method (`told_at_start`, `in_invite`, `in_writing`) and the version of the notice shown. The command refuses audio otherwise; the audit row records codes only.
- The record is kept as long as the meeting's text and deleted with it. No signature of each participant in the first slice (plan Q4).
- No voiceprint is stored and no speaker is recognized across meetings. Speaker labels belong to one meeting and are named by a reader.
- The legal reading (Law 91/2025/QH15, Decree 356/2025/NĐ-CP) is commentary until the lawyer answers the plan's section 7 questions; an answer that requires more changes this point by an amendment.

### 7. Retention and shredding

- Three org settings: audio retention (default 30 days after the transcript is ready), video retention (default 7 days, never longer than the audio) and text retention (default 12 months), each stamped on the meeting when it is recorded, so the period participants were told stays true. A meeting whose transcript is never ready (AI off, no model, the kill switch, a spent budget) still gets dates: when it is recorded, its audio and video dates are stamped from the recording time with the same periods (the shortest choice, 7 days, when the setting is "deleted right after"), and the dates move to the transcript's time only if it is ready before them, so no audio waits for a transcript forever.
- At the video or audio date, or when a meeting is deleted, the worker deletes that kind's `media_key` row: every copy of the ciphertext (current and old versions, bucket backups) is unreadable from that moment. The objects are then deleted as the store allows; a lifecycle rule reclaims old versions.
- At the text date, or with the meeting, the module's text rows (drafts and published) are deleted; an unpublished draft goes earlier, after ADR-0049's 30 days. None of them is in the WORM stream, an outbox payload, an audit fact or an activity summary, so database backups are the last copy and expire on their schedule.
- A deletion before its date writes a shred reference (ids only) to the archive store under its object lock; after a restore the replay deletes those keys and rows again (ADR-0017 §8, built here for meetings). Date-based expiries need no reference: the next nightly run repeats them.
- Every column is in the personal-data registry with handling `erase`; transcript text and speaker labels are `pii`, the audio and video references `sensitive`. The org export carries text of meetings shared with the org and never audio or video.

### 8. AI output and tasks

- The transcript is untrusted input (ADR-0018) and everything derived from it is tainted.
- Action items are suggestions on the meeting, not `crove_kernel.proposal` rows: the approval queue is read by approvers who may not be readers of the meeting. The recorder accepts one from the draft, or every clean one in a batch, and after publication any reader may accept a published item; accepting runs `meetings.action_item.accept` as that member, a confirm command on ADR-0049's `MEMBER_VY_SINKS` list, which calls a new kernel helper `kernel.task.create_from_meeting` (the pattern of `kernel.task.create_from_todo`): the task gets the confirmed title, due date and position, `source_ref` to the item, and `tainted` while the AI text is unedited. No RPC route reaches the helper directly.
- Checks in code decide what is clean: a number in the summary or decisions must appear in the transcript (#1237's rule); each item's time names a real segment; dates are parsed by code; the assignee is an attendee with a position; no link, email or phone in a title.

### 9. Budgets and the kill switch

- `meetings.transcribe` and `meetings.summary` count against a `meetings` module budget.
- The meter records the audio seconds of a transcription call and prices them by a deployment setting; before the call it admits on the length the sandbox measured. A refusal defers the meeting (`usage_deferral`, `ai_budget`).
- The existing kill switches (org, module `meetings`, global) stop new calls; recording, storage, playback and deletion go on.
- Caps on length and size per meeting are deployment settings with defaults (plan section 10); video costs storage, not AI.

### 10. Capture, and the Ludy extension

- **Three ways, one pipeline:** (a) the Ludy browser extension for Chrome and Edge records the meeting tab (Google Meet, or Teams and Zoom in the browser) through `chrome.tabCapture` in an offscreen document, mixed with the member's microphone, and the tab's video when ticked; (b) the Ludy app records the microphone for a meeting in a room, on desktop and phone, with no extension; (c) a file is uploaded. All three create the meeting with its consent record first and end as the same staged upload, encryption and sandbox.
- **Not captured:** the Zoom and Teams desktop apps (the member uploads their recording); Safari and Firefox get (b) and (c) only. No bot and no desktop app in this design; a bot is later; a desktop app is not planned, because one recorder app is not worth its maintenance and Ludy has no desktop app today.
- **One extension for every app.** `apps/extension` is the shared Ludy extension (owner, 2026-11-03), not a meetings-only one. Its shell: sign-in with an extension token; an org picker (one token per org); features shown only when their module runs in the org (ADR-0031) and the member holds their permission; and a permission request per feature, so a feature asks the browser for permissions only when the member turns it on. Meeting capture is the first feature, behind module `meetings`. A later feature of another app is behind that app's module (`social` for Ludy Engage) and its own permission; none is planned here.
- **The "capture this page to a command" contract.** For later features, the shell offers one generic path: on the member's click, never in the background, it reads the page in front of the member (its address, its title and the selected text) and sends exactly that to the one kernel command the feature declares. The command runs through `Runtime.execute()` as the member, in the token's org, so it is tenant-checked, authorized and audited like any command, and its input is tainted untrusted content (ADR-0018). A feature declares the command and the browser permissions it needs; the shell asks for those permissions when the feature is turned on (`activeTab` and `scripting` for page capture, never a standing host permission on the sites). Meeting capture does not use the contract.
- **Security of the extension:**
  - least privilege: the base install asks for `storage`, `identity` and a host permission for the one Ludy address configured at setup; meeting capture adds `tabCapture` and `offscreen` when turned on; no broad host permission by default, and never `<all_urls>`, `tabs`, `cookies`, `history` or content scripts declared for sites;
  - no reading of pages unless the member clicks: tab and page capture act only on the tab the member clicked, after the click, so the extension never reaches another tab and starts nothing by itself;
  - all code ships in the package (no remote code), and a CI check holds each manifest's permissions to the declared list.
- **Authentication:** the extension never holds the member's password or browser session. Sign-in opens the Ludy sign-in in a browser window (`chrome.identity.launchWebAuthFlow`); the signed-in member approves the extension for one org (a fresh second factor where the member has one); a one-time code is exchanged with PKCE for an extension token.
- **The extension token:** opaque, kept in the extension's own storage, scoped to one org, one member and the scopes of the features the member turned on. Every command it reaches runs as that member, so it can never do more than the member can. Meeting capture's scope may create a meeting with its consent record, get upload grants for the meetings the token created, finish their upload and read their status; it never reads content. No route outside its scopes accepts it. The kernel stores its hash in `extension_token`, 90 days; it is listed under the member's devices and revoked in one click, and void at once when the member is removed from the org or loses a feature's permission; each use is audited. `authenticate()` treats it as its own kind of credential, so the route enumeration test (#693) lists the routes each scope opens. When ADR-0032's authorization server exists, the extension may move to it as a public client with the same scopes; nothing else changes.
- **Ownership:** Ludy publishes the extension to the Chrome Web Store from the owner's developer account (an owner action); agents hold no store credential. Releases are built in CI from a tag.

## Consequences

- Eight new tenant tables in `crove_meetings` and the kernel's `extension_token`, worker-only definers, two new upload purposes, a blob cipher in a protected package, a new sandbox image with its CI job, a kernel task helper, a new kind of credential on the HTTP edge and a browser extension with its store listing: each step is reviewed by the Platform PO, the tables by the two-step rule.
- Real erasure of audio and video without delete rights on old object versions; the cost is that losing `CREDENTIAL_KEY` loses all meeting media, as it loses channel tokens.
- Ludy carries an extension's lifecycle: store review, browser API changes, and the security of code running in members' browsers. The in-app recorder and the upload keep the module usable when the extension is unavailable. The credential-key runbook says so.
- Owners cannot read attendees-only meetings. Some owners will want to; the share-with-org choice is the answer, and a break-glass read is not offered.
- A meeting's processing depends on ADR-0049's stage B (the background member-scoped run); until it is built, transcription waits.
- Attendees see a meeting's transcript and summary only after the recorder publishes it: one more click, in exchange for no AI output ever reaching other people unreviewed.
- The meter gains a second measure (audio seconds); every report of AI use shows it.

## Alternatives considered

- **Delete audio objects instead of shredding.** Rejected: old versions, bucket backups and object locks keep copies Crove cannot remove.
- **Encrypt transcripts too.** Rejected for the first slice: text rows are mutable and deleted; a key in the database is in the same backups as the text, so it buys nothing without the restore replay, which deletion also gets.
- **Parse media in `crove-extract`.** Rejected: it forbids child processes and native code on purpose; a transcoder in it would weaken the gate for invoices.
- **Transcode in the browser.** Rejected as the only path: decoding an hour of audio in a phone's memory is not reliable, and uploads from other tools would still need the server. The recorder records in a compact format, and the sandbox normalizes everything.
- **A meeting bot** that joins Meet, Zoom or Teams. Deferred: the owner finds bots annoying, each platform needs its own app or agreement, and the extension covers browser meetings. Later, in the plan.
- **A desktop app** that records system audio. Not planned (the owner prefers none): one recorder app is not worth its maintenance, Ludy has no desktop app today, and an upload covers the desktop Zoom and Teams case.
- **An extension for meetings only.** Rejected by the owner (2026-11-03): one Ludy extension with a small shell serves later features of other apps too, with one review, one listing and one token model.
- **The extension on the member's browser session** (reading the app's cookie). Rejected: it would need a host permission that also exposes the session, and the session's scope is everything the member can do.
- **Video always kept.** Rejected: it multiplies storage and exposure (faces, screens) and adds nothing to the transcript.
- **Action items as kernel proposals.** Rejected: they would expose meeting content to approvers who are not readers.
- **Process in the worker's system context.** Rejected by the owner's per-member Vy rule: the system context would read every meeting.
- **Write Vy's results straight to the meeting's readers.** Rejected by the Platform PO's ruling on ADR-0049 (option (a)): a result reaches other people only through the member's own click.

## Revisit when

- The lawyer's answers change what consent needs.
- A meeting bot or live notes are planned (consent inside the call, a connector's credentials).
- A second app plans an extension feature: its plan names its command, scope and browser permissions under point 10's contract.
- Teams exist, so a meeting can be shared with a team.
- Search or the personal-data finder reach transcripts (a folded index of private text).
