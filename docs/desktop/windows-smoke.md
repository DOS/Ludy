# Ludy Desktop: Windows install smoke (CI)

[#4566](https://github.com/DOS/Ludy/issues/4566), follow-up of [#4515](https://github.com/DOS/Ludy/issues/4515) (ADR-0055 slice 2). The unit tests run the shell against fakes; this job runs the real **installed, unsigned Squirrel.Windows build** on a `windows-latest` runner, once per PR that touches `apps/desktop/**` or the workflow. It is the evidence behind the "install, tray, DPAPI and update" acceptance items that [#4569](https://github.com/DOS/Ludy/pull/4569) merged on a waiver.

Job: `windows-install-smoke` in [desktop-build.yml](../../.github/workflows/desktop-build.yml). It builds two versions (A `0.1.0`, B `0.1.1`), then `apps/desktop/scripts/smoke-windows.mjs` runs these named steps and stops at the first failure (the job summary table names it):

| Step | What it proves |
|---|---|
| `feed-and-installers-present` | both builds have `Setup.exe`, `RELEASES` and a full nupkg |
| `install-version-a-unsigned-silent` | `LudyDesktop-Setup.exe --silent` installs for the user (no admin) under `%LOCALAPPDATA%\LudyDesktop` |
| `shortcut-made-by-the-squirrel-install-hook` | the `--squirrel-install` startup hook ran `Update.exe --createShortcut` |
| `first-start-reports-version-a` | the installed app starts, says it is packaged and Squirrel-installed (`squirrelInstalled`), and its first check finds no update |
| `tray-process-and-menu` | the tray was created with the signed-out menu; exactly one main process |
| `single-instance-lock` | a second launch hands over to the first and exits; the first sees it |
| `sign-in-through-the-system-browser` | the tray's sign-in opens the **default browser** (real `shell.openExternal`) at the fake sign-in page; PKCE S256; the loopback callback; one token exchange |
| `token-stored-with-dpapi-never-plain` | `session.bin` is a Chromium `os_crypt` blob (`v10`), the token is not in it, and `Local State` holds a DPAPI-wrapped key |
| `quit-then-restart-reads-token-back` | after a restart the app is signed in from the stored token without the sign-in page, and the server saw it |
| `corrupt-update-leaves-the-running-version-untouched` | a feed whose package fails its checksum gives "update failed"; the same process and version keep running, still signed in |
| `update-a-to-b-and-restart` | Squirrel downloads B from the `127.0.0.1` feed, the tray offers the restart, the app restarts into B (version written to `running-version.txt`) and is still signed in |
| `uninstall` | `Update.exe --uninstall` removes the app folders and the shortcuts (the `--squirrel-uninstall` hook) |
| `no-token-in-logs-or-artifacts` | none of the tokens the fake issued, nor a `crx_` marker, is in the logs that are uploaded |

## How it is driven

- **Fake Ludy** (`apps/desktop/test/support/fake-ludy.ts`, unit-tested in `test/fake-ludy.test.ts` against the shell's own sign-in code): `/api/config`, the sign-in page (checks the PKCE request, redirects the browser to the loopback callback), `/api/extension/token`, `/api/extension/me` and the update feed folder, all on `127.0.0.1`. It is not the real server and holds no data.
- **Smoke channel** (`apps/desktop/src/smoke.ts`): when `LUDY_DESKTOP_SMOKE_DIR` is set **and** the configured Ludy address is a loopback one, the app writes `state.json` (version, pid, tray, auth and update state; never a token) and runs commands from `command.json` through the same functions as the tray menu items (`sign-in`, `sign-out`, `check-update`, `restart`, `quit`). Against a real deployment address the channel stays off.
- **No signing, no secrets, no internet:** the build is unsigned, the only network is loopback, no repository secret is used, and the app and installer run with an environment stripped of anything that looks like a credential.

## Reading a run

The job summary lists each step with its time and a note. The artifact `ludy-desktop-windows-smoke-logs` (7 days) holds `steps.log`, `states/` (the app's state after each step), `squirrel/` (Squirrel's own logs), `fake-ludy-requests.log` (method, path and status only) and `running-version.txt`. It holds no installer and no token.

## Not covered

A real code-signing certificate, SmartScreen, a hosted update feed over https, and a real Ludy server are owner steps ([signing-runbook.md](signing-runbook.md)). The tray icon itself is proven by the app's own state and process, not by a screenshot of the notification area.
