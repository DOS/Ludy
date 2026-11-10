// SPDX-License-Identifier: AGPL-3.0-only
// The transcription eval's scorer (issue #2979, meetings plan M4): how far a provider's transcript is from the one a person
// checked. Pure functions, no I/O, no AI call. Vietnamese is written one syllable per word, so a "word" here is a
// whitespace-separated token of the normalized text.
//
// - normalizeTranscript: NFC, lower case, punctuation removed (a letter or digit of any script stays; a mark that is part
//   of a letter, the tone marks of Vietnamese, stays with it because the text is NFC first). A diacritic that differs is
//   a different token, so "ma" and "má" are an error.
// - alignTokens: Levenshtein alignment over tokens, into correct, substituted, deleted and inserted tokens.
// - scoreTranscript: word error rate (substitutions + deletions + insertions over the reference length), character error rate,
//   the substitutions that repeat most, and, when the reference names its speakers, how often the speaker is right on the
//   aligned words.
// - formatTranscriptionEvalReport: numbers, and the token pairs of the most frequent substitutions only when asked. It never
//   prints a transcript, a line of one or a speaker's name, so a report is safe in a CI log.
//
// Nothing here is a model call: the numbers are the deterministic check of what a model wrote (AGENTS.md: AI output is tainted,
// deterministic checks decide).

// The most cells of the alignment table: the longest meeting (two hours) is well under 20 000 syllables, 20 000 squared is
// 400 million cells of one byte.
const MAX_ALIGNMENT_CELLS = 400_000_000;

export class TranscriptEvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranscriptEvalError';
  }
}

// Punctuation, symbols and separators, in any script. Letters, digits and the combining marks of a letter are kept.
const NOT_WORD = /[^\p{L}\p{N}\p{M}]+/gu;

// The tokens of a text: NFC, lower case, every run of punctuation or space a boundary.
export function normalizeTranscript(text: string): string[] {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(NOT_WORD, ' ')
    .trim()
    .split(' ')
    .filter((token) => token !== '');
}

// A reference line may name its speaker: `[Lan] Xin chào cả nhà`. The label stays for the words that follow, until the
// next marker. A reference with no marker has no speakers (diarization is then not scored).
const SPEAKER_MARKER = /\[([^\]\n]{1,80})\]/gu;

export interface LabelledTokens {
  tokens: string[];
  // The speaker of each token, or null while no marker has been seen; empty when the text names no speaker at all.
  speakers: Array<string | null>;
  hasSpeakers: boolean;
}

export function parseReference(text: string): LabelledTokens {
  const tokens: string[] = [];
  const speakers: Array<string | null> = [];
  let hasSpeakers = false;
  let current: string | null = null;
  let last = 0;
  const take = (chunk: string) => {
    for (const token of normalizeTranscript(chunk)) {
      tokens.push(token);
      speakers.push(current);
    }
  };
  for (const match of text.matchAll(SPEAKER_MARKER)) {
    take(text.slice(last, match.index));
    current = match[1]!.normalize('NFC').trim();
    hasSpeakers = true;
    last = match.index + match[0].length;
  }
  take(text.slice(last));
  return { tokens, speakers, hasSpeakers };
}

export interface HypothesisSegment {
  speakerLabel: string;
  text: string;
}

// The transcript a provider gave, as tokens with the speaker label of the segment each came from.
export function hypothesisTokens(segments: readonly HypothesisSegment[]): LabelledTokens {
  const tokens: string[] = [];
  const speakers: Array<string | null> = [];
  for (const segment of segments) {
    for (const token of normalizeTranscript(segment.text)) {
      tokens.push(token);
      speakers.push(segment.speakerLabel);
    }
  }
  return { tokens, speakers, hasSpeakers: segments.length > 0 };
}

export type AlignmentOp = { type: 'ok' | 'sub'; ref: number; hyp: number } | { type: 'del'; ref: number } | { type: 'ins'; hyp: number };

const DIAG = 1;
const UP = 2;
const LEFT = 3;

// Levenshtein alignment over tokens (substitution, deletion and insertion each cost 1): the operations in order. Ties prefer
// the diagonal, so a pair of different tokens is one substitution rather than a deletion and an insertion.
export function alignTokens(reference: readonly string[], hypothesis: readonly string[]): AlignmentOp[] {
  const n = reference.length;
  const m = hypothesis.length;
  if ((n + 1) * (m + 1) > MAX_ALIGNMENT_CELLS) throw new TranscriptEvalError('the transcripts are too long to align');
  const width = m + 1;
  const back = new Uint8Array((n + 1) * width);
  let previous = new Uint32Array(width);
  let row = new Uint32Array(width);
  for (let j = 1; j <= m; j += 1) {
    previous[j] = j;
    back[j] = LEFT;
  }
  for (let i = 1; i <= n; i += 1) {
    row[0] = i;
    back[i * width] = UP;
    for (let j = 1; j <= m; j += 1) {
      const diag = previous[j - 1]! + (reference[i - 1] === hypothesis[j - 1] ? 0 : 1);
      const up = previous[j]! + 1;
      const left = row[j - 1]! + 1;
      if (diag <= up && diag <= left) {
        row[j] = diag;
        back[i * width + j] = DIAG;
      } else if (up <= left) {
        row[j] = up;
        back[i * width + j] = UP;
      } else {
        row[j] = left;
        back[i * width + j] = LEFT;
      }
    }
    [previous, row] = [row, previous];
  }
  const ops: AlignmentOp[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const step = back[i * width + j];
    if (i > 0 && j > 0 && step === DIAG) {
      ops.push({ type: reference[i - 1] === hypothesis[j - 1] ? 'ok' : 'sub', ref: i - 1, hyp: j - 1 });
      i -= 1;
      j -= 1;
    } else if (i > 0 && (j === 0 || step === UP)) {
      ops.push({ type: 'del', ref: i - 1 });
      i -= 1;
    } else {
      ops.push({ type: 'ins', hyp: j - 1 });
      j -= 1;
    }
  }
  return ops.reverse();
}

// The edit distance between two strings by code point, in two rows of memory (no operations, only the distance).
export function editDistance(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = new Uint32Array(b.length + 1);
  let row = new Uint32Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    row[0] = i;
    const ai = a[i - 1];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = ai === b[j - 1] ? 0 : 1;
      row[j] = Math.min(previous[j - 1]! + cost, previous[j]! + 1, row[j - 1]! + 1);
    }
    [previous, row] = [row, previous];
  }
  return previous[b.length]!;
}

export interface SubstitutionCount {
  reference: string;
  hypothesis: string;
  count: number;
}

export interface DiarizationScore {
  // Aligned words (correct or substituted) the reference gave a speaker to.
  words: number;
  // Of those, the words whose provider label is the one the best one-to-one mapping gives the reference speaker.
  matched: number;
  accuracy: number;
}

export interface TranscriptScore {
  referenceTokens: number;
  hypothesisTokens: number;
  correct: number;
  substitutions: number;
  deletions: number;
  insertions: number;
  // (substitutions + deletions + insertions) / referenceTokens: above 1 when the provider wrote much more than was said.
  wer: number;
  referenceChars: number;
  charErrors: number;
  cer: number;
  topSubstitutions: SubstitutionCount[];
  // Every distinct substitution, most frequent first (the summary adds them across files).
  substitutionPairs: SubstitutionCount[];
  // null when the reference names no speaker.
  diarization: DiarizationScore | null;
}

const TOP_SUBSTITUTIONS = 5;

// The best one-to-one mapping from the provider's labels to the reference's speakers, by how many aligned words each pair
// shares (greedy from the largest count): a provider names its speakers "Người nói 1", a person wrote "Lan".
function diarize(pairs: Array<{ refSpeaker: string; hypSpeaker: string }>): DiarizationScore {
  const counts = new Map<string, number>();
  for (const { refSpeaker, hypSpeaker } of pairs) {
    const key = `${refSpeaker}\u0000${hypSpeaker}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const usedRef = new Set<string>();
  const usedHyp = new Set<string>();
  let matched = 0;
  for (const [key, count] of [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))) {
    const [refSpeaker, hypSpeaker] = key.split('\u0000') as [string, string];
    if (usedRef.has(refSpeaker) || usedHyp.has(hypSpeaker)) continue;
    usedRef.add(refSpeaker);
    usedHyp.add(hypSpeaker);
    matched += count;
  }
  return { words: pairs.length, matched, accuracy: pairs.length === 0 ? 0 : matched / pairs.length };
}

export interface ScoredTranscript {
  score: TranscriptScore;
  // The alignment, for a local diff file; it holds the words, so it never goes into a report.
  ops: AlignmentOp[];
  reference: LabelledTokens;
  hypothesis: LabelledTokens;
}

// The reference text (a person's, optionally with [speaker] markers) against what a provider returned.
// An empty reference is refused: nothing to measure against.
export function scoreTranscript(referenceText: string, segments: readonly HypothesisSegment[]): ScoredTranscript {
  const reference = parseReference(referenceText);
  if (reference.tokens.length === 0) throw new TranscriptEvalError('the reference transcript has no words');
  const hypothesis = hypothesisTokens(segments);
  const ops = alignTokens(reference.tokens, hypothesis.tokens);
  let correct = 0;
  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;
  const pairCounts = new Map<string, SubstitutionCount>();
  const speakerPairs: Array<{ refSpeaker: string; hypSpeaker: string }> = [];
  for (const op of ops) {
    if (op.type === 'del') deletions += 1;
    else if (op.type === 'ins') insertions += 1;
    else {
      if (op.type === 'ok') correct += 1;
      else {
        substitutions += 1;
        const r = reference.tokens[op.ref]!;
        const h = hypothesis.tokens[op.hyp]!;
        const key = `${r}\u0000${h}`;
        const found = pairCounts.get(key);
        if (found) found.count += 1;
        else pairCounts.set(key, { reference: r, hypothesis: h, count: 1 });
      }
      const refSpeaker = reference.speakers[op.ref];
      const hypSpeaker = hypothesis.speakers[op.hyp];
      if (refSpeaker && hypSpeaker) speakerPairs.push({ refSpeaker, hypSpeaker });
    }
  }
  const refChars = Array.from(reference.tokens.join(' '));
  const hypChars = Array.from(hypothesis.tokens.join(' '));
  const charErrors = editDistance(refChars, hypChars);
  const substitutionPairs = [...pairCounts.values()].sort((a, b) => b.count - a.count || (a.reference + a.hypothesis < b.reference + b.hypothesis ? -1 : 1));
  const topSubstitutions = substitutionPairs.slice(0, TOP_SUBSTITUTIONS);
  return {
    score: {
      referenceTokens: reference.tokens.length,
      hypothesisTokens: hypothesis.tokens.length,
      correct,
      substitutions,
      deletions,
      insertions,
      wer: (substitutions + deletions + insertions) / reference.tokens.length,
      referenceChars: refChars.length,
      charErrors,
      cer: charErrors / refChars.length,
      topSubstitutions,
      substitutionPairs,
      diarization: reference.hasSpeakers ? diarize(speakerPairs) : null,
    },
    ops,
    reference,
    hypothesis,
  };
}

// The local diff of one file: every error with the words around it, and the speaker labels. It holds transcript text, so it is
// written to a private local file and never printed or uploaded.
export function formatLocalDiff(scored: ScoredTranscript): string {
  const { ops, reference, hypothesis } = scored;
  const lines: string[] = [];
  for (const op of ops) {
    if (op.type === 'ok') continue;
    const r = op.type === 'ins' ? '' : reference.tokens[op.ref]!;
    const h = op.type === 'del' ? '' : hypothesis.tokens[op.hyp]!;
    const at = op.type === 'ins' ? '-' : String(op.ref);
    lines.push(`${op.type}\t#${at}\t${r || '(none)'}\t->\t${h || '(none)'}`);
  }
  return `${lines.join('\n')}\n`;
}

// What one file of the set measured, with the wall time and the audio seconds the provider was sent for it.
export interface FileResult {
  id: string;
  score: TranscriptScore;
  audioSeconds: number;
  wallSeconds: number;
  chunks: number;
}

export interface TranscriptionEvalSummary {
  files: FileResult[];
  referenceTokens: number;
  errors: number;
  wer: number;
  referenceChars: number;
  charErrors: number;
  cer: number;
  audioSeconds: number;
  wallSeconds: number;
  // Wall seconds for an hour of audio: the number the plan's "a one-hour meeting within the time measured" reads.
  wallSecondsPerAudioHour: number;
  // Audio minutes sent to the provider (what a provider bills).
  audioMinutesBilled: number;
  topSubstitutions: SubstitutionCount[];
  diarization: DiarizationScore | null;
}

export function summarizeTranscriptionEval(files: readonly FileResult[]): TranscriptionEvalSummary {
  const sum = (pick: (f: FileResult) => number) => files.reduce((n, f) => n + pick(f), 0);
  const referenceTokens = sum((f) => f.score.referenceTokens);
  const errors = sum((f) => f.score.substitutions + f.score.deletions + f.score.insertions);
  const referenceChars = sum((f) => f.score.referenceChars);
  const charErrors = sum((f) => f.score.charErrors);
  const audioSeconds = sum((f) => f.audioSeconds);
  const wallSeconds = sum((f) => f.wallSeconds);
  const pairs = new Map<string, SubstitutionCount>();
  for (const file of files) {
    for (const p of file.score.substitutionPairs) {
      const key = `${p.reference}\u0000${p.hypothesis}`;
      const found = pairs.get(key);
      if (found) found.count += p.count;
      else pairs.set(key, { ...p });
    }
  }
  const diarized = files.map((f) => f.score.diarization).filter((d): d is DiarizationScore => d !== null);
  const diarWords = diarized.reduce((n, d) => n + d.words, 0);
  const diarMatched = diarized.reduce((n, d) => n + d.matched, 0);
  return {
    files: [...files],
    referenceTokens,
    errors,
    wer: referenceTokens === 0 ? 0 : errors / referenceTokens,
    referenceChars,
    charErrors,
    cer: referenceChars === 0 ? 0 : charErrors / referenceChars,
    audioSeconds,
    wallSeconds,
    wallSecondsPerAudioHour: audioSeconds === 0 ? 0 : (wallSeconds / audioSeconds) * 3600,
    audioMinutesBilled: audioSeconds / 60,
    topSubstitutions: [...pairs.values()].sort((a, b) => b.count - a.count || (a.reference + a.hypothesis < b.reference + b.hypothesis ? -1 : 1)).slice(0, TOP_SUBSTITUTIONS),
    diarization: diarized.length === 0 ? null : { words: diarWords, matched: diarMatched, accuracy: diarWords === 0 ? 0 : diarMatched / diarWords },
  };
}

// The proposed pass line for clear speech (the owner confirms it with the first real run).
export const PROPOSED_MAX_WER = 0.15;

const pct = (ratio: number) => `${(ratio * 100).toFixed(1)}%`;
const fixed = (n: number, digits = 1) => n.toFixed(digits);

export interface ReportOptions {
  // Print the token pairs of the most frequent substitutions. Words of a real meeting are private: off for a private set.
  showPairs: boolean;
}

// Markdown for the job summary and the terminal: numbers per file and overall, never a line of a transcript. File ids are the
// names the person gave the files in the private folder, so they are printed as an index (file 1, file 2) for a private set.
export function formatTranscriptionEvalReport(summary: TranscriptionEvalSummary, options: ReportOptions & { nameFiles: boolean }): string {
  const lines: string[] = ['## Transcription eval', ''];
  lines.push('| File | Audio (min) | Words | WER | CER | Sub / Del / Ins | Wall (s) | Chunks |');
  lines.push('|---|---:|---:|---:|---:|---|---:|---:|');
  summary.files.forEach((file, index) => {
    const name = options.nameFiles ? file.id : `file ${index + 1}`;
    const s = file.score;
    lines.push(`| ${name} | ${fixed(file.audioSeconds / 60)} | ${s.referenceTokens} | ${pct(s.wer)} | ${pct(s.cer)} | ${s.substitutions} / ${s.deletions} / ${s.insertions} | ${fixed(file.wallSeconds)} | ${file.chunks} |`);
  });
  lines.push('');
  lines.push(`- **Overall WER:** ${pct(summary.wer)} (${summary.errors} errors over ${summary.referenceTokens} reference words); **CER:** ${pct(summary.cer)}`);
  lines.push(`- **Wall time per hour of audio:** ${fixed(summary.wallSecondsPerAudioHour, 0)} s (${fixed(summary.wallSeconds)} s for ${fixed(summary.audioSeconds / 60)} audio minutes)`);
  lines.push(`- **Audio minutes billed:** ${fixed(summary.audioMinutesBilled)}`);
  if (summary.diarization) {
    lines.push(`- **Speaker label right on aligned words:** ${pct(summary.diarization.accuracy)} (${summary.diarization.matched} of ${summary.diarization.words})`);
  }
  if (options.showPairs && summary.topSubstitutions.length > 0) {
    lines.push('', '**Most frequent substitutions (reference → provider):**');
    for (const p of summary.topSubstitutions) lines.push(`- ${p.reference} → ${p.hypothesis} (${p.count})`);
  } else if (summary.topSubstitutions.length > 0) {
    lines.push(`- **Most frequent substitutions:** ${summary.topSubstitutions.reduce((n, p) => n + p.count, 0)} in the top ${summary.topSubstitutions.length} pairs (the words are not printed for a private set; set TRANSCRIBE_EVAL_SHOW_PAIRS=true on your own screen)`);
  }
  lines.push(`- **Proposed pass line (clear speech):** WER at most ${pct(PROPOSED_MAX_WER)}: ${summary.wer <= PROPOSED_MAX_WER ? 'PASS' : 'FAIL'}`);
  return `${lines.join('\n')}\n`;
}
