# Runbook: deploy and roll back

How a release reaches a Ludy instance that runs the `docker compose` stack on one server (the pilot setup, backlog item M1-6), what the smoke test checks, and how to roll back. Issue #56. The pieces:

- `tools/deploy/deploy.sh` runs on the host: it pulls the images, migrates, rolls the services, waits for readiness, runs the smoke test and rolls back on failure.
- `.github/workflows/deploy.yml` builds the images of a release, pushes them to GitHub Container Registry (GHCR) and runs the script over SSH.

Until an environment has its secrets, a run still builds and pushes the release images, and its deploy job passes with the notice "Deploy not configured" without contacting any server.

## What triggers a deploy

| Trigger | Environment | Release name |
|---|---|---|
| A tag `v*` pushed on a commit of `main` | `pilot` | the tag, for example `v0.3.0` |
| A push to `dev` | `beta` | `dev-<first 12 characters of the commit>` |
| Run the workflow by hand ("Run workflow"), action `deploy` | the one you pick | the tag (or `dev`, for beta only) the run starts from |
| Run the workflow by hand, action `rollback` | the one you pick | the release that ran before the current one |

- `pilot` deploys only `v*` tags whose commit is on `main`; any other tag fails the run before anything is built.
- There is no `dev` branch yet: today every PR merges to `main`, and plan §3.5 creates `dev` together with a beta instance. Until both exist, `beta` stays unused.
- The commit must have passed CI: the run waits up to 30 minutes for the check runs named in the variable `DEPLOY_REQUIRED_CHECKS` (one name per line; default `Lint, typecheck, test` and `Playwright on docker compose`) and stops if one did not succeed.
- One deploy per environment runs at a time; a second one waits. GitHub keeps only one waiting run per environment: when a third arrives, the one that was waiting is cancelled. Check the Actions list after queuing a rollback behind a running deploy.
- `pilot` runs only commits of `main`, for a rollback too: start a manual run from `main` or from a `v*` tag.

## What a deploy does

The workflow builds `ghcr.io/<owner>/<repo>` (the kernel image, `Dockerfile`, with the release commit as its `CROVE_BUILD`) and `ghcr.io/<owner>/<repo>-extract` (`apps/extract/Dockerfile`) and `ghcr.io/<owner>/<repo>-media` (`apps/media/Dockerfile`, the sandbox that measures meeting recordings, #2988) from the release commit, tags them with the release name and passes them on **by digest**, so the host runs exactly what was built. It uploads `deploy.sh` and the release's `docker-compose.yml` to the host and runs, in this order:

1. Pull the three images by digest (a rollback to a release staged before `crove-media` was published has no media image to pull and pins none). The registry login uses the run's read-only token, sent over stdin into a throwaway Docker config that is deleted right after the pull: no credential stays on the host.
2. Check that the compose files load with the env file (`docker compose config`). Nothing has changed yet.
3. Start the database, then two production steps on the host ([below](#production-steps-in-the-deploy-the-context-token-key-and-the-plain-idempotency-rows)): make the context token key when the env file has none, and print the count of plain idempotency rows. Then run `migrate` with the new image (the migrations, the context token key, then the DDL watch's event triggers, [alerts.md](alerts.md)). If it fails, the services are left as they were and the run exits 1: the old release keeps running.
4. Start Supabase Auth (it applies its own migrations before it is healthy) and run `auth-grants`.
5. Start the other services (`crove-extract`, `crove-media`, Mailpit, anything from `compose.host.yml`).
6. Roll the app. With separate `worker` and `api` services, the **worker first**: it must still be running after `CROVE_WORKER_SETTLE` seconds (15), then the API. With the all-in-one `crove` service (the default `docker-compose.yml`, for a laptop), that one container; the pilot runs the separate services ([The pilot layout](#the-pilot-layout)). Toward an older build (usually a rollback, or the recovery after a failed deploy; also a deploy of an older tag), the **API first**, then the worker, still checked the same way, so a newer API does not serve beside an older worker (plan §3.5; its `/readyz` waits while a live worker runs an older build, #1952, #1965). Older is by the build time the image carries (`CROVE_BUILD_TIME`, recorded as `BUILD_EPOCH` in the release's `release.env`); between releases without one (images from before #1952), by when each was deployed. So a second rollback, back to the newer build, rolls the worker first again.
7. Wait for `/readyz` (`CROVE_READY_TIMEOUT`, 300 seconds): it answers 200 only when every migration in the image is in the ledger and the session check can read Supabase Auth's tables.
8. Start the prober (when its profile is on), then run the smoke test on the loopback port.
9. On success, record the release as current. On a failure in steps 4 to 8, deploy the release that ran before again (same steps without the migration), run the smoke test on it, and exit 1.

When `DEPLOY_PUBLIC_URL` is set, the workflow then runs the same smoke test through the public URL (DNS, TLS, reverse proxy). If that fails, it rolls back with `deploy.sh rollback` and the run fails.

Exit codes of `deploy.sh`: 0 done; 1 the deploy failed and the previous release serves again (or nothing was changed); 2 bad usage or configuration (missing env file, a deploy already running, no previous release to roll back to); 3 the deploy failed **and** the rollback failed: someone must look at the server.

## Production steps in the deploy: the context token key and the plain idempotency rows

Two security changes wait for a step on the pilot host (#3282, owner decision 2026-11-15): #1822 step 2 revokes `enter_context` and requires the context token key, and #1750 step 2 drops the legacy plain-hash idempotency branch and must not merge while plain rows exist. Nobody else has a shell on the host, so `deploy.sh deploy` performs both on the host itself, after the database is up and before `migrate`. The owner approves one deploy run; nothing is done by hand over SSH, and the key never leaves the server.

**The context token key** ([context-token-key.md](context-token-key.md) section 1 is the same step by hand).

- If the env file (`.env`, or `DEPLOY_ENV_FILE`) has no non-empty `CROVE_CONTEXT_TOKEN_KEY`, the deploy makes one with `openssl rand -base64 32` and writes it into that line (or adds the line). It reads the file like a dotenv file: the last assignment wins, `export` and spaces around `=` (or the colon form) are fine, `""`, `''` (with or without a comment after them), an empty value and a value that is only a comment are empty, a commented-out line and `CROVE_CONTEXT_TOKEN_KEY_FILE` are no assignment. A value it cannot judge counts as a key.
- **An existing key is never replaced.** A deploy with a key logs `context token key present` and changes nothing. Rotation stays a manual step ([context-token-key.md](context-token-key.md) section 2).
- The key is never printed, logged or passed as a command argument, and no other process gets it in its environment: it is held in one shell variable, written with the shell's own `printf` into a temporary copy of the env file (mode 600, in `.deploy/`, removed on every exit) and from there into the env file itself with `cat >`, which keeps the file's inode, owner and mode. The new copy is checked first (every line of the old file, the key line, nothing cut short by a full disk) and the old file is kept in a second mode 600 copy, put back if the overwrite fails. A `CROVE_CONTEXT_TOKEN_KEY` in the SSH session's environment is ignored: the env file is the one source. The log says only `context token key generated`, and then names the person step below.
- Before anything is pulled, a deploy whose env file has no key stops with exit 2 if `openssl` is missing or the deploy user cannot write the file. A key that cannot be made or written later stops the deploy before `migrate` (exit 1, the services untouched; the env file is as it was, or, if its rewrite failed halfway, the file is put back from the copy; only if that fails too, or the deploy is stopped by a signal during the overwrite, do both copies stay in `.deploy/` and the log names them).
- `migrate` then installs the key (its log says `context token key installed`; a later deploy says `context token key unchanged`), and the app's boot check confirms that the database holds the same key. A rollback (`deploy.sh rollback`, or the recovery after a failed deploy) leaves the key in the env file: with the release from before step 2 it is harmless, as [context-token-key.md](context-token-key.md) explains.
- **Person step, after the first deploy that logs `context token key generated`** (the owner, or whoever holds the secret store): copy the value from the env file on the host into the secret store. Open the file in an editor; do not `cat` it into a shared terminal or a ticket. Until it is in the secret store, a restore of the host has no copy of it. Check the deploy log: it must show `context token key generated` once, then `context token key present` on every later deploy.

**The plain idempotency rows** (#1750; the count that #1882 waits for).

- The deploy prints `plain idempotency rows: <n>`: the result of the read-only `SELECT count(*) FROM crove_kernel.idempotency_key WHERE NOT starts_with(request_sha256, 'k1:')`. It runs as the database superuser inside the `db` container (the table is under row-level security, so only a role that bypasses it counts every org), in a session that is read only and has a 30 second statement timeout. It changes nothing.
- **It never fails the deploy.** A count that did not run (the table is not there yet on a new host, the database refused, the answer was not a number) logs `plain idempotency rows: unknown (the count did not run; the deploy goes on)` with the start of the error, and the deploy goes on. The count is taken before this release's `migrate`, so it is the state the previous release left.
- Reading it: idempotency rows live 7 days, so the count falls to 0 within a week of a release that keys every row (#1742). **#1882 merges only after a deploy log shows `plain idempotency rows: 0`**; a number above 0 means the retention purge has not removed the old rows yet: do not merge, and deploy again later. Only `deploy` prints the count, a rollback does not; to get a fresh one, deploy the release that runs again.
- Nothing to roll back: the count changes nothing.

## Identity provider settings in the deploy (#2704)

Opt-in. A pilot that signs in at a remote identity provider (Supabase Auth, [pilot-sign-in-remote-idp.md](pilot-sign-in-remote-idp.md)) needs a few lines in the host's env file. No agent has a shell on the host, so the deploy can write them: when the GitHub environment opts in and defines the settings below, the workflow checks them, sends them to the host with the release, and `deploy.sh deploy --auth-settings <file>` edits the env file. Without the opt-in the env file is never edited (apart from the context token key) and nothing below applies.

**Define all of these in the environment itself (`pilot`), never at repository or organization level**: a variable or secret of the repository or organization falls back into every environment, and these names would then reach an environment that did not ask for them. The names carry a `DEPLOY_IDP_` prefix (the lines they become keep the kernel's own names, which another project of the organization may use for its own purposes), and the settings apply only where `DEPLOY_IDP_ENVIRONMENT` is exactly the name of the environment being deployed. Defined without it (or with another name) they are ignored and the run says so in a notice.

| Name | Kind | Value |
|---|---|---|
| `DEPLOY_IDP_ENVIRONMENT` | variable | the opt-in: the name of the environment (`pilot`) |
| `DEPLOY_IDP_AUTH_ISSUER`, `DEPLOY_IDP_AUTH_JWKS_URL`, `DEPLOY_IDP_PUBLIC_AUTH_URL`, `DEPLOY_IDP_PUBLIC_AUTH_ANON_KEY` | variable | the line `AUTH_ISSUER` (the provider's token issuer), `AUTH_JWKS_URL` (its keys), `PUBLIC_AUTH_URL` (its Auth URL) and `PUBLIC_AUTH_ANON_KEY` (its publishable key): public values. All four, and the secret below, are required once the opt-in is set |
| `DEPLOY_IDP_AUTH_ALLOWED_EMAILS` | **secret** | the line `AUTH_ALLOWED_EMAILS`, who may use the deployment: addresses and `@domain` entries, comma or space separated (addresses are private, so it is a secret) |
| `DEPLOY_IDP_AUTH_OAUTH_PROVIDERS` | variable | optional: the line `AUTH_OAUTH_PROVIDERS`, provider ids for the sign-in buttons |
| `DEPLOY_IDP_AUTH_HOSTED_LOGIN_URL`, `DEPLOY_IDP_AUTH_HOSTED_LOGIN_TOKEN_URL`, `DEPLOY_IDP_AUTH_HOSTED_LOGIN_NAME` | variable | optional: the lines `AUTH_HOSTED_LOGIN_*`: the hosted sign-in page and token endpoint (both or neither) and the button's words (only with them) |

**What it does to the env file.**

- Sets the lines it was given, plus `AUTH_SESSION_CHECK=jwt` and an empty `AUTH_UPSTREAM_URL=` (no bundled proxy).
- Removes every assignment of those names and of `AUTH_SIGNUP_POLICY`, `AUTH_SIGNUP_ALLOWED_DOMAINS` and `PROBER_AUTH_URL`. The optional settings the environment does not define leave the file too: the environment is the truth.
- Leaves every other line alone, `AUTH_JWT_SECRET` and comments included. It writes into the file itself (the inode, owner and mode stay), after the migration and right before the services are recreated, so the worker, the API and the prober start with the new settings.
- Before writing, it keeps a dated copy next to the file (`<env file>.bak-<UTC time>-<random>`, mode 600; it holds the old secrets, so clean it up when it is no longer needed). A deploy that finds the file already holding exactly these settings writes nothing and makes no copy.
- Keeps the newest `CROVE_KEEP_ENV_BACKUPS` (default 5) dated copies and the one a rollback needs (so up to one more), and removes the rest. Files next to the env file named `<env file>.bak-<UTC time>Z-<random>` are taken for these copies: do not name a copy of your own that way.
- Before anything is pulled it also checks that the env file and its directory are writable by the deploy user (exit 2 if not), and that the provider answers: `AUTH_JWKS_URL` returns a JSON Web Key Set and `PUBLIC_AUTH_URL/health` answers 200 with GoTrue's own answer (a page of this API, from an Auth URL that is the API's address by mistake, is refused) to the publishable key (sent in a header file, not on a command line). The keys must hold at least one EC or RSA key. The probe speaks https only and follows no redirect. Well-formed but wrong values (the project URL without `/auth/v1`, a typo in the keys path) stop the deploy there with exit 1 and nothing changed, instead of booting and locking everyone out. The settings file the workflow uploads (in the release's private incoming directory) is removed from the host as soon as it has been read, valid or not; a file anywhere else named with `--auth-settings` is only read, and the env file or the compose file is refused.

**Checks before the host is touched.** The workflow and `deploy.sh` (again, on the host) refuse the deploy, with exit 2 and the name of the setting (never its value), unless: every address is `https` with a host name (no IP address, `localhost` or `*.localhost`), a plain path and no query, fragment or user; the issuer and the JWKS address have the same origin (`:443` counts as the default port); the publishable key is 16 to 2048 characters of letters, digits, `.`, `-` and `_`; every provider id is `[a-z][a-z0-9_]{0,31}` (at most 12; commas or spaces between them); every allowed entry is an address or `@domain` (at most 200; commas or spaces between them, like the kernel); the two hosted-login addresses come together; and the button's words are at most 40 characters (the kernel's limit) with no quote, backslash, `$`, backtick, `#`, `=` or other character a shell or a dotenv file could act on. A value with a line break, or a name this list does not have, is refused too, so a value cannot add a line of its own. The settings are never given to a process as an argument, on the runner or on the host (the file is checked with shell builtins only), with one exception: the probe passes the two public addresses `AUTH_JWKS_URL` and `PUBLIC_AUTH_URL` to curl, and the publishable key goes in a header file. The allowed addresses (the secret) never leave the file and the shell: the file is mode 600 in the release's private incoming directory, which the run removes at its end, and the host deletes it as soon as it has been read, valid or not (the uploaded file only). Because the log of a worker that refuses a bad entry would name it, and a deploy log may be public, a deploy whose env file sets `AUTH_ALLOWED_EMAILS` does not print the worker's log when it fails to stay up (read it on the host).

**Rollback.** When the deploy fails after the file was written (the release does not become ready, the smoke test fails, the compose files do not load) the dated copy is put back before the release before runs again, and the log says `restored ... (the identity provider settings are out again)`. `deploy.sh rollback`, which the workflow runs after a failed public smoke test, does the same when the release it leaves is the one that wrote the settings **and the env file is still exactly what that deploy wrote** (the deploy records a checksum): a file edited since (a rotated password, a new setting) is left as it is, and the log says so and names the copy from before. A rollback whose own roll fails puts the settings back, so the release it returns to runs with the file it was deployed with. A deploy of the same release again that changed nothing keeps the record; the same release deployed again with other settings keeps the copy from before its first deploy, unless the file was edited in between (then there is no record and a rollback leaves the file as it is); a later release's deploy without settings clears it, so the rollback leaves nothing to restore. Rollbacks are swaps: a second one (back to the release that was left) runs it with the settings of the file as it is then, not with the ones it was deployed with. If the copy cannot be put back, the exit code is 3 and the message names the copy: copy it over the env file by hand.

**The smoke test with a remote provider.** The kernel then has no `/auth/v1` proxy, so the smoke test skips `/auth/v1/health` and the smoke account's sign-in (the log says `smoke skipped`) and the prober watches the provider instead. The host's smoke test knows from the env file (`AUTH_UPSTREAM_URL` empty); the public one reads the deployed `/api/config`: an `authUrl` on another host than the public URL (case, scheme and a default port aside) **and** no `/auth/v1/health` answering at the public URL. A bundled Auth whose address only differs cosmetically is still checked as before. In the deploy that wrote the settings both also require `/api/config` to report exactly the `PUBLIC_AUTH_URL` it was given, so settings that did not take (an old container, a stale line) fail the test and roll back instead of passing with the proxy checks skipped. `/readyz`, `/version`, `/api/config` and the sign-in page are still checked.

## What the smoke test checks

`deploy.sh smoke <base url> [build id]` (it needs only bash and curl, so you can run it from any machine):

| Check | Why |
|---|---|
| `/healthz` answers `{"ok":true}` | the process serves |
| `/readyz` answers `{"ready":true}` | the schema is complete and Supabase Auth's grants are in place |
| with a build id: `/version` answers that `build` and `"migrationsMissing":[]` | the new image answers, not an old container that is still running, and its migrations are all in the ledger |
| `/api/config` answers with `authUrl` | the API and its configuration load |
| `/auth/v1/health` answers | Supabase Auth is reachable through the kernel's proxy, the path every sign-in takes |
| `/login` serves the app shell and its first script bundle loads | the sign-in page loads in a browser |

The workflow passes the release commit as the build id, to `deploy.sh deploy --build` (the smoke test on the host, recorded in the release's `release.env`) and to the smoke test through the public URL. A rollback checks the build of the release it returns to when that release was deployed with one; a release from before `/version` has none and skips the check.

With the smoke account set up (below), the workflow's smoke test through the public URL adds one more check:

| Check | Why |
|---|---|
| signs in with the smoke account's password, uploads one synthetic e-invoice XML into the smoke org, waits up to 2 minutes for the worker to turn it into a proposal, then rejects that proposal | sign-in, upload, the worker and `crove-extract` work end to end on the new release |

Without the account's secrets this check is skipped and the log says `smoke skipped: sign-in and upload`. It needs `jq` (GitHub's runners have it). The deploy's own smoke test on the host never runs it: a rollback must not depend on the smoke account, or a broken account would fail the rollback too. So it runs only through `DEPLOY_PUBLIC_URL`, and when it fails, the workflow rolls back like for any failed public check. The full flow (sign up, upload, approve, export) is still the Playwright suite, which must be green on the commit before the deploy starts.

### Smoke account

Off until the owner creates it (#690). Once per environment:

1. Create an account for it, such as `smoke@<your domain>`, with a long random password (`openssl rand -base64 24`), the way any user joins (sign-up while it is open, or an invite). Do not enroll a second factor: the check signs in with the password alone.
2. Signed in as that account, create its own org, for example `Ludy smoke test`, and note the org's slug (the part after `/o/` in the app's address). Nobody else joins it, and the account belongs to no other org: each deploy uploads a document into it and rejects the proposal.
3. In the GitHub environment (`pilot` or `beta`, section "Settings of each GitHub environment"), add the secrets `SMOKE_EMAIL` and `SMOKE_PASSWORD` and the variable `SMOKE_ORG` (the slug). `DEPLOY_PUBLIC_URL` must be set too.

The synthetic e-invoice has a made-up seller and buyer whose tax codes fail the checksum, and a new number each run, so it is never a duplicate. The smoke org counts in the weekly usage report like any org: one active org, one uploaded document and one rejected proposal per deploy. Read the report with `--by-org` and leave out the smoke org's row (its name) when you count the pilot's usage. To stop the check, delete the two secrets.

## Migrations are forward only

A rollback restores the **images and compose files** of the previous release. It never touches the schema: the database stays at the newer release's migrations. This is safe only because every migration keeps the release before it working:

- Add before you use, and remove only after nothing uses it (expand, then contract in a later release; plan §3.5, "Contract changes").
- A broken migration is fixed by a new migration, never by editing or reverting the applied file (AGENTS.md, "Schema only via migrations").
- The older release's `/readyz` still passes on the newer schema: it checks that its own migrations are in the ledger, not that there are no others.

## One-time setup of the host

The host is one Linux server with Docker Engine and the compose plugin **v2.24 or newer** (the deploy uses `!reset`), plus bash, curl and tar.

1. Create a deploy user (for example `crove-deploy`) in the `docker` group. Membership of `docker` is equivalent to root on that machine, so this user and its key are as sensitive as root.
2. Create an SSH key pair for the workflow (`ssh-keygen -t ed25519 -N '' -f deploy_key`). Put the public key in the deploy user's `~/.ssh/authorized_keys` with the `restrict` option (no port, agent or X11 forwarding, no terminal): `restrict ssh-ed25519 AAAA... crove-deploy`.
3. Create the stack directory, owned by the deploy user, mode 700: `/opt/crove` by default (`DEPLOY_DIR`).
4. Write the env file there as `.env` (or at `DEPLOY_ENV_FILE`), mode 600: start from `.env.example`, change every secret, and set at least `PUBLIC_URL` (the https address), `AUTH_AUTOCONFIRM=false` with a real SMTP server, `EXPORT_ENCRYPTION_KEY`, `BACKUP_ENCRYPTION_KEY`, `TRUSTED_PROXY_HOPS=1` behind the reverse proxy, `CROVE_MODULES=finance` and the `COMPOSE_FILE` of [The pilot layout](#the-pilot-layout). The pilot readiness checklist (M1-8, [pilot-readiness.md](pilot-readiness.md)) lists the rest, and `pnpm pilot:check` fails the settings it forbids.
5. Optional: `compose.host.yml` in the same directory (for example, to drop Mailpit's loopback port, which the default compose file publishes for local use: `services: { mailpit: { ports: !reset [] } }`) for local changes the release files must not overwrite (a reverse proxy service, extra volumes; the split `api` and `worker` have a file of their own, below). Services it adds that run the Ludy images use `image: ${CROVE_IMAGE}` and `${CROVE_EXTRACT_IMAGE}`, which the deploy sets to the release's digests (and which a plain `docker compose` there does not know: export them from `releases/<current>/release.env`, `IMAGE=` and `EXTRACT_IMAGE=`, first). `COMPOSE_PROFILES=prober` in the env file turns the prober on.
6. Put a TLS reverse proxy in front of `127.0.0.1:${PORT}` (the compose file publishes the port on loopback only). `tools/deploy/caddy/` holds one for this layout (a `compose.host.yml` and a `Caddyfile`); the whole server setup, from a fresh machine to the first deploy, is in [provision-pilot.md](provision-pilot.md).
7. Read the host key for the workflow from a trusted session on the server (`ssh-keyscan -t ed25519 localhost` on the host itself, then replace `localhost` with the address the runner uses; for a port other than 22 the line starts with `[address]:port`). Do not take it from a scan over the network you are trying to protect.

The first deploy creates `releases/`, `.deploy/` and the active compose files. After it, plain `docker compose` in the stack directory sees the same stack: `docker-compose.yml` is the running release's file and `docker-compose.override.yml` pins its images. With a `compose.host.yml`, add `COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml:compose.host.yml` (with the pilot's `compose.pilot.yml`, [below](#the-pilot-layout), in the order given there) to the env file so that plain `docker compose` includes it too (the deploy passes the files itself). The nightly backup ([backup-and-restore.md](backup-and-restore.md)) runs `tools/backup` from a checkout with `CROVE_DIR` set to this directory.

## The pilot layout

`docker-compose.yml` on its own is the laptop layout: one `crove` container runs the API and the worker together (`command: all`), with every module on. Its API process then holds the worker's database login (`WORKER_DATABASE_URL`, which enters the system context of every org) and every secret, and Social's public routes answer on the public address. A deployment other people reach (a pilot) runs this instead (#2118, from the outside review of 2026-10-29):

| | Laptop (`docker compose up`) | Pilot |
|---|---|---|
| Processes | one `crove` container, role `all` | `api` (HTTP edge) and `worker` (outbox, jobs, archive, extraction), same image |
| Database login of the API | `crove_app` and `crove_worker` | `crove_app` only: no `WORKER_DATABASE_URL`, no `EXTRACT_URL`, not on the `extract` network |
| Modules | every module | `CROVE_MODULES=finance` (kernel is always on) |
| Prober | asks `crove` | asks `api` |

`tools/deploy/compose.pilot.yml` makes the pilot layout. It extends the release's `crove` service, so every setting of `docker-compose.yml` reaches both services and nothing is copied; it moves `crove` behind the `all-in-one` profile and defaults `CROVE_MODULES` to `finance` for the API, the worker and the prober. Nothing in `docker-compose.yml` changes, so the laptop layout needs no new setting.

1. Nothing to copy: the file ships inside every release. The deploy workflow uploads `tools/deploy/compose.pilot.yml` next to the release's `docker-compose.yml`, and `deploy.sh` stages it in the release directory and makes it the host's active copy when it activates the release, so it is always the one that matches that release's `docker-compose.yml` (no host copy to keep in step, none to forget). Do not edit the host's copy: the next release replaces it, and `deploy.sh` says so in its log when the host's copy matches no release it staged (keep host settings in `compose.host.yml`). A release from before it existed (a rollback to one) keeps the host's copy.
2. In the env file set `CROVE_MODULES=finance` and list the file right after `docker-compose.yml`, before the pins: `COMPOSE_FILE=docker-compose.yml:compose.pilot.yml:docker-compose.override.yml:compose.host.yml`. That line is the host's choice of layout: `deploy.sh` passes `compose.pilot.yml` to every compose call, and pins `api` and `worker`, exactly when `COMPOSE_FILE` lists it, in that order (the file extends the release's `crove`, so the release's image pins must come after it). Take it out of `COMPOSE_FILE` to go back to one container (see below); the copy on the host then stays, unused.
   `deploy.sh` stops with exit 2, before it pulls anything, when `COMPOSE_FILE` names `compose.pilot.yml` and neither the release nor the host has the file; without that check a missing file would silently roll the all-in-one `crove`. The kernel guards the same line twice: it refuses to start the `all` role on a public `PUBLIC_URL` unless `CROVE_ALLOW_ALL_IN_ONE=true` (a deliberate opt-in for a self-hoster who accepts it; `pnpm pilot:check` fails it, and the laptop on `localhost` needs none), and it refuses to start the `api` role on a public `PUBLIC_URL` when `WORKER_DATABASE_URL` is set, so keeping the worker's login out of the API does not rest on how the container was composed (compose 2.24 or newer applying `!reset` under `extends`, a host file, an `env_file`).
3. Never put `all-in-one` or `*` in `COMPOSE_PROFILES`: that starts `crove` beside them, and `pnpm pilot:check` fails it (the kernel refuses it on a public `PUBLIC_URL` too, without the opt-in above).
4. On a host that already ran the all-in-one `crove` container, `deploy.sh` removes that container (`docker compose rm --stop --force crove`) before it rolls the worker and the API: left running, it would keep `127.0.0.1:${PORT}` so the new `api` could not bind it, and run the worker's jobs beside the new worker. The database volume is untouched. Do the same by hand (in `/opt/crove`) if you start the layout with plain `docker compose`.
5. In the pilot layout `deploy.sh` pins the release's image for `api` and `worker` in the generated `docker-compose.override.yml`, as it does for `crove`, so a plain `docker compose` in `/opt/crove` (a manual `up`, `exec`, `logs`, the restore script) runs the deployed digest. The pins follow the layout at the moment a release is activated, whatever it was staged under: going back to one container takes them out of the active override (and out of a release staged with them), so a bare `api` or `worker` is never defined, nor rolled, from a leftover pin.
6. Check, once, after the first deploy:

   ```bash
   docker compose ps --services                                    # api, worker, ... and no crove
   docker compose exec api printenv | cut -d= -f1 | grep -c '^WORKER_DATABASE_URL$'   # 0
   docker compose exec worker printenv | cut -d= -f1 | grep -c '^CROVE_MODULES$'      # 1
   ```

A deployment without docker compose (Kubernetes, systemd) runs the same two roles from the one image (`api` and `worker` as the container command) and gives the worker, and only the worker, `WORKER_DATABASE_URL`, `EXTRACT_URL` and the archive settings. It names the roles in `CROVE_ROLES=api,worker` so `pilot:check` can tell.

The nightly backup and a restore name `crove` by default; on this layout set `BACKUP_FILES_SERVICE=worker`, `BACKUP_NODE_SERVICE=worker` and `RESTORE_FILES_SERVICE=worker` ([backup-and-restore.md](backup-and-restore.md), "Set up").

CI boots this layout on every pull request (`ci.yml`, job "Split api and worker on S3", step "Boot the pilot layout"; `tools/e2e/pilot-stack.mjs`): `docker-compose.yml` and `compose.pilot.yml` laid out as on a host, `api` and `worker` apart, the API without the worker login or the sandbox, finance only, and an uploaded e-invoice read by the worker through the shared `files` volume. `tools/test/pilot-compose.test.ts` checks the resolved configuration; the boot checks that it runs.

What this layout trims, and what it does not (#2130). Besides the worker's database login and the sandbox, the API container does not get what only the worker reads: the WORM archive settings (`ARCHIVE_*`, as one group) and the `archive` volume, the per-org daily limits (`ORG_LIMIT_*`), the transcription key and mode, and a few worker knobs; the worker does not get the MCP endpoint's authorization server settings (`OAUTH_SERVER`, `OAUTH_JWKS`, `OAUTH_COOKIE_KEYS`, `MCP_ALLOWED_ORIGINS`). The exact lists are in `tools/deploy/compose.pilot.yml` and pinned by `tools/test/pilot-compose.test.ts`, which also boots both roles' configuration on what they are left with. The API **keeps** the S3 credentials, the channel app secrets and the credential key (and the `keys` volume): it reads them for uploads, webhook signatures, the connect flows and the channel broker, so taking them away would break those. Every other setting still reaches both containers, and a new one stays on both until it is sorted into one list in that test.

Going back to one container (a laptop, a test) is taking `compose.pilot.yml` out of `COMPOSE_FILE` and deploying (or `deploy.sh rollback`): the pins leave with it, `crove` is the app again, and the database stays. Run `docker compose rm --stop --force api worker` first, in `/opt/crove` and **before** you take the file out of `COMPOSE_FILE`: once it is out, compose no longer knows `api` and `worker`, so the command cannot name them, and the two old containers keep the port. `deploy.sh` does not do this for you (it removes the old `crove` going the other way, because `crove` stays defined in the pilot layout; the two split services do not stay defined going back, and `deploy.sh` has not been run against a real host to automate it safely, #2162).

Two more settings keep a pilot safe by default and are checked by `pnpm pilot:check` on a public `PUBLIC_URL`: `BACKUP_ENCRYPTION_KEY` (the backup bucket never holds the books unsealed) and a price in `AI_PRICE_INPUT_PER_MTOK` or `AI_PRICE_OUTPUT_PER_MTOK` whenever `AI_API_KEY` is set (without one the AI cost cap `ORG_LIMIT_AI_COST_PER_DAY` and the monthly AI budget count nothing; `AI_DEFAULT_MONTHLY_BUDGET` gives every org without a budget of its own a monthly one in the same unit). The kernel itself also refuses to start on a public `PUBLIC_URL` when a database URL (`DATABASE_URL`, `WORKER_DATABASE_URL`, `ADMIN_DATABASE_URL`, `DATABASE_LISTEN_URL`) carries one of the passwords this repository ships in `.env.example` and the compose fallbacks.

## Settings of each GitHub environment

Create the environment (`pilot`, later `beta`) under Settings, Environments. A run that references it before it exists creates it without protection rules, so set these up first. The workflow refuses a pilot run whose commit is not on `main`, but a check inside a workflow does not hold against someone who can push an edited workflow; these settings are the real boundary, so they are required:

- **Deployment branches and tags** (required): "Selected branches and tags", with the tag rule `v*` and the branch `main` for `pilot` (the branch is for rollback runs started from `main`), and the branch `dev` (and, if you want, the tag rule `v*`) for `beta`.
- **Tag protection** (required): a repository ruleset that lets only maintainers create, update or delete tags matching `v*`. Pushing such a tag is a production deploy.
- **Required reviewers** (recommended): the owner approves each pilot deploy and rollback with one click.

| Name | Kind | Required | Value |
|---|---|---|---|
| `DEPLOY_HOST` | secret | yes | the server's host name or IP address |
| `DEPLOY_USER` | secret | yes | the deploy user, for example `crove-deploy` |
| `DEPLOY_SSH_KEY` | secret | yes | the private key from step 2 (the whole file) |
| `DEPLOY_KNOWN_HOSTS` | secret | yes | the host key line(s) from step 7 |
| `DEPLOY_PORT` | variable | no | SSH port, default `22` |
| `DEPLOY_DIR` | variable | no | stack directory on the host, default `/opt/crove` |
| `DEPLOY_ENV_FILE` | variable | no | env file on the host, default `<DEPLOY_DIR>/.env` |
| `DEPLOY_PUBLIC_URL` | variable | no | the public origin, for example `https://crove.example.com`, for the smoke test through the proxy |
| `DEPLOY_REQUIRED_CHECKS` | variable | no | check runs that must be green on the commit, one per line |
| `DEPLOY_IDP_ENVIRONMENT`, `DEPLOY_IDP_AUTH_*` and `DEPLOY_IDP_PUBLIC_AUTH_*` (variables), `DEPLOY_IDP_AUTH_ALLOWED_EMAILS` (secret) | variable and one secret | no | the pilot's remote identity provider (section "Identity provider settings in the deploy"); in the environment only, never at repository or organization level |
| `SMOKE_EMAIL`, `SMOKE_PASSWORD` | secret | no | the smoke account (section "Smoke account"); without them the public smoke test does not sign in |
| `SMOKE_ORG` | variable | with the two above | the smoke org's slug |

The images go to the repository's GHCR packages with the run's own token, so no registry secret is needed. The deploy job's token can only read packages; only the build job, which never talks to the host, can push.

## Pre-deploy checks

Some migrations tighten a rule on data that already exists. Before tagging the first release that contains one, run its read-only check against the environment's database (`psql` as any role that can read the tables, inside a `READ ONLY` transaction). If a check lists anything, **stop**: do not tag the release, and raise it on the migration's issue. Nothing here changes data.

### Amounts the book currency cannot hold (#1282, `20261030002100_crove_finance_currency_scale.sql`)

From this migration on, `post_journal_entry()` refuses an amount with more decimals than the org's book currency uses (VND has none). An entry posted earlier with a fraction of a dong could then never be reversed or replaced, since its mirror carries the same fraction, and a purchase document with one could not be posted again. The check lists journal lines with more decimals than their org's book currency, and purchase documents and lines with fractional VND amounts (a purchase document's amounts are in VND, #918). It must return no rows:

The check runs before the release's migrations, so `crove_kernel.currency` does not exist yet; every org books in VND until a command sets another `base_currency`, so the journal part uses the VND rule:

```sql
BEGIN READ ONLY;
SELECT 'journal_line' AS source, l.org_id, l.entry_id AS id, l.line_no, 'VND' AS currency, l.debit, l.credit
FROM crove_finance.journal_line l
WHERE l.debit <> pg_catalog.round(l.debit, 0) OR l.credit <> pg_catalog.round(l.credit, 0)
UNION ALL
SELECT 'purchase_document', d.org_id, d.id, NULL, 'VND', d.subtotal, d.total
FROM crove_finance.purchase_document d
WHERE d.subtotal <> pg_catalog.round(d.subtotal, 0) OR d.vat_amount <> pg_catalog.round(d.vat_amount, 0)
   OR d.total <> pg_catalog.round(d.total, 0)
UNION ALL
SELECT 'purchase_line', p.org_id, p.document_id, p.line_no, 'VND', p.amount, p.vat_amount
FROM crove_finance.purchase_line p
WHERE p.amount <> pg_catalog.round(p.amount, 0) OR p.vat_amount <> pg_catalog.round(p.vat_amount, 0);
ROLLBACK;
```

After the migration has run, the journal part can use each org's book currency instead: select `t.base_currency AS currency` in place of `'VND' AS currency`, and use `JOIN crove_kernel.tenant t ON t.org_id = l.org_id LEFT JOIN crove_kernel.currency c ON c.code = t.base_currency WHERE c.code IS NULL OR l.debit <> pg_catalog.round(l.debit, c.minor_units) OR l.credit <> pg_catalog.round(l.credit, c.minor_units)`. That post-migration form is the one `apps/kernel/test/finance-currency-scale.db.test.ts` runs.

### Every org has a default legal entity (#1280, `20261102140000_crove_finance_legal_entity_scope.sql` and `20261102150000_crove_finance_legal_entity_books.sql`)

These migrations put every finance row, and every org's period lock row, in its org's default legal entity, then make `legal_entity_id` NOT NULL. An org without a default entity would leave its rows NULL, `SET NOT NULL` would fail, and the deploy would stop on the old release. `20261030001000_crove_kernel_legal_entity.sql` created one for every org and `create_or_replay_org` creates one with every new org, so the check should be empty. It must return no rows:

```sql
BEGIN READ ONLY;
SELECT t.org_id, t.slug, t.status
FROM crove_kernel.tenant t
WHERE NOT EXISTS (SELECT 1 FROM crove_kernel.legal_entity e WHERE e.org_id = t.org_id AND e.is_default);
ROLLBACK;
```

Both migrations rewrite or alter the finance tables under ACCESS EXCLUSIVE locks until they commit (a few hundred milliseconds for a few thousand journal lines in testing). On a large ledger, deploy them in a quiet window.

### No large relay hold pending (#1782, `20261104020000_crove_kernel_relay_hold_mark.sql`)

This migration adds `outbox_pending.held_type` and builds an index on the pending queue. Its header says the index is built under a SHARE lock, but that is wrong: `ADD COLUMN` takes an ACCESS EXCLUSIVE lock on `crove_kernel.outbox_pending` and keeps it until the migration commits. So the index is built under that lock, and for that time everything that touches the pending queue waits: `crove_kernel.emit()` (every command that emits an event), the relay's claim and its back-pressure lag (`outbox_lag_seconds`), the prober's `crove_kernel.health()`, the org purge and `pnpm ops:kill-switch status`. The build takes about as long as an index on the queue's rows: well under a second for a few thousand, longer for a held backlog of hundreds of thousands. Before tagging the first release that contains it, check that no `relay:<event type>` kill switch is holding a large backlog (`pnpm ops:kill-switch status`, [incidents.md](incidents.md) §7), and release or let drain any that is. Where the column `crove_kernel.outbox_pending.held_type` already exists, the migration has run there and there is nothing to check. The pending queue should be short (a few thousand rows at most):

```sql
BEGIN READ ONLY;
SELECT pg_catalog.count(*) AS pending FROM crove_kernel.outbox_pending;
ROLLBACK;
```

### A purchase or sale document is posted once (#1928, `20261107110000_crove_finance_document_one_revision.sql` and `20261107120000_crove_finance_document_one_revision_validate.sql`)

The first migration adds the CHECK `journal_entry_document_one_revision` to `crove_finance.journal_entry`: an entry whose source is a purchase or sale document (`source_type = 'finance.purchase_document'`, sales included) is revision 1. It is added `NOT VALID`, so it holds every new row at once. The second migration then validates it against the rows already there.

- No code path has ever posted a document's revision 2, so the check should be empty.
- A row it lists was written outside the posting path. Such a row would also count in the ledger while its document stays voided, out of the VAT working and the MISA exports.

Run it as the database owner. `journal_entry` is under tenant row-level security, so a login role without an org context sees no rows, and the check would pass falsely. On an environment without the column `source_revision` (before `20261031000000_crove_finance_source_revision.sql`), the query fails on the missing column: every entry there is revision 1, so there is nothing to check. It must return no rows:

```sql
BEGIN READ ONLY;
SELECT org_id, id, source_id AS document_id, source_revision, entry_date, created_at
FROM crove_finance.journal_entry
WHERE source_type = 'finance.purchase_document' AND source_revision > 1
ORDER BY org_id, created_at;
ROLLBACK;
```

If it lists rows, **stop**:
- Do not tag the release. Raise them on #1928, with the org, the document and the entry of each row.
- Do not delete or edit them: journal entries are append-only, and the WORM archive anchors them.
- The books cannot clear them either, so the validation would fail again on every deploy:
  - a reversal does not remove the row;
  - a reversal of revision 2 would need a second void of the document, which `purchase_document_void` (one per document) refuses.
- The way out is a decision for the owner (with the accountant, #61, for the books), then a forward migration, tracked on #1928. For example, the validation could name the rows it accepts as they are.

If a release with these migrations runs anyway:
- The first migration commits, so no new revision 2 can be written.
- The second fails on the check violation, and the deploy stops on that migration.
- That half state refuses every new revision 2 and loses nothing. It stays until the forward migration above lands.

## Upgrade notes

Settings whose meaning changes between releases, to read before tagging the first release that contains the change. Nothing here changes data.

### The prober's check of the archive's verification marker needs a key of its own (#2082, #2098, #2108)

New in the first release after v0.1.1: the prober reads the newest verification marker from the WORM archive store and alerts when the nightly verification has not passed ([worm-archive.md](worm-archive.md)). It affects only a deployment with `ARCHIVE_STORE=s3`; a local archive (`ARCHIVE_STORE=local`, the default) is read from the archive volume and needs nothing.

- With `ARCHIVE_STORE=s3` the prober needs a key of its own that only reads: `PROBER_ARCHIVE_S3_ACCESS_KEY_ID` and `PROBER_ARCHIVE_S3_SECRET_ACCESS_KEY` (list and list versions on the bucket, get on `verify/*` and `chain/*`). Never the worker's own `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`.
- The SDK's default credential chain (an instance or task role) is used only when `PROBER_ARCHIVE_S3_DEFAULT_CHAIN=true` says so, with the prober running under a role that only reads. On a host where the worker and the prober share the default chain, that gives the prober the worker's role, which writes the archive: use the pair.
- With neither the pair nor the opt-in, the marker check is disabled and the prober alerts `archive_marker` on every probe (exit code 1, repeated every `ALERT_REPEAT_MINUTES`) until one of them is set. The other checks, the backup alerts and the test alert are not affected.
- Before tagging the release, set it in the host's `.env` (or `DEPLOY_ENV_FILE`). Check: `pnpm pilot:check` reports a prober with neither, and asks you to confirm the role when the worker and the prober share the default chain. The prober's start line says `with the prober's own key` or `with the default credential chain`.

## Deploy a release

1. Merge to `main` and wait for CI. Run the [pre-deploy checks](#pre-deploy-checks) of every migration the release adds that has one. Read the [upgrade notes](#upgrade-notes) for settings the release changes.
2. Tag the commit and push the tag: `git tag v0.3.0 <commit>` then `git push origin v0.3.0`. (Or create a release with that tag in the GitHub interface.)
3. The `deploy` workflow runs. Its summary shows the image digests, the result on the host and the public smoke test.

To deploy an existing tag again, run the workflow by hand from that tag (Actions, deploy, Run workflow, "Use workflow from" the tag, action `deploy`).

## Roll back

From GitHub: Actions, deploy, Run workflow from `main`, pick the environment and the action `rollback`. It redeploys the release that ran before the current one, with its images (pulled again by digest if they are no longer on the host) and compose file, and runs the smoke test. Running it again returns to the release you left.

From a shell on the server, the same in one command:

```
bash /opt/crove/.deploy/deploy.sh rollback --dir /opt/crove
```

This one has no registry credentials, so it needs the previous images on the host: do not run `docker image prune -a` (or `docker system prune -a`) there, which removes them. Plain `docker image prune` (dangling images only) is safe.

`bash /opt/crove/.deploy/deploy.sh status --dir /opt/crove` shows the current and previous releases and the last lines of `.deploy/history.log`. The host keeps the last 5 release directories (`CROVE_KEEP_RELEASES`); a rollback reaches only the one before the current. To go further back, run the workflow by hand from an older tag: it builds that tag again (new digests) and deploys it like any release, migrations included (they are already applied, so nothing changes in the schema).

## When a deploy fails

- **Exit 1 at the pull, compose check or migration:** nothing was restarted. Read the run log; for a failed migration, fix it with a new migration and release again.
- **Exit 1 after the rollout:** the previous release serves again. The log shows which step or smoke check failed (`smoke failed: ...`, `not ready after ...`, the worker's last log lines).
- **Exit 3:** the deploy and the rollback both failed. On the server: `docker compose ps` and `docker compose logs --tail 100 crove auth` in the stack directory, and `/readyz` (`curl -s http://127.0.0.1:8080/readyz`) for the reason (`database`, `schema`, `auth_grants`).
- **The run was cancelled or the connection dropped:** the script on the host ignores the hangup and finishes, so the result is in `.deploy/history.log` (`deploy.sh status`). A run stopped by a signal is logged there as "interrupted"; check `docker compose ps` and deploy or roll back again.
- **"another deploy (pid N) is running":** a deploy holds the lock `.deploy/lock`. A lock whose process is gone is removed by the next run.
