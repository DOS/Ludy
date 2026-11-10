# Runbook: switch on the meetings AI (summary and transcription)

How an instance turns on the recorder's Vy for meeting notes: the summary with its decisions and action items (`MEETINGS_SUMMARY`, #2580), and speech to text (`MEETINGS_TRANSCRIBE`, #2578). Both are off by default, and the meetings module works without them: a person types or pastes the transcript and writes the summary by hand.

This is a production step. No team lead or worker runs it. The coordinator shows the owner the step list below, the owner approves it in the coordinator's chat, and the coordinator runs exactly that list, stopping at the first failure ([contributing](../contributing.md#production-secret-and-credential-steps)). Secrets are named here by reference, never by value.

## What switching on does

- **Summary.** The recorder clicks "Nhờ Vy tóm tắt" on a meeting, then "Chép vào bản nháp của tôi". Their own Vy, a member-scoped run (ADR-0049), reads the transcript and writes a draft summary, decisions and action items. Every copied draft row is tainted: the screen shows the review note, and the draft cannot be shared until the recorder clicks "Tôi đã đọc". Each call goes through the AI budget meter, and the kill switch stops it.
- **Transcription.** The recorder clicks "Nhờ Vy ghi lời". Their Vy sends the meeting's audio, chunk by chunk, to the speech-to-text provider. It reads the audio only through the audited door (`crove_meetings.audio_for_member_vy`) and the recorder's "Chép vào bản nháp của tôi" copies the text into a draft transcript, also tainted. It is metered by audio minutes.
- **Neither one changes data on its own.** Nothing is published, sent or turned into a task without a person's click.

## Preconditions (check each, do not assume)

| # | Check | How | Who |
|---|---|---|---|
| P1 | The release that runs includes #2822's gates (#2950, #2955), #2946 and #2949 | `/version` answers a build at or after the merge of the last of them | coordinator |
| P2 | The deployment's AI provider is set: `AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY` in the host's env file | `deploy.sh` config check; an existing AI feature (the Inbox suggestion) answers | coordinator |
| P3 | Member Vy is allowed for the pilot org's members (`vy.use`) and the org's AI budget is set | Settings, AI: the budget shows a limit; a member can open Vy | owner or org owner |
| P4 (transcription only) | `CREDENTIAL_KEY` (or a shared `CREDENTIAL_KEY_FILE`) is the same on `api` and `worker` ([credential-key.md](credential-key.md)) | the meeting screen offers "Nhờ Vy ghi lời" after step T2; without the key the status says off | coordinator |
| P5 (transcription only) | A speech-to-text provider, its account and key exist, and the provider was chosen by the owner | the owner names it in the coordinator's chat | owner |
| P6 (transcription only) | The lawyer's answer on recording consent and on sending voice to a provider abroad (#2585), or the owner's decision to run an internal test first | recorded on #2585 | owner, lawyer |

## Steps: summary (option A)

| Step | Action | Check | Rollback |
|---|---|---|---|
| S1 | In the host's env file, set `MEETINGS_SUMMARY=on` | `docker compose config` shows it on the `api` service | set it back to `off` |
| S2 | Redeploy the running release (`deploy.yml`, action `deploy`, the same tag) | the smoke test passes; `/readyz` is 200 | `deploy.yml`, action `rollback` |
| S3 | Smoke test in the pilot org with a test meeting (no real customer data): paste a short transcript, click "Nhờ Vy tóm tắt", then "Chép vào bản nháp của tôi" | the draft shows the review note; "Chia sẻ cho người dự họp" is refused; after "Tôi đã đọc" it works | S1 rollback, then S2 |
| S4 | Check the AI meter | the call appears against the recorder's Vy with its token count | none needed |

## Extra steps: transcription (option B)

| Step | Action | Check | Rollback |
|---|---|---|---|
| T1 | Put the provider key into the host's secret store as `TRANSCRIBE_API_KEY` (a person does this; the value never goes into a chat, an issue or the repository). Set `TRANSCRIBE_BASE_URL` (https), `TRANSCRIBE_MODEL`, `TRANSCRIBE_API_MODE` (see below) and `AI_PRICE_AUDIO_PER_MIN` | `docker compose config` shows the names set on both `api` and `worker`; the kernel refuses to start on an `http://` URL unless `TRANSCRIBE_ALLOW_INSECURE_HTTP=1`, which must stay `0` for a provider on the internet | remove the values |
| T2 | Set `MEETINGS_TRANSCRIBE=on` on `api` and `worker`; redeploy as in S2 | the smoke test passes; the meeting screen offers "Nhờ Vy ghi lời" | set it to `off`, redeploy |
| T3 | Smoke test with a two-minute Vietnamese test recording made for the purpose, with the consent step filled in | the run ends; "Chép vào bản nháp của tôi" fills a draft transcript with the review note; the meter shows the audio minutes | T2 rollback |

The provider must speak an OpenAI-compatible API (AGENTS.md: AI calls go through an OpenAI-compatible endpoint). `TRANSCRIBE_API_MODE` says which request the adapter makes:

| Mode | Request | For |
|---|---|---|
| `audio_transcriptions` (default) | the chunk as a file to `${TRANSCRIBE_BASE_URL}/audio/transcriptions`, `verbose_json` answer | a Whisper-class model, hosted or local |
| `chat_input_audio` | the chunk as an `input_audio` part to `${TRANSCRIBE_BASE_URL}/chat/completions`, with a fixed instruction asking for JSON segments (start, end, speaker, text) in the recorder's language | a provider with no transcription endpoint, such as Gemini's OpenAI-compatible one |

In both modes the answer is untrusted data: times are clamped to the chunk, text is cut to a stated length, a label is a short plain string, and a reply that is not usable JSON is refused. The audio and the key go only to `TRANSCRIBE_BASE_URL` over https, a redirect is never followed, and nothing of the audio or the text is logged.

Example values for Gemini 3.5 Transcribe (the key is set by a person as in T1, never written here):

```
TRANSCRIBE_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
TRANSCRIBE_MODEL=gemini-3.5-transcribe
TRANSCRIBE_API_MODE=chat_input_audio
AI_PRICE_AUDIO_PER_MIN=<the price of one minute of audio in the unit of the other AI_PRICE_* settings>
```

The `input_audio` part names the audio's format by the extension of its type (`wav`, `mp3`, `ogg`, `m4a`, ...); a type with no such name (`audio/x-m4a`, `audio/aac`) is refused by Ludy before any audio is sent, and a type the provider does not accept is refused by the provider; either way the run ends with a `TRANSCRIBE_INVALID_REQUEST` code. T3 (the two-minute test recording) is what proves a given format works with the provider.

## Rollback at any time

- Set the flag back to `off` and redeploy, or turn on the AI kill switch for the org. Both stop new runs at once (the kill switch also stops a run between chunks; with only the flag off, a run already going may finish).
- Nothing is lost:
  - Drafts and published notes stay.
  - Each member's private Vy results expire on their own within 31 days and are never shared.

## Cost (fill in before the owner approves)

- **Summary:** about `<tokens per hour of meeting>` tokens per hour of meeting, at the deployment's AI price.
- **Transcription:** `AI_PRICE_AUDIO_PER_MIN` × 60 per hour of audio, at the chosen provider's price. For Gemini 3.5 Transcribe, Google's page (read 2026-11-10, via web sources) lists $2 per million audio input tokens plus $12 per million text output tokens, about $0.005 per audio minute, so about $0.30 per hour of meeting; confirm it on the provider's price page before the owner approves. A request is limited to 15 minutes of audio with timestamps and speakers, and Ludy's 10-minute chunks fit.
- **Limit:** the org's AI budget caps both; a spent budget refuses before the call.
