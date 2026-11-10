// SPDX-License-Identifier: AGPL-3.0-only
// The transcription eval (#2979, meetings plan M4): every recording of a set goes through the production path (the media sandbox cuts it
// into 10 minute chunks, transcribeChunks sends them to the provider in TRANSCRIBE_*) and its transcript is scored against the reference a
// person checked. The set is TRANSCRIBE_EVAL_DIR (private recordings, kept outside the repository; see docs/runbooks/meetings-transcribe-eval.md)
// or, without it, the committed synthetic clips. Run with `pnpm ai:eval:transcribe`. Without a provider (TRANSCRIBE_BASE_URL, TRANSCRIBE_MODEL) the
// suite skips itself. The report holds numbers only; the full diff of each file goes to a local directory (TRANSCRIBE_EVAL_OUT).
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { formatLocalDiff, formatTranscriptionEvalReport, summarizeTranscriptionEval, type FileResult } from '../src/index.ts';
import { evaluateRecording, loadTranscriptSet, startMediaSandbox, SYNTHETIC_TRANSCRIPTS, transcribeConfigFromEnv, type RunningSandbox } from './transcripts.ts';

const privateDir = process.env.TRANSCRIBE_EVAL_DIR?.trim() || null;
const provider = transcribeConfigFromEnv();
const language = process.env.TRANSCRIBE_EVAL_LANGUAGE?.trim() === 'en' ? 'en' : 'vi';
// The words of a real meeting are private: printed only for the committed synthetic set, or when asked on your own screen.
const showPairs = privateDir === null || process.env.TRANSCRIBE_EVAL_SHOW_PAIRS === 'true';
// A pass line is only a gate when one is set; the plan's proposed 15 percent is for the owner to confirm with the first real run.
const maxWer = process.env.TRANSCRIBE_EVAL_MAX_WER ? Number(process.env.TRANSCRIBE_EVAL_MAX_WER) : null;

if (!provider) console.warn('TRANSCRIBE_BASE_URL and TRANSCRIBE_MODEL are not set: skipping the transcription eval');
// A set with a missing pair stops here, naming the files, before anything is sent.
const pairs = provider ? loadTranscriptSet(privateDir ?? SYNTHETIC_TRANSCRIPTS) : [];

describe.skipIf(!provider)('transcription eval', () => {
  const results: FileResult[] = [];
  let sandbox: RunningSandbox | null = null;
  const outDir = process.env.TRANSCRIBE_EVAL_OUT?.trim() || null;
  const diffDir = outDir ?? (privateDir ? mkdtempSync(join(tmpdir(), 'crove-transcribe-eval-')) : null);

  afterAll(async () => {
    await sandbox?.stop();
  });

  for (const pair of pairs) {
    it(`transcribes ${privateDir ? 'a recording' : pair.id}`, async () => {
      sandbox ??= await startMediaSandbox();
      const run = await evaluateRecording(pair, { media: sandbox.client, provider: provider!, language });
      results.push(run.result);
      if (diffDir) {
        const path = join(diffDir, `${pair.id}.diff.txt`);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, formatLocalDiff(run.scored), { mode: 0o600 });
      }
    });
  }

  it('reports WER, CER, time per hour of audio and the audio minutes billed', () => {
    expect(results.map((r) => r.id).sort(), 'every recording must be scored').toEqual(pairs.map((p) => p.id).sort());
    const summary = summarizeTranscriptionEval(results);
    const report = formatTranscriptionEvalReport(summary, { showPairs, nameFiles: privateDir === null });
    console.log(report);
    if (diffDir) console.log(`The full diff of each file (it holds transcript text) is in ${diffDir}`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
    if (maxWer !== null) expect(summary.wer, report).toBeLessThanOrEqual(maxWer);
  });
});
