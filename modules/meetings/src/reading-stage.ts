// SPDX-License-Identifier: AGPL-3.0-only
// Which stage of a meeting's transcript lines the caller reads (#4910, point 2 and 3): the recorder's working draft while one exists, else the published lines. It is the rule of the
// transcript page (meetings.transcript.get) and the file (meetings.transcript.download), kept in one place for the reads that
// derive something from the lines (Ask Vy about a meeting, the link suggestion). Row security does the rest: only the recorder is shown a draft line, so for every other reader this is
// always the published lines. The stage is found with a small read, so the caller then reads one stage only, never a mix of the shared text and a newer draft of it.
import type { QueryContext } from '@ludy/kernel-runtime';
import type { TranscriptStage } from '@ludy/kernel-contract';

export async function readingStage(trx: QueryContext['trx'], orgId: string, meetingId: string): Promise<TranscriptStage> {
  const draft = await trx.selectFrom('ludy_meetings.transcript_segment').select('id').where('org_id', '=', orgId).where('meeting_id', '=', meetingId).where('stage', '=', 'draft').limit(1).executeTakeFirst();
  return draft ? 'draft' : 'published';
}
