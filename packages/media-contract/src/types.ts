// SPDX-License-Identifier: AGPL-3.0-only
// Contract and schemas for crove-media (AI Meeting Notes M3, #2577).
// Media processing sandbox: probe length, normalize to mono Opus, split into 10-minute segments,
// extract audio from video, and repackage video without re-encoding.
import { z } from 'zod';

export const MEDIA_LIMITS = {
  // Plan §10: 2 hours per meeting, audio upload up to 300 MB, video upload up to 2 GB.
  maxDurationSeconds: 7200,
  maxAudioBytes: 300 * 1024 * 1024,
  maxVideoBytes: 2 * 1024 * 1024 * 1024,
  defaultSegmentSeconds: 600, // 10 minutes
  minSegmentSeconds: 5,
  maxSegments: 64,
  defaultOpusBitrateKbps: 24, // ~24 kbit/s mono Opus (~11 MB/hr)
  minOpusBitrateKbps: 6,
  maxOpusBitrateKbps: 64,
  defaultOpusSampleRate: 48000, // standard Opus rate
} as const;

export const MEDIA_TIMING = {
  concurrency: 1,
  maxQueue: 4,
  processTimeoutMs: 300_000, // 5 minutes, easily handles 2-hour normalization
  bodyIdleTimeoutMs: 10_000,
  bodyTimeoutMs: 60_000,
} as const;

export const MEDIA_ERROR_CODES = [
  'malformed_media',
  'no_audio_stream',
  'no_video_stream',
  'timeout',
  'too_large',
  'bad_request',
  'busy',
  'internal_error',
] as const;

export type MediaErrorCode = (typeof MEDIA_ERROR_CODES)[number];

export const MEDIA_ERROR_STATUS: Record<MediaErrorCode, number> = {
  malformed_media: 422,
  no_audio_stream: 422,
  no_video_stream: 422,
  bad_request: 400,
  too_large: 413,
  timeout: 504,
  busy: 503,
  internal_error: 500,
};

export const zMediaProbeResult = z.strictObject({
  durationSeconds: z.number().nonnegative().max(7300),
  format: z.string().max(100),
  hasAudio: z.boolean(),
  hasVideo: z.boolean(),
  audioCodec: z.string().max(50).nullable(),
  audioChannels: z.number().int().positive().max(32).nullable(),
  audioSampleRate: z.number().int().positive().max(192000).nullable(),
  videoCodec: z.string().max(50).nullable(),
  videoWidth: z.number().int().positive().max(8192).nullable(),
  videoHeight: z.number().int().positive().max(8192).nullable(),
});

export type MediaProbeResult = z.infer<typeof zMediaProbeResult>;

export const zMediaNormalizeResult = z.strictObject({
  durationSeconds: z.number().nonnegative().max(7300),
  format: z.literal('opus'),
  channels: z.literal(1),
  sampleRate: z.literal(48000),
  bitrateKbps: z.number().positive().min(6).max(64),
  audioBase64: z.string(),
});

export type MediaNormalizeResult = z.infer<typeof zMediaNormalizeResult>;

export const zMediaSegment = z.strictObject({
  index: z.number().int().nonnegative().max(64),
  startSeconds: z.number().nonnegative().max(7300),
  endSeconds: z.number().nonnegative().max(7300),
  durationSeconds: z.number().nonnegative().max(7300),
  dataBase64: z.string(),
});

export type MediaSegment = z.infer<typeof zMediaSegment>;

export const zMediaSplitResult = z.strictObject({
  durationSeconds: z.number().nonnegative().max(7300),
  segmentCount: z.number().int().nonnegative().max(64),
  maxSegmentSeconds: z.number().int().positive().max(3600),
  segments: z.array(zMediaSegment).max(64),
});

export type MediaSplitResult = z.infer<typeof zMediaSplitResult>;

export const zMediaProcessResult = z.strictObject({
  probe: zMediaProbeResult,
  normalizedAudioBase64: z.string(),
  durationSeconds: z.number().nonnegative().max(7300),
  segments: z.array(zMediaSegment).max(64),
});

export type MediaProcessResult = z.infer<typeof zMediaProcessResult>;

export const zMediaErrorResponse = z.strictObject({
  ok: z.literal(false),
  code: z.enum(MEDIA_ERROR_CODES),
  error: z.string().max(500),
});

export type MediaErrorResponse = z.infer<typeof zMediaErrorResponse>;

export type MediaResponse<T> =
  | { ok: true; result: T }
  | MediaErrorResponse;
