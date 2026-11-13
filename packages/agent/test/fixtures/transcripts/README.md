# Synthetic transcription eval fixture (#2979)

Two short clips for the transcription eval's runner test (`packages/agent/test/transcribe-eval-runner.test.ts`).

- `clip-a.ogg`: a 3 second 440 Hz sine tone, mono Opus. `clip-b.mp3`: a 3 second 330 Hz sine tone, mono MP3. Both were generated with
  `ffmpeg -f lavfi -i sine=frequency=<hz>:duration=3` and contain no speech and no recording of a person.
- `clip-a.txt`, `clip-b.txt`: the reference transcripts, sentences written for this fixture. `clip-a.txt` names its speakers with `[Name]`
  markers (see `parseReference` in `packages/agent/src/transcribe-eval.ts`).

The tones are placeholders: the test's fake provider returns a fixed transcript for each clip, so the numbers the scorer must give are
known in advance. No real provider is called.

License: the audio and the text are original to this repository and released under CC0 1.0 (public domain dedication) as well as the
repository's AGPL-3.0-only. Real recordings never go in the repository (docs/runbooks/meetings-transcribe-eval.md).
