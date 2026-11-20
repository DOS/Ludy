// SPDX-License-Identifier: AGPL-3.0-only
// "Ai cam kết làm gì" (#3954) end to end against the FAKE model (#4050). The recorder opens a meeting with a stored transcript: nothing runs until they click. One click makes one run; the answer lists, for each
// speaker the transcript has, the lines the checks kept (the fake model also wrote an invented figure, a second that belongs to another speaker and a speaker who is not in the transcript: they are dropped, and
// only their count is shown), a time opens the transcript at that line, and nothing is stored but counts. An answer with no line left, and an answer that is not JSON, both read as "no suggestion", and the run rows
// tell them apart. What the model says is chosen by a scenario token in the stored transcript (e2e/fake-model/fixtures.ts). Its own user and org, created without the sign-up form.
import { expect, test } from '@playwright/test';
import { SCENARIO_TOKENS, TRANSCRIPT } from '../fake-model/fixtures.ts';
import { runRows, runsOf, seedMeeting } from '../lib/meetings-seed.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

const withToken = (token: keyof typeof SCENARIO_TOKENS) => [...TRANSCRIPT, { from: 30, to: 40, who: 'Hà', said: SCENARIO_TOKENS[token] }];

test('Vy lists what each speaker committed to on a click: nothing runs before it, the checks drop what the transcript does not support, and an unusable answer reads as no suggestion (#3954)', async ({ page }) => {
  const email = newEmail('meetings-commit');
  await signInNewUser(page, email);
  const slug = await createOrg(page, 'Công ty Cam Kết Họp');
  const good = seedMeeting(slug, email, 'Họp báo giá khách A');
  const empty = seedMeeting(slug, email, 'Họp không có gì giữ lại', { segments: withToken('bad') });
  const garbled = seedMeeting(slug, email, 'Họp đọc không ra', { segments: withToken('garbage') });
  const down = seedMeeting(slug, email, 'Họp mất dịch vụ', { segments: withToken('down') });
  const card = page.getByTestId('meeting-commitments');
  const run = page.getByTestId('commitments-run');

  await test.step('opening the meeting shows the button and runs nothing', async () => {
    await page.goto(`/o/${slug}/meetings/${good}`);
    await expect(card).toBeVisible();
    await expect(run).toHaveText('Liệt kê cam kết');
    await expect(page.getByTestId('commitments-answer')).toHaveCount(0);
    expect(runsOf(slug, 'meetings.commitments')).toBe(0);
  });

  await test.step('one click makes one run and lists, per speaker, the lines that passed the checks', async () => {
    await run.click();
    const speakers = page.getByTestId('commitments-speaker');
    await expect(speakers).toHaveCount(2);
    await expect(speakers.nth(0).getByRole('heading', { level: 3 })).toHaveText('Hà');
    await expect(speakers.nth(1).getByRole('heading', { level: 3 })).toHaveText('Nam');
    const ha = speakers.nth(0).getByTestId('commitments-line');
    await expect(ha).toHaveCount(2);
    await expect(ha.nth(0)).toHaveAttribute('data-kind', 'decision');
    await expect(ha.nth(0)).toContainText('Đã quyết');
    await expect(ha.nth(0)).toContainText('Giữ giá cũ cho khách A');
    await expect(ha.nth(1)).toHaveAttribute('data-kind', 'commitment');
    await expect(ha.nth(1)).toContainText('Sẽ làm');
    await expect(ha.nth(1)).toContainText('Họp tiếp vào tuần sau');
    const nam = speakers.nth(1).getByTestId('commitments-line');
    await expect(nam).toHaveCount(1);
    await expect(nam).toContainText('Gửi báo giá cho khách A vào thứ sáu');
    // The invented figure, the line at another speaker's second and the speaker the transcript does not have are dropped: three, counted and not shown.
    const answer = page.getByTestId('commitments-answer');
    await expect(answer).toContainText('Đã bỏ 3 dòng của Vy vì không qua được các bước kiểm tra.');
    await expect(answer).not.toContainText('3.000.000');
    await expect(answer).not.toContainText('Lan');
    await expect(answer).toContainText('Chỉ bạn thấy phần này và nó không được lưu.');
    expect(runsOf(slug, 'meetings.commitments')).toBe(1);
  });

  await test.step('a time opens the transcript at the line the claim rests on, and runs nothing', async () => {
    await page.getByTestId('commitments-speaker').nth(1).getByTestId('commitments-jump').click();
    await expect(page.locator('[data-testid="transcript-line"][aria-current="location"]')).toContainText('Em sẽ gửi báo giá vào thứ sáu.');
    expect(runsOf(slug, 'meetings.commitments')).toBe(1);
  });

  await test.step('nothing but counts is stored for the run', async () => {
    const rows = runRows(slug, 'meetings.commitments');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('ready');
    expect(JSON.parse(rows[0]?.body ?? '{}')).toEqual({ v: 1, speakers: 2, lines: 3, dropped: 3 });
  });

  await test.step('when every line is dropped the recorder is told there is no suggestion, and the run says it was empty', async () => {
    await page.goto(`/o/${slug}/meetings/${empty}`);
    await run.click();
    await expect(page.getByTestId('commitments-none')).toContainText('Lần này chưa có gợi ý.');
    await expect(page.getByTestId('commitments-line')).toHaveCount(0);
    const rows = runRows(slug, 'meetings.commitments');
    expect(rows).toHaveLength(2);
    expect(rows[1]?.status).toBe('ready');
    expect(JSON.parse(rows[1]?.body ?? '{}')).toMatchObject({ speakers: 0, lines: 0 });
  });

  await test.step('when the answer is not JSON the recorder is told there is no suggestion, and the run says it failed with a code', async () => {
    await page.goto(`/o/${slug}/meetings/${garbled}`);
    await run.click();
    await expect(page.getByTestId('commitments-none')).toContainText('Lần này chưa có gợi ý.');
    await expect(page.getByTestId('commitments-line')).toHaveCount(0);
    const rows = runRows(slug, 'meetings.commitments');
    expect(rows).toHaveLength(3);
    expect(rows[2]).toMatchObject({ status: 'failed', error_code: 'COMMITMENTS_UNPARSABLE' });
  });

  await test.step('when the model service is down the recorder is told in words, no line is shown, and the run says it failed with a code', async () => {
    await page.goto(`/o/${slug}/meetings/${down}`);
    await run.click();
    await expect(page.getByTestId('commitments-failed')).toContainText('Vy chưa liệt kê được các cam kết.');
    await expect(page.getByTestId('commitments-failed')).toContainText('Dịch vụ AI không trả lời.');
    await expect(page.getByTestId('commitments-line')).toHaveCount(0);
    const rows = runRows(slug, 'meetings.commitments');
    expect(rows).toHaveLength(4);
    expect(rows[3]).toMatchObject({ status: 'failed', error_code: 'COMMITMENTS_FAILED' });
  });
});
