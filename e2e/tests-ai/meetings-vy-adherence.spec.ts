// SPDX-License-Identifier: AGPL-3.0-only
// "Cuộc họp đã bàn đủ chưa?" (#3959) end to end against the FAKE model (#4050). The recorder opens a meeting with a stored transcript and types the agenda it was meant to follow: with no line the button is off, and
// neither opening the page nor typing runs anything. One click makes one run; each agenda line is shown "covered" with the transcript line that shows it, or "not heard". The fake model also claims a line is
// covered while citing a transcript line that is not there: the app's checks turn it into "not heard" and say how many they turned. Changing the typed lines clears an answer that no longer matches them. When the
// model's claims all fail the checks every line is "not heard", and an answer that is not JSON is a failure said in words. What the model says is chosen by the typed lines (e2e/fake-model/fixtures.ts: a line naming
// a price is covered by the transcript line that does, a party line is claimed with a line that is not there, a scenario token changes the whole answer). Its own user and org, created without the sign-up form.
import { expect, test } from '@playwright/test';
import { SCENARIO_TOKENS } from '../fake-model/fixtures.ts';
import { runRows, runsOf, seedMeeting } from '../lib/meetings-seed.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

const AGENDA = ['Chốt giá cho khách A', 'Tuyển nhân sự mới', 'Chọn địa điểm tiệc cuối năm'];

test('Vy checks the typed agenda against the transcript on a click: nothing runs before it, a claim with no real line is "not heard", and an unusable answer is said in words (#3959)', async ({ page }) => {
  const email = newEmail('meetings-adh');
  await signInNewUser(page, email);
  const slug = await createOrg(page, 'Công ty Bàn Đủ Chưa');
  const meetingId = seedMeeting(slug, email, 'Họp báo giá khách A');
  const typed = page.getByTestId('adherence-typed');
  const check = page.getByTestId('adherence-check');

  await test.step('with no agenda line the button is off and nothing runs', async () => {
    await page.goto(`/o/${slug}/meetings/${meetingId}`);
    await expect(page.getByTestId('meeting-adherence')).toBeVisible();
    await expect(check).toBeVisible();
    await expect(check).toBeDisabled();
    await expect(page.getByTestId('adherence-no-agenda')).toBeVisible();
    expect(runsOf(slug, 'meetings.adherence')).toBe(0);
  });

  await test.step('typing the agenda enables the button and still runs nothing', async () => {
    await typed.fill(AGENDA.join('\n'));
    await expect(check).toBeEnabled();
    await expect(page.getByTestId('adherence-no-agenda')).toHaveCount(0);
    expect(runsOf(slug, 'meetings.adherence')).toBe(0);
  });

  await test.step('one click makes one run: the price line is covered with the line that says it, the others are not heard', async () => {
    await check.click();
    const items = page.getByTestId('adherence-item');
    await expect(items).toHaveCount(3);
    await expect(items.nth(0).getByTestId('adherence-covered')).toHaveText('Đã bàn');
    await expect(items.nth(0)).toContainText('Chốt giá cho khách A');
    await expect(items.nth(0)).toContainText('Chúng ta chốt giá cũ cho khách A.');
    await expect(items.nth(1).getByTestId('adherence-not-heard')).toHaveText('Chưa nghe thấy');
    await expect(items.nth(1)).toContainText('Tuyển nhân sự mới');
    // The model claimed the party line with a transcript line that is not there: it is "not heard", and the answer says one claim was turned.
    await expect(items.nth(2).getByTestId('adherence-not-heard')).toHaveText('Chưa nghe thấy');
    await expect(items.nth(2)).toContainText('Chọn địa điểm tiệc cuối năm');
    await expect(page.getByTestId('adherence-answer')).toContainText('Đã chuyển 1 mục về “chưa nghe thấy”');
    await expect(page.getByTestId('adherence-answer')).toContainText('Chỉ bạn thấy và không được lưu.');
    expect(runsOf(slug, 'meetings.adherence')).toBe(1);
  });

  await test.step('a cited line opens the transcript at its time and runs nothing', async () => {
    await page.getByTestId('adherence-item').nth(0).getByRole('button', { name: 'Chúng ta chốt giá cũ cho khách A.' }).click();
    await expect(page.locator('[data-testid="transcript-line"][aria-current="location"]')).toContainText('Chúng ta chốt giá cũ cho khách A.');
    // The page keeps its one box for the typed lines.
    await expect(typed).toHaveCount(1);
    expect(runsOf(slug, 'meetings.adherence')).toBe(1);
  });

  await test.step('changing the typed lines clears an answer that no longer matches them', async () => {
    await typed.fill(`${AGENDA.join('\n')}\nChốt lịch họp tuần sau`);
    await expect(page.getByTestId('adherence-answer')).toHaveCount(0);
    expect(runsOf(slug, 'meetings.adherence')).toBe(1);
  });

  await test.step('when every claim fails the checks every line is "not heard", and the answer says so', async () => {
    await typed.fill(`${AGENDA[0]} ${SCENARIO_TOKENS.bad}\n${AGENDA[1]}\n${AGENDA[2]}`);
    await check.click();
    await expect(page.getByTestId('adherence-item')).toHaveCount(3);
    await expect(page.getByTestId('adherence-not-heard')).toHaveCount(3);
    await expect(page.getByTestId('adherence-covered')).toHaveCount(0);
    await expect(page.getByTestId('adherence-answer')).toContainText('Đã chuyển 3 mục về “chưa nghe thấy”');
    expect(runsOf(slug, 'meetings.adherence')).toBe(2);
  });

  await test.step('an answer that is not JSON is a failure said in words, with no line shown, and the run says it failed with a code', async () => {
    await typed.fill(`${AGENDA[0]} ${SCENARIO_TOKENS.garbage}\n${AGENDA[1]}`);
    await check.click();
    await expect(page.getByTestId('adherence-failed')).toContainText('Vy chưa kiểm tra được lần này.');
    await expect(page.getByTestId('adherence-failed')).toContainText('Không đọc được câu trả lời.');
    await expect(page.getByTestId('adherence-item')).toHaveCount(0);
    const rows = runRows(slug, 'meetings.adherence');
    expect(rows).toHaveLength(3);
    expect(rows[2]).toMatchObject({ status: 'failed', error_code: 'ADHERENCE_UNPARSABLE' });
  });
});
