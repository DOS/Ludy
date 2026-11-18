<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Importing a platform's video recording: sizing

A meeting platform (Google Meet, Teams) hands over a **video** file. The import job ([plan, "C2a as built"](../plan/meetings-integrations.md)) keeps only its audio: the video is sealed in the blob store while it downloads, crove-media reads it back and returns mono Opus, and only the Opus is staged. This page says what that costs, so the worker, the blob store and the media container can be sized for it. Nothing here runs unless `MEDIA_URL` is set and the platform adapter is on.

## What one video import uses

| Where | What | How much |
|---|---|---|
| Worker (memory) | A few chunks in flight, plus the Opus that comes back (about 11 MB an hour) | Under 50 MB. The video is never held whole. |
| Blob store | The sealed video under `tmp/<org>/`, until the call ends | Up to `MEETING_PLATFORM_VIDEO_MAX_BYTES` (2 GiB) per import, plus the encryption overhead (under 1 percent). Deleted on success and on every failure; a crash leaves ciphertext whose key was only in memory, which the daily retention job deletes. |
| crove-media (memory) | The decrypted video spooled to its scratch tmpfs (`/data/scratch`, `MEDIA_SCRATCH_SIZE`, 2304m by default), then ffmpeg | Up to `MEDIA_MAX_INPUT_BYTES` (2 GiB) in the tmpfs, which counts against `MEDIA_MEM_LIMIT` (4g by default), plus ffmpeg's own working memory. |
| crove-media (time) | One slot, for the extraction only | Up to `MEDIA_TIMEOUT_MS` (5 minutes). The slot is not held while the platform's file downloads. |
| Worker (time) | The download, then the extraction | The download is limited to 20 minutes; with the extraction it stays inside the job's 30-minute expiry. |

## Settings that matter

- `MEDIA_MAX_INPUT_BYTES` must stay at or above `MEETING_PLATFORM_VIDEO_MAX_BYTES` (2 GiB), or the sandbox refuses the video after it was sealed and sent (`too_large`).
- `MEDIA_SCRATCH_SIZE` must hold one video (2304m is sized for 2 GiB plus slack); with `MEDIA_CONCURRENCY` above 1 it must hold that many at once, and `MEDIA_MEM_LIMIT` must grow with it.
- The blob store needs 2 GiB of free room per import running at once; the worker runs two imports at once (`MEETINGS_IMPORT_CONCURRENCY`).
- Lower `MEETING_PLATFORM_VIDEO_MAX_BYTES` (a code constant, `packages/kernel-contract/src/meeting-platform.ts`) rather than `MEDIA_MAX_INPUT_BYTES` if a smaller deployment cannot hold 2 GiB; a larger video then fails `too_large` before a byte is read, when the platform declares its size.

## How a failure is recorded

On the recording's row, as a short code and never the platform's words: `too_large` (over a cap), `no_audio` (the video has no audio track, or no sandbox is configured), `invalid_media` (the file is not a video the sandbox can read), `too_long`, `timeout` (the sandbox ran out of time, not retried), `normalize_failed` (the sandbox is down or busy, retried, then recorded), `download_failed` (the body ended short, retried). The platform's own copy is never touched. The words the app shows for these codes are updated when the refusal of video-only recordings is lifted (PR 2 of C2a).
