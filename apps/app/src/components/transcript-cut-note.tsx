// SPDX-License-Identifier: AGPL-3.0-only
// "Bản chép lời của nền tảng bị cắt" (#3922): a transcript Ludy imported from a meeting platform (Google Meet, Microsoft Teams) was longer than the platform's adapter reads or the draft takes, so the draft stops
// early. One line for the recorder, from the meeting's own flag (set with the import, cleared when the draft is replaced), so it is there whichever page the background claim ran on. Nothing for a whole transcript.
import { useTranslations } from 'use-intl';
import type { MeetingDetail } from '@crove/kernel-contract';

export function TranscriptCutNote({ meeting }: { meeting: Pick<MeetingDetail, 'platformTranscriptCut' | 'isRecorder'> }) {
  const t = useTranslations('meetings.detail');
  if (!meeting.isRecorder || !meeting.platformTranscriptCut) return null;
  return (
    <div role="status" data-testid="transcript-cut" className="rounded-lg border border-warning/50 bg-warning/10 p-3 text-sm">
      {t('transcriptCut')}
    </div>
  );
}
