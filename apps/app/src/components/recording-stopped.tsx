// SPDX-License-Identifier: AGPL-3.0-only
// The visible "Ghi âm đã dừng lúc 12:44" on a meeting whose recording ended without the recorder's click (Meetings A1, #3159):
// when it stopped (the start plus what was recorded) and why, in plain words. Nothing is shown for a recording the recorder stopped.
import { useTranslations } from 'use-intl';
import type { MeetingDetail } from '@crove/kernel-contract';
import { useFormat } from '../i18n/provider.tsx';

export function RecordingStoppedNote({ meeting }: { meeting: Pick<MeetingDetail, 'recordingStopReason' | 'endedAt'> }) {
  const t = useTranslations('meetings');
  const f = useFormat();
  if (!meeting.recordingStopReason) return null;
  return (
    <div role="status" data-testid="recording-stopped" className="rounded-lg border border-warning/50 bg-warning/10 p-3 text-sm">
      <div className="font-medium">{t('detail.stoppedAt', { time: meeting.endedAt ? f.time(meeting.endedAt) : '' })}</div>
      <div className="text-xs text-muted-foreground">{t(`stopReason.${meeting.recordingStopReason}`)}</div>
    </div>
  );
}
