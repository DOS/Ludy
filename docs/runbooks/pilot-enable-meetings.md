<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Runbook: turn on Ludy Biên bản / AI Meeting Notes (`meetings`) on the pilot

Issue [#4615](https://github.com/DOS/Ludy/issues/4615). Enables the core `meetings` module (`Ludy Biên bản` / `AI Meeting Notes`, app-switcher entry `Cuộc họp` under `Cộng tác` / `Teamwork`) on the pilot alongside the pilot's currently active modules through the opt-in GitHub Actions deploy environment variables (`DEPLOY_MODULES_ENVIRONMENT` and `DEPLOY_CROVE_MODULES` / `DEPLOY_LUDY_MODULES`, [#3531](deploy.md#module-settings-in-the-deploy-3531)), with all meetings AI switches kept **OFF** by default. No manual SSH session on the pilot host is needed.

This runbook is a Production environment configuration step ([contributing.md](../contributing.md#production-secret-and-credential-steps)): run it only after the owner (JOY) explicitly approves this concrete step list in the running Product Owner chat, one approval per run, stopping on the first failed check.

Public repository rule ([AGENTS.md](../../AGENTS.md)): no secret, token, Supabase project reference, internal hostname, IP address, or real customer data belongs in this file, an issue, a PR, or chat.

## Who does what

- **[OWNER]** (JOY) approves the concrete step list in the running Product Owner chat, sets (or approves setting) the GitHub environment variables in `Settings -> Environments -> pilot`, and runs the manual UI smoke test using synthetic test audio only.
- **[OPERATOR]** (or the coordinator / Product Owner with JOY's one-time approval) checks prerequisites, validates the unioned module list locally, triggers the `deploy` workflow on the target `v*` tag, and checks workflow logs and public endpoints.
- **[CHECK]** must hold before moving to the next step. If any check fails, stop immediately and follow [3. Roll back](#3-roll-back).

## What changes (core enabled, AI switches OFF)

- **Deployment module list (`#3531` + `LUDY_MODULES` / `CROVE_MODULES` dual support):**
  - `.github/workflows/deploy.yml` reads `${{ vars.DEPLOY_LUDY_MODULES || vars.DEPLOY_CROVE_MODULES }}` when `DEPLOY_MODULES_ENVIRONMENT=pilot`, validates the list via `tools/deploy/deploy.sh check-modules`, and writes `LUDY_MODULES=<existing_modules>,meetings` into the host env file (replacing any legacy `CROVE_MODULES` or existing `LUDY_MODULES` line).
  - `tools/deploy/compose.pilot.yml` (`LUDY_MODULES: ${LUDY_MODULES:-${CROVE_MODULES:-finance}}`) and `apps/kernel/src/config.ts` (`checkEnvPair`) support both `LUDY_MODULES` and `CROVE_MODULES` across the `api`, `worker`, and `prober` services (refusing conflicting values if both are set differently).
  - Always set the **union** of currently active pilot modules plus `meetings` (for example `finance,crm,social,sign,meetings`, or appending `,meetings` to whatever modules `/api/config` currently serves). Never overwrite active modules with a static subset.
- **Core features enabled with AI off:**
  - Under `Cộng tác` (`Teamwork`) in the app switcher, signed-in `owner`, `admin`, and `member` users gain `Cuộc họp` (`/o/<slug>/meetings`, `/o/<slug>/meetings/record`, `/o/<slug>/meetings/$id`, and printable A4 `/o/<slug>/print/meeting-minutes/$id`; `viewer` users cannot create or read meetings).
  - Core workflows run deterministically with zero AI calls: in-app microphone/camera recording, audio upload (and audio extraction from video files up to the pilot cap), mandatory recording consent confirmation, per-meeting AES-256-GCM encryption and crypto-shredding on delete, manual rough notes (`Ghi chú của tôi`), manual summary / decisions / action items and task creation, built-in and company minutes templates (`Loại cuộc họp`, configured in `Settings > Ứng dụng`), printable A4 `Xem biên bản`, and per-org toggle in `Settings > Ứng dụng` ([ADR-0053](../adr/0053-per-org-app-enablement.md)).
- **AI switches stay OFF by default:**
  - `MEETINGS_SUMMARY=off` and `MEETINGS_TRANSCRIBE=off` remain off, and `MEETINGS_TRANSLATION_LANGUAGES` stays unset/empty (no `zh`, `ja`, or `ko`).
  - With AI off, no "Nhờ Vy ghi lời", "Nhờ Vy tóm tắt", AI translation, or Vy meeting-insight buttons appear, and `meetings` makes zero model calls and incurs zero AI spend.
  - Enabling AI summary, transcription, or target translation languages requires a separate owner-approved Production run under [meetings-ai.md](meetings-ai.md), and speech-to-text transcription remains gated on the lawyer review of recording consent and cross-border voice transfer in [#2585](https://github.com/DOS/Ludy/issues/2585) (plus eval recordings).
- **Zero unauthenticated public routes by default:** When `ZOOM_WEBHOOK_SECRET_TOKEN` is unset (the default), `meetings` exposes zero unauthenticated public HTTP routes or webhooks (`apps/kernel/test/invariant/route-coverage.test.ts`).
- **Database migrations already apply:** `ludy_meetings.*` migrations run on every deploy regardless of `LUDY_MODULES` / `CROVE_MODULES`. Toggling `meetings` off leaves `ludy_meetings.*` rows, per-meeting keys, consent records, and encrypted media blobs intact.

## 0. Prerequisites

1. **[CHECK] Inspect the currently serving release and active modules before changing anything:**

   ```bash
   curl -fsS <PUBLIC_URL>/version
   curl -fsS <PUBLIC_URL>/api/config
   ```

   - Confirm `/version` reports the target `build` commit SHA on `main` (carrying `meetings`, `#3531`, and `ludy_meetings` schema support) with `"migrationsMissing":[]`.
   - Record every non-`kernel` module currently listed in `/api/config`'s `"modules"` array and verify it against `Settings -> Environments -> pilot` (`DEPLOY_CROVE_MODULES` / `DEPLOY_LUDY_MODULES`).
   - Build the deduplicated union `<existing_modules>,meetings` (for example `finance,crm,social,sign,meetings`, appending `,meetings` to whichever modules are currently active on the pilot) and validate it locally:

     ```bash
     bash tools/deploy/deploy.sh check-modules "<existing_modules>,meetings"
     ```

     Confirm the command exits `0` (1 to 10 unique lowercase names from `AVAILABLE_MODULES`, no duplicates, spaces, or shell characters).

2. **[CHECK] Confirm `crove-media` (`ludy-media`) readiness under `compose.pilot.yml` limits:**
   - Even with AI off, the `api` container calls `MEDIA_URL` (`http://ludy-media:8095` on the internal `media` network) on every recording or upload to measure duration and normalize/extract audio. Without `crove-media` running, uploads fail with `503 MEDIA_PROBE_UNAVAILABLE` and nothing is stored.
   - Verify the active `v*` release includes `tools/deploy/compose.pilot.yml` limits for `crove-media` (`MEDIA_MAX_INPUT_BYTES=1000000000` enforced identically on `api` and `crove-media`, `MEDIA_MEM_LIMIT=1536m` for both `mem_limit` and `memswap_limit`, and `MEDIA_SCRATCH_SIZE=1g` tmpfs on `/data/scratch`), and confirm `crove-media` is up and healthy (`docker compose ps crove-media` if checking from host, or confirm the `-media` image digest step in the `deploy` workflow logs).
   - Confirm `CREDENTIAL_KEY` (or the shared `/data/keys/credential.key` on the `keys` volume) matches between `api` and `worker` ([credential-key.md](credential-key.md)), because per-meeting media keys in `ludy_meetings.media_key` are wrapped under it.

3. **[CHECK] Confirm AI switches remain OFF and `ludy_meetings` migrations are current:**
   - Confirm the pilot host `.env` keeps `MEETINGS_SUMMARY=off`, `MEETINGS_TRANSCRIBE=off`, and `MEETINGS_TRANSLATION_LANGUAGES` unset. (While `MEETINGS_TRANSCRIBE=off`, `pnpm pilot:check` passes the transcription price and provider checks without requiring `TRANSCRIBE_*` or `AI_PRICE_AUDIO_PER_MIN`.)
   - Confirm `/version` reports `"migrationsMissing":[]` so all `ludy_meetings` migrations are already applied (or will apply cleanly during the tag deploy).

4. **[CHECK] Confirm encrypted backups and GitHub `pilot` environment secrets:**
   - Confirm last night's sealed backup exists and passed ([backup-and-restore.md](backup-and-restore.md), `BACKUP_ENCRYPTION_KEY` set, off-host backup bucket, and WAL archiving if configured).
   - Confirm the WORM archive / shred-replay path is healthy ([worm-archive.md](worm-archive.md#shred-references-for-deleted-meetings-2579)) so deleted meetings remain permanently crypto-shredded across any future restore.
   - Confirm the `pilot` GitHub environment has its deploy secrets (`DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`) and `DEPLOY_PUBLIC_URL` configured ([deploy.md](deploy.md#settings-of-each-github-environment)).

5. **[CHECK] Optional non-blocking capabilities (do NOT block core enablement):**
   - **VAPID browser push (`#3736`):** Kernel-wide Web Push (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, generated via `vapid-keys`) is optional. When unset, the browser push toggle stays hidden in user notification settings and `meetings` works normally (and with `MEETINGS_SUMMARY=off`, `meetings.summary_ready` push notices never trigger).
   - **Calendar OAuth ([calendar-oauth.md](calendar-oauth.md)):** `CALENDAR_GOOGLE_*` and `CALENDAR_MICROSOFT_*` are optional. When unset, the Today/Upcoming calendar tabs display an unconfigured hint and `meetings-morning` stays idle; recording, upload, notes, minutes templates, and tasks work without Calendar OAuth.
   - **Meeting platform OAuth and browser extension ([extension-store.md](extension-store.md)):** `MEETINGS_GOOGLE_*`, `ZOOM_OAUTH_*` / `ZOOM_WEBHOOK_SECRET_TOKEN`, and `TEAMS_OAUTH_*` ([meetings-google.md](meetings-google.md), [meetings-zoom.md](meetings-zoom.md), [meetings-teams.md](meetings-teams.md)) are optional and off by default. Core upload, in-app recording, consent confirmation, manual notes/summary/action items, and minutes templates work without platform OAuth or the Chrome/Edge extension (whose store release is tracked separately in `#2584`; `DEFAULT_EXTENSION_IDS` already carries the Chrome Web Store listing ID `#3010` when installed).

## 1. Set environment variables and deploy

1. **[OWNER]** In GitHub repository `Settings -> Environments -> pilot` (define these in the `pilot` environment **only**, never at repository or organization level):
   - Add or update variable `DEPLOY_MODULES_ENVIRONMENT` = `pilot`
   - Update `DEPLOY_CROVE_MODULES` = `<existing_modules>,meetings` (or `DEPLOY_LUDY_MODULES` if the environment has already migrated per [brand-phase3-pilot-cutover.md](brand-phase3-pilot-cutover.md); `.github/workflows/deploy.yml` uses `DEPLOY_LUDY_MODULES || DEPLOY_CROVE_MODULES` and `deploy.sh` writes `LUDY_MODULES=<existing_modules>,meetings` to `.env`).
2. **[OPERATOR]** Trigger the `deploy` workflow on an existing `v*` tag whose commit is on `main` (and includes `meetings` + `#3531`):
   - Open `Actions -> deploy -> Run workflow`, choose `Use workflow from` the active `v*` release tag, `environment: pilot`, and `action: deploy` (or cut and push a new `v*` tag on `main` with green CI if a newer release is required per [deploy.md](deploy.md#deploy-a-release)).
3. **[CHECK]** Watch the `Deploy to pilot` job in GitHub Actions:
   - `Prepare the module settings` passes (`Modules given: <existing_modules>,meetings`).
   - `Deploy, or roll back, on the host` logs:
     - `module settings written to ...: LUDY_MODULES=<existing_modules>,meetings`
     - `worker` rolls and stays running for 15 seconds before `api` and `prober`
     - `smoke ok: /api/config lists the expected modules`
   - `Smoke test through the public URL` passes with `SMOKE_EXPECT_MODULES=<existing_modules>,meetings`.
   - `Summary` reports `- module settings: updated for LUDY_MODULES=<existing_modules>,meetings (when changed; see host log)`.

## 2. Verify

1. **[CHECK] Confirm the public `/version`, `/readyz`, and `/api/config` endpoints after deploy:**

   ```bash
   curl -fsS <PUBLIC_URL>/version
   curl -fsS <PUBLIC_URL>/readyz
   curl -fsS <PUBLIC_URL>/api/config
   ```

   - `/version` returns the deployed `build` commit SHA and `"migrationsMissing":[]`.
   - `/readyz` returns `{"ready":true}`.
   - `/api/config`'s `"modules"` array includes `"kernel"`, `"meetings"`, and every previously active pilot module.

2. **[OWNER] Manual UI smoke test (use synthetic test data only; NO real customer or confidential data):**
   - **App entry & AI-off verification:** Sign in as an org `owner`, `admin`, or `member` at `<APP_URL>`. Open `Cộng tác` (`Teamwork`) -> `Cuộc họp` (`/o/<slug>/meetings`). Confirm `Cuộc họp` loads and no Vy transcription, AI summary, or AI translation buttons appear.
   - **Recording / upload + mandatory consent:** Click `Ghi lại cuộc họp mới` (or open `Ghi âm trong ứng dụng` at `/o/<slug>/meetings/record`) with a short synthetic test audio clip (a few seconds of harmless test audio, never real customer audio):
     - Confirm creating/starting is blocked until a consent notice method is selected and the consent confirmation checkbox is ticked.
     - Submit and confirm the meeting page (`/o/<slug>/meetings/<id>`) loads, `crove-media` measured the audio duration, `Bản ghi âm (Đã giải mã)` plays back cleanly, `Hồ sơ xác nhận đồng ý ghi âm` records the method/notice version/timestamp, and the AI-off notice card (`Trí tuệ nhân tạo (AI) đang tắt`) is displayed.
   - **Manual transcript, notes, summary, and minutes templates (AI off):**
     - Note that with `MEETINGS_TRANSCRIBE=off`, the transcript card shows `"Chưa có bản ghi lời. Ghi âm và nghe lại vẫn dùng được khi không có."` (manual transcript lines can be stored via `POST /api/rpc/meetings/transcript/draftStore` and edited inline via `Sửa` / `meetings.transcript.correct` if testing transcript search/correction).
     - In the UI directly: save rough notes in `Ghi chú của tôi`, pick a built-in or company minutes template (`Loại cuộc họp`, or create a test company template in `Settings > Ứng dụng` `/o/<slug>/settings/apps`), type a test summary, decisions, and action item (`Lưu bản nháp`, `Thêm mục`), publish via `Chia sẻ cho người dự họp`, and open `Xem biên bản` (`/o/<slug>/print/meeting-minutes/<id>`) to confirm the A4 minutes render cleanly.
   - **Delete & crypto-shredding check:** On the synthetic test meeting (`/o/<slug>/meetings/<id>`), click `Xóa cuộc họp` -> `Tiêu hủy và xóa vĩnh viễn` (or `Xóa tuân thủ (chủ sở hữu)` with MFA step-up if deleting as non-recorder owner). Confirm the test meeting disappears from `/o/<slug>/meetings` and is no longer accessible at `/o/<slug>/meetings/<id>` or `/api/meetings/<id>/audio` (decryption key shredded via `ludy_meetings.media_key_shred`, with a `shred/v1/meeting-<org_id>-<meeting_id>.json` reference queued for WORM archive within ~1 minute).
   - **Optional per-org toggle check (`ADR-0053`):** In a smoke/test org under `Settings > Ứng dụng` (`/o/<slug>/settings/apps`), toggling `Cuộc họp` (`'meetings'`) off hides navigation and returns `404 MODULE_OFF` on `meetings/*` RPCs for that org only (cannot toggle off while a live recording or platform import is running; toggle back on to restore UI access or delete a meeting on request).

## 3. Roll back

### Automatic rollback during deploy

If compose validation, `worker` startup (15-second settle), `api` or `crove-media` startup, `/readyz`, the loopback smoke test, or the public URL smoke test (`SMOKE_EXPECT_MODULES` mismatch on `/api/config`) fails during `.github/workflows/deploy.yml`, `deploy.sh` automatically restores the mode-`600` pre-deploy `.env` backup and rolls back to the previous release.

### Manual rollback after a good deploy

To turn `meetings` off again on the pilot while keeping all other active pilot modules running:

- **Option A (recommended, forward sync):** Update `DEPLOY_CROVE_MODULES` (or `DEPLOY_LUDY_MODULES`) in GitHub `Settings -> Environments -> pilot` back to `<existing_modules>` (removing `,meetings`), then run Actions -> `deploy` -> `Run workflow` (`environment: pilot`, `action: deploy`) from the current `v*` tag.
- **Option B (workflow rollback to the previous release):** Remove `DEPLOY_MODULES_ENVIRONMENT`, `DEPLOY_CROVE_MODULES`, and `DEPLOY_LUDY_MODULES` from the `pilot` environment, then run Actions -> `deploy` -> `Run workflow` from `main` with `environment: pilot` and `action: rollback`. Note that `deploy.sh rollback` restores the pre-deploy `.env` backup only when the release that wrote `LUDY_MODULES` / `CROVE_MODULES` is still the current release and `.env` has not been edited manually on the host since that deploy.

**Data safety:** Turning `meetings` off removes its runtime routes, RPC handlers, UI menus, and regular worker sweeps while keeping all existing `ludy_meetings.*` rows, per-meeting media keys, consent records, and encrypted media blobs intact in PostgreSQL and BlobStore; everything becomes accessible again when `meetings` is re-enabled. (For single-org opt-outs while `meetings` remains in `LUDY_MODULES` / `CROVE_MODULES`, retention and shred-replay continue under [ADR-0053](../adr/0053-per-org-app-enablement.md).) Note what failed and which rollback path ran in the Product Owner chat.
