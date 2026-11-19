// SPDX-License-Identifier: AGPL-3.0-only
// The features of Vy working for one member (ADR-0049, issue #2782): which ones exist, the module whose budget and kill switch each counts
// against, and how long one run may live. Pure data: a member-Vy feature module is a function of its input and imports no runtime, no
// database client and no vendor SDK (packages/agent/test/invariant/member-vy-boundary.test.ts). The kernel keeps the same table for its
// commands (packages/kernel/src/member-vy.ts); each side's test pins the same literal (packages/agent/test/member-vy-features.test.ts, apps/kernel/test/member-vy-features.test.ts).
export const MEMBER_VY_FEATURE_TABLE = {
  'notes.summary': { module: 'notes', expiryMinutes: 30 },
  'notes.todo_suggest': { module: 'notes', expiryMinutes: 30 },
  // The recorder's Vy transcribing one meeting in the background (#2578, M4b): the longest run, the kernel's 4 hour cap.
  'meetings.transcribe': { module: 'meetings', expiryMinutes: 240 },
  // The recorder's Vy summarizing one meeting in the foreground (#2580, M6): one model call over the transcript, the member waiting for it.
  'meetings.summary': { module: 'meetings', expiryMinutes: 30 },
  // The recorder's Vy taking live notes of one meeting being recorded (#3110, L4a-2): one run per window of one or two pieces (15 to 30 seconds), so a window that
  // fails or is abandoned never holds the next one; its own key, so it never cuts off a transcription or a summary (#3029).
  'meetings.live_notes': { module: 'meetings', expiryMinutes: 30 },
  // The running notes of a live-notes meeting (#3110): one model call over the new preview lines and the previous notes, the recorder's pane waiting for it. A run of its own,
  // because a member's Vy has one live run per feature and a window (meetings.live_notes) may be running.
  'meetings.live_summary': { module: 'meetings', expiryMinutes: 30 },
  // The member's Vy translating the summary of a meeting between Vietnamese and English in the foreground (meetings integrations E1, #3184): one model call, the member waiting for it. Its own key, so it
  // never cuts off a transcription, a summary or live notes (#3029); any reader of the meeting may ask, for what they read.
  'meetings.translate': { module: 'meetings', expiryMinutes: 30 },
  // The member's Vy answering one question across the meetings the member reads, a citation to a transcript line on every sentence (meetings integrations A3, #3161): one model call over at most 40 lines the
  // member's own search found, the member waiting for it. Its own key, so it never cuts off a transcription, a summary, a translation or live notes (#3029); the run's result row holds counts only.
  'meetings.ask': { module: 'meetings', expiryMinutes: 30 },
  // The member's Vy writing the two or three sentences of the brief before a meeting from facts the member's own reads found, a citation to a fact on every sentence (#3543): one model call over at most 23 short
  // facts, the member waiting for it. Its own key, so it never cuts off a transcription, a summary, a translation, a question or live notes (#3029); the run's result row holds counts only.
  'meetings.brief': { module: 'meetings', expiryMinutes: 30 },
  // The recorder's Vy writing the table of contents of one meeting in the foreground (#3844): one model call over the transcript, the member waiting for it. Its own key, so it never cuts off a transcription, a summary, a translation, a question or live notes (#3029).
  'meetings.chapters': { module: 'meetings', expiryMinutes: 30 },
  // The recorder's Vy suggesting up to three titles for one meeting from its transcript in the foreground (#3947): one model call, the member waiting for it, the candidates shown and never stored. Its own key, so it
  // never cuts off a transcription, a summary, a translation, a question, a brief or chapters (#3029).
  'meetings.title': { module: 'meetings', expiryMinutes: 30 },
  // The recorder's Vy listing what each speaker of one meeting committed to or decided, from the transcript, in the foreground (#3954): one model call, the member waiting for it, the lines shown and never stored. Its own key, so it never cuts off a transcription, a summary, a translation, a question, a brief, chapters or a title (#3029).
  'meetings.commitments': { module: 'meetings', expiryMinutes: 30 },
  // The member's Vy naming who an action item belongs to from the name said in the meeting, when code found nobody (#3921): one model call over a name and at most 100 names, the member waiting for it. Its own key,
  // so it never cuts off a transcription, a summary, a translation, a question, a brief or live notes (#3029); the run's result row holds counts only.
  'meetings.assignee': { module: 'meetings', expiryMinutes: 30 },
  'projects.tasks_from_note': { module: 'projects', expiryMinutes: 30 },
  'projects.tasks_from_source': { module: 'projects', expiryMinutes: 30 },
} as const;
