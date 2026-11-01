<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Runbook: the web app and the API on two origins

By default Ludy serves its web app and its API from one origin (`docker compose up`: the kernel answers `/api` and serves the app's files). A hosted deployment can split them: the app is built as static files and served from a static host (Vercel) at `app.<domain>`, and the API runs on its own host at `api.<domain>`. The browser then calls the API directly. Issue #2261, [plan Decision 22](../plan/crove-os-kernel.md). This runbook is the generic mechanics, for any operator. The steps for one operator's DNS, hosting accounts and secret store belong in that operator's private deployment layer, not here.

Nothing changes for self-host: with `APP_URL`, `CORS_ALLOWED_ORIGINS` and `VITE_API_URL` unset, every call is a same-origin path and the kernel sends no CORS header.

## The three settings

| Setting | Where | Meaning |
|---|---|---|
| `VITE_API_URL` | the app's **build** (`apps/app`) | The API's origin, such as `https://api.example.com`. Unset or empty: calls stay same-origin. Anything but an http(s) origin stops the app at load. |
| `CORS_ALLOWED_ORIGINS` | the API | The exact origins whose pages may call the API from a browser: the app's origin. Never `*`; https only (http for `localhost`); no path or trailing slash; at most 10. Unset: no CORS header at all. |
| `APP_URL` | the API and the worker | Where people open the app. It must be listed in `CORS_ALLOWED_ORIGINS` when it is another origin than `PUBLIC_URL` (the API refuses to start otherwise). Unset: `PUBLIC_URL`. |

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

- **The app builds from a release, never from a plain merge to `main`.** A tag `v*` on a commit of `main` runs `.github/workflows/release-branch.yml`, which moves the branch `release` to that commit. The static host's Production Branch is `release`. As a second guard, `apps/app/vercel.json` runs `tools/vercel/ignore-build.mjs`, which skips a Production build of any other branch.
- **The app asks for a reload on a mismatch.** The bundle carries its commit (`VITE_BUILD`, else Vercel's `VERCEL_GIT_COMMIT_SHA`); the API reports its own on `GET /version` (`CROVE_BUILD`, the release commit). When the two differ, a bar over the app says to reload. It checks every five minutes and when the tab returns to the front. A bundle with no build id (the kernel's own, same-origin) never asks.
- **Order of a release:** roll the API and the worker first (worker before API, as in [deploy.md](deploy.md)), then the tag's static build goes live; a page open meanwhile shows the reload bar once the API runs the new build. A rollback moves both back the same way.

## `apps/app/vercel.json`

- `build.env.VITE_API_URL` is the API origin of the public hosted deployment. Another operator on Vercel edits it, and the `connect-src` of the Content-Security-Policy in the same file (a test, `apps/kernel/test/vercel-config.test.ts`, keeps that policy equal to the one the kernel would send for the same origins).
- The headers are those the kernel sends with the app: the Content-Security-Policy with Trusted Types (the same one, with the API origin allowed), `Referrer-Policy: no-referrer`, `X-Content-Type-Options`, `X-Frame-Options` and `Strict-Transport-Security`.
- Every path but `/assets/*` and `/favicon.svg` is rewritten to `index.html`, as the kernel does for deep links.
- With presigned transfers, add the bucket's https origin to `connect-src`. R2 (no presigned uploads) needs nothing.

## Checks

- `pnpm pilot:check` (with the API's `.env`) fails a split with no matching CORS entry, a wildcard, a path, a non-https `APP_URL`, or a list that names an origin the app does not serve from. With `--url https://api.<domain>` it also sends two preflights as a browser would: one from the app's origin (must be answered with that origin) and one from a stranger (must get no CORS header).
- Open the app, sign in, open a screen, upload a file and watch the live updates: the network tab shows no CORS error, `/api/stream` stays open.
- Tag a release and check the bar: with the API on a newer build than the page, the page shows "reload".
