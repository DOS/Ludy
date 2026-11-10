// SPDX-License-Identifier: AGPL-3.0-only
// The transcription eval's runner (#2979): the set loader, then the production path end to end on the committed synthetic clips with
// a fake provider, so the numbers are known in advance. No real provider is called. The sandbox runs for real (a child process of
// apps/media, with ffmpeg) when ffmpeg is on the machine, and a stand-in cuts the chunks otherwise.
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatTranscriptionEvalReport, summarizeTranscriptionEval, TranscriptEvalError, type TranscribeConfig } from '../src/index.ts';
import { evaluateRecording, loadTranscriptSet, startMediaSandbox, SYNTHETIC_TRANSCRIPTS, transcribeConfigFromEnv, type MediaProcessor } from './transcripts.ts';

// The sandbox needs ffmpeg on the PATH: found by looking, so nothing is run to ask.
const hasFfmpeg = (process.env.PATH ?? '').split(delimiter).some((dir) => dir !== '' && existsSync(join(dir, 'ffmpeg')));

interface Said {
  speaker?: string;
  text: string;
}

// A provider answering the calls in order, each with the given utterances on the clip's own timeline, in the shape of the mode asked.
function fakeProvider(mode: 'audio_transcriptions' | 'chat_input_audio', answers: Said[][]) {
  const urls: string[] = [];
  const fetchFake = (async (url: string | URL | Request) => {
    urls.push(String(url));
    const said = answers[urls.length - 1] ?? [];
    const segments = said.map((s, i) => ({ start: i * 1, end: i * 1 + 1, ...(s.speaker ? { speaker: s.speaker } : {}), text: s.text }));
    const body = mode === 'chat_input_audio' ? { choices: [{ message: { content: JSON.stringify({ segments }) }, finish_reason: 'stop' }] } : { text: said.map((s) => s.text).join(' '), segments };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  const config: TranscribeConfig = { baseURL: 'https://stt.test/v1', apiKey: 'sk-test', model: 'fake', mode, fetch: fetchFake };
  return { config, urls };
}

// What the provider says for each synthetic clip: clip-a has one wrong and one extra syllable (of 41), clip-b has "tuần sau" missing (of 17).
const CLIP_A: Said[] = [
  { speaker: 'Người nói 1', text: 'Chào cả nhà, hôm nay chúng ta họp về kế hoạch bán hàng quý tư.' },
  { speaker: 'Người nói 2', text: 'Doanh thu tháng mười đã đạt chín mươi phần trăm mục tiêu.'.replace('mười', 'mười một') },
  { speaker: 'Người nói 1', text: 'Tốt lắm, tuần sau anh gửi báo cáo chi tiết cho cả nhóm nhé.'.replace('báo', 'bão') },
];
const CLIP_B: Said[] = [{ text: 'Cảm ơn mọi người đã tham dự buổi họp. Hẹn gặp lại vào thứ sáu.' }];

describe('loadTranscriptSet', () => {
  it('pairs each recording with its reference, in order', () => {
    expect(loadTranscriptSet(SYNTHETIC_TRANSCRIPTS).map((p) => p.id)).toEqual(['clip-a', 'clip-b']);
  });

  it('refuses a recording with no reference and a reference with no recording, and names the files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crove-transcribe-set-'));
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'ok.ogg'), 'x');
    writeFileSync(join(dir, 'ok.txt'), 'xin chào');
    writeFileSync(join(dir, 'sub', 'lonely.mp3'), 'x');
    writeFileSync(join(dir, 'orphan.txt'), 'xin chào');
    writeFileSync(join(dir, 'notes.md'), 'ignored');
    const error = (() => {
      try {
        loadTranscriptSet(dir);
      } catch (e) {
        return e as Error;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(TranscriptEvalError);
    expect(error!.message).toContain('sub/lonely.mp3');
    expect(error!.message).toContain('orphan.txt');
    expect(error!.message).not.toContain('ok.ogg');
    expect(error!.message).not.toContain('notes.md');
  });

  it('matches an upper-case .TXT reference and reads it from its own path, and does not follow a symbolic link out of the set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crove-transcribe-case-'));
    writeFileSync(join(dir, 'hop.ogg'), 'x');
    writeFileSync(join(dir, 'hop.TXT'), 'xin chào');
    symlinkSync(dir, join(dir, 'loop'));
    const pairs = loadTranscriptSet(dir);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.referencePath).toBe(join(dir, 'hop.TXT'));
  });

  it('refuses a directory with no recording at all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crove-transcribe-empty-'));
    expect(() => loadTranscriptSet(dir)).toThrow(/holds no recording/);
  });
});

describe('transcribeConfigFromEnv', () => {
  it('reads the variables the kernel reads, and none without a base URL and a model', () => {
    expect(transcribeConfigFromEnv({})).toBeNull();
    expect(transcribeConfigFromEnv({ TRANSCRIBE_BASE_URL: 'https://x/v1' })).toBeNull();
    expect(transcribeConfigFromEnv({ TRANSCRIBE_BASE_URL: 'https://x/v1', TRANSCRIBE_MODEL: 'm' })).toEqual({ baseURL: 'https://x/v1', apiKey: null, model: 'm', mode: 'audio_transcriptions' });
    expect(transcribeConfigFromEnv({ TRANSCRIBE_BASE_URL: 'https://x/v1', TRANSCRIBE_MODEL: 'm', TRANSCRIBE_API_KEY: 'k', TRANSCRIBE_API_MODE: 'chat_input_audio' })).toMatchObject({ apiKey: 'k', mode: 'chat_input_audio' });
    expect(() => transcribeConfigFromEnv({ TRANSCRIBE_BASE_URL: 'https://x/v1', TRANSCRIBE_MODEL: 'm', TRANSCRIBE_API_MODE: 'chat' })).toThrow(/TRANSCRIBE_API_MODE/);
  });
});

describe('the runner with a stand-in sandbox that cuts three chunks', () => {
  it('puts each chunk on the meeting timeline, sums the audio, times the provider calls and scores the merged transcript', async () => {
    const pair = loadTranscriptSet(SYNTHETIC_TRANSCRIPTS)[1]!;
    const media: MediaProcessor = {
      process: async () => ({
        probe: {} as never,
        normalizedAudioBase64: '',
        durationSeconds: 1500,
        segments: [0, 600, 1200].map((start, index) => ({ index, startSeconds: start, endSeconds: start + (index === 2 ? 300 : 600), durationSeconds: index === 2 ? 300 : 600, dataBase64: Buffer.from('opus').toString('base64') })),
      }),
    };
    // clip-b's 17 words, said in three chunks.
    const provider = fakeProvider('audio_transcriptions', [[{ text: 'Cảm ơn mọi người đã tham dự' }], [{ text: 'buổi họp. Hẹn gặp lại' }], [{ text: 'vào thứ sáu tuần sau.' }]]);
    let tick = 0;
    const run = await evaluateRecording(pair, { media, provider: provider.config, language: 'vi', now: () => (tick += 1500) });
    expect(provider.urls).toHaveLength(3);
    expect(run.result).toMatchObject({ id: 'clip-b', audioSeconds: 1500, chunks: 3, wallSeconds: 1.5 });
    expect(run.result.score).toMatchObject({ referenceTokens: 17, wer: 0, cer: 0 });
  });
});

describe.each(['audio_transcriptions', 'chat_input_audio'] as const)('the synthetic set through the production path (%s)', (mode) => {
  it.skipIf(!hasFfmpeg)(
    'gives the known WER, CER and speaker accuracy, and a report with no transcript text',
    async () => {
      const pairs = loadTranscriptSet(SYNTHETIC_TRANSCRIPTS);
      const provider = fakeProvider(mode, [CLIP_A, CLIP_B]);
      const sandbox = await startMediaSandbox();
      try {
        const runs = [];
        for (const pair of pairs) runs.push(await evaluateRecording(pair, { media: sandbox.client, provider: provider.config, language: 'vi' }));
        const [a, b] = runs.map((r) => r.result);
        // The sandbox cut each 3 second clip into one chunk of about 3 seconds.
        expect(a!.chunks).toBe(1);
        expect(a!.audioSeconds).toBeGreaterThan(2.5);
        expect(a!.audioSeconds).toBeLessThan(3.5);
        expect(a!.score).toMatchObject({ referenceTokens: 41, substitutions: 1, insertions: 1, deletions: 0 });
        expect(a!.score.wer).toBeCloseTo(2 / 41, 10);
        expect(a!.score.diarization).toMatchObject({ words: 41, matched: 41, accuracy: 1 });
        expect(b!.score).toMatchObject({ referenceTokens: 17, deletions: 2, substitutions: 0, insertions: 0 });
        expect(b!.score.wer).toBeCloseTo(2 / 17, 10);
        expect(b!.score.diarization).toBeNull();
        const summary = summarizeTranscriptionEval([a!, b!]);
        expect(summary.referenceTokens).toBe(58);
        expect(summary.wer).toBeCloseTo(4 / 58, 10);
        expect(summary.audioMinutesBilled).toBeCloseTo((a!.audioSeconds + b!.audioSeconds) / 60, 10);
        const report = formatTranscriptionEvalReport(summary, { showPairs: false, nameFiles: false });
        for (const word of ['Chào', 'chào', 'Doanh', 'doanh', 'Cảm', 'cảm', 'mười', 'báo', 'bão']) expect(report).not.toContain(word);
        expect(report).toContain('Overall WER');
        expect(provider.urls.every((u) => u.endsWith(mode === 'chat_input_audio' ? '/chat/completions' : '/audio/transcriptions'))).toBe(true);
      } finally {
        await sandbox.stop();
      }
    },
    120_000,
  );
});
