# Ludy extension

The shared Ludy browser extension (Manifest V3, Chrome and Edge). Decision: [ADR-0047](../../docs/adr/0047-meeting-notes-audio-and-transcripts.md) point 10; plan: [meetings.md](../../docs/plan/meetings.md) sections 5.6, 5.7 and step M9. The store listing and publication are M10 and an owner action; nothing here publishes.

## What it is

- **Shell (Ludy Cloud locked for store builds, build-time overrides for self-hosters):** connects to Ludy Cloud across its split origins (`https://app.ludy.vn` for browser consent at `/-/extension/connect`, and `https://api.ludy.vn` for `/api/config`, token exchange, `/api/extension/me`, RPCs, and uploads; owner decision 2026-11-27, #1210, #5224). Sign-in uses PKCE in a normal browser tab (`connected.html` is web accessible to the App origin only), falling back to `chrome.identity.launchWebAuthFlow` if the tab cannot open (#4662). Includes an org picker (one token per org), features shown only when the org runs the module and the token holds the scope (`GET /api/extension/me`), and per-feature optional browser permissions released when turned off. Self-hosters build from source with `--origin <url>` or `--app-origin` / `--api-origin`.
- **Meetings feature:** consent step (title, how participants were told, explicit confirmation before Start is enabled, collapsible recording notice with vi/en copy), "Ghi cả video" off by default, "Ghi chú trực tiếp" off by default, tab capture in an offscreen document mixed with the microphone, a REC badge and timer, chunks saved on the device (`@ludy/meeting-recorder`), uploaded to the meeting on stop. AI off still records: the transcript and summary come from the meeting pipeline, never from the extension.
- **Notes feature:** Quick Capture (notes and personal to-dos) with zero extra browser permissions, plus an opt-in Web Clipper (`activeTab` and `scripting` requested only when toggled on, running solely on explicit click).
- **Languages and icons:** the popup is English for an English browser and Vietnamese for any other language (`src/strings.ts`, both sets in the package, chosen once from `chrome.i18n.getUILanguage()`). The manifest names the Ludy mark at 16, 32, 48 and 128 pixels (`icons/`, copied by `scripts/build.mjs`).
- **No dependency at runtime or in the package:** `chrome.*` is typed by hand (`src/chrome.d.ts`); `scripts/build.mjs` strips the TypeScript types with Node and copies one workspace package. No remote code.

## Permissions (fixed list, `src/manifest-policy.ts`)

| Where | Entries |
|---|---|
| `permissions` | `storage`, `identity` |
| `host_permissions` | `https://api.ludy.vn/*` |
| `optional_permissions` | `tabCapture`, `offscreen`, `activeTab`, `scripting` (asked only when Meetings or Web Clipper is turned on) |
| `web_accessible_resources` | `connected.html` for `https://app.ludy.vn/*` only |

Never `optional_host_permissions`, `<all_urls>`, `tabs`, `cookies`, `history`, background content scripts, `externally_connectable`, `update_url`, `declarative_net_request`, or `sandbox`. CI (`extension` job) builds the package and fails if the built manifest differs from this list.

## Commands

```
pnpm --filter @ludy/extension build                                       # dist/, the Ludy Cloud store package
pnpm --filter @ludy/extension check:manifest                              # dist/manifest.json against the fixed list
pnpm --filter @ludy/extension test:e2e                                    # unpacked in Chromium, fake servers, fake media
node apps/extension/scripts/build.mjs --version 1.2.3                     # a release build by hand; CI does it for a tag ext-v1.2.3 (.github/workflows/extension-package.yml)
node apps/extension/scripts/build.mjs --origin https://ludy.congty.vn     # single-origin self-host build
node apps/extension/scripts/build.mjs --app-origin https://app.congty.vn --api-origin https://api.congty.vn --out ./my-dist
```

A Ludy server signs in only the extension ids it lists: the Chrome Web Store build's id by default (`DEFAULT_EXTENSION_IDS`, #3010), or only the ids in its `EXTENSION_IDS` setting when that is set (#2740), so a server that sets it lists the store id too if it wants the store build. An unpacked or custom-built extension has its own id (shown at `chrome://extensions`), so list it in `EXTENSION_IDS` on the server it connects to, or the sign-in window says the request is not valid.

Load `dist/` through `chrome://extensions` (Developer mode, Load unpacked) or `edge://extensions`. Locally, `CHROMIUM_PATH=/path/to/chrome pnpm --filter @ludy/extension test:e2e` uses a browser installed elsewhere.

## Manual test: a 60-minute Google Meet in Chrome and Edge

Automation cannot click the extension icon or answer the browser's permission prompts, so this needs a person. It is not done by CI; record the result in the PR or issue.

Setup: Ludy Cloud (or a self-hosted build from `--origin` / `--app-origin` + `--api-origin`) with the `meetings` module on and the `meetings` extension scope; a second person (or a second device) to talk from the other side of the call. Run once in Chrome and once in Edge.

1. Load `dist/` unpacked. Open the popup. Click "Đăng nhập Ludy" and approve the org in the `/-/extension/connect` tab (which closes itself via `connected.html`).
2. With `meetings` off in the org: the popup lists no meetings feature. Turn it on in the org, reopen the popup: it shows. The browser asked for nothing yet.
3. Click "Bật ghi cuộc họp": the browser asks for tab capture; a tab opens for the microphone prompt; allow.
4. Join a Google Meet with the second person. Click the Ludy icon on the Meet tab. Without the consent steps the "Bắt đầu ghi" button must stay disabled (title, method, confirmation each). Complete them. Leave "Ghi cả video" unticked.
5. Start. Check: the badge shows REC and the timer runs; you still hear the other person; the other person hears you normally; the tab is not muted.
6. Talk from both sides for 60 minutes (read a script, alternate speakers). Switch to other tabs, lock and unlock the screen once, and open/close the popup twice: the REC badge must stay.
7. Stop from the popup. Check: "Đã tải lên", the badge clears, and the meeting appears in Ludy with both voices in the audio and, after processing, in the transcript. No video file exists for the meeting.
8. Repeat for 5 minutes with "Ghi cả video" ticked: the video arrives with the meeting.
9. Disconnect the network during a recording and stop: the upload fails, "Bản ghi còn trên máy này" lists it; reconnect and "Tải lên lại" uploads it; the device copy disappears.
10. Open the browser's network log for the extension's service worker and offscreen pages: every API request goes to the configured API origin (`https://api.ludy.vn` on Ludy Cloud, plus the granted storage origin when `STORAGE=s3`), and never to `app.ludy.vn`.
11. In Ludy, Settings, connected devices: the extension is listed; revoke it; the popup's next action asks to sign in again.

Pass: all steps hold in both browsers, and the 60-minute recording has both voices throughout.

## Known limits

- Real-world capture length, tab-capture behaviour on Meet, Teams and Zoom in the browser, and Edge behaviour are untested by CI. There is no Edge job in CI on purpose (the e2e tests load the package in Playwright's Chromium, and an Edge channel is not a drop-in): Edge is covered by the manual test above, with the Edge additions in [the store runbook](../../docs/runbooks/extension-store.md#microsoft-edge-add-ons-d2-3181).
- **The Edge Add-ons build has its own extension id**, which a Ludy server must list (`DEFAULT_EXTENSION_IDS`, or `EXTENSION_IDS`), or its sign-in is refused; the id exists only once the owner creates the Edge item (runbook step E5). The same release zip is uploaded to both stores.
- With object storage (`STORAGE=s3`) the upload goes to the storage address the Ludy server grants. The bucket's CORS must allow the extension's origin (`chrome-extension://<id>`), or the upload fails and the recording stays on the device for a retry.
- The devices are opened before the meeting is created, so a refused device leaves no meeting; if the recorder fails to start after the meeting exists, that meeting stays empty, because the extension token cannot delete a meeting.
