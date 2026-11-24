// SPDX-License-Identifier: AGPL-3.0-only
// The desktop client's HTTP calls to the configured Ludy origin: public config, token identity/features, agenda preview,
// meeting creation (which writes the consent record), capture heartbeat, live audio chunks, upload grants and final media.
// Never sends the bearer token anywhere except ludyUrl (and presigned upload POSTs only to validated storage URLs).
import type { FetchLike } from './exchange.ts';
import type { CaptureHeld } from './capture/consent.ts';

export interface PublicDesktopConfig {
  meetingsDesktopCapture: boolean;
  uploads: 'presigned' | 'direct';
  modules: string[];
}

export interface DesktopFeatures {
  meetings: boolean;
  agenda: boolean;
  notes: boolean;
}

export interface DesktopMe {
  tokenId: string;
  orgId: string;
  client: 'desktop' | 'extension';
  scopes: string[];
  expiresAt: string;
  features: DesktopFeatures;
}

export interface AgendaEvent {
  id?: string;
  title: string;
  startsAt: string;
  endsAt: string;
  joinHost: string | null;
}

export interface AgendaNext {
  enabled: boolean;
  events: AgendaEvent[];
}

export type RecordingStopReason = 'user' | 'tab_closed' | 'mic_lost' | 'permission_lost' | 'storage_full' | 'left_screen' | 'unknown';
export type ConsentMethod = 'told_at_start' | 'in_invite' | 'in_writing' | 'in_call_chat';

export class DesktopApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;
  constructor(code: string, status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'DesktopApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const REQUEST_TIMEOUT_MS = 15_000;
const UPLOAD_TIMEOUT_MS = 120_000;

async function readFailure(response: Response): Promise<DesktopApiError> {
  const raw = (await response.json().catch(() => null)) as {
    code?: unknown;
    message?: unknown;
    data?: unknown;
    json?: { code?: unknown; message?: unknown; data?: unknown };
  } | null;
  const body = raw?.json && typeof raw.json === 'object' ? raw.json : raw;
  return new DesktopApiError(
    typeof body?.code === 'string' ? body.code : 'HTTP_ERROR',
    response.status,
    typeof body?.message === 'string' ? body.message : `HTTP ${response.status}`,
    body?.data,
  );
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

export function assertGrantUrl(value: string, ludyUrl: string): URL {
  const url = new URL(value);
  const base = new URL(ludyUrl);
  const local = isLoopbackHost(url.hostname) && isLoopbackHost(base.hostname) && base.protocol === 'http:';
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username !== '' || url.password !== '') {
    throw new Error('Refused: the upload address is not a plain https address');
  }
  return url;
}

function parseDesktopMeBody(raw: unknown): DesktopMe | null {
  if (raw === null || typeof raw !== 'object') return null;
  const body = raw as Record<string, unknown>;
  const client = body.client === 'extension' ? 'extension' : body.client === 'desktop' ? 'desktop' : null;
  if (client === null) return null;
  const scopes = Array.isArray(body.scopes) ? body.scopes.filter((s): s is string => typeof s === 'string') : [];
  const f = (body.features !== null && typeof body.features === 'object' ? body.features : {}) as Record<string, unknown>;
  return {
    tokenId: typeof body.tokenId === 'string' ? body.tokenId : '',
    orgId: typeof body.orgId === 'string' ? body.orgId : '',
    client,
    scopes,
    expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : '',
    features: {
      meetings: f.meetings === true,
      agenda: f.agenda === true,
      notes: f.notes === true,
    },
  };
}

export function readAgendaNext(raw: unknown): AgendaNext | null {
  const body = typeof raw === 'object' && raw !== null && 'json' in raw ? (raw as { json: unknown }).json : raw;
  if (typeof body !== 'object' || body === null) return null;
  const { enabled, events } = body as { enabled?: unknown; events?: unknown };
  if (typeof enabled !== 'boolean' || !Array.isArray(events) || events.length > 5) return null;
  const out: AgendaEvent[] = [];
  for (const e of events) {
    if (typeof e !== 'object' || e === null) return null;
    const { id, title, startsAt, endsAt, joinHost } = e as Record<string, unknown>;
    if (typeof title !== 'string' || typeof startsAt !== 'string' || typeof endsAt !== 'string' || Number.isNaN(Date.parse(startsAt)) || Number.isNaN(Date.parse(endsAt))) return null;
    if (joinHost !== null && typeof joinHost !== 'string') return null;
    out.push({
      ...(typeof id === 'string' ? { id } : {}),
      title: title.slice(0, 200),
      startsAt,
      endsAt,
      joinHost: joinHost === null ? null : joinHost.slice(0, 100),
    });
  }
  return { enabled, events: out };
}

export function parseCaptureHeld(details: unknown): CaptureHeld | null {
  if (typeof details !== 'object' || details === null) return null;
  const { kind, since } = details as { kind?: unknown; since?: unknown };
  return (kind === 'extension' || kind === 'app' || kind === 'desktop') && typeof since === 'string' && !Number.isNaN(new Date(since).getTime())
    ? { kind, since }
    : null;
}

export async function fetchPublicConfig(fetchImpl: FetchLike, ludyUrl: string): Promise<PublicDesktopConfig> {
  try {
    const response = await fetchImpl(`${ludyUrl}/api/config`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return { meetingsDesktopCapture: false, uploads: 'direct', modules: [] };
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    return {
      meetingsDesktopCapture: body?.meetingsDesktopCapture === true,
      uploads: body?.uploads === 'presigned' ? 'presigned' : 'direct',
      modules: Array.isArray(body?.modules) ? body.modules.filter((m): m is string => typeof m === 'string') : [],
    };
  } catch {
    return { meetingsDesktopCapture: false, uploads: 'direct', modules: [] };
  }
}

export type DesktopMeResult = { status: 'valid'; me: DesktopMe } | { status: 'revoked' } | { status: 'unreachable' };

export async function fetchDesktopMe(fetchImpl: FetchLike, ludyUrl: string, token: string): Promise<DesktopMeResult> {
  try {
    const response = await fetchImpl(`${ludyUrl}/api/extension/me`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 401) return { status: 'revoked' };
    if (response.status !== 200) return { status: 'unreachable' };
    const body = await response.json().catch(() => null);
    const me = parseDesktopMeBody(body);
    return me ? { status: 'valid', me } : { status: 'unreachable' };
  } catch {
    return { status: 'unreachable' };
  }
}

export async function fetchAgendaNext(fetchImpl: FetchLike, ludyUrl: string, token: string): Promise<AgendaNext | null> {
  const response = await fetchImpl(`${ludyUrl}/api/rpc/meetings/agenda/next`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ json: {} }),
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw await readFailure(response);
  return readAgendaNext(await response.json().catch(() => null));
}

export interface DesktopMeetingCreateInput {
  title: string;
  consentMethod: ConsentMethod;
  consentNoticeVersion: string;
  liveNotes: boolean;
  agendaId?: string;
  joinUrl?: string;
}

export async function createDesktopMeeting(fetchImpl: FetchLike, ludyUrl: string, token: string, input: DesktopMeetingCreateInput): Promise<{ meetingId: string }> {
  const capture: { agendaId?: string; joinUrl?: string } = {};
  if (input.agendaId) capture.agendaId = input.agendaId;
  if (input.joinUrl) capture.joinUrl = input.joinUrl;
  const payload = {
    json: {
      title: input.title.trim(),
      language: 'vi',
      visibility: 'attendees',
      keepVideo: false,
      consentMethod: input.consentMethod,
      consentNoticeVersion: input.consentNoticeVersion,
      liveNotes: input.liveNotes,
      ...(capture.agendaId || capture.joinUrl ? { capture } : {}),
    },
  };
  const response = await fetchImpl(`${ludyUrl}/api/rpc/meetings/create`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload),
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw await readFailure(response);
  const out = (await response.json().catch(() => null)) as { json?: { meetingId?: unknown } } | null;
  if (typeof out?.json?.meetingId !== 'string') throw new DesktopApiError('BAD_RESPONSE', 502, 'Máy chủ trả lời không đúng dạng');
  return { meetingId: out.json.meetingId };
}

export async function sendCaptureHeartbeat(fetchImpl: FetchLike, ludyUrl: string, token: string, input: { meetingId: string; end?: boolean }): Promise<{ open: boolean }> {
  const response = await fetchImpl(`${ludyUrl}/api/rpc/meetings/captureHeartbeat`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ json: { meetingId: input.meetingId, ...(input.end ? { end: true } : {}) } }),
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw await readFailure(response);
  const out = (await response.json().catch(() => null)) as { json?: { open?: unknown } } | null;
  return { open: out?.json?.open === true };
}

export async function sendDesktopLiveChunk(
  fetchImpl: FetchLike,
  ludyUrl: string,
  token: string,
  input: { meetingId: string; seq: number; lengthSeconds: number; bytes: Uint8Array; mimeType: string },
): Promise<void> {
  const query = new URLSearchParams({ seq: String(input.seq), lengthSeconds: String(input.lengthSeconds) });
  const base = input.mimeType.split(';')[0]?.trim() ?? '';
  const contentType = /^audio\/[\w.+-]+$/.test(base) ? base : 'application/octet-stream';
  const bodyBytes = Uint8Array.from(input.bytes);
  const response = await fetchImpl(`${ludyUrl}/api/meetings/${encodeURIComponent(input.meetingId)}/live-chunk?${query.toString()}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': contentType, 'content-length': String(bodyBytes.byteLength) },
    body: bodyBytes,
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw await readFailure(response);
}

export async function sendDesktopRecordingStopped(
  fetchImpl: FetchLike,
  ludyUrl: string,
  token: string,
  input: { meetingId: string; reason?: RecordingStopReason; lengthSeconds?: number },
): Promise<void> {
  const response = await fetchImpl(`${ludyUrl}/api/rpc/meetings/recordingStopped`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ json: { meetingId: input.meetingId, ...(input.reason ? { reason: input.reason } : {}), ...(input.lengthSeconds !== undefined ? { lengthSeconds: input.lengthSeconds } : {}) } }),
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw await readFailure(response);
}

async function retryWhileBusy<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof DesktopApiError) || (error.status !== 429 && error.status !== 503) || attempt >= 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
}

export async function uploadDesktopMedia(
  fetchImpl: FetchLike,
  ludyUrl: string,
  token: string,
  input: { meetingId: string; bytes: Uint8Array; mimeType: string; lengthSeconds: number; uploads: 'presigned' | 'direct'; stopReason?: RecordingStopReason },
): Promise<{ fileId: string }> {
  const base = input.mimeType.split(';')[0]?.trim() ?? '';
  const type = /^audio\/[\w.+-]+$/.test(base) ? base : 'audio/webm';
  const ext = type.endsWith('/ogg') ? 'ogg' : 'webm';
  const bodyBytes = Uint8Array.from(input.bytes);

  if (input.uploads === 'presigned') {
    const grantRes = await fetchImpl(`${ludyUrl}/api/files/uploads`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ purpose: 'meeting_audio' }),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!grantRes.ok) throw await readFailure(grantRes);
    const grant = (await grantRes.json()) as { uploadId: string; url: string; fields: Record<string, string> };
    const target = assertGrantUrl(grant.url, ludyUrl);
    const form = new FormData();
    for (const [k, v] of Object.entries(grant.fields)) form.append(k, v);
    form.append('file', new Blob([bodyBytes], { type }), `meeting-${input.meetingId}.${ext}`);
    const stored = await fetchImpl(target.toString(), { method: 'POST', body: form, redirect: 'error', signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) }).catch(() => null);
    if (!stored?.ok) throw new DesktopApiError('STORAGE_UPLOAD_FAILED', stored?.status ?? 0, 'Không tải được tệp lên kho lưu trữ');
    return retryWhileBusy(async () => {
      const finRes = await fetchImpl(`${ludyUrl}/api/meetings/${encodeURIComponent(input.meetingId)}/media`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ uploadId: grant.uploadId, kind: 'audio', lengthSeconds: input.lengthSeconds, ...(input.stopReason ? { stopReason: input.stopReason } : {}) }),
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!finRes.ok) throw await readFailure(finRes);
      return (await finRes.json()) as { fileId: string };
    });
  }

  const query = new URLSearchParams({ kind: 'audio', lengthSeconds: String(input.lengthSeconds) });
  if (input.stopReason) query.set('stopReason', input.stopReason);
  return retryWhileBusy(async () => {
    const res = await fetchImpl(`${ludyUrl}/api/meetings/${encodeURIComponent(input.meetingId)}/media?${query.toString()}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': type, 'content-length': String(bodyBytes.byteLength) },
      body: bodyBytes,
      redirect: 'error',
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    if (!res.ok) throw await readFailure(res);
    return (await res.json()) as { fileId: string };
  });
}
