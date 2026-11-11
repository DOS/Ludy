# Ludy extension

The shared Ludy browser extension (Manifest V3, Chrome and Edge). Decision: [ADR-0047](../../docs/adr/0047-meeting-notes-audio-and-transcripts.md) point 10; plan: [meetings.md](../../docs/plan/meetings.md) sections 5.6, 5.7 and step M9. The store listing and publication are M10 and an owner action; nothing here publishes.

## What it is

- **Shell:** setup for `app.ludy.vn` or a self-hosted address (asked as an optional host permission for that one origin), sign-in through the app's `/-/extension/connect` page with PKCE (`chrome.identity.launchWebAuthFlow`), an org picker (one token per org), features shown only when the org runs the module and the token holds the scope (`GET /api/extension/me`), and a permission request per feature, given back when turned off.
- **Meetings feature:** consent step (name, how participants were told, a confirmation), "Ghi cả video" off by default, tab capture in an offscreen document mixed with the microphone, a REC badge and timer, chunks saved on the device (the app recorder's chunk store, `@crove/meeting-recorder`), uploaded to the meeting on stop. AI off still records: the transcript and summary come from the meeting pipeline, never from the extension.
- **Languages and icons:** the popup is English for an English browser and Vietnamese for any other language (`src/strings.ts`, both sets in the package, chosen once from the browser's interface language, `chrome.i18n.getUILanguage()`). The manifest names the Ludy mark at 16, 32, 48 and 128 pixels (`icons/`, copied by `scripts/build.mjs`).
- **Page capture:** `src/page-capture.ts` defines the generic "capture this page to one command, on a click" contract of plan section 5.6. No feature uses it.
- **No dependency at runtime or in the package:** `chrome.*` is typed by hand (`src/chrome.d.ts`); `scripts/build.mjs` strips the TypeScript types with Node and copies one workspace package. No remote code.

## Permissions (fixed list, `src/manifest-policy.ts`)

| Where | Entries |
|---|---|
| `permissions` | `storage`, `identity` |
| `host_permissions` | `https://app.ludy.vn/*` |
| `optional_permissions` | `tabCapture`, `offscreen` (asked when meetings is turned on) |
| `optional_host_permissions` | `https://*/*`, `http://localhost/*` (only the one address the member types, on their click) |

Never `<all_urls>`, `tabs`, `cookies`, `history`, `activeTab`, content scripts or web accessible resources. CI (`extension` job) builds the package and fails if the built manifest differs from this list.

## Commands

```
pnpm --filter @crove/extension build                       # dist/, the unpacked package
pnpm --filter @crove/extension check:manifest              # dist/manifest.json against the fixed list
pnpm --filter @crove/extension test:e2e                    # unpacked in Chromium, fake server, fake media
node apps/extension/scripts/build.mjs --version 1.2.3      # a release build from a tag, e.g. extension-v1.2.3
```

A Ludy server signs in only the extension ids it lists: the store's id by default (not set until the store listing exists, so until then an unpacked build always needs its own), or the ids in its `EXTENSION_IDS` setting (#2740). An unpacked build has its own id (shown at `chrome://extensions`), so list it in `EXTENSION_IDS` on the server it connects to, or the sign-in window says the request is not valid.

Load `dist/` through `chrome://extensions` (Developer mode, Load unpacked) or `edge://extensions`. Locally, `CHROMIUM_PATH=/path/to/chrome pnpm --filter @crove/extension test:e2e` uses a browser installed elsewhere.

## Manual test: a 60-minute Google Meet in Chrome and Edge

Automation cannot click the extension icon or answer the browser's permission prompts, so this needs a person. It is not done by CI; record the result in the PR or issue.

Setup: a Ludy deployment with the `meetings` module on and the `meetings` extension scope; a second person (or a second device) to talk from the other side of the call. Run once in Chrome and once in Edge.

1. Load `dist/` unpacked. Open the popup. Choose Ludy Cloud or type the self-hosted address and accept the browser prompt for that one address. Sign in; approve the org in the window.
2. With `meetings` off in the org: the popup lists no meetings feature. Turn it on in the org, reopen the popup: it shows. The browser asked for nothing yet.
3. Click "Bật ghi cuộc họp": the browser asks for tab capture; a tab opens for the microphone prompt; allow.
4. Join a Google Meet with the second person. Click the Ludy icon on the Meet tab. Without the consent steps the "Bắt đầu ghi" button must refuse (name, method, confirmation each). Complete them. Leave "Ghi cả video" unticked.
5. Start. Check: the badge shows REC and the timer runs; you still hear the other person; the other person hears you normally; the tab is not muted.
6. Talk from both sides for 60 minutes (read a script, alternate speakers). Switch to other tabs, lock and unlock the screen once, and open/close the popup twice: the REC badge must stay.
7. Stop from the popup. Check: "Đã tải lên", the badge clears, and the meeting appears in Ludy with both voices in the audio and, after processing, in the transcript. No video file exists for the meeting.
8. Repeat for 5 minutes with "Ghi cả video" ticked: the video arrives with the meeting.
9. Disconnect the network during a recording and stop: the upload fails, "Bản ghi còn trên máy này" lists it; reconnect and "Tải lên lại" uploads it; the device copy disappears.
10. Open the browser's network log for the extension's service worker and offscreen pages: every request goes to the configured Ludy address (and, with S3 storage, to the one storage address the server granted for the upload).
11. In Ludy, Settings, connected devices: the extension is listed; revoke it; the popup's next action asks to sign in again.

Pass: all steps hold in both browsers, and the 60-minute recording has both voices throughout.

## Known limits

- Real-world capture length, tab-capture behaviour on Meet, Teams and Zoom in the browser, and Edge behaviour are untested by CI.
- With object storage (`STORAGE=s3`) the upload goes to the storage address the Ludy server grants. The bucket's CORS must allow the extension's origin (`chrome-extension://<id>`), or the upload fails and the recording stays on the device for a retry.
- The devices are opened before the meeting is created, so a refused device leaves no meeting; if the recorder fails to start after the meeting exists, that meeting stays empty, because the extension token cannot delete a meeting.
