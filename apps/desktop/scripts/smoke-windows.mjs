// SPDX-License-Identifier: AGPL-3.0-only
// Windows smoke proof of the installed Ludy Desktop (#4566, follow-up of #4515): installs the UNSIGNED Squirrel build, starts it, checks the
// tray process and the single-instance lock, signs in through the system browser against a fake Ludy on 127.0.0.1 (PKCE, token kept
// by safeStorage/DPAPI and read back after a restart), refuses a corrupt update, updates from version A to version B through a local
// 127.0.0.1 feed, and uninstalls. It runs on a Windows runner only (.github/workflows/desktop-build.yml, job "windows-install-smoke").
//   node scripts/smoke-windows.mjs --installer-a <dir> --installer-b <dir> --out <logs dir>
// <dir> holds what scripts/package.mjs made (LudyDesktop-Setup.exe, RELEASES, the full nupkg). Every step has a name; the first failure
// stops the run and names its step. No certificate, no real server, no internet: the only network is 127.0.0.1. Logs under --out never
// hold a token (the last step searches them for the tokens the fake issued).
import { execFile, spawn } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startFakeLudy } from '../test/support/fake-ludy.ts';

if (process.platform !== 'win32') {
  console.error('smoke-windows.mjs runs on Windows (in CI) only.');
  process.exit(1);
}

function arg(name) {
  const at = process.argv.indexOf(name);
  const value = at === -1 ? undefined : process.argv[at + 1];
  if (!value) throw new Error(`missing ${name}`);
  return resolve(value);
}
const installerA = arg('--installer-a');
const installerB = arg('--installer-b');
const out = arg('--out');
const smokeDir = join(out, 'smoke-state');
const statesDir = join(out, 'states');
const logFile = join(out, 'steps.log');
for (const dir of [out, smokeDir, statesDir]) mkdirSync(dir, { recursive: true });

const localAppData = process.env.LOCALAPPDATA;
const appData = process.env.APPDATA;
if (!localAppData || !appData) throw new Error('LOCALAPPDATA and APPDATA must be set');
const installRoot = join(localAppData, 'LudyDesktop');
const updateExe = join(installRoot, 'Update.exe');
const userData = join(appData, 'ludy-desktop');
const EXE = 'ludy-desktop.exe';

const log = (line) => {
  const text = `[${new Date().toISOString()}] ${line}`;
  console.log(text);
  appendFileSync(logFile, `${text}\n`);
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function waitFor(what, check, { timeoutMs = 60_000, everyMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await check();
    if (last) return last;
    if (Date.now() > deadline) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for: ${what}`);
    await sleep(everyMs);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(file, args, { timeoutMs = 120_000, env } = {}) {
  return new Promise((done, fail) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, env, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && error.killed) return fail(new Error(`${file} timed out`));
      done({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
    });
  });
}

// The app and the installer get the throwaway test setup and nothing that looks like a credential of this runner.
const SECRETISH = /token|secret|key|password|credential|^github_|^actions_/i;
function appEnv(extra) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) if (!SECRETISH.test(name) && value !== undefined) env[name] = value;
  return { ...env, ...extra };
}

// The feed starts as A's own (nothing newer), so the app's check at start reports "no update"; the update steps swap it.
let feedDir = installerA;
const fake = await startFakeLudy({ feedDir: () => feedDir });
const env = appEnv({ LUDY_URL: fake.url, LUDY_DESKTOP_UPDATE_URL: `${fake.url}/feed`, LUDY_DESKTOP_SMOKE_DIR: smokeDir });
log(`fake Ludy on ${fake.url}`);

// ---- helpers over the installed app ----

async function ludyProcesses() {
  const ps = `Get-CimInstance Win32_Process -Filter "Name='${EXE}'" | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress`;
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeoutMs: 60_000 });
  const text = stdout.trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({ pid: p.ProcessId, path: p.ExecutablePath ?? '', cmd: p.CommandLine ?? '' }));
}
// The app's main process: the installed exe inside app-<version>, not a Chromium child (--type=) and not Squirrel's stub.
const mainProcesses = async () => (await ludyProcesses()).filter((p) => /\\app-\d/.test(p.path) && !p.cmd.includes('--type='));

function readState() {
  try {
    return JSON.parse(readFileSync(join(smokeDir, 'state.json'), 'utf8'));
  } catch {
    return null;
  }
}
const waitState = (what, predicate, options) =>
  waitFor(what, () => {
    const state = readState();
    return state !== null && predicate(state) ? state : null;
  }, options);

function sendCommand(command) {
  const temp = join(smokeDir, 'command.json.tmp');
  writeFileSync(temp, JSON.stringify({ command }));
  renameSync(temp, join(smokeDir, 'command.json'));
  log(`command sent: ${command}`);
}
const keepState = (name) => {
  const state = readState();
  if (state !== null) writeFileSync(join(statesDir, `${name}.json`), JSON.stringify(state, null, 2));
};

// Starts the installed app the way a shortcut does (through Update.exe), with the test environment.
function launchInstalled() {
  const child = spawn(updateExe, ['--processStart', EXE], { env, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

async function stopAll() {
  await run('taskkill.exe', ['/F', '/T', '/IM', EXE], { timeoutMs: 30_000 }).catch(() => undefined);
}

function findShortcuts() {
  const roots = [join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'), join(process.env.USERPROFILE ?? '', 'Desktop')];
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 3 || !existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (/ludy/i.test(entry.name) && entry.name.endsWith('.lnk')) found.push(path);
    }
  };
  roots.forEach((root) => walk(root, 0));
  return found;
}

// The "Apps and features" entries Squirrel wrote for the user (HKCU Uninstall), by display name.
async function uninstallEntries() {
  const ps = "Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' -ErrorAction SilentlyContinue | Get-ItemProperty | Where-Object { $_.DisplayName -like '*Ludy*' } | ForEach-Object { $_.DisplayName }";
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeoutMs: 60_000 });
  return stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

function copyDiagnostics(tag) {
  const dir = join(out, 'squirrel');
  mkdirSync(dir, { recursive: true });
  for (const file of [join(installRoot, 'SquirrelSetup.log'), join(localAppData, 'SquirrelTemp', 'SquirrelSetup.log')]) {
    if (existsSync(file)) copyFileSync(file, join(dir, `${tag}-${file.includes('SquirrelTemp') ? 'temp-' : ''}SquirrelSetup.log`));
  }
  if (existsSync(installRoot)) writeFileSync(join(dir, `${tag}-install-root.txt`), readdirSync(installRoot).join('\n'));
}

// ---- the steps ----

const results = [];
let current = null;
async function step(name, body) {
  current = name;
  const started = Date.now();
  log(`STEP ${name}`);
  try {
    const note = await body();
    results.push({ name, ok: true, seconds: (Date.now() - started) / 1000, note: note ?? '' });
    log(`PASS ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({ name, ok: false, seconds: (Date.now() - started) / 1000, note: message });
    log(`FAIL ${name}: ${message}`);
    throw error;
  } finally {
    keepState(name.replace(/[^a-z0-9]+/gi, '-').toLowerCase());
  }
}

let versionA = 'A';
let versionB = 'B';
let failed = false;
try {
  await step('feed-and-installers-present', async () => {
    for (const dir of [installerA, installerB]) {
      for (const name of ['LudyDesktop-Setup.exe', 'RELEASES']) assert(existsSync(join(dir, name)), `${dir} has no ${name}`);
      assert(readdirSync(dir).some((n) => n.endsWith('-full.nupkg')), `${dir} has no full nupkg`);
    }
    versionA = /-(\d+\.\d+\.\d+)-full\.nupkg/.exec(readdirSync(installerA).find((n) => n.endsWith('-full.nupkg')) ?? '')?.[1] ?? 'A';
    versionB = /-(\d+\.\d+\.\d+)-full\.nupkg/.exec(readdirSync(installerB).find((n) => n.endsWith('-full.nupkg')) ?? '')?.[1] ?? 'B';
    assert(versionA !== versionB, `both builds are ${versionA}`);
    return `A ${versionA}, B ${versionB}`;
  });

  await step('install-version-a-unsigned-silent', async () => {
    assert(!existsSync(installRoot), `${installRoot} exists before the install (the runner is not clean)`);
    log(`installing ${versionA}`);
    const result = await run(join(installerA, 'LudyDesktop-Setup.exe'), ['--silent'], { timeoutMs: 180_000, env });
    log(`Setup.exe exit code ${result.code}`);
    assert(result.code === 0, `Setup.exe exited with code ${result.code}`);
    await waitFor('Update.exe and the app folder', () => existsSync(updateExe) && existsSync(join(installRoot, `app-${versionA}`, EXE)), { timeoutMs: 60_000 });
    copyDiagnostics('after-install');
    const entries = await uninstallEntries();
    assert(entries.length > 0, 'no "Apps and features" entry for Ludy was written');
    return `Apps and features: ${entries.join(', ')}`;
  });

  await step('shortcut-made-by-the-squirrel-install-hook', async () => {
    const shortcuts = await waitFor('a Ludy shortcut (the --squirrel-install hook ran Update.exe --createShortcut)', () => {
      const found = findShortcuts();
      return found.length > 0 ? found : null;
    }, { timeoutMs: 30_000 });
    return shortcuts.map((s) => s.split('\\').slice(-2).join('\\')).join(', ');
  });

  await step('first-start-reports-version-a', async () => {
    // Setup.exe starts the app itself (--squirrel-firstrun). If it did not (or did not pass the test environment), start it like a shortcut.
    let note = 'started by Setup.exe';
    log(`main processes right after Setup.exe: ${(await mainProcesses()).map((p) => p.pid).join(', ') || 'none'}`);
    let state = await waitState('state.json from the app Setup.exe started', (s) => s.version === versionA, { timeoutMs: 25_000 }).catch(() => null);
    if (state === null) {
      note = 'Setup.exe did not start the app with the test environment; started through Update.exe --processStart';
      await stopAll();
      launchInstalled();
      state = await waitState('state.json from the installed app', (s) => s.version === versionA, { timeoutMs: 60_000 });
    }
    assert(state.packaged === true, 'the app says it is not packaged');
    assert(state.squirrelInstalled === true, 'the app did not detect its Squirrel install (Update.exe one folder up), so the updater would be off');
    assert(state.execPath.includes(`\\app-${versionA}\\`), `unexpected exe path ${state.execPath}`);
    assert(state.update.kind === 'idle' || state.update.kind === 'checking', `update state at start: ${JSON.stringify(state.update)} (feed ${fake.url}/feed)`);
    return note;
  });

  await step('tray-process-and-menu', async () => {
    const state = readState();
    assert(state?.tray.created === true, 'the Tray object was not created');
    assert(state.tray.items.some((i) => i.startsWith('sign-in:')) && state.tray.items.some((i) => i.startsWith('quit:')), `tray menu is not the signed-out menu: ${state.tray.items.join(' | ')}`);
    const procs = await mainProcesses();
    assert(procs.length === 1, `expected one main process of the installed app, found ${procs.length}`);
    assert(procs[0].pid === state.pid, 'the running process is not the one that wrote the state');
    return `pid ${state.pid}, icon ${state.tray.icon}, "${state.tray.tooltip}"`;
  });

  await step('single-instance-lock', async () => {
    const before = readState();
    const exe = (await mainProcesses())[0]?.path;
    assert(exe, 'no main process to start a second copy of');
    // A second copy started by hand must hand over to the first and exit.
    const second = await run(exe, [], { timeoutMs: 45_000, env });
    log(`second launch exited with code ${second.code}`);
    const after = await waitState('the first instance reporting the second launch', (s) => s.secondInstances > before.secondInstances, { timeoutMs: 20_000 });
    const procs = await mainProcesses();
    assert(procs.length === 1 && procs[0].pid === before.pid, `after a second launch there are ${procs.length} main processes (first pid ${before.pid})`);
    assert(after.pid === before.pid, 'the first instance changed');
  });

  await step('sign-in-through-the-system-browser', async () => {
    const connectsBefore = fake.connects.length;
    sendCommand('sign-in');
    await waitState('tray state "signing-in"', (s) => s.auth.kind === 'signing-in', { timeoutMs: 20_000 });
    await waitFor('the system browser reaching the fake sign-in page (shell.openExternal opened the default browser)', () => fake.connects.length > connectsBefore, { timeoutMs: 90_000 });
    const connect = fake.connects.at(-1);
    assert(connect.method === 'S256', `PKCE method ${connect.method}`);
    assert(/^http:\/\/127\.0\.0\.1:\d+\/ludy-desktop\/callback$/.test(connect.redirectUri), `redirect ${connect.redirectUri}`);
    const state = await waitState('tray state "signed-in" (loopback callback and token exchange)', (s) => s.auth.kind === 'signed-in', { timeoutMs: 45_000 });
    assert(fake.exchanges === 1 && fake.refusedExchanges === 0, `token exchanges: ${fake.exchanges} ok, ${fake.refusedExchanges} refused`);
    assert(state.auth.persisted === true, 'the app kept the token in memory only (the OS key store was not available)');
    assert(state.auth.orgSlug === 'smoke-org', `org ${state.auth.orgSlug}`);
    return `device "${connect.device}"`;
  });

  await step('token-stored-with-dpapi-never-plain', async () => {
    const sessionFile = join(userData, 'session.bin');
    assert(existsSync(sessionFile), `${sessionFile} was not written`);
    const blob = readFileSync(sessionFile);
    const tokens = fake.issuedTokens();
    assert(tokens.length === 1, `fake issued ${tokens.length} tokens`);
    assert(!blob.includes(Buffer.from(tokens[0])), 'the token is in session.bin as plain text');
    assert(!blob.includes(Buffer.from('crx_')), 'session.bin holds a plain token marker');
    assert(blob.subarray(0, 3).toString('latin1') === 'v10', `session.bin does not start with the Chromium os_crypt marker (starts ${blob.subarray(0, 3).toString('hex')})`);
    const localState = JSON.parse(readFileSync(join(userData, 'Local State'), 'utf8'));
    const wrapped = Buffer.from(localState?.os_crypt?.encrypted_key ?? '', 'base64');
    assert(wrapped.subarray(0, 5).toString('latin1') === 'DPAPI', 'Local State does not hold a DPAPI-wrapped key');
    return `session.bin ${blob.length} bytes, key wrapped by DPAPI`;
  });

  await step('quit-then-restart-reads-token-back', async () => {
    const old = readState();
    const connectsBefore = fake.connects.length;
    sendCommand('quit');
    await waitFor('the first process to exit', async () => (await mainProcesses()).length === 0, { timeoutMs: 30_000 });
    fake.meCalls.length = 0;
    launchInstalled();
    const state = await waitState('a new process signed in from the stored token', (s) => s.pid !== old.pid && s.auth.kind === 'signed-in', { timeoutMs: 60_000 });
    assert(state.version === versionA, `restarted into ${state.version}`);
    assert(fake.connects.length === connectsBefore, 'the app went through the sign-in page again instead of reading the stored token');
    await waitFor('/api/extension/me called with the stored token', () => fake.meCalls.some((c) => c.accepted), { timeoutMs: 30_000 });
    assert(state.auth.persisted === true && state.auth.online === true, `auth after restart ${JSON.stringify(state.auth)}`);
  });

  await step('corrupt-update-leaves-the-running-version-untouched', async () => {
    // The feed for B with its package damaged: the checksum in RELEASES no longer matches, as after a bad download.
    const bad = join(out, 'feed-corrupt');
    rmSync(bad, { recursive: true, force: true });
    mkdirSync(bad, { recursive: true });
    for (const name of readdirSync(installerB)) {
      if (name.endsWith('.exe')) continue;
      const data = readFileSync(join(installerB, name));
      if (name.endsWith('.nupkg')) for (let i = 0; i < Math.min(2048, data.length); i += 1) data[data.length - 1 - i] ^= 0xff;
      writeFileSync(join(bad, name), data);
    }
    feedDir = bad;
    const before = readState();
    sendCommand('check-update');
    const failedState = await waitState('update state "failed"', (s) => s.update.kind === 'failed', { timeoutMs: 120_000 });
    const procs = await mainProcesses();
    assert(procs.length === 1 && procs[0].pid === before.pid, 'the running process changed after a failed update');
    assert(failedState.version === versionA && failedState.execPath.includes(`\\app-${versionA}\\`), `the running version is now ${failedState.version}`);
    assert(failedState.auth.kind === 'signed-in', 'the sign-in was lost by a failed update');
    // The failure must come from the damaged package (Squirrel's checksum step), not from something unrelated.
    assert(/checksum/i.test(String(failedState.update.message)), `the update failed, but not on the package checksum: ${String(failedState.update.message).slice(0, 300)}`);
    return 'failed on the package checksum, old version kept running';
  });

  await step('update-a-to-b-and-restart', async () => {
    feedDir = installerB;
    rmSync(join(out, 'feed-corrupt'), { recursive: true, force: true });
    const before = readState();
    sendCommand('check-update');
    const ready = await waitState('update state "ready" (downloaded by Squirrel from the local feed)', (s) => s.update.kind === 'ready', { timeoutMs: 180_000 });
    assert(fake.feedRequests.some((r) => r.status === 200 && r.file.endsWith('-full.nupkg') && r.file.includes(versionB)), 'Squirrel did not download the full package of the new version');
    assert(existsSync(join(installRoot, `app-${versionB}`, EXE)), `app-${versionB} was not unpacked next to the running version`);
    assert(ready.version === versionA, 'the running version changed before the restart was chosen');
    sendCommand('restart');
    await waitFor('the old process to exit', async () => !(await mainProcesses()).some((p) => p.pid === before.pid), { timeoutMs: 60_000 });
    const state = await waitState(`a new process running ${versionB}`, (s) => s.pid !== before.pid && s.version === versionB, { timeoutMs: 90_000 }).catch(async (error) => {
      const procs = await mainProcesses();
      throw new Error(`${error.message}; main processes now: ${procs.map((p) => p.path).join(', ') || 'none'}`);
    });
    assert(state.execPath.includes(`\\app-${versionB}\\`), `unexpected exe path ${state.execPath}`);
    assert(state.squirrelInstalled === true, 'the updated app does not detect its Squirrel install');
    await waitState('the updated app still signed in', (s) => s.auth.kind === 'signed-in', { timeoutMs: 60_000 });
    writeFileSync(join(out, 'running-version.txt'), `${state.version}\n`);
    copyDiagnostics('after-update');
    return `now ${state.version} (pid ${state.pid})`;
  });

  await step('uninstall', async () => {
    sendCommand('quit');
    await waitFor('the app to exit', async () => (await mainProcesses()).length === 0, { timeoutMs: 30_000 });
    const result = await run(updateExe, ['--uninstall'], { timeoutMs: 120_000, env });
    log(`Update.exe --uninstall exit code ${result.code}`);
    assert(result.code === 0, `Update.exe --uninstall exited with code ${result.code}`);
    await waitFor('the "Apps and features" entry to be removed', async () => (await uninstallEntries()).length === 0, { timeoutMs: 30_000 });
    await waitFor('the Ludy shortcuts to be removed (the --squirrel-uninstall hook)', () => findShortcuts().length === 0, { timeoutMs: 30_000 });
    assert((await ludyProcesses()).length === 0, 'a Ludy process is still running after the uninstall');
    // Squirrel leaves its install folder (marked .dead) to be deleted later because Update.exe cannot delete itself while it runs: recorded, not failed.
    copyDiagnostics('after-uninstall');
    const left = existsSync(installRoot) ? readdirSync(installRoot) : [];
    return left.length === 0 ? 'install folder removed' : `left behind by Squirrel for a later delete: ${left.join(', ')}`;
  });

  await step('no-token-in-logs-or-artifacts', async () => {
    const tokens = fake.issuedTokens().map((t) => Buffer.from(t));
    const bad = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (statSync(path).size < 32 * 1024 * 1024) {
          const data = readFileSync(path);
          if (tokens.some((t) => data.includes(t)) || data.includes(Buffer.from('crx_'))) bad.push(path);
        }
      }
    };
    walk(out);
    assert(bad.length === 0, `a token or token marker is in: ${bad.join(', ')}`);
  });
} catch {
  failed = true;
} finally {
  await stopAll();
  copyDiagnostics('final');
  writeFileSync(join(out, 'fake-ludy-requests.log'), `${fake.requestLog.join('\n')}\n`);
  writeFileSync(join(out, 'processes-at-end.txt'), JSON.stringify(await ludyProcesses().catch(() => []), null, 2));
  rmSync(join(smokeDir, 'command.json'), { force: true });
  await fake.close();
  const rows = results.map((r) => `| ${r.ok ? 'pass' : '**FAIL**'} | ${r.name} | ${r.seconds.toFixed(1)} s | ${r.note.replace(/\|/g, '/').replace(/\r?\n/g, ' ')} |`);
  const lines = [`### Ludy Desktop Windows install smoke (unsigned, ${versionA} then ${versionB})`, '', '| result | step | time | note |', '|---|---|---|---|', ...rows];
  if (failed) lines.push('', `**Stopped at step: ${current}.** Logs: the "ludy-desktop-windows-smoke-logs" artifact (steps.log, states/, squirrel/, fake-ludy-requests.log).`);
  writeFileSync(join(out, 'summary.md'), `${lines.join('\n')}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
}
process.exit(failed ? 1 : 0);
