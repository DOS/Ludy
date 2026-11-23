// SPDX-License-Identifier: AGPL-3.0-only
// "Gợi ý tên" (#3947) end to end against the FAKE model (#4050). The recorder opens a meeting with a stored transcript: nothing runs until they click. One click makes one run; the answer shows the candidates the
// app's checks kept (the fake model also wrote a repeat, a figure the transcript does not say and an email address: they are dropped, and only their count is shown), nothing changes until the recorder
// picks one (a pick makes no second run), and the pick renames the meeting. A transcript the model "answers badly" for shows "no suggestion", and a model that is down shows the failure in words. What the model says is chosen by a
// scenario token in the stored transcript (e2e/fake-model/fixtures.ts). Its own user and org, created without the sign-up form.
import { expect, test } from '@playwright/test';
import { SCENARIO_TOKENS, TRANSCRIPT } from '../fake-model/fixtures.ts';
import { sql } from '../lib/db.ts';
import { runsOf, seedMeeting } from '../lib/meetings-seed.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

const titleOf = (id: string): string | undefined => sql<{ title: string }>(`SELECT title FROM ludy_meetings.meeting WHERE id = :'id'::uuid`, { id })[0]?.title;
// The transcript of the specs and one more line that holds a scenario token.
const withToken = (token: keyof typeof SCENARIO_TOKENS) => [...TRANSCRIPT, { from: 30, to: 40, who: 'Hà', said: SCENARIO_TOKENS[token] }];

test('Vy suggests titles on a click: nothing runs before it, the checks drop what the transcript does not support, and a pick renames the meeting (#3947)', async ({ page }) => {
  const email = newEmail('meetings-title');
  await signInNewUser(page, email);
  const slug = await createOrg(page, 'Công ty Gợi Ý Tên Họp');
  const good = seedMeeting(slug, email, 'Họp chưa có tên');
  const bad = seedMeeting(slug, email, 'Họp đọc không ra', { segments: withToken('bad') });
  const down = seedMeeting(slug, email, 'Họp mất dịch vụ', { segments: withToken('down') });
  const box = page.getByTestId('title-suggest');
  const run = page.getByTestId('title-suggest-run');

  await test.step('opening the meeting shows the button and runs nothing', async () => {
    await page.goto(`/o/${slug}/meetings/${good}`);
    await expect(run).toBeVisible();
    await expect(page.getByTestId('title-candidates')).toHaveCount(0);
    expect(runsOf(slug, 'meetings.title')).toBe(0);
  });

  await test.step('one click makes one run and shows the candidates that passed the checks', async () => {
    await run.click();
    const candidates = page.getByTestId('title-candidate');
    await expect(candidates).toHaveCount(2);
    await expect(candidates.nth(0)).toContainText('Chốt giá cũ cho khách A');
    await expect(candidates.nth(1)).toContainText('Gửi báo giá cho khách A vào thứ sáu');
    // The repeat, the figure the transcript does not write and the address are dropped, and the answer says how many (not which).
    await expect(box).toContainText('Đã bỏ 3 gợi ý của Vy vì không qua được các bước kiểm tra.');
    await expect(box).not.toContainText('2.500.000');
    await expect(box).not.toContainText('example.com');
    expect(runsOf(slug, 'meetings.title')).toBe(1);
  });

  await test.step('nothing changes until the recorder picks one, and a pick renames the meeting without a second run', async () => {
    expect(titleOf(good)).toBe('Họp chưa có tên');
    await page.getByTestId('title-candidate').nth(1).getByTestId('title-pick').click();
    await expect(page.getByTestId('title-renamed')).toContainText('Cuộc họp đã có tên mới.');
    await expect.poll(() => titleOf(good)).toBe('Gửi báo giá cho khách A vào thứ sáu');
    expect(runsOf(slug, 'meetings.title')).toBe(1);
  });

  await test.step('when every candidate is dropped the recorder is told there is no suggestion, and the title stays', async () => {
    await page.goto(`/o/${slug}/meetings/${bad}`);
    await run.click();
    await expect(page.getByTestId('title-none')).toContainText('Lần này chưa có gợi ý.');
    await expect(page.getByTestId('title-candidate')).toHaveCount(0);
    expect(titleOf(bad)).toBe('Họp đọc không ra');
  });

  await test.step('when the model service is down the recorder is told in words, nothing is suggested and the title stays', async () => {
    await page.goto(`/o/${slug}/meetings/${down}`);
    await run.click();
    await expect(page.getByTestId('title-failed')).toContainText('Vy chưa gợi ý được tên.');
    await expect(page.getByTestId('title-failed')).toContainText('Dịch vụ AI không trả lời.');
    await expect(page.getByTestId('title-candidate')).toHaveCount(0);
    expect(titleOf(down)).toBe('Họp mất dịch vụ');
  });
});
