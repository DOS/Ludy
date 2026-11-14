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
} as const;
