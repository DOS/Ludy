# 0047. Meeting notes: audio storage, the provider boundary, consent, retention and who reads a meeting

- Status: Proposed (2026-11-03). Nothing here is built. The owner decides Q1 to Q6 of [meetings.md](../plan/meetings.md) section 14 before any build; the consent points (point 6) need the lawyer (#62); the tables, definers and the blob cipher are protected paths and get the Platform PO's security review.
- Date: 2026-11-03
- Deciders: owner (JOY), for the readers (Q2), the retention defaults (Q3), the consent step (Q4) and the Cloud provider (Q5); the engineering choices below by the Claude Code session that wrote the plan
- Builds on: ADR-0013 (files: staged uploads, content address, versioned buckets), ADR-0017 (crypto-shredding design, the restore replay), ADR-0018 (untrusted content), ADR-0025 (the credential vault's envelope), ADR-0029 (tasks and agents, the write allowlist #285), ADR-0031 (module enablement), ADR-0037 (private notes: restrictive policies, definers that return no text), the owner's per-member Vy rule of 2026-11-03 ([#1677](https://github.com/DOS/Ludy/issues/1677)), the AI budget meter (#2382), the kill switches (#886)
- Issue: [#932](https://github.com/DOS/Ludy/issues/932); the plan is [meetings.md](../plan/meetings.md)

## Context and problem statement

A meeting recording is the most personal data a small business will put into Ludy: voices of members and of outsiders (customers, suppliers, candidates), talk about pay, prices and people. The module must turn it into a transcript, a summary, decisions and action items with AI, and then let it go.

What the code gives today, and what it does not:

- **Files** (`crove_kernel.file`) are content-addressed and written create-only to versioned buckets; Crove holds no permission to delete an old object version (ADR-0013). File rows are readable by every member of the org. Deleting audio there cannot reach every copy.
- **Crypto-shredding** is designed (ADR-0017: per-subject keys wrapped under the deployment key, a replay after restores) but not built; the vault's envelope exists for channel credentials (ADR-0025).
- **The parsing sandbox** (`crove-extract`, T12) runs no child process and no native code, so it cannot run an audio transcoder.
- **The AI layer** has one OpenAI-compatible endpoint behind `metered()`; the meter counts tokens, while transcription is billed by audio length.
- **Per-user privacy** exists for private notes (ADR-0037); the member's own Vy (#1677) is decided by the owner and not built.

What has to be decided: who reads a meeting; how audio is stored so that it can really be erased; where media is parsed; how the transcription provider is chosen and bounded; what the consent record is; retention of audio and text; and how Vy's work fits the per-member rule.

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
| `transcript_segment` | start and end times, the speaker label, the text |
| `meeting_result` | summary and decisions, the feature that wrote them, `tainted` |
| `action_item` | title, who and when as drafted and as parsed, the transcript time, status (`suggested`, `accepted`, `dismissed`), flags, the task created, `tainted` |
| `audio_key` | the meeting's wrapped data key; no grant to any login role |

### 2. Readers, enforced by the database

- Restrictive policies beside `tenant_isolation`, in the style of `crove_notes`: a row of a meeting is read when the context's user (`ctx_user_id()`, the sealed context T11) is its recorder, or is in `meeting_reader`, or the meeting's `visibility` is `org` and the user's base role is owner, admin or member with the whole-org scope. Writes follow the same readers, and the commands limit what each may change (a reader corrects text and speaker names; the recorder changes readers and visibility).
- Owners and admins get the existence of every meeting (id, date, length, recorder, retention dates) through a definer that returns no text, and an owner deletes any meeting (R3, fresh second factor) without reading it.
- Viewers, org-chart agent contexts and the worker's system context read and write nothing. The worker reaches meetings only through `SECURITY DEFINER` functions with `search_path = pg_catalog, pg_temp`, EXECUTE for the worker login alone: `meetings_due(limit)` (ids and dates past a retention), `meeting_shred(org, meeting)` and `meeting_text_purge(org, meeting, before)`. The org purge runs as the table owner.
- The invariant suite gets `meetings-readers.db.test.ts`; the RLS matrix lists the tables with a readers-only exception to its system-context controls, as it does for notes.

### 3. Vy and agents

- **Processing runs as the member's own Vy** (#1677): the job that transcribes and summarizes runs in the sealed user context of the member who started it, with the Vy run recorded beside it, and ends if that member leaves. It reads the one meeting and the attendees' names; nothing else. The member-context run is one mechanism for notes N8 and meetings, designed in the ADR-0037 addendum, owned by the Platform PO, built once.
- Results are stored on the meeting and read by its readers only. They derive from the meeting alone, so every reader may see them.
- Org-chart agents keep no access (as notes decision N-6). Org-wide outputs (team brief, digests, proposals others approve) carry no meeting content; a "ready to review" item appears on the readers' own Home only.

### 4. Audio storage: ciphertext, one key per meeting

- Audio is a `kernel.file` of a new purpose `meeting_audio`, with its own size cap and a neutral name. The claim step encrypts the bytes as they stream from staging: AES-256-GCM in fixed-size chunks under a random 32-byte data key of the meeting; the stored object, its sha256 and its generation are those of the ciphertext, so ADR-0013's integrity rules hold unchanged.
- The data key is wrapped with the vault's envelope under `CREDENTIAL_KEY` (`CREDENTIAL_KEY_PREVIOUS` during a rotation; the reseal pass gains `audio_key`), its AAD binding the domain `crove.meeting_audio.v1`, the org and the meeting. The wrapped key lives in `audio_key`, reached only through definers that check the caller is a reader in the sealed context, or the worker's shred.
- The generic file download refuses the purpose; playback goes through a module route that checks the reader, decrypts in the API process and streams. Audio playback is a `sensitive` query (the audit row before the read).
- The blob cipher lives in `@crove/kernel-runtime` beside the vault, so a later build of ADR-0017 reuses it.
- The original upload is deleted after normalization (point 5): only normalized audio is kept. Video is never stored.

### 5. Media parsing and the provider boundary

- **Media is parsed only in `crove-media`**, a new sandbox image: ffmpeg and a small server, no network (an internal compose network), no secrets, an environment allowlist, a read-only root, no capabilities, CPU, memory, process and time limits, the CI checks of `crove-extract`. It probes the length, normalizes to mono Opus and splits into segments of at most 10 minutes. The worker sends it decrypted bytes and encrypts what it returns; its answers are validated as untrusted.
- **Transcription goes through `packages/agent`** under `metered('meetings.transcribe')`, as the OpenAI-compatible `/audio/transcriptions` request, with a deployment setting for the model and an optional base URL of its own. A self-hoster may point it at a self-hosted Whisper-class server; the open-source core needs no DOS service. The provider gets the audio segments and the language hint only. The summary uses the existing text model under `metered('meetings.summary')` and gets the transcript text, the meeting date and the attendees' names.
- **Which provider Ludy Cloud uses** is an owner decision made in the private Cloud layer (plan Q5); the module stays off there until then.

### 6. Consent

- A meeting accepts audio only after its consent record is written: who confirmed, when, the method (`told_at_start`, `in_invite`, `in_writing`) and the version of the notice shown. The command refuses audio otherwise; the audit row records codes only.
- The record is kept as long as the meeting's text and deleted with it. No signature of each participant in the first slice (plan Q4).
- No voiceprint is stored and no speaker is recognized across meetings. Speaker labels belong to one meeting and are named by a reader.
- The legal reading (Law 91/2025/QH15, Decree 356/2025/NĐ-CP) is commentary until the lawyer answers the plan's section 7 questions; an answer that requires more changes this point by an amendment.

### 7. Retention and shredding

- Two org settings: audio retention (default 30 days after the transcript is ready) and text retention (default 12 months), each stamped on the meeting when it is recorded, so the period participants were told stays true.
- At the audio date, or when a meeting is deleted, the worker deletes its `audio_key` row: every copy of the ciphertext (current and old versions, bucket backups) is unreadable from that moment. The objects are then deleted as the store allows; a lifecycle rule reclaims old versions.
- At the text date, or with the meeting, the module's text rows are deleted. None of them is in the WORM stream, an outbox payload, an audit fact or an activity summary, so database backups are the last copy and expire on their schedule.
- A deletion before its date writes a shred reference (ids only) to the archive store under its object lock; after a restore the replay deletes those keys and rows again (ADR-0017 §8, built here for meetings). Date-based expiries need no reference: the next nightly run repeats them.
- Every column is in the personal-data registry with handling `erase`; transcript text and speaker labels are `pii`, the audio reference `sensitive`. The org export carries text of meetings shared with the org and never audio.

### 8. AI output and tasks

- The transcript is untrusted input (ADR-0018) and everything derived from it is tainted.
- Action items are suggestions on the meeting, not `crove_kernel.proposal` rows: the approval queue is read by approvers who may not be readers of the meeting. A reader accepts one, or every clean one in a batch; accepting runs `meetings.action_item.accept` as that member, which calls a new kernel helper `kernel.task.create_from_meeting` (the pattern of `kernel.task.create_from_todo`): the task gets the confirmed title, due date and position, `source_ref` to the item, and `tainted` while the AI text is unedited. No RPC route reaches the helper directly.
- Checks in code decide what is clean: a number in the summary or decisions must appear in the transcript (#1237's rule); each item's time names a real segment; dates are parsed by code; the assignee is an attendee with a position; no link, email or phone in a title.

### 9. Budgets and the kill switch

- `meetings.transcribe` and `meetings.summary` count against a `meetings` module budget.
- The meter records the audio seconds of a transcription call and prices them by a deployment setting; before the call it admits on the length the sandbox measured. A refusal defers the meeting (`usage_deferral`, `ai_budget`).
- The existing kill switches (org, module `meetings`, global) stop new calls; recording, storage, playback and deletion go on.
- Caps on length and size per meeting are deployment settings with defaults (plan section 10).

## Consequences

- Seven new tenant tables, worker-only definers, a new upload purpose, a blob cipher in a protected package, a new sandbox image with its CI job, and a kernel task helper: each step is reviewed by the Platform PO, the tables by the two-step rule.
- Real erasure of audio without delete rights on old object versions; the cost is that losing `CREDENTIAL_KEY` loses all meeting audio, as it loses channel tokens. The credential-key runbook says so.
- Owners cannot read attendees-only meetings. Some owners will want to; the share-with-org choice is the answer, and a break-glass read is not offered.
- A meeting's processing depends on the member-context run (#1677); until it is built, transcription waits.
- The meter gains a second measure (audio seconds); every report of AI use shows it.

## Alternatives considered

- **Delete audio objects instead of shredding.** Rejected: old versions, bucket backups and object locks keep copies Crove cannot remove.
- **Encrypt transcripts too.** Rejected for the first slice: text rows are mutable and deleted; a key in the database is in the same backups as the text, so it buys nothing without the restore replay, which deletion also gets.
- **Parse media in `crove-extract`.** Rejected: it forbids child processes and native code on purpose; a transcoder in it would weaken the gate for invoices.
- **Transcode in the browser.** Rejected as the only path: decoding an hour of audio in a phone's memory is not reliable, and uploads from other tools would still need the server. The recorder records in a compact format, and the sandbox normalizes everything.
- **Action items as kernel proposals.** Rejected: they would expose meeting content to approvers who are not readers.
- **Process in the worker's system context.** Rejected by the owner's per-member Vy rule: the system context would read every meeting.

## Revisit when

- The lawyer's answers change what consent needs.
- A meeting bot or live notes are planned (consent inside the call, a connector's credentials).
- Teams exist, so a meeting can be shared with a team.
- Search or the personal-data finder reach transcripts (a folded index of private text).
