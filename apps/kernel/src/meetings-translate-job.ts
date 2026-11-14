// SPDX-License-Identifier: AGPL-3.0-only
// The job of one transcript translation run (meetings integrations E2, #3185): ids only, never text. The worker (worker.ts) queues it from the event the member's start command
// emitted and hands it to the run in member-vy-ports.ts; the run reads the text through the member-Vy door, so a job that outlives its meeting or its member finds nothing to read.
export interface MeetingsTranslateJob {
  orgId: string;
  meetingId: string;
  runId: string;
  agentId: string;
  // The member the run acts for (the context is sealed to them; this only names them to the model port).
  memberUserId: string;
  // The stage of the transcript the member reads: the recorder's draft or the published lines.
  stage: 'draft' | 'published';
  // The ids of the lines this run translates, in any order (the run takes them in the order of the transcript).
  lineIds: string[];
}
