# Runbook: sign the pilot in with DOS ID (issue #2704)

Moves the pilot (`app.ludy.vn`, `api.ludy.vn`) from its own bundled Supabase Auth to DOS ID, so the owner can sign in with his dos.me account. DOS ID is a Supabase Auth project (ADR-0027, ADR-0028), so Ludy needs no DOS-specific code: the kernel verifies its ES256 tokens against its published keys (`AUTH_SESSION_CHECK=jwt`) and the app signs in at its Auth URL. What the repository supplies is generic: the settings of [Your own identity provider](../self-host/README.md#your-own-identity-provider) and `AUTH_ALLOWED_EMAILS`. What follows is the pilot's own configuration.

**This is a Production, secret and credential step** ([contributing.md](../contributing.md#production-secret-and-credential-steps)). It is run by the Platform PO, one step list per approval from the owner in the PO's chat, stopping at the first failure. A session that writes code never runs it. No value below is in this repository: each says where it comes from.

## What changes, and what breaks

- **Every existing pilot sign-in stops working.** The kernel accepts one issuer: after the switch a token from the pilot's bundled Supabase Auth is refused (401). Everyone who uses the pilot with an email account created there must be known and told first (step 0, question 2). Their orgs and data stay; only the way in changes.
- **A DOS ID login is a new account here, not the owner's existing pilot member.** Ludy keys accounts by `(issuer, subject)`; a new issuer gives a new, empty account. Step 5 joins it to the existing org.
- **Only listed addresses may use the pilot.** DOS ID serves many people; `AUTH_ALLOWED_EMAILS` makes the pilot refuse every other address with 403 `ACCOUNT_NOT_ALLOWED`.
- The bundled `auth` service keeps running, unused, so the rollback is a settings change only (no data moves, no migration).

## Step 0. Human-only inputs (owner and DOS ID's operator)

Nothing is started until each is answered. Only a person with access to DOS ID or the pilot's consoles can get them.

| # | Input | Who | Where it comes from |
|---|---|---|---|
| 1 | How the owner signs in at DOS ID: email and password, or a social provider (Google and the like) | owner | his dos.me account. The app's sign-in screen offers email and password only. With a social-only account, this runbook stops until a "sign in with a provider" button exists (follow-up of #2704), or the owner sets a password at DOS ID |
| 2 | Who else signs in to the pilot today, and with what addresses | owner | the pilot's members list (Settings, Members) of each org |
| 3 | Which org holds data to keep, and which address owns it (or: nothing to keep) | owner | Settings, Members |
| 4 | DOS ID's Supabase Auth URL (ends `/auth/v1`), publishable (anon) key, token issuer (`iss`) and JWKS address | DOS ID's operator | DOS ID's project settings. The issuer is the `iss` of a real access token; the JWKS is normally `<issuer>/.well-known/jwks.json`. Both addresses and the publishable key are public values; **no service-role key, JWT secret or database password is ever needed or to be sent** |
| 5 | DOS ID signs its tokens with an asymmetric key (ES256 or RS256) and publishes the JWKS | DOS ID's operator | its JWT signing keys setting. A project that signs with a shared HS256 secret cannot be used: Ludy would need that secret, and it is never shared |
| 6 | DOS ID requires email confirmation for its accounts | DOS ID's operator | its Auth settings. Ludy identifies members by the token's `email` |
| 7 | DOS ID lets the owner enrol a second factor (TOTP) | DOS ID's operator, owner | approvals, posting and member changes (R3) need a second factor from the last 5 minutes (`AUTH_STEP_UP=required`, which the kernel enforces on a public URL). Without MFA at DOS ID those actions are refused with `STEP_UP_REQUIRED` |
| 8 | Registration at DOS ID: the pilot app's address `https://app.ludy.vn` and its sign-in return paths `https://app.ludy.vn/` and `https://app.ludy.vn/reset-password` in the project's allowed redirect URLs | DOS ID's operator | its Auth, URL configuration. Without it, password-recovery and confirmation links land on DOS ID's own default page. The app signs in with a password and needs no OAuth client or secret from DOS ID |
| 9 | The owner's DOS ID email address(es) to allow, as `AUTH_ALLOWED_EMAILS` | owner | the address his dos.me account signs in with |
| 10 | Access to set the API's environment and restart it, and to the static host's Production environment (Vercel project of the app) | Platform PO | the pilot's own secret store and console |

If DOS ID's own settings let anyone sign up, the app's "create account" tab creates DOS ID accounts. They cannot use the pilot (not on the list), but tell DOS ID's operator the tab exists.

## Step 1. The release

The API's compose file must carry the identity-provider settings: a release that includes this runbook's change (`docker-compose.yml` passes `AUTH_ISSUER`, `AUTH_SESSION_CHECK`, `AUTH_JWKS_URL`, `PUBLIC_AUTH_URL`, `PUBLIC_AUTH_ANON_KEY`, `AUTH_ALLOWED_EMAILS` and honours an empty `AUTH_UPSTREAM_URL`). Check the running release is at or after it (`GET /version` build against the PR's merge commit); if not, deploy one first through the normal release ([deploy.md](deploy.md)). Everything after this step is settings only.

## Step 2. Record what rolls back

On the API host, copy the current `.env` to a private, dated file next to it (mode 600, never into the repository), and write down the current values of these lines: `AUTH_ISSUER`, `AUTH_SESSION_CHECK`, `AUTH_UPSTREAM_URL`, `AUTH_SIGNUP_POLICY` (the pilot runs `invite_only`), `AUTH_SIGNUP_ALLOWED_DOMAINS`, `PUBLIC_AUTH_URL`, `PUBLIC_AUTH_ANON_KEY`, `PROBER_AUTH_URL`. Also note the app's current Production deployment on the static host (its rollback target).

## Step 3. The app's build (harmless first)

On the static host's Production environment ([split-app-api.md](split-app-api.md)) set `VITE_AUTH_URL` to the DOS ID Auth URL (input 4), so the app's Content-Security-Policy lets the browser reach it. Then rebuild the Production deployment (a redeploy of the current one; the variable is baked into the bundle). It changes nothing yet: the API still names the bundled Auth. Skipping this step makes the sign-in request fail in the browser ("Failed to fetch") after step 4.

## Step 4. The API's settings

In the API host's `.env` (mode 600) set exactly:

| Line | Value |
|---|---|
| `AUTH_ISSUER` | input 4's issuer |
| `AUTH_JWKS_URL` | input 4's JWKS address |
| `PUBLIC_AUTH_URL` | input 4's Auth URL |
| `PUBLIC_AUTH_ANON_KEY` | input 4's publishable key |
| `AUTH_SESSION_CHECK` | `jwt` |
| `AUTH_UPSTREAM_URL` | empty (`AUTH_UPSTREAM_URL=`): no bundled proxy |
| `AUTH_ALLOWED_EMAILS` | input 9, comma separated (exact addresses; `@domain` entries allow a whole domain) |
| `AUTH_SIGNUP_POLICY` | remove the line or set `open`: the kernel refuses `invite_only` and `allowlist` without the bundled proxy, and the boot fails. Sign-up is DOS ID's to restrict |
| `AUTH_SIGNUP_ALLOWED_DOMAINS` | remove the line |
| `PROBER_AUTH_URL` | remove the line: it then follows `PUBLIC_AUTH_URL`, so the prober asks DOS ID's `/health` (with the publishable key) instead of the proxy that no longer exists |

Leave `AUTH_JWT_SECRET` and the other lines alone. Then recreate the API and the worker in the stack directory (`docker compose up -d api worker`, with the `COMPOSE_FILE` of [The pilot layout](deploy.md#the-pilot-layout)). A boot failure names the setting (the container exits; `docker compose logs api`): fix it or roll back (below), never loosen a check.

## Step 5. Join the owner to the existing org (before anyone signs in at DOS ID)

The owner's DOS account is new here and empty. Which path depends on input 3:

- **Nothing to keep in the pilot** (only test or smoke data): the owner signs in at DOS ID (step 6, item 5) and creates a fresh org. Nothing else to do.
- **An org with data to keep**: the account that owns it must become the owner's DOS identity. There is no Ludy command for that, and an invite cannot make an owner (it grants `admin`, `member` or `viewer`; only an owner promotes), so the old owner's account would be stuck behind a sign-in that no longer exists. The way that keeps every membership, role and audit row is to give the **existing** account row the new identity, once, **before** the owner's first DOS sign-in. It rewrites an account's identity key in the production database, so it needs the owner's separate, explicit approval, and the Platform PO runs it, never a code session:
  1. Extra inputs (human-only): the old owner's account (its email in `crove_kernel.user_account`, the old `issuer` and `subject` read from the row) and the owner's DOS ID user id (the `sub` of his DOS token; DOS ID's operator reads it from the account).
  2. On the database host, as the admin login, in one transaction, check first that exactly one row matches and that no account exists for the new identity (an account created by an earlier sign-in would collide on `UNIQUE (issuer, subject)`; if one exists, stop):

     ```sql
     BEGIN;
     SELECT id, email, issuer, subject FROM crove_kernel.user_account WHERE lower(email) = lower('<old owner email>');  -- one row
     SELECT count(*) FROM crove_kernel.user_account WHERE issuer = '<DOS issuer>' AND subject = '<DOS sub>';          -- 0
     UPDATE crove_kernel.user_account SET issuer = '<DOS issuer>', subject = '<DOS sub>', email = '<DOS email>'
       WHERE id = '<id from the first SELECT>' AND issuer = '<old issuer>' AND subject = '<old subject>';             -- UPDATE 1
     COMMIT;
     ```
  3. Then the owner signs in at DOS ID and finds the org, with the same role. The old pilot login of that account is gone with the old issuer.

Do not link identities any other way (no other table, no copied rows). An owner who also wants a second owner promotes them in Settings, Members once signed in, with a second factor (input 7).

## Step 6. Verify

All of these, from outside the server, and the owner's sign-in (item 5) only after step 5:

1. `GET https://api.ludy.vn/api/config` answers `authUrl` = DOS ID's Auth URL and `authAnonKey` = the publishable key.
2. `GET https://api.ludy.vn/readyz` answers `{"ready":true}`; `/healthz` answers 200.
3. Without a token, `GET https://api.ludy.vn/api/export/ledger.xlsx` and `GET https://api.ludy.vn/api/files/00000000-0000-0000-0000-000000000000` still answer 401.
4. A token from the **old** bundled Auth (an existing member's browser) now gets 401 and the app shows the sign-in screen.
5. The owner signs in at `https://app.ludy.vn` with the DOS ID address (input 9) and password. The app opens with the org of step 5 (a fresh owner of nothing sees the empty start screen). If the sign-in screen shows an error, read the first red line of the browser console and network tab: a blocked request means step 3 did not take; 401 from the API means `AUTH_ISSUER` or `AUTH_JWKS_URL` do not match the token (compare the token's `iss` claim); 403 `ACCOUNT_NOT_ALLOWED` means the address or its case is not in `AUTH_ALLOWED_EMAILS` or DOS ID reports it unverified.
6. A DOS ID account whose address is **not** on the list (the owner's second address, or a colleague's test account) signs in at DOS ID and then gets "This account is not allowed" from Ludy on every screen; no account is created (the members list shows nobody new).
7. `pnpm pilot:check -- --url https://api.ludy.vn` run by a person on the host's checkout: "Sign-up limited" passes through `AUTH_ALLOWED_EMAILS`. The probe does not follow the Auth URL to another host, so its two Auth lines that read the settings answer "check by hand"; the by-hand checks are inputs 6 and 7 above. It sends no sign-up to DOS ID.
8. The prober reports healthy within its interval, with no Auth alert.

## Rollback

Restore step 2's lines in `.env` (`AUTH_ISSUER`, `AUTH_SESSION_CHECK`, `AUTH_UPSTREAM_URL` unset or `http://auth:9999`, `AUTH_SIGNUP_POLICY=invite_only`, `AUTH_SIGNUP_ALLOWED_DOMAINS`, `PROBER_AUTH_URL`), remove `AUTH_JWKS_URL`, `PUBLIC_AUTH_URL`, `PUBLIC_AUTH_ANON_KEY` and `AUTH_ALLOWED_EMAILS`, and recreate the API and the worker. If step 5's update ran, first undo it the same way (the same transaction with the old and new values swapped, one row), or that account keeps the DOS identity and cannot sign in at the old Auth. The old sign-ins work again at once: the bundled Auth never stopped and no data changed. `VITE_AUTH_URL` may stay (it only allows one more origin in the policy); remove it and rebuild only if the owner wants. Accounts created at DOS ID stay there, and their Ludy accounts stay (empty or in the org they joined); a person removed from an org by mistake is re-invited.

## Limits to know

- **Sign-outs and bans at DOS ID take effect when the access token expires**, at most DOS ID's token lifetime (ADR-0028, section 3). Approving, posting and member changes confirm the session live with DOS ID first.
- **`AUTH_ALLOWED_EMAILS` is as strong as DOS ID's email confirmation** (input 6). The kernel refuses a token that says its email is unverified; one that omits the claim passes.
- **One issuer per deployment.** Running the bundled Auth and DOS ID side by side needs a different design and is not part of this runbook.
- Social login is not in the app's sign-in screen (input 1).
