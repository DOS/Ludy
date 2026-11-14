// SPDX-License-Identifier: AGPL-3.0-only
// Why a recording stopped without the recorder's own click (Meetings A1, #3159): a code, never text. The server keeps the code
// on the meeting (`crove_meetings.meeting.recording_stop_reason`, same list as `RECORDING_STOP_REASONS` of the kernel contract; a
// test ties the two) so the meeting can say "Ghi âm đã dừng lúc 12:44". The screens turn a code into plain words.

export const RECORDING_STOP_REASONS = ['tab_closed', 'mic_lost', 'permission_lost', 'storage_full', 'left_screen', 'unknown'] as const;
export type RecordingStopReason = (typeof RECORDING_STOP_REASONS)[number];

export const isRecordingStopReason = (value: unknown): value is RecordingStopReason =>
  typeof value === 'string' && (RECORDING_STOP_REASONS as readonly string[]).includes(value);
