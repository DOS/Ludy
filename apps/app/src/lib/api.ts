import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { createTanstackQueryUtils } from '@orpc/tanstack-query';
import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import type { RecordingStopReason } from '@ludy/meeting-recorder';
import { mediaUploadQuery, needsAudioExtraction } from './meeting-upload.ts';
import { DIRECT_UPLOAD_MAX_BYTES, ENEX_MAX_FILE_BYTES, MAX_IMPORT_BYTES, MAX_MEETING_AUDIO_BYTES, MAX_MEETING_VIDEO_BYTES, MAX_SOCIAL_VIDEO_BYTES, MAX_UPLOAD_BYTES, NOTE_ATTACHMENT_MAX_BYTES, TODOIST_CSV_MAX_BYTES, type contract, type EnexImportResult, type NoteAttachment, type TodoistImportResult, type UploadPurpose } from '@ludy/kernel-contract';
import { activeLocale, translator } from '../i18n/runtime.ts';
import { apiUrl, serverOrigin } from './api-base.ts';
import { accessToken, afterMfaRefusal, auth, getConfig, secondFactorStillOwed } from './auth.ts';
import { ClientError, apiErrorFromResponse, describeError, isMfaRequired, isOrgAccessRevoked, isUnauthenticated, retryWhileBusy } from './errors.ts';
import { createSessionErrorHandler, rememberOrgLeft, requestHeaders, takeOrgLeft } from './org-access.ts';

let currentOrg: string | null = null;

export function setCurrentOrg(slug: string | null): void {
  currentOrg = slug;
}

export function getCurrentOrg(): string | null {
  return currentOrg;
}

async function headers(orgSlug: string | null = currentOrg): Promise<Record<string, string>> {
  return requestHeaders(await accessToken(), orgSlug);
}

const link = new RPCLink({ url: `${serverOrigin()}/api/rpc`, headers: () => headers() });

export const client: ContractRouterClient<typeof contract> = createORPCClient(link);
export const orpc = createTanstackQueryUtils(client);

// The same API without the org header, whatever page this is: the user's own sign-out revoke (issue #247).
const orglessLink = new RPCLink({ url: `${serverOrigin()}/api/rpc`, headers: async () => requestHeaders(await accessToken(), null) });
export const orglessClient: ContractRouterClient<typeof contract> = createORPCClient(orglessLink);

// The API for one org named here rather than by the page: onboarding sets up the org it has just created (issue #324).
export function clientForOrg(slug: string): ContractRouterClient<typeof contract> {
  return createORPCClient(new RPCLink({ url: `${serverOrigin()}/api/rpc`, headers: async () => requestHeaders(await accessToken(), slug) }));
}

export { ClientError, isStepUpRequired, isUnauthenticated } from './errors.ts';

function sessionStore(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

// The MFA_REQUIRED answer being checked, so a burst of refused requests asks once.
let checkingMfa: Promise<void> | null = null;
// When the queries refused with MFA_REQUIRED were last sent again (#1912).
const lastMfaRetry = { at: -Infinity };

// A stale or revoked session signs the user out locally; main.tsx then routes to /login. A session revoked in this
// org only leaves the org: the start page then lists only the orgs this session can enter (issue #247). A session that
// still owes its second factor goes to the challenge instead (issue #32).
const onError = createSessionErrorHandler({
  currentOrg: getCurrentOrg,
  leaveOrg: (slug) => {
    const me = queryClient.getQueryData<{ orgs: Array<{ slug: string; name: string }> }>(orpc.me.get.queryKey());
    rememberOrgLeft(sessionStore(), { name: me?.orgs.find((o) => o.slug === slug)?.name ?? slug });
    setCurrentOrg(null);
    queryClient.clear();
    window.location.assign('/');
  },
  signOut: () => void auth().signOut({ scope: 'local' }),
  openMfa: () => {
    if (window.location.pathname === '/mfa' || checkingMfa) return;
    // A request sent just before this tab verified a second factor is refused too (#1611): loading /mfa then would drop
    // the screen and the work under way on it (a step-up's approval and its toast). A failed answer opens /mfa. When
    // nothing is owed, the queries refused this way load again with the verified session (#1912).
    checkingMfa = afterMfaRefusal({
      stillOwed: () => secondFactorStillOwed(),
      openChallenge: () => window.location.assign('/mfa'),
      retryRefused: () => void queryClient.invalidateQueries({ predicate: (query) => isMfaRequired(query.state.error) }),
      lastRetry: lastMfaRetry,
    }).finally(() => {
      checkingMfa = null;
    });
  },
});

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError }),
  mutationCache: new MutationCache({ onError }),
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: true,
      retry: (count, error) => !isUnauthenticated(error) && !isMfaRequired(error) && !isOrgAccessRevoked(error) && count < 1,
    },
  },
});

// An error in words, in the active locale. Call it while rendering, never when the error is caught, so the text
// follows a language switch (the components that show it re-render through I18nProvider).
export function errorMessage(error: unknown): string {
  return describeError(error, translator(), activeLocale());
}

// Authenticated fetch for non-RPC endpoints (files, export). A refusal throws ApiError with the kernel's code and
// the HTTP status, like the RPC path, so MFA_REQUIRED and a dead session are recognised here too.
export function takeOrgLeftNotice() {
  return takeOrgLeft(sessionStore());
}

export async function apiFetch(
  path: string,
  init: RequestInit & { orgSlug?: string | null } = {},
): Promise<Response> {
  const { orgSlug, ...rest } = init;
  const resolvedOrg = orgSlug === undefined ? currentOrg : orgSlug;
  const response = await fetch(apiUrl(path), {
    ...rest,
    headers: { ...(await headers(resolvedOrg)), ...(rest.headers as Record<string, string> | undefined) },
  });
  if (!response.ok) throw await apiErrorFromResponse(response);
  return response;
}

// A one-time ticket for the invalidation stream of `slug` (issue #69): EventSource cannot send the Authorization
// header, so the stream opens with this ticket, valid for seconds and bound to this session and org.
export async function fetchStreamTicket(slug: string): Promise<string> {
  const response = await fetch(apiUrl('/api/stream/tickets'), { method: 'POST', headers: requestHeaders(await accessToken(), slug) });
  if (!response.ok) throw await apiErrorFromResponse(response);
  return ((await response.json()) as { ticket: string }).ticket;
}

// A ticket for the video of a meeting (#2703): a <video> cannot send the Authorization header, so it streams
// /api/meetings/:id/video/stream with this ticket (at most ten minutes, bound to this session and the meeting).
export async function fetchVideoTicket(meetingId: string): Promise<{ ticket: string; expiresInSeconds: number }> {
  const response = await apiFetch(`/api/meetings/${encodeURIComponent(meetingId)}/video/ticket`, { method: 'POST' });
  return (await response.json()) as { ticket: string; expiresInSeconds: number };
}

// A stored file's bytes. With presigned transfers the kernel hands out a short-lived URL for the exact version it
// recorded (after the same authorization), fetched without Crove's headers; otherwise the kernel streams it.
export async function fetchFile(fileId: string): Promise<Blob> {
  if (getConfig().uploads === 'presigned') {
    const { url } = (await (await apiFetch(`/api/files/${fileId}?link=1`)).json()) as { url: string | null };
    if (url) {
      const response = await fetch(url, { credentials: 'omit' }).catch(() => null);
      if (!response?.ok) throw new ClientError('inbox.storageDownloadFailed', (t) => t('inbox.storageDownloadFailed'));
      return response.blob();
    }
  }
  return (await apiFetch(`/api/files/${fileId}`)).blob();
}

// A customer's image of a conversation message (#2357): the kernel streams it after the same authorization as the thread (a member who may
// not read the thread gets a 404), and it is shown as an image only, from an object URL, never as a page.
export async function fetchConversationImage(attachmentId: string): Promise<Blob> {
  return (await apiFetch(`/api/conversations/attachments/${attachmentId}`)).blob();
}

export async function uploadNoteAttachment(
  noteId: string,
  file: File,
  orgSlug?: string | null,
): Promise<NoteAttachment> {
  if (file.size === 0) {
    throw new ClientError('notes.attachments.emptyFile', (t) => t('notes.attachments.emptyFile'));
  }
  if (file.size > NOTE_ATTACHMENT_MAX_BYTES) {
    throw new ClientError('notes.attachments.fileTooLarge', (t) =>
      t('notes.attachments.fileTooLarge', { name: file.name || 'dinh-kem' }),
    );
  }
  const form = new FormData();
  form.append('file', file, file.name || 'dinh-kem');
  const response = await retryWhileBusy(() =>
    apiFetch(`/api/notes/${encodeURIComponent(noteId)}/attachments`, {
      method: 'POST',
      body: form,
      ...(orgSlug === undefined ? {} : { orgSlug }),
    }),
  );
  const data = (await response.json()) as { attachment: NoteAttachment };
  return data.attachment;
}

export async function fetchNoteAttachmentBlob(
  attachmentId: string,
  orgSlug?: string | null,
): Promise<Blob> {
  const response = await apiFetch(`/api/notes/attachments/${encodeURIComponent(attachmentId)}`, orgSlug === undefined ? {} : { orgSlug });
  return response.blob();
}

export async function importEvernoteEnex(
  file: File,
  options: { targetNotebookId?: string | null; ignoreFileNotebooks?: boolean; skipDuplicates?: boolean } = {},
  orgSlug?: string | null,
): Promise<EnexImportResult> {
  if (file.size === 0) throw new ClientError('notes.import.invalidSizeEmpty', (t) => t('notes.import.invalidSizeEmpty'));
  if (file.size > ENEX_MAX_FILE_BYTES) throw new ClientError('notes.import.invalidSizeLimit', (t) => t('notes.import.invalidSizeLimit'));
  const form = new FormData();
  form.append('file', file);
  if (options.targetNotebookId) form.append('targetNotebookId', options.targetNotebookId);
  if (options.ignoreFileNotebooks) form.append('ignoreFileNotebooks', 'true');
  if (options.skipDuplicates) form.append('skipDuplicates', 'true');
  const response = await retryWhileBusy(() =>
    apiFetch('/api/notes/import/enex', {
      method: 'POST',
      body: form,
      ...(orgSlug === undefined ? {} : { orgSlug }),
    }),
  );
  return (await response.json()) as EnexImportResult;
}

export async function importTodoistCsv(
  file: File,
  options: { targetListId?: string | null; useInboxWhenNoList?: boolean; timeZone?: string; skipDuplicates?: boolean } = {},
  orgSlug?: string | null,
): Promise<TodoistImportResult> {
  if (file.size === 0) throw new ClientError('myWork.import.invalidSizeEmpty', (t) => t('myWork.import.invalidSizeEmpty'));
  if (file.size > TODOIST_CSV_MAX_BYTES) throw new ClientError('myWork.import.invalidSizeLimit', (t) => t('myWork.import.invalidSizeLimit'));
  const form = new FormData();
  form.append('file', file);
  if (options.targetListId) form.append('targetListId', options.targetListId);
  if (options.useInboxWhenNoList) form.append('useInboxWhenNoList', 'true');
  if (options.timeZone) form.append('timeZone', options.timeZone);
  if (options.skipDuplicates) form.append('skipDuplicates', 'true');
  const response = await retryWhileBusy(() =>
    apiFetch('/api/notes/import/todoist', {
      method: 'POST',
      body: form,
      ...(orgSlug === undefined ? {} : { orgSlug }),
    }),
  );
  return (await response.json()) as TodoistImportResult;
}

type Uploaded = { fileId: string; duplicate: boolean };

// A Social upload may be a video of up to 100 MB (#409); the server checks each type's own limit.
// An import spreadsheet (#465) is at most 10 MB. Meeting audio up to 300 MB, video up to 2 GB (#2576).
const maxBytesFor = (purpose: UploadPurpose) =>
  purpose === 'social'
    ? MAX_SOCIAL_VIDEO_BYTES
    : purpose === 'import'
      ? MAX_IMPORT_BYTES
      : purpose === 'meeting_audio'
        ? MAX_MEETING_AUDIO_BYTES
        : purpose === 'meeting_video'
          ? MAX_MEETING_VIDEO_BYTES
          : MAX_UPLOAD_BYTES;
const tooLarge = (file: File, purpose: UploadPurpose) =>
  purpose === 'meeting_audio' || purpose === 'meeting_video'
    ? new ClientError('FILE_TOO_LARGE', (t) => t('kernelErrors.codes.FILE_TOO_LARGE'))
    : purpose === 'social'
    ? new ClientError('inbox.socialFileTooLarge', (t) => t('inbox.socialFileTooLarge', { name: file.name }))
    : new ClientError('inbox.fileTooLarge', (t) => t('inbox.fileTooLarge', { name: file.name }));

// Staged upload for meeting audio or video (#2576): grants uploadId and sends bytes to bucket staging.
export async function stageMediaUpload(file: File, purpose: 'meeting_audio' | 'meeting_video'): Promise<string> {
  if (file.size > maxBytesFor(purpose)) throw tooLarge(file, purpose);
  const grant = (await (await apiFetch('/api/files/uploads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ purpose }) })).json()) as {
    uploadId: string;
    url: string;
    fields: Record<string, string>;
  };
  const form = new FormData();
  for (const [name, value] of Object.entries(grant.fields)) form.append(name, value);
  form.append('file', file);
  const stored = await fetch(grant.url, { method: 'POST', body: form, credentials: 'omit' }).catch(() => null);
  if (!stored?.ok) throw new ClientError('inbox.storageUploadFailed', (t) => t('inbox.storageUploadFailed', { name: file.name }));
  return grant.uploadId;
}

// Encrypted media upload for meeting audio or video (#2576). Works on both STORAGE=s3 (staged upload) and STORAGE=local (direct multipart).
export async function uploadMeetingMedia(
  meetingId: string,
  kind: 'audio' | 'video',
  file: File,
  lengthSeconds?: number,
  // The recording stopped without the recorder's click (A1, #3159): the server keeps the code on the meeting.
  stopReason?: RecordingStopReason,
): Promise<{ fileId: string }> {
  // A video chosen as the audio (a local Zoom or Teams MP4) is sent with extract=audio: the server keeps only its audio and never stores the video (#3337).
  // It is sized and staged as a video, since that is what is transferred.
  const extractAudio = kind === 'audio' && needsAudioExtraction(file);
  const purpose = kind === 'audio' && !extractAudio ? 'meeting_audio' : 'meeting_video';
  if (file.size > maxBytesFor(purpose)) throw tooLarge(file, purpose);

  if (getConfig().uploads === 'presigned') {
    const uploadId = await stageMediaUpload(file, purpose);
    const response = await retryWhileBusy(() =>
      apiFetch(`/api/meetings/${meetingId}/media${extractAudio ? `?${mediaUploadQuery({ kind, extractAudio })}` : ''}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ uploadId, kind, ...(lengthSeconds !== undefined ? { lengthSeconds } : {}), ...(stopReason ? { stopReason } : {}) }),
      }),
    );
    return (await response.json()) as { fileId: string };
  }

  // The file itself as the request body (#2780): the server seals it as it arrives, so a large recording is never held whole
  // there (a multipart form is parsed whole). The kind and the length go in the query, because the body is only the file.
  const query = mediaUploadQuery({ kind, extractAudio, ...(lengthSeconds !== undefined ? { lengthSeconds } : {}), ...(stopReason ? { stopReason } : {}) });
  const response = await retryWhileBusy(() =>
    apiFetch(`/api/meetings/${meetingId}/media?${query}`, {
      method: 'POST',
      headers: { 'content-type': /^(?:audio|video)\/[\w.+-]+$/.test(file.type) ? file.type : 'application/octet-stream' },
      body: file,
    }),
  );
  return (await response.json()) as { fileId: string };
}

// Claims the audio Ludy's worker copied from a meeting platform (meetings integrations C1, #3173): the same media route an upload ends at, with the recording's id in place of an upload id
// and no bytes in the request. The server seals the staged file with the meeting key and records it; a row that is not staged, or is another member's, is refused there.
export async function claimImportedMedia(meetingId: string, recordingId: string): Promise<{ fileId: string }> {
  const response = await retryWhileBusy(() =>
    apiFetch(`/api/meetings/${encodeURIComponent(meetingId)}/media`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ importId: recordingId, kind: 'audio' }),
    }),
  );
  return (await response.json()) as { fileId: string };
}

// Claims the transcript Ludy's worker read from a meeting platform for a recording that has nothing else (C2, #3174): the server takes the staged lines, writes them as the recorder's draft (tainted, labelled
// with the platform) and ends the meeting. Like claimImportedMedia, a row that is not staged, or is another member's, is refused there.
export async function claimImportedTranscript(meetingId: string, recordingId: string): Promise<{ meetingId: string; stored: number }> {
  const response = await retryWhileBusy(() =>
    apiFetch(`/api/meetings/${encodeURIComponent(meetingId)}/transcript-import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ importId: recordingId }),
    }),
  );
  return (await response.json()) as { meetingId: string; stored: number };
}

// One piece of the audio of a live-notes meeting (ADR-0052 L4a, #3109): the raw bytes as the body, the seq and the length in
// the query. Not retried here (the live sender retries by the error's status, which an ApiError carries) and no busy wait: a
// failed piece may be dropped, the recording uploaded at the end is the one that counts.
export async function sendLiveChunk(input: { meetingId: string; seq: number; lengthSeconds: number; blob: Blob }): Promise<void> {
  const query = new URLSearchParams({ seq: String(input.seq), lengthSeconds: String(input.lengthSeconds) });
  // The recorder's type carries codecs ("audio/webm;codecs=opus"): the route wants the plain audio type.
  const base = (input.blob.type.split(';')[0] ?? '').trim();
  await apiFetch(`/api/meetings/${encodeURIComponent(input.meetingId)}/live-chunk?${query.toString()}`, {
    method: 'POST',
    headers: { 'content-type': /^audio\/[\w.+-]+$/.test(base) ? base : 'application/octet-stream' },
    body: input.blob,
  });
}

// Join the live pieces of a recording whose final upload never arrived (ADR-0052 L4a, #3126): the recorder's own click. The kernel reads the pieces in the recorder's
// session, seals the join under a fresh audio key and answers how many pieces it joined and which numbers were missing.
export async function assembleLivePieces(meetingId: string): Promise<{ meetingId: string; fileId: string; pieces: number; missing: number[]; lengthSeconds: number }> {
  const response = await apiFetch(`/api/meetings/${encodeURIComponent(meetingId)}/live-assemble`, { method: 'POST' });
  return (await response.json()) as { meetingId: string; fileId: string; pieces: number; missing: number[]; lengthSeconds: number };
}

// One file through a presigned staging upload (plan §7.6): a single-use form from the kernel, the bytes straight to
// the bucket, then the kernel reads them back, hashes them and records the file.
async function uploadStaged(
  file: File,
  purpose: UploadPurpose,
  legalEntityId?: string,
  orgSlug?: string | null,
): Promise<Uploaded> {
  if (file.size > maxBytesFor(purpose)) throw tooLarge(file, purpose);
  const orgOpt = orgSlug !== undefined ? { orgSlug } : {};
  const grant = (await (await apiFetch('/api/files/uploads', { ...orgOpt, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ purpose }) })).json()) as {
    uploadId: string;
    url: string;
    fields: Record<string, string>;
  };
  const form = new FormData();
  for (const [name, value] of Object.entries(grant.fields)) form.append(name, value);
  // The file goes last: S3 ignores fields after it.
  form.append('file', file);
  // No credentials or Crove headers: the form's signature is the only authorization the bucket sees.
  const stored = await fetch(grant.url, { method: 'POST', body: form, credentials: 'omit' }).catch(() => null);
  if (!stored?.ok) throw new ClientError('inbox.storageUploadFailed', (t) => t('inbox.storageUploadFailed', { name: file.name }));
  // A busy kernel refuses the completion without using the grant, so the same completion is retried.
  const response = await retryWhileBusy(() =>
    apiFetch(`/api/files/uploads/${grant.uploadId}/complete`, {
      ...orgOpt,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: file.name, purpose, ...(legalEntityId ? { legalEntityId } : {}) }),
    }),
  );
  return (await response.json()) as Uploaded;
}

// Bulk intake (#314) sends a file of at most DIRECT_UPLOAD_MAX_BYTES through the kernel even when the store takes
// presigned uploads: a batch of 200 e-invoice XML files would otherwise open 200 upload grants, past the per-user grant
// rate. The kernel refuses a larger one on that path (#432).
// One document of an upload batch, alone in its request, so a refused file never fails the others. legalEntityId: the
// entity it is booked in (#1764), the shell's choice; the kernel checks the uploader sees it, and it never changes.
export async function uploadDocument(file: File, legalEntityId?: string): Promise<Uploaded> {
  if (file.size > MAX_UPLOAD_BYTES) throw tooLarge(file, 'document');
  if (getConfig().uploads === 'presigned' && file.size > DIRECT_UPLOAD_MAX_BYTES) return uploadStaged(file, 'document', legalEntityId);
  const form = new FormData();
  form.append('purpose', 'document');
  if (legalEntityId) form.append('legalEntityId', legalEntityId);
  form.append('file', file);
  const response = await retryWhileBusy(() => apiFetch('/api/files', { method: 'POST', body: form }));
  const { files } = (await response.json()) as { files: Uploaded[] };
  const first = files[0];
  if (!first) throw new ClientError('inbox.storageUploadFailed', (t) => t('inbox.storageUploadFailed', { name: file.name }));
  return first;
}

// The signed agreement of an invoice correction (#2504): a PDF or the photo or scan of the signed paper, stored as an evidence file that is never read as an invoice. Returns its file id.
export async function uploadAgreement(file: File): Promise<string> {
  if (file.size > MAX_UPLOAD_BYTES) throw tooLarge(file, 'agreement');
  const form = new FormData();
  form.append('purpose', 'agreement');
  form.append('file', file);
  // The organization that starts the correction, kept for every try: a switch of organization while the upload waits on a busy retry must never store the agreement in another one.
  const org = currentOrg;
  const response = await retryWhileBusy(() => apiFetch('/api/files', { method: 'POST', body: form, orgSlug: org }));
  const { files } = (await response.json()) as { files: Uploaded[] };
  const first = files[0];
  if (!first) throw new ClientError('inbox.storageUploadFailed', (t) => t('inbox.storageUploadFailed', { name: file.name }));
  return first.fileId;
}

// purpose social: images for a Social post (#372); purpose import: a spreadsheet for a module's import (#465). Both are
// stored but never read as documents.
export async function uploadFiles(
  files: File[],
  purpose: UploadPurpose = 'document',
  orgSlug?: string | null,
): Promise<{ files: Uploaded[] }> {
  if (getConfig().uploads === 'presigned') {
    const results: Uploaded[] = [];
    for (const file of files) results.push(await uploadStaged(file, purpose, undefined, orgSlug));
    return { files: results };
  }
  const orgOpt = orgSlug !== undefined ? { orgSlug } : {};
  const send = async (batch: File[]) => {
    const form = new FormData();
    form.append('purpose', purpose);
    for (const file of batch) form.append('file', file);
    return (await (await retryWhileBusy(() => apiFetch('/api/files', { ...orgOpt, method: 'POST', body: form }))).json()) as { files: Uploaded[] };
  };
  // Social files go one per request, so a video's body stays within the server's limit.
  if (purpose !== 'social') return send(files);
  for (const file of files) if (file.size > maxBytesFor(purpose)) throw tooLarge(file, purpose);
  const results: Uploaded[] = [];
  for (const file of files) results.push(...(await send([file])).files);
  return { files: results };
}
