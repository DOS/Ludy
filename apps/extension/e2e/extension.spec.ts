// SPDX-License-Identifier: AGPL-3.0-only
// The unpacked extension in Chromium with fake media devices. tabCapture needs a click on the real extension icon and the
// browser's permission prompts, which automation cannot answer, so the capture path is driven below the click: the
// offscreen document's own module with a fake tab stream. The 60-minute Google Meet run in Chrome and Edge is a manual
// test (docs in the PR); this does not replace it.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { startFakeLudy, type FakeLudy } from './fake-ludy.ts';

const pkg = fileURLToPath(new URL('..', import.meta.url));
const dist = fileURLToPath(new URL('../dist', import.meta.url));
let context: BrowserContext;
let profile: string;
let fake: FakeLudy;
let extensionId: string;

test.beforeAll(async () => {
  execFileSync('node', ['scripts/build.mjs'], { cwd: pkg, stdio: 'inherit' });
  fake = await startFakeLudy();
  profile = mkdtempSync(`${tmpdir()}/ludy-ext-`);
  context = await chromium.launchPersistentContext(profile, {
    // The new headless mode loads extensions; CHROMIUM_PATH points at a browser installed elsewhere (a sandbox).
    channel: 'chromium',
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--lang=vi'],
    // The browser's language drives the popup's language (#3008): Vietnamese here, so the texts below hold. Playwright's own locale is what the pages see (an extension page's
    // chrome.i18n.getUILanguage included, once a page is open), so it is set with the flag.
    locale: 'vi-VN',
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(worker.url()).host;
});

test.afterAll(async () => {
  await context.close();
  await fake.close();
  rmSync(profile, { recursive: true, force: true });
});

const seed = async (enabled: Record<string, boolean>) => {
  const worker = context.serviceWorkers()[0]!;
  await worker.evaluate(
    ([origin, on]) =>
      chrome.storage.local.set({
        'ludy-extension-state': { address: origin, accounts: { org1: { orgId: 'org1', orgSlug: 'cong-ty', token: 'crx_test', expiresAt: '2027-01-01T00:00:00.000Z' } }, activeOrg: 'org1', enabled: on },
      }),
    [fake.origin, enabled] as const,
  );
};

const popup = async (): Promise<Page> => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  return page;
};

test('the installed manifest asks for nothing beyond the list', async () => {
  const manifest = await context.serviceWorkers()[0]!.evaluate(() => chrome.runtime.getManifest());
  expect([...(manifest.permissions ?? [])].sort()).toEqual(['identity', 'storage']);
  expect(manifest.host_permissions).toEqual(['https://app.ludy.vn/*']);
  expect([...(manifest.optional_permissions ?? [])].sort()).toEqual(['offscreen', 'tabCapture']);
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

test('the popup is Vietnamese in a Vietnamese browser and English in an English one (#3008)', async () => {
  const english = await chromium.launchPersistentContext(mkdtempSync(`${tmpdir()}/ludy-ext-en-`), {
    channel: 'chromium',
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--lang=en-US'],
    locale: 'en-US',
  });
  try {
    const worker = english.serviceWorkers()[0] ?? (await english.waitForEvent('serviceworker'));
    const page = await english.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
    await expect(page.getByText('Connect to Ludy')).toBeVisible();
    await expect(page.getByText('Kết nối với Ludy')).toHaveCount(0);
  } finally {
    await english.close();
  }
  const vietnamese = await context.newPage();
  await vietnamese.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(vietnamese.getByText('Kết nối với Ludy')).toBeVisible();
  await vietnamese.close();
});

test('with meetings off in the org the feature does not show, with it on it does', async () => {
  await seed({});
  fake.features.meetings = false;
  let page = await popup();
  await expect(page.getByText('Tổ chức này chưa bật tính năng nào')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Ghi cuộc họp' })).toHaveCount(0);
  await page.close();

  fake.features.meetings = true;
  page = await popup();
  await expect(page.getByRole('heading', { name: 'Ghi cuộc họp' })).toBeVisible();
  // Not turned on yet: only the opt-in button, no consent form, no capture.
  await expect(page.getByRole('button', { name: 'Bật ghi cuộc họp' })).toBeVisible();
  await expect(page.locator('#agreed')).toHaveCount(0);
  await page.close();
});

test('the code exchange carries the extension\'s own Origin, which the kernel binds the code to (#2850)', async () => {
  // Signed out, pointing at the fake Ludy. The popup's own sign-in runs; only the browser window is replaced: it answers
  // with the redirect address the extension asked for plus a code, as the app's connect page would.
  const worker = context.serviceWorkers()[0]!;
  await worker.evaluate((origin) => chrome.storage.local.set({ 'ludy-extension-state': { address: origin, accounts: {}, activeOrg: null, enabled: {} } }), fake.origin);
  fake.requests.length = 0;
  fake.exchanges.length = 0;
  const page = await popup();
  await page.evaluate(() => {
    const seen: { redirect: string } = { redirect: '' };
    (chrome.identity as { launchWebAuthFlow: unknown }).launchWebAuthFlow = async ({ url }: { url: string }) => {
      const params = new URL(url).searchParams;
      seen.redirect = params.get('redirect_uri') ?? '';
      const back = new URL(seen.redirect);
      back.searchParams.set('code', `crc_${'A'.repeat(43)}`);
      back.searchParams.set('org', 'cong-ty');
      back.searchParams.set('state', params.get('state') ?? '');
      return back.toString();
    };
    (window as unknown as { seen: typeof seen }).seen = seen;
  });
  await page.getByRole('button', { name: 'Đăng nhập Ludy' }).click();
  await expect.poll(() => fake.exchanges.length).toBe(1);
  const redirect = await page.evaluate(() => (window as unknown as { seen: { redirect: string } }).seen.redirect);
  // The address the extension asked the app to send the code to is its own id's, and the exchange request says the same id.
  expect(redirect).not.toBe('');
  expect(new URL(redirect).hostname).toBe(`${extensionId}.chromiumapp.org`);
  const exchange = fake.requests.filter((r) => r.method === 'POST' && r.path === '/api/extension/token');
  expect(exchange).toHaveLength(1);
  expect(exchange[0]!.origin).toBe(`chrome-extension://${extensionId}`);
  expect(fake.exchanges[0]).toEqual({ code: `crc_${'A'.repeat(43)}`, codeVerifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
  await page.close();
});

test('the shell talks to the configured address only', async () => {
  await seed({});
  fake.requests.length = 0;
  const seen: string[] = [];
  const onRequest = (r: { url(): string }) => void seen.push(r.url());
  context.on('request', onRequest);
  const page = await popup();
  await expect(page.getByText('Ghi cuộc họp').first()).toBeVisible();
  await page.close();
  context.off('request', onRequest);
  for (const url of seen) expect(url.startsWith(`chrome-extension://${extensionId}/`) || url.startsWith(fake.origin) || url.startsWith('data:') || url === 'about:blank').toBe(true);
  expect(fake.requests.map((r) => r.path)).toContain('/api/extension/me');
});

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
      const params = { address, token: 'crx_test', orgId: 'org1', uploads: 'direct', title: 'Họp thử', consentMethod: 'told_at_start', consentAgreed: true, keepVideo: video, streamId: 'fake' } as const;
      const started = await run.startCapture(params, deps);
      if (!started.ok) return { ok: false, left: 0 };
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const done = await started.running.stop();
      return { ok: true, uploaded: done.uploaded, left: (await deps.store.list('org1')).length };
    },
    [`chrome-extension://${extensionId}/`, fake.origin, keepVideo] as const,
  );
  await page.close();
  return result;
}

test('video off: the meeting is created with its consent and only audio arrives', async () => {
  fake.created.length = 0;
  fake.uploads.length = 0;
  const result = await record(false);
  expect(result).toEqual({ ok: true, uploaded: true, left: 0 });
  expect(fake.created).toEqual([{ title: 'Họp thử', language: 'vi', visibility: 'attendees', keepVideo: false, consentMethod: 'told_at_start' }]);
  expect(fake.uploads).toHaveLength(1);
  expect(fake.uploads[0]).toMatchObject({ kind: 'audio', fileType: expect.stringMatching(/^audio\/webm/) });
  expect(fake.uploads[0]!.bytes).toBeGreaterThan(1000);
});

test('video ticked: the video arrives', async () => {
  fake.created.length = 0;
  fake.uploads.length = 0;
  const result = await record(true);
  expect(result).toEqual({ ok: true, uploaded: true, left: 0 });
  expect(fake.created[0]).toMatchObject({ keepVideo: true });
  expect(fake.uploads).toHaveLength(1);
  expect(fake.uploads[0]).toMatchObject({ kind: 'video', fileType: expect.stringMatching(/^video\/webm/) });
});

test('a failed upload keeps the recording on the device', async () => {
  fake.uploads.length = 0;
  fake.failUploads = true;
  const result = await record(false);
  fake.failUploads = false;
  expect(result).toEqual({ ok: true, uploaded: false, left: 1 });
  expect(fake.uploads).toHaveLength(0);
});

test('a redirect from the configured address is not followed: the token goes nowhere else', async () => {
  const elsewhere = await startFakeLudy();
  try {
    await seed({});
    fake.redirectMeTo = elsewhere.origin;
    const page = await popup();
    await expect(page.getByText('Không lấy được thông tin từ Ludy')).toBeVisible();
    await page.close();
    expect(elsewhere.requests).toEqual([]);
  } finally {
    fake.redirectMeTo = null;
    await elsewhere.close();
  }
});

test('an address the manifest cannot ask for is refused in the form, not by a thrown permission request', async () => {
  await context.serviceWorkers()[0]!.evaluate(() => chrome.storage.local.clear());
  const page = await popup();
  await page.locator('#where-own').check();
  await page.locator('#address').fill('http://127.0.0.1:8080');
  await page.getByRole('button', { name: 'Lưu địa chỉ' }).click();
  await expect(page.getByText('Chỉ nhận địa chỉ https')).toBeVisible();
  await page.close();
});

// The browser's own permission prompt cannot be answered by automation (a real chrome.permissions.request stays open), so the
// permission API is replaced in the popup page by a small fake that keeps the granted patterns; what the tests check is what the
// popup asks of it and what the member sees.
const fakePermissions = (page: Page, granted: string[], mode: 'grant' | 'throw' = 'grant') =>
  page.evaluate(
    ([start, how]) => {
      const held = new Set(start);
      const removed: string[] = [];
      (window as unknown as { perm: { removed: string[]; held: Set<string> } }).perm = { removed, held };
      const api = chrome.permissions as unknown as Record<string, unknown>;
      api.request = async (request: { origins?: string[] }) => {
        if (how === 'throw') throw new Error('The manifest does not list this pattern');
        for (const origin of request.origins ?? []) held.add(origin);
        return true;
      };
      api.remove = async (request: { origins?: string[] }) => {
        for (const origin of request.origins ?? []) {
          held.delete(origin);
          removed.push(origin);
        }
        return true;
      };
      api.contains = async (request: { origins?: string[] }) => (request.origins ?? []).every((origin) => held.has(origin));
    },
    [granted, mode] as const,
  );

const stored = () => context.serviceWorkers()[0]!.evaluate(async () => ((await chrome.storage.local.get('ludy-extension-state'))['ludy-extension-state'] as { address: string }).address);
const setAddress = (address: string) =>
  context.serviceWorkers()[0]!.evaluate((value) => chrome.storage.local.set({ 'ludy-extension-state': { address: value, accounts: {}, activeOrg: null, enabled: {} } }), address);

test('when the browser throws for the permission, the member sees that the address is not allowed and the address stays', async () => {
  await context.serviceWorkers()[0]!.evaluate(() => chrome.storage.local.clear());
  const page = await popup();
  await fakePermissions(page, [], 'throw');
  await page.locator('#where-own').check();
  await page.locator('#address').fill('https://selfhosted.example');
  await page.getByRole('button', { name: 'Lưu địa chỉ' }).click();
  await expect(page.getByText('Chưa cho phép tiện ích nói chuyện với địa chỉ này.')).toBeVisible();
  expect(await stored().catch(() => 'https://app.ludy.vn')).toBe('https://app.ludy.vn');
  await page.close();
});

test('going back to Ludy Cloud gives back the permission for the self-hosted address', async () => {
  await setAddress('https://selfhosted.example');
  const page = await popup();
  await fakePermissions(page, ['https://selfhosted.example/*']);
  expect(await page.evaluate(() => chrome.permissions.contains({ origins: ['https://selfhosted.example/*'] }))).toBe(true);
  await page.locator('#where-cloud').check();
  await page.getByRole('button', { name: 'Lưu địa chỉ' }).click();
  await expect.poll(() => page.evaluate(() => chrome.permissions.contains({ origins: ['https://selfhosted.example/*'] }))).toBe(false);
  expect(await stored()).toBe('https://app.ludy.vn');
  await page.close();
});

test('a popup drawn before another one moved the address gives back the permission of the address stored now', async () => {
  await setAddress('https://first.example');
  const page = await popup();
  await fakePermissions(page, ['https://first.example/*', 'https://second.example/*']);
  // A second popup moved the address to another self-hosted one while this one stayed open.
  await setAddress('https://second.example');
  await page.locator('#where-cloud').check();
  await page.getByRole('button', { name: 'Lưu địa chỉ' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { perm: { removed: string[] } }).perm.removed)).toEqual(['https://second.example/*']);
  expect(await page.evaluate(() => chrome.permissions.contains({ origins: ['https://first.example/*'] }))).toBe(true);
  await page.close();
});

test('the worker refuses a start request whose flags are not booleans, and creates no meeting', async () => {
  await seed({ meetings: true });
  fake.created.length = 0;
  const page = await popup();
  const replies = await page.evaluate(async () => {
    const base = { type: 'start', title: 'Họp', consentMethod: 'told_at_start', streamId: 'x' };
    return [
      await chrome.runtime.sendMessage({ ...base, consentAgreed: 'true', keepVideo: false }),
      await chrome.runtime.sendMessage({ ...base, consentAgreed: true, keepVideo: 'false' }),
    ];
  });
  await page.close();
  expect(replies).toEqual([
    { ok: false, reason: 'invalid' },
    { ok: false, reason: 'invalid' },
  ]);
  expect(fake.created).toEqual([]);
});
