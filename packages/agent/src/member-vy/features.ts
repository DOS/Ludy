// SPDX-License-Identifier: AGPL-3.0-only
// The features of Vy working for one member (ADR-0049, issue #2782): which ones exist, the module whose budget and kill switch each counts
// against, and how long one run may live. Pure data: a member-Vy feature module is a function of its input and imports no runtime, no
// database client and no vendor SDK (packages/agent/test/invariant/member-vy-boundary.test.ts). The kernel keeps the same table for its
// commands (packages/kernel/src/member-vy.ts); each side's test pins the same literal (packages/agent/test/member-vy-features.test.ts, apps/kernel/test/member-vy-features.test.ts).
export const MEMBER_VY_FEATURE_TABLE = {
  'notes.summary': { module: 'notes', expiryMinutes: 30 },
  'notes.todo_suggest': { module: 'notes', expiryMinutes: 30 },
  'notes.todo_plan': { module: 'notes', expiryMinutes: 30 },
  'notes.organize': { module: 'notes', expiryMinutes: 30 },
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
  // The member's Vy preparing checked daily prep lines for up to five meetings on the morning briefing (#5073): system-started only when opted in, counts-only result row, never supersedes an active run.
  'meetings.brief_daily': { module: 'meetings', expiryMinutes: 30, systemStartable: true },
  // The recorder's Vy writing the table of contents of one meeting in the foreground (#3844): one model call over the transcript, the member waiting for it. Its own key, so it never cuts off a transcription, a summary, a translation, a question or live notes (#3029).
  'meetings.chapters': { module: 'meetings', expiryMinutes: 30 },
  // The recorder's Vy suggesting up to three titles for one meeting from its transcript in the foreground (#3947): one model call, the member waiting for it, the candidates shown and never stored. Its own key, so it
  // never cuts off a transcription, a summary, a translation, a question, a brief or chapters (#3029).
  'meetings.title': { module: 'meetings', expiryMinutes: 30 },
  // The recorder's Vy listing what each speaker of one meeting committed to or decided, from the transcript, in the foreground (#3954): one model call, the member waiting for it, the lines shown and never stored. Its own key, so it never cuts off a transcription, a summary, a translation, a question, a brief, chapters or a title (#3029).
  'meetings.commitments': { module: 'meetings', expiryMinutes: 30 },
  // The recorder's Vy drafting a personal-note follow-up email from the meeting's summary, decisions and action items (#4292): one model call, the member waiting for it, edited before send and never stored in vy_result (counts only).
  'meetings.followup_note': { module: 'meetings', expiryMinutes: 30 },
  // The recorder's Vy suggesting the minutes template of one meeting from its transcript when code could not tell, in the foreground (#4772): one model call, the member waiting for it, the answer shown and never stored (counts only). Its own key, so it never cuts off a transcription, a summary, a translation, a question, a brief, chapters, commitments or a title (#3029).
  'meetings.template_suggest': { module: 'meetings', expiryMinutes: 30 },
  // The recorder's Vy proposing the next step and a note for the deal a meeting is linked to, from the published minutes (#4766): one model call, the recorder waiting for it; the proposal is edited and confirmed by the recorder and the run's result row holds counts only.
  'meetings.deal_update': { module: 'meetings', expiryMinutes: 30 },
  // The recorder's Vy listing what a meeting left open, questions asked and not answered and decisions raised and not taken, from the transcript in the foreground (#4768): one model call, the member waiting for it, the lines shown and never stored (counts only). Its own key, so it never cuts off a transcription, a summary, a translation, a question, a brief, chapters, commitments or a title (#3029).
  'meetings.open_points': { module: 'meetings', expiryMinutes: 30 },
  // A member's Vy catching them up in a few cited lines on published minutes they missed (#5130, L33): one foreground model call over published minutes only, shown and never stored (counts only). Its own key, so it never cuts off any other meeting feature (#3029).
  'meetings.catch_up': { module: 'meetings', expiryMinutes: 30 },
  // The recorder's Vy extracting sales call insights (customer concerns, buying signals, agreed next steps with cited transcript line IDs) for a meeting linked to an open deal (#4920): one foreground model call, results returned to the recorder alone and stored as counts only.
  'meetings.sales_insight': { module: 'meetings', expiryMinutes: 30 },
  // The recorder's Vy suggesting up to three labels for one meeting from its title and the labels the recorder already reads, no transcript, in the foreground (#5010): one short model call, the recorder waiting for it, the labels shown and never stored (counts only). Its own key, so it never cuts off a transcription, a summary, a translation, a question, a brief, chapters or a title (#3029).
  'meetings.label_suggest': { module: 'meetings', expiryMinutes: 30 },
  // The member's Vy writing the few sentences of the weekly digest across the meetings the member reads (#3949): one model call over at most 60 short facts the member's own reads found, the member waiting for it.
  // Its own key, so it never cuts off a transcription, a summary, a translation, a question, a brief or live notes (#3029); the run's result row holds counts only.
  'meetings.digest': { module: 'meetings', expiryMinutes: 30 },
  // The member's Vy naming who an action item belongs to from the name said in the meeting, when code found nobody (#3921): one model call over a name and at most 100 names, the member waiting for it. Its own key,
  // so it never cuts off a transcription, a summary, a translation, a question, a brief or live notes (#3029); the run's result row holds counts only.
  'meetings.assignee': { module: 'meetings', expiryMinutes: 30 },
  // The recorder's Vy checking whether a meeting covered its agenda from the agenda lines and the transcript they read (#3959): one model call over a short list and a transcript, the recorder waiting for it. Its own key,
  // so it never cuts off a transcription, a summary, a translation, a question, a brief or live notes (#3029); the run's result row holds counts only.
  'meetings.adherence': { module: 'meetings', expiryMinutes: 30 },
  'projects.tasks_from_note': { module: 'projects', expiryMinutes: 30 },
  'projects.tasks_from_source': { module: 'projects', expiryMinutes: 30 },
} as const;
