<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Zoom cloud recordings in Ludy Meetings: set up and operate

A member connects their own Zoom account in Settings and Ludy then lists the cloud recordings Zoom finished, as suggestions. Nothing is downloaded until the member presses "Import" on the Meetings tab ([plan, section 6.3](../plan/meetings-integrations.md)). It is **off by default**: without the two settings below there is no Zoom button and no Zoom adapter.

> **Facts to re-check on the first live run.** This page and the code were written from Zoom's own API documentation and tested only against fixtures and a stub transport; no real Zoom account has been used yet. The scope names, the exact redirect rules and the file types are the facts to confirm against Zoom's current pages when the first self-hoster connects, and the result goes on [#3175](https://github.com/DOS/Ludy/issues/3175).

## What the operator does (once per deployment)

1. In the [Zoom App Marketplace](https://marketplace.zoom.us/) (Develop, Build App) create an **OAuth** app of the **User-managed** kind. A user-managed app reads only the recordings of the Zoom user who connected it. Do not use an account-level or Server-to-Server app: it could read every user's recordings, and a recording in Ludy belongs to the member who imported it.
2. Set the **Redirect URL for OAuth** to `APP_URL/meetings/oauth/zoom/callback` and add the same address to the app's allow list. `APP_URL` is the address of the web app (the same value the calendar connections use; see [split-app-api.md](split-app-api.md)), not the API's.
3. Give the app these scopes (granular names; Zoom's older "classic" names for the same read access also work): `cloud_recording:read:list_user_recordings`, `cloud_recording:read:list_recording_files` and `user:read:user`. The last one lets Ludy read the member's Zoom email address, which names the connection. Nothing that writes or deletes is asked for.
4. Put the app's Client ID and Client Secret in the settings of the API **and** the worker (the worker needs them to renew tokens): `ZOOM_OAUTH_CLIENT_ID` and `ZOOM_OAUTH_CLIENT_SECRET`. Set both or neither; the server refuses to start with one. `CREDENTIAL_KEY` must be set too ([credential-key.md](credential-key.md)), or the connect answers 503 before a member leaves for Zoom.
5. A private app in your own Zoom account needs no Zoom review and works for the people in that account at once. A public listing goes through Zoom's own review, which has no published length; that is the operator's choice and not needed for one company.

## What a member sees

- Settings, **Security** tab, card "Kết nối nền tảng họp" (Meeting platforms): a button "Kết nối Zoom" appears only where steps 1 to 4 are done. It opens Zoom's own permission screen; the member approves there and comes back to a page that says which account was connected.
- Ludy then lists the member's recordings of the last 14 days within a few minutes, and the member imports one with a click. The listing prefers the **audio-only** file Zoom makes. A recording that has only a video file imports only where the **media sandbox** (`crove-media`, `MEDIA_URL`) is running ([meetings-video-import.md](meetings-video-import.md)); without it that recording fails with "no audio". The Settings card says this in plain words.
- Zoom keeps **cloud recordings only on a paid plan**, and only if the host turned cloud recording on. A free account lists nothing. Recordings made in several segments (the host stopped and started the recording) are not offered until the segments can be joined.
- The member can disconnect in Settings at any time: Ludy forgets the access and deletes the list of suggestions. Meetings already imported stay. To also take the app away on Zoom's side the member removes it in Zoom (Marketplace, Manage, Added Apps).

## How the access is kept

- Zoom access tokens last about an hour, so the worker renews a token shortly before it expires (10 minutes ahead), under a row lock, and **saves the new refresh token Zoom rotates in** on every renewal. If Zoom will not renew the grant (the member removed the app, or the refresh token expired) the connection is marked expired and Settings says "connect again"; nothing else changes. See the plan's [6.1](../plan/meetings-integrations.md) for the renewal rules.
- The tokens are sealed with the credential key for the member's org, platform and account, and only the worker opens them. No screen, answer, log line or audit row carries a token, the code or Zoom's own words; an error is a short code.
- A connect attempt (the state) lasts 10 minutes, works once and only for the member who started it. The one-time code is exchanged before anything is stored, and a refused code uses the attempt up.
- The only hosts Ludy calls for Zoom are `zoom.us` and `api.zoom.us`; a recording file is downloaded only from `zoom.us` or one of its subdomains, and the member's token goes only to the first host of a download.

## When something fails

| What the member sees | Likely cause | What to do |
|---|---|---|
| Zoom says the redirect address is invalid | The Redirect URL in the Marketplace app is not exactly `APP_URL/meetings/oauth/zoom/callback`, or is not on the allow list | Fix it in the Marketplace app; no Ludy change |
| "The platform refused the code ... or did not give enough permission" (`OAUTH_CODE_REJECTED`) | The code was used or expired, the redirect address differs, the client secret is wrong, or the app lacks `user:read:user` | Check the app's scopes and the two settings, then connect again |
| "The platform is not answering" (`OAUTH_PROVIDER_FAILED`) | Zoom was unreachable or answered something unexpected | Try again; the log line names a short code, never a token |
| No "Kết nối Zoom" button | One of the two settings is missing, `CREDENTIAL_KEY` is not set, or the Meetings module is off | Check the settings of the API |
| "Connection expired: connect again" | Zoom would not renew the grant | The member connects again; it is the same row |
| The list stays empty | A free Zoom plan, cloud recording off, no recording in the last 14 days, or the files are still processing | Nothing in Ludy to fix |

## What is not built yet

Zoom's "recording completed" notification (the webhook that makes a suggestion appear at once instead of at the next listing) is a later step of #3175. Until then the listing runs about every 10 minutes and the member's "Refresh" button asks for one at the next pass.
