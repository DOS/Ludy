// SPDX-License-Identifier: AGPL-3.0-only
// Three Vy screens of the meetings line that landed on 2026-11-25 without a browser run, end to end against the FAKE model (#4050): "Hỏi về cuộc họp này" on a meeting's page (#4815), "Còn bỏ ngỏ" (#4768) and Vy's
// suggestion of a minutes template when code cannot tell (#4772). Each is one click on one meeting with a stored transcript: nothing runs before it, the answer shows what the checks kept and counts what they dropped
// (the fake model also writes an invented figure, a bare link, an address, a citation of a line that is not there), a time opens the transcript at the line the claim rests on, and an answer with nothing left, a
// request that fails and one that is taken are each told in words. What the model says is chosen by a scenario token in the stored transcript (e2e/fake-model/fixtures.ts, checked by tools/test/fake-model.test.ts
// against the product's own checks). Its own user and org, created without the sign-up form.
import { expect, test } from '@playwright/test';
import { SCENARIO_TOKENS, TRANSCRIPT } from '../fake-model/fixtures.ts';
import { sql } from '../lib/db.ts';
import { runRows, runsOf, seedMeeting } from '../lib/meetings-seed.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

// The stored transcript with one more line holding a scenario token (and the words the question asks for, so the line is one the box sends to the model).
const withToken = (token: keyof typeof SCENARIO_TOKENS) => [...TRANSCRIPT, { from: 30, to: 40, who: 'Hà', said: `Chốt giá cho khách ${SCENARIO_TOKENS[token]}` }];
const QUESTION = 'Chốt giá cũ cho khách nào?';
const templateOf = (meetingId: string) => sql<{ summary_template: string }>(`SELECT summary_template FROM ludy_meetings.meeting WHERE id = :'id'::uuid`, { id: meetingId })[0]?.summary_template;

test('ask this meeting: one click makes one run, the answer keeps the cited sentence and counts what the checks dropped, a time opens the line, and no answer or a failure is told in words (#4815)', async ({ page }) => {
  const email = newEmail('meetings-ask-this');
  await signInNewUser(page, email);
  const slug = await createOrg(page, 'Công ty Hỏi Về Cuộc Họp');
  const good = seedMeeting(slug, email, 'Họp báo giá khách A');
  const empty = seedMeeting(slug, email, 'Họp không có câu trả lời', { segments: withToken('bad') });
  const down = seedMeeting(slug, email, 'Họp mất dịch vụ hỏi', { segments: withToken('down') });
  const box = page.getByTestId('meeting-ask-this');
  const ask = async (question: string) => {
    await box.getByLabel('Hỏi về cuộc họp này').fill(question);
    await box.getByRole('button', { name: 'Hỏi Vy' }).click();
  };

  await test.step('opening the meeting shows the box, with the cost before the click, and runs nothing', async () => {
    await page.goto(`/o/${slug}/meetings/${good}`);
    await expect(box).toBeVisible();
    await expect(box.getByRole('button', { name: 'Hỏi Vy' })).toBeVisible();
    await expect(page.getByTestId('ask-this-answer')).toHaveCount(0);
    expect(runsOf(slug, 'meetings.ask')).toBe(0);
  });

  await test.step('one click makes one run; the cited sentence is kept, the invented figure, the link and the missing line are counted and not shown', async () => {
    await ask(QUESTION);
    const sentences = page.getByTestId('ask-this-sentence');
    await expect(sentences).toHaveCount(1);
    await expect(sentences.first()).toContainText('Trong cuộc họp có nói: Chúng ta chốt giá cũ cho khách A.');
    const answer = page.getByTestId('ask-this-answer');
    await expect(answer).toContainText('Đã bỏ 3 câu vì không có dòng bản ghi nào xác nhận.');
    await expect(answer).not.toContainText('999.000.000');
    await expect(answer).not.toContainText('example.com');
    await expect(answer).toContainText('Chỉ mình bạn thấy câu trả lời này và nó không được lưu.');
    expect(runsOf(slug, 'meetings.ask')).toBe(1);
  });

  await test.step('the time under the sentence opens the transcript at the line the sentence rests on, and runs nothing', async () => {
    await page.getByTestId('ask-this-time').first().click();
    await expect(page.locator('[data-testid="transcript-line"][aria-current="location"]')).toContainText('Chúng ta chốt giá cũ cho khách A.');
    expect(runsOf(slug, 'meetings.ask')).toBe(1);
  });

  await test.step('an answer with every sentence dropped is told as "nothing found", and the run is stored without any text', async () => {
    await page.goto(`/o/${slug}/meetings/${empty}`);
    await ask(QUESTION);
    await expect(page.getByTestId('ask-this-none')).toContainText('Không thấy gì trong bản ghi của cuộc họp này');
    await expect(page.getByTestId('ask-this-sentence')).toHaveCount(0);
    expect(runsOf(slug, 'meetings.ask')).toBe(2);
    for (const row of runRows(slug, 'meetings.ask')) expect(row.body ?? '').not.toContain('Chúng ta chốt giá');
  });

  await test.step('when the model service is down the box says so in words and shows no sentence', async () => {
    await page.goto(`/o/${slug}/meetings/${down}`);
    await ask(QUESTION);
    await expect(page.getByTestId('ask-this-failed')).toContainText('Vy chưa trả lời được lần này.');
    await expect(page.getByTestId('ask-this-sentence')).toHaveCount(0);
    expect(runsOf(slug, 'meetings.ask')).toBe(3);
  });
});

test('"Còn bỏ ngỏ": one click lists the questions and decisions the checks kept, counts what they dropped, and a time opens the line (#4768)', async ({ page }) => {
  const email = newEmail('meetings-open-points');
  await signInNewUser(page, email);
  const slug = await createOrg(page, 'Công ty Còn Bỏ Ngỏ');
  const good = seedMeeting(slug, email, 'Họp còn nhiều việc bỏ ngỏ');
  const empty = seedMeeting(slug, email, 'Họp không có gì giữ lại', { segments: withToken('bad') });
  const card = page.getByTestId('meeting-open-points');
  const run = page.getByTestId('open-points-run');

  await test.step('opening the meeting shows the button and runs nothing', async () => {
    await page.goto(`/o/${slug}/meetings/${good}`);
    await expect(card).toBeVisible();
    await expect(run).toHaveText('Liệt kê những gì còn bỏ ngỏ');
    await expect(page.getByTestId('open-points-answer')).toHaveCount(0);
    expect(runsOf(slug, 'meetings.open_points')).toBe(0);
  });

  await test.step('one click makes one run: the question and the decision are listed, the address, the invented figure and the missing second are counted and not shown', async () => {
    await run.click();
    const answer = page.getByTestId('open-points-answer');
    await expect(answer).toBeVisible();
    await expect(page.getByTestId('open-points-questions')).toContainText('Khi nào gửi báo giá cho khách A?');
    await expect(page.getByTestId('open-points-decisions')).toContainText('Có giữ giá cũ cho khách A hay không?');
    await expect(page.getByTestId('open-points-line')).toHaveCount(2);
    await expect(answer).toContainText('Đã bỏ 3 dòng của Vy vì không qua được các bước kiểm tra.');
    await expect(answer).not.toContainText('nam@example.com');
    await expect(answer).not.toContainText('3.000.000');
    await expect(answer).toContainText('Chỉ bạn thấy phần này và nó không được lưu.');
    expect(runsOf(slug, 'meetings.open_points')).toBe(1);
  });

  await test.step('the time of the question opens the transcript at the line it rests on, and runs nothing', async () => {
    await page.getByTestId('open-points-questions').getByTestId('open-points-jump').click();
    await expect(page.locator('[data-testid="transcript-line"][aria-current="location"]')).toContainText('Em sẽ gửi báo giá vào thứ sáu.');
    expect(runsOf(slug, 'meetings.open_points')).toBe(1);
  });

  await test.step('when every point is dropped the recorder is told there is no suggestion', async () => {
    await page.goto(`/o/${slug}/meetings/${empty}`);
    await run.click();
    await expect(page.getByTestId('open-points-none')).toContainText('Lần này chưa có gợi ý.');
    await expect(page.getByTestId('open-points-line')).toHaveCount(0);
    expect(runsOf(slug, 'meetings.open_points')).toBe(2);
  });
});

test('template suggestion by Vy: shown only when code cannot tell, one click asks, the answer is taken with one more click, and "no template fits" is told in words (#4772)', async ({ page }) => {
  const email = newEmail('meetings-template-vy');
  await signInNewUser(page, email);
  const slug = await createOrg(page, 'Công ty Mẫu Biên Bản');
  // Titles with no word of a kind of meeting: code cannot tell, so the recorder may ask Vy.
  const good = seedMeeting(slug, email, 'Cuộc trao đổi chung');
  const none = seedMeeting(slug, email, 'Cuộc gặp không rõ loại', { segments: withToken('bad') });
  const titled = seedMeeting(slug, email, 'Họp giao ban đầu tuần');

  await test.step('code cannot tell: the card says so and offers Vy; nothing runs before the click', async () => {
    await page.goto(`/o/${slug}/meetings/${good}`);
    await expect(page.getByTestId('template-suggest')).toBeVisible();
    await expect(page.getByTestId('template-suggest-code')).toHaveCount(0);
    await expect(page.getByTestId('template-suggest-vy')).toHaveText('Nhờ Vy gợi ý');
    expect(runsOf(slug, 'meetings.template_suggest')).toBe(0);
  });

  await test.step('one click makes one run; the answer names the template with its reason as plain text and the time of the line it rests on', async () => {
    await page.getByTestId('template-suggest-vy').click();
    const answer = page.getByTestId('template-suggest-vy-answer');
    await expect(answer).toBeVisible();
    await expect(answer).toContainText('Cuộc họp bàn giá và báo giá cho khách A.');
    await expect(answer).toContainText('Chỉ bạn thấy phần này và nó không được lưu.');
    expect(runsOf(slug, 'meetings.template_suggest')).toBe(1);
    // Nothing is stored but counts, and the meeting is still on the general summary until the recorder takes it.
    expect(templateOf(good)).toBe('general');
    for (const row of runRows(slug, 'meetings.template_suggest')) expect(row.body ?? '').not.toContain('báo giá cho khách');
  });

  await test.step('the time opens the transcript at the line the reason rests on', async () => {
    await page.getByTestId('template-suggest-jump').click();
    await expect(page.locator('[data-testid="transcript-line"][aria-current="location"]')).toContainText('Em sẽ gửi báo giá vào thứ sáu.');
  });

  await test.step('taking the answer sets the template through the set-template command', async () => {
    await page.getByTestId('template-suggest-vy-take').click();
    await expect(page.getByTestId('template-suggest')).toHaveCount(0);
    expect(templateOf(good)).toBe('customer');
  });

  await test.step('when the model says no template fits, the recorder is told so and nothing is taken', async () => {
    await page.goto(`/o/${slug}/meetings/${none}`);
    await page.getByTestId('template-suggest-vy').click();
    await expect(page.getByTestId('template-suggest-none')).toContainText('Chưa có loại nào hợp rõ ràng.');
    await expect(page.getByTestId('template-suggest-vy-answer')).toHaveCount(0);
    expect(templateOf(none)).toBe('general');
  });

  await test.step('when code can tell from the title, there is no run to ask for: the code suggestion is shown and Vy is not asked', async () => {
    const before = runsOf(slug, 'meetings.template_suggest');
    await page.goto(`/o/${slug}/meetings/${titled}`);
    await expect(page.getByTestId('template-suggest-code')).toBeVisible();
    await expect(page.getByTestId('template-suggest-vy')).toHaveCount(0);
    expect(runsOf(slug, 'meetings.template_suggest')).toBe(before);
  });
});
