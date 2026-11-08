// SPDX-License-Identifier: AGPL-3.0-only
// The messages between the popup, the background worker and the offscreen document. Each carries what the receiver needs
// and nothing the receiver may not hold: only the background worker reads storage, and hands the offscreen document the
// token of the one org and the address for the one recording.
import type { ConsentMethod } from './consent.ts';

export interface StartRequest {
  title: string;
  consentMethod: string;
  consentAgreed: boolean;
  keepVideo: boolean;
  // From chrome.tabCapture.getMediaStreamId in the popup, after the member's click on the tab.
  streamId: string;
}

export interface CaptureStart {
  target: 'offscreen';
  type: 'capture-start';
  address: string;
  token: string;
  orgId: string;
  uploads: 'presigned' | 'direct';
  title: string;
  consentMethod: ConsentMethod;
  consentAgreed: boolean;
  keepVideo: boolean;
  streamId: string;
}

export type PopupMessage = ({ type: 'start' } & StartRequest) | { type: 'stop' } | { type: 'status' };
export type OffscreenMessage = CaptureStart | { target: 'offscreen'; type: 'capture-stop' };

export interface Tick {
  type: 'tick';
  elapsedMs: number;
}

export type StartFailure = 'title' | 'consentMethod' | 'consentAgreed' | 'permission' | 'busy' | 'signedOut' | 'device' | 'store' | 'setup';
export type StartReply = { ok: true; meetingId: string; startedAt: number; micMissing: boolean } | { ok: false; reason: StartFailure };
export type StopReply = { ok: true; uploaded: boolean; meetingId: string; message?: string } | { ok: false; reason: 'idle' };

export interface RecordingState {
  meetingId: string;
  title: string;
  startedAt: number;
  keepVideo: boolean;
  micMissing: boolean;
}
export const RECORDING_KEY = 'ludy-extension-recording';
