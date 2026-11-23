// SPDX-License-Identifier: AGPL-3.0-only
// The extension's only network path (ADR-0047 point 10, plan section 5.7). Every request goes to the configured Ludy
// address, built by `ludyUrl`, which refuses any other origin before a request is made; none carries cookies. The one
// exception is the staged upload of a recording to the storage address the configured Ludy server itself granted (a
// single-use signed form, https only), the same step the app takes. The bearer token is the extension token.
import { isLocalhost, ludyUrl } from './ludy-address.ts';
import type { Me } from './features.ts';
import { readAgendaNext, type AgendaNext } from './agenda.ts';
import type { ConsentMethod } from './consent.ts';
import type { RecordingStopReason } from '@ludy/meeting-recorder';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class LudyError extends Error {
  code: string;
  status: number;
  // What the server added to the refusal (a DomainError's details), when it did: the kind and time of CAPTURE_ALREADY_RUNNING.
  details: unknown;
  constructor(code: string, status: number, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

// The body of a refusal: the route's own `{code, message}`, or the RPC wire form `{json: {code, message, data}}` that the app's procedures answer in.
async function failure(response: Response): Promise<LudyError> {
  const raw = (await response.json().catch(() => null)) as { code?: unknown; message?: unknown; data?: unknown; json?: { code?: unknown; message?: unknown; data?: unknown } } | null;
  const body = raw?.json && typeof raw.json === 'object' ? raw.json : raw;
  return new LudyError(typeof body?.code === 'string' ? body.code : 'HTTP_ERROR', response.status, typeof body?.message === 'string' ? body.message : `HTTP ${response.status}`, body?.data);
}

// A signed form's address: https, no credentials. Plain http is accepted only when the configured Ludy address is itself
// plain http on localhost (a stack on the member's own machine), and then only for localhost.
export function assertGrantUrl(value: string, address: string): URL {
  const url = new URL(value);
  const local = isLocalhost(url.hostname) && isLocalhost(new URL(address).hostname) && new URL(address).protocol === 'http:';
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username !== '' || url.password !== '') {
    throw new Error('Refused: the upload address is not a plain https address');
  }
  return url;
}

export interface Uploaded {
  fileId: string;
}

export interface NoteClipInput {
  title: string;
  body?: string;
  tags?: readonly string[];
  sourceUrl?: string | null;
}

export interface NoteWritten {
  noteId: string;
  revision: number;
}

export interface TodoQuickCaptureInput {
  title: string;
  details?: string;
  dueOn?: string | null;
  sourceUrl?: string | null;
}

export interface TodoWritten {
  todoId: string;
  revision: number;
}

export interface MeetingCreate {
  title: string;
  keepVideo: boolean;
  consentMethod: ConsentMethod;
  // The version of the recording notice text this popup showed; the server stores it on the meeting (A1, #3159).
  consentNoticeVersion?: string;
  // Live notes (ADR-0052 L4a): the server defaults to off.
  liveNotes: boolean;
  // The address of the tab being recorded, when the browser gave it (ADR-0055 slice 1, #4123): the server reads which call it names, so a second capture of the same call is refused. Never stored.
  joinUrl?: string;
}

// The server's answer to a heartbeat: whether this capture still holds its call. False never stops the recording.
export interface CaptureBeat {
  open: boolean;
}

export interface Client {
  config(): Promise<{ uploads: 'presigned' | 'direct'; modules?: readonly string[] }>;
  exchangeCode(code: string, codeVerifier: string): Promise<{ token: string; orgId: string; scopes: string[]; expiresAt: string }>;
  me(): Promise<Me>;
  // The member's next calendar meetings (B2, the agenda scope): null when the answer is not the expected shape. Throws LudyError with the HTTP status (403 when the token lacks the scope).
  agendaNext(): Promise<AgendaNext | null>;
  clipNote(input: NoteClipInput): Promise<NoteWritten>;
  quickCaptureTodo(input: TodoQuickCaptureInput): Promise<TodoWritten>;
  createMeeting(input: MeetingCreate): Promise<{ meetingId: string }>;
  // One piece of the audio of a live-notes meeting; throws LudyError with the HTTP status (the live sender retries or gives up by it).
  sendLiveChunk(input: { meetingId: string; seq: number; lengthSeconds: number; blob: Blob }): Promise<void>;
  // The capture is alive (every 30 seconds), or over when `end` is set because the member stopped (ADR-0055 slice 1, #4123). Callers never fail on it.
  captureHeartbeat(input: { meetingId: string; end?: boolean }): Promise<CaptureBeat>;
  // `stopReason`: the recording stopped without the member's click (A1, #3159); the server keeps the code on the meeting.
  // The recording ended and no media will reach the server (nothing saved, the upload failed, the capture failed to start): the meeting gets its end time
  // and the code, once, so the app's recording chip lets go (#3196). The server ignores it when the meeting already has a recording; callers never fail on it.
  recordingStopped(input: { meetingId: string; reason?: RecordingStopReason; lengthSeconds?: number }): Promise<void>;
  uploadMedia(input: { meetingId: string; kind: 'audio' | 'video'; file: File; lengthSeconds: number; uploads: 'presigned' | 'direct'; stopReason?: RecordingStopReason }): Promise<Uploaded>;
}

export function createClient(address: string, token: string | null, fetchImpl: FetchLike = (input, init) => fetch(input, init)): Client {
  const call = async (path: string, init: RequestInit = {}, auth = true): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (auth) {
      if (token === null) throw new LudyError('NOT_SIGNED_IN', 401, 'Chưa đăng nhập');
      headers.set('authorization', `Bearer ${token}`);
    }
    // `redirect: 'error'`: a proxy that answers with a redirect must not send the token (or the request) to another
    // origin; older Chromium within minimum_chrome_version may forward Authorization across origins.
    const response = await fetchImpl(ludyUrl(address, path), { ...init, headers, credentials: 'omit', cache: 'no-store', redirect: 'error' });
    if (!response.ok) throw await failure(response);
    return response;
  };
  const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  // A busy server answers 429 or 503 with Retry-After: the same request is made again, a few times.
  const retryWhileBusy = async <T>(run: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await run();
      } catch (error) {
        if (!(error instanceof LudyError) || (error.status !== 429 && error.status !== 503) || attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
      }
    }
  };
  return {
    async config() {
      const body = (await (await call('/api/config', {}, false)).json()) as { uploads?: unknown; modules?: unknown };
      const uploads = body.uploads === 'presigned' ? 'presigned' : 'direct';
      return Array.isArray(body.modules)
        ? { uploads, modules: body.modules.filter((m): m is string => typeof m === 'string') }
        : { uploads };
    },
    async exchangeCode(code, codeVerifier) {
      return (await (await call('/api/extension/token', json({ code, codeVerifier }), false)).json()) as { token: string; orgId: string; scopes: string[]; expiresAt: string };
    },
    async me() {
      return (await (await call('/api/extension/me')).json()) as Me;
    },
    async agendaNext() {
      return readAgendaNext(await (await call('/api/rpc/meetings/agenda/next', json({ json: {} }))).json());
    },
    async clipNote(input) {
      const payload = {
        json: {
          title: input.title.trim(),
          ...(input.body !== undefined ? { body: input.body } : {}),
          ...(input.tags && input.tags.length > 0 ? { tags: [...input.tags] } : {}),
          ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
        },
      };
      const out = (await (await call('/api/rpc/notes/clip', json(payload))).json()) as { json?: { noteId?: unknown; revision?: unknown } };
      if (typeof out.json?.noteId !== 'string' || typeof out.json?.revision !== 'number') {
        throw new LudyError('BAD_RESPONSE', 502, 'Máy chủ trả lời không đúng dạng');
      }
      return { noteId: out.json.noteId, revision: out.json.revision };
    },
    async quickCaptureTodo(input) {
      const payload = {
        json: {
          title: input.title.trim(),
          ...(input.details !== undefined ? { details: input.details } : {}),
          ...(input.dueOn ? { dueOn: input.dueOn } : {}),
          ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
        },
      };
      const out = (await (await call('/api/rpc/notes/todos/quickCapture', json(payload))).json()) as { json?: { todoId?: unknown; revision?: unknown } };
      if (typeof out.json?.todoId !== 'string' || typeof out.json?.revision !== 'number') {
        throw new LudyError('BAD_RESPONSE', 502, 'Máy chủ trả lời không đúng dạng');
      }
      return { todoId: out.json.todoId, revision: out.json.revision };
    },
    async createMeeting(input) {
      // oRPC's wire format: the input in `json`. Language and visibility take the server's defaults of the app's recorder.
      const body = { json: { title: input.title.trim(), language: 'vi', visibility: 'attendees', keepVideo: input.keepVideo, consentMethod: input.consentMethod, ...(input.consentNoticeVersion ? { consentNoticeVersion: input.consentNoticeVersion } : {}), liveNotes: input.liveNotes, ...(input.joinUrl ? { capture: { joinUrl: input.joinUrl } } : {}) } };
      const out = (await (await call('/api/rpc/meetings/create', json(body))).json()) as { json?: { meetingId?: unknown } };
      if (typeof out.json?.meetingId !== 'string') throw new LudyError('BAD_RESPONSE', 502, 'Máy chủ trả lời không đúng dạng');
      return { meetingId: out.json.meetingId };
    },
    async sendLiveChunk({ meetingId, seq, lengthSeconds, blob }) {
      const query = new URLSearchParams({ seq: String(seq), lengthSeconds: String(lengthSeconds) });
      // The recorder's type carries codecs ("audio/webm;codecs=opus"): the route wants the plain audio type.
      const base = blob.type.split(';')[0]!.trim();
      const type = /^audio\/[\w.+-]+$/.test(base) ? base : 'application/octet-stream';
      await call(`/api/meetings/${encodeURIComponent(meetingId)}/live-chunk?${query.toString()}`, { method: 'POST', headers: { 'content-type': type }, body: blob });
    },
    async captureHeartbeat({ meetingId, end }) {
      const out = (await (await call('/api/rpc/meetings/captureHeartbeat', json({ json: { meetingId, ...(end ? { end: true } : {}) } }))).json()) as { json?: { open?: unknown } };
      return { open: out.json?.open === true };
    },
    async recordingStopped({ meetingId, reason, lengthSeconds }) {
      await call('/api/rpc/meetings/recordingStopped', json({ json: { meetingId, ...(reason ? { reason } : {}), ...(lengthSeconds !== undefined ? { lengthSeconds } : {}) } }));
    },
    async uploadMedia({ meetingId, kind, file, lengthSeconds, uploads, stopReason }) {
      const purpose = kind === 'audio' ? 'meeting_audio' : 'meeting_video';
      if (uploads === 'presigned') {
        const grant = (await (await call('/api/files/uploads', json({ purpose }))).json()) as { uploadId: string; url: string; fields: Record<string, string> };
        const target = assertGrantUrl(grant.url, address);
        const form = new FormData();
        for (const [name, value] of Object.entries(grant.fields)) form.append(name, value);
        // The file goes last: S3 ignores fields after it.
        form.append('file', file);
        const stored = await fetchImpl(target.toString(), { method: 'POST', body: form, credentials: 'omit', redirect: 'error' }).catch(() => null);
        if (!stored?.ok) throw new LudyError('STORAGE_UPLOAD_FAILED', stored?.status ?? 0, 'Không tải được tệp lên kho lưu trữ');
        return (await (await retryWhileBusy(() => call(`/api/meetings/${encodeURIComponent(meetingId)}/media`, json({ uploadId: grant.uploadId, kind, lengthSeconds, ...(stopReason ? { stopReason } : {}) })))).json()) as Uploaded;
      }
      // The file itself as the body (#2780), sealed by the server as it arrives; the kind and length are in the query.
      const query = new URLSearchParams({ kind, lengthSeconds: String(lengthSeconds) });
      if (stopReason) query.set('stopReason', stopReason);
      const type = /^(?:audio|video)\/[\w.+-]+$/.test(file.type) ? file.type : 'application/octet-stream';
      return (await (await retryWhileBusy(() => call(`/api/meetings/${encodeURIComponent(meetingId)}/media?${query.toString()}`, { method: 'POST', headers: { 'content-type': type }, body: file }))).json()) as Uploaded;
    },
  };
}
