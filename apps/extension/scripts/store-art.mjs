// SPDX-License-Identifier: AGPL-3.0-only
// Regenerates the Chrome Web Store images in apps/extension/store (docs/runbooks/extension-store.md): three 1280x800
// screenshots, the 440x280 small tile and the 1400x560 marquee, each in Vietnamese and English, as JPEG (the store refuses
// an alpha channel). Screenshots 1 and 2 are the real popup, loaded unpacked in Chromium against the e2e fake Ludy
// (e2e/fake-ludy.ts), so they hold no customer data; the fake server's local address is shown as https://app.ludy.vn, the
// address a Ludy Cloud member sees. Screenshot 3 (the consent step) is text only: the consent form needs the tabCapture
// permission, which automation cannot grant.
//
// Run after `node scripts/build.mjs`: `node scripts/store-art.mjs` (from apps/extension). It writes into store/.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { startFakeLudy } from '../e2e/fake-ludy.ts';

const dist = fileURLToPath(new URL('../dist', import.meta.url));
const out = fileURLToPath(new URL('../store', import.meta.url));
const mark = readFileSync(fileURLToPath(new URL('../../web/public/brand/ludy-mark.svg', import.meta.url)), 'utf8').replace('<svg ', '<svg width="100%" height="100%" ');
const shots = {};

// 1. The real popup, signed out and signed in, per language.
const fake = await startFakeLudy();
try {
  for (const lang of ['vi', 'en-US']) {
    const profile = mkdtempSync(`${tmpdir()}/ludy-store-art-`);
    const context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
      args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, `--lang=${lang}`],
      locale: lang,
      deviceScaleFactor: 2,
    });
    try {
      const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
      const id = new URL(worker.url()).host;
      const shot = async (name) => {
        const page = await context.newPage();
        await page.setViewportSize({ width: 380, height: 600 });
        await page.goto(`chrome-extension://${id}/popup.html`);
        await page.waitForTimeout(800);
        await page.evaluate(() => {
          const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          for (let n = walk.nextNode(); n; n = walk.nextNode()) n.nodeValue = n.nodeValue.replace(/http:\/\/127\.0\.0\.1:\d+/g, 'https://app.ludy.vn');
        });
        const height = await page.evaluate(() => document.body.scrollHeight);
        await page.setViewportSize({ width: 380, height: Math.min(Math.max(height, 300), 760) });
        shots[`${lang.slice(0, 2)}-${name}`] = (await page.screenshot()).toString('base64');
        await page.close();
      };
      await shot('connect');
      await worker.evaluate(
        ([origin]) =>
          chrome.storage.local.set({
            'ludy-extension-state': { address: origin, accounts: { org1: { orgId: 'org1', orgSlug: 'cong-ty-mau', token: 'crx_test', expiresAt: '2027-01-01T00:00:00.000Z' } }, activeOrg: 'org1', enabled: {} },
          }),
        [fake.origin],
      );
      await shot('feature');
    } finally {
      await context.close();
      rmSync(profile, { recursive: true, force: true });
    }
  }
} finally {
  await fake.close();
}

// 2. The store images around them.
const T = {
  en: {
    s1: ['Record browser meetings into Ludy', ['Google Meet, and Teams or Zoom in the browser', 'Tab audio together with your microphone', 'Uploaded to your Ludy workspace when you stop'], 'en-feature'],
    s2: ['Sign in without sharing your password', ['Ludy Cloud or your company’s own Ludy server', 'Approve the extension for one workspace', 'Revoke it any time in Ludy, connected devices'], 'en-connect'],
    s3: ['Consent comes first', ['Before recording, confirm everyone was told', 'No confirmation, no recording', 'REC badge and timer stay visible', 'Video only if you tick it'], null],
    tag: 'Meeting notes for small businesses',
    sub: 'Record in your browser. Summary, decisions and action items in Ludy.',
  },
  vi: {
    s1: ['Ghi cuộc họp trên trình duyệt vào Ludy', ['Google Meet, và Teams hoặc Zoom bản web', 'Ghi âm tab họp cùng micro của bạn', 'Tải lên tổ chức Ludy khi bạn dừng'], 'vi-feature'],
    s2: ['Đăng nhập không cần đưa mật khẩu', ['Ludy Cloud hoặc máy chủ Ludy của công ty bạn', 'Cho phép tiện ích làm việc với một tổ chức', 'Thu hồi bất cứ lúc nào trong Ludy'], 'vi-connect'],
    s3: ['Đồng ý trước, ghi sau', ['Xác nhận đã báo cho mọi người trước khi ghi', 'Không xác nhận thì không ghi được', 'Luôn hiện REC và đồng hồ khi đang ghi', 'Chỉ ghi video khi bạn tích chọn'], null],
    tag: 'Ghi chú cuộc họp cho doanh nghiệp nhỏ',
    sub: 'Ghi trên trình duyệt. Tóm tắt, quyết định và việc cần làm trong Ludy.',
  },
};
const css = `*{box-sizing:border-box;margin:0}body{font-family:'Noto Sans','DejaVu Sans',Arial,sans-serif;background:linear-gradient(135deg,#f6f2ff 0%,#ffffff 55%,#eaf6f3 100%);color:#1d1533}
.wrap{display:flex;align-items:center;height:100%;padding:64px;gap:56px}.mark{width:56px;height:56px}.h{font-size:46px;font-weight:700;line-height:1.15;color:#2b1470;margin:28px 0}
ul{list-style:none;padding:0}li{font-size:25px;line-height:1.35;margin:14px 0;padding-left:34px;position:relative}li:before{content:'';position:absolute;left:0;top:11px;width:14px;height:14px;border-radius:4px;background:#0A6A5B}
.card{flex:0 0 auto;background:#fff;border-radius:18px;box-shadow:0 18px 50px rgba(68,32,154,.22);padding:14px;border:1px solid #e6defa}.card img{display:block;width:420px;border-radius:8px}.left{flex:1}`;
const slide = ([heading, items, shot]) =>
  `<div class="wrap"><div class="left"><div class="mark">${mark}</div><div class="h">${heading}</div><ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul></div>${
    shot ? `<div class="card"><img src="data:image/png;base64,${shots[shot]}"></div>` : `<div style="flex:0 0 360px;height:360px">${mark}</div>`
  }</div>`;
const tile = (t, big) =>
  `<div style="height:100%;display:flex;align-items:center;gap:${big ? 48 : 22}px;padding:${big ? 90 : 28}px;background:linear-gradient(135deg,#2b1470,#612BD3)"><div style="flex:0 0 ${big ? 220 : 96}px;height:${big ? 220 : 96}px;background:#fff;border-radius:${big ? 40 : 20}px;padding:${big ? 30 : 13}px">${mark}</div><div style="color:#fff"><div style="font-size:${big ? 92 : 46}px;font-weight:700">Ludy</div><div style="font-size:${big ? 38 : 19}px;margin-top:${big ? 10 : 4}px;font-weight:600">${t.tag}</div>${
    big ? `<div style="font-size:26px;margin-top:18px;opacity:.9">${t.sub}</div>` : ''
  }</div></div>`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  const render = async (html, width, height, name) => {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.setContent(`<html><head><style>${css} html,body{width:${width}px;height:${height}px}</style></head><body>${html}</body></html>`);
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${out}/${name}.jpg`, type: 'jpeg', quality: 95 });
    await page.close();
  };
  for (const lang of ['en', 'vi']) {
    const t = T[lang];
    await render(slide(t.s1), 1280, 800, `${lang}-1-screenshot-1280x800`);
    await render(slide(t.s2), 1280, 800, `${lang}-2-screenshot-1280x800`);
    await render(slide(t.s3), 1280, 800, `${lang}-3-screenshot-1280x800`);
    await render(tile(t, false), 440, 280, `${lang}-small-tile-440x280`);
    await render(tile(t, true), 1400, 560, `${lang}-marquee-1400x560`);
  }
} finally {
  await browser.close();
}
console.log(`Wrote the store images to ${out}`);
