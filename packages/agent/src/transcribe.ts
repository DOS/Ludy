// SPDX-License-Identifier: AGPL-3.0-only
// Speech to text for the meetings module (issue #2578, ADR-0047 and ADR-0049 stage A, meetings plan M4a). Two halves:
//
// - Pure functions, input in and parsed output out, no runtime, no database, no org: parseTranscription turns what a
//   provider answered into validated transcript segments, mergeChunkTranscripts joins the 10 minute chunks of one meeting.
//   Nothing in a provider's answer is trusted: times are clamped, text is cut to a stated length, a label is a short plain
//   string, and anything unusable is refused (the answer is data, never an instruction).
// - The provider adapter: transcribeAudio posts one audio chunk to an OpenAI-compatible `/audio/transcriptions` endpoint
//   (Whisper-class, the deployment's own choice: in Ludy Cloud a model run in Vietnam, chosen in the private layer; a
//   self-hosted Ludy can point it at a local model). It is called only through transcribeChunks, which puts every call
//   behind the AI budget meter (`metered('meetings.transcribe')`): the meter admits before the call and records after.
//   Measuring by audio length and the member's own context come with M4b; here the call counts as one call.
//
// Nothing here logs or returns the audio, a transcript or a provider's body: errors carry a kind and an HTTP status only.
import { metered, type AiUsageSink } from './meter.ts';

export interface TranscribeConfig {
  baseURL: string;
  apiKey?: string | null;
  model: string;
  timeoutMs?: number;
  // For tests: replaces the global fetch.
  fetch?: typeof fetch;
}

// One audio chunk of a meeting (the media sandbox cuts a recording into 10 minute chunks).
export interface TranscribeInput {
  audio: Uint8Array;
  filename: string;
  mimeType: string;
  language: 'vi' | 'en';
  // The chunk's own length, and where it starts in the meeting: segment times are the meeting's, not the chunk's.
  lengthSeconds: number;
  offsetSeconds: number;
}

export interface TranscriptSegment {
  startSeconds: number;
  endSeconds: number;
  speakerLabel: string;
  text: string;
}

export const TRANSCRIPT_TEXT_MAX = 4000;
export const TRANSCRIPT_SPEAKER_MAX = 80;
// More segments than this in one chunk is not a transcript of ten minutes.
export const TRANSCRIPT_SEGMENTS_MAX = 5000;
export const DEFAULT_SPEAKER = 'Người nói 1';
const RESPONSE_BYTES_MAX = 8 * 1024 * 1024;

export type TranscriptionErrorKind = 'auth' | 'rate_limit' | 'unavailable' | 'invalid_request' | 'invalid_response' | 'timeout' | 'network';

// What went wrong, never why in words: no body, no text, no audio.
export class TranscriptionError extends Error {
  readonly kind: TranscriptionErrorKind;
  readonly status: number | null;
  constructor(kind: TranscriptionErrorKind, status: number | null = null) {
    super(`transcription failed (${kind}${status === null ? '' : ` ${status}`})`);
    this.name = 'TranscriptionError';
    this.kind = kind;
    this.status = status;
  }
}

const invalid = () => new TranscriptionError('invalid_response');
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const round3 = (value: number) => Math.round(value * 1000) / 1000;
// A lone surrogate (half of an emoji a provider cut) is not valid text for the database: it becomes U+FFFD.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const tidy = (text: string) => text.replace(LONE_SURROGATE, '\uFFFD').replace(/\s+/g, ' ').trim();
// The latest second a transcript may name (the contract's bound for a segment).
const TIMELINE_MAX = 86_400;

// A speaker label is a short plain string; anything else is the default.
export function speakerLabelOf(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_SPEAKER;
  // By code points, so a cut never splits a surrogate pair.
  const label = Array.from(tidy(value)).slice(0, TRANSCRIPT_SPEAKER_MAX).join('');
  return label === '' ? DEFAULT_SPEAKER : label;
}

// Cuts a long text at word boundaries into pieces of at most TRANSCRIPT_TEXT_MAX characters.
function pieces(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > TRANSCRIPT_TEXT_MAX) {
    const cut = rest.lastIndexOf(' ', TRANSCRIPT_TEXT_MAX);
    let at = cut > TRANSCRIPT_TEXT_MAX / 2 ? cut : TRANSCRIPT_TEXT_MAX;
    // Never between the two halves of a surrogate pair.
    const before = rest.charCodeAt(at - 1);
    if (before >= 0xd800 && before <= 0xdbff) at -= 1;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest !== '') out.push(rest);
  return out;
}

export interface ParseOptions {
  // The chunk's length and where it starts in the meeting.
  lengthSeconds: number;
  offsetSeconds: number;
}

// A provider's answer (the `verbose_json` of an OpenAI-compatible transcription: { text, duration?, segments?: [{ start,
// end, text, speaker? }] }) as validated segments on the meeting's own timeline, in time order. Without segments the text
// is one segment over the whole chunk. Empty text is no segment; a silent chunk has none. Throws a TranscriptionError of
// kind invalid_response for an answer that is not an object, holds no usable text field, or is implausibly large.
export function parseTranscription(raw: unknown, options: ParseOptions): TranscriptSegment[] {
  if (!isRecord(raw)) throw invalid();
  const length = Math.max(0, options.lengthSeconds);
  const offset = Math.max(0, options.offsetSeconds);
  const out: TranscriptSegment[] = [];
  const push = (start: number, end: number, speaker: string, text: string) => {
    const clean = tidy(text);
    if (clean === '') return;
    const from = Math.min(Math.max(0, start), length);
    const to = Math.min(Math.max(from, end), length);
    const parts = pieces(clean);
    const total = parts.reduce((n, p) => n + p.length, 0);
    let cursor = from;
    for (const part of parts) {
      const share = parts.length === 1 ? to - from : ((to - from) * part.length) / total;
      out.push({ startSeconds: round3(Math.min(TIMELINE_MAX, offset + cursor)), endSeconds: round3(Math.min(TIMELINE_MAX, offset + cursor + share)), speakerLabel: speaker, text: part });
      cursor += share;
    }
  };
  const segments = raw.segments;
  if (segments !== undefined && segments !== null) {
    if (!Array.isArray(segments) || segments.length > TRANSCRIPT_SEGMENTS_MAX) throw invalid();
    for (const item of segments) {
      if (!isRecord(item) || typeof item.text !== 'string') throw invalid();
      const start = finite(item.start);
      const end = finite(item.end);
      if (start === null || end === null) throw invalid();
      push(start, end, speakerLabelOf(item.speaker), item.text);
    }
  } else if (typeof raw.text === 'string') {
    push(0, length, DEFAULT_SPEAKER, raw.text);
  } else {
    throw invalid();
  }
  return out.sort((a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds);
}

// The chunks of one meeting, each already on the meeting's timeline, as one transcript in time order. A segment a chunk
// repeats exactly (same times, speaker and text, as a provider may at a cut) is kept once.
export function mergeChunkTranscripts(chunks: readonly (readonly TranscriptSegment[])[]): TranscriptSegment[] {
  const seen = new Set<string>();
  const merged: TranscriptSegment[] = [];
  for (const chunk of chunks) {
    for (const segment of chunk) {
      const key = `${segment.startSeconds}|${segment.endSeconds}|${segment.speakerLabel}|${segment.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(segment);
    }
  }
  return merged.sort((a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds);
}

// The body as text, read as a stream and refused once it passes RESPONSE_BYTES_MAX bytes: a provider that never stops
// cannot make the process buffer it.
async function readCapped(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > RESPONSE_BYTES_MAX) throw invalid();
  if (!response.body) throw invalid();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > RESPONSE_BYTES_MAX) {
      await reader.cancel().catch(() => undefined);
      throw invalid();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function kindOf(status: number): TranscriptionErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'unavailable';
  return 'invalid_request';
}

// The provider adapter: one chunk to `${baseURL}/audio/transcriptions`, the answer parsed. Call it through
// transcribeChunks only: that is what puts it behind the meter (packages/agent/test/meter-coverage.test.ts checks every
// call of it sits inside metered()). The usage it reports is empty: the meter counts the call; audio seconds come with M4b.
export async function transcribeAudio(config: TranscribeConfig, input: TranscribeInput): Promise<{ segments: TranscriptSegment[]; usage: { inputTokens: number; outputTokens: number } }> {
  const form = new FormData();
  form.set('file', new Blob([input.audio.slice()], { type: input.mimeType }), input.filename);
  form.set('model', config.model);
  form.set('language', input.language);
  form.set('response_format', 'verbose_json');
  form.set('temperature', '0');
  const url = `${config.baseURL.replace(/\/+$/, '')}/audio/transcriptions`;
  const send = config.fetch ?? fetch;
  let response: Response;
  try {
    response = await send(url, {
      method: 'POST',
      headers: config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {},
      body: form,
      signal: AbortSignal.timeout(config.timeoutMs ?? 10 * 60_000),
    });
  } catch (error: unknown) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new TranscriptionError(timedOut ? 'timeout' : 'network');
  }
  if (!response.ok) throw new TranscriptionError(kindOf(response.status), response.status);
  let raw: unknown;
  try {
    raw = JSON.parse(await readCapped(response));
  } catch (error: unknown) {
    throw error instanceof TranscriptionError ? error : invalid();
  }
  return { segments: parseTranscription(raw, { lengthSeconds: input.lengthSeconds, offsetSeconds: input.offsetSeconds }), usage: { inputTokens: 0, outputTokens: 0 } };
}

// The chunks of one meeting, one after the other, each admitted by the AI budget meter before its call (a spent budget or
// an engaged kill switch refuses it with AiBudgetExhaustedError, and no later chunk is sent), merged into one transcript.
// Needs an AI scope (withAiScope): outside one the call is refused, never sent unmetered.
export async function transcribeChunks(config: TranscribeConfig, chunks: readonly TranscribeInput[], onUsage?: AiUsageSink): Promise<TranscriptSegment[]> {
  const done: TranscriptSegment[][] = [];
  for (const chunk of chunks) {
    const { segments } = await metered('meetings.transcribe', () => transcribeAudio(config, chunk), onUsage);
    done.push(segments);
  }
  return mergeChunkTranscripts(done);
}
