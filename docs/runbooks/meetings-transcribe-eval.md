# Runbook: the meeting transcription eval

How Ludy measures how well a speech-to-text provider writes down a Vietnamese meeting (meetings plan M4, issue #2979; the provider modes are in [meetings-ai.md](meetings-ai.md)). It is the sibling of the [extraction eval](ai-eval.md): the same idea, a fixed set run through the production path and scored against what a person checked.

The eval runs each recording of a set the way a meeting is transcribed:
1. the media sandbox (`crove-media`) normalizes it to mono Opus and cuts it into 10 minute chunks;
2. `transcribeChunks` sends the chunks to the provider in the deployment's `TRANSCRIBE_*` settings, in either request mode (`audio_transcriptions` or `chat_input_audio`);
3. the merged transcript is compared with the reference transcript.

It reports:
- **WER** (word error rate) and **CER** (character error rate), per file and overall;
- the **wall time per hour of audio** (the time the provider's calls took; the sandbox's own time is not in it) and the **audio minutes billed**;
- how often the **speaker label** is right on the aligned words, when the reference names its speakers;
- the five most frequent substitutions, as word pairs, only when you ask for them.

This measures the recorder's Vy transcription. Vy itself is not changed by it, and the eval never writes anything to a Ludy database.

## How the numbers are counted

- Text is made NFC, lower case, and every run of punctuation or space is a boundary. Vietnamese is written one syllable per word, so a word is one token.
- A different diacritic is a different word: `má` for `ma` is an error.
- Words are aligned with the smallest number of substitutions, deletions and insertions (Levenshtein over tokens). WER is (substitutions + deletions + insertions) divided by the reference words. It can be above 100 percent when the provider wrote much more than was said.
- CER is the same distance over the characters of the normalized text.
- Speaker labels and timestamps do not count for WER. Diarization is scored apart: a provider calls its speakers "Người nói 1", a person wrote "Lan", so each provider label is mapped to at most one reference speaker (the best match first) and the report gives the share of aligned words whose label is the mapped one.

## Before you start

| Input | Who | Issue |
|---|---|---|
| Recordings of real meetings, with the consent of the people in them | owner | #2585 |
| For each, the reference transcript a person checked | owner | #2585 |
| The provider's key, base URL and model | owner, coordinator (a production step, never in chat or the repository) | #2972 |
| A private machine with Node 26, pnpm and ffmpeg (the pilot server or the owner's computer) | owner | |

## 1. Where the recordings go

The recordings and references never go into the repository, a pull request, an issue or a CI log. GitHub is public.

1. Put them in one folder outside your checkout of this repository, for example `/srv/crove-transcribe-eval/`. Subfolders are fine.
2. Next to each recording, put a text file with the same name and the extension `.txt`: `hop-01.ogg` and `hop-01.txt`.
3. Accepted recordings: `.ogg`, `.webm`, `.m4a`, `.mp3`.
4. The reference is plain text. To score the speakers, start each speaker's turn with their name in square brackets: `[Lan] Xin chào cả nhà [Minh] Chào chị Lan`. The label stays for the words that follow until the next one. A reference with no brackets is scored for words only.

The eval refuses to start when a recording has no reference or a reference has no recording, and names the files, so a set never measures less than it claims.

## 2. Run it

On the private machine, in a checkout of this repository (`pnpm install` once):

```sh
TRANSCRIBE_EVAL_DIR=/srv/crove-transcribe-eval \
TRANSCRIBE_BASE_URL=<the provider's base URL> TRANSCRIBE_MODEL=<the model> \
TRANSCRIBE_API_MODE=<audio_transcriptions or chat_input_audio> TRANSCRIBE_API_KEY=<the key, if any> \
pnpm ai:eval:transcribe
```

- These are the same `TRANSCRIBE_*` variables the server reads ([meetings-ai.md](meetings-ai.md), step T1). Without `TRANSCRIBE_BASE_URL` and `TRANSCRIBE_MODEL` the suite skips itself.
- The sandbox is the real `apps/media` service, started as a child process on a free local port with ffmpeg from the PATH. To use a running sandbox (the container) instead, set `MEDIA_URL`.
- `TRANSCRIBE_EVAL_LANGUAGE=en` runs an English set (default `vi`).
- The report never prints a line of a transcript, a speaker's name or a file's name: files are "file 1", "file 2" for a private set. It is safe to paste into an issue. To also see the most frequent word substitutions on your own screen, add `TRANSCRIBE_EVAL_SHOW_PAIRS=true`, and never paste that output anywhere public.
- The full diff of each file (every error with the words, for a person to read) goes to a local directory, `TRANSCRIBE_EVAL_OUT` or a new private temporary one, with mode 600. It holds transcript text: keep it on the machine and delete it when done.
- `TRANSCRIBE_EVAL_MAX_WER=0.15` makes the run fail above that WER (a gate); without it the numbers are only reported.
- Without `TRANSCRIBE_EVAL_DIR`, the eval scores the committed synthetic clips (see below).

## 3. Read the result

- **File table:** audio minutes, reference words, WER, CER, substitutions / deletions / insertions, wall seconds, chunks.
- **Overall WER and CER:** the sum of errors over the sum of reference words, so a long meeting counts for more than a short one.
- **Wall time per hour of audio:** the plan's acceptance reads "a one-hour Vietnamese meeting is transcribed within the time measured on the reference provider". Run a one-hour recording once to get this number for the provider.
- **Audio minutes billed:** the audio sent to the provider, to check against the invoice and `AI_PRICE_AUDIO_PER_MIN`.
- **Pass line (proposed):** WER at most 15 percent on clear speech. The report prints PASS or FAIL against it, but it is a proposal: the owner confirms the line with the first real run (#2585).
- Many deletions with a low insertion count usually mean the provider dropped quiet speech or a long silence; many insertions mean it made up text. Wrong substitutions that repeat (`TRANSCRIBE_EVAL_SHOW_PAIRS=true`) point at names and numbers the provider gets wrong, which a custom vocabulary or a bigger model may fix.

## 4. In CI

Nothing here calls a real provider in CI. The committed synthetic set, `packages/agent/test/fixtures/transcripts`, is two 3 second tone clips (generated, no speech, no person; license in its README) with two reference transcripts written for the purpose. Its test, `packages/agent/test/transcribe-eval-runner.test.ts`, runs the whole path on them in the normal unit tests: the real `crove-media` sandbox when ffmpeg is on the machine, then a fake provider that answers a fixed transcript for each clip, in both request modes. The numbers it must give are known in advance (for the first clip, 2 errors over 41 words), so a change to the scorer, the chunking, the timeline offsets or the request modes that moves them fails the build. The scorer itself has its own unit tests (`transcribe-eval.test.ts`).

The live suite, `pnpm ai:eval:transcribe`, is run by a person on a private machine, as the extraction eval is.
