<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Runbook: publish the Ludy extension to the Chrome Web Store

How the owner publishes the Ludy browser extension (`apps/extension`, Manifest V3, Chrome and Edge) to the Chrome Web Store, and how every later release follows (issue #2584, step M10 of [the meetings plan](../plan/meetings.md); the extension's threat model is plan section 5.7, the decision is [ADR-0047](../adr/0047-meeting-notes-audio-and-transcripts.md) point 10).

This is a production-adjacent step with an account and a listing, so no team lead or worker runs it ([contributing](../contributing.md#production-secret-and-credential-steps)). The owner holds the store developer account; an agent holds no store credential. This runbook names accounts and settings by reference and never holds a password, a key or a token.

**What was and was not verified when this was written.** Everything about the extension (permissions, what it sends, where it keeps data, how it is built) is read from the code at the time of writing and is cited. Everything about the store (form fields, image sizes, review times, fees, policy names) is general knowledge of the store and was **not** checked against its current documentation in the session that wrote this: read each store-side item against the developer dashboard and the store's own policy pages before submitting, and correct this file in the same PR if one differs. The listing texts and the privacy answers are drafts for the owner to approve; the privacy answers are also a declaration the owner makes to the store, so the lawyer (#62, #2585) should see them first.

## What the owner needs (before anything else)

| # | Item | Who | Note |
|---|---|---|---|
| 1 | A Google account for the developer account, ideally a shared role mailbox of the org that publishes Ludy, not a person's own address | owner | The account owns the listing and receives every review and policy email. Two-step verification on |
| 2 | The one-time developer registration fee | owner | Paid by the owner on the dashboard. New spending: the owner decides |
| 3 | Verified contact email and, where the store asks, the publisher's verified address and domain | owner | The listing shows the contact email |
| 4 | A public privacy policy page on an `https` address | owner, lawyer | The store requires a link. The drafts in [docs/legal](../legal/README.md) are not reviewed by a lawyer (#328): do not point the listing at an unreviewed draft. **The page exists (#3090):** `/privacy` on the marketing site (`apps/web`, Vietnamese by default and an English twin), served on every host that serves that app, so the listing uses `https://ludy.so/privacy` (the owner confirmed that ludy.so and ludy.vn point at the same project on 2026-11-13). It is a short page of its own, written from the section "Privacy practices" below, ADR-0047 and the meetings plan sections 8 and 9, not the unreviewed draft, and it says it is being reviewed. Its copy is `apps/web/src/content/privacy-vi.ts` and `privacy-en.ts`; its version and date are in `apps/web/src/content/site.ts` |
| 5 | The release to publish, built as in "Pre-submission checklist" | agent builds, owner uploads | The owner uploads the zip; nobody else needs the account |

## Known gaps before the first submission (status)

Each is a code or content item, not a credential, and has its own issue (P2, milestone M3, line `meetings`, each linked to #2584).

1. **Icons** (#3007, done): the package holds 16, 32, 48 and 128 pixel PNGs of the Ludy mark (`apps/extension/icons`, named by the manifest's `icons` and `action.default_icon`, copied by `scripts/build.mjs`, checked by `test/icons.test.ts`). The 128 pixel one keeps a transparent margin around the mark, as the store's icon guidance asks; upload that file as the listing's store icon too (take it from the built package, `dist/icons/icon-128.png`).
2. **The store's extension id is wired** (#3010, done: the owner uploaded the package on 2026-11-13 and the dashboard shows the id `emfhpcbmdbbeomfkdadbellllngmlhmf`). A Ludy server signs in only the extension ids it lists; the default list (`DEFAULT_EXTENSION_IDS`, `packages/kernel-contract/src/extension.ts`) now holds that id, so Ludy Cloud and every self-hosted server that updates accepts the store build with no setting, and refuses any other id. A server that sets `EXTENSION_IDS` uses only that list (add the store id to it to keep accepting the store build), and an unpacked or private build lists its own id there (`apps/extension/README.md`, `apps/kernel/src/config.ts`, #2740). Note: an item keeps its id for life; the id of a draft is already the final one.
3. **Release workflow** (#3009, done): a tag `ext-vX.Y.Z` on a commit of main runs `.github/workflows/extension-package.yml`, which builds the package as the CI job `extension` does, checks the built manifest against the fixed permission list, zips it with `manifest.json` at the root and attaches the zip and its SHA-256 to a GitHub release. It uploads nothing to the store and uses no secret; uploading stays the owner's step. A run by hand (`workflow_dispatch`, the version as input) is a dry run that keeps the zip as a workflow artifact for 7 days and creates no release.
4. **Languages** (#3008, done): the popup, the consent step, the microphone page and the toolbar title are English for an English browser (`en`, `en-US`, `en-GB`...) and Vietnamese for every other language, from one set of strings (`apps/extension/src/strings.ts`). The English consent wording is the app recorder's; the Vietnamese method labels are the extension's own short forms. The device name shown in Ludy under connected devices ("Tiện ích Ludy, Chrome trên Windows") stays Vietnamese.
   **The store listing is Vietnamese (default) plus English** (#3082): the manifest declares `default_locale: "vi"` and names its `name`, `description` and toolbar title as `__MSG_extName__`, `__MSG_extDescription__` and `__MSG_extActionTitle__`, with the texts in `apps/extension/_locales/vi/messages.json` and `_locales/en/messages.json`. The store offers a per-language listing only for a package that declares locales, so the dashboard's language list is expected to offer Vietnamese and English for this item (store behavior from general knowledge: confirm it in the dashboard). The build copies `_locales` into the package (so the zip holds `_locales/vi/messages.json` and `_locales/en/messages.json`), and `check:manifest` refuses a name, description or toolbar title that is not a message reference, a missing language or message, and a description over 132 characters. The English short description is "Record a browser meeting's tab audio and your microphone into Ludy, and upload it when you stop." (96 characters); the Vietnamese one is in `_locales/vi/messages.json` (88). The browser shows the one that matches its interface language and falls back to Vietnamese.
5. **The privacy policy page** (item 4 above; built in #3090 at `/privacy`) and its lawyer review (#328; the lawyer's review of the store answers is #2585). The lawyer reviews the privacy answers below and the page **before** the owner submits. The owner gave, through the Meetings PO on 2026-11-13, the operator's legal name in English ("DOS LTD", `PRIVACY_OPERATOR`) and the contact email for privacy requests (`PRIVACY_CONTACT_EMAIL`), both in `apps/web/src/content/site.ts`; the Vietnamese page uses the English name until the owner gives a Vietnamese registered name (one constant to change). The page shows no address, because none has been given, and names no transcription provider, because the Ludy Cloud one is not chosen (ADR-0047 Q5).

## Pre-submission checklist

Run in a clean checkout of the repository, as a person with commit and tag rights. Version numbers: the manifest accepts one to four dot-separated integers, each 0 to 65535, and the store accepts only a version higher than the last published one. This runbook uses `X.Y.Z` for the new one.

| # | Step | Check |
|---|---|---|
| C1 | Choose `X.Y.Z`, higher than the last published version (the dashboard shows it; the first submission has none). Set `"version"` in `apps/extension/package.json` to it in a pull request and merge it | `main` shows the version; `pnpm --filter @ludy/extension build` prints `Built the Ludy extension X.Y.Z` |
| C2 | The CI of the commit to release is green: the required check "Lint, typecheck, test", which passes only when the job "Browser extension (build, manifest permissions, Chromium)" did too (it builds, runs `check:manifest` against the fixed list of plan section 5.7, and loads the package in Chromium against a fake server) | the job's result on the commit's checks |
| C3 | The manual test of `apps/extension/README.md` ("Manual test: a 60-minute Google Meet in Chrome and Edge") has passed on this version, in both browsers, and its result is on the issue or the PR. CI cannot click the icon or answer the browser's prompts, so a person does this | the recorded result |
| C4 | Tag the commit and push the tag: `git tag ext-vX.Y.Z <commit>` and `git push origin ext-vX.Y.Z`. The tag must be on a commit of main, and its name is `ext-v` and one to four integers (each 0 to 65535, none with a leading zero). The workflow checks the ancestry, but a tag runs the workflow file of the tagged commit, so the real boundary is who may create `ext-v*` tags: the owner limits that in the repository's tag rules (settings), and C7 below is the last look | the workflow run `extension-package` starts for the tag |
| C5 | The workflow checks that the tag's version equals `apps/extension/package.json` (C1), that the required CI check "Lint, typecheck, test" succeeded on the commit (it waits up to 20 minutes; if that CI run was cancelled by a later merge, re-run it and then the workflow), installs with the frozen lockfile, builds with `--version X.Y.Z`, runs `check:manifest`, zips and hashes | the run is green; its summary shows the version and the SHA-256 |
| C6 | Download `ludy-extension-X.Y.Z.zip` and `ludy-extension-X.Y.Z.zip.sha256` from the GitHub release `Extension X.Y.Z` (it is not marked as the latest release). Check them: `sha256sum --check ludy-extension-X.Y.Z.zip.sha256`, and `unzip -l ludy-extension-X.Y.Z.zip` lists `manifest.json` at the top level and only `.js`, `.html`, `.css`, image and manifest files; no `node_modules`, no source maps, no `.ts` | the hash check says OK; the listing is as described |
| C7 | Re-read the permissions in the built manifest against "Permissions" below. A permission that is not in the table stops the release: it needs the security review and a changed `manifest-policy.ts` first | the two lists are the same |
| C8 | The hash is already in the release's notes and in the run's summary, so anyone can tell which build was uploaded. If the workflow cannot be used, build by hand in a clean checkout of the tag with `pnpm install --frozen-lockfile --filter "@ludy/extension..."`, `node apps/extension/scripts/build.mjs --version X.Y.Z`, `pnpm --filter @ludy/extension check:manifest` and `cd apps/extension/dist && zip -r ../ludy-extension-X.Y.Z.zip .`, and write the zip's SHA-256 on the issue | the hash is written down |
| C9 | Hand the zip to the owner by a channel the owner chooses. It holds no secret: it is the same code as the public repository | |

The package must hold no remote code (Manifest V3 forbids it, and the content security policy in `manifest.json` allows scripts from the package only); the build runs no bundler and the package has no runtime dependency.

## Permissions

The built manifest, and what each entry is for. These are the fixed list of `apps/extension/src/manifest-policy.ts`; CI fails when the manifest differs.

| Where | Entry | Used for |
|---|---|---|
| `permissions` | `storage` | Keeps, in the extension's own storage, the Ludy address, one connected account per org (the extension token, the org's name for the address bar, when the token ends) and which features the member turned on (`src/state.ts`). Recordings in progress are kept on the device until uploaded (the recorder's chunk store, `@ludy/meeting-recorder`) |
| `permissions` | `identity` | `chrome.identity.launchWebAuthFlow` only: opens the Ludy sign-in page in a browser window so the member signs in to Ludy and approves the extension for one org, without the extension ever seeing a password or the app's session (`src/popup.ts`, `src/auth.ts`) |
| `host_permissions` | `https://app.ludy.vn/*` | Calls from the extension to the Ludy Cloud address: sign-in code exchange, the list of features, creating the meeting, the upload (`src/api.ts`) |
| `optional_permissions` | `tabCapture` | Records the audio of the tab where the member clicks "Bắt đầu ghi", after the consent step. Asked only when the member turns on the meetings feature, and given back when they turn it off |
| `optional_permissions` | `offscreen` | Opens the offscreen document in which the tab's audio and the microphone are mixed and recorded (a Manifest V3 service worker cannot hold a media stream). Asked together with `tabCapture` |
| `optional_host_permissions` | `https://*/*`, `http://localhost/*` | Asked at run time for **one origin only**: the address a self-hosting member types at setup (their company's Ludy), or `localhost` for the `docker compose up` stack on their own machine. Never granted by default and never used for any site the member browses (the extension has no content script and reads no page) |

Not requested, by rule of plan section 5.7: `<all_urls>`, `tabs`, `activeTab`, `cookies`, `history`, `scripting`, content scripts, web accessible resources, `externally_connectable`, remote code.

## Single-purpose statement

For the store's "single purpose" field (the store wants one narrow purpose, stated plainly). Draft:

> Ludy records the audio (and, only when the member ticks it, the video) of a meeting that is open in the member's browser tab, together with their microphone, and uploads it to the member's own Ludy workspace as a meeting, after the member confirms the participants were told. Signing in to Ludy, choosing the workspace and turning meeting recording on or off exist only to serve that one purpose. The "starting soon" card, which fills in the meeting title from the member's own calendar (only when the member turned calendar reading on in Ludy), and the optional live notes, which send the audio to the same workspace while recording instead of only at the end, serve the same purpose and send nothing to any other address.

Check against the manifest's `description`, which is a message reference whose texts are in `apps/extension/_locales/<lang>/messages.json` (vi: "Ghi lại cuộc họp trên trình duyệt vào Ludy: ghi âm tab họp cùng micro, tải lên khi dừng."; en: "Record a browser meeting's tab audio and your microphone into Ludy, and upload it when you stop."), and keep the two aligned: the store compares them.

## Privacy practices (the dashboard's "Privacy practices" tab)

The tab asks for a justification of each permission, whether remote code is used, which user data is collected, and three certifications. Each answer below is justified from the code, and the rule is to declare honestly and on the side of more disclosure (Meetings PO decision, 2026-11-11): recorded audio and video are personal communications, so the categories that cover them are ticked, plus authentication information for the token. The lawyer (#2585) reviews the answers before submission, and the owner confirms them, because the form is a declaration.

### Permission justifications (paste each, in English; the store reads English)

| Permission | Justification |
|---|---|
| `storage` | Stores the member's Ludy address, their sign-in token for each workspace and which features they turned on, in the extension's own storage. Also holds a recording on the device until it has been uploaded, so a closed tab does not lose it. |
| `identity` | Opens the Ludy sign-in page in a browser window (`launchWebAuthFlow`) so the member can sign in and approve the extension. The extension never sees the member's password. |
| Host permission `https://app.ludy.vn/*` | The extension sends the member's recording and meeting details to the member's Ludy workspace at this address, and gets the list of features the workspace allows. It contacts no other address. |
| `tabCapture` (optional) | Records the audio of the meeting tab where the member clicked "Start recording", after they confirmed the consent notice. It is requested only when the member turns meeting recording on, and released when they turn it off. It never records another tab and never starts by itself. |
| `offscreen` (optional) | A Manifest V3 service worker cannot hold a media stream, so the recording and the mixing of the tab's audio with the microphone run in an offscreen document. Requested together with `tabCapture`. |
| Optional host permissions `https://*/*` and `http://localhost/*` | Only for companies that run Ludy on their own server: the member types their server's address and the browser asks for that single origin. It is never requested for a site the member visits, and the extension reads no web page. |

### Remote code

Answer **No, the extension does not use remote code.** All code ships in the package; the manifest's content security policy allows `script-src 'self'`; the build has no runtime dependency and `check:manifest` refuses a policy with `unsafe-eval`, `unsafe-inline` or an external address.

### Data collected (tick only what is true, and say why)

What the extension handles, from `src/api.ts`, `src/state.ts`, `src/auth.ts`, `src/consent.ts` and plan section 5.7:

| Store category | Tick? | Why |
|---|---|---|
| Authentication information | Yes | The extension token, kept in the extension's storage and sent to the member's Ludy address with each request. Its scope is one workspace, one member and the turned-on features; it expires after 90 days and the member can revoke it in Ludy |
| Personal communications | Yes | The audio of a meeting the member chooses to record, with their microphone, and the video only when they tick "Ghi cả video"; with "Ghi chú trực tiếp" ticked, pieces of the audio are sent while recording and not only at the end. The member confirms that participants were told before anything is recorded |
| Personally identifiable information | Yes | The meeting's name the member types, the title and time of the member's next calendar meetings (only when they turned calendar reading on in Ludy; shown in the popup, used to fill in the meeting title and not kept by the extension), and the voices (and, with video, the faces) of participants in the recording. The extension also sends a device name such as "Tiện ích Ludy, Chrome trên Windows" (browser and operating system, never an address or serial number) so the member can see and revoke the device in Ludy. It is also said in the popup's sign-in step, before the button (`signInDeviceNote` in `strings.ts`, #3273), so the disclosure is at the point of collection. Declared on the side of more disclosure (Meetings PO decision, 2026-11-11) |
| Website content | No | The extension reads no page content, no address, no title and no selected text. The generic page-capture contract exists in the code (`src/page-capture.ts`) but no feature uses it and the permissions it would need are not in the manifest |
| Web history, location, financial and payment information, health information, user activity | No | Not collected. No analytics, no telemetry, no advertising identifier (`apps/extension/src` has no such code; every request goes to the configured Ludy address) |

### The three certifications

The dashboard asks the publisher to certify that the data is (1) not sold to third parties outside the approved use cases, (2) not used or transferred for purposes unrelated to the item's single purpose, and (3) not used or transferred to determine creditworthiness or for lending. All three hold: recordings go only to the member's own Ludy workspace, the org controls retention and deletion in Ludy (plan section 9 and ADR-0047), and nothing is sold or used for credit decisions. The owner ticks them.

### Privacy policy link

The listing's privacy policy field takes the public page from "What the owner needs" item 4. That page has to describe, in plain words: the recording and who confirms consent, where the audio goes (the member's workspace and, when transcription is on, the provider that workspace chose), who can read it, how long it is kept, and how to ask for deletion.

## Store listing: drafts for the owner to approve

The owner edits these before submission. Limits are the store's, from general knowledge: confirm them in the dashboard (the short description is capped at 132 characters, the item name at 75).

### Name

`Ludy` (the manifest `name`; the store requires the listing name to match the product and not mislead). If `Ludy` is taken or too bare, `Ludy: ghi cuộc họp`.

### Category

Productivity (Năng suất). Language of the listing: Vietnamese as the default, English added.

### Short description

The listing's short description comes from the package's manifest `description`, one text per language (#3082), so change it in `apps/extension/_locales/<lang>/messages.json` and rebuild, not in the dashboard (confirm in the dashboard that the field is read-only):

- vi (88 characters): `Ghi lại cuộc họp trên trình duyệt vào Ludy: ghi âm tab họp cùng micro, tải lên khi dừng.`
- en (96 characters): `Record a browser meeting's tab audio and your microphone into Ludy, and upload it when you stop.`

### Long description

**vi**

```
Ludy là hệ điều hành doanh nghiệp mã nguồn mở cho cá nhân và doanh nghiệp nhỏ tại Việt Nam. Tiện ích này ghi lại cuộc họp trên trình duyệt (Google Meet, và Teams hoặc Zoom bản web) vào tổ chức Ludy của bạn.

Cách hoạt động
- Kết nối với Ludy Cloud hoặc với máy chủ Ludy của công ty bạn, rồi đăng nhập và chọn tổ chức. Tiện ích không bao giờ thấy mật khẩu của bạn.
- Bật "Ghi cuộc họp". Trình duyệt sẽ xin quyền ghi tab và micro, chỉ khi bạn bật tính năng này.
- Trước khi ghi, bạn phải xác nhận đã thông báo cho tất cả người tham gia rằng cuộc họp được ghi âm. Không có xác nhận thì không bắt đầu được.
- Khi ghi, biểu tượng hiện REC và đồng hồ chạy. Bản ghi được lưu trên máy bạn khi đang ghi, nên đóng tab nhầm không làm mất.
- Khi dừng, bản ghi được tải lên cuộc họp trong Ludy. Âm thanh được mã hóa khi lưu. Video chỉ được lưu khi bạn tích "Ghi cả video".
- Nếu bạn bật đọc lịch trong Ludy, thẻ "Sắp họp" hiện tối đa 5 cuộc họp trong 30 phút tới của bạn để điền sẵn tên khi bạn bấm "Ghi cuộc họp này"; Ludy không tự ghi gì.
- Nếu bạn tick "Ghi chú trực tiếp", âm thanh được gửi lên Ludy ngay trong lúc ghi (không đợi tới lúc dừng) để Vy ghi chú trong cuộc họp.
- Phiên bản tóm tắt, ghi lời và việc cần làm chạy trong Ludy và do người ghi duyệt; tiện ích chỉ ghi và tải lên.

Quyền riêng tư
- Tiện ích chỉ ghi tab bạn đang mở khi bấm "Bắt đầu ghi", không đọc nội dung trang nào khác, không có theo dõi hay quảng cáo.
- Mọi yêu cầu chỉ đi đến địa chỉ Ludy bạn đã cấu hình.
- Bạn có thể thu hồi tiện ích bất cứ lúc nào ở Cài đặt, mục thiết bị đã kết nối, trong Ludy.
- Mã nguồn mở theo giấy phép AGPL-3.0.

Cần có tài khoản Ludy và tổ chức đã bật tính năng cuộc họp. Giao diện của tiện ích bằng tiếng Anh nếu trình duyệt của bạn dùng tiếng Anh, và bằng tiếng Việt với mọi ngôn ngữ khác.
```

**en**

```
Ludy is the open-source business OS for one-person companies and small businesses in Vietnam. This extension records a meeting that is open in your browser (Google Meet, and the web versions of Teams or Zoom) into your Ludy workspace.

How it works
- Connect to Ludy Cloud, or to your company's own Ludy server, sign in and pick your workspace. The extension never sees your password.
- Turn on "Record meetings". The browser asks for permission to record the tab and your microphone, and only when you turn this feature on.
- Before recording, you must confirm that you told every participant the meeting is recorded. Without that confirmation it cannot start.
- While recording, the icon shows REC and a timer runs. The recording is kept on your device as it goes, so closing the tab by mistake does not lose it.
- When you stop, the recording is uploaded to the meeting in Ludy. Audio is encrypted when stored. Video is stored only if you tick "Record video too".
- If you turn on calendar reading in Ludy, a "Starting soon" card shows up to 5 meetings in your next 30 minutes so the title is filled in when you click "Record this meeting"; Ludy never records by itself.
- If you tick "Live notes", the audio is sent to Ludy while you record (not only when you stop) so Vy can take notes during the meeting.
- The summary, the transcript and the action items run inside Ludy and are reviewed by the person who recorded; the extension only records and uploads.

Privacy
- The extension records only the tab you have open when you click "Start recording"; it reads no other page, and it has no tracking or advertising.
- Every request goes only to the Ludy address you configured.
- You can revoke the extension at any time in Ludy under Settings, connected devices.
- Open source under the AGPL-3.0 licence.

Needs a Ludy account and a workspace with the meetings feature turned on. The extension's popup is in English or Vietnamese, following your browser's language.
```

### Screenshots to capture

A ready set (Vietnamese and English: three screenshots, the small tile and the marquee) is in [apps/extension/store](../../apps/extension/store/README.md), made by `apps/extension/scripts/store-art.mjs` from the real popup; regenerate it there when the popup changes. The table below is what a set made by hand should show.

The store takes up to five. Use a clean test workspace with no customer data and a short harmless meeting. Size: 1280 by 800 (or 640 by 400) pixels, PNG or JPEG without transparency; check the dashboard's current rule. Capture in Chrome at 100 percent zoom, with the popup open over a Google Meet tab and the person's name and face removed or a test account used.

| # | Screen | What it shows | Source |
|---|---|---|---|
| 1 | The popup after sign-in | The workspace picker and the "Ghi cuộc họp" feature with "Bật ghi cuộc họp" | `src/popup.ts`, `src/strings.ts` (`meetings`, `meetingsOn`) |
| 2 | The consent step | The notice, the three ways participants were told, and the confirmation box with the start button disabled until done | `src/consent.ts`, `consentTitle` |
| 3 | Recording | The popup with the timer, and the toolbar icon showing REC next to a Meet tab | the REC badge and timer of `src/background.ts` |
| 4 | Upload done | "Đã tải lên", and the meeting in Ludy with its audio player (a second window or a composite) | the meeting page of the app |
| 5 | Settings, connected devices in Ludy | The extension listed and the revoke button, to show the member stays in control | Ludy Settings |

Also needed by the dashboard (check): a **128 by 128 icon** (gap 1 above: `dist/icons/icon-128.png`), a **small promotional tile of 440 by 280** pixels, and optionally a marquee of 1400 by 560. The Edge Add-ons store has its own fields and may have its own image sizes: see "Microsoft Edge Add-ons (D2)" below (step E3).

### Data-use disclosures

The "Privacy practices" answers above are the data-use disclosures. Keep one rule: the listing text, the privacy policy page (`apps/web/src/content/privacy-vi.ts`, `privacy-en.ts`; bump `PRIVACY_VERSION` and `PRIVACY_UPDATED` in `site.ts`) and the dashboard answers say the same things. When one changes (a permission, a new feature, a new data type), change all three before submitting.

## Policy review 2026: what only a person can do (D1, #3180)

The written review is [the extension against the Chrome Web Store policy of 2026](../security/extension-store-policy-review-2026.md): a verdict and the evidence for each point, and what was fixed in the code and the drafts. It could **not** read the store's policy pages (the session has no route to `developer.chrome.com`), so these items are for the coordinator to hand to the owner. Do them before the first submission, and again before D2 (Edge) with Microsoft's pages.

| # | Item | Who | Check |
|---|---|---|---|
| P1 | Read the current store pages and correct the review in the same PR if one differs: the program policies, the user data policy (Limited Use, prominent disclosure, privacy policy rules), the listing and privacy-practices requirements, anything on `tabCapture` and audio, and the Chrome developer blog post on the 2026 policy changes (`cws-policy-updates-2026`). Write the date you read them at the top of the review | owner or the coordinator with access | the review names the date and any changed row |
| P2 | Prove on a real Chrome that the browser accepts `offscreen` together with `tabCapture` as **optional** permissions: step 3 of the manual test in [the extension README](../../apps/extension/README.md) ("the browser asks for tab capture" when "Bật ghi cuộc họp" is clicked). The e2e tests replace this prompt, so nothing automated has checked it. If Chrome refuses, `offscreen` has to move to `permissions` (a change of the fixed list in `manifest-policy.ts`, so the security review first) | a person, with Chrome | the result is on the issue or the PR |
| P3 | Paste the updated texts into the dashboard: the single-purpose statement, the vi and en long descriptions and the "why" of the two data categories in "Privacy practices" (all above, corrected in D1: the calendar card and live notes). The permission justifications above did not change (no permission was added) | owner | the dashboard shows the new text |
| P4 | Show the lawyer (#2585, #328) the privacy page **version 1.1** (calendar reading for Google and Outlook, live notes) before submitting. The page's effective date is 2026-11-15, the day of the change: move it in `site.ts`, `privacy-vi.ts` and `privacy-en.ts` if the deploy is later. If the store policy asks for an explicit Limited Use statement (P1), the lawyer decides the sentence; a proposal: "Ludy's use of information received through the extension adheres to the Chrome Web Store User Data Policy, including the Limited Use requirements." It was not added to the live page because it is a legal commitment | owner, lawyer | the lawyer's answer is on #2585 |
| P5 | Fill the dashboard's **test instructions** for the store's reviewer: a test Ludy workspace (Ludy Cloud) with the `meetings` module on, a test account and its sign-in, and how to reach the consent step and the recording; a reviewer cannot judge an extension that needs an account without one. No real customer data. The credentials go only into the dashboard field, never into the repository | owner | the field is filled |
| P6 | Upload the regenerated screenshots 1 (`apps/extension/store/vi-1-…` and `en-1-…`: the popup note now says where the recording goes) | owner | the listing shows the new images |
| P7 | Re-enter the "Privacy practices" answers and the three certifications from this runbook, as a declaration the owner makes; the dashboard is the place the store reads them | owner | the tab is saved |
| P8 | Edge (D2): read Microsoft's Edge Add-ons policies and listing fields, and whether a Chrome package with `tabCapture` is accepted unchanged; none of that was read for D1 or D2 | owner or coordinator | step E1 of "Microsoft Edge Add-ons" below, which names what was read |

## Microsoft Edge Add-ons (D2, #3181)

How the same extension reaches the Edge Add-ons store, what is the same as Chrome, the one step that needs a code change, and what only a person can do. The plan is [section 7 of the integrations plan](../plan/meetings-integrations.md); the Chrome side is everything above.

**What was and was not read.** Microsoft's own pages could **not** be read: the session that wrote this section has no route to `learn.microsoft.com` (the name does not resolve: it is outside the session's allowed network domains), and no other route was tried (no mirror, no search summary, no cache). Every Edge store fact below is marked **[unverified]**: it is general knowledge of the store from before this session, or a statement of what the plan says is still to be re-checked. What is said about the extension (the package, the permissions, the code) was read in this repository and is cited. Item E1 below is a person's re-read of Microsoft's pages, and any row it contradicts is corrected in the same PR.

### What is the same, and what the repository already does for Edge

- **One package for both stores.** The release workflow (`.github/workflows/extension-package.yml`) builds one Manifest V3 zip, `manifest.json` at its root, checked against the fixed permission list, with its SHA-256. Nothing in it is Chrome-only: the manifest (`apps/extension/manifest.json`) uses the `chrome.*` namespace, `identity`, `storage`, optional `tabCapture` and `offscreen`, and no Chrome-store-specific key. **No separate Edge zip is made**, and the workflow is unchanged: the same `ludy-extension-X.Y.Z.zip` from the GitHub release is uploaded to both stores, and its hash is written down once. *That Edge Add-ons accepts a Chrome Manifest V3 package unchanged is [unverified] (E1).* If Microsoft's checks reject a manifest key, the change is in `apps/extension/scripts/build.mjs` (an option for an Edge build) and in the workflow (a second zip), which is a protected path: a PR for the Meetings PO's review, not an edit on the side. The fixed permission list does not change for Edge.
- **The code names Edge where it matters:** the device name shown in Ludy's connected devices says "Edge" for an Edge browser (`apps/extension/src/auth.ts:53`, the user agent contains `Edg/`); the README and the privacy page already say "Chrome and Edge"; the manual test of the README is written for both browsers.
- **The sign-in assumes the redirect address `https://<32 letters a to p>.chromiumapp.org/…`** from `chrome.identity.getRedirectURL()` (`apps/app/src/lib/extension-connect.ts:12` accepts only that shape, and `packages/kernel-contract/src/extension.ts` says "Chrome and Edge give an extension this redirect address"). That Edge gives the same shape is **[unverified]**; the manual test below checks it first, because if Edge gives another host the sign-in cannot work and needs a code change.

### The one step that needs a code change: the Edge extension id

A Ludy server signs in only the extension ids it lists (`DEFAULT_EXTENSION_IDS` in `packages/kernel-contract/src/extension.ts`, or the server's `EXTENSION_IDS`). The list holds the **Chrome** store id only (#3010). **The Edge Add-ons item will have its own id** (assigned by Microsoft when the draft is created: [unverified], but the same is true of any second store), so **Ludy Cloud refuses the Edge store build at sign-in ("the request is not valid") until that id is added.** This cannot be done ahead: the id does not exist before the owner creates the item (E3). When the owner has it (E5), the coordinator opens a one-line PR, as #3010 did: add the id to `DEFAULT_EXTENSION_IDS` and to the test that pins it. An unpacked Edge build (Load unpacked) has yet another id (shown at `edge://extensions`); a test server lists it in `EXTENSION_IDS`.

### What only a person can do

| # | Step | Who | Check |
|---|---|---|---|
| E1 | Read Microsoft's pages and mark each **[unverified]** fact of this section verified or corrected in the same PR: the Edge Add-ons developer policies; the listing and privacy requirements; the review time; **whether a Chrome Manifest V3 package with `tabCapture` and `offscreen` is accepted unchanged** (and whether the manifest key `minimum_chrome_version`, which the package sets to 116, is accepted or Edge wants its own); whether Edge asks for extra justification for `tabCapture`; whether publishing by API is offered; the registration cost and any identity check. Write the date you read them | owner or the coordinator with access to the pages | this section names the date and what changed |
| E2 | Register a Microsoft Partner Center developer account for Edge Add-ons (D-OA1): a role mailbox of the org that publishes Ludy as the account owner, two-step verification on, the registration cost (**new spending: the owner decides**) and any identity check [unverified] | owner | the account exists; nothing about it is written in the repository |
| E3 | Create the extension in Partner Center and upload the **same zip** as Chrome (take it from the GitHub release, check `sha256sum --check` as in C6). Fill the listing from "Store listing" above (Vietnamese default and English), the category, the privacy policy link `https://ludy.so/privacy`, the contact the owner chooses, and the images of `apps/extension/store/` (the Edge field list and image sizes are [unverified]: check them in Partner Center and regenerate with `scripts/store-art.mjs` if a size differs) | owner | the draft shows the manifest's name and version and no manifest error |
| E4 | Enter the permission justifications and the data-use answers of "Privacy practices" above (the same declaration as Chrome; the form's fields and wording are [unverified] and may differ) and the **notes for the certification team** the same way as P5 (a test workspace, a test account, how to reach the consent step; credentials only in the dashboard field, never in the repository) | owner (the lawyer sees the answers first, #2585) | every permission has a justification; the notes field is filled |
| E5 | Note the **Edge extension id** shown in Partner Center and send it to the coordinator, who adds it to `DEFAULT_EXTENSION_IDS` in a PR (above) before the first Edge install is tested against Ludy Cloud | owner, then the coordinator | the PR is merged; the id is public, not a secret |
| E6 | Run the manual Edge test below and put its result on #3181 (this is the issue's first acceptance item: a recorded test, both voices, the consent step first, the REC badge) | a person, with Edge | the result is on the issue |
| E7 | Submit for review, choosing manual publish so the owner decides the moment; watch the account's email for the result. An update is the same flow as "Updating the extension" with the same zip and a higher version (Partner Center's update step and whether it takes the same version rule as Chrome are [unverified]) | owner | "in review" or the store's own word for it |
| E8 | After approval, install from the Edge Add-ons page in a fresh Edge profile, sign in to a test workspace, record five minutes of a Meet, and put the result on #3181 | a person | the evidence is on the issue |

### The manual test on Edge

The 60-minute test of [the extension README](../../apps/extension/README.md) ("Manual test: a 60-minute Google Meet in Chrome and Edge") is the test; run it once in Edge, on Windows, macOS or Linux, with these additions:

1. **Install:** unzip the release zip (so what is tested is the package that will be uploaded) and load it at `edge://extensions` (Developer mode, Load unpacked); copy its id and list it in `EXTENSION_IDS` of the test server (or, after E5, install the store build).
2. **The redirect address first:** open the popup's service worker console at `edge://extensions` and run `chrome.identity.getRedirectURL()`; it must be `https://<32 letters a to p>.chromiumapp.org/`, the shape the Ludy sign-in accepts. If it is not, stop: the sign-in needs a code change and the rest cannot pass.
3. **Sign in and the device name:** the sign-in window opens and returns; in Ludy under connected devices the device reads "Tiện ích Ludy, Edge …" (`auth.ts:53`).
4. **The permission prompt (also settles P2 for Edge):** "Bật ghi cuộc họp" makes Edge ask for tab capture; allow. The microphone page opens; allow.
5. **The recording:** the consent step runs first and refuses an empty confirmation; the REC badge and the timer show; both voices arrive in the meeting's audio; the other person hears you; the other tab is not muted; lock and unlock the screen once; a stopped upload can be retried.
6. **Record the result** on #3181: Edge version, operating system, Meet, minutes recorded, and for each step pass or what happened. A step that fails on Edge and passes on Chrome is a bug to file (P2 line, `tooling`), not a reason to change the permission list.

### Why there is no Edge job in CI

The extension's e2e tests launch the browser Playwright installs as `chromium` (`apps/extension/e2e/extension.spec.ts`: `channel: 'chromium'`, the new headless mode, the one headless mode that loads an unpacked extension), and the CI job installs only that (`pnpm --filter @ludy/extension exec playwright install --with-deps chromium` in `ci.yml`). An `msedge` channel would not be a drop-in: it needs Edge on the runner (whether the image has it was **not** checked here), a headed run, and a branded browser that still honours `--load-extension` (**[unverified]**: Chrome stable has stopped doing so, and Edge may follow). Installing a browser in CI changes `.github/workflows/`, a protected path, so it is not done here; the coordinator decides, with the Meetings PO, whether the manual test is enough or an Edge job is worth building. The same unverified list is why the e2e config was not given an Edge option.

## Submitting

| Step | Action | Check |
|---|---|---|
| S1 | Sign in to the Chrome Web Store developer dashboard with the developer account (owner, two-step verification on) | the dashboard opens |
| S2 | Add a new item and upload `ludy-extension-X.Y.Z.zip` | the dashboard shows the manifest's name and version, and no manifest error |
| S3 | Fill the listing from "Store listing" above, upload the images, set the language and category | the preview matches the drafts the owner approved |
| S4 | Fill the "Privacy practices" tab from above, link the privacy policy page | every permission has a justification; remote code is "No" |
| S5 | Distribution: for the **first** submission choose public, or "unlisted" first if the owner wants to test the store build with a few members before listing. Regions: all (the product is for Vietnam, but a narrower choice is also fine). Free | the choice is written on the issue |
| S6 | Note the item's **id** from the dashboard and send it to the coordinator for gap 2 (the id is not a secret) | the coordinator has it |
| S7 | Submit for review. Choose "publish automatically after approval" only if the owner wants it live at once; otherwise choose manual publish, so the owner decides the moment | the item shows "Pending review" |

## Review: what to expect and what to do

From general knowledge of the store, not checked here:

- A first review usually takes from a day to a few days. An item that asks for powerful permissions (`tabCapture` and broad optional host permissions are the likely triggers) or a change that adds a permission can wait longer, up to a few weeks in a bad case. The store emails the developer account's address with the result.
- Plan a release with room: the plan's risk list says a store review adds days to any fix (plan section 13). The in-app recorder and the upload keep working without the extension, so a stuck review does not stop recording.
- **If approved:** publish (if manual), then check the store page from a fresh Chrome profile and install it. Install it also in Edge from the same store page (Edge asks to allow extensions from another store). Sign in on a test server whose `EXTENSION_IDS` or default list holds the store id (gap 2): the connect page must accept it. Then close #2584's first acceptance item ("installable from the store") with that evidence.
- **If rejected:** the email names a policy and often the permission or the text at fault. Do not resubmit unchanged. Read the cited policy page, then fix the smallest thing that answers it:
  - a permission justification too vague: rewrite it from "Permissions" above and resubmit with the same package;
  - the optional host permission `https://*/*` objected to: **the planned response (Meetings PO decision, 2026-11-11) is a Cloud-only build**, not an open question. First reply on the dashboard with the justification (one origin, typed by the member, for self-hosting) and keep the first submission as it is. If the review still rejects it, release a store build whose manifest has `optional_host_permissions` of `http://localhost/*` only, or none, and serves Ludy Cloud only (`host_permissions` stays `https://app.ludy.vn/*`); self-hosters keep the unpacked build from the release zip and list its id in `EXTENSION_IDS`. That build changes `manifest-policy.ts` (its fixed list) and so needs the security review and a changed `check:manifest`; do it in a PR for that purpose, never by editing the manifest on the side. Do not widen or rename a permission to get past a review;
  - the single purpose or the listing text misleading: align the texts with the manifest `description` (`_locales`);
  - the privacy policy page missing or not matching: fix the page, not only the form.
  Keep each rejection email (without the account address) on the issue. An appeal goes through the dashboard's support form, from the owner's account, only when the owner believes the rejection is wrong; say what the extension does and cite the manifest.
- **If the item is taken down** for a policy reason after publishing, stop releasing, tell the coordinator, and treat it as an incident ([incidents](incidents.md)): the in-app recorder is the fallback.

## Updating the extension

Every later release repeats "Pre-submission checklist" (C1 to C9) with a higher version, then:

| Step | Action | Check |
|---|---|---|
| U1 | In the dashboard open the item, "Package", upload the new zip | the dashboard shows the new version |
| U2 | If the manifest's permissions or the data handled changed, update "Privacy practices", the listing and the privacy policy page in the same change. A new permission **disables the extension for existing users until they accept** the new permission, which is why the list is fixed, CI-checked and security-reviewed. Prefer no new permission in a minor release | the answers match the new manifest |
| U3 | Submit for review. A later release usually reviews faster than the first, but a new permission or a changed data answer can trigger a full review | "Pending review" |
| U4 | After approval and publication the browsers update the extension on their own, usually within hours. Verify from a profile with the previous version: `chrome://extensions` shows `X.Y.Z` after an update check | the version number |
| U5 | The store lets the publisher choose a staged percentage for an update: use a small percentage first for a release that changes capture behaviour, and raise it when no report comes in | the percentage on the dashboard |
| U6 | There is no rollback button. To undo a bad release, publish the last good code as a **new, higher** version, and say so in the release note. The store's review applies again | a higher version carries the good code |
| U7 | A fix for a security problem is the same flow with the review's delay in mind. If the problem is in the token or the server side, revoke tokens in Ludy (connected devices) while the review runs; the extension is only as dangerous as the token it holds (plan section 5.7) | |

A compromised release would run in members' browsers, so the controls are: the fixed permission list, no remote code, builds from a tagged commit, the owner's account with two-step verification and nobody else holding it, and the hash of each uploaded zip written down (C8).

## Reference

- Extension: [apps/extension/README.md](../../apps/extension/README.md), the manifest `apps/extension/manifest.json`, the permission list `apps/extension/src/manifest-policy.ts`.
- Plan: [meetings.md](../plan/meetings.md) sections 5.6, 5.7, 12 (what needs a person), 13 (risks) and the step list (M9, M10).
- Decision: [ADR-0047](../adr/0047-meeting-notes-audio-and-transcripts.md) point 10.
- Meetings AI on the server side: [meetings-ai.md](meetings-ai.md).
