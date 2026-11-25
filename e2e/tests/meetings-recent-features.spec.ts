// SPDX-License-Identifier: AGPL-3.0-only
// The Meetings screens that landed on 2026-11-25 without a real browser run, end to end with NO model (the default stack has none; the AI screens of the same day are in tests-ai/meetings-vy-ask-open-points.spec.ts):
// "Ai đã nói" (#4765, talk time worked out in code), the suggestion of a minutes template from the meeting itself (#4772, code first), the download of the transcript as .txt and .srt (#4817), and the
// recording player's speed and the time of a transcript line that moves it (#4816). A meeting with a stored transcript is seeded straight into the database (e2e/lib/meetings-seed.ts: the three lines of the fake
// model's transcript, Hà at 0 to 10 and 20 to 30 seconds, Nam at 10 to 20); the player needs a real recording, so that meeting is made from a WAV file as meetings-upload-publish.spec.ts does. Its own user and org,
// created without the sign-up form.
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { exec, sql } from '../lib/db.ts';
import { seedMeeting } from '../lib/meetings-seed.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

// A 16-bit mono WAV of a 440 Hz tone, `seconds` long (the player test needs a recording longer than the lines it seeks to).
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

test('talk time: the card shows each speaker\'s share, time, turns and longest turn, worked out in code from the transcript (#4765)', async ({ page }) => {
  const email = newEmail('meetings-talk');
  await signInNewUser(page, email);
  const slug = await createOrg(page, 'Công ty Ai Đã Nói');
  const id = seedMeeting(slug, email, 'Họp để xem ai nói');

  await page.goto(`/o/${slug}/meetings/${id}`);
  const card = page.getByTestId('meeting-talk-time');
  await expect(card).toBeVisible();
  await expect(card.getByRole('heading', { name: 'Ai đã nói' })).toBeVisible();
  await expect(card).toContainText('Không dùng AI.');
  const rows = card.getByTestId('talk-time-row');
  await expect(rows).toHaveCount(2);
  // Most talk first: Hà talked 20 of 30 seconds in two turns (the longest 10 seconds), Nam 10 in one.
  const ha = rows.nth(0);
  await expect(ha.getByRole('rowheader')).toHaveText('Hà');
  await expect(ha).toContainText('67%');
  await expect(ha.getByRole('cell').nth(1)).toHaveText('0:20');
  await expect(ha.getByRole('cell').nth(2)).toHaveText('2');
  await expect(ha.getByRole('cell').nth(3)).toHaveText('0:10');
  const nam = rows.nth(1);
  await expect(nam.getByRole('rowheader')).toHaveText('Nam');
  await expect(nam).toContainText('33%');
  await expect(nam.getByRole('cell').nth(1)).toHaveText('0:10');
  await expect(nam.getByRole('cell').nth(2)).toHaveText('1');
  // The line under a published summary is for published lines only: the seeded transcript is the recorder's draft, so there is none.
  await expect(page.getByTestId('talk-time-line')).toHaveCount(0);
});

test('template suggestion: code reads the title and suggests the briefing template with its reason, and one click takes it (#4772)', async ({ page }) => {
  const email = newEmail('meetings-template');
  await signInNewUser(page, email);
  const slug = await createOrg(page, 'Công ty Gợi Ý Mẫu');
  const id = seedMeeting(slug, email, 'Họp giao ban đầu tuần');
  const plain = seedMeeting(slug, email, 'Cuộc trao đổi chung');
  const templateOf = (meetingId: string) => sql<{ summary_template: string }>(`SELECT summary_template FROM ludy_meetings.meeting WHERE id = :'id'::uuid`, { id: meetingId })[0]?.summary_template;

  await test.step('a title that names a kind of meeting is suggested with the reason in plain words, and nothing changes before the click', async () => {
    await page.goto(`/o/${slug}/meetings/${id}`);
    const card = page.getByTestId('template-suggest');
    await expect(card).toBeVisible();
    await expect(card.getByText('Gợi ý loại cuộc họp')).toBeVisible();
    const code = page.getByTestId('template-suggest-code');
    await expect(code).toBeVisible();
    await expect(code).toContainText('tên cuộc họp nhắc đến loại họp này');
    // The default stack has no model, so there is no button to ask Vy: code's suggestion is all there is.
    await expect(page.getByTestId('template-suggest-vy')).toHaveCount(0);
    expect(templateOf(id)).toBe('general');
  });

  await test.step('one click takes it through the set-template command, and the suggestion goes', async () => {
    await page.getByTestId('template-suggest-take').click();
    await expect(page.getByTestId('template-suggest')).toHaveCount(0);
    expect(templateOf(id)).toBe('briefing');
  });

  await test.step('a title with no sign of a kind of meeting is left alone: code does not suggest', async () => {
    await page.goto(`/o/${slug}/meetings/${plain}`);
    await expect(page.getByTestId('meeting-talk-time')).toBeVisible();
    await expect(page.getByTestId('template-suggest-code')).toHaveCount(0);
    expect(templateOf(plain)).toBe('general');
  });
});

test('transcript download: the recorder saves the transcript as plain text and as SRT, built on the server (#4817)', async ({ page }) => {
  const email = newEmail('meetings-export');
  await signInNewUser(page, email);
  const slug = await createOrg(page, 'Công ty Tải Bản Ghi');
  const id = seedMeeting(slug, email, 'Họp: tải "bản ghi" về');
  await page.goto(`/o/${slug}/meetings/${id}`);

  const box = page.getByTestId('transcript-export');
  await expect(box).toBeVisible();
  // The box is itself the labelled group.
  await expect(page.getByRole('group', { name: 'Tải bản ghi lời về' })).toBeVisible();
  await expect(box).toContainText('Không dùng AI.');

  const saved = async (format: 'txt' | 'srt'): Promise<{ name: string; text: string }> => {
    const download = page.waitForEvent('download');
    await page.getByTestId(`transcript-export-${format}`).click();
    const file = await download;
    return { name: file.suggestedFilename(), text: readFileSync(await file.path(), 'utf8') };
  };

  await test.step('plain text: one "[time] speaker: line" entry per line', async () => {
    const txt = await saved('txt');
    // The characters a file name cannot hold are gone, the date is the Vietnam date of the meeting.
    expect(txt.name).toMatch(/^Bản ghi - Họp tải bản ghi về - \d{4}-\d{2}-\d{2}\.txt$/);
    expect(txt.text).toBe('[00:00:00] Hà: Chúng ta chốt giá cũ cho khách A.\n[00:00:10] Nam: Em sẽ gửi báo giá vào thứ sáu.\n[00:00:20] Hà: Được, họp tiếp tuần sau.\n');
  });

  await test.step('SRT: numbered cues with their start and end', async () => {
    const srt = await saved('srt');
    expect(srt.name).toMatch(/^Bản ghi - Họp tải bản ghi về - \d{4}-\d{2}-\d{2}\.srt$/);
    expect(srt.text).toBe(
      [
        '1\n00:00:00,000 --> 00:00:10,000\nHà: Chúng ta chốt giá cũ cho khách A.\n',
        '2\n00:00:10,000 --> 00:00:20,000\nNam: Em sẽ gửi báo giá vào thứ sáu.\n',
        '3\n00:00:20,000 --> 00:00:30,000\nHà: Được, họp tiếp tuần sau.\n',
      ].join('\n') + '\n',
    );
  });

  await test.step('a meeting with no transcript has no download to offer', async () => {
    const empty = seedMeeting(slug, email, 'Họp chưa có bản ghi', { segments: [] });
    await page.goto(`/o/${slug}/meetings/${empty}`);
    await expect(page.getByTestId('transcript-export')).toHaveCount(0);
  });
});

// Opens the new-meeting sheet on the Meetings list, makes a meeting from a WAV and returns once the meeting page shows its audio player.
async function meetingFromRecording(page: Page, slug: string, title: string, seconds: number): Promise<string> {
  await page.goto(`/o/${slug}/meetings`);
  await page.getByRole('button', { name: 'Ghi lại cuộc họp mới' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Tiêu đề cuộc họp').fill(title);
  await dialog.getByLabel(/Tệp âm thanh/).setInputFiles({ name: 'hop.wav', mimeType: 'audio/wav', buffer: wav(seconds) });
  await dialog.getByLabel('Hình thức thông báo').selectOption('told_at_start');
  await dialog.getByRole('checkbox', { name: /Tôi xác nhận đã thông báo/ }).click();
  await expect(dialog.getByRole('button', { name: 'Tạo cuộc họp và mã hóa tệp' })).toBeEnabled();
  await dialog.getByLabel('Tiêu đề cuộc họp').press('Control+Enter');
  await expect(page).toHaveURL(/\/meetings\/[0-9a-f-]{36}$/, { timeout: 90_000 });
  const id = /\/meetings\/([0-9a-f-]{36})$/.exec(page.url())?.[1] as string;
  await expect(page.locator('audio')).toBeVisible({ timeout: 30_000 });
  return id;
}

const playbackRate = (page: Page) => page.evaluate(() => (document.querySelector('audio') as HTMLAudioElement).playbackRate);
const currentTime = (page: Page) => page.evaluate(() => (document.querySelector('audio') as HTMLAudioElement).currentTime);

test('recording player: the speed is picked, applied and remembered in this browser, and the time of a transcript line moves the recording (#4816)', async ({ page }) => {
  const email = newEmail('meetings-player');
  await signInNewUser(page, email);
  const slug = await createOrg(page, 'Công ty Nghe Lại Họp');
  const id = await meetingFromRecording(page, slug, 'Họp nghe lại', 40);
  // The lines of the transcript at 0, 10 and 20 seconds of the recording just stored.
  exec(
    `INSERT INTO ludy_meetings.transcript_segment (org_id, meeting_id, start_seconds, end_seconds, speaker_label, text, stage)
     SELECT m.org_id, m.id, v.from_s, v.to_s, v.who, v.said, 'draft'
       FROM ludy_meetings.meeting m, jsonb_to_recordset(:'segments'::jsonb) AS v(from_s int, to_s int, who text, said text)
      WHERE m.id = :'id'::uuid`,
    {
      id,
      segments: JSON.stringify([
        { from_s: 0, to_s: 10, who: 'Hà', said: 'Chúng ta chốt giá cũ cho khách A.' },
        { from_s: 10, to_s: 20, who: 'Nam', said: 'Em sẽ gửi báo giá vào thứ sáu.' },
        { from_s: 20, to_s: 30, who: 'Hà', said: 'Được, họp tiếp tuần sau.' },
      ]),
    },
  );
  await page.reload();
  const speed = page.getByTestId('playback-speed');
  await expect(speed).toBeVisible();
  await expect(page.locator('audio')).toBeVisible({ timeout: 30_000 });

  await test.step('four speeds are offered, 1x is the one in use, and nothing plays by itself', async () => {
    await expect(speed.getByRole('button')).toHaveText(['1x', '1.25x', '1.5x', '2x']);
    await expect(page.getByTestId('playback-rate-1')).toHaveAttribute('aria-pressed', 'true');
    expect(await playbackRate(page)).toBe(1);
    expect(await page.evaluate(() => (document.querySelector('audio') as HTMLAudioElement).paused)).toBe(true);
  });

  await test.step('a speed is applied to the player at once', async () => {
    await page.getByTestId('playback-rate-1.5').click();
    await expect(page.getByTestId('playback-rate-1.5')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('playback-rate-1')).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => playbackRate(page)).toBe(1.5);
  });

  await test.step('it is remembered in this browser: after a reload the player starts at that speed', async () => {
    await page.reload();
    await expect(page.locator('audio')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('playback-rate-1.5')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => playbackRate(page)).toBe(1.5);
  });

  await test.step('the time of a transcript line moves the recording to the start of the line, says so, and does not play it', async () => {
    const seek = page.getByTestId('transcript-seek');
    await expect(seek).toHaveText(['0:00', '0:10', '0:20']);
    await page.getByRole('button', { name: 'Tua bản ghi đến 0:20' }).click();
    await expect(page.getByText('Đã chuyển bản ghi đến 0:20.')).toBeVisible();
    await expect.poll(() => currentTime(page)).toBeCloseTo(20, 0);
    await page.getByRole('button', { name: 'Tua bản ghi đến 0:10' }).click();
    await expect.poll(() => currentTime(page)).toBeCloseTo(10, 0);
    expect(await page.evaluate(() => (document.querySelector('audio') as HTMLAudioElement).paused)).toBe(true);
  });
});
