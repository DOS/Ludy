<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Runbook: the web app and the API on two origins

By default Ludy serves its web app and its API from one origin (`docker compose up`: the kernel answers `/api` and serves the app's files). A hosted deployment can split them: the app is built as static files and served from a static host (Vercel) at `app.<domain>`, and the API runs on its own host at `api.<domain>`. The browser then calls the API directly. Issue #2261, [plan Decision 22](../plan/crove-os-kernel.md). This runbook is the generic mechanics, for any operator. The steps for one operator's DNS, hosting accounts and secret store belong in that operator's private deployment layer, not here.

Nothing changes for self-host: with `APP_URL`, `CORS_ALLOWED_ORIGINS` and `VITE_API_URL` unset, every call is a same-origin path and the kernel sends no CORS header.

## The three settings

| Setting | Where | Meaning |
|---|---|---|
| `VITE_API_URL` | the app's **build** (`apps/app`) | The API's origin, such as `https://api.example.com`. Unset or empty: calls stay same-origin. Anything but an http(s) origin stops the app at load. |
| `CORS_ALLOWED_ORIGINS` | the API | The exact origins whose pages may call the API from a browser: the app's origin. Never `*`; https only (http for `localhost`); no path or trailing slash; at most 10. Unset: no CORS header at all. |
| `APP_URL` | the API and the worker | Where people open the app: an origin only (no path, query or trailing slash). It must be listed in `CORS_ALLOWED_ORIGINS` when it is another origin than `PUBLIC_URL` (the API refuses to start otherwise). Unset: `PUBLIC_URL`. |

Credentials are bearer tokens in the `Authorization` header, and the invalidation stream opens with a one-time ticket in its address. No cookie is set or read, so no `SameSite` setting is involved, and the API never sends `Access-Control-Allow-Credentials`. An origin off the list gets no CORS header, so the browser refuses to hand it any answer; a preflight (`OPTIONS`) from it ends with an empty `204`. The API answers preflights before the rate limit and the session check, since a preflight carries no token.

## Which link uses which address

The rule: a link that opens a screen of the app uses `APP_URL`; what the API itself serves uses `PUBLIC_URL`.

| Link | Address |
|---|---|
| Invite, notification, digest, report and booking mail; chat alerts; events in calendar feeds | `APP_URL` |
| The OAuth return addresses of channels, ads and calendars (`/channels/oauth/<provider>/callback`, `/calendar/oauth/<provider>/callback`) are **pages of the app**: register them at the provider under `APP_URL` | `APP_URL` |
| Supabase Auth's site URL and redirect allow list (bundled Auth: `GOTRUE_SITE_URL`, set from `APP_URL` by `docker-compose.yml`) | `APP_URL` |
| The sign-in endpoint `/auth/v1` (`PUBLIC_AUTH_URL`, else `PUBLIC_URL/auth/v1`), mail and bank-feed webhooks, `/api/inbound/email`, the status page, link-in-bio pages (`/b/<slug>`), calendar feed files (`/cal/<file>`), Social short links (`/l/<code>`) | `PUBLIC_URL` |
| The bucket's CORS rule for presigned transfers (`S3_PRESIGNED_URLS=true`) | the **app's** origin: browsers upload from there |

## The release ships both together

The app and the API must be the same build, or a bundle may call a route its API does not have yet.

- **The app builds from a release, never from a plain merge to `main`.** The static host's Production Branch is `release`. The workflow `.github/workflows/release-branch.yml` (run by hand, or by the operator's deploy pipeline with `gh workflow run release-branch.yml -f tag=v1.2.3`) points `release` at a tag `v*` that is on a commit of `main` and has green CI. As a second guard, `apps/app/vercel.json` runs `tools/vercel/ignore-build.mjs`, which skips a Production build of any other branch. Nothing moves `release` on its own when a tag is pushed: the app must not go live before its API.
- **The app asks for a reload on a mismatch.** The bundle carries its commit (`VITE_BUILD`, else Vercel's `VERCEL_GIT_COMMIT_SHA` on a Production build; a Preview carries none and never asks); the API reports its own on `GET /version` (`CROVE_BUILD`, the release commit). When the two differ, a bar over the app says to reload. It checks `GET /version` (a public request that reads the migration ledger) every five minutes and when the tab returns to the front. A bundle with no build id (the kernel's own, same-origin) never asks.
- **Order of a release:** roll the API and the worker first (worker before API, as in [deploy.md](deploy.md)) and check them, then run `release-branch` with the same tag, and Vercel builds the app. A page open meanwhile shows the reload bar once the API runs the new build. **A rollback moves both back:** roll the API back, then run `release-branch` with the earlier tag. The bar cannot tell a bundle older than its API from one newer than it, so its text says the new version is being rolled out and to try again in a few minutes.
- **Protect the pointer.** Create the GitHub environment `release` and allow deployments from `main` only (the workflow runs only from `main` and uses that environment), so an edited copy of the workflow on another branch cannot move `release`; allow only the workflow's `github-actions[bot]` to push `release` (a branch rule or ruleset), and limit who may create `v*` tags to maintainers.

## The static host: `apps/app/vercel.json` and the build environment

The repository names no deployment's address. Set these in the static host's project environment (Vercel: Project Settings, Environment Variables, for Production); they are public addresses baked into the bundle, never secrets:

| Variable | Meaning |
|---|---|
| `VITE_API_URL` | The API's origin (required for a split; unset builds the same-origin app). |
| `VITE_AUTH_URL` | Supabase Auth's URL when it is not the API's (its origin is allowed in the policy below). Default: the API's origin. |
| `VITE_STORAGE_ORIGIN` | The bucket's public origin (`S3_PUBLIC_ENDPOINT`) when files go to and from it by presigned URL. R2 and any `S3_PRESIGNED_URLS=false` setup need none. The bucket's CORS rule must allow the app's origin. |
| `VITE_TURNSTILE` | `true` when the booking page shows Cloudflare Turnstile (`TURNSTILE_SITE_KEY`). |

- **The Content-Security-Policy is built from them.** `apps/app/vite-csp.ts` adds a `<meta http-equiv="Content-Security-Policy">` to the built page (default-src, script-src, style-src, img-src, connect-src with the API, Auth and bucket origins, frame-src and the Trusted Types allowlist); with `VITE_API_URL` unset it adds nothing and the kernel's own header governs. The origin-free directives (`frame-ancestors`, `object-src`, `base-uri`, `form-action`, `require-trusted-types-for`) are a header in `apps/app/vercel.json`, which a `<meta>` policy cannot carry. A browser applies both; `apps/kernel/test/vercel-config.test.ts` keeps the two together equal to the policy the kernel sends for the same origins.
- The other headers are those the kernel sends with the app: `Referrer-Policy: no-referrer`, `X-Content-Type-Options`, `X-Frame-Options` and `Strict-Transport-Security`.
- Every path but `/assets/*` and `/favicon.svg` is rewritten to `index.html`, as the kernel does for deep links.
- **Authorization codes in the host's logs.** A provider's OAuth return address is a page of the app, so the one-time `code` in its query string reaches the static host and appears in its access logs (and nowhere in the API's). The code is single-use and expires within minutes, and the app posts it to the API at once; keep the host's log retention short and its log access to the operator.

## Behind a cloud load balancer

- **`TRUSTED_PROXY_HOPS`** counts the proxies that append to `X-Forwarded-For`. Behind Google's external Application Load Balancer, Cloud Run sees two (the balancer and Google's front end), so set `2`; with `1` or `0` every client shares one address, and so one rate-limit and email budget ([pilot-readiness.md](pilot-readiness.md)). `pnpm pilot:check --url` shows the effect on a real request.
- **`APP_URL` goes to every process that builds a link: the API and the worker** (mail and chat alerts are sent by the worker). `CORS_ALLOWED_ORIGINS` is the API's alone.
- **Protection rules must still let the workflow push.** The branch rule on `release` must allow `github-actions[bot]` (or the workflow's app) to force-push it, and the tag rule on `v*` must limit who creates tags without blocking the maintainers who run the release. After setting both, run `release-branch` once and check that `release` moved.

## Checks

- `pnpm pilot:check` (with the API's `.env`) fails a split with no matching CORS entry, a wildcard, a path, a non-https `APP_URL`, or a list that names an origin the app does not serve from. With `--url https://api.<domain>` it also sends two preflights as a browser would: one from the app's origin (must be answered with that origin) and one from a stranger (must get no CORS header).
- Open the app, sign in, open a screen, upload a file and watch the live updates: the network tab shows no CORS error, `/api/stream` stays open.
- Tag a release and check the bar: with the API on a newer build than the page, the page shows "reload".
