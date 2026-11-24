// SPDX-License-Identifier: AGPL-3.0-only
// A recording file uploaded, its summary written, edited and shared, end to end with no AI (#3805, part 2; the stack has no model, so this is the manual path of the same screens Vy writes into).
// A person makes a meeting from a file on the Meetings list, the audio is stored and plays back, the summary and decisions are typed as a draft and kept across a reload, the draft is
// edited and shared, the shared text shows on the meeting's page and on the printable biên bản, and a second edit shared again replaces the first. Its own user, created confirmed without
// the sign-up form. The file is a WAV made here: five seconds of a quiet tone, so no fixture is committed and the crove-media sandbox measures a real length.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { sql } from '../lib/db.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

// A 16-bit mono WAV of a 440 Hz tone, `seconds` long.
function wav(seconds: number): Buffer {
  const rate = 8000;
  const samples = rate * seconds;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 3000), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// Saves the draft and waits for the answer, so a reload right after cannot cancel the request.
async function saveDraft(page: Page, panel: Locator): Promise<void> {
  const saved = page.waitForResponse((r) => r.request().method() === 'POST' && /saveSummary/.test(r.url()));
  await panel.getByRole('button', { name: 'Lưu bản nháp' }).click();
  expect((await saved).ok()).toBe(true);
}

test('a file is uploaded, the summary is written, edited and shared twice, and the biên bản shows the last one (#3805)', async ({ page }) => {
  await signInNewUser(page, newEmail('meetings-upload'));
  const slug = await createOrg(page, 'Công ty Tải Họp Lên');

  await test.step('a meeting is made from a file on the Meetings list', async () => {
    await page.goto(`/o/${slug}/meetings`);
    const newMeetingBtn = page.getByRole('button', { name: 'Ghi lại cuộc họp mới' }).first();
    await expect(newMeetingBtn).toBeVisible();
    await newMeetingBtn.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toHaveAttribute('data-slot', 'sheet-content');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(newMeetingBtn).toBeFocused();

    await newMeetingBtn.click();
    await dialog.getByLabel('Tiêu đề cuộc họp').fill('Họp tải tệp lên');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('panel-discard')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Tiếp tục nhập' })).toBeFocused();
    await page.getByRole('button', { name: 'Tiếp tục nhập' }).click();
    await expect(dialog.getByLabel('Tiêu đề cuộc họp')).toBeFocused();
    await expect(dialog.getByLabel('Tiêu đề cuộc họp')).toHaveValue('Họp tải tệp lên');

    await dialog.getByLabel(/Tệp âm thanh/).setInputFiles({ name: 'hop-giao-ban.wav', mimeType: 'audio/wav', buffer: wav(5) });
    await dialog.getByLabel('Hình thức thông báo').selectOption('told_at_start');
    await dialog.getByRole('checkbox', { name: /Tôi xác nhận đã thông báo/ }).click();
    await expect(dialog.getByRole('button', { name: 'Tạo cuộc họp và mã hóa tệp' })).toBeEnabled();
    await dialog.getByLabel('Tiêu đề cuộc họp').press('Control+Enter');
    await expect(page).toHaveURL(/\/meetings\/[0-9a-f-]{36}$/, { timeout: 90_000 });
  });

  await test.step('the audio is stored and plays back from the meeting page', async () => {
    const rows = sql<{ length_seconds: number }>(`SELECT s.length_seconds FROM ludy_meetings.audio_segment s JOIN ludy_kernel.tenant t ON t.org_id = s.org_id WHERE t.slug = :'slug'`, { slug });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.length_seconds).toBeGreaterThanOrEqual(3);
    await expect(page.locator('audio')).toBeVisible({ timeout: 30_000 });
    expect(await page.locator('audio').getAttribute('src')).toMatch(/^blob:/);
  });

  const panel = page.getByTestId('meeting-results');
  await test.step('the draft summary and decision are typed and kept across a reload', async () => {
    await expect(panel).toBeVisible();
    await panel.getByLabel('Tóm tắt', { exact: true }).fill('Bản nháp đầu tiên của buổi họp.');
    await panel.getByLabel('Quyết định', { exact: true }).fill('Giữ lịch giao ban sáng thứ hai');
    await saveDraft(page, panel);
    await page.reload();
    await expect(panel.getByLabel('Tóm tắt', { exact: true })).toHaveValue('Bản nháp đầu tiên của buổi họp.');
    await expect(panel.getByLabel('Quyết định', { exact: true })).toHaveValue('Giữ lịch giao ban sáng thứ hai');
  });

  await test.step('the draft is edited, saved again and shared', async () => {
    await panel.getByLabel('Tóm tắt', { exact: true }).fill('Bản nháp đã sửa: chốt lịch giao ban.');
    await saveDraft(page, panel);
    await page.reload();
    await expect(panel.getByLabel('Tóm tắt', { exact: true })).toHaveValue('Bản nháp đã sửa: chốt lịch giao ban.');
    await panel.getByRole('button', { name: 'Chia sẻ cho người dự họp' }).click();
    await expect(panel.getByRole('heading', { name: 'Đã chia sẻ cho người dự họp' })).toBeVisible();
    await expect(panel).toContainText('Bản nháp đã sửa: chốt lịch giao ban.');
    await expect(panel).toContainText('Giữ lịch giao ban sáng thứ hai');
  });

  await test.step('a second edit shared again replaces the first', async () => {
    await panel.getByLabel('Tóm tắt', { exact: true }).fill('Bản chốt cuối: dời giao ban sang chín giờ.');
    await saveDraft(page, panel);
    await panel.getByRole('button', { name: 'Chia sẻ cho người dự họp' }).click();
    await expect(panel).toContainText('Bản chốt cuối: dời giao ban sang chín giờ.');
    await expect(panel).not.toContainText('Bản nháp đã sửa: chốt lịch giao ban.');
  });

  await test.step('the printable biên bản shows the shared text, not the earlier ones', async () => {
    await panel.getByRole('link', { name: 'Xem biên bản' }).click();
    const sheet = page.getByTestId('minutes-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('Bản chốt cuối: dời giao ban sang chín giờ.');
    await expect(sheet).not.toContainText('Bản nháp đã sửa');
    await expect(sheet.getByTestId('minutes-draft')).toHaveCount(0);
    await expect(sheet).toContainText('Họp tải tệp lên');
  });
});
