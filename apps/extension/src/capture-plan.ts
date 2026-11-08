// SPDX-License-Identifier: AGPL-3.0-only
// What a recording captures, decided in one place. "Ghi cả video" is off by default; with it off no video track is ever
// requested, so none can be recorded, stored or uploaded (plan section 6: video only when the person ticks it).
import { pickRecorderMime, type RecordingKind } from '@crove/meeting-recorder';

export interface CapturePlan {
  kind: RecordingKind;
  // The type to ask MediaRecorder for (undefined: the browser's own).
  mimeType: string | undefined;
  // Constraints for the tab's stream: a video track only with the tick.
  tabConstraints: { audio: { mandatory: { chromeMediaSource: 'tab'; chromeMediaSourceId: string } }; video: false | { mandatory: { chromeMediaSource: 'tab'; chromeMediaSourceId: string } } };
}

export function capturePlan(input: { streamId: string; keepVideo: boolean; isTypeSupported: (type: string) => boolean }): CapturePlan {
  const kind: RecordingKind = input.keepVideo ? 'video' : 'audio';
  const source = { mandatory: { chromeMediaSource: 'tab' as const, chromeMediaSourceId: input.streamId } };
  return { kind, mimeType: pickRecorderMime(input.isTypeSupported, kind), tabConstraints: { audio: source, video: input.keepVideo ? source : false } };
}
