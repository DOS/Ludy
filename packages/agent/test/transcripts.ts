// SPDX-License-Identifier: AGPL-3.0-only
// The transcription eval's set and its runner (#2979, meetings plan M4). A set is a directory (the committed synthetic one, or
// TRANSCRIBE_EVAL_DIR for the private one, outside the repository): each recording (.ogg, .webm, .m4a, .mp3) next to a
// <name>.txt, the reference transcript a person checked, in any subdirectory. Each recording goes through the production
// path: the crove-media sandbox normalizes it to mono Opus and cuts it into 10 minute chunks, then transcribeChunks is called
// with the deployment's TRANSCRIBE_* config (either request mode), and the merged transcript is scored against the reference.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join, relative } from 'node:path';
import { createMediaClient, type MediaClient } from '@crove/media/client';
import {
  scoreTranscript,
  transcribeChunks,
  TranscriptEvalError,
  type FileResult,
  type ScoredTranscript,
  type TranscribeApiMode,
  type TranscribeConfig,
  type TranscribeInput,
} from '../src/index.ts';
import { unmetered } from './support.ts';

export const SYNTHETIC_TRANSCRIPTS = join(import.meta.dirname, 'fixtures', 'transcripts');

const AUDIO_EXTENSIONS = ['.ogg', '.webm', '.m4a', '.mp3'];

export interface TranscriptPair {
  // The path under the set's directory, without the extension.
  id: string;
  audioPath: string;
  referencePath: string;
}

// The files of a directory and its subdirectories. A symbolic link is not followed, so a link to a parent folder cannot loop.
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : [];
    });
}

const extensionOf = (path: string) => path.slice(path.lastIndexOf('.')).toLowerCase();

// Every recording of the set with its reference. A recording without one, or a reference without its recording, is an error
// that names the files: a set that silently drops files measures less than it claims. An empty set is refused too.
export function loadTranscriptSet(dir: string): TranscriptPair[] {
  const files = walk(dir);
  // The reference of each base name, with the path it really has (an upper-case .TXT is matched and read from its own path).
  const references = new Map(files.filter((f) => extensionOf(f) === '.txt').map((f) => [f.slice(0, f.lastIndexOf('.')), f]));
  const problems: string[] = [];
  const pairs: TranscriptPair[] = [];
  for (const path of files) {
    if (!AUDIO_EXTENSIONS.includes(extensionOf(path))) continue;
    const base = path.slice(0, path.lastIndexOf('.'));
    const id = relative(dir, base);
    const referencePath = references.get(base);
    if (referencePath === undefined) {
      problems.push(`${relative(dir, path)}: no ${id}.txt next to the recording`);
      continue;
    }
    pairs.push({ id, audioPath: path, referencePath });
  }
  const used = new Set(pairs.map((p) => p.referencePath));
  for (const referencePath of references.values()) if (!used.has(referencePath)) problems.push(`${relative(dir, referencePath)}: no recording (${AUDIO_EXTENSIONS.join(', ')}) next to the reference`);
  if (problems.length > 0) throw new TranscriptEvalError(`the transcription set ${dir} is incomplete:\n${problems.join('\n')}`);
  if (pairs.length === 0) throw new TranscriptEvalError(`the transcription set ${dir} holds no recording (${AUDIO_EXTENSIONS.join(', ')})`);
  return pairs;
}

// What the runner needs of the media sandbox: the production call that normalizes and cuts a recording.
export type MediaProcessor = Pick<MediaClient, 'process'>;

export interface RunOptions {
  media: MediaProcessor;
  provider: TranscribeConfig;
  language: 'vi' | 'en';
  // The chunk length the sandbox cuts to; 10 minutes, as production.
  maxSegmentSeconds?: number;
  // The clock, for a test.
  now?: () => number;
}

export interface EvalRun {
  result: FileResult;
  scored: ScoredTranscript;
}

// One recording through the production path, then scored. The wall time is the transcription itself (the provider's calls, chunk by
// chunk), since that is what "an hour of meeting within the time measured" asks about; the sandbox's own time is not in it.
export async function evaluateRecording(pair: TranscriptPair, options: RunOptions): Promise<EvalRun> {
  const now = options.now ?? (() => performance.now());
  const reference = readFileSync(pair.referencePath, 'utf8');
  const processed = await options.media.process(new Uint8Array(readFileSync(pair.audioPath)), { maxSegmentSeconds: options.maxSegmentSeconds ?? 600 });
  const chunks: TranscribeInput[] = processed.segments.map((segment) => ({
    audio: new Uint8Array(Buffer.from(segment.dataBase64, 'base64')),
    mimeType: 'audio/ogg',
    language: options.language,
    lengthSeconds: segment.durationSeconds,
    offsetSeconds: segment.startSeconds,
  }));
  const started = now();
  const segments = await unmetered(() => transcribeChunks(options.provider, chunks));
  const wallSeconds = (now() - started) / 1000;
  const scored = scoreTranscript(reference, segments);
  return {
    scored,
    result: { id: pair.id, score: scored.score, audioSeconds: chunks.reduce((n, c) => n + c.lengthSeconds, 0), wallSeconds, chunks: chunks.length },
  };
}

// The provider the eval measures, from the variables the kernel reads. null without a base URL and a model.
export function transcribeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TranscribeConfig | null {
  const baseURL = env.TRANSCRIBE_BASE_URL?.trim();
  const model = env.TRANSCRIBE_MODEL?.trim();
  if (!baseURL || !model) return null;
  const mode = env.TRANSCRIBE_API_MODE?.trim() || 'audio_transcriptions';
  if (mode !== 'audio_transcriptions' && mode !== 'chat_input_audio') throw new TranscriptEvalError('TRANSCRIBE_API_MODE must be audio_transcriptions or chat_input_audio');
  return { baseURL, apiKey: env.TRANSCRIBE_API_KEY?.trim() || null, model, mode: mode satisfies TranscribeApiMode };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export interface RunningSandbox {
  client: MediaClient;
  stop: () => Promise<void>;
}

// The production crove-media service (apps/media/src/main.ts) as a child process on a free local port, with the environment it allows
// (no credentials), and needing ffmpeg on the PATH. With MEDIA_URL set, a running sandbox (the container) is used instead.
export async function startMediaSandbox(env: NodeJS.ProcessEnv = process.env): Promise<RunningSandbox> {
  const external = env.MEDIA_URL?.trim();
  if (external) return { client: createMediaClient(external), stop: async () => undefined };
  const port = await freePort();
  const entry = join(import.meta.dirname, '..', '..', '..', 'apps', 'media', 'src', 'main.ts');
  // Its own scratch directory: at start the sandbox deletes every crove-media-* entry of the temporary directory, which would remove
  // the working files of another crove-media (a test in the same run, or a service on this machine).
  const scratch = mkdtempSync(join(tmpdir(), 'crove-transcribe-eval-media-'));
  const child: ChildProcess = spawn(process.execPath, [entry], {
    env: { PATH: env.PATH ?? '', NODE_ENV: 'test', PORT: String(port), HOST: '127.0.0.1', TMPDIR: scratch },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-2000);
  });
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  // A child left behind when the process ends early (a test that timed out never reaches its finally).
  const killAtExit = () => {
    if (!exited()) child.kill('SIGKILL');
  };
  process.once('exit', killAtExit);
  const stop = async () => {
    process.off('exit', killAtExit);
    if (!exited()) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill('SIGTERM');
      });
    }
    rmSync(scratch, { recursive: true, force: true });
  };
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (exited()) {
      await stop();
      throw new TranscriptEvalError(`the media sandbox did not start: ${stderr.trim() || `exit ${child.exitCode ?? child.signalCode}`}`);
    }
    try {
      const response = await fetch(`${url}/healthz`);
      if (response.ok) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      await stop();
      throw new TranscriptEvalError('the media sandbox did not answer within 30 seconds');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { client: createMediaClient(url), stop };
}
