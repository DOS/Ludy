// SPDX-License-Identifier: AGPL-3.0-only
// The messages between the popup, the background worker and the offscreen document. The popup and the background worker
// read storage (the popup calls /api/extension/me and the upload retry with the token); the offscreen document cannot, so
// the worker hands it the token of the one org and the address for the one recording. Every receiver checks who sent a
// message and the shape of what it carries (`parseStartRequest`, `parseCaptureStart`) before acting on it.
import { CONSENT_METHODS, type ConsentMethod } from './consent.ts';

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

export type OffscreenMessage = CaptureStart | { target: 'offscreen'; type: 'capture-stop' };

export interface Tick {
  type: 'tick';
  elapsedMs: number;
}

// The offscreen document's once-a-second tick, or null when its time is not a finite, non-negative number: the badge clock is
// built from it, and a NaN, an Infinity, a string or a negative value must not reach `formatClock` or the toolbar title.
export function parseTick(raw: unknown): Tick | null {
  if (!isObject(raw) || raw.type !== 'tick') return null;
  const { elapsedMs } = raw;
  return typeof elapsedMs === 'number' && Number.isFinite(elapsedMs) && elapsedMs >= 0 ? { type: 'tick', elapsedMs } : null;
}

export type StartFailure = 'invalid' | 'title' | 'consentMethod' | 'consentAgreed' | 'permission' | 'busy' | 'signedOut' | 'device' | 'store' | 'setup';
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

// Only this extension's own pages and worker may send it a message: an id that is not ours (another extension, a page
// that reached the runtime) is refused. `chrome.runtime.id` is passed in so the check tests without a browser.
export const isOwnSender = (sender: unknown, ownId: string | undefined): boolean =>
  typeof ownId === 'string' && ownId !== '' && typeof sender === 'object' && sender !== null && (sender as { id?: unknown }).id === ownId;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

// The start request of the popup, or null when any field is not what it must be. The flags are booleans, not truthy
// values: a string "false" must not count as consent, nor as a video that was not asked for.
export function parseStartRequest(raw: unknown): StartRequest | null {
  if (!isObject(raw)) return null;
  const { title, consentMethod, consentAgreed, keepVideo, streamId } = raw;
  if (typeof title !== 'string' || typeof consentMethod !== 'string' || typeof streamId !== 'string' || streamId === '') return null;
  if (typeof consentAgreed !== 'boolean' || typeof keepVideo !== 'boolean') return null;
  return { title, consentMethod, consentAgreed, keepVideo, streamId };
}

// The worker's capture command for the offscreen document, or null when it is malformed.
export function parseCaptureStart(raw: unknown): CaptureStart | null {
  if (!isObject(raw) || raw.target !== 'offscreen' || raw.type !== 'capture-start') return null;
  const { address, token, orgId, uploads, title, consentMethod, consentAgreed, keepVideo, streamId } = raw;
  const request = parseStartRequest({ title, consentMethod, consentAgreed, keepVideo, streamId });
  if (!request || typeof address !== 'string' || typeof token !== 'string' || typeof orgId !== 'string') return null;
  if (uploads !== 'presigned' && uploads !== 'direct') return null;
  if (!(CONSENT_METHODS as readonly string[]).includes(request.consentMethod)) return null;
  return { target: 'offscreen', type: 'capture-start', address, token, orgId, uploads, ...request, consentMethod: request.consentMethod as ConsentMethod };
}
