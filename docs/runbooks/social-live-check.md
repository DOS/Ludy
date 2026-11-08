<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Runbook: live check of Facebook Page and Zalo OA (Social)

Until now the Facebook Page and Zalo OA adapters (`packages/channel/src/meta.ts`, `zalo.ts`) ran only against recorded answers. This runbook takes a person with no coding background from nothing to one real post on a Facebook Page and one real article on a Zalo Official Account, read back on the platform, removed again, with the result of every step written down. It closes the live part of issue #236 (the developer apps of #591).

Public repository rule: no secret, app id, project ref, Page id, OA id, token or internal host appears in this file, in an issue, in a PR or in chat. Every value is named by where it comes from.

## Who does what

Every step carries a tag.

- **[PERSON]** only the owner (JOY) can do it: it needs their Facebook, Meta, Zalo or OA login, or it creates an app or a bucket under their name. Nobody else does it for them, and no agent signs in.
- **[PO]** the Social Product Owner session runs it, after JOY approved the concrete step list in the PO's chat (AGENTS.md, "Production, secret and credential steps"). This runbook is not that approval.
- **[CHECK]** what must be true before going on, and what to do if it is not.

Secrets (the two app secrets, the S3 keys) go from the platform's page into the `.env` file of the check stack on the machine where the stack runs, typed or pasted by the person at the keyboard. The agent never prints, reads back or pastes them into chat, an issue or a PR. The source of truth is the owner's password manager.

## Where the check runs, and why

**Decision: a throwaway stack from `docker compose up` on the machine of whoever runs the check (the PO's or JOY's), at `http://localhost:8080`, with its own database and no customer data.**

Why not the other places:

- **The pilot instance** runs `CROVE_MODULES=finance` (#2118): Social's routes, publish queues and worker do not exist there, and a design partner's books live in its database. Nothing here touches it, and Social is never switched on there for a test.
- **A public https test deployment** would have to pass the server's public-deployment checks (https `PUBLIC_URL`, a random JWT secret, no `AUTH_AUTOCONFIRM`, split api and worker roles, an export key; `pilot-readiness.md` section 1). That is the pilot layout again, with a second host and a tunnel to pay attention to. It stays the fallback for Zalo only (part B, step B2).
- **A local stack** keeps `PUBLIC_URL` on `localhost`, so those checks do not apply, `AUTH_AUTOCONFIRM` stays on (no mail setup), and `CROVE_MODULES` stays empty, which runs every module including Social with its workers. The OAuth redirect is the browser of the person at the keyboard going to the registered address, not a call from the platform to the server, so a local address can work.

Facebook needs nothing public: Ludy sends a photo to Facebook as an upload. Zalo is different: Zalo fetches every article image itself from a public https URL, so part B needs a small private S3 bucket (step B1).

What the local address leaves unproven (record it in the results table): whether Meta and Zalo accept `http://localhost` as a redirect address. Meta documents `Strict Mode` (exact match) and an "Enforce HTTPS" switch; whether localhost is exempt for an app in development was not confirmed from the docs. Zalo's docs could not be read from automation (JavaScript pages), so its rule for the callback address is unconfirmed too [U].

## What is verified in code before you start

On `main` (2026-11-01), against recorded answers; none of this proves the platforms' live behaviour, that is what the check is for.

| Path the check uses | Code | Tests that pass |
| --- | --- | --- |
| Start: single-use state, Meta dialog URL with the Page scopes | `apps/kernel/src/rpc.ts` (`channels.oauthStart`), `packages/channel/src/meta.ts` | `packages/channel/test/meta.test.ts`, `apps/kernel/test/channels.db.test.ts` |
| Meta callback: code to long-lived user token, every Page the user may post to with its Page token, sealed | `MetaLogin`, `FacebookPageConnector`, `oauthFinish` | same files |
| Facebook text post, photo post (photos uploaded unpublished, then one feed post), read back, removal | `FacebookPagePublisher` | `packages/channel/test/meta-publish.test.ts`, `apps/kernel/test/social-publish.db.test.ts` |
| Zalo: dialog with PKCE, code to token pair, OA name and id | `ZaloOaConnector` | `packages/channel/test/zalo.test.ts` |
| Zalo article with cover and extra images, `article/verify` until Zalo names the id, removal | `ZaloOaPublisher` | `zalo.test.ts` |
| Zalo single-use refresh: new pair sealed in the same transaction, a refused token expires the connection, one sweep at a time | `apps/kernel/src/channel-refresh.ts`, `ZaloOaRefresher` | `apps/kernel/test/channel-refresh.db.test.ts` |
| Publish pipeline: scheduled, written call row, one visible call, outcome recorded, paused on a refused token | `modules/social/src/publisher.ts` | `social-publish.db.test.ts` |
| Callback page in the app, which finishes the attempt | `apps/app/src/routes/social-oauth.tsx` | covered through the RPC tests above (no browser test of this page against a provider) |

Gaps found while reading, and what became of them:

- **Zalo needs a public image URL.** Before #2192 the only source of that URL was a presigned download, which exists only with `S3_PRESIGNED_URLS=true`, and the server refuses that on Cloudflare R2, so a Zalo (and Instagram, Threads) post with an image failed with `MEDIA_URL_UNAVAILABLE` there. #2192 gives the store a signed read for platforms that works with browser transfers off. It needs an https endpoint (a plain http MinIO is refused as unreachable for a platform) and is not offered on GCS. The check below still uses a plain S3 bucket, since that is the path with the fewest unknowns; an R2 bucket (`S3_PRESIGNED_URLS=false`, `S3_VERSIONING=off`) is a second run worth recording.
- **A Zalo article always needs a title, a body text and at least one image** (`zalo_oa` rules in `modules/social/src/domain/channels.ts`, `MEDIA_REQUIRED` and `TITLE_REQUIRED` in the adapter). So the Zalo "text post" of the check is an article with a title, text and a cover image, and the second article adds one more image after the text. Facebook has no such rule.
- **Facebook Page tokens are sealed with no expiry** (`expiresAt: null`) on the reading that a Page token from a long-lived user token has no timer. Meta's current Pages docs say Page tokens "have an expiration time" and the page on expiry could not be read, so this is unconfirmed [U]: step A9 records what Meta reports.
- **Meta's login model.** The connector uses classic Facebook Login with the permissions as `scope`. Meta also offers Facebook Login for Business, with a configuration id instead of `scope`, and says it requires a business-type app or a use case that supports it. If the dialog in step A4 refuses the `scope`, that is a finding to file, not something to work around live.

## Before you start

- **[PERSON]** A Facebook account that is an **administrator of the Page** to post on (full control, which carries the task `CREATE_CONTENT`). Use a test Page, not the shop's real Page, so a failed run shows nothing to customers.
- **[PERSON]** A Meta developer account at developers.facebook.com on that same Facebook account (the one that creates the app is its administrator).
- **[PERSON]** The Zalo account that is **administrator of the Zalo Official Account** (OA) to post on, and a Zalo developer account at developers.zalo.me. The OA must be able to publish articles: Zalo may require the OA to be verified, and may require the article permission to be requested and approved for the app before it works [U]. If the article permission needs Zalo's review, ask for it at once: it is the longest wait of the whole check.
- **[PERSON]** For part B: an AWS account, to make one small private S3 bucket (step B1).
- **[PO]** A checkout of `main` that is not the pilot's, with Docker, `pnpm` and Node as the README lists. Two image files for each part: a JPEG or PNG under 1 MB, easy to recognise (a plain picture saying "Ludy live check"). Zalo refuses an image over 1 MB.
- **[CHECK]** Nothing else listens on port 8080 of that machine. The redirect addresses below contain the port; a different port means a different registered address.

## Part A. Facebook Page

### A1. Create the Meta app

**[PERSON]** at developers.facebook.com, My Apps, Create app. The wizard changes; what matters is the result:

1. App name "Ludy live check" and the contact email.
2. The use case that gives Page publishing: "Manage everything on your Page" is what Meta's create-an-app page names as its example for Pages. It must offer `pages_show_list`, `pages_manage_posts` and `pages_read_engagement`. If the wizard asks for an app type, take the one that keeps Facebook Login available, and write down which it was.
3. Open the use case's Facebook Login settings. Under **Valid OAuth Redirect URIs** add exactly `http://localhost:8080/channels/oauth/facebook_page/callback`, no trailing slash. Keep Client OAuth Login and Web OAuth Login on.
4. Leave the app in **Development** mode. Do not publish it, do not start App Review, do not start Business Verification. In development mode the people with a role on the app (you, as administrator) can use the permissions on Pages they manage.

- **[CHECK]** The dashboard says Development mode, and the redirect address is listed exactly. If Meta refuses the `http://localhost` address (it may demand https), stop and tell the PO: the fallback is a public https address, which moves the stack to the pilot layout (see "Where the check runs").
- **Rollback:** delete the app in its settings.

### A2. Take the two values

**[PERSON]** In the app's Settings, Basic: the **App ID** (digits only) becomes `CHANNEL_META_APP_ID`; the **App secret** (press Show, it asks for the Facebook password) becomes `CHANNEL_META_APP_SECRET`. The server refuses to start with one of the two, and refuses an app id that is not digits.

- **[CHECK]** Both are in the password manager. Neither has been typed into chat.

### A3. Start the stack

**[PERSON]** or **[PO]** with the person at the keyboard, in the checkout of step "Before you start":

```bash
cp .env.example .env
```

Edit `.env` (it is git-ignored): set `CHANNEL_META_APP_ID` and `CHANNEL_META_APP_SECRET`; leave `PUBLIC_URL`, `CROVE_MODULES` and `STORAGE` as they are (empty, empty, `local`). `CHANNEL_SANDBOX=true` stays: the sandbox channel is a handy control.

```bash
docker compose -p social-check up --build -d
```

- **[CHECK]** `http://localhost:8080` loads. `curl -s http://localhost:8080/api/config` lists `facebook_page` under `channels.oauth` (Instagram appears next to it because it shares the Meta app; ignore it, it is out of scope here). If `facebook_page` is missing, both variables are not both set.
- **Rollback:** `docker compose -p social-check down -v` removes the stack and its database. Nothing else is touched.

### A4. Connect the Page

1. In the app, sign up (the local stack confirms accounts at once; the mail would be at http://localhost:8025), create an organization, so you are its owner. Only an owner or admin can connect a channel.
2. Open Social, Kênh (channels), Kết nối kênh, press **Kết nối Facebook Page**.
3. **[PERSON]** In Meta's dialog sign in, pick the test Page (only it), and accept every permission it lists. The dialog asks for `pages_show_list`, `pages_manage_posts`, `pages_read_engagement` and also `pages_manage_engagement` (optional: first comments only).
4. The browser comes back to `/channels/oauth/facebook_page/callback`, shows "Đang hoàn tất kết nối..." and then "Đã kết nối: <Page name>".

- **[CHECK]** The Page is listed under "Kênh đã kết nối" as active. Record: how long the dialog took, whether `pages_manage_engagement` was granted, any extra screen Meta added.
- **Rollback:** "Ngắt kết nối" on the channel removes the sealed token; revoke the app in Facebook, Settings, Business integrations.
- If it fails: "Nền tảng từ chối mã cấp quyền" is an `invalid_grant` (a used or expired code, or a redirect address that differs from the registered one); "Bạn chưa cấp đủ quyền" means a required permission was not granted; "Không có tài khoản nào bạn được quyền đăng bài" means the Facebook account has no `CREATE_CONTENT` task on a Page it picked. The server log has the line `[channels] OAuth exchange failed: <kind> (<Meta code>)`.

### A5. Publish a text post

1. Soạn bài (compose). Text for example "Ludy live check, text post, <date and time>". Select only the Facebook Page channel. No image.
2. Press **Duyệt và lên lịch** and pick a time two minutes ahead. The worker looks for due posts every 15 seconds.
3. Open the post's page and watch it go from "Đã lên lịch" to "Đang đăng" to "Đã đăng".

- **[CHECK]** The status is "Đã đăng" within a minute of the time, with a link. **[PERSON]** opens "Mở bài trên kênh" and sees the text on the test Page, once (not twice). Record the post's id from the link only as "ok", never the id itself.
- If the status is "Cần xử lý" or "Đăng lỗi", copy the code and the message the page shows, not a screenshot with tokens (there are none on screen): a Graph error code 190 or 102 is a dead token (`token_expired`), 10 or 200 to 299 a missing permission, 4, 17, 32, 613 a rate limit. A "possible duplicate" or "unknown" outcome is the pipeline refusing to guess: do not press retry before looking at the Page.

### A6. Publish a post with an image

Compose again with text and one JPEG or PNG under 4 MB (Ludy's rule for Page photos), for the Facebook Page only, scheduled two minutes ahead.

- **[CHECK]** Posted once, the photo shows on the Page with the text. Record how long the photo took to appear.

### A7. Read back

**[PERSON]** On the Page itself (facebook.com, in the Page's feed), confirm both posts exist, with the text and the photo, from the app named "Ludy live check". In Ludy, "Số liệu" (metrics) may show reactions after a few minutes; an empty reading is fine, a refused one (permission) is a finding.

### A8. Remove both posts

In the post's page choose **Gỡ khỏi kênh**, then **Gỡ bài**, for each post.

- **[CHECK]** Both are gone from the Page. Record the answer: a removal Meta refuses is shown as `FACEBOOK_CANNOT_DELETE`, in which case **[PERSON]** deletes the post on Facebook and the finding is filed.

### A9. Does the Page token live on

Tokens are sealed and never shown, so Meta's token debugger cannot be used on them. Instead, at least one hour after A4 (and again the next day if the apps are kept), publish one more text post as in A5.

- **[CHECK]** It goes out. Record "Page token alive after N hours". This does not prove the token is permanent; if Meta refuses it later the connection turns "Cần kết nối lại" and its posts pause (nothing is lost).

## Part B. Zalo OA

### B1. A small private S3 bucket for the images

Zalo fetches the cover and every image by URL. Ludy makes that URL as a presigned download, valid for about a minute, so the bucket stays private. The signed read needs an https endpoint to the bucket, which AWS S3 has by default (on R2 it needs #2192).

**[PERSON]** in the AWS console:

1. Create a bucket in any region (for example Singapore), **Block all public access left on**, **Bucket Versioning enabled** (Ludy refuses an unversioned bucket unless `S3_VERSIONING=off`).
2. Under the bucket's Permissions, CORS, add a rule that allows the origin `http://localhost:8080`, methods `GET` and `POST`, any header. Browser uploads go straight to the bucket and fail without it.
3. Create one IAM user for this check with a policy limited to that bucket (list, get, put, delete objects and object versions), and make an access key for it.

Settings for `.env`: `STORAGE=s3`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_PRESIGNED_URLS=true` (the default), and leave `S3_ENDPOINT` and `S3_FORCE_PATH_STYLE` empty and false for AWS. The keys come from the password manager.

- **[CHECK]** After restarting (B4), upload a picture in the composer: it appears in the library. A refused upload with a network or CORS error is the CORS rule.
- **Rollback:** empty and delete the bucket (all versions) and the IAM user after the check.

### B2. Create the Zalo app and link it to the OA

**[PERSON]** at developers.zalo.me, with the account that administers the OA. The console's wording may differ; the result is:

1. Create an application ("Tạo ứng dụng"), name "Ludy live check". Add the **Official Account** product and link the app to the OA to post on (the OA's admin confirms the link).
2. Register the callback address `http://localhost:8080/channels/oauth/zalo_oa/callback` exactly. Per Zalo guides found secondhand it is entered in the OA settings of the app (the "Callback Url" of the Official Account section) and needs saving [U].
3. Turn on the permission to manage articles for the app ("quản lý bài viết" or similar), and submit it for review if Zalo asks [U].
4. Note the **App ID** (digits only) as `CHANNEL_ZALO_APP_ID` and the **App secret** as `CHANNEL_ZALO_APP_SECRET`.

- **[CHECK]** The console accepted a `http://localhost` callback. **If it refused it** (it may demand a domain or https), stop and tell the PO. The fallback is a public https hostname that reaches this machine (a tunnel the PO starts with JOY's approval), used as `PUBLIC_URL`, which then makes the server demand the whole pilot layout and settings of `pilot-readiness.md` section 1 (random secrets, no auto-confirm, api and worker split, an export key). That stack runs on its own database with no real data, and it must be a second stack, never the pilot instance. Zalo's redirect is the browser of the person at the keyboard, so only that person's machine needs to reach the hostname.
- **Rollback:** remove the callback address or delete the app.

### B3. Give the server the Zalo app

**[PERSON]** adds `CHANNEL_ZALO_APP_ID` and `CHANNEL_ZALO_APP_SECRET` to `.env` (both or neither: the server refuses to start with one), together with the S3 settings of B1.

### B4. Restart

```bash
docker compose -p social-check up -d
```

- **[CHECK]** `curl -s http://localhost:8080/api/config` lists `zalo_oa` under `channels.oauth`, and `facebook_page` still. "Kết nối Zalo OA" shows on the Kênh page.

### B5. Connect the OA

Kênh, **Kết nối Zalo OA**. **[PERSON]** the OA administrator signs in to Zalo and grants the app. The browser returns to `/channels/oauth/zalo_oa/callback` and the app says "Đã kết nối: <OA name>".

- **[CHECK]** The OA is active in the list. Record whether the OA name shown is right, and how long the grant took.
- If it fails: `invalid_grant` ("Nền tảng từ chối mã cấp quyền") is any refusal of the code by Zalo's token endpoint below a 500; "Bạn chưa cấp đủ quyền" is a refusal of the OA profile call (`oa/getoa`), which usually means the app was not granted the OA or the OA is not allowed to use the API. Keep Zalo's error code from the server log line `[channels] OAuth exchange failed: <kind> (<code>)`. Zalo's DPoP debugger appears in its developer tools: if Zalo now demands DPoP-bound tokens, the token endpoint will refuse the connector's plain request and that is a finding, not something to patch live [U].

### B6. Publish an article with a cover

Soạn bài for Zalo OA only. A title (up to 150 characters), a body text, and **one** JPEG or PNG under 1 MB as the first image: it is the cover. Leave comments on ("Cho phép bình luận"). Schedule it two minutes ahead.

- **[CHECK]** The post goes "Đang đăng" (Zalo creates articles asynchronously: the app asks Zalo again every 20 seconds until it names the article) and then "Đã đăng". **[PERSON]** finds the article in the OA's article list (Zalo OA manager, Bài viết) with the title, text and cover. Record how long Zalo took.
- Errors the adapter maps: -216, -220, -124, -118 are a dead access token; -32 a rate limit; `MEDIA_URL_UNAVAILABLE` means no signed URL (storage is not S3 on an https endpoint, or the file could not be read back, B1); `IMAGE_TOO_LARGE` a file over 1 MB; `TITLE_REQUIRED` a missing title. Any other negative code is shown on the post with Zalo's message: copy it into the results.

### B7. Publish an article with two images

Same as B6 with a second image: the first is the cover, the second follows the text as an image block with its description as caption.

- **[CHECK]** The article shows the cover on top and the second image after the text, once.

### B8. The single-use refresh

Zalo's access token lasts about 25 hours, and each refresh returns a new refresh token while the old one dies. The worker refreshes a token that expires within 6 hours, scanning every 10 minutes, so the first natural refresh comes about 19 hours after connecting. To see it now, **[PO]** moves that connection's expiry on the throwaway database of this stack (never on any other):

```bash
docker compose -p social-check exec db psql -U postgres -d postgres -c "UPDATE crove_kernel.channel_connection SET expires_at = now() + interval '30 minutes' WHERE provider = 'zalo_oa' AND status = 'active'"
```

Wait 10 to 15 minutes (the sweep interval), then read the connection back:

```bash
docker compose -p social-check exec db psql -U postgres -d postgres -c "SELECT status, expires_at FROM crove_kernel.channel_connection WHERE provider = 'zalo_oa'"
```

Then publish one more article (B6 again).

- **[CHECK]** The status is `active`, `expires_at` is about 25 hours ahead (it was moved to 30 minutes ahead), and the new article goes out: Zalo issued a new token pair, Ludy sealed it, and the old refresh token was not needed again. The worker log (`docker compose -p social-check logs worker`) has no `[channel-refresh]` error line.
- If the status is `expired`, Zalo refused the refresh token (`-14020`, `-14014` or a message naming a refresh token): record the code, and reconnect the OA to carry on. If it is still `active` with the old expiry, the sweep did not run: check the worker is up.
- Run the SQL once. A refresh token is single use, so never repeat it while a refresh may be running.

### B9. Read back and remove

**[PERSON]** confirms the articles in the OA manager. In Ludy, **Gỡ khỏi kênh**, **Gỡ bài** for each. Record what Zalo answers for a removal (the adapter counts `-201` on both `article/remove` and `article/getdetail` as "already gone", which is unconfirmed live), and whether the article is gone from the OA manager. A refusal is shown as `ZALO_CANNOT_REMOVE` and **[PERSON]** deletes it by hand.

## Results to record

**[PO]** copies this table into a comment on #236 after the run, filled in. No ids, tokens or URLs of the posts: write ok, failed, or the error code and message.

| Step | Result | Time taken | What differed from the docs or this runbook |
| --- | --- | --- | --- |
| A1 Meta app (type, use case, redirect `http://localhost` accepted) | | | |
| A4 Connect Page (permissions granted, `pages_manage_engagement`) | | | |
| A5 Text post | | | |
| A6 Photo post | | | |
| A7 Read back (post and metrics) | | | |
| A8 Remove | | | |
| A9 Page token alive after N hours | | | |
| B2 Zalo app (callback `http://localhost` accepted, article permission review) | | | |
| B5 Connect OA | | | |
| B6 Article with cover | | | |
| B7 Article with two images | | | |
| B8 Refresh: new pair, article after it | | | |
| B9 Remove | | | |

Then **[PO]** writes each difference into `docs/plan/social.md` sections 4 and 6, and fixes or files it (P2, milestone Social, labels `line:social-management` and `social`). The live questions on takedown codes are already filed in #1467 (answered by A8 and B9).

## When something goes wrong

- **The connect button is missing.** The app id and secret of that platform are both set in `.env`, the stack was restarted with `up -d`, and the signed-in user is an owner or admin. "Chưa cấu hình khóa mã hóa thông tin kết nối (CREDENTIAL_KEY)" means no credential key: the compose default creates `.data/credential.key` on its volume, so this appears only when `CREDENTIAL_KEY_FILE` was changed.
- **"Lượt kết nối này không hợp lệ".** The attempt is single use and lasts 10 minutes, and it is bound to the signed-in member: start again from the Kênh page in the same tab, signed in as the same person.
- **"Không tìm thấy lượt kết nối này trên trình duyệt".** The attempt is remembered in that browser tab (`sessionStorage`): do not open the dialog link in another browser or a private window.
- **A post stays "Đã lên lịch".** The worker role of the stack runs (`docker compose -p social-check ps`), `CROVE_MODULES` is empty (a list without `social` runs no publishing), and the channel is active. A channel marked "Cần kết nối lại" pauses its posts until it is reconnected.
- **A post stays "Cần xử lý".** The pipeline did not know whether the platform posted. Look at the Page or the OA first. Only then use the retry or "resolve" buttons: a blind retry is how a double post happens.
- **Reading the stack's logs without leaking:** `docker compose -p social-check logs api worker`. Lines name the provider, an error name and a code, never a token; if one ever does, stop and tell the PO.

## Cleanup

1. **[PO]** `docker compose -p social-check down -v` (removes the stack, its database and the sealed tokens).
2. **[PERSON]** In Facebook, Settings, Business integrations, remove "Ludy live check". In Zalo, remove the app's access from the OA. Delete the Meta app and the Zalo app, or leave them in development for the next run. Empty and delete the S3 bucket and delete the IAM user and its key.
3. **[PERSON]** Delete the app secrets and keys from the password manager if the apps are deleted, or rotate them if they were ever shown somewhere they should not have been.
4. **[PO]** Delete the check's `.env` from the machine. Confirm no secret or id reached chat, an issue or a PR.

What this check does not decide: production use of either platform. Other people's Pages need Meta's App Review and Business Verification, and other OAs need whatever Zalo requires of a public app. Those are owner actions tracked outside this runbook.
