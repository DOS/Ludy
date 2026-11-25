// SPDX-License-Identifier: AGPL-3.0-only
// ffmpeg and ffprobe execution wrapper for crove-media.
// Runs isolated media operations in temporary directories with strict timeouts,
// signal-based aborts, protocol restrictions, safe container allowlists, and clean error mapping.
import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MEDIA_JOIN_FRAME,
  MEDIA_LIMITS,
  MEDIA_TIMING,
  type MediaErrorCode,
  type MediaNormalizeResult,
  type MediaProbeResult,
  type MediaProcessResult,
  type MediaSegment,
  type MediaSplitResult,
} from './types.ts';

export class MediaExecutionError extends Error {
  readonly code: MediaErrorCode;
  constructor(code: MediaErrorCode, message: string) {
    super(message);
    this.name = 'MediaExecutionError';
    this.code = code;
  }
}

export interface FfmpegRunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface NormalizeOptions extends FfmpegRunOptions {
  bitrateKbps?: number;
}

export interface SplitOptions extends NormalizeOptions {
  maxSegmentSeconds?: number;
}

export interface RepackageVideoOptions extends FfmpegRunOptions {
  dropAudio?: boolean;
}

export interface ProcessMediaOptions extends FfmpegRunOptions {
  maxSegmentSeconds?: number;
  bitrateKbps?: number;
}

interface RawProbeStream {
  index: number;
  codec_name?: string;
  codec_type?: 'audio' | 'video' | string;
  channels?: number;
  sample_rate?: string | number;
  width?: number;
  height?: number;
  duration?: string;
}

interface RawProbeFormat {
  format_name?: string;
  duration?: string;
}

interface RawProbeOutput {
  format?: RawProbeFormat;
  streams?: RawProbeStream[];
}

export function createTempDir(): string {
  const baseDir = process.env.TMPDIR || tmpdir();
  return mkdtempSync(join(baseDir, 'ludy-media-'));
}

function sortSegmentFiles(files: string[]): string[] {
  return files
    .filter((name) => name.startsWith('seg_') && name.endsWith('.opus'))
    .sort((a, b) => {
      const numA = parseInt(a.match(/seg_(\d+)/)?.[1] ?? '0', 10);
      const numB = parseInt(b.match(/seg_(\d+)/)?.[1] ?? '0', 10);
      return numA - numB;
    });
}

const SAFE_CONTAINER_FORMATS: ReadonlySet<string> = new Set([
  'ogg',
  'opus',
  'matroska,webm',
  'webm',
  'mov,mp4,m4a,3gp,3g2,mj2',
  'mp4',
  'm4a',
  'wav',
  'mp3',
  'aac',
  'flac',
]);

const DANGEROUS_DEMUXERS = /concat|hls|applehttp|dash|sdp|rtsp|rtp|image2|tty|lavfi/i;

function runCommand(
  bin: string,
  args: string[],
  options?: FfmpegRunOptions,
): Promise<{ stdout: string; stderr: string }> {
  const timeout = options?.timeoutMs ?? MEDIA_TIMING.processTimeoutMs;
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let aborted = false;
    let killing = false;
    let killTimer: NodeJS.Timeout | null = null;
    let processExited = false;
    let pendingSettle: (() => void) | null = null;

    const fullArgs = [
      ...(bin.includes('ffmpeg') ? ['-nostdin'] : []),
      '-protocol_whitelist',
      'file',
      ...args,
    ];

    const cp = execFile(
      bin,
      fullArgs,
      {
        maxBuffer: 64 * 1024 * 1024,
        env: {
          PATH: process.env.PATH,
          TMPDIR: process.env.TMPDIR || tmpdir(),
        },
      },
      (error, stdout, stderr) => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        if (options?.signal) options.signal.removeEventListener('abort', onAbort);

        const settle = () => {
          if (error) {
            if (timedOut) {
              reject(new MediaExecutionError('timeout', `Media processing timed out after ${timeout}ms`));
            } else if (aborted) {
              reject(new MediaExecutionError('timeout', 'Media processing was aborted'));
            } else {
              // Never leak raw stderr or paths outside
              reject(new MediaExecutionError('malformed_media', 'Invalid media data or unsupported format'));
            }
          } else {
            resolve({ stdout, stderr });
          }
        };

        if (processExited) {
          settle();
        } else {
          pendingSettle = settle;
        }
      },
    );

    const onExit = () => {
      processExited = true;
      if (pendingSettle) {
        pendingSettle();
      }
    };
    cp.once('close', onExit);
    cp.once('error', onExit);

    const escalateKill = () => {
      if (killing) return;
      killing = true;
      try {
        cp.kill('SIGTERM');
      } catch {}
      killTimer = setTimeout(() => {
        try {
          cp.kill('SIGKILL');
        } catch {}
      }, 2000);
      killTimer.unref();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      escalateKill();
    }, timeout);

    const onAbort = () => {
      aborted = true;
      escalateKill();
    };

    if (options?.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    }
  });
}


export async function probeFile(
  filePath: string,
  options?: FfmpegRunOptions,
): Promise<MediaProbeResult> {
  const args = [
    '-v',
    'error',
    '-show_entries',
    'format=duration,format_name:stream=index,codec_name,codec_type,channels,sample_rate,width,height,duration',
    '-of',
    'json',
    filePath,
  ];

  const { stdout } = await runCommand('ffprobe', args, options);
  let parsed: RawProbeOutput;
  try {
    parsed = JSON.parse(stdout) as RawProbeOutput;
  } catch {
    throw new MediaExecutionError('malformed_media', 'Media metadata could not be parsed');
  }

  const format = parsed.format;
  const formatName = format?.format_name ?? '';
  if (!formatName || DANGEROUS_DEMUXERS.test(formatName) || !SAFE_CONTAINER_FORMATS.has(formatName)) {
    throw new MediaExecutionError('malformed_media', 'Unsupported or unsafe media format');
  }

  const streams = parsed.streams ?? [];
  const MAX_STREAMS = 32;
  if (streams.length > MAX_STREAMS) {
    throw new MediaExecutionError('too_large', `Media stream count (${streams.length}) exceeds maximum allowed of ${MAX_STREAMS}`);
  }

  const audioStream = streams.find((s) => s.codec_type === 'audio');
  const videoStream = streams.find((s) => s.codec_type === 'video');

  const durationStr = format?.duration ?? audioStream?.duration ?? videoStream?.duration ?? '0';
  const durationSeconds = Math.max(0, Number.parseFloat(durationStr) || 0);

  // 60-second grace tolerance accounts for container/codec frame packetization and Opus padding on a 2-hour recording
  const MAX_DURATION_TOLERANCE_SECONDS = 60;
  if (durationSeconds > MEDIA_LIMITS.maxDurationSeconds + MAX_DURATION_TOLERANCE_SECONDS) {
    throw new MediaExecutionError(
      'too_large',
      `Media duration (${Math.round(durationSeconds)}s) exceeds maximum allowed duration (${MEDIA_LIMITS.maxDurationSeconds}s)`,
    );
  }

  return {
    durationSeconds,
    format: formatName,
    hasAudio: !!audioStream,
    hasVideo: !!videoStream,
    audioCodec: audioStream?.codec_name ?? null,
    audioChannels: audioStream?.channels ? Number(audioStream.channels) : null,
    audioSampleRate: audioStream?.sample_rate ? Number(audioStream.sample_rate) : null,
    videoCodec: videoStream?.codec_name ?? null,
    videoWidth: videoStream?.width ? Number(videoStream.width) : null,
    videoHeight: videoStream?.height ? Number(videoStream.height) : null,
  };
}

// What the file really holds (#2985). The length a container declares is the sender's word: a header can say a second over two hours of
// audio, and a browser's streamed WebM declares none. So the stream is read to its end into a null sink and the time it reaches is
// the length: audio is decoded (the first audio track), a video without audio is read packet by packet. Decoding is capped just
// past the limit, so a hostile file costs a bounded time and is then refused as too long. Everything else the probe checks
// (container allowlist, stream count) is checked first.
export async function measureFile(filePath: string, options?: FfmpegRunOptions): Promise<MediaProbeResult> {
  const probe = await probeFile(filePath, options);
  if (!probe.hasAudio && !probe.hasVideo) throw new MediaExecutionError('malformed_media', 'The media holds no audio or video');
  const tolerance = 60;
  const cap = MEDIA_LIMITS.maxDurationSeconds + tolerance + 1;
  // Audio is re-timed by sample count (asetpts=N/SR/TB) before the null sink: timestamps are the sender's word too, and a stream whose
  // timestamps wrap or restart (a WebM joined to itself, a muxer that resets them) reaches a short output time while every sample is still
  // decoded, and still heard by a provider. Counting samples cannot be moved by a timestamp.
  const map = probe.hasAudio ? ['-map', '0:a:0', '-vn', '-af', 'asetpts=N/SR/TB'] : ['-map', '0:v:0', '-c', 'copy'];
  const { stdout } = await runCommand(
    'ffmpeg',
    ['-v', 'error', '-nostats', '-i', filePath, ...map, '-t', String(cap), '-progress', 'pipe:1', '-f', 'null', '-'],
    options,
  );
  // The progress report ends with out_time_us (microseconds of output); the last one is the stream's end.
  let reached = -1;
  for (const match of stdout.matchAll(/^out_time_us=(-?\d+)$/gm)) reached = Number(match[1]);
  if (!Number.isFinite(reached) || reached <= 0) throw new MediaExecutionError('malformed_media', 'The media holds no readable stream');
  const durationSeconds = reached / 1_000_000;
  if (durationSeconds > MEDIA_LIMITS.maxDurationSeconds + tolerance) {
    throw new MediaExecutionError('too_large', `Media duration exceeds maximum allowed duration (${MEDIA_LIMITS.maxDurationSeconds}s)`);
  }
  return { ...probe, durationSeconds };
}

export async function normalizeAudioFile(
  inputPath: string,
  outputPath: string,
  options?: NormalizeOptions,
): Promise<MediaNormalizeResult> {
  const probe = await probeFile(inputPath, options);
  if (!probe.hasAudio) {
    throw new MediaExecutionError('no_audio_stream', 'Input media contains no audio stream to normalize');
  }

  const bitrateKbps = options?.bitrateKbps ?? MEDIA_LIMITS.defaultOpusBitrateKbps;
  const args = [
    '-y',
    '-v',
    'error',
    '-i',
    inputPath,
    '-vn',
    '-c:a',
    'libopus',
    '-b:a',
    `${bitrateKbps}k`,
    '-ac',
    '1',
    '-ar',
    String(MEDIA_LIMITS.defaultOpusSampleRate),
    outputPath,
  ];

  await runCommand('ffmpeg', args, options);
  const audioBytes = readFileSync(outputPath);
  const outProbe = await probeFile(outputPath, options);

  return {
    durationSeconds: outProbe.durationSeconds > 0 ? outProbe.durationSeconds : probe.durationSeconds,
    format: 'opus',
    channels: 1,
    sampleRate: 48000,
    bitrateKbps,
    audioBase64: Buffer.from(audioBytes).toString('base64'),
  };
}


export async function splitAudioFile(
  inputPath: string,
  dir: string,
  options?: SplitOptions,
): Promise<MediaSplitResult> {
  const probe = await probeFile(inputPath, options);
  if (!probe.hasAudio) {
    throw new MediaExecutionError('no_audio_stream', 'Input media contains no audio stream to split');
  }

  const maxSegmentSeconds = options?.maxSegmentSeconds ?? MEDIA_LIMITS.defaultSegmentSeconds;
  const bitrateKbps = options?.bitrateKbps ?? MEDIA_LIMITS.defaultOpusBitrateKbps;
  const segmentPattern = join(dir, 'seg_%04d.opus');

  const args = [
    '-y',
    '-v',
    'error',
    '-i',
    inputPath,
    '-vn',
    '-c:a',
    'libopus',
    '-b:a',
    `${bitrateKbps}k`,
    '-ac',
    '1',
    '-ar',
    String(MEDIA_LIMITS.defaultOpusSampleRate),
    '-f',
    'segment',
    '-segment_time',
    String(maxSegmentSeconds),
    '-reset_timestamps',
    '1',
    segmentPattern,
  ];

  await runCommand('ffmpeg', args, options);

  const segmentFiles = sortSegmentFiles(readdirSync(dir));
  if (segmentFiles.length > MEDIA_LIMITS.maxSegments) {
    throw new MediaExecutionError('too_large', `Segment count (${segmentFiles.length}) exceeds maximum of ${MEDIA_LIMITS.maxSegments}`);
  }

  const segments: MediaSegment[] = [];
  let currentStart = 0;
  for (let i = 0; i < segmentFiles.length; i++) {
    const fileName = segmentFiles[i];
    if (!fileName) continue;
    const segFile = join(dir, fileName);
    const segBytes = readFileSync(segFile);
    const segProbe = await probeFile(segFile, options);
    const segDuration = segProbe.durationSeconds;
    const endSeconds = currentStart + segDuration;

    segments.push({
      index: i,
      startSeconds: currentStart,
      endSeconds,
      durationSeconds: segDuration,
      dataBase64: Buffer.from(segBytes).toString('base64'),
    });
    currentStart = endSeconds;
    try {
      rmSync(segFile, { force: true });
    } catch {}
  }

  return {
    durationSeconds: currentStart > 0 ? currentStart : probe.durationSeconds,
    segmentCount: segments.length,
    maxSegmentSeconds,
    segments,
  };
}


export async function repackageVideoFile(
  inputPath: string,
  outputPath: string,
  options?: RepackageVideoOptions,
): Promise<{ durationSeconds: number; format: string; hasAudio: boolean }> {
  const probe = await probeFile(inputPath, options);
  if (!probe.hasVideo) {
    throw new MediaExecutionError('no_video_stream', 'Input media contains no video stream to repackage');
  }

  const dropAudio = options?.dropAudio ?? true;
  const isWebm = (probe.videoCodec ?? '').includes('vp8') || (probe.videoCodec ?? '').includes('vp9');

  const args = ['-y', '-v', 'error', '-i', inputPath, '-c:v', 'copy'];
  if (dropAudio) {
    args.push('-an');
  } else {
    args.push('-c:a', 'copy');
  }
  if (isWebm) {
    args.push('-f', 'webm');
  } else {
    args.push('-f', 'mp4', '-movflags', '+faststart');
  }
  args.push(outputPath);

  await runCommand('ffmpeg', args, options);
  const outProbe = await probeFile(outputPath, options);

  return {
    durationSeconds: outProbe.durationSeconds > 0 ? outProbe.durationSeconds : probe.durationSeconds,
    format: isWebm ? 'webm' : 'mp4',
    hasAudio: !dropAudio,
  };
}


export async function processMediaFile(
  inputPath: string,
  dir: string,
  options?: ProcessMediaOptions,
): Promise<MediaProcessResult> {
  const probe = await probeFile(inputPath, options);
  if (!probe.hasAudio) {
    throw new MediaExecutionError('no_audio_stream', 'Input media contains no audio stream');
  }

  const normalizedAudioPath = join(dir, 'normalized.opus');
  const segmentPattern = join(dir, 'seg_%04d.opus');
  const maxSegmentSeconds = options?.maxSegmentSeconds ?? MEDIA_LIMITS.defaultSegmentSeconds;
  const bitrateKbps = options?.bitrateKbps ?? MEDIA_LIMITS.defaultOpusBitrateKbps;

  // 1. Normalize audio to mono Opus
  const normArgs = [
    '-y',
    '-v',
    'error',
    '-i',
    inputPath,
    '-vn',
    '-c:a',
    'libopus',
    '-b:a',
    `${bitrateKbps}k`,
    '-ac',
    '1',
    '-ar',
    String(MEDIA_LIMITS.defaultOpusSampleRate),
    normalizedAudioPath,
  ];
  await runCommand('ffmpeg', normArgs, options);

  // Immediately unlink input file to release disk space!
  try {
    rmSync(inputPath, { force: true });
  } catch {}

  const normalizedAudioBytes = readFileSync(normalizedAudioPath);
  const normProbe = await probeFile(normalizedAudioPath, options);

  // 2. Split normalized audio into segments (stream copy, fast)
  const splitArgs = [
    '-y',
    '-v',
    'error',
    '-i',
    normalizedAudioPath,
    '-c:a',
    'copy',
    '-f',
    'segment',
    '-segment_time',
    String(maxSegmentSeconds),
    '-reset_timestamps',
    '1',
    segmentPattern,
  ];
  await runCommand('ffmpeg', splitArgs, options);

  // Immediately unlink normalized intermediate file!
  try {
    rmSync(normalizedAudioPath, { force: true });
  } catch {}

  const segmentFiles = sortSegmentFiles(readdirSync(dir));
  if (segmentFiles.length > MEDIA_LIMITS.maxSegments) {
    throw new MediaExecutionError('too_large', `Segment count (${segmentFiles.length}) exceeds maximum of ${MEDIA_LIMITS.maxSegments}`);
  }

  const segments: MediaSegment[] = [];
  let currentStart = 0;
  for (let i = 0; i < segmentFiles.length; i++) {
    const fileName = segmentFiles[i];
    if (!fileName) continue;
    const segFile = join(dir, fileName);
    const segBytes = readFileSync(segFile);
    const segProbe = await probeFile(segFile, options);
    const segDuration = segProbe.durationSeconds;
    const endSeconds = currentStart + segDuration;

    segments.push({
      index: i,
      startSeconds: currentStart,
      endSeconds,
      durationSeconds: segDuration,
      dataBase64: Buffer.from(segBytes).toString('base64'),
    });
    currentStart = endSeconds;

    // Immediately unlink this segment file!
    try {
      rmSync(segFile, { force: true });
    } catch {}
  }

  return {
    probe,
    normalizedAudioBase64: Buffer.from(normalizedAudioBytes).toString('base64'),
    durationSeconds: normProbe.durationSeconds > 0 ? normProbe.durationSeconds : probe.durationSeconds,
    segments,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Joining the parts of one recording (#3175): a call recorded in several segments arrives as ONE framed body (packages/media-contract/src/join.ts), is cut into one file per part here, and is joined with
// ffmpeg's `concat` FILTER (not the concat demuxer, which reads file lists and is refused as dangerous above) into one mono Opus, so the answer has the shape and the caps of normalize.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------

const JOIN_COUNT_BYTES = MEDIA_JOIN_FRAME.countBytes;
const JOIN_LENGTH_BYTES = MEDIA_JOIN_FRAME.lengthBytes;

/**
 * Cuts a framed body (count, then length and bytes of each part) into `part-<i>.bin` files in `dir`, and returns their paths in order. The frame lengths are checked against the size of the
 * file as they are read, so a length that runs past the end, a count outside 1 to the maximum, a part of no bytes and any byte after the last part are all `bad_request`: nothing is guessed.
 * The parts are copied out from the LAST to the first and the body is cut back after each copy, so the disk holds the body and one part at most, never the body twice.
 */
export async function splitJoinFrames(framedPath: string, dir: string, signal?: AbortSignal): Promise<string[]> {
  const total = statSync(framedPath).size;
  const handle = await open(framedPath, 'r+');
  const bad = (what: string) => new MediaExecutionError('bad_request', `The parts of the join are not framed correctly (${what})`);
  try {
    const read = async (at: number, bytes: number): Promise<Buffer> => {
      if (at + bytes > total) throw bad('the body ends inside a frame');
      const out = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(out, 0, bytes, at);
      if (bytesRead !== bytes) throw bad('the body ends inside a frame');
      return out;
    };
    const count = (await read(0, JOIN_COUNT_BYTES)).readUInt32BE(0);
    if (count < 1 || count > MEDIA_LIMITS.maxJoinParts) throw bad(`${count} parts`);
    // First every frame is read and checked (offsets only, nothing copied): the whole body must be framed exactly before a byte is written.
    const frames: Array<{ start: number; length: number }> = [];
    let at = JOIN_COUNT_BYTES;
    for (let i = 0; i < count; i++) {
      const length = Number((await read(at, JOIN_LENGTH_BYTES)).readBigUInt64BE(0));
      at += JOIN_LENGTH_BYTES;
      if (!Number.isSafeInteger(length) || length < 1 || at + length > total) throw bad(`part ${i + 1}`);
      frames.push({ start: at, length });
      at += length;
    }
    if (at !== total) throw bad('bytes after the last part');
    const paths = frames.map((_, i) => join(dir, `part-${i}.bin`));
    try {
      for (let i = frames.length - 1; i >= 0; i--) {
        if (signal?.aborted) throw new MediaExecutionError('timeout', 'Request was aborted');
        const frame = frames[i] as { start: number; length: number };
        await pipeline(createReadStream(framedPath, { start: frame.start, end: frame.start + frame.length - 1 }), createWriteStream(paths[i] as string, { mode: 0o600 }));
        // The tail that was just copied is not needed any more; the frame headers before it are untouched.
        await handle.truncate(frame.start - JOIN_LENGTH_BYTES);
      }
    } catch (error) {
      // The scratch of a sandbox is capped: a body that does not fit twice is too large for a join, not an internal error.
      if ((error as { code?: string } | null)?.code === 'ENOSPC') throw new MediaExecutionError('too_large', 'The parts of the recording are too large to join here');
      throw error;
    }
    return paths;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function joinAudioFiles(framedPath: string, dir: string, outputPath: string, options?: NormalizeOptions): Promise<MediaNormalizeResult> {
  const parts = await splitJoinFrames(framedPath, dir, options?.signal);
  // The framed body was cut back to its first frame header as the parts were copied out; nothing of it is needed now.
  rmSync(framedPath, { force: true });
  // Each part must hold audio and be a container the sandbox allows (probeFile), and the length of the whole is what the parts really hold (measureFile decodes), against the same duration cap as one recording.
  let seconds = 0;
  for (const part of parts) {
    const measured = await measureFile(part, options);
    if (!measured.hasAudio) throw new MediaExecutionError('no_audio_stream', 'A part of the recording contains no audio stream to join');
    seconds += measured.durationSeconds;
    if (seconds > MEDIA_LIMITS.maxDurationSeconds + 60) {
      throw new MediaExecutionError('too_large', `The parts add up to more than the maximum allowed duration (${MEDIA_LIMITS.maxDurationSeconds}s)`);
    }
  }
  const bitrateKbps = options?.bitrateKbps ?? MEDIA_LIMITS.defaultOpusBitrateKbps;
  // Every part to the same rate and one channel first (the concat filter wants the same format on all inputs), then joined in order. Only our own temp file names reach ffmpeg.
  const labels = parts.map((_, i) => `[a${i}]`);
  const graph = [
    ...parts.map((_, i) => `[${i}:a:0]aresample=${MEDIA_LIMITS.defaultOpusSampleRate},aformat=sample_fmts=fltp:channel_layouts=mono,asetpts=N/SR/TB[a${i}]`),
    `${labels.join('')}concat=n=${parts.length}:v=0:a=1[out]`,
  ].join(';');
  // The timestamps of every part start at its own first sample (asetpts), so a gap or jump inside a part cannot stretch the output, and the output is cut at the duration cap as a second guard.
  const args = ['-y', '-v', 'error', ...parts.flatMap((part) => ['-i', part]), '-filter_complex', graph, '-map', '[out]', '-t', String(MEDIA_LIMITS.maxDurationSeconds + 60), '-c:a', 'libopus', '-b:a', `${bitrateKbps}k`, '-ac', '1', '-ar', String(MEDIA_LIMITS.defaultOpusSampleRate), outputPath];
  await runCommand('ffmpeg', args, options);
  const outProbe = await probeFile(outputPath, options);
  return {
    // What the parts really hold (measureFile decoded them), unless the output measures shorter; never the container's word for a longer one.
    durationSeconds: outProbe.durationSeconds > 0 ? Math.min(outProbe.durationSeconds, seconds + 1) : seconds,
    format: 'opus',
    channels: 1,
    sampleRate: 48000,
    bitrateKbps,
    audioBase64: readFileSync(outputPath).toString('base64'),
  };
}
