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
import { snapshotDomPage } from '../src/page-capture.ts';
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
    // The browser's language drives the popup's language (#3008): Vietnamese here, so the texts below hold. Under Playwright it is the context's `locale` that a page's
    // chrome.i18n.getUILanguage answers (the flag alone does not change it), so the locale decides what the tests see; a real browser's interface language is not tested here.
    locale: 'vi-VN',
    // The manifest's name and description are resolved from _locales by the browser's own interface language, which on Linux comes from LANGUAGE (not from --lang or the context locale).
    env: { ...process.env, LANGUAGE: 'vi' },
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
  expect([...(manifest.optional_permissions ?? [])].sort()).toEqual(['activeTab', 'offscreen', 'scripting', 'tabCapture']);
  // The one page a website may navigate to (#4662): the sign-in tab's landing page, for the cloud address and localhost only; not a permission, so no install or update warning.
  expect((manifest as { web_accessible_resources?: unknown }).web_accessible_resources).toEqual([{ resources: ['connected.html'], matches: ['https://app.ludy.vn/*', 'http://localhost/*'] }]);
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
  const englishProfile = mkdtempSync(`${tmpdir()}/ludy-ext-en-`);
  const english = await chromium.launchPersistentContext(englishProfile, {
    channel: 'chromium',
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--lang=en-US'],
    locale: 'en-US',
    env: { ...process.env, LANGUAGE: 'en_US' },
  });
  try {
    const worker = english.serviceWorkers()[0] ?? (await english.waitForEvent('serviceworker'));
    // The localized manifest: the browser resolves the __MSG_ references from _locales, English here.
    const englishManifest = await worker.evaluate(() => chrome.runtime.getManifest());
    expect(englishManifest.name).toBe('Ludy');
    expect(englishManifest.description).toBe("Record a browser meeting's tab audio and your microphone into Ludy, and upload it when you stop.");
    const page = await english.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
    await expect(page.getByText('Connect to Ludy')).toBeVisible();
    await expect(page.getByText('Kết nối với Ludy')).toHaveCount(0);
  } finally {
    await english.close();
    rmSync(englishProfile, { recursive: true, force: true });
  }
  const vietnameseManifest = await context.serviceWorkers()[0]!.evaluate(() => chrome.runtime.getManifest());
  expect(vietnameseManifest.name).toBe('Ludy');
  expect(vietnameseManifest.description).toBe('Ghi lại cuộc họp trên trình duyệt vào Ludy: ghi âm tab họp cùng micro, tải lên khi dừng.');
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
  // Signed out, pointing at the fake Ludy on 127.0.0.1, an address the manifest does not let reach the landing page (only the cloud address and localhost are listed), so the
  // sign-in keeps the browser window (#4662). The popup's own sign-in runs; only the browser window is replaced: it answers
  // with the redirect address the extension asked for plus a code, as the app's connect page would.
  const worker = context.serviceWorkers()[0]!;
  await worker.evaluate((origin) => chrome.storage.local.set({ 'ludy-extension-state': { address: origin, accounts: {}, activeOrg: null, enabled: {} } }), fake.origin);
  fake.requests.length = 0;
  fake.exchanges.length = 0;
  const page = await popup();
  // The sign-in step says, before the button, that the browser and operating system name is sent (#3273).
  await expect(page.locator('#sign-in-device-note')).toContainText('tên thiết bị');
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

// Sign-in in a normal tab (#4662). The fake Ludy answers on `localhost` here, which the manifest lets reach the landing page (the cloud address is the other); the tab the popup opens
// is a real tab of the fake's origin, and the test sends it to the landing page the way the app's connect page does: a navigation started by that page, which the browser allows
// only because of web_accessible_resources.
const localOrigin = () => fake.origin.replace('127.0.0.1', 'localhost');
const signedOut = async (address: string) => {
  await context.serviceWorkers()[0]!.evaluate((origin) => chrome.storage.local.set({ 'ludy-extension-state': { address: origin, accounts: {}, activeOrg: null, enabled: {} } }), address);
  fake.requests.length = 0;
  fake.exchanges.length = 0;
};
const CODE = `crc_${'B'.repeat(43)}`;

test('sign-in opens one normal tab, which the landing page finishes and closes (#4662)', async () => {
  await signedOut(localOrigin());
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
  expect(asked.origin).toBe(localOrigin());
  expect(asked.pathname).toBe('/-/extension/connect');
  const redirect = asked.searchParams.get('redirect_uri') ?? '';
  expect(redirect).toBe(`chrome-extension://${extensionId}/connected.html`);
  expect(asked.searchParams.get('code_challenge_method')).toBe('S256');
  expect(asked.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const state = asked.searchParams.get('state') ?? '';
  expect(state).not.toBe('');
  // No browser window was asked for, and nothing is exchanged before the app answers.
  expect(await page.evaluate(() => (window as unknown as { windowFlows: number }).windowFlows)).toBe(0);
  expect(fake.exchanges).toHaveLength(0);

  // The app's connect page, once the member approved: the tab itself goes to the extension's landing page with the code.
  await tab.evaluate((to) => location.assign(to), `${redirect}?code=${CODE}&org=cong-ty&state=${state}`).catch(() => undefined);
  await tab.waitForURL(`chrome-extension://${extensionId}/connected.html`);
  await expect(tab.getByText('Đã kết nối với Ludy')).toBeVisible();
  await expect.poll(() => fake.exchanges.length).toBe(1);
  expect(fake.exchanges[0]).toEqual({ code: CODE, codeVerifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
  const exchange = fake.requests.filter((r) => r.method === 'POST' && r.path === '/api/extension/token');
  expect(exchange).toHaveLength(1);
  expect(exchange[0]!.origin).toBe(`chrome-extension://${extensionId}`);
  const stored = (await context.serviceWorkers()[0]!.evaluate(async () => (await chrome.storage.local.get('ludy-extension-state'))['ludy-extension-state'])) as { activeOrg: string; accounts: Record<string, { orgSlug: string; token: string }> };
  expect(stored.activeOrg).toBe('org1');
  expect(stored.accounts.org1).toMatchObject({ orgSlug: 'cong-ty', token: 'crx_signed_in' });
  // The tab closes itself; the popup shows the signed-in state the next time it opens.
  await expect.poll(() => tab.isClosed(), { timeout: 10_000 }).toBe(true);
  await page.close();
  const again = await popup();
  await expect(again.locator('#org')).toBeVisible();
  await expect(again.locator('#org option')).toHaveText(['cong-ty']);
  await again.close();
});

test('the landing page ignores an answer with another state, and finishes the sign-in that is waiting (#4662)', async () => {
  await signedOut(localOrigin());
  const page = await popup();
  const [tab] = await Promise.all([context.waitForEvent('page'), page.getByRole('button', { name: 'Đăng nhập Ludy' }).click()]);
  await tab.waitForURL(/\/-\/extension\/connect\?/);
  const asked = new URL(tab.url());
  const redirect = asked.searchParams.get('redirect_uri') ?? '';
  const state = asked.searchParams.get('state') ?? '';
  // A forged or stale answer: another state. It trades nothing and leaves the pending sign-in alone.
  const stranger = await context.newPage();
  await stranger.goto(`${localOrigin()}/`);
  await stranger.evaluate((to) => location.assign(to), `${redirect}?code=${CODE}&org=cong-ty&state=not-the-state`).catch(() => undefined);
  await stranger.waitForURL(`chrome-extension://${extensionId}/connected.html`);
  await expect(stranger.getByText('Không có lần đăng nhập nào đang chờ')).toBeVisible();
  expect(fake.exchanges).toHaveLength(0);
  await stranger.close();
  // The real answer still finishes it.
  await tab.evaluate((to) => location.assign(to), `${redirect}?code=${CODE}&org=cong-ty&state=${state}`).catch(() => undefined);
  await tab.waitForURL(`chrome-extension://${extensionId}/connected.html`);
  await expect(tab.getByText('Đã kết nối với Ludy')).toBeVisible();
  await expect.poll(() => fake.exchanges.length).toBe(1);
  await page.close();
});

test('a tab the browser will not open keeps the browser window (#4662)', async () => {
  await signedOut(localOrigin());
  const page = await popup();
  await page.evaluate(() => {
    const seen: { windowRedirect: string } = { windowRedirect: '' };
    (chrome.tabs as { create: unknown }).create = async () => {
      throw new Error('blocked');
    };
    (chrome.identity as { launchWebAuthFlow: unknown }).launchWebAuthFlow = async ({ url }: { url: string }) => {
      const params = new URL(url).searchParams;
      seen.windowRedirect = params.get('redirect_uri') ?? '';
      const back = new URL(seen.windowRedirect);
      back.searchParams.set('code', `crc_${'C'.repeat(43)}`);
      back.searchParams.set('org', 'cong-ty');
      back.searchParams.set('state', params.get('state') ?? '');
      return back.toString();
    };
    (window as unknown as { seen: typeof seen }).seen = seen;
  });
  await page.getByRole('button', { name: 'Đăng nhập Ludy' }).click();
  await expect.poll(() => fake.exchanges.length).toBe(1);
  const redirect = await page.evaluate(() => (window as unknown as { seen: { windowRedirect: string } }).seen.windowRedirect);
  expect(new URL(redirect).hostname).toBe(`${extensionId}.chromiumapp.org`);
  // The tab route left nothing pending behind: a landing page opened now finds no sign-in waiting.
  const pending = await context.serviceWorkers()[0]!.evaluate(async () => (await chrome.storage.session.get('ludy-pending-signin'))['ludy-pending-signin']);
  expect(pending).toBeUndefined();
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
  expect(fake.created).toEqual([{ title: 'Họp thử', language: 'vi', visibility: 'attendees', keepVideo: false, consentMethod: 'told_at_start', consentNoticeVersion: '2026-11-v1', liveNotes: false }]);
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

// A1 (#3159): the meeting tab's track ends while recording (the tab was closed or its capture taken away). The capture reports it
// once, with a code, and what was saved is uploaded with that code; a stop the member asks for carries none.
test('a recording whose tab ends by itself uploads what it has with the reason code', async () => {
  fake.created.length = 0;
  fake.uploads.length = 0;
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
    [`chrome-extension://${extensionId}/`, fake.origin] as const,
  );
  await page.close();
  expect(result).toEqual({ ok: true, reasons: ['tab_closed'], uploaded: true });
  expect(fake.created[0]).toMatchObject({ consentMethod: 'in_call_chat', consentNoticeVersion: '2026-11-v1' });
  expect(fake.uploads).toHaveLength(1);
  expect(fake.uploads[0]).toMatchObject({ kind: 'audio', stopReason: 'tab_closed' });
});

// A2 (#3160): a strict org refuses a consent method that is not written; the capture reports it as its own failure, opens no recording
// and leaves nothing on the device, and a written method works.
test('a strict org refuses "said at the start" and accepts a written method', async () => {
  fake.created.length = 0;
  fake.strict = true;
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
    [`chrome-extension://${extensionId}/`, fake.origin] as const,
  );
  await page.close();
  fake.strict = false;
  expect(outcome).toEqual({ refused: 'consentPolicy', written: true });
  expect(fake.created).toHaveLength(1);
  expect(fake.created[0]).toMatchObject({ consentMethod: 'in_call_chat' });
});

test('a stop the member asks for carries no reason code', async () => {
  fake.uploads.length = 0;
  expect(await record(false)).toMatchObject({ ok: true, uploaded: true });
  expect(fake.uploads[0]).toMatchObject({ stopReason: null });
});

test('the consent step shows the recording notice: the text, the other language, copied to the clipboard on the click, and the draft marker (A1, #3159)', async () => {
  await seed({ meetings: true });
  const page = await popupGranted();
  await expect(page.locator('#notice-text')).toContainText('Cuộc họp này đang được ghi âm để lập biên bản');
  await expect(page.getByText('#2585').first()).toBeVisible();
  // The new method is one of the choices.
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
  // Copying ticks nothing: the start is still refused without the method and the confirmation.
  const titleInput = page.locator('#title');
  await expect(titleInput).toBeEditable();
  await titleInput.fill('Họp thử');
  await expect(titleInput).toHaveValue('Họp thử');
  await expect(page.locator('#start')).toBeEnabled();
  await page.locator('#start').click();
  await expect(page.getByRole('alert')).toContainText('Vui lòng chọn cách đã báo cho người tham gia');
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
    [fake.origin] as const,
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
      await chrome.runtime.sendMessage({ ...base, consentAgreed: 'true', keepVideo: false, liveNotes: false }),
      await chrome.runtime.sendMessage({ ...base, consentAgreed: true, keepVideo: 'false', liveNotes: false }),
    ];
  });
  await page.close();
  expect(replies).toEqual([
    { ok: false, reason: 'invalid' },
    { ok: false, reason: 'invalid' },
  ]);
  expect(fake.created).toEqual([]);
});

test('Notes Quick Capture saves private note and to-do with zero optional permissions, while Web Clipper requires opt-in toggle', async () => {
  await seed({});
  fake.scopes = ['notes'];
  fake.features = { meetings: false, notes: true };
  fake.clips.length = 0;
  fake.todos.length = 0;
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
    await expect.poll(() => fake.clips.length).toBe(1);
    expect(fake.clips[0]).toEqual({ title: 'Ghi chú nhanh e2e', body: 'Nội dung e2e', tags: ['e2e', 'nhanh'] });
    await expect(page.locator('#notes-status')).toContainText('Đã lưu ghi chú riêng tư');

    // Switch to To-do Quick Capture and save.
    await page.locator('#mode-todo').click();
    await page.locator('#capture-title').fill('Việc nhanh e2e');
    await page.locator('#capture-details').fill('Chi tiết việc');
    await page.locator('#capture-save').click();
    await expect.poll(() => fake.todos.length).toBe(1);
    expect(fake.todos[0]).toEqual({ title: 'Việc nhanh e2e', details: 'Chi tiết việc' });
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
    await expect.poll(() => fake.clips.length).toBe(2);
    expect(fake.clips[1]).toEqual({
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
    fake.scopes = ['meetings'];
    fake.features = { meetings: true, notes: false };
    await page.close();
  }
});
