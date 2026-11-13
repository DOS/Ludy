// SPDX-License-Identifier: AGPL-3.0-only
// ffmpeg and ffprobe execution wrapper for crove-media.
// Runs isolated media operations in temporary directories with strict timeouts,
// signal-based aborts, protocol restrictions, safe container allowlists, and clean error mapping.
import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
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
  return mkdtempSync(join(baseDir, 'crove-media-'));
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

