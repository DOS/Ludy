<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Microsoft Teams recordings in Ludy Meetings: set up and operate

A member connects their own Microsoft 365 work or school account and Ludy then lists the Teams meetings that have a recording or a transcript, as suggestions. Nothing is downloaded before the member presses "Import" on the Meetings tab ([plan, section 6.4](../plan/meetings-integrations.md)). It is **off by default**: without the two settings below there is no Teams adapter and no button.

> **Facts to re-check on the first live run.** The code and this page were written from Microsoft's own Graph and Teams documentation (read on 2026-11-18) and tested only against fixtures and a stub transport; no Microsoft account has been used and no call was made to Microsoft. What the first self-hoster finds goes on [#3176](https://github.com/DOS/Ludy/issues/3176). Marked **[unverified]** below: how Graph treats the files of a recurring series (the time match above is Ludy's rule, not Microsoft's), whether `Calendars.ReadBasic` returns the join address of an event, the host a recording download redirects to, the Microsoft 365 licences the organizer needs, whether a transcript of a meeting someone else organized can be read with the delegated permission, and the exact labels of the two Teams admin settings.

## Cost

- **Microsoft does not meter these Teams APIs any more** (the recording and transcript APIs were billed per minute until 2025-08-25; Microsoft's page says they are not metered since). Ludy therefore needs **no Azure subscription or billing account** for them, and the old plan figure (about 0.003 USD per recording minute, 600 free minutes) no longer applies. The owner confirms this on the issue ([C-OA3, #3179](https://github.com/DOS/Ludy/issues/3179)); until then nothing in Ludy sets up an Azure billing account and the feature stays off by default.
- Ludy itself: the import is a click, no model is called by it. Transcribing the downloaded recording uses the normal transcription path and its meter, as any upload does. A platform transcript (WebVTT) costs nothing to read.

## What the operator does (once per deployment)

1. In the Microsoft Entra admin center create an **App registration**: supported account types "Accounts in any organizational directory" (multi-tenant, work and school only, so the tenant is `organizations`; personal Microsoft accounts have no Teams meeting recordings through Graph).
2. Add a **Web** redirect URI `APP_URL/meetings/oauth/microsoft_teams/callback`, exactly, with no trailing slash. `APP_URL` is the address of the web app, not the API's ([split-app-api.md](split-app-api.md)).
3. Under API permissions add these **delegated** Microsoft Graph permissions, and no other: `openid`, `profile`, `offline_access`, `Calendars.ReadBasic`, `OnlineMeetings.Read`, `OnlineMeetingRecording.Read.All` and `OnlineMeetingTranscript.Read.All`. Nothing that writes, no mail, no files or sites scope, no `User.Read`, and none of the application-only `getAll` permissions (those would read every user's meetings; a recording in Ludy belongs to the member who imported it). The last two permissions need **administrator consent** in every tenant (their names end in `.All` but they still read only what the signed-in member may read).
4. Create a client secret. Put the Application (client) ID and the secret in the settings of the API **and** the worker (the worker renews tokens): `TEAMS_OAUTH_CLIENT_ID` and `TEAMS_OAUTH_CLIENT_SECRET`. Set both or neither; the server refuses to start with one, or with an id that is not a UUID. `CREDENTIAL_KEY` must be set too ([credential-key.md](credential-key.md)). A client secret expires (24 months at most): write the date down.
5. Publisher verification is not required for the app to work, but a tenant that only lets members consent to verified apps will ask for administrator consent for everything.

## What a tenant administrator does (each Microsoft 365 tenant, once)

A one-person company is its own administrator: this is three steps in its own admin pages.

1. **Consent for the app.** Open `https://login.microsoftonline.com/organizations/adminconsent?client_id=<Application ID>&redirect_uri=<the redirect URI above>` as a Global Administrator (or Privileged Role Administrator), or approve the app when Microsoft shows its "Need admin approval" page. Microsoft answers `AADSTS65001`, `AADSTS90094` or `AADSTS90095` until this is done.
2. **Let apps read transcripts (off by default).** In the Teams admin center, under the setting for transcript API access (labelled "Microsoft Graph access" **[unverified]**), turn it on. While it is off Graph answers 403 `GraphAccessToTranscriptsDisabled` and Ludy says exactly that, without retrying. Recordings are not behind this switch. With the switch off Graph also refuses the list of a meeting's transcripts, so Ludy offers no transcript for it and the meeting looks as if it had none; the connect screen of the next PR names this switch in plain words, and the message below appears when a transcript is opened and Graph answers it.
3. **Speaker names (second switch).** To keep the speakers' names in a transcript, the Teams meeting setting "Include speaker attribution" **[unverified]** must be on; otherwise Graph answers 403 `SpeakerAttributionNotAllowed` and Ludy says so.

## What a member sees

- Settings, **Security** tab, card "Kết nối nền tảng họp" (Meeting platforms): a button "Kết nối Microsoft Teams" appears only where steps 1 to 4 above are done. Under it the card says in plain words that the member's Microsoft 365 administrator has to allow Ludy once (and turn on transcript access for transcripts), that Ludy cannot do this for them, that nothing is downloaded until "Nhập", what Microsoft charges (nothing, see Cost), and links to this page as the guide for the administrator. The button opens Microsoft's own permission screen; the member comes back to a page that says which account was connected.
- **The administrator has not allowed the app.** Microsoft sends the member back with `AADSTS65001`, `AADSTS90094` or `AADSTS90095` (at the redirect, or when Ludy exchanges the code). The page says that only the administrator can do it and Ludy cannot, shows the administrator consent address to hand over (built from the app's own id and return address) and the link to this guide. Nothing is retried; the attempt is used up and nothing is stored. After the administrator has allowed the app the member connects again.
- **The transcript switches** (administrator steps 2 and 3) are named in the card before the member connects, and `transcripts_disabled` and `speakers_disabled` show the message of those steps when Microsoft answers them while a transcript is opened.
- **Before the first import**, the import dialog of a Teams recording shows the cost line (Microsoft does not charge; Ludy's own transcription of the audio is metered like any upload) and says that the video is downloaded only to take the audio out of it, and only the audio is kept.

## What the member can import

- Each **occurrence** of a recurring meeting is its own entry: Teams keeps one join address and one meeting object for the whole series, so Ludy matches a recording or transcript to the occurrence by the time it was made (within 30 minutes of the occurrence). An occurrence with two recordings in it (the organizer stopped and started) is not offered.
- Only **scheduled** Teams meetings with a join address (not a one-to-one call, a channel meeting without one, or a "meet now" the calendar does not hold) of the **last 14 days**; Microsoft keeps them reachable for about 60 days, and Ludy never reads further back.
- A **recording**: only the meeting's **organizer** may download it, so a meeting someone else organized offers its transcript only. A meeting with several recordings (the organizer stopped and started it) offers none until they can be joined. A Teams recording is a **video** file: it imports only where the **media sandbox** (`crove-media`, `MEDIA_URL`) is running ([meetings-video-import.md](meetings-video-import.md)); Teams has no audio-only file.
- A **transcript** (Microsoft's own WebVTT, in the meeting's spoken language, lines tagged with the speaker): it is read at the click, kept as Microsoft's transcript (source `microsoft_teams`) and shown next to Ludy's own for comparison. It is untrusted text like any transcript: it never runs anything and never decides anything.
- The member disconnects in Settings at any time; Ludy forgets the access and the suggestions. Meetings already imported stay. Microsoft has no revoke endpoint: the member also removes the app in their Microsoft account ("My Apps"), and a refresh token otherwise lives up to 90 days.

## How the access is kept

- The access token lasts about an hour; the worker renews it shortly before, under a row lock, and **saves the new refresh token Microsoft rotates in** on every renewal ([plan 6.1](../plan/meetings-integrations.md)). A grant Microsoft will not renew (`invalid_grant`, the member left, the app was removed or the administrator withdrew consent) marks the connection expired and Settings says "connect again"; nothing else changes.
- Tokens are sealed with the credential key for the member's org, platform and account (`<tenant id>:<user id>` from the sign-in token, so it survives a rename); only the worker opens them. No screen, answer, log line or audit row carries a token, the code or Microsoft's own words; an error is a short code.
- The only hosts Ludy calls are `graph.microsoft.com` and `login.microsoftonline.com`. A recording is downloaded from Graph first, then only through a redirect to `sharepoint.com` or one of its subdomains **[unverified]**, and the token goes only to the first host. A next-page link on any other host is refused.

## When something fails

| What the member sees | Likely cause | What to do |
|---|---|---|
| Microsoft shows "Need admin approval" | The tenant needs the administrator's consent for the two `.All` permissions | Administrator step 1 above |
| No transcript offered, or the `transcripts_disabled` message | Transcript API access is off in the tenant | Administrator step 2 |
| `speakers_disabled` message | Speaker attribution is not allowed | Administrator step 3 |
| "Connection expired: connect again" | Microsoft would not renew the grant or answered 401 | The member connects again; it is the same row |
| A meeting is missing from the list | No recording and no transcript, the member's calendar has more than 200 events in the 14 days (the read stops there), not scheduled, someone else organized it and it has no transcript, older than 14 days, or the recording was deleted | Nothing in Ludy to fix; the list cannot tell which |
| Import fails with "no audio" | A Teams recording is video and the media sandbox is not running | Run `crove-media` |
| Redirect URI mismatch (`AADSTS50011`) | The redirect URI of the app registration is not exactly `APP_URL/meetings/oauth/microsoft_teams/callback` | Fix it in Entra |

## What is not built yet

- A Teams recording is a video file, and the database still refuses to start an import of a recording that has no audio file (`MEETING_PLATFORM_NO_AUDIO`, the second half of [#3306](https://github.com/DOS/Ludy/issues/3306)); the app still shows such a recording as "video only, cannot be imported yet". Until that lands a Teams recording is listed and can be connected, but not imported. The same holds for Google Meet.
- The transcript-only import path (a Teams transcript without its recording) is not wired for any platform yet.
