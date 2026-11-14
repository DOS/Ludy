# Contract: a hosted login page for Ludy (issue #2704)

What an identity provider implements so that Ludy can send people to the provider's own sign-in page and get a standard Supabase Auth session back. It is written for whoever builds the provider's side (for the pilot: the team that runs the DOS ID sign-in page). Ludy's side is generic and names no provider: [Ludy's settings](#ludys-settings) are the only configuration.

This is an authorization-code flow with PKCE ([RFC 7636](https://www.rfc-editor.org/rfc/rfc7636), method S256), shaped like OAuth 2.0's but with no client secret, because Ludy's app is a browser app (a public client). It does **not** use Supabase Auth's OAuth 2.1 server: tokens that server issues to a client carry a `client_id`, and Ludy's kernel refuses them on purpose (ADR-0028). The session this flow returns is an ordinary Supabase Auth browser session.

## Why a code and a token endpoint

Supabase Auth's own PKCE flow cannot be completed by another page: it creates a flow state only for its `/authorize` (social providers), SSO and email flows, and `admin.generateLink` takes no `code_challenge` (checked in Supabase Auth v2.197.0). A sign-in page that offers a password, social or custom providers therefore needs a small service of its own. Returning the page's own access and refresh tokens in the address (the implicit return) is not allowed either: Ludy and the provider's page would share one refresh-token family, and Supabase Auth's "detect compromised refresh token" revokes the family when both refresh.

## The flow

```text
Ludy app                      Hosted login page (provider)          Token endpoint (provider)
   |  1. redirect, PKCE challenge        |                                   |
   |------------------------------------>|  user signs in however it likes   |
   |  2. redirect back: code + state     |                                   |
   |<------------------------------------|                                   |
   |  3. POST code + code_verifier -------------------------------------------->|
   |  4. a new Supabase session  <---------------------------------------------|
```

### 1. Ludy sends the browser to the hosted page

`GET <login page URL>` with these query parameters added (any query the configured address already has is kept, and a parameter of the same name is replaced):

| Parameter | Value |
|---|---|
| `response_type` | `code` |
| `redirect_uri` | the app's callback: `<app origin>/auth/hosted-callback` |
| `state` | 43 characters of base64url, random per attempt |
| `code_challenge` | base64url(SHA-256(`code_verifier`)), 43 characters, no padding |
| `code_challenge_method` | `S256` (the only method) |

The provider must:

- Refuse the request without redirecting when `redirect_uri` is not **exactly** (byte for byte, no wildcard, no prefix, no normalisation) one of the callback addresses registered for Ludy, or when `response_type` or `code_challenge_method` is anything else, or when `code_challenge` is not 43 characters of `[A-Za-z0-9_-]`. Never redirect to an unregistered address, whatever the error.
- Keep `state`, `redirect_uri` and `code_challenge` with the sign-in attempt on the server (not in a cookie the page can swap), and use them only for this attempt.

### 2. The page returns a code

After the user is signed in, the page redirects (302) to `redirect_uri` with query parameters:

- success: `code=<one-time code>&state=<the state received, unchanged>`;
- failure or a cancelled sign-in: `error=<code>&state=<state>` (and optionally `error_description`). Ludy treats any `error` as "did not complete" and shows its own message.

The code:

- is random, unguessable, 16 to 512 characters of `[A-Za-z0-9._~-]` (Ludy refuses anything else);
- is bound on the server to the signed-in user, the `code_challenge` and the exact `redirect_uri` of the attempt;
- is **single use** and valid for **60 seconds**; it is invalidated on first use whether the redemption succeeds or not, and on any failed verification;
- is never logged in clear (log a hash if it must be traced).

The redirect carries nothing else: no token, no email, no user id.

### 3. Ludy redeems the code

`POST <token endpoint URL>`, `Content-Type: application/json`, from the user's browser (cross-origin, so CORS applies), body:

```json
{ "grant_type": "authorization_code", "code": "...", "code_verifier": "...", "redirect_uri": "<app origin>/auth/hosted-callback" }
```

`code_verifier` is 43 characters of base64url (32 random bytes), made by the app for this attempt. The request is sent without cookies (`credentials: omit`), without a referrer, without following redirects and without caching.

The endpoint must:

- Answer CORS for **the app's origin only** (`Access-Control-Allow-Origin: <that origin>`, never `*`, never a reflected arbitrary `Origin`), for `POST` and the preflight, with `Vary: Origin`. No credentials mode.
- Find the code, and refuse (`400`, `{"error":"invalid_grant"}`, the same answer for every cause, no detail) unless **all** hold: it exists, it is unused and under 60 seconds old, `redirect_uri` equals the one stored with it exactly, and base64url(SHA-256(`code_verifier`)) equals the stored `code_challenge` (compared in constant time). Mark the code used before answering.
- Rate limit by code and by client address, and answer `429` over the limit.
- Send `Cache-Control: no-store` and `Pragma: no-cache` on every answer.

### 4. The session

On success the endpoint answers `200` with `Content-Type: application/json`:

```json
{ "access_token": "...", "refresh_token": "...", "token_type": "bearer", "expires_in": 3600 }
```

This is the body of Supabase Auth's `/token` answer (extra fields such as `user` and `expires_at` are fine; Ludy reads `access_token`, `refresh_token` and `token_type` only, and refuses a `token_type` other than `bearer`). Ludy hands both tokens to the Supabase Auth client (`setSession`) and sends the access token to its API as a Bearer token, like every other sign-in.

The session must be:

- **Fresh**: a new Supabase Auth session for the user, with its own refresh-token family, never the provider's own page session or one already given to another app. A way that needs only standard Supabase Auth calls and the service role key, held only by the provider's server: `admin.generateLink({ type: 'magiclink', email })` for the user, then `POST /auth/v1/verify` with `{ "token_hash": <hashed_token>, "type": "magiclink" }`, which answers a new session. (Nothing is mailed by `generateLink`.)
- **From the same Supabase Auth project** that Ludy's `AUTH_ISSUER`, `AUTH_JWKS_URL` and `PUBLIC_AUTH_URL` name: the access token must verify against that project's JWKS (ES256 or RS256), with `aud = authenticated`, `role = authenticated`, a `session_id` and the user's confirmed `email`. It must not be anonymous and must not be issued to an OAuth client (no `client_id` claim, no `oauth_provider/` method in `amr`).
- **`aal1`**: signing in through this flow is a first factor. A user with a second factor enrolled in that project does the second factor in Ludy afterwards (Ludy asks for it when an action needs it; policy P11, ADR-0028). The endpoint does not pass `aal2` on a page's own earlier MFA.
- **Only for the user who signed in at the page**, whose email is confirmed. Ludy additionally decides who may use the deployment (`AUTH_ALLOWED_EMAILS`).

Errors: `400 {"error":"invalid_grant"}` for every refusal of step 3, `429`, `5xx` for the provider's own failures. Ludy shows one message for all of them ("sign-in did not complete") and discards the attempt; the user starts again.

## What Ludy guarantees on its side

These are tested in `apps/app/test/hosted-login.test.ts`:

- `state` and `code_verifier` are made with the browser's cryptographic random generator and kept in `sessionStorage` of the tab only (never `localStorage`, a cookie or an address), under one key.
- They are removed from storage the moment the callback is read, before anything is sent: a code is redeemed at most once from the tab, a failed attempt starts over, and a second tab or a replayed callback finds nothing and is refused.
- A login started more than 10 minutes ago is refused.
- The callback is refused unless its `state` equals the tab's exactly, its path is the callback path, and the `redirect_uri` it was started with is the app's callback; `code` must have the shape above. Nothing is sent to the token endpoint otherwise.
- The code goes only to the token endpoint the kernel configured, with `credentials: omit`, `referrerPolicy: no-referrer`, `redirect: error` and `cache: no-store`. The callback address is replaced in the address bar before the Supabase Auth client is created, so no other code reads the one-time code, and nothing is logged.
- The answer must be a JSON object with non-empty `access_token` and `refresh_token` and, if present, `token_type` `bearer`; the kernel then verifies the access token like any other (signature, issuer, audience, expiry, `session_id`, `email`).

## Ludy's settings

| Setting | Meaning |
|---|---|
| `AUTH_HOSTED_LOGIN_URL` | the hosted login page (step 1), https |
| `AUTH_HOSTED_LOGIN_TOKEN_URL` | the token endpoint (step 3), https; both or neither |
| `AUTH_HOSTED_LOGIN_NAME` | the words on the sign-in button ("Continue with <name>"); optional, at most 40 characters |
| `VITE_HOSTED_LOGIN_ORIGIN` | build environment of a web app served apart from its API: the token endpoint's origin, so the app's Content-Security-Policy lets the browser call it ([split-app-api.md](../runbooks/split-app-api.md)) |

The provider registers, for Ludy: the callback address `<app origin>/auth/hosted-callback` (for the pilot, the app's own address), and the app's origin for CORS on the token endpoint.

## Checks for the provider's tests

- RFC 7636 appendix B: verifier `dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk` has challenge `E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM`.
- A code redeemed twice: the second answer is `invalid_grant`, and so is the first when it comes after 60 seconds, with the wrong verifier, or with another `redirect_uri` (also one that differs only by a trailing slash, a case or a query).
- A `redirect_uri` that is not registered gets an error page, never a redirect.
- A preflight and a `POST` from another origin get no `Access-Control-Allow-Origin` for it.
- The access token verifies against the project's JWKS, has `aal1`, and refreshing its refresh token does not invalidate the provider's own page session (a separate family).
