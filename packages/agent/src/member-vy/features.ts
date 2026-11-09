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
} as const;
