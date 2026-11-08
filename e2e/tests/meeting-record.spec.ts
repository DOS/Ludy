// SPDX-License-Identifier: AGPL-3.0-only
// Record a meeting in the app, end to end (AI Meeting Notes M7, #2581): a real Chromium with a fake microphone records
// with the real MediaRecorder, the page is reloaded mid-recording, the recording is recovered from the real IndexedDB
// store and uploaded through the real media route, and the meeting then has its audio.
// The crove-media sandbox is not part of this stack (compose profile `media`; the worker job that calls it is M4), so
// normalization is covered by the crove-media image job and this test asserts the upload and the decrypted playback.
import { expect, test, type Page } from '@playwright/test';
import { sql } from '../lib/db.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

test.use({
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
});

// What the recorder keeps on the device, read through the page's own IndexedDB.
async function deviceCopy(page: Page): Promise<{ chunkCount: number; chunks: number }> {
  return page.evaluate(
    () =>
      new Promise<{ chunkCount: number; chunks: number }>((resolve, reject) => {
        const open = indexedDB.open('crove-meeting-recordings');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction(['recordings', 'chunks'], 'readonly');
          const metas = tx.objectStore('recordings').getAll();
          const chunks = tx.objectStore('chunks').count();
          tx.oncomplete = () => {
            db.close();
            resolve({ chunkCount: Math.max(0, ...(metas.result as Array<{ chunkCount: number }>).map((m) => m.chunkCount)), chunks: chunks.result });
          };
        };
      }),
  );
}

test('a recording survives a reload, is recovered from the device and uploaded, and the meeting plays its audio', async ({ page }) => {
  await page.goto('/');
  await signInNewUser(page, newEmail('meeting-record'));
  const slug = await createOrg(page, 'Công ty Ghi Âm Họp');

  await test.step('recording cannot start without the confirmation', async () => {
    await page.goto(`/o/${slug}/meetings/record`);
    await page.getByLabel('Tiêu đề cuộc họp').fill('Họp giao ban thử nghiệm');
    const start = page.getByRole('button', { name: 'Bắt đầu ghi' });
    await expect(start).toBeDisabled();
    await page.getByLabel('Hình thức thông báo').selectOption('told_at_start');
    await expect(start).toBeDisabled();
    await page.getByRole('checkbox', { name: /Tôi xác nhận đã thông báo/ }).click();
    await expect(start).toBeEnabled();
    expect(sql(`SELECT 1 FROM crove_meetings.meeting m JOIN crove_kernel.tenant t ON t.org_id = m.org_id WHERE t.slug = :'slug'`, { slug })).toHaveLength(0);
  });

  await test.step('record about 15 seconds of real microphone output', async () => {
    await page.getByRole('button', { name: 'Bắt đầu ghi' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Đang ghi' })).toBeVisible();
    // One chunk is stored every 5 seconds: three chunks are about 15 seconds.
    await expect.poll(async () => (await deviceCopy(page)).chunkCount, { timeout: 40_000 }).toBeGreaterThanOrEqual(3);
    const meetings = sql<{ consent_method: string }>(`SELECT m.consent_method FROM crove_meetings.meeting m JOIN crove_kernel.tenant t ON t.org_id = m.org_id WHERE t.slug = :'slug'`, { slug });
    expect(meetings).toEqual([{ consent_method: 'told_at_start' }]);
  });

  await test.step('reload mid-recording: the saved part is still on the device', async () => {
    await page.reload();
    await expect(page.getByRole('button', { name: 'Bắt đầu ghi' })).toBeVisible();
    expect((await deviceCopy(page)).chunks).toBeGreaterThanOrEqual(3);
  });

  await test.step('the recording is offered again, and uploading it opens the meeting', async () => {
    // A recording whose heartbeat is under 15 seconds old may still be another tab's, so it appears a moment later.
    const card = page.getByText('Bản ghi chưa tải lên');
    await expect(card).toBeVisible({ timeout: 40_000 });
    await expect(page.getByText('Họp giao ban thử nghiệm')).toBeVisible();
    await page.getByRole('button', { name: 'Tải lên', exact: true }).click();
    await expect(page).toHaveURL(/\/meetings\/[0-9a-f-]{36}$/, { timeout: 60_000 });
  });

  await test.step('the meeting has its audio, stored, and the device copy is gone', async () => {
    const rows = sql<{ length_seconds: number }>(`SELECT s.length_seconds FROM crove_meetings.audio_segment s JOIN crove_kernel.tenant t ON t.org_id = s.org_id WHERE t.slug = :'slug'`, { slug });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.length_seconds).toBeGreaterThanOrEqual(10);
    await expect(page.locator('audio')).toBeVisible({ timeout: 30_000 });
    expect(await page.locator('audio').getAttribute('src')).toMatch(/^blob:/);
    const left = await deviceCopy(page);
    expect(left).toEqual({ chunkCount: 0, chunks: 0 });
  });
});
