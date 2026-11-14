// SPDX-License-Identifier: AGPL-3.0-only
// The in-app side of the always-visible recording indicator (Meetings A1, #3159). The recorder screen publishes what it is
// recording here, and the header chip reads it, so the chip shows on every screen while this member records in the app.
// Nothing leaves the device: it is a small in-memory store, never persisted. (A recording made by the extension reaches the
// chip through the server instead: `meetings.meeting.recording_now`.)

export interface LocalRecording {
  meetingId: string;
  title: string;
  paused: boolean;
  // The exact recorded time (the recorder's own clock, which stops while paused).
  elapsedMs(): number;
}

let current: LocalRecording | null = null;
const listeners = new Set<() => void>();

export function setLocalRecording(next: LocalRecording | null): void {
  current = next;
  for (const listener of listeners) listener();
}

export const subscribeLocalRecording = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export const getLocalRecording = (): LocalRecording | null => current;
