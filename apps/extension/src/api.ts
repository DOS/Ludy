// SPDX-License-Identifier: AGPL-3.0-only
// The extension's only network path (ADR-0047 point 10, plan section 5.7). Every request goes to the configured Ludy
// address, built by `ludyUrl`, which refuses any other origin before a request is made; none carries cookies. The one
// exception is the staged upload of a recording to the storage address the configured Ludy server itself granted (a
// single-use signed form, https only), the same step the app takes. The bearer token is the extension token.
import { isLocalhost, ludyUrl } from './ludy-address.ts';
import type { Me } from './features.ts';
import type { ConsentMethod } from './consent.ts';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class LudyError extends Error {
  code: string;
  status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function failure(response: Response): Promise<LudyError> {
  const body = (await response.json().catch(() => null)) as { code?: unknown; message?: unknown } | null;
  return new LudyError(typeof body?.code === 'string' ? body.code : 'HTTP_ERROR', response.status, typeof body?.message === 'string' ? body.message : `HTTP ${response.status}`);
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

export interface MeetingCreate {
  title: string;
  keepVideo: boolean;
  consentMethod: ConsentMethod;
}

export interface Client {
  config(): Promise<{ uploads: 'presigned' | 'direct' }>;
  exchangeCode(code: string, codeVerifier: string): Promise<{ token: string; orgId: string; scopes: string[]; expiresAt: string }>;
  me(): Promise<Me>;
  createMeeting(input: MeetingCreate): Promise<{ meetingId: string }>;
  uploadMedia(input: { meetingId: string; kind: 'audio' | 'video'; file: File; lengthSeconds: number; uploads: 'presigned' | 'direct' }): Promise<Uploaded>;
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
      const body = (await (await call('/api/config', {}, false)).json()) as { uploads?: unknown };
      return { uploads: body.uploads === 'presigned' ? 'presigned' : 'direct' };
    },
    async exchangeCode(code, codeVerifier) {
      return (await (await call('/api/extension/token', json({ code, codeVerifier }), false)).json()) as { token: string; orgId: string; scopes: string[]; expiresAt: string };
    },
    async me() {
      return (await (await call('/api/extension/me')).json()) as Me;
    },
    async createMeeting(input) {
      // oRPC's wire format: the input in `json`. Language and visibility take the server's defaults of the app's recorder.
      const body = { json: { title: input.title.trim(), language: 'vi', visibility: 'attendees', keepVideo: input.keepVideo, consentMethod: input.consentMethod } };
      const out = (await (await call('/api/rpc/meetings/create', json(body))).json()) as { json?: { meetingId?: unknown } };
      if (typeof out.json?.meetingId !== 'string') throw new LudyError('BAD_RESPONSE', 502, 'Máy chủ trả lời không đúng dạng');
      return { meetingId: out.json.meetingId };
    },
    async uploadMedia({ meetingId, kind, file, lengthSeconds, uploads }) {
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
        return (await (await retryWhileBusy(() => call(`/api/meetings/${encodeURIComponent(meetingId)}/media`, json({ uploadId: grant.uploadId, kind, lengthSeconds })))).json()) as Uploaded;
      }
      const form = new FormData();
      form.append('kind', kind);
      form.append('file', file);
      form.append('lengthSeconds', String(lengthSeconds));
      return (await (await retryWhileBusy(() => call(`/api/meetings/${encodeURIComponent(meetingId)}/media?kind=${kind}`, { method: 'POST', body: form }))).json()) as Uploaded;
    },
  };
}
