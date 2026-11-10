// SPDX-License-Identifier: AGPL-3.0-only
// The transcription eval's scorer (#2979): word and character error rates over Vietnamese syllables, with known numbers.
import { describe, expect, it } from 'vitest';
import {
  alignTokens,
  editDistance,
  formatLocalDiff,
  formatTranscriptionEvalReport,
  normalizeTranscript,
  parseReference,
  PROPOSED_MAX_WER,
  scoreTranscript,
  summarizeTranscriptionEval,
  TranscriptEvalError,
  type FileResult,
  type HypothesisSegment,
} from '../src/index.ts';

const segs = (...texts: string[]): HypothesisSegment[] => texts.map((text) => ({ speakerLabel: 'Người nói 1', text }));
const TEN = 'một hai ba bốn năm sáu bảy tám chín mười';

describe('normalizeTranscript', () => {
  it('lower-cases, drops punctuation and splits on whitespace, one Vietnamese syllable per token', () => {
    expect(normalizeTranscript('  Xin   CHÀO, cả nhà!  Hôm nay… họp (quý 4).\n')).toEqual(['xin', 'chào', 'cả', 'nhà', 'hôm', 'nay', 'họp', 'quý', '4']);
    expect(normalizeTranscript('')).toEqual([]);
    expect(normalizeTranscript('... ,, !!')).toEqual([]);
  });

  it('puts decomposed and composed Vietnamese letters on one form (NFC), and keeps a different diacritic a different token', () => {
    const decomposed = 'cấn'; // "cấn" as base letters plus combining marks
    expect(normalizeTranscript(decomposed)).toEqual(normalizeTranscript('cấn'));
    expect(normalizeTranscript('ma')).not.toEqual(normalizeTranscript('má'));
  });
});

describe('scoreTranscript', () => {
  it('gives 0 for identical text, whatever the case and punctuation', () => {
    const { score } = scoreTranscript('Xin chào, cả nhà!', segs('xin CHÀO cả nhà'));
    expect(score).toMatchObject({ wer: 0, cer: 0, substitutions: 0, deletions: 0, insertions: 0, correct: 4 });
  });

  it('gives 10 percent for one substituted syllable in ten', () => {
    const { score } = scoreTranscript(TEN, segs('một hai ba bốn năm sáu bảy tám chín mười'.replace('sáu', 'sau')));
    expect(score).toMatchObject({ referenceTokens: 10, substitutions: 1, deletions: 0, insertions: 0, wer: 0.1 });
    expect(score.topSubstitutions).toEqual([{ reference: 'sáu', hypothesis: 'sau', count: 1 }]);
  });

  it('counts a diacritic difference as an error', () => {
    expect(scoreTranscript('mẹ đi chợ', segs('me đi chợ')).score.wer).toBeCloseTo(1 / 3, 10);
  });

  it('counts deletions and insertions, and goes above 100 percent when the provider wrote much more than was said', () => {
    const del = scoreTranscript(TEN, segs('một hai ba bốn năm sáu bảy tám chín')).score;
    expect(del).toMatchObject({ deletions: 1, substitutions: 0, insertions: 0, wer: 0.1 });
    const ins = scoreTranscript('xin chào', segs('xin chào các bạn rất vui được gặp')).score;
    expect(ins).toMatchObject({ insertions: 6, wer: 3 });
    const nothing = scoreTranscript('xin chào', segs()).score;
    expect(nothing).toMatchObject({ deletions: 2, wer: 1, cer: 1 });
  });

  it('prefers one substitution to a deletion plus an insertion', () => {
    const ops = alignTokens(['a', 'b', 'c'], ['a', 'x', 'c']);
    expect(ops.map((o) => o.type)).toEqual(['ok', 'sub', 'ok']);
  });

  it('measures the character error rate on the normalized text', () => {
    // "chào" against "chao": one character of 4 in the word, 1 of 4 over the whole one-word text.
    const { score } = scoreTranscript('chào', segs('chao'));
    expect(score.cer).toBeCloseTo(1 / 4, 10);
    expect(editDistance(Array.from('kitten'), Array.from('sitting'))).toBe(3);
    expect(editDistance([], Array.from('abc'))).toBe(3);
  });

  it('refuses an empty reference, and one with only punctuation', () => {
    expect(() => scoreTranscript('', segs('xin chào'))).toThrow(TranscriptEvalError);
    expect(() => scoreTranscript('  ... !! ', segs('xin chào'))).toThrow(/no words/);
  });

  it('lists the substitutions that repeat most, most frequent first', () => {
    const { score } = scoreTranscript('a b a b a c', segs('x y x y x z'));
    expect(score.topSubstitutions[0]).toEqual({ reference: 'a', hypothesis: 'x', count: 3 });
    expect(score.topSubstitutions.slice(1).map((p) => p.count)).toEqual([2, 1]);
  });

  it('refuses a pair of texts too long to align, instead of using all the memory', () => {
    const long = Array.from({ length: 21_000 }, (_, i) => `t${i % 7}`);
    expect(() => alignTokens(long, long)).toThrow(/too long/);
  });
});

describe('diarization', () => {
  const reference = '[Lan] xin chào cả nhà [Minh] chào chị Lan [Lan] hôm nay họp';

  it('is not scored when the reference names no speaker', () => {
    expect(scoreTranscript('xin chào cả nhà', segs('xin chào cả nhà')).score.diarization).toBeNull();
  });

  it('maps the provider labels onto the reference speakers and scores the words each got right', () => {
    const perfect = scoreTranscript(reference, [
      { speakerLabel: 'Người nói 1', text: 'xin chào cả nhà' },
      { speakerLabel: 'Người nói 2', text: 'chào chị Lan' },
      { speakerLabel: 'Người nói 1', text: 'hôm nay họp' },
    ]).score;
    expect(perfect.diarization).toEqual({ words: 10, matched: 10, accuracy: 1 });
    const wrong = scoreTranscript(reference, [
      { speakerLabel: 'Người nói 1', text: 'xin chào cả nhà' },
      { speakerLabel: 'Người nói 1', text: 'chào chị Lan' },
      { speakerLabel: 'Người nói 1', text: 'hôm nay họp' },
    ]).score;
    // One provider label for everyone: it can map to one speaker only (Lan has 7 of the 10 words).
    expect(wrong.diarization).toEqual({ words: 10, matched: 7, accuracy: 0.7 });
  });

  it('keeps a [marker] out of the words', () => {
    const parsed = parseReference(reference);
    expect(parsed.tokens).toEqual(['xin', 'chào', 'cả', 'nhà', 'chào', 'chị', 'lan', 'hôm', 'nay', 'họp']);
    expect(parsed.speakers.slice(0, 5)).toEqual(['Lan', 'Lan', 'Lan', 'Lan', 'Minh']);
  });
});

describe('the report', () => {
  const file = (id: string, ref: string, hyp: string, audioSeconds: number, wallSeconds: number): FileResult => ({
    id,
    score: scoreTranscript(ref, segs(hyp)).score,
    audioSeconds,
    wallSeconds,
    chunks: 1,
  });

  it('sums the files, prices the audio minutes and reads the time per audio hour', () => {
    const summary = summarizeTranscriptionEval([file('a', TEN, TEN.replace('sáu', 'sau'), 600, 20), file('b', TEN, TEN, 1800, 40)]);
    expect(summary.referenceTokens).toBe(20);
    expect(summary.errors).toBe(1);
    expect(summary.wer).toBe(0.05);
    expect(summary.audioMinutesBilled).toBe(40);
    // 60 s of wall time for 2400 s of audio is 90 s per hour.
    expect(summary.wallSecondsPerAudioHour).toBeCloseTo(90, 10);
    expect(summary.topSubstitutions).toEqual([{ reference: 'sáu', hypothesis: 'sau', count: 1 }]);
  });

  it('prints numbers and never a line of the transcript, and the token pairs only when asked', () => {
    const secret = 'khách hàng Nguyễn Văn Bí mật nói số điện thoại không dấu';
    const summary = summarizeTranscriptionEval([file('hop-khach-hang-bi-mat', secret, secret.replace('điện', 'điên'), 120, 5)]);
    const quiet = formatTranscriptionEvalReport(summary, { showPairs: false, nameFiles: false });
    expect(quiet).toContain('file 1');
    expect(quiet).not.toContain('hop-khach-hang');
    for (const word of ['khách', 'Nguyễn', 'điện', 'điên', 'thoại']) expect(quiet).not.toContain(word);
    expect(quiet).toContain('Overall WER');
    expect(quiet).toContain(`WER at most ${(PROPOSED_MAX_WER * 100).toFixed(1)}%`);
    const shown = formatTranscriptionEvalReport(summary, { showPairs: true, nameFiles: true });
    expect(shown).toContain('hop-khach-hang-bi-mat');
    expect(shown).toContain('điện → điên (1)');
    expect(shown).not.toContain('Nguyễn');
  });

  it('writes the full diff for a local file only, with the words', () => {
    const scored = scoreTranscript('một hai ba', segs('một hay ba bốn'));
    const diff = formatLocalDiff(scored);
    expect(diff).toContain('sub\t#1\thai\t->\thay');
    expect(diff).toContain('ins\t#-\t(none)\t->\tbốn');
  });
});
