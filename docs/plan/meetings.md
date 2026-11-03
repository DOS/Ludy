# Ludy Meetings: AI meeting notes, plan

> Plan for epic [#932](https://github.com/DOS/Ludy/issues/932), 2026-11-03. Owner direction the same day: "Okay đưa nó đi. Rồi tao bàn với nó. Nói nó là làm lean, core feature trước và AI first nhé" (go ahead; the owner discusses it first; lean, core features first, AI-first). Revised the same day after the owner's input on capture: "Tao thấy option extension là ổn nhất mà, không cần bot, không cần cài app mà ghi âm, record video đều được" (a browser extension is the best option: no bot, no app to install, and it records audio and video). **A proposal: nothing here is built, no build issue is opened, no money is spent and no provider was contacted.** The owner discusses it and answers section 14 before any build. The decision record is [ADR-0047](../adr/0047-meeting-notes-audio-and-transcripts.md) (Proposed); a Vietnamese summary for the owner is [meetings.vi.md](meetings.vi.md). It replaces the scope paragraph of the kernel plan's §13 "Meeting Notes" once accepted. The legal points of section 7 are commentary until a lawyer (#62) confirms them.

## 1. The user and the weekly job

The owner of a one-person company or a small team meets every week: with staff on Monday, with a customer to agree a quote, with a supplier on prices and dates. Today what was said lives in someone's head or a phone voice memo nobody replays, and the promises made ("anh gửi báo giá trước thứ Sáu") are forgotten.

After the first slice, that person can:

1. capture the meeting one of three ways: with the Ludy browser extension for an online meeting in Chrome or Edge (Google Meet, or Teams and Zoom opened in the browser), with the microphone in the Ludy app for a meeting in a room, or by uploading a recording;
2. confirm that everyone in the meeting was told it is recorded;
3. get back, a few minutes after the meeting, a Vietnamese transcript with timestamps (and speakers when the provider gives them), a short summary, the decisions taken, and the action items with who and when;
4. turn the action items into team tasks with one click each, or one click for all the clean ones;
5. keep the video too when they tick it for that meeting;
6. know that the audio is gone after 30 days, a kept video after 7, and the transcript after the period the org chose.

## 2. What the owner decided

- 2026-10-21, Decision 19 of the kernel plan: an optional `meetings` module is on the roadmap, after M3 by default unless the owner or a pilot customer pulls it forward.
- 2026-10-31 and 2026-11-02 ([scope.md](../product/scope.md)): OPC and SME first, core features first, AI-first; AI is a coworker, never an "assistant"; Vy is the general manager across apps.
- 2026-11-03, on [#1677](https://github.com/DOS/Ludy/issues/1677): each member has their own Vy, which sees exactly what that member can access; org-wide outputs carry nothing private.
- 2026-11-03, this plan: lean, core first, AI-first; the owner discusses before anything is built.
- 2026-11-03, capture: a browser extension is the main path for online meetings, with no bot and no desktop app; it records audio and, when chosen, video. The owner accepts that people are used to meeting bots but finds them annoying, so the bot stays later.
- 2026-11-03, the extension is the shared Ludy extension, useful to Ludy Engage too later; meetings is its first feature (section 5.6).
- 2026-11-04, video (Q7, decided): "Có option cho cái extension là được mà? mặc định voice only, có thêm nút check record video thôi" (an option is fine: voice only by default, plus a "record video" checkbox). Audio only by default; a "Ghi cả video" checkbox in the extension and in the in-app recorder, set per meeting.

## 3. The scope gate

- **Fit.** An owner or salesperson of a small business meets several times a month, and the weekly job (remember what was agreed and follow it up) is the one this shortens. Enterprise features (a bot in every call, compliance recording, meeting analytics for managers) wait (section 11).
- **Smallest slice.** One person, the defaults, no setup beyond adding the extension once: capture, confirm the notice, read the result, accept the tasks. Three settings only, all needed by law or cost: how long audio, video and transcripts are kept (section 9).
- **AI part, named.** In the meeting screen Vy (`{gm}`) transcribes, summarizes, lists the decisions and drafts the action items, each with a link to the moment in the transcript it comes from. Review stays short: items whose checks pass are accepted in one batch. Model calls go through `metered()` under `withAiScope` with new `AI_FEATURES` keys `meetings.transcribe` and `meetings.summary`. AI output is tainted; a person approves every task. With AI off the module still records, stores, plays back and takes typed notes and tasks.
- **Proportionate security.** Tenancy, approvals and the personal-data rules stay as they are; a meeting gets the narrowest readers that work (section 8), because a recording holds voices of people who are not members.

## 4. What exists today

| What | Where | Use here |
|---|---|---|
| Files: staged uploads, content address, create-only writes, versioned buckets; per-purpose size caps (`document`, `social`, `import`) | `crove_kernel.file`, [ADR-0013](../adr/0013-evidence-storage-and-integrity.md), `packages/kernel/src/commands.ts` | new purposes `meeting_audio` and `meeting_video` with their own caps; the stored bytes are ciphertext (section 6) |
| Parsing sandbox (T12): no network, no child processes, no native code, 25 s per parse | `apps/extract` | the model for a separate media sandbox; `crove-extract` itself cannot run an audio transcoder |
| The AI layer: one OpenAI-compatible endpoint, `metered()`, `withAiScope`, `AI_FEATURES`; the meter counts tokens | `packages/agent/src/index.ts`, `packages/agent/src/meter.ts` | the transcription and summary calls; the meter needs an audio-seconds measure, since transcription is billed by length |
| Budgets per org, module and agent; "Dừng AI" kill switches per org, module and agent and a global one; work waiting for the budget | `crove_kernel.budget_policy`, `kill_switch`, `global_kill_switch`, `usage_deferral` (`ai_budget`) | a `meetings` module budget and kill switch |
| A numbers check on AI text | `summaryNumbersOutside` (#1237) in `packages/agent/src/summary.ts` | the summary may state no number the transcript does not hold |
| Tasks with `tainted` and `source_ref`; a module creates one through a kernel helper | `crove_kernel.task`, `kernel.task.create_from_todo` in `packages/kernel/src/agents.ts` | a `kernel.task.create_from_meeting` on the same pattern |
| Per-user restrictive row policies; definers that return no text to the worker | `crove_notes` ([ADR-0037](../adr/0037-private-notes-and-todos.md)) | the readers of a meeting |
| The credential vault's envelope (AES-256-GCM under `CREDENTIAL_KEY`) | `packages/kernel-runtime/src/vault.ts` (ADR-0025) | wrapping each meeting's audio key |
| Crypto-shredding with subject keys: designed in [ADR-0017](../adr/0017-crypto-shredding.md), **not built** (the #1949 build shipped the "keep it out" part only) | | this plan builds a per-meeting key on the same envelope; it does not wait for subject keys |
| Personal-data registry and finder, org purge, org export | `packages/kernel/src/personal-data.ts` (#923), `crove_kernel.org_purge` (#1024), #38 | the meetings tables join each |
| Scoped tokens for software other than the app: the OAuth 2.1 authorization server of [ADR-0032](../adr/0032-oauth-authorization-server.md), **proposed, not built** | | the Ludy extension gets its own narrow extension token (section 5.7) |
| No browser extension exists | | `apps/extension`, the shared Ludy extension, is new (section 5.6) |
| Module enablement | `CROVE_MODULES`, `AVAILABLE_MODULES` in `apps/kernel/src/config.ts` (ADR-0031) | `meetings` is off unless listed |
| The member's own Vy (#1677) | designed in the planned ADR-0037 addendum for notes N8, **not built** | meeting jobs run as the member's Vy (sections 6 and 8) |

## 5. The first slice

### 5.1 The flow

1. **New meeting** (in Ludy Notes, Vy's app, as a "Cuộc họp" tab): a title (pre-filled with the date), the language (Vietnamese by default, or English or automatic), and the attendees who are members of the org (optional).
2. **The notice.** Before recording starts or an upload is accepted, the person ticks "Mọi người trong cuộc họp đã được báo là cuộc họp được ghi âm" and picks how they were told (said at the start, written in the invite, agreed in writing). The screen shows a one-sentence notice to read aloud. The server refuses audio for a meeting without this record (section 7).
3. **Capture** one of the three ways of section 5.5, with the "Ghi cả video" checkbox off by default (owner decision of 2026-11-04). A recording is saved as it goes on the person's device, so a closed tab does not lose it, and uploaded when stopped. Only the audio is kept unless the person ticked video for this meeting.
4. **Processing** (a job, section 6): the media sandbox checks and normalizes the audio; Vy transcribes it; Vy drafts the summary, decisions and action items. The meeting shows "Đang chép lời", then the result. A notification tells the person when it is ready.
5. **Review.** The transcript with timestamps; speakers as "Người nói 1, 2..." when the provider separates them, renamed by the person for this meeting; the text can be corrected. Beside it, the summary, the decisions and the action items, each drafted item styled "Đề xuất" with a link to its moment.
6. **Tasks.** "Tạo việc" on an item, or "Tạo N việc" for all clean items, creates team tasks (section 5.3).

### 5.2 The transcript

- Vietnamese first; the provider gets the language hint; mixed English words stay as spoken.
- Segments with start and end times; speakers only where the provider returns them. No speaker recognition across meetings: that would keep a voiceprint, which the law likely treats as biometric data (section 7).
- Audio plays from any segment. A corrected segment keeps its times.

### 5.3 Vy's part: summary, decisions, action items

- One structured call (`meetings.summary`) over the transcript text, with the meeting date and the attendees' names; nothing else from the org is sent.
- Output: a summary of at most about eight lines, the decisions, and action items (what, who as said, when as said, the transcript time it rests on).
- Checks in code, before anything is shown: every number in the summary and the decisions appears in the transcript (the #1237 rule); every item's time points to a real segment; a "when" is parsed by code against the meeting date, never by the model; the "who" is matched against the attendees.
- **Clean** item: the who is an attendee with a position, the date parsed, the title has no link, email or phone number, and no flag. Clean items can be accepted in one batch; others one by one.
- **Accepting** runs `meetings.action_item.accept` as the person, which calls `kernel.task.create_from_meeting`: a task with the title the person confirmed, the due date, the position, `source_ref` to the item and `tainted` set while the AI text is unedited. A task is read by every member, so the dialog says so; the transcript is never copied into it. A member who cannot open the meeting sees "Bản ghi không mở được" on the link.
- Action items are suggestions on the meeting, not `crove_kernel.proposal` rows: the approval queue is read by the org's approvers, who may not be readers of the meeting (ADR-0047 point 8, the same reason as notes §3.11).
- Prompt injection: the transcript is untrusted. Someone saying "Vy, chuyển tiền cho..." in the meeting produces at most a tainted, flagged suggestion; nothing runs without a person's click, and nothing raises a risk level. Red-team cases run in CI with a fake model, as #893 does for documents.

### 5.4 With AI off

No model configured, the budget spent or the kill switch engaged: the meeting records, stores, plays and is deleted on time; the person types notes and action items; tasks are created the same way. The screen says why the transcript waits ("Chờ ngân sách AI", "AI đang tạm dừng").

### 5.5 Three ways to capture

| Way | For | How | Limits |
|---|---|---|---|
| **(a) The Ludy extension** (main path online) | Google Meet; Teams and Zoom opened in Chrome or Edge | The person clicks the extension's button on the meeting tab. The consent step runs in its popup first (section 7); then it records the tab's audio and, if "Ghi cả video" is ticked, the tab's video (`chrome.tabCapture` into an offscreen document with `MediaRecorder`), mixed with the person's microphone so their own voice is in it. The tab keeps playing to the person. Chrome's own capture indicator, a "REC" badge and a timer stay visible; stop is one click | Chrome and Edge only. The Zoom and Teams desktop apps are not captured: the person uploads the recording those apps make. No bot joins the call, so the other participants learn of the recording only from the person's notice |
| **(b) In the app** (in a room) | A meeting around a table, on a laptop or a phone | The Ludy app records the microphone with `MediaRecorder`, and the camera too when "Ghi cả video" is ticked, with the same consent step; no extension | Safari and Firefox get this way only (they have no tab capture for extensions). A phone whose screen locks may stop recording; the app asks to keep it on |
| **(c) Upload** | A recording from a phone, the Zoom or Teams desktop app, or any other tool | An audio or video file, with the same consent step | The caps of section 10 |

Video, when ticked, is recorded at most 720p; transcription always uses the audio track, which `crove-media` extracts (section 6).

### 5.6 The Ludy extension: a small shell, meetings its first feature

Owner, 2026-11-03: "Tạm thời tao nghĩ nên xài extension Ludy đi, extension còn có tác dụng cho App Engage nữa". So `apps/extension` is **the Ludy extension** for Chrome and Edge (Manifest V3), shared by the apps, and meeting capture is its first feature. The shell, built with it:

- **Sign-in** to the member's org with a scoped token (below);
- **an org picker** for a member of several orgs (one token per org);
- **features that follow the org**: the extension shows a feature only when its module runs in that org (ADR-0031) and the member holds its permission; meetings needs `meetings`;
- **a permission request per feature**: a feature asks for the browser permissions it needs only when the member turns it on, and gives them back when turned off; the base install asks for almost nothing;
- **a generic "capture this page to a command" contract** for later features (ADR-0047 point 10): on the member's click only, it reads the page in front of them (its address, its title and the selected text) and sends that to exactly one kernel command the feature names, run as the member in that org, tenant-checked, audited and tainted. Meetings does not use it.

**Later uses (an idea, not a commitment).** Other apps may add features to the shell through that contract, for example Ludy Engage bringing a lead or a conversation from a page into Hộp thư. That is for the Engage line to plan; no Engage feature is planned or built by this plan.

### 5.7 The extension's threat model

The extension runs in the member's browser, beside their other tabs, so it is held to the least it needs. Ludy owns its review, permissions, updates and security.

- **Least privilege, no broad host permissions.** The base install asks for `storage` and `identity` and a host permission for the one Ludy address the member signs in to (`app.ludy.vn`, or a self-hosted address the member types, asked at setup as an optional host permission). Meeting capture, when turned on, adds `tabCapture` and `offscreen`, and no host permission on any meeting site. A later page-capture feature would add `activeTab` and `scripting` when turned on, and nothing that reaches a site in the background. Never `<all_urls>`, `tabs`, `cookies`, `history` or content scripts declared for sites.
- **No reading of pages without a click.** Tab capture and page capture work only on the tab where the member clicked, after that click; the extension never reads another tab and starts nothing by itself.
- **How it authenticates.** It never sees the member's password or the app's session. Sign-in opens the Ludy sign-in page in a browser window (`chrome.identity.launchWebAuthFlow`); the signed-in member approves "Cho phép tiện ích Ludy làm việc với tổ chức X" (with a fresh second factor where the member has one), and the extension exchanges a one-time code with PKCE for an **extension token**.
- **The token.** One org, one member, and the scopes of the features the member turned on. Meeting capture's scope: create a meeting with its consent record, get upload grants for the meetings this token created, finish the upload, and read those meetings' status (processing or ready, never their content). No other route answers it, and every command it reaches runs as that member, so it can never do more than the member can. It is kept in the extension's own storage; the kernel stores only its hash. It expires after 90 days, is listed under the member's connected devices and revoked there in one click, and is void at once when the member is removed from the org or loses a feature's permission. Every use is an audit row. A stolen token can at most do the turned-on features' acts as that member, under the rate limits and the AI budget.
- **Code and updates.** All code ships in the package (Manifest V3 runs no remote code); dependencies are pinned and few; a release is built in CI from a tag and published to the Chrome Web Store from the owner's developer account (an owner action); Edge installs it from the same store. A store review or a policy change can delay a fix, so the in-app recorder and the upload keep working without the extension.
- **Recordings on the device** live in the extension's own storage only until they are uploaded, then are deleted.

## 6. Audio storage and the transcription provider

- **Storage.** Audio is a `kernel.file` of purpose `meeting_audio`, with a neutral name (`meeting-<id>.opus`); a kept video is a file of purpose `meeting_video` under its own key (below). File rows are visible to every member, so the bytes stored are **ciphertext**: the claim step encrypts the upload with the meeting's own data key (AES-256-GCM in chunks), wrapped under the deployment key like a channel credential. The generic file download refuses this purpose; playback goes through the meetings module, which checks the reader and decrypts. The original upload is deleted once normalized; the normalized audio (mono Opus at about 24 kbit/s, about 11 MB an hour) stays.
- **Video, only when the person ticks it** for a meeting: kept as recorded (repackaged by the sandbox, not re-encoded), encrypted under a second data key of the meeting, its **video key**, so it is shredded on its own date, before the audio. Without the tick, the video track of a capture or an upload is dropped in the sandbox and never stored. Playback of video is a `sensitive` read like audio.
- **Media sandbox.** Checking, splitting and transcoding run in a new container, `crove-media` (ffmpeg only, no network, no secrets, read-only, CPU, memory and time limits, the hardening of `crove-extract`), never in the API or the worker. It extracts the audio track of a video, and answers normalized audio segments of at most 10 minutes, so every provider's request cap holds.
- **Provider boundary.** Transcription goes through `packages/agent` like every model call: the OpenAI-compatible `/audio/transcriptions` request, a deployment setting for the model and optionally its own base URL, so a self-hoster points it at a self-hosted Whisper-class server (for example whisper.cpp's server, a faster-whisper based server, or vLLM) and audio never leaves the org's machine. Vietnamese fine-tuned Whisper models exist; their licences and quality are checked in step 4. Whether the AI SDK's OpenAI-compatible provider covers transcription, or `packages/agent` needs a small client, is checked in step 4 too. The summary uses the existing text model.
- **What leaves.** The provider gets the audio segments and the language hint, nothing else. A provider outside Vietnam is a cross-border transfer for the org (section 7); the deployment's sub-processor list names it.
- **The job runs as the member's Vy** (the #1677 rule): in the sealed context of the member who started it, so it reads only that meeting, never in the worker's system context.

## 7. Consent under Vietnam's personal data law

Law 91/2025/QH15 on Personal Data Protection (in force 2026-01-01) and its Decree 356/2025/NĐ-CP, which replaced Decree 13/2023/NĐ-CP. Read through the repository's earlier survey ([payroll.md](payroll.md) row 21) and commentary only: **[commentary]**, the lawyer (#62) confirms.

- **Who is the controller.** The org that records. Ludy is the tool and, in Ludy Cloud, a processor. The org must tell participants; the product makes that step unavoidable and records it.
- **Who must be told.** Everyone whose voice is recorded: members, customers, suppliers, candidates, people joining remotely. Consent must be clear and freely given; silence is not consent; it can be withdrawn.
- **How the UI records it.** On the meeting row, before any audio is accepted: who confirmed, when, how participants were told (said at the start, in the invite, in writing) and the version of the notice text shown. The audit row records the act with codes only. The server refuses audio without it. During recording the timer and a red dot stay visible.
- **Withdrawal.** A participant who objects: the person pauses, or deletes the meeting; deletion shreds the audio at once (section 9).
- **Voice as biometric data.** The law names biometric data sensitive. Slice 1 keeps no voiceprint and does no recognition across meetings; whether a provider's per-meeting speaker separation is biometric processing is a lawyer question.
- **Cross-border.** A provider abroad needs the org's transfer assessment; a self-hosted model avoids it. The impact assessment exemptions for household businesses and small enterprises, and whether they reach Ludy as a processor, are already open lawyer questions (payroll.md row 21).
- **Not verified:** whether recording a private meeting needs every participant's consent or the org's legitimate purpose suffices; whether the confirmation of the recorder is enough evidence of notice. Both go to the lawyer.

## 8. Who reads a meeting

Proposed in ADR-0047 point 2, an owner decision (section 14, Q2):

- **Readers:** the member who recorded it, and the members named as attendees. The recorder may share it with the whole org (owners, admins and members whose scope covers the org).
- **Owners and admins** do not read a meeting shared only with attendees; they see that it exists (date, length, recorder) for budgets and retention, and an owner can delete it for a personal-data request without reading it.
- **Viewers, org-chart agents and the system context** read nothing. The worker reaches meeting rows only through named definers that return ids and dates (retention, purge); a member's processing job reads its one meeting in that member's own context (section 6).
- **Vy:** the member's own Vy reads what the member reads. Its meeting results (transcript, summary, items) are stored on the meeting, readable by the meeting's readers only, because they come from the meeting alone. Org-wide outputs (the team brief, digests, proposals others approve) carry no meeting content; a meeting ready for review shows only on its readers' own Home.

## 9. Retention and crypto-shredding

- **Three settings** (owner or admin): audio kept for 30 days after the transcript is ready by default (or deleted right after, 7 or 90 days); a kept video 7 days by default (or 30 days; never longer than the audio); transcripts, summaries, decisions and items kept 12 months by default (or 3, 24 months, or until deleted). A change applies to meetings recorded afterwards, so the period participants were told stays true.
- **Audio and video are shredded, not deleted.** Each meeting's audio key and video key live in mutable rows no login role reads. At the end of each one's retention, or when the meeting is deleted, its key row is deleted: the ciphertext in the bucket, its old versions and every backup of the bucket become unreadable at once. The objects are then removed as the store allows (Crove holds no permission to delete old versions; a lifecycle rule reclaims the space).
- **Text is deleted.** Transcript, summary, decisions and items are rows of the module, deleted by the nightly job at the end of their retention or with the meeting. They are in no WORM batch, no outbox payload, no audit fact and no activity summary (ids and codes only), so database backups are the last copy, gone when the backups expire (30 days on the pilot, M1-7).
- **Backups and restores.** A restore brings back keys and rows: the date-based ones are shredded again by the next nightly run; a deletion before its date is written as a shred reference to the archive store and replayed after a restore (the mechanism of ADR-0017 §8, built here for meetings).
- **Derived items.** A task created from an action item is the org's work record and stays, with the text the person confirmed; its link then reads "Cuộc họp đã xóa". A summary saved into a note (notes step N10, #1679) belongs to that note.
- **The window, stated in the privacy notice:** audio and video unreadable at the moment of shredding; the plaintext upload removed from staging within one day; text gone from backups when they expire.
- **Org purge and export.** The purge deletes every meeting row and key of the org. The export carries the transcripts and summaries of meetings shared with the org, never audio or video; attendees-only meetings are left out, as private notes are, and each reader may download their own meeting before.

## 10. Budgets and the kill switch

- Two feature keys in `AI_FEATURES`, both counting against a `meetings` module budget: `meetings.transcribe` and `meetings.summary`.
- **The meter learns audio length.** A transcription call records the audio seconds next to the tokens, priced by a deployment setting per audio minute (no price in this plan). Before the call the meter is asked with the length the sandbox measured, so a long recording cannot overrun the budget; refused, the meeting waits (`usage_deferral` `ai_budget`) and starts when the month turns or the owner raises the budget.
- **Caps** (proposed): 2 hours a meeting; an audio upload up to 300 MB; with video, up to 2 GB; the per-minute upload rate of the file grants applies. Video costs storage, not AI: only its audio is transcribed.
- **Kill switch:** the existing "Dừng AI" for the org, the `meetings` module or the whole deployment stops new transcription and summary calls; calls in flight finish; recording and storage go on (section 5.4).

## 11. What comes later (not in the first slice)

- **Links:** a meeting linked to a party, a deal or a calendar event (ADR-0024); a booking's meeting opens a meeting record; notes link to meetings (N10, #1679).
- **Search** across the meetings a member can read, with the Vietnamese folding of Finance's search.
- **A follow-up email draft** to the participants, sent by a person through the Email module (R2).
- **A bot that joins Meet, Zoom or Teams** through a connector, and live notes during the call. Each needs an OAuth app or a vendor agreement (owner action) and a consent flow inside the call. The extension covers the browser case without it.
- **The extension on the Edge Add-ons store**, if Edge users cannot install from the Chrome Web Store.
- **The personal-data finder in transcripts** (match a person's email, phone or tax code in free text, as notes N9), with the GA gate.
- **Native recording on phones**, where a locked screen stops a browser recording.
- **Not planned:** a desktop app (owner preference, 2026-11-03): one recorder app is not worth its maintenance, Ludy has no desktop app today, and the extension, the in-app recorder and the upload cover the cases. Nor speaker recognition across meetings (voiceprints), meeting analytics for managers, or recording without a notice.

## 12. What needs a person who is not an agent

| Who | What | Why |
|---|---|---|
| A lawyer (#62) | The questions of section 7: consent for a private meeting, the recorder's confirmation as evidence, voice and speaker separation as biometric data, cross-border transfer to a transcription provider, the impact assessment for orgs that record | none was read in primary text |
| The owner, or people the owner asks | Record 5 to 10 scripted Vietnamese meetings (two to five voices, regional accents, some English words, background noise) with written consent of every voice, for the eval set; the scripts are committed, the audio is stored outside the public repo | the word error rate is measured on a fixed set (the kernel plan's exit criterion) |
| The owner | A Chrome Web Store developer account for the org that publishes Ludy, the store listing (name, icon, privacy answers) and each publication of a release CI built | Ludy owns the extension's listing and updates; an agent holds no store credential |
| The owner | The decisions of section 14; for Ludy Cloud, which transcription endpoint the hosted service uses and its spending (in the private Cloud layer) | new spending and data residency |

## 13. Risks

- **Vietnamese accuracy.** Accents, crosstalk and phone audio lower quality; a bad transcript makes a bad summary. Mitigation: the eval set gates a model change; every item links to its moment so a person checks the source in one click.
- **Secret recording.** The product cannot prove participants were told; it records who confirmed what. The privacy notice and the terms put the duty on the org.
- **Tasks leak meeting content.** A task is org-visible; the dialog says so and only the confirmed title goes in.
- **A dependency on the member's Vy.** The member-context run (#1677, the ADR-0037 addendum) is not built. It has one owner, the Platform PO, and is built once for notes N8 and meetings; step 4 waits for it.
- **Cost of long audio.** The pre-call admission on measured length and the caps bound it.
- **A new container.** `crove-media` is one more image to pin, harden and test in CI; it keeps hostile media out of the API and the worker.
- **The extension is ours to keep safe.** A compromised release would run in members' browsers. The permissions of section 5.7, no remote code, CI-built releases and the owner's account are the controls; the store's review adds days to any fix.
- **Browser and store changes.** Chrome may change tab capture or the store's policy; Safari and Firefox users get the microphone only; the Zoom and Teams desktop apps stay outside. The in-app recorder and the upload are the fallback for each.
- **Video multiplies exposure.** Faces, screens and much larger files; hence off by default, a separate key and a short default retention.

## 14. Decisions for the owner

| # | Decision | Recommendation | Why | If no answer |
|---|---|---|---|---|
| Q1 | When is the first slice built? | Steps M1 to M11 in M3 at P2, after M3's P0 and P1 work; the rest in the Icebox at P3 | Owners meet weekly, and this is a feature an OPC feels on day one; it does not compete with the monthly close work of M2 | It stays in the Icebox (Decision 19's default) |
| Q2 | Who reads a meeting? | The recorder and the member attendees; the recorder may share it with the org; owners and admins see that it exists and may delete it, not read it | Meetings hold talk about pay, customers and people; the same rule as private notes (ADR-0037) and the per-member Vy rule | Built as recommended |
| Q3 | How long are audio, video and transcripts kept by default? | Audio 30 days after the transcript is ready; a kept video 7 days (or 30); transcript and its results 12 months; all changeable | Audio is the most sensitive part and is only needed to check the transcript; video multiplies exposure (faces, screens) and a week is enough to look back at a shared screen; a year of text covers follow-up | Built as recommended |
| Q4 | How strong is the consent step? | A required confirmation with the method and a notice to read aloud, recorded on the meeting; no per-participant signature in the first slice | It costs the user ten seconds and leaves a record; signatures from customers would kill the feature for small teams | Built as recommended, pending the lawyer |
| Q5 | Where does audio go for transcription in Ludy Cloud? | A Whisper-class model run in Vietnam with no retention, chosen in the private Cloud layer; the module stays off in Ludy Cloud until chosen | Voices of customers are personal data, and a transfer abroad needs an assessment | Self-hosters choose their own; Ludy Cloud keeps the module off |
| Q6 | Where does it live in the app? | A "Cuộc họp" tab in Ludy Notes, done by Vy | Notes is Vy's app, and a meeting's summary becomes a note later (N10) | Built as recommended |

Decided: **Q7, video** (owner, 2026-11-04: "Có option cho cái extension là được mà? mặc định voice only, có thêm nút check record video thôi"): audio only by default; a "Ghi cả video" checkbox in the extension and in the in-app recorder, per meeting; a kept video has its own key; transcription always uses the audio.

## 15. Build steps

Step ids M1 to M11 and L1 to L5 name the steps of this plan, not the milestones M1 to M3 of the backlog review; the milestone column says "M3" for the milestone M3 Paid pilot. One issue, one worktree, one PR each, end to end. New tenant tables go by the two-step rule (the invariant PR first). Milestone and priority as proposed in Q1; the issues are opened after the owner approves.

| # | Step | Scope | Acceptance | Files | Milestone, priority | Protected |
|---|---|---|---|---|---|---|
| M1 | Invariants first | RLS matrix row factories for the meetings tables, listed pending; `meetings-readers.db.test.ts`: a non-reader member, owner, admin, viewer, entity-limited member, agent and the system context read and write nothing of an attendees-only meeting; no login role reads the key table; definers return no text | The suite runs green with the tables pending; the base copy runs it on later PRs | `apps/kernel/test/invariant/**` | M3, P2 | Yes |
| M2 | A meeting with its audio and video | `modules/meetings` (manifest, data classes, permissions); tables for meetings, readers, audio segments, videos and keys; purposes `meeting_audio` and `meeting_video` with their caps; the video tick and its own key; encryption at claim, playback through the module, generic download refused; the consent record required; upload, list and meeting screens; delete by the recorder or an owner shreds the key; `CROVE_MODULES` gating | Upload refused without consent; stored bytes are ciphertext; a non-reader gets nothing; after delete the audio does not decrypt; with the module off nothing loads | `modules/meetings/**`, `packages/kernel-contract/src/index.ts`, `packages/kernel/src/commands.ts`, `packages/kernel-runtime/src/**` (blob cipher), `apps/kernel/src/**`, `apps/app/src/**`, a migration | M3, P2 | Yes |
| M3 | Media sandbox | `apps/media` image `crove-media` (ffmpeg, no network, limits); probe length, normalize to mono Opus, split into 10-minute segments, extract the audio track of a video, repackage a kept video or drop its track; compose service on an internal network; CI image job with the no-egress checks | A 2-hour file is normalized within the time limit; a malformed or hostile file fails cleanly; the container reaches nothing outside | `apps/media/**`, `docker-compose.yml`, `.github/workflows/ci.yml`, a `package.json` | M3, P2 | Yes |
| M4 | Transcription | `meetings.transcribe` in `AI_FEATURES`; the transcription client in `packages/agent`; audio seconds in the meter and admission on measured length; the job as the member's Vy; module budget and kill switch; transcript screen with speakers, timestamps and corrections; the eval of word error rate on the fixed set in `ai-eval` | A one-hour Vietnamese meeting is transcribed within the time measured on the reference provider; WER reported; the budget refuses before the call; the kill switch stops it; AI off leaves a working meeting | `packages/agent/**`, `apps/kernel/src/ai-meter.ts`, `modules/meetings/**`, `.github/workflows/ai-eval.yml`, a migration | M3, P2 | Yes |
| M5 | Retention and shredding | The three settings; the nightly job (shred audio and video keys, delete text) through worker-only definers; shred references in the archive store and their replay; org purge and export; personal-data registry entries | A meeting past its video or audio retention does not decrypt that part; its text is gone after its own retention; a restore followed by the replay leaves no deleted meeting readable; purge leaves no row | `modules/meetings/**`, `apps/kernel/src/org-purge.ts`, `apps/kernel/src/retention.ts`, `packages/kernel/src/personal-data.ts`, a migration | M3, P2 | Yes |
| M6 | Summary, decisions, action items | `meetings.summary`; the checks of section 5.3; items as suggestions; accept one or all clean; `kernel.task.create_from_meeting`; red-team transcripts in CI with a fake model | No task without a person's click; an injected instruction stays a flagged suggestion; a number not in the transcript refuses the summary; a non-reader sees "Bản ghi không mở được" on the task | `packages/agent/**`, `packages/kernel/src/agents.ts`, `modules/meetings/**`, `apps/app/src/**` | M3, P2 | Possibly (a migration) |
| M7 | Record in the app | The in-app recorder (way b): the microphone, and the camera when "Ghi cả video" is ticked, with timer, pause and the consent gate; saved on the device as it goes; upload on stop; recovery of an interrupted recording | A 60-minute recording survives a reload; recording cannot start without the confirmation; Chrome, Edge, Safari and Firefox files all normalize | `apps/app/src/**`, `modules/meetings/**` | M3, P2 | No |
| M8 | The extension token | The sign-in page in the app with the org choice, the one-time code with PKCE, the extension token (one org, one member, the scopes of the turned-on features, 90 days, hashed, audited), the connected-devices list and revoke, the routes each scope opens and nothing else, the meetings scope first; void when the member is removed or loses a feature's permission | A token is refused on every route outside its scopes; the meetings scope cannot read a meeting's content; a revoked or expired token, or one of a removed member, is refused at once; the route enumeration test (#693) lists its routes | `apps/kernel/src/auth*.ts`, `apps/kernel/src/http.ts`, `modules/meetings/**`, `apps/app/src/**`, a migration, an invariant test | M3, P2 | Yes |
| M9 | The Ludy extension, with meeting capture | `apps/extension` (Manifest V3, Chrome and Edge): the shell (sign-in, org picker, features shown by module enablement and the member's permission, a permission request per feature, the generic page-capture contract defined but used by no feature yet) and its first feature: the popup with the consent step and the "Ghi cả video" checkbox (off by default), tab capture in an offscreen document mixed with the microphone, "REC" badge and timer, saved on the device and uploaded to the meeting on stop; setup for `app.ludy.vn` or a self-hosted address; a CI job that builds the package from a tag and checks the manifest's permissions against a fixed list | On Google Meet in Chrome and Edge, a 60-minute meeting arrives with both sides' voices; recording cannot start without the consent step; the base install and the meetings feature ask for nothing beyond the list of section 5.7; with `meetings` off in the org the feature does not show; no request goes anywhere but the configured Ludy address; with video ticked the video arrives, otherwise none is stored | `apps/extension/**`, its `package.json`, `.github/workflows/ci.yml`, `knip.jsonc` | M3, P2 | Yes (`package.json`, workflow) |
| M10 | owner-action: Chrome Web Store | The developer account, the listing and its privacy answers, the first publication | The extension is installable from the store; the steps are in a runbook without any credential | none | M3, P2 | No |
| M11 | owner-action: lawyer and eval recordings | The questions of section 7; 5 to 10 consented scripted meetings for the eval set | Answers recorded on the issue and section 7 updated; recordings stored outside the repo, scripts committed | none | M3, P2 | No |
| L1 | Links to parties, deals and calendar events | Link a meeting; a booking opens one | A deal shows its meetings to their readers only | `modules/meetings/**`, `modules/crm/**` | Icebox, P3 | Yes (migration) |
| L2 | Search across meetings | Folded search over readable transcripts | A member finds only meetings they read | `modules/meetings/**` | Icebox, P3 | Yes (migration) |
| L3 | Follow-up email draft | Vy drafts, a person sends (R2) through Email | Nothing is sent without a person | `modules/meetings/**`, `packages/agent/**` | Icebox, P3 | No |
| L4 | Meeting bot and live notes | A connector joins Meet, Zoom or Teams; consent inside the call; live notes in the extension | Needs the owner's OAuth apps or vendor agreements | `packages/channel/**`, `modules/meetings/**` | Icebox, P3 | Yes |
| L5 | Personal-data finder in transcripts | Match a person's values in transcript text; counts for meetings the owner cannot read | An erasure request reaches every meeting that names the person | `packages/kernel/src/personal-data.ts`, `modules/meetings/**` | GA gate, P2 | Yes |

Each issue's acceptance says what Vy does on that screen, that the core works with AI off, and that a person approves every task.
