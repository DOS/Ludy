# 0055. Three capture paths, one meeting: extension, desktop app, bot

- Status: **Accepted** (owner decision 2026-11-20 UTC / 2026-11-21 +07:00, AI Meeting Notes PO popup A2, [#3986 comment](https://github.com/DOS/Ludy/pull/3986#issuecomment-7048557563)). JOY approved all 10 recommendations below ("Đồng ý cả 10 đề xuất trong ADR-0055: làm xong lát 1 chống ghi trùng trước, sau đó làm app máy tính Electron thuộc khung chung Platform (Windows trước macOS), thêm câu hỏi luật sư #2585/#62 ngay, chưa mua tài khoản ký phần mềm hay làm bot vội"): Slice 1 ([#4123](https://github.com/DOS/Ludy/issues/4123), the one-meeting rule on existing capture paths) ships first; `Ludy Desktop` reverses the 2026-11-03 "no desktop app" decision as a general Platform-owned (`line:platform`) Electron shell with meeting capture first (Windows before macOS); the section 5 non-bot capture legal questions go to `#2585` / `#62` immediately (gating Slice 3); software-signing accounts wait until Slice 2 is approved; ADR-0052 open bot questions 2, 3, 4, 6, 7, 8 remain open and unanswered (no bot build now); and a Slack/Lark-style chat module stays outside current plans until a separate owner decision and its own ADR.
- Date: 2026-11-20 (proposed 2026-11-19; accepted 2026-11-20 UTC / 2026-11-21 +07:00)
- Deciders: owner (JOY) for the 10 decisions in "Owner decisions" (approved 2026-11-20 UTC / 2026-11-21 +07:00). The engineering choices were written by the Meetings worker session for the Meetings PO and the Platform PO; `Ludy Desktop` shell ownership (section 4) belongs to the Platform line (`line:platform`), so Slice 2 framing and shared-core work are coordinated with the Platform PO.
- Builds on: [ADR-0047](0047-meeting-notes-audio-and-transcripts.md) (audio storage, consent, retention, the extension), [ADR-0052](0052-meeting-bot-and-live-notes.md) (live notes, L4a built; the bot, L4b, still Proposed), [ADR-0049](0049-member-scoped-vy.md) (the recorder's own Vy), [ADR-0025](0025-channel-layer.md) (connectors), [ADR-0032](0032-oauth-authorization-server.md) (scoped tokens for software other than the app, proposed), [meetings.md](../plan/meetings.md) section 5.5 (three ways to capture) and [meetings-integrations.md](../plan/meetings-integrations.md) (B1 calendar match, C1 to C3 import).
- Amends: reverses the 2026-11-03 "no desktop app" decision in [ADR-0047](0047-meeting-notes-audio-and-transcripts.md) (section 10 "Not captured" and "Alternatives considered"), [meetings.md](../plan/meetings.md) (sections 2 and 11), and [meetings-integrations.md](../plan/meetings-integrations.md) (sections 1 and 8).
- Issue: [#4123](https://github.com/DOS/Ludy/issues/4123) (Slice 1: one-meeting rule on existing capture paths; In progress as of 2026-11-21: Step 3 import-notice PR [#4196](https://github.com/DOS/Ludy/pull/4196) merged, Step 1 server PR [#4130](https://github.com/DOS/Ludy/pull/4130) open, Step 2 client capture in progress). Desktop Slices 2 and 3 are opened after Slice 1 ships and after Platform PO coordination on the `Ludy Desktop` shell; Slice 3 also stays gated on the legal answers in [#2585](https://github.com/DOS/Ludy/issues/2585) / [#62](https://github.com/DOS/Ludy/issues/62). The Vietnamese summary for the owner is [0055-three-capture-paths-one-meeting.vi.md](0055-three-capture-paths-one-meeting.vi.md).
- Number: 0054 is [ADR-0054](0054-rebrand-internal-crove-identifiers-to-ludy.md) (the Ludy rename, merged from [#3980](https://github.com/DOS/Ludy/pull/3980)), so this is 0055.

## Context and problem statement

Ludy captures a meeting four ways today or soon: the Ludy extension records a browser tab (built), the app records the microphone and takes uploads (built), an import takes a recording the platform already made (C1 built, C2 and C3 in progress), and a bot that joins the call is Proposed (ADR-0052, L4b). The owner now wants **all three live paths, the extension, a desktop app and a bot, with one rule that no meeting is ever recorded twice**. The owner also notes that a desktop app becomes mandatory later if Ludy adds a Slack or Lark style chat module. That module is not in any plan today (the plan lists "Ludy's own Slack app" as not approved); this ADR only keeps room for it.

The risk is concrete. A member could start the extension on a Meet tab while a calendar bot is also scheduled and the desktop app auto-detects the same call: three recordings, three bills for transcription, three transcripts that disagree, and several consent records for one conversation. As far as I read the code, nothing refuses a second recording of one meeting today: B1 links a meeting to a calendar event and refuses a second meeting for the same event, but only when a person presses "Gắn vào sự kiện lịch này", and nothing is checked when a recording starts.

The scope gate ([scope.md](../product/scope.md)) applies. **Fit:** a one-person company or SME records a handful of calls a month, and a double recording is a cost and a privacy problem for exactly them. **Smallest slice:** section 6 puts the one-meeting rule first, because it protects the paths that exist now and costs no new app. **AI part:** transcription, summary and live notes stay the recorder's own Vy through the AI budget meter, with AI off the capture and the audio still work. A person approves money, messages and spend.

## Decision drivers

- One meeting, one live capture, one consent record, one transcription bill. The server decides; a client cannot be trusted to know about the others.
- The open-source core runs with `docker compose up` and no DOS service. The desktop app, if built, is an optional client; nothing in the server may need it.
- Audio keeps ADR-0047's treatment (ciphertext under a per-meeting key, one pipeline, retention and shredding). No path may skip the consent record, and a bot-free path needs a stronger notice step than a visible bot (section 5).
- Reuse before building: the B1 calendar match (15 minutes, exactly one event, a person confirms), the extension token (#2740, one org, one member, scopes), the consent kit (A1 and A2, ADR-0047), the import claim path (`kernel.meeting_platform.import.claim`).
- Do not answer the open bot questions of ADR-0052 here. Do not start a desktop build before the owner and the lawyer have been asked.

## 1. Market check (2026-11-19)

Eight products were read on 2026-11-19 from their own help centers, blogs and product pages (a research pass with web search and page fetches; the sources are in "Sources"). Many help pages show only relative dates ("updated 2 days ago"); an absolute date is given only where the page shows one. Otter's and Read.ai's help centers refused the page fetch (HTTP 403), so what is said of them comes from search-result summaries of those pages and is marked **[summary only]**. "Not documented" means nothing was found either way, which is not proof that the thing is absent.

| Product | Main path | Other paths found | How it avoids a double recording |
|---|---|---|---|
| Granola | Desktop app (Mac, Windows), no bot | Phone app for in-person; no extension found | Never auto-records (you click into a note or open it at its start). A duplicate note was explained by one meeting in two connected calendars. Bot or cross-user dedupe: not documented |
| Notion AI Meeting Notes | Desktop app (system audio and mic) | Browser and phone, microphone only; file upload | Not documented |
| Fireflies | Bot ("Fred"), joins from the calendar or on invite | Chrome extension (Meet only), desktop app "Take Notes" (no bot), phone, upload | Bots only: "joins on behalf of the first person who invited it". Bot together with the desktop app: not documented, except that to bring the bot into a meeting already being recorded you stop and start a new session |
| Otter | Notetaker bot | Desktop app (bot-free), Chrome extension, phone | Bots only **[summary only]**: one Notetaker per workspace, the organizer's first, else the member sharing with the most calendar participants; one per workspace, so two workspaces can still send two. Bot with desktop: not documented |
| tl;dv | Bot, calendar auto-record | Chrome extension (Meet), desktop app (audio only, no bot) | Bots only, documented: "only ever one tl;dv bot present", organizer first, then the highest plan, ties random, every requester becomes a co-owner. Desktop with bot: not documented |
| Read.ai | Bot ("web mode") | Chrome and Edge extension, desktop app (bot-free), a botless Google Meet integration (2026-03-26), phone | Not documented as a feature; a support page says several Read users in one meeting "can sometimes lead to confusion" **[summary only]** |
| Jamie | Desktop app (bot-free) | Phone for in-person | Auto-start never fires while a recording runs and never twice for one calendar event. Cross-user dedupe: not documented |
| Noota | Meeting Assistant bot | Desktop app (bot or bot-free by choice), Chrome extension | Bots only, admin setting "Single assistant" with a priority order. Bot with desktop: not documented |

What the table says, and what it does not:

- **Only bots are deduplicated, and only by the calendar event or the meeting.** tl;dv, Otter and Noota document a rule (organizer first, then plan or admin priority). Fireflies has "first inviter". I found **no product that documents a rule between a bot and its own desktop app, or between two members who each use a desktop app**. Granola, Notion and Jamie avoid duplicates mostly by never auto-recording, or by refusing a second auto-start. Ludy's rule below is therefore not a copy of a known pattern; it is built from the calendar match Ludy already has.
- **Every bot-free path pushes the legal duty to the user** and offers optional tools: a chat message posted for you (Granola, Fireflies on Mac, Jamie, Notion, Otter for Teams), an audio notice played into the call (Fireflies, Notion), a "watermark" virtual camera (Granola, Fireflies), a pre-meeting email from the calendar (Jamie, tl;dv for external invitees). tl;dv's own legal article says disclosure "sits with the user" in bot-free mode; Noota's pages disagree with each other on whether participants are told.
- **Desktop technology, where stated or measured by a third party:** system audio plus microphone, Core Audio or ScreenCaptureKit on macOS (Microphone and "Screen and System Audio Recording" permissions), WASAPI loopback on Windows (no prompt found for loopback itself, not confirmed). Third-party app-inventory data lists Granola and Notion as Electron (not stated by either vendor). The framework of Otter, Fireflies, tl;dv, Read.ai, Jamie and Noota **could not be confirmed**.

**Could not confirm:** the framework of six of the eight; what any of the six does when a bot and a desktop recording of the same meeting are both active; Otter and Read.ai beyond the search summaries; upload and phone paths for tl;dv, Read.ai, Jamie and Noota; Apple's own pages for ScreenCaptureKit audio and for notarization (they returned no content), so the macOS facts below come from Electron's and Tauri's own docs and from the repository's earlier research.

## 2. The role of each path

| Path | Role in Ludy | State |
|---|---|---|
| **Extension** (Chrome, Edge) | Browser meetings (Meet, and Teams or Zoom opened in a tab) and machines where an app cannot be installed. Records a tab plus the microphone, with the consent step in its popup, live notes opt-in | Built (ADR-0047, L4a #3109) |
| **In-app recorder and upload** | A meeting around a table on a laptop or phone, and any file | Built |
| **Desktop app** ("Ludy Desktop") | Native Zoom, Teams, Zalo PC, a Slack huddle, and in-person on a laptop: system audio plus the microphone, no browser tab. The only route for Zalo PC calls and Slack huddles (the repository's earlier research found no official API for either) | Approved direction (2026-11-20 UTC / 2026-11-21 +07:00): Platform-owned Electron shell (Slice 2), Windows capture first then macOS (Slice 3), queued after Slice 1 (#4123); Slice 3 gated on #2585/#62 legal answers |
| **Bot** (ADR-0052, L4b) | A meeting the recorder is not at the keyboard for. A Zoom bot only when a pilot customer pulls it | Proposed (Icebox); ADR-0052 owner questions 2, 3, 4, 6, 7, 8 remain explicitly open and unanswered (no bot build now) |
| **Platform import** (C1 to C3) | After the fact: Meet, Zoom and Teams recordings or transcripts the member asks for | C1 built; C2 and C3 in progress |

The three live paths differ in who is told: the extension and the desktop app show nothing to the other participants (Chrome's own indicator and Ludy's recording indicator are the recorder's alone), a bot is visible. That is the reason the consent step cannot be the same for all (section 5).

## 3. The one-meeting rule

### 3.1 What "the same meeting" means

A meeting's identity is the first of these that exists:

1. **The calendar event** the recording is linked to (B1: `calendar_agenda.meeting_id`, one event per meeting). For a recurring event the occurrence, not the series.
2. **A meeting key**: a hash of the platform and the meeting id read from the join address (a Meet code, a Zoom meeting id, a Teams thread id). The extension reads the address of the tab; the desktop app reads it from the calendar event it matches or from the window the user picks; the bot is given it. Only the hash is stored.
3. **Time overlap within 15 minutes with exactly one calendar event of the recorder** (B1's existing rule). A person confirms.
4. **Nothing known.** The meeting is its own; the rule below still stops a second capture on the same recorder and the same device clock window.

Two members of one org recording the same call, and the same member on two devices, are both "the same meeting" when 1 or 2 is known. Two different orgs are never related (no cross-org data is read).

### 3.2 One live capture per meeting, decided by the server

A new tenant table `crove_meetings.capture_session` (proposed, a migration, protected): `meeting_id`, `source` (`extension`, `app`, `desktop`, `bot`), `meeting_key` (nullable hash), `started_at`, `last_seen_at`, `ended_at`, `ended_reason`. Two partial unique indexes over open sessions: one per `(org_id, meeting_id)` and one per `(org_id, meeting_key)`. A client **asks to start** through one command, `meetings.capture.start`, before it sends any audio, and sends a heartbeat with every live piece or every 30 seconds. The server:

- **refuses a second open session** with 409 `CAPTURE_ALREADY_RUNNING` and says **which source and since when** ("Tiện ích đang ghi cuộc họp này từ 14:02"), never a name and never the other person's meeting;
- **ends a session that has no heartbeat for 90 seconds** (`ended_reason: lost`), so a crashed browser or a closed laptop does not lock the meeting;
- **keeps the consent record where it is**: the session start needs the meeting's consent record (as `meetings.live.chunk` does today), so a capture cannot start before the notice is confirmed;
- is the same for the extension, the in-app recorder, the desktop app and the bot, through the extension token's scope (#2740) or the member's session. A new capture command is an R1 command that runs through `Runtime.execute()`.

Before this exists the extension and the in-app recorder keep working unchanged. The rule is added to them first (slice 1), so the desktop app and the bot never ship without it.

### 3.3 A scheduled bot and a local capture

The bot, if built, is scheduled by the recorder for one calendar event (ADR-0052 question 6 is still open: who may send a bot, no auto-join). Priority:

1. **Local capture wins before the bot has started.** The bot's join job calls `meetings.capture.start` first; if a local session is open for that event or key it does not join. If the bot is already scheduled and a local capture starts, the scheduled bot job is cancelled.
2. **The first live capture stays.** If the bot is already in the call and recording, a local start is refused with `CAPTURE_ALREADY_RUNNING` naming the bot. The person may press "Dừng bot" (the bot leaves) and start locally; that is a click, never automatic.
3. The refusal text says which one is recording and offers the other action (open the running meeting, stop it first).

### 3.4 Platform import attaches to the same meeting

Import is after the fact and must never make a second meeting for a call Ludy already recorded. Before the platform list offers "Nhập" for a recording, code looks for a meeting with the same calendar event or meeting key, else the 15-minute overlap with exactly one event. When one exists the row says "Ludy đã có bản ghi của cuộc họp này" and the import is not offered as new. The first slice is that notice only. A later slice may let the member attach the platform's transcript to the existing meeting as a second, labelled text (C2's `take_transcript` already marks such lines as the platform's, not Ludy's) without replacing the recorder's draft. The import claim path (`kernel.meeting_platform.import.claim`, one row, one claim) is unchanged.

### 3.5 Two people in one org

If a second member of the same org starts a capture for a meeting key that is already being captured, the answer is the same 409 (which source and since when to an attendee, never who). The accepted rule (owner decision 4, 2026-11-20 UTC / 2026-11-21 +07:00) is **no second recording in one org** and a message that suggests sharing the running meeting with the second member as a reader. The alternative (each records and has their own draft) doubles the bill and the consent records for one conversation, which is what the owner wants to prevent.

**Known limits of this rule (#4538, found in the independent review of 2026-11-23; not a change of the rule).** The server does not check that the join address is one of the caller's own calendar events: any member of the org who knows a call's join address can open a capture of it and hold the lock with a heartbeat at least every 90 seconds, so the real recorder is refused (409 `CAPTURE_ALREADY_RUNNING`) until it stops. The refusal never destroys a recording (a client whose start was refused is told, and it takes the call back when the lock is free), and an extension recording of an ad-hoc call has no calendar event to compare, so the lock stays open to every member. What the code now narrows: the 409 keeps its status, code and message for every caller, but its details (the kind of client and since when) go only to an attendee, that is a caller whose own calendar event for this very call is named in the start. A member who merely knows the address learns nothing more than that the call is held. A later option, **B**, is that an owner or admin ends another member's capture (a new command, a migration, an audit line); it changes who may end a recording and needs the owner's decision first, so it is not built.

### 3.6 What is reused and what is new

Reused: B1's match and its unique link, the extension token and its scopes, the consent record and its methods (`told_at_start`, `in_invite`, `in_writing`, `in_call_chat`, `platform_notice`), the live piece path, the import claim and its status machine. New: `capture_session`, `meetings.capture.start` and `.stop` and a heartbeat, the meeting key, a bot-job check, an import notice. No new audio path and no new storage of audio.

## 4. "Ludy Desktop": one shell, meeting capture first

The desktop app is **a general Ludy client owned by the Platform line**, not a Meetings-only app, the same way the extension is "a small shell, meetings its first feature" ([meetings.md](../plan/meetings.md) section 5.6). Meeting capture is its first capability. Room is kept, without building, for: a global Quick Add hotkey, tray notifications (the app has no push outside Social), the chat module if the owner adds it later, and USB-token signing (the Sign line's later need).

Responsibilities of the shell, in order of first use: sign-in as the member (the extension's sign-in flow with PKCE and a scoped token, ADR-0032 once accepted; a desktop token is one org, one member and the scopes of the features turned on, kept in the OS keychain, listed and revocable under "thiết bị đã kết nối"), auto-update, a tray with an always-visible recording indicator, and one capture module behind a narrow interface (`start(source, meetingKey)`, `pieces`, `stop`), so the shell and the audio core can change independently.

### Electron or Tauri

Numbers below are from blogs and single-developer tests, not an independent benchmark; they must be measured on Ludy's own shell before a choice is final.

| | Electron | Tauri 2 |
|---|---|---|
| **Size** | Bundles Chromium: about 100 MB and up for a small app in tests (106 MB against 1 MB in one 2026 test); large apps are far bigger (a third-party inventory lists Granola at 987 MB and Notion at 461 MB on macOS) | Uses the OS webview: under 1 MB to about 9 MB in tests; official: "less than 600 KB" minimal |
| **Memory** | Higher in tests (about 409 MB against 172 MB with six windows, one run); very variable | Lower in that run; varies from near parity to several times |
| **Rendering** | One Chromium everywhere, so the extension's React UI renders the same on both systems | WebView2 on Windows, WKWebView on macOS: two engines, quirks differ |
| **Language** | TypeScript main process; the repository already runs erasable TypeScript, so one language | Rust backend plus the web UI: a second language and toolchain |
| **System-audio capture** | Built in: Windows loopback through `setDisplayMediaRequestHandler` with `audio: 'loopback'`; macOS Core Audio tap by default since Electron 39 (macOS 14.2 and up, `NSAudioCaptureUsageDescription`). **Failure mode: without the macOS permission the track ends silently, no error** | No first-party audio capture. A third-party plugin gives microphone and WASAPI loopback on Windows but **microphone only on macOS**; an open-source Tauri meeting app reportedly uses ScreenCaptureKit and Core Audio through native code (secondary source). So Rust audio work is Ludy's own |
| **Auto-update** | Built-in `autoUpdater` (Squirrel.Mac needs a signed app; Squirrel.Windows or MSIX); a service or update server is ours | Updater plugin; update signatures cannot be turned off and use our own key pair; losing the private key ends updates for installed copies |
| **macOS signing** | Apple Developer Program, 99 USD a year, a legal entity with a D-U-N-S number and a website for an organization; Developer ID certificate, signing and **notarization** | Same cost and rules; Tauri's docs say notarization is required and a free account cannot notarize |
| **Windows signing** | Electron's docs say an EV certificate (hardware or cloud) is needed for instant SmartScreen reputation; the sources disagree on whether EV still gives instant reputation | Same certificates; Tauri's docs say EV certificates since 2024 no longer give instant reputation and unsigned apps can be blocked by Smart App Control |
| **Distribution** | Direct download plus updater; a store is optional | Same |

**Windows signing for a Vietnamese company.** Azure Artifact Signing (formerly Trusted Signing) costs about 9.99 USD a month for 5,000 signatures (Basic) or 99.99 USD for 100,000 (Premium) according to a trade article of 2026-01-14 and a search summary; Microsoft's own pricing page did not show the figures. Microsoft's quickstart (updated 2026-11-17) lists the countries open to organizations: the US, Canada, the EU, the UK, Australia, New Zealand, Japan, South Korea, Singapore, Switzerland, Norway and Israel. **Vietnam is not in the list**, so a Vietnamese entity would likely need a traditional EV or OV certificate from a certificate authority (one 2026 article quotes about 290 to 500 USD a year for Sectigo EV; no reliable OV price was found; certificate validity has dropped to about 460 days since 2026-03-01). Identity validation by Microsoft takes 1 to 30 business days where it is open. The signing keys, the Apple account and the Microsoft or CA account are owner or operator actions (accounts, payments, secrets): no worker or team lead creates them.

**Accepted choice (owner decision 3, 2026-11-20 UTC / 2026-11-21 +07:00): Electron for the first capture slice.** The reasons are the audio capture on both systems and the updater come with it, the team writes one language, and the renderer is the one the extension UI already targets. The costs are size and memory, which matter less for an installed work tool than for a utility, and Chromium's security updates become ours to ship. Tauri is the better shell if size and memory become a complaint and a Rust audio core exists; keeping the capture module behind the narrow interface above keeps that door open. The Platform PO (`line:platform`) owns the shared shell, coordinates Slice 2 framing, and confirms size and memory measurements on the first build with the owner.

## 5. Consent without a visible bot

The law is Law 91/2025/QH15 on Personal Data Protection (in force 2026-01-01) and Decree 356/2025/ND-CP, which **replaced Decree 13/2023/ND-CP**; the repository reads them through [meetings.md](../plan/meetings.md) section 7 as commentary until the lawyer (#62) answers. The brief for this ADR named Decree 13/2023; the repository's current reading is the newer pair, so this ADR uses it and the lawyer list below asks the lawyer to confirm which applies.

A visible bot tells everyone by being there. The extension and the desktop app tell nobody. So the desktop app must, **before it stores any audio**:

1. **Block the capture until the recorder confirms** the same consent record as everywhere (who, when, how they were told, the notice version), and refuse to send a piece without it (the server already refuses audio for a meeting without the record).
2. **Show the notice text to read aloud, and offer to copy it** to the clipboard for the call's chat. The app cannot post into Zoom, Teams or Zalo (no official API); it must not pretend to. The consent method is the existing `told_at_start` or `in_call_chat`, set by the recorder's own statement.
3. **Show a recording indicator that cannot be hidden while it records** (a tray icon and a small always-on-top pill with the timer and a stop button), plus the operating system's own indicator.
4. **Never start by itself.** The app may detect a meeting window and offer "Ghi cuộc họp này"; it never starts without a click, as the owner ruled for the bot (no auto-join) and as Jamie's auto-start is off by default.
5. **Capture the meeting app, not the whole machine, where the operating system allows it** (a Core Audio process tap or WASAPI process loopback on the meeting app), so other sounds such as music or a personal call are not recorded. This is a privacy default, from the repository's earlier research; it is an inference that it works for each target app and it is tested in the first slice.
6. **Keep the voiceprint rule**: no speaker recognition across meetings (ADR-0047).

**Questions added to the lawyer list** ([meetings.md](../plan/meetings.md) section 7, [#2585 comment](https://github.com/DOS/Ludy/issues/2585#issuecomment-7049109109) and [#62](https://github.com/DOS/Ludy/issues/62)), as an addition to the existing ones and to ADR-0052 question 8:

- Is a notice the recorder reads aloud or pastes in the call's chat enough for a **bot-free desktop capture**, or must each participant agree?
- Does the notice have to be shown **before** the first audio is captured, and is the recorder's confirmation enough evidence?
- Is capturing **system audio of calls the recorder is on, but not the organizer of** (a customer's Zoom, a Zalo call with a supplier) within the org's legitimate purpose?
- Is an **in-person recording** on a laptop covered by the same notice, with people physically present who never touch the app?
- Which decree is the reading of record (91/2025 with 356/2025, or 13/2023)?

## 6. Smallest first slice, risks, owner decisions

### Smallest first slice

**Slice 1 ([#4123](https://github.com/DOS/Ludy/issues/4123)): the one-meeting rule on the paths that exist (no new app).** `capture_session`, `meetings.capture.start`, `.stop` and the heartbeat, the meeting key, the extension and the in-app recorder calling it, the import notice "đã có bản ghi". One person can use it with the defaults; the AI part is unchanged (the recorder's Vy transcribes as today). It is the precondition for everything else and is useful alone: today a second tab or a second device can already record the same call. Status as of 2026-11-21: `#4123` is In progress (Step 3 import-notice PR [#4196](https://github.com/DOS/Ludy/pull/4196) merged at `2b4162174ff7eb7de131801f852be7d265cfd5f3`; Step 1 server PR [#4130](https://github.com/DOS/Ludy/pull/4130) open; Step 2 client capture in progress).

**Slice 2: a `Ludy Desktop` shell with no capture** (Platform line, `line:platform`): sign-in with a scoped token, the keychain, auto-update, the tray, signed installers for one system, framed with the Platform PO after Slice 1. **Slice 3: capture on Windows first** (WASAPI process loopback needs no permission prompt, and Windows is where Zalo PC and the Teams and Zoom desktop clients are, which is an assumption about Vietnamese small businesses that is not verified), then macOS (Screen and System Audio Recording permission, Sequoia's periodic re-approval), gated on the non-bot capture legal answers in [#2585](https://github.com/DOS/Ludy/issues/2585) / [#62](https://github.com/DOS/Ludy/issues/62). Each slice is its own issue, with the plan's milestone and priority set by the owner. A bot waits on its own open questions in ADR-0052.

### Risks

- **Silent failures.** macOS gives silence, not an error, when the permission is missing (Electron's track ends; a Core Audio tap returns zero buffers). The app must check the level and tell the recorder within seconds.
- **Signing and notarization cost and time**: an Apple account, a Windows certificate for a Vietnamese entity, identity checks of days to weeks. Without them users see warnings or the app is blocked.
- **Platform changes**: Apple and Microsoft change capture permissions; Zoom or Teams could restrict desktop audio capture of their own apps (not seen, not checked).
- **A double recording by two people in different orgs**: not preventable and not Ludy's to prevent.
- **Maintenance**: two audio stacks, a release pipeline and an update server are a permanent cost; a small team carries it.
- **Consent**: a bot-free capture is invisible; the lawyer has not answered (section 5).

### Owner decisions

**Decided 2026-11-20 UTC / 2026-11-21 +07:00** (AI Meeting Notes PO popup A2, [#3986 comment](https://github.com/DOS/Ludy/pull/3986#issuecomment-7048557563)): JOY approved all 10 recommendations ("Đồng ý cả 10 đề xuất trong ADR-0055: làm xong lát 1 chống ghi trùng trước, sau đó làm app máy tính Electron thuộc khung chung Platform (Windows trước macOS), thêm câu hỏi luật sư #2585/#62 ngay, chưa mua tài khoản ký phần mềm hay làm bot vội").

1. **Build a desktop app at all (reverses "no desktop app" of 2026-11-03)?** **Accepted: yes, as a Platform-owned (`line:platform`) `Ludy Desktop` shell with meeting capture first, after Slice 1 (`#4123`).** Reverses the 2026-11-03 "not planned" lines in `meetings.md` and `meetings-integrations.md`.
2. **The one-meeting rule first (Slice 1, `#4123`), before any desktop or bot work?** **Accepted: yes.** Useful immediately for existing paths, and desktop/bot paths depend on it.
3. **Electron or Tauri for the shell?** **Accepted: Electron for the first capture slice** (section 4). Platform PO (`line:platform`) owns the shell, coordinates Slice 2 framing, and confirms size and memory measurements on the first build.
4. **Two members of one org: refuse a second recording and offer to share the running one?** **Accepted: yes** (409 `CAPTURE_ALREADY_RUNNING` naming source and start time, suggesting sharing the running meeting as a reader).
5. **When a local capture and a scheduled bot meet: local wins before the bot has started, the first live capture stays after?** **Accepted: yes** (section 3.3). Applies only if a bot is later built.
6. **Windows first, then macOS?** **Accepted: yes** (remains an unverified assumption about Vietnamese SME machines; pilot hardware check applies when Slice 3 approaches).
7. **Signing accounts (owner action, new spending):** an Apple Developer Program account (99 USD a year) and a Windows certificate from a certificate authority (Azure Artifact Signing does not list Vietnam). **Accepted: defer purchase until Slice 2 is approved** (do not buy signing accounts or certificates yet).
8. **The lawyer questions of section 5 added to the list (#2585, #62)?** **Accepted: yes, append now**; they cost no new spend and gate Slice 3 desktop capture.
9. **ADR-0052's bot questions stay open and are not answered here:** **Accepted: keep open and unanswered (no bot build now):** 2 (a Zoom bot now or when a pilot asks), 3 (a Meet and a Teams bot: confirm "not planned"), 4 (a third-party meeting-bot API), 6 (who may send a bot, no auto-join), 7 (Zoom spending and accounts), 8 (the in-call notice for a bot).
10. **A chat module that would make the desktop app mandatory:** not planned. **Accepted: leave as a note only**; any Slack/Lark-style chat module stays outside current plans until a separate owner decision with its own ADR.

### Protected paths (Decision 7) for the slices

Slice 1: `supabase/migrations/` (the new table and indexes), `packages/kernel-contract` (the capture shapes), a route for the extension token's scope (`http.ts`, shared core, and `EXTENSION_ROUTES`), possibly `packages/kernel-runtime` only if a new command class is needed (not expected). Slice 2: a new `apps/desktop` workspace (`package.json`, the pnpm workspace and lock), a CI workflow to build, sign and publish installers (`.github/workflows/`, with signing secrets: a credential step no worker runs), `tools/deploy/**` if an update server is hosted, and the OAuth or token sign-in (`auth*.ts`, ADR-0032). All of these need the security review; the signing, account and secret steps are written as a runbook and run only by the coordinator on the owner's word.

## Consequences

- Slice 1 (`#4123`, one-meeting rule on existing capture paths plus the import notice) finishes first before any desktop or bot build (Step 3 PR `#4196` merged; Step 1 PR `#4130` open; Step 2 client capture in progress).
- The 2026-11-03 "no desktop app" / "not planned" lines in `meetings.md` (sections 2, 11, and plan notes) and `meetings-integrations.md` (sections 1 and 8) are updated to reference Accepted ADR-0055.
- `Ludy Desktop` shell ownership sits with the Platform line (`line:platform`); Slice 2 framing, Electron size/memory verification, and shared-core review are coordinated with the Platform PO after Slice 1, and software-signing accounts wait until Slice 2 is approved.
- The non-bot capture legal questions of section 5 are appended to [#2585](https://github.com/DOS/Ludy/issues/2585#issuecomment-7049109109) and cross-linked with [#62](https://github.com/DOS/Ludy/issues/62); Slice 3 desktop capture (Windows first, then macOS) stays gated on those legal answers.
- ADR-0052's L4b stays `Proposed` in the Icebox with bot questions 2, 3, 4, 6, 7, 8 explicitly open and unanswered (no bot build now).
- A Slack/Lark-style chat module stays outside current plans (note only) until a separate owner decision with its own ADR.

## Revisit when

- A pilot customer needs Zalo PC calls or Slack huddles recorded.
- The lawyer answers the bot-free consent question, or the law's reading changes.
- Apple or Microsoft changes system-audio capture rules, or Tauri gets a first-party audio capture API.
- A chat module is approved.

## Sources

Read on 2026-11-19. Pages without a visible date are marked "no date".

- Granola: [transcription](https://docs.granola.ai/help-center/taking-notes/transcription.md), [syncing calendars](https://docs.granola.ai/help-center/getting-started/syncing-your-calendars.md), [transparency and consent](https://docs.granola.ai/help-center/consent-security-privacy/transparency-solutions/introduction.md); third-party inventory: [Desktop Insights, Granola](https://desktopinsights.com/apps/granola)
- Notion: [AI meeting notes](https://www.notion.com/help/ai-meeting-notes) (no date); [Desktop Insights, Notion](https://desktopinsights.com/apps/notion)
- Fireflies: [bot or no bot](https://guide.fireflies.ai/articles/7066927951-bot-vs-no-bot-which-capture-am-i-using), [desktop app](https://guide.fireflies.ai/articles/1208704416-getting-started-with-the-fireflies-desktop-app), [desktop consent](https://guide.fireflies.ai/articles/3917896272-how-consent-notifications-work-on-the-fireflies-desktop-app), [team settings](https://guide.fireflies.ai/articles/3422594586-team-settings-complete-guide-workspace-admins)
- Otter: [bot-free notetakers, 2026-10-20](https://otter.ai/blog/bot-free-ai-notetakers), [desktop](https://otter.ai/integrations/desktop) (no date); help-center articles on deduplication and the desktop app returned 403, summaries only
- tl;dv: [whose bot joins, 2026-01-28](https://intercom.help/tldv/en/articles/10684526-how-does-tl-dv-decide-whose-bot-joins-the-meeting), [record without the bot](https://intercom.help/tldv/en/articles/14433337-how-to-record-without-the-bot), [is bot-free recording legal, modified 2026-10-13](https://tldv.io/blog/is-bot-free-recording-legal/)
- Read.ai: [desktop](https://www.read.ai/desktop), [botless Google Meet, 2026-03-26](https://www.read.ai/post/read-ai-introduces-a-botless-integration-with-google-meet); support articles on consent and report ownership returned 403, summaries only
- Jamie: [auto-start](https://docs.meetjamie.ai/getting-started/auto-start-recording.md), [recording consent](https://docs.meetjamie.ai/getting-started/recording-consent.md), [chat notice](https://docs.meetjamie.ai/getting-started/meeting-chat-compliance-notice.md)
- Noota: [new desktop version, 2026-10-21](https://www.noota.io/product-updates/new-version-desktop-app), [do participants get a notice, 2025-11-18](https://support.noota.io/en/articles/8564869-do-other-participants-receive-notification-when-i-start-recording), [company assistant settings, 2026-05-05](https://support.noota.io/en/articles/14968314-company-meeting-assistant-settings)
- Frameworks: Tauri [updater](https://v2.tauri.app/plugin/updater/), [Windows signing](https://v2.tauri.app/distribute/sign/windows/), [macOS signing](https://v2.tauri.app/distribute/sign/macos/); Electron [auto-updater](https://www.electronjs.org/docs/latest/api/auto-updater), [code signing](https://www.electronjs.org/docs/latest/tutorial/code-signing), [desktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer), [session](https://www.electronjs.org/docs/latest/api/session); [Tauri against Electron, one test](https://dev.to/gethopp/tauri-vs-electron-performance-bundle-size-and-the-real-trade-offs-1el4); [tauri-plugin-system-audio](https://docs.rs/tauri-plugin-system-audio); [Recall.ai desktop recording tutorial](https://recall.ai/blog/how-to-build-a-desktop-recording-app)
- Signing: [Apple Developer Program enrollment](https://developer.apple.com/programs/enroll/), [Azure Artifact Signing quickstart, updated 2026-11-17](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart), [DevClass, 2026-01-14](https://www.devclass.com/security/2026/01/14/code-signing-windows-apps-may-be-easier-and-more-secure-with-new-azure-artifact-service/4079554); certificate prices and validity: search summaries only, not fetched
- Windows loopback: [Microsoft, loopback recording](https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording)
- In the repository: [meetings-research.md](../plan/meetings-research.md) (desktop apps, bot-free system audio capture, signing, consent), [meetings.md](../plan/meetings.md) sections 5.5, 5.6, 7 and 11, [meetings-integrations.md](../plan/meetings-integrations.md) sections 5.1 and 6.1
