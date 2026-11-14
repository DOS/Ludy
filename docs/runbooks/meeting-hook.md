# The minutes webhook (a member's own address for the minutes they publish)

Plan: [Meetings integrations, section 4.5](../plan/meetings-integrations.md). Tracking: issue #3164. It reuses the signing and the delivery of [the wake-up webhook](mcp-wake-webhook.md); verify a message exactly as that runbook says (headers, signature, replay window, test vectors).

What it is: a member gives one https address on the Meetings screen ("Gửi biên bản tới địa chỉ của tôi"). When that member, as the recorder, publishes the minutes of a meeting, Ludy sends one signed `POST` there. Nothing else sends it: not a draft, not a result someone else published, not an unpublish. **It is off for every organization until the owner turns it on**, and no AI takes part: what goes out is what the person approved by publishing.

## Whose it is

- **One address per member, theirs alone.** Only that member sets, reads, rotates, tests or clears it. The owner sees nothing of it, and only turns the feature on or off for the organization.
- **The owner's switch.** Off by default. While it is off no member can save an address (`MEETING_HOOKS_OFF`) and nothing is sent. Turning it off drops every message not yet sent, in the same transaction.
- **It stops** when the member leaves the organization or is disabled, when the member turns it off or removes it, and when the owner turns the feature off. The next attempt of a waiting message drops it instead of sending.

## What Ludy sends

`POST <your address>`, `Content-Type: application/json`, the three headers of the wake-up (`Ludy-Event-Id`, `Ludy-Timestamp`, `Ludy-Signature: v1=<hex>`) and a body with the keys `id`, `type`, `created_at`, `org` and `data`, in that order. The `id` is the id of the published result, the same on every retry, so deduplicate on it. The `type` is:

- `meeting.result_published`: `data` always has `meeting_id`, `published_at` (when the minutes were published), `started_at` (the meeting's start, or the publish time when the meeting has none) and `length_seconds` (or `null`). The member ticks what else is there: `title`, `summary` (the published text, at most 8000 characters), `decisions` (a list of at most 50), `action_items` (a list of at most 100 of `{text, owner, due}`: the text, the owner as said, and the due date as `YYYY-MM-DD` or `null`).
- `ping`: `data` is `{}`. The "Gửi thử" test, at most once a minute and ten an hour (`MEETING_HOOK_TOO_SOON`).

**Never** in the body, whatever the ticks: the transcript, the audio, the video, or any attendee's contact details. The body is built by one function that refuses any key it does not know, and the database refuses a stored body with such a key, so this does not depend on a screen.

## Leaving Ludy cannot be recalled

What the member ticks leaves Ludy the moment the minutes are published. Ludy cannot take it back from the address or from any tool behind it, and a personal-data erasure done later in Ludy does not reach it. The card says so before an address is saved. Inside Ludy the text is kept only while a message waits: the stored copy is cleared the moment the message is sent, fails or is dropped, and a waiting message is dropped, copy cleared, when the meeting's title, summary, decisions or an action item change (which is what an erasure does), when the meeting is deleted, and when the hook is turned off.

## The secret

Ludy makes it (`whsec_` and 32 random bytes) when the address is first saved, shows it **once**, and keeps it only sealed with the deployment's credential key, bound to the organization and the member. **Without `CREDENTIAL_KEY` the card says so and nothing can be saved.** "Bí mật mới" shows a new secret once; for 24 hours every message carries two signatures so the receiver can switch without a gap. Removing the address deletes the secret. Audit rows hold the host and the names of the ticked fields, never the full address, the secret or any text.

## Retries, pause and what the member sees

- A message that is stored at publish and not yet handed over is handed to the queue by a sweep that runs every minute (one not taken up within 3 minutes is handed over again). A failed attempt (not `2xx`, a timeout, a redirect, a refused connection) is retried 8 times from 30 seconds, doubling, each retry signed again with a fresh timestamp. A message still waiting after 8 hours fails and does not count against the receiver. Delivery is at least once.
- If the address fails for **7 days** running the hook is paused and the card says so; fix the receiver and save to turn it back on. The card shows the last result ("gửi lần cuối").
- The address follows the wake-up's rules: https only, a public domain name, port 443, no credentials in it; every send looks the name up again and refuses a private address; the answer is capped at 4 KB and never read.

## If it does not arrive

1. Is the owner's switch on, and is the hook on? The card says which.
2. "Gửi thử": a test with no meeting data. If it arrives and a published meeting does not, check that the minutes were published by the member who set the address (a meeting recorded by someone else sends to that recorder's address, if they set one).
3. Verify the signature on the raw body, with the secret shown when it was made, and with both secrets during a rotation.
4. Lost the secret: "Bí mật mới" and update the receiver.
