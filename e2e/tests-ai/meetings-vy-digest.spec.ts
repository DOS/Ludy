// SPDX-License-Identifier: AGPL-3.0-only
// "Tuần này trong các cuộc họp của bạn" (#3949) end to end against the FAKE model (#4050). On the meetings page the member sees, from code and with no model, what was decided in the meetings they read and what is
// still open, numbered. One click has their own Vy write a few sentences from those numbered facts: nothing runs before it, the sentence that quotes its fact is kept, and the fake model's other sentences (an
// invented figure, a link, a citation of a fact that is not there) are dropped and only counted. A window with a fact the model "cannot read" ends in a failure said in words, and a window where every sentence fails
// the checks says Vy has nothing to add. The window picker chooses the facts, so it also chooses what the fake model says (e2e/fake-model/fixtures.ts: a scenario token in a decision). Its own user and org, created
// without the sign-up form.
import { expect, test } from '@playwright/test';
import { SCENARIO_TOKENS } from '../fake-model/fixtures.ts';
import { publishOutcome, runRows, runsOf, seedMeeting } from '../lib/meetings-seed.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

test('Vy recaps the week on a click: nothing runs before it, the checks keep the sentence that holds and drop the rest, and a bad window ends in words, not a guess (#3949)', async ({ page }) => {
  const email = newEmail('meetings-digest');
  await signInNewUser(page, email);
  const slug = await createOrg(page, 'Công ty Tổng Kết Tuần');
  // Three meetings: one inside the 7 day window, one only in the 14 day window (a decision whose text makes the fake model answer with text that is not JSON), one only in the 30 day window (a decision that
  // makes every sentence one the checks drop). The 30 day window holds both tokens, and "bad" is the stronger one.
  const week = seedMeeting(slug, email, 'Giao ban tuần này', { daysAgo: 3, segments: [] });
  publishOutcome(week, ['Chốt giá gói kế toán 15.000.000 đồng'], ['Gửi báo giá bản cuối']);
  const fortnight = seedMeeting(slug, email, 'Họp khách B', { daysAgo: 10, segments: [] });
  publishOutcome(fortnight, [`Hoãn buổi gặp khách B ${SCENARIO_TOKENS.garbage}`], []);
  const month = seedMeeting(slug, email, 'Họp giao hàng', { daysAgo: 20, segments: [] });
  publishOutcome(month, [`Giữ nguyên lịch giao hàng ${SCENARIO_TOKENS.bad}`], []);
  const card = page.getByTestId('meeting-digest');
  const recap = page.getByTestId('digest-recap');

  await test.step('the facts are listed from code, and opening the page runs nothing', async () => {
    await page.goto(`/o/${slug}/meetings`);
    await page.getByTestId('meetings-tool-digest').click();
    await expect(card).toBeVisible();
    await expect(page.getByTestId('digest-meeting')).toHaveCount(1);
    await expect(page.getByTestId('digest-fact')).toHaveCount(2);
    await expect(page.getByTestId('digest-fact').nth(0)).toContainText('Chốt giá gói kế toán 15.000.000 đồng');
    await expect(page.getByTestId('digest-fact').nth(1)).toContainText('Gửi báo giá bản cuối');
    await expect(recap).toBeVisible();
    await expect(page.getByTestId('digest-answer')).toHaveCount(0);
    expect(runsOf(slug, 'meetings.digest')).toBe(0);
  });

  await test.step('one click makes one run: the sentence that quotes its fact is kept, the other three are dropped and counted', async () => {
    await recap.click();
    const sentences = page.getByTestId('digest-sentence');
    await expect(sentences).toHaveCount(1);
    await expect(sentences.nth(0)).toContainText('Đã chốt: Chốt giá gói kế toán 15.000.000 đồng');
    await expect(sentences.nth(0)).toContainText('Căn cứ: 1');
    const answer = page.getByTestId('digest-answer');
    await expect(answer).toContainText('Đã bỏ 3 câu vì không có mục nào ở trên xác nhận.');
    await expect(answer).not.toContainText('999.000.000');
    await expect(answer).not.toContainText('example.com');
    await expect(answer).not.toContainText('đồng ý với mọi điều khoản');
    await expect(answer).toContainText('Chỉ bạn thấy và không được lưu.');
    expect(runsOf(slug, 'meetings.digest')).toBe(1);
  });

  await test.step('nothing but counts is stored for the run', async () => {
    const rows = runRows(slug, 'meetings.digest');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('ready');
    expect(rows[0]?.body ?? '').not.toContain('15.000.000');
    expect(rows[0]?.body ?? '').not.toContain('Chốt giá');
  });

  await test.step('another window shows other facts and no answer, and runs nothing by itself', async () => {
    await page.getByTestId('digest-window').selectOption('14');
    await expect(page.getByTestId('digest-meeting')).toHaveCount(2);
    await expect(page.getByTestId('digest-answer')).toHaveCount(0);
    expect(runsOf(slug, 'meetings.digest')).toBe(1);
  });

  await test.step('when the answer is not JSON the member is told in words, and the run says it failed with a code', async () => {
    await recap.click();
    await expect(page.getByTestId('digest-failed')).toContainText('Vy chưa viết được lần này.');
    await expect(page.getByTestId('digest-failed')).toContainText('Không đọc được câu trả lời.');
    await expect(page.getByTestId('digest-sentence')).toHaveCount(0);
    const rows = runRows(slug, 'meetings.digest');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ status: 'failed', error_code: 'DIGEST_UNPARSABLE' });
  });

  await test.step('when every sentence fails the checks Vy has nothing to add, and no sentence is shown', async () => {
    await page.getByTestId('digest-window').selectOption('30');
    await expect(page.getByTestId('digest-meeting')).toHaveCount(3);
    await recap.click();
    await expect(page.getByTestId('digest-none')).toContainText('Vy không có gì thêm để viết từ những mục này.');
    await expect(page.getByTestId('digest-sentence')).toHaveCount(0);
    expect(runsOf(slug, 'meetings.digest')).toBe(3);
    expect(runRows(slug, 'meetings.digest')[2]?.status).toBe('ready');
  });
});
