<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Runbook: turn on CRM and Social (with the inbox) on the pilot

Owner decision 2026-11-13, in the Engage PO's chat: the pilot runs CRM and Social, with its inbox, next to Finance. Until now it ran `CROVE_MODULES=finance` only ([deploy.md](deploy.md), "The pilot layout", #2118). This runbook is the step list for that change. It is not the approval to run it: the operator runs it only after the owner approved this list in the running PO session's chat (AGENTS.md, "Production, secret and credential steps").

Public repository rule: no secret, app id, Page id, OA id, token or internal host appears in this file, an issue, a PR or chat. Every value is named by the setting it goes in.

## Who does what

- **[PERSON]** needs the owner's login: the Meta and Zalo developer consoles, the secret manager that holds the existing app secrets.
- **[OPERATOR]** has SSH to the pilot host (the stack directory `/opt/crove`) and runs the shell steps. Secrets are typed or pasted into `.env` there, never into chat.
- **[CHECK]** must be true before going on. On a failed check, stop and go to "Roll back".

## What changes, and the risk the owner accepted

- The API answers Social's public routes on the public address: link-in-bio pages, short links (`/l/<code>`), calendar and RSS feeds, and the channel webhooks (`/api/channels/facebook/webhook`, `/api/channels/zalo/webhook`). This is what the finance-only default kept closed (outside review of 2026-10-29, #2118). Each route is covered by the invariant suite and the RLS matrix in CI, and none of them signs anyone in.
- The worker starts Social's jobs (publish queue, evergreen and recurring posts, digests, reports, feeds) and CRM's (the daily sweep of stale imports).
- The database does not change: every module's migrations already run on every deploy, whatever `CROVE_MODULES` says. Rolling back is a setting, not a data change.
- No channel posts or replies on its own: a person connects each channel and approves each post and reply.

## 0. Before you start

1. **[CHECK]** the pilot runs `v0.3.1` or newer: `curl -s <PUBLIC_URL>/version`.
2. **[CHECK]** last night's sealed backup exists ([backup-and-restore.md](backup-and-restore.md)); take one by hand if it does not.
3. **[CHECK]** the API and the worker share one credential key, which seals channel tokens ([credential-key.md](credential-key.md)). In the pilot layout both mount the `keys` volume, so either `CREDENTIAL_KEY` is set in `.env` (both read it) or both read `/data/keys/credential.key`:

   ```bash
   docker compose exec api sha256sum /data/keys/credential.key
   docker compose exec worker sha256sum /data/keys/credential.key   # the same sum
   ```

   Back the key up apart from the database backups if that is not done yet.

## 1. The channel apps (only for the channels you connect now)

CRM needs none of this. Social and its inbox work without any channel app (drafts, the calendar, the bio page), but connect no account until its app is set.

1. **[PERSON]** find the existing Meta and Zalo apps and their secrets in the secret manager. For each app, in its developer console, add Ludy's addresses:
   - OAuth redirect: `<APP_URL>/channels/oauth/<provider>/callback` (`<provider>` is `facebook_page`, `instagram`, `threads` or `zalo_oa`; [social-live-check.md](social-live-check.md)).
   - Meta webhook (Page and Instagram objects): `<PUBLIC_URL>/api/channels/facebook/webhook`, with the verify token of step 2 ([facebook-conversations-live-check.md](facebook-conversations-live-check.md), section 0).
   - Zalo OA webhook: `<APP_URL>/api/channels/zalo/webhook` ([zalo-conversations-live-check.md](zalo-conversations-live-check.md), section 0).
2. **[OPERATOR]** in `/opt/crove/.env`, set the settings of those apps (names in `.env.example`): `CHANNEL_META_APP_ID`, `CHANNEL_META_APP_SECRET`, `CHANNEL_META_WEBHOOK_VERIFY_TOKEN` (a fresh random token), `CHANNEL_INSTAGRAM_APP_ID` and `CHANNEL_INSTAGRAM_APP_SECRET` when Instagram uses its own app, `CHANNEL_ZALO_APP_ID`, `CHANNEL_ZALO_APP_SECRET`, `CHANNEL_ZALO_OA_SECRET_KEY`. Leave `CHANNEL_FACEBOOK_HISTORY` and `CHANNEL_ZALO_HISTORY` off until their live checks pass.

## 2. Turn the modules on

1. **[OPERATOR]** in `/opt/crove/.env`: `CROVE_MODULES=finance,crm,social`.
2. **[OPERATOR]** check the settings before restarting: `pnpm pilot:check` with the same `.env` ([pilot-readiness.md](pilot-readiness.md)). **[CHECK]** no new `FAIL` line; `Modules` reads `CROVE_MODULES=finance,crm,social`.
3. **[OPERATOR]** recreate the worker first, then the API (the order `deploy.sh` uses), in `/opt/crove`:

   ```bash
   docker compose up -d --no-deps worker
   sleep 15 && docker compose ps worker        # still running
   docker compose up -d --no-deps api prober
   ```

4. **[CHECK]** `curl -s <PUBLIC_URL>/readyz` answers ready, and `curl -s <PUBLIC_URL>/api/config` lists `crm` and `social` in `modules`.

## 3. See it work

1. **[PERSON]** sign in at `<APP_URL>`: the app switcher shows CRM and Social next to Finance.
2. **[PERSON]** in CRM, add a contact and a quote, open its PDF, and send its link to your own address.
3. **[PERSON]** in Social, connect one channel whose app was set in section 1, then follow that channel's live check runbook for the first real post or message. Each runbook has a results table; fill it in on its issue (#236 for connect, #591 for the apps).
4. **[OPERATOR]** watch the logs for ten minutes: `docker compose logs --since 10m worker api | grep -iE 'error|refused'`. **[CHECK]** nothing new.

## Roll back

1. **[OPERATOR]** set `CROVE_MODULES=finance` in `.env` and run section 2 step 3 again.
2. Data stays: contacts, quotes, posts and connections remain in the database and come back when the modules are turned on again. Queued Social posts do not go out while Social is off.
3. Say on the PO's chat what failed and at which step.
