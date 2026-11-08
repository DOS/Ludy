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
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
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
