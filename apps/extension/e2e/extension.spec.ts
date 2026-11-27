// SPDX-License-Identifier: AGPL-3.0-only
// The unpacked extension in Chromium with fake media devices, testing both the default Ludy Cloud build and a
// split-origin (--app-origin + --api-origin) / single-origin (--origin) build against fake Ludy servers.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { snapshotDomPage } from '../src/page-capture.ts';
import { startFakeLudy, type FakeLudy } from './fake-ludy.ts';

const pkg = fileURLToPath(new URL('..', import.meta.url));
let tempRoot: string;
let cloudDist: string;
let singleDist: string;
let e2eDist: string;
let context: BrowserContext;
let profile: string;
let fakeApp: FakeLudy;
let fakeApi: FakeLudy;
let appOrigin: string;
let apiOrigin: string;
let extensionId: string;

test.beforeAll(async () => {
  tempRoot = mkdtempSync(`${tmpdir()}/ludy-ext-e2e-`);
  cloudDist = join(tempRoot, 'cloud-dist');
  singleDist = join(tempRoot, 'single-dist');
  e2eDist = join(tempRoot, 'e2e-dist');
  profile = join(tempRoot, 'profile');

  fakeApp = await startFakeLudy();
  fakeApi = await startFakeLudy();
  // Distinct hostnames + ports so Chromium enforces host_permissions (127.0.0.1) separately from web_accessible_resources (localhost).
  appOrigin = fakeApp.origin.replace('127.0.0.1', 'localhost');
  apiOrigin = fakeApi.origin;

  execFileSync('node', ['scripts/build.mjs', '--out', cloudDist], { cwd: pkg, stdio: 'inherit' });
  execFileSync('node', ['scripts/check-manifest.mjs', join(cloudDist, 'manifest.json')], { cwd: pkg, stdio: 'inherit' });
  execFileSync('node', ['scripts/build.mjs', '--origin', 'https://ludy.congty.vn', '--out', singleDist], { cwd: pkg, stdio: 'inherit' });
  execFileSync('node', ['scripts/check-manifest.mjs', join(singleDist, 'manifest.json'), '--origin', 'https://ludy.congty.vn'], { cwd: pkg, stdio: 'inherit' });
  execFileSync('node', ['scripts/build.mjs', '--app-origin', appOrigin, '--api-origin', apiOrigin, '--out', e2eDist], { cwd: pkg, stdio: 'inherit' });

  context = await chromium.launchPersistentContext(profile, {
    // The new headless mode loads extensions; CHROMIUM_PATH points at a browser installed elsewhere (a sandbox).
    channel: 'chromium',
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: [`--disable-extensions-except=${e2eDist}`, `--load-extension=${e2eDist}`, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--lang=vi'],
    // The browser's language drives the popup's language (#3008): Vietnamese here, so the texts below hold.
    locale: 'vi-VN',
    env: { ...process.env, LANGUAGE: 'vi' },
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(worker.url()).host;
});

test.afterAll(async () => {
  await context.close();
  await fakeApp.close();
  await fakeApi.close();
  rmSync(tempRoot, { recursive: true, force: true });
});

const seed = async (enabled: Record<string, boolean>) => {
  const worker = context.serviceWorkers()[0]!;
  await worker.evaluate(
    ([app, api, on]) =>
      chrome.storage.local.set({
        'ludy-extension-state': { appAddress: app, apiAddress: api, accounts: { org1: { orgId: 'org1', orgSlug: 'cong-ty', token: 'crx_test', expiresAt: '2027-01-01T00:00:00.000Z' } }, activeOrg: 'org1', enabled: on },
      }),
    [appOrigin, apiOrigin, enabled] as const,
  );
};

const signedOut = async () => {
  await context.serviceWorkers()[0]!.evaluate(() => chrome.storage.local.clear());
  fakeApp.requests.length = 0;
  fakeApi.requests.length = 0;
  fakeApi.exchanges.length = 0;
};

const popup = async (): Promise<Page> => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  return page;
};

test('the default Cloud build locks to Ludy Cloud split origins and --origin supports self-hosted builds', async () => {
  const cloudManifest = JSON.parse(readFileSync(join(cloudDist, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  expect([...(cloudManifest.permissions as string[])].sort()).toEqual(['identity', 'storage']);
  expect(cloudManifest.host_permissions).toEqual(['https://api.ludy.vn/*']);
  expect([...(cloudManifest.optional_permissions as string[])].sort()).toEqual(['activeTab', 'offscreen', 'scripting', 'tabCapture']);
  expect('optional_host_permissions' in cloudManifest).toBe(false);
  expect(cloudManifest.web_accessible_resources).toEqual([{ resources: ['connected.html'], matches: ['https://app.ludy.vn/*'] }]);
  const cloudAddressJs = readFileSync(join(cloudDist, 'ludy-address.js'), 'utf8');
  expect(cloudAddressJs).toMatch(/DEFAULT_APP_ADDRESS = ['"]https:\/\/app\.ludy\.vn['"]/);
  expect(cloudAddressJs).toMatch(/DEFAULT_API_ADDRESS = ['"]https:\/\/api\.ludy\.vn['"]/);

  const singleManifest = JSON.parse(readFileSync(join(singleDist, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  expect(singleManifest.host_permissions).toEqual(['https://ludy.congty.vn/*']);
  expect(singleManifest.web_accessible_resources).toEqual([{ resources: ['connected.html'], matches: ['https://ludy.congty.vn/*'] }]);
  const singleAddressJs = readFileSync(join(singleDist, 'ludy-address.js'), 'utf8');
  expect(singleAddressJs).toContain('DEFAULT_APP_ADDRESS = "https://ludy.congty.vn"');
  expect(singleAddressJs).toContain('DEFAULT_API_ADDRESS = "https://ludy.congty.vn"');
});

test('the installed e2e manifest stamps split app/api origins with zero optional_host_permissions', async () => {
  const manifest = await context.serviceWorkers()[0]!.evaluate(() => chrome.runtime.getManifest());
  expect([...(manifest.permissions ?? [])].sort()).toEqual(['identity', 'storage']);
  expect(manifest.host_permissions).toEqual(['http://127.0.0.1/*']);
  expect([...(manifest.optional_permissions ?? [])].sort()).toEqual(['activeTab', 'offscreen', 'scripting', 'tabCapture']);
  expect('optional_host_permissions' in manifest).toBe(false);
  expect((manifest as { web_accessible_resources?: unknown }).web_accessible_resources).toEqual([{ resources: ['connected.html'], matches: ['http://localhost/*'] }]);
});

test('the installed manifest names its icons, and the package holds them', async () => {
  const manifest = await context.serviceWorkers()[0]!.evaluate(() => chrome.runtime.getManifest());
  expect(Object.keys(manifest.icons ?? {}).sort()).toEqual(['128', '16', '32', '48']);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  for (const path of Object.values(manifest.icons ?? {})) {
    expect(await page.evaluate(async (file) => (await fetch(chrome.runtime.getURL(file))).ok, path), path).toBe(true);
  }
  await page.close();
});

test('the signed-out popup is clean in Vietnamese and English with no Own server or device-note bloat (#3008, #5224)', async () => {
  const englishProfile = mkdtempSync(`${tmpdir()}/ludy-ext-en-`);
  const english = await chromium.launchPersistentContext(englishProfile, {
    channel: 'chromium',
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: [`--disable-extensions-except=${e2eDist}`, `--load-extension=${e2eDist}`, '--lang=en-US'],
    locale: 'en-US',
    env: { ...process.env, LANGUAGE: 'en_US' },
  });
  try {
    const worker = english.serviceWorkers()[0] ?? (await english.waitForEvent('serviceworker'));
    const englishManifest = await worker.evaluate(() => chrome.runtime.getManifest());
    expect(englishManifest.name).toBe('Ludy');
    expect(englishManifest.description).toBe('Record browser meeting audio and your mic into Ludy, and optionally save quick notes or clip the active page on click.');
    const page = await english.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
    await expect(page.getByRole('button', { name: 'Sign in to Ludy' })).toBeVisible();
    await expect(page.getByText('Record meetings and capture quick notes to Ludy Cloud.')).toBeVisible();
    await expect(page.locator('#sign-in-device-note')).toHaveCount(0);
    await expect(page.locator('#where-own')).toHaveCount(0);
    await expect(page.locator('#address')).toHaveCount(0);
  } finally {
    await english.close();
    rmSync(englishProfile, { recursive: true, force: true });
  }
  const vietnameseManifest = await context.serviceWorkers()[0]!.evaluate(() => chrome.runtime.getManifest());
  expect(vietnameseManifest.name).toBe('Ludy');
  expect(vietnameseManifest.description).toBe('Ghi âm cuộc họp trên trình duyệt vào Ludy (tab họp và micro), và tùy chọn lưu nhanh ghi chú hoặc cắt trang web đang mở.');
  const vietnamese = await context.newPage();
  await vietnamese.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(vietnamese.getByRole('button', { name: 'Đăng nhập Ludy' })).toBeVisible();
  await expect(vietnamese.getByText('Ghi cuộc họp và lưu ghi chú nhanh vào Ludy Cloud.')).toBeVisible();
  await expect(vietnamese.locator('#sign-in-device-note')).toHaveCount(0);
  await expect(vietnamese.locator('#where-own')).toHaveCount(0);
  await vietnamese.close();
});

const CODE = `crc_${'B'.repeat(43)}`;

test('sign-in opens App origin in a tab and exchanges the code strictly against API origin (#4662, #5224)', async () => {
  await signedOut();
  const page = await popup();
  await page.evaluate(() => {
    (window as unknown as { windowFlows: number }).windowFlows = 0;
    (chrome.identity as { launchWebAuthFlow: unknown }).launchWebAuthFlow = async () => {
      (window as unknown as { windowFlows: number }).windowFlows += 1;
      return undefined;
    };
  });
  const [tab] = await Promise.all([context.waitForEvent('page'), page.getByRole('button', { name: 'Đăng nhập Ludy' }).click()]);
  await tab.waitForURL(/\/-\/extension\/connect\?/);
  const asked = new URL(tab.url());
  expect(asked.origin).toBe(appOrigin);
  expect(asked.pathname).toBe('/-/extension/connect');
  const redirect = asked.searchParams.get('redirect_uri') ?? '';
  expect(redirect).toBe(`chrome-extension://${extensionId}/connected.html`);
  expect(asked.searchParams.get('code_challenge_method')).toBe('S256');
  expect(asked.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const state = asked.searchParams.get('state') ?? '';
  expect(state).not.toBe('');
  // /api/config went to fakeApi only, never fakeApp; no window fallback ran; no code exchanged before approval.
  expect(fakeApi.requests.map((r) => r.path)).toContain('/api/config');
  expect(fakeApp.requests.filter((r) => r.path.startsWith('/api/'))).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { windowFlows: number }).windowFlows)).toBe(0);
  expect(fakeApi.exchanges).toHaveLength(0);

  // The app's connect page sends the tab to connected.html with the code.
  await tab.evaluate((to) => location.assign(to), `${redirect}?code=${CODE}&org=cong-ty&state=${state}`).catch(() => undefined);
  await tab.waitForURL(`chrome-extension://${extensionId}/connected.html`);
  await expect(tab.getByText('Đã kết nối với Ludy')).toBeVisible();
  await expect(tab.locator('.status-badge')).toContainText('Đã kết nối');
  await expect(tab.locator('#close-countdown')).toContainText('Tự đóng thẻ sau');
  await expect.poll(() => fakeApi.exchanges.length).toBe(1);
  expect(fakeApi.exchanges[0]).toEqual({ code: CODE, codeVerifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
  const exchange = fakeApi.requests.filter((r) => r.method === 'POST' && r.path === '/api/extension/token');
  expect(exchange).toHaveLength(1);
  expect(exchange[0]!.origin).toBe(`chrome-extension://${extensionId}`);
  expect(fakeApp.requests.filter((r) => r.path.startsWith('/api/'))).toEqual([]);
  const stored = (await context.serviceWorkers()[0]!.evaluate(async () => (await chrome.storage.local.get('ludy-extension-state'))['ludy-extension-state'])) as { appAddress: string; apiAddress: string; activeOrg: string; accounts: Record<string, { orgSlug: string; token: string }> };
  expect(stored.appAddress).toBe(appOrigin);
  expect(stored.apiAddress).toBe(apiOrigin);
  expect(stored.activeOrg).toBe('org1');
  expect(stored.accounts.org1).toMatchObject({ orgSlug: 'cong-ty', token: 'crx_signed_in' });
  await expect.poll(() => tab.isClosed(), { timeout: 10_000 }).toBe(true);
  await page.close();
  const again = await popup();
  await expect(again.locator('#org')).toBeVisible();
  await expect(again.locator('#org option')).toHaveText(['cong-ty']);
  await expect(again.locator('#add-org')).toBeVisible();
  await expect(again.locator('#sign-out')).toBeVisible();
  await again.close();
});

test('the landing page ignores an answer with another state, and finishes the sign-in that is waiting (#4662)', async () => {
  await signedOut();
  const page = await popup();
  const [tab] = await Promise.all([context.waitForEvent('page'), page.getByRole('button', { name: 'Đăng nhập Ludy' }).click()]);
  await tab.waitForURL(/\/-\/extension\/connect\?/);
  const asked = new URL(tab.url());
  const redirect = asked.searchParams.get('redirect_uri') ?? '';
  const state = asked.searchParams.get('state') ?? '';
  // A forged or stale answer: another state. It trades nothing and leaves the pending sign-in alone.
  const stranger = await context.newPage();
  await stranger.goto(`${appOrigin}/-/extension/connect`);
  await stranger.evaluate((to) => location.assign(to), `${redirect}?code=${CODE}&org=cong-ty&state=not-the-state`).catch(() => undefined);
  await stranger.waitForURL(`chrome-extension://${extensionId}/connected.html`);
  await expect(stranger.getByText('Không có lần đăng nhập nào đang chờ')).toBeVisible();
  expect(fakeApi.exchanges).toHaveLength(0);
  await stranger.close();
  // The real answer still finishes it.
  await tab.evaluate((to) => location.assign(to), `${redirect}?code=${CODE}&org=cong-ty&state=${state}`).catch(() => undefined);
  await tab.waitForURL(`chrome-extension://${extensionId}/connected.html`);
  await expect(tab.getByText('Đã kết nối với Ludy')).toBeVisible();
  await expect.poll(() => fakeApi.exchanges.length).toBe(1);
  await page.close();
});

test('a tab the browser will not open falls back to launchWebAuthFlow on App origin and exchanges at API origin (#4662, #2850)', async () => {
  await signedOut();
  const page = await popup();
  await page.evaluate(() => {
    const seen: { windowRedirect: string; connectOrigin: string } = { windowRedirect: '', connectOrigin: '' };
    (chrome.tabs as { create: unknown }).create = async () => {
      throw new Error('blocked');
    };
    (chrome.identity as { launchWebAuthFlow: unknown }).launchWebAuthFlow = async ({ url }: { url: string }) => {
      const parsed = new URL(url);
      seen.connectOrigin = parsed.origin;
      seen.windowRedirect = parsed.searchParams.get('redirect_uri') ?? '';
      const back = new URL(seen.windowRedirect);
      back.searchParams.set('code', `crc_${'C'.repeat(43)}`);
      back.searchParams.set('org', 'cong-ty');
      back.searchParams.set('state', parsed.searchParams.get('state') ?? '');
      return back.toString();
    };
    (window as unknown as { seen: typeof seen }).seen = seen;
  });
  await page.getByRole('button', { name: 'Đăng nhập Ludy' }).click();
  await expect.poll(() => fakeApi.exchanges.length).toBe(1);
  const seen = await page.evaluate(() => (window as unknown as { seen: { windowRedirect: string; connectOrigin: string } }).seen);
  expect(seen.connectOrigin).toBe(appOrigin);
  expect(new URL(seen.windowRedirect).hostname).toBe(`${extensionId}.chromiumapp.org`);
  const exchange = fakeApi.requests.filter((r) => r.method === 'POST' && r.path === '/api/extension/token');
  expect(exchange).toHaveLength(1);
  expect(exchange[0]!.origin).toBe(`chrome-extension://${extensionId}`);
  expect(fakeApp.requests.filter((r) => r.path.startsWith('/api/'))).toEqual([]);
  const pending = await context.serviceWorkers()[0]!.evaluate(async () => (await chrome.storage.session.get('ludy-pending-signin'))['ludy-pending-signin']);
  expect(pending).toBeUndefined();
  await page.close();
});

test('foreign-origin stored accounts are dropped on startup without sending their token to the API origin (#5224)', async () => {
  await signedOut();
  await context.serviceWorkers()[0]!.evaluate(() =>
    chrome.storage.local.set({
      'ludy-extension-state': {
        address: 'https://foreign.example',
        accounts: { org1: { orgId: 'org1', orgSlug: 'foreign', token: 'crx_foreign_secret', expiresAt: '2027-01-01T00:00:00.000Z' } },
        activeOrg: 'org1',
        enabled: { meetings: true },
      },
    }),
  );
  const page = await popup();
  await expect(page.getByRole('button', { name: 'Đăng nhập Ludy' })).toBeVisible();
  expect(fakeApi.requests).toEqual([]);
  expect(fakeApp.requests).toEqual([]);
  await page.close();
});

test('with meetings off in the org the feature does not show, with it on it does; dual features show segmented tabs', async () => {
  await seed({});
  fakeApi.features.meetings = false;
  fakeApi.features.notes = false;
  let page = await popup();
  await expect(page.getByText('Tổ chức này chưa bật tính năng nào')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Ghi cuộc họp' })).toHaveCount(0);
  await page.close();

  fakeApi.features.meetings = true;
  page = await popup();
  await expect(page.getByRole('heading', { name: 'Ghi cuộc họp' })).toBeVisible();
  // Not turned on yet: only the opt-in button, no consent form, no capture.
  await expect(page.getByRole('button', { name: 'Bật ghi cuộc họp' })).toBeVisible();
  await expect(page.locator('#agreed')).toHaveCount(0);
  await page.close();

  fakeApi.scopes = ['meetings', 'notes'];
  fakeApi.features = { meetings: true, notes: true };
  page = await popup();
  await expect(page.locator('#tab-meetings')).toBeVisible();
  await expect(page.locator('#tab-notes')).toBeVisible();
  await expect(page.locator('#panel-meetings')).toBeVisible();
  await expect(page.locator('#panel-notes')).toBeHidden();
  await page.locator('#tab-notes').click();
  await expect(page.locator('#panel-notes')).toBeVisible();
  await expect(page.locator('#panel-meetings')).toBeHidden();
  fakeApi.scopes = ['meetings'];
  fakeApi.features = { meetings: true, notes: false };
  await page.close();
});

test('the shell talks to the configured API origin only', async () => {
  await seed({});
  fakeApi.requests.length = 0;
  fakeApp.requests.length = 0;
  const seen: string[] = [];
  const onRequest = (r: { url(): string }) => void seen.push(r.url());
  context.on('request', onRequest);
  const page = await popup();
  await expect(page.getByText('Ghi cuộc họp').first()).toBeVisible();
  await page.close();
  context.off('request', onRequest);
  for (const url of seen) expect(url.startsWith(`chrome-extension://${extensionId}/`) || url.startsWith(apiOrigin) || url.startsWith('data:') || url === 'about:blank').toBe(true);
  expect(fakeApi.requests.map((r) => r.path)).toContain('/api/extension/me');
  expect(fakeApp.requests).toEqual([]);
});

// The popup as if the member had granted the feature's browser permissions (a click-only prompt automation cannot answer), so the consent step shows.
const popupGranted = async (): Promise<Page> => {
  const page = await context.newPage();
  await page.addInitScript(() => {
    (chrome.permissions as { contains: unknown }).contains = async () => true;
  });
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  return page;
};

// Runs one capture in the offscreen document's module: a fake tab (a tone, and a picture only when asked), the fake
// microphone device, three seconds, stop.
async function record(keepVideo: boolean): Promise<{ ok: boolean; uploaded?: boolean; left: number }> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/offscreen.html`);
  const result = await page.evaluate(
    async ([base, address, video]) => {
      const run = (await import(`${base}capture-run.js`)) as typeof import('../src/capture-run.ts');
      const deps = run.browserDeps();
      deps.getTabStream = async (constraints) => {
        const wants = (constraints as { video: unknown }).video !== false;
        const context = new AudioContext();
        const tone = context.createOscillator();
        const out = context.createMediaStreamDestination();
        tone.connect(out);
        tone.start();
        const tracks = [...out.stream.getAudioTracks()];
        if (wants) {
          const canvas = document.createElement('canvas');
          canvas.width = 160;
          canvas.height = 90;
          const draw = canvas.getContext('2d')!;
          setInterval(() => {
            draw.fillStyle = `hsl(${Date.now() % 360} 80% 50%)`;
            draw.fillRect(0, 0, 160, 90);
          }, 100);
          tracks.push(...canvas.captureStream(10).getVideoTracks());
        }
        return new MediaStream(tracks);
      };
      const params = { address, token: 'crx_test', orgId: 'org1', uploads: 'direct', title: 'Họp thử', consentMethod: 'told_at_start', consentAgreed: true, keepVideo: video, liveNotes: false, streamId: 'fake' } as const;
      const started = await run.startCapture(params, deps);
      if (!started.ok) return { ok: false, left: 0 };
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const done = await started.running.stop();
      return { ok: true, uploaded: done.uploaded, left: (await deps.store.list('org1')).length };
    },
    [`chrome-extension://${extensionId}/`, apiOrigin, keepVideo] as const,
  );
  await page.close();
  return result;
}

test('video off: the meeting is created with its consent and only audio arrives', async () => {
  fakeApi.created.length = 0;
  fakeApi.uploads.length = 0;
  const result = await record(false);
  expect(result).toEqual({ ok: true, uploaded: true, left: 0 });
  expect(fakeApi.created).toEqual([{ title: 'Họp thử', language: 'vi', visibility: 'attendees', keepVideo: false, consentMethod: 'told_at_start', consentNoticeVersion: '2026-11-v1', liveNotes: false }]);
  expect(fakeApi.uploads).toHaveLength(1);
  expect(fakeApi.uploads[0]).toMatchObject({ kind: 'audio', fileType: expect.stringMatching(/^audio\/webm/) });
  expect(fakeApi.uploads[0]!.bytes).toBeGreaterThan(1000);
});

test('video ticked: the video arrives', async () => {
  fakeApi.created.length = 0;
  fakeApi.uploads.length = 0;
  const result = await record(true);
  expect(result).toEqual({ ok: true, uploaded: true, left: 0 });
  expect(fakeApi.created[0]).toMatchObject({ keepVideo: true });
  expect(fakeApi.uploads).toHaveLength(1);
  expect(fakeApi.uploads[0]).toMatchObject({ kind: 'video', fileType: expect.stringMatching(/^video\/webm/) });
});

test('a failed upload keeps the recording on the device', async () => {
  fakeApi.uploads.length = 0;
  fakeApi.failUploads = true;
  const result = await record(false);
  fakeApi.failUploads = false;
  expect(result).toEqual({ ok: true, uploaded: false, left: 1 });
  expect(fakeApi.uploads).toHaveLength(0);
});

// A1 (#3159): the meeting tab's track ends while recording (the tab was closed or its capture taken away). The capture reports it
// once, with a code, and what was saved is uploaded with that code; a stop the member asks for carries none.
test('a recording whose tab ends by itself uploads what it has with the reason code', async () => {
  fakeApi.created.length = 0;
  fakeApi.uploads.length = 0;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/offscreen.html`);
  const result = await page.evaluate(
    async ([base, address]) => {
      const run = (await import(`${base}capture-run.js`)) as typeof import('../src/capture-run.ts');
      const deps = run.browserDeps();
      let tabTrack: MediaStreamTrack | null = null;
      deps.getTabStream = async () => {
        const context = new AudioContext();
        const tone = context.createOscillator();
        const out = context.createMediaStreamDestination();
        tone.connect(out);
        tone.start();
        tabTrack = out.stream.getAudioTracks()[0]!;
        return new MediaStream([tabTrack]);
      };
      const params = { address, token: 'crx_test', orgId: 'org1', uploads: 'direct', title: 'Họp bị ngắt', consentMethod: 'in_call_chat', consentAgreed: true, keepVideo: false, liveNotes: false, streamId: 'fake' } as const;
      const started = await run.startCapture(params, deps);
      if (!started.ok) return { ok: false, reasons: [] as string[], uploaded: false };
      const reasons: string[] = [];
      let finished: Promise<{ uploaded: boolean }> | null = null;
      started.running.onLost((reason) => {
        reasons.push(reason);
        finished = started.running.stop(reason);
      });
      await new Promise((resolve) => setTimeout(resolve, 2000));
      // The browser fires `ended` on the track when its tab goes away.
      tabTrack!.dispatchEvent(new Event('ended'));
      const done = await (finished as Promise<{ uploaded: boolean }> | null);
      // A second sign of the same loss reports nothing more.
      tabTrack!.dispatchEvent(new Event('ended'));
      return { ok: true, reasons, uploaded: done?.uploaded ?? false };
    },
    [`chrome-extension://${extensionId}/`, apiOrigin] as const,
  );
  await page.close();
  expect(result).toEqual({ ok: true, reasons: ['tab_closed'], uploaded: true });
  expect(fakeApi.created[0]).toMatchObject({ consentMethod: 'in_call_chat', consentNoticeVersion: '2026-11-v1' });
  expect(fakeApi.uploads).toHaveLength(1);
  expect(fakeApi.uploads[0]).toMatchObject({ kind: 'audio', stopReason: 'tab_closed' });
});

// A2 (#3160): a strict org refuses a consent method that is not written; the capture reports it as its own failure, opens no recording
// and leaves nothing on the device, and a written method works.
test('a strict org refuses "said at the start" and accepts a written method', async () => {
  fakeApi.created.length = 0;
  fakeApi.strict = true;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/offscreen.html`);
  const outcome = await page.evaluate(
    async ([base, address]) => {
      const run = (await import(`${base}capture-run.js`)) as typeof import('../src/capture-run.ts');
      const deps = run.browserDeps();
      deps.getTabStream = async () => {
        const context = new AudioContext();
        const out = context.createMediaStreamDestination();
        context.createOscillator().connect(out);
        return new MediaStream(out.stream.getAudioTracks());
      };
      const params = { address, token: 'crx_test', orgId: 'org1', uploads: 'direct', title: 'Họp nghiêm', consentMethod: 'told_at_start', consentAgreed: true, keepVideo: false, liveNotes: false, streamId: 'fake' } as const;
      const refused = await run.startCapture(params, deps);
      const written = await run.startCapture({ ...params, consentMethod: 'in_call_chat' }, deps);
      if (written.ok) await written.running.stop();
      return { refused: refused.ok ? 'started' : refused.reason, written: written.ok };
    },
    [`chrome-extension://${extensionId}/`, apiOrigin] as const,
  );
  await page.close();
  fakeApi.strict = false;
  expect(outcome).toEqual({ refused: 'consentPolicy', written: true });
  expect(fakeApi.created).toHaveLength(1);
  expect(fakeApi.created[0]).toMatchObject({ consentMethod: 'in_call_chat' });
});

test('a stop the member asks for carries no reason code', async () => {
  fakeApi.uploads.length = 0;
  expect(await record(false)).toMatchObject({ ok: true, uploaded: true });
  expect(fakeApi.uploads[0]).toMatchObject({ stopReason: null });
});

test('the consent step keeps notice collapsible, toggles language, copies, and disables Start until consent is complete (A1, #3159, #5224)', async () => {
  await seed({ meetings: true });
  const page = await popupGranted();
  // Recording notice starts collapsed inside .notice-disclosure; opening it reveals the notice, copy button, and #2585 marker.
  await expect(page.locator('#notice-text')).toBeHidden();
  await page.locator('.notice-disclosure summary').click();
  await expect(page.locator('#notice-text')).toContainText('Cuộc họp này đang được ghi âm để lập biên bản');
  await expect(page.getByText('#2585').first()).toBeVisible();
  await expect(page.locator('#method option')).toHaveText(['Chọn...', 'Nói ở đầu cuộc họp', 'Ghi trong lời mời', 'Bằng văn bản', 'Đã dán thông báo vào khung chat cuộc họp']);
  await page.evaluate(() => {
    (window as unknown as { copied: string[] }).copied = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text: string) => void (window as unknown as { copied: string[] }).copied.push(text) }, configurable: true });
  });
  await page.locator('#copy-notice').click();
  await expect(page.locator('#copy-note')).toContainText('Đã sao chép');
  // The English one is one click away, and copying then copies that text.
  await page.locator('#notice-lang').click();
  await expect(page.locator('#notice-text')).toContainText('This meeting is being recorded to prepare the minutes');
  await expect(page.locator('#copy-note')).toHaveCount(0);
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text: string) => void (window as unknown as { copied: string[] }).copied.push(text) }, configurable: true }));
  await page.locator('#copy-notice').click();
  await expect(page.locator('#copy-note')).toContainText('Đã sao chép');
  const copied = await page.evaluate(() => (window as unknown as { copied: string[] }).copied);
  expect(copied).toHaveLength(2);
  expect(copied[0]).toContain('Cuộc họp này đang được ghi âm');
  expect(copied[1]).toContain('This meeting is being recorded');
  // Copying ticks nothing: #start stays disabled until title + consentMethod + consentAgreed are all completed.
  const titleInput = page.locator('#title');
  await expect(titleInput).toBeEditable();
  await expect(page.locator('#start')).toBeDisabled();
  await titleInput.fill('Họp thử');
  await expect(page.locator('#start')).toBeDisabled();
  await page.locator('#method').selectOption('in_call_chat');
  await expect(page.locator('#start')).toBeDisabled();
  await page.locator('#agreed').check();
  await expect(page.locator('#start')).toBeEnabled();
  await page.close();
});

test('a recording that ended by itself shows when and why in the popup and the badge, until the member says they saw it (A1, #3159)', async () => {
  await seed({ meetings: true });
  const worker = context.serviceWorkers()[0]!;
  await worker.evaluate(
    async ([origin]) => {
      await chrome.storage.local.set({
        'ludy-extension-recording-lost': {
          meetingId: 'm1',
          title: 'Họp thử',
          reason: 'tab_closed',
          at: Date.now(),
          uploaded: true,
          orgId: 'org1',
          address: origin,
          tokenId: 't1',
        },
      });
      await chrome.action.setBadgeText({ text: '!' });
    },
    [apiOrigin] as const,
  );
  const page = await popupGranted();
  const lost = page.locator('#lost');
  await expect(lost).toContainText('Ghi âm đã dừng lúc');
  await expect(lost).toContainText('Tab họp đã đóng');
  await expect(lost).toContainText('đã được tải lên');
  await page.locator('#lost-dismiss').click();
  await expect(page.locator('#lost')).toHaveCount(0);
  expect(await worker.evaluate(() => chrome.action.getBadgeText({}))).toBe('');
  await page.close();
});

test('a redirect from the configured API origin is not followed: the token goes nowhere else', async () => {
  const elsewhere = await startFakeLudy();
  try {
    await seed({});
    fakeApi.redirectMeTo = elsewhere.origin;
    const page = await popup();
    await expect(page.getByText('Không lấy được thông tin từ Ludy')).toBeVisible();
    await page.close();
    expect(elsewhere.requests).toEqual([]);
  } finally {
    fakeApi.redirectMeTo = null;
    await elsewhere.close();
  }
});

test('the worker refuses a start request whose flags are not booleans, and creates no meeting', async () => {
  await seed({ meetings: true });
  fakeApi.created.length = 0;
  const page = await popup();
  const replies = await page.evaluate(async () => {
    const base = { type: 'start', title: 'Họp', consentMethod: 'told_at_start', streamId: 'x' };
    return [
      await chrome.runtime.sendMessage({ ...base, consentAgreed: 'true', keepVideo: false, liveNotes: false }),
      await chrome.runtime.sendMessage({ ...base, consentAgreed: true, keepVideo: 'false', liveNotes: false }),
    ];
  });
  await page.close();
  expect(replies).toEqual([
    { ok: false, reason: 'invalid' },
    { ok: false, reason: 'invalid' },
  ]);
  expect(fakeApi.created).toEqual([]);
});

test('Notes Quick Capture saves private note and to-do with zero optional permissions, while Web Clipper requires opt-in toggle', async () => {
  await seed({});
  fakeApi.scopes = ['notes'];
  fakeApi.features = { meetings: false, notes: true };
  fakeApi.clips.length = 0;
  fakeApi.todos.length = 0;
  const page = await popup();
  try {
    await expect(page.locator('#notes-capture')).toBeVisible();
    await expect(page.locator('#clipper-toggle')).not.toBeChecked();
    await expect(page.locator('#clip-now')).toHaveCount(0);

    // Quick Capture note works with zero extra browser permissions.
    await page.locator('#capture-title').fill('Ghi chú nhanh e2e');
    await page.locator('#capture-body').fill('Nội dung e2e');
    await page.locator('#capture-tags').fill('e2e, nhanh');
    await page.locator('#capture-save').click();
    await expect.poll(() => fakeApi.clips.length).toBe(1);
    expect(fakeApi.clips[0]).toEqual({ title: 'Ghi chú nhanh e2e', body: 'Nội dung e2e', tags: ['e2e', 'nhanh'] });
    await expect(page.locator('#notes-status')).toContainText('Đã lưu ghi chú riêng tư');

    // Switch to To-do Quick Capture and save.
    await page.locator('#mode-todo').click();
    await page.locator('#capture-title').fill('Việc nhanh e2e');
    await page.locator('#capture-details').fill('Chi tiết việc');
    await page.locator('#capture-save').click();
    await expect.poll(() => fakeApi.todos.length).toBe(1);
    expect(fakeApi.todos[0]).toEqual({ title: 'Việc nhanh e2e', details: 'Chi tiết việc' });
    await expect(page.locator('#notes-status')).toContainText('Đã lưu việc cá nhân');

    // Enabling Web Clipper explicitly requests activeTab + scripting and allows 1-click Clip; turning it OFF revokes them.
    await page.evaluate(() => {
      const held = new Set<string>();
      const events: { requested: string[][]; removed: string[][] } = { requested: [], removed: [] };
      (window as unknown as { clipperEvents: typeof events }).clipperEvents = events;
      (chrome.permissions as { contains: unknown }).contains = async ({ permissions = [] }: { permissions?: string[] }) =>
        permissions.every((p) => held.has(p));
      (chrome.permissions as { request: unknown }).request = async ({ permissions = [] }: { permissions?: string[] }) => {
        events.requested.push([...permissions]);
        for (const p of permissions) held.add(p);
        return true;
      };
      (chrome.permissions as { remove: unknown }).remove = async ({ permissions = [] }: { permissions?: string[] }) => {
        events.removed.push([...permissions]);
        for (const p of permissions) held.delete(p);
        return true;
      };
      (chrome.tabs as { query: unknown }).query = async () => [{ id: 42, url: 'https://example.com/clip-target' }];
      (chrome as unknown as { scripting: { executeScript: unknown } }).scripting = {
        executeScript: async () => [
          {
            result: {
              url: 'https://example.com/clip-target',
              title: 'Trang tin mẫu',
              selectedHtml: '',
              selectedText: '',
              contentHtml: '<h1>Tiêu đề bài viết</h1><p>Đoạn trích sạch</p>',
              textFallback: 'Tiêu đề bài viết Đoạn trích sạch',
            },
          },
        ],
      };
    });

    await page.locator('#clipper-toggle').check();
    await expect(page.locator('#clip-now')).toBeVisible();
    await page.locator('#clip-now').click();
    await expect.poll(() => fakeApi.clips.length).toBe(2);
    expect(fakeApi.clips[1]).toEqual({
      title: 'Trang tin mẫu',
      body: '# Tiêu đề bài viết\n\nĐoạn trích sạch',
      sourceUrl: 'https://example.com/clip-target',
    });

    await page.locator('#clipper-toggle').uncheck();
    await expect(page.locator('#clip-now')).toHaveCount(0);
    const permEvents = await page.evaluate(() => (window as unknown as { clipperEvents: { requested: string[][]; removed: string[][] } }).clipperEvents);
    expect(permEvents.requested).toEqual([['activeTab', 'scripting']]);
    expect(permEvents.removed).toEqual([['activeTab', 'scripting']]);

    // Real-DOM snapshotDomPage sanity check: stripped form inputs, hidden nodes, scripts and nav never leak into textFallback.
    const articlePage = await context.newPage();
    try {
      await articlePage.setContent(`
        <nav>Menu Item</nav>
        <div id="only-hidden">
          <div hidden>HIDDEN_SECRET_TEXT</div>
          <div style="display:none">STYLE_HIDDEN_TEXT</div>
          <div hidden><article>${'HIDDEN_ANCESTOR_ARTICLE '.repeat(10)}</article></div>
          <div aria-hidden="true"><main>${'ARIA_HIDDEN_MAIN '.repeat(10)}</main></div>
          <div style="display: none"><article>${'INLINE_HIDDEN_ARTICLE '.repeat(10)}</article></div>
          <form><textarea>SECRET_TEXTAREA</textarea><input type="password" value="SECRET_PW" /></form>
          <script>const secretVar = "SECRET_SCRIPT";</script>
        </div>
        <p id="real-text">Clean article body</p>
      `);
      const snap = await articlePage.evaluate(snapshotDomPage);
      expect(snap.textFallback).toBe('Clean article body');
      expect(snap.contentHtml).not.toContain('HIDDEN_SECRET_TEXT');
      expect(snap.contentHtml).not.toContain('STYLE_HIDDEN_TEXT');
      expect(snap.contentHtml).not.toContain('HIDDEN_ANCESTOR_ARTICLE');
      expect(snap.contentHtml).not.toContain('ARIA_HIDDEN_MAIN');
      expect(snap.contentHtml).not.toContain('INLINE_HIDDEN_ARTICLE');
      expect(snap.contentHtml).not.toContain('SECRET_TEXTAREA');
      expect(snap.contentHtml).not.toContain('SECRET_SCRIPT');
      expect(snap.contentHtml).not.toContain('Menu Item');

      await articlePage.setContent(`
        <div hidden><article>${'LONGER_HIDDEN_ARTICLE '.repeat(20)}</article></div>
        <article>${'Visible primary article '.repeat(8).trim()}</article>
      `);
      const rankedSnap = await articlePage.evaluate(snapshotDomPage);
      expect(rankedSnap.textFallback).toBe('Visible primary article '.repeat(8).trim());
      expect(rankedSnap.contentHtml).not.toContain('LONGER_HIDDEN_ARTICLE');
    } finally {
      await articlePage.close();
    }
  } finally {
    fakeApi.scopes = ['meetings'];
    fakeApi.features = { meetings: true, notes: false };
    await page.close();
  }
});
