// SPDX-License-Identifier: AGPL-3.0-only
// The Today view of the meetings page and Vy's brief before a meeting (#3955, #3543) end to end against the FAKE model (#4050). The member's own calendar has three events today, each of a series with an earlier
// meeting. The page lists them with, from code and with no model, what was decided last time and what is still open; opening it runs nothing. One click on an event has the member's own Vy write a few sentences
// from that event's numbered facts: the sentence that quotes its fact is kept, the fake model's other sentences (an invented figure, a link, a citation of a fact that is not there) are dropped and only counted,
// and the click of one event runs one run and leaves the others alone. Another event's facts make the model answer with only sentences the checks drop (Vy has nothing to add), and a third makes the service answer
// HTTP 500 (a failure said in words). What the model says is chosen by a scenario token in a decision of the earlier meeting (e2e/fake-model/fixtures.ts). Its own user and org, created without the sign-up form.
import { expect, test } from '@playwright/test';
import { SCENARIO_TOKENS } from '../fake-model/fixtures.ts';
import { publishOutcome, runRows, runsOf, seedMeeting, seedTodayEvent, waitOutVietnamMidnight } from '../lib/meetings-seed.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

const SERIES = ['3f2a8c10-0000-4000-8000-000000000001', '3f2a8c10-0000-4000-8000-000000000002', '3f2a8c10-0000-4000-8000-000000000003'] as const;

test('Vy briefs one event of the Today view on a click: nothing runs before it, the checks keep the sentence that holds and drop the rest, and the other events are left alone (#3955)', async ({ page }) => {
  const email = newEmail('meetings-brief');
  await signInNewUser(page, email);
  const slug = await createOrg(page, 'Công ty Chuẩn Bị Họp');
  // Each series has an earlier meeting with a decision and an open item; the decisions of the second and third carry a scenario token.
  const earlier = [
    { series: SERIES[0], title: 'Giao ban tuần trước', decision: 'Chốt giá gói kế toán 15.000.000 đồng', event: 'Giao ban đầu tuần', hours: 0 },
    { series: SERIES[1], title: 'Họp khách C tuần trước', decision: `Giữ nguyên lịch giao hàng ${SCENARIO_TOKENS.bad}`, event: 'Họp khách C', hours: 2 },
    { series: SERIES[2], title: 'Họp nhà cung cấp tuần trước', decision: `Đổi nhà cung cấp mực in ${SCENARIO_TOKENS.down}`, event: 'Họp nhà cung cấp', hours: 4 },
  ];
  // Once, before the first seed: a run in the last minutes before Vietnam midnight waits for the new day, so all three events and the page load fall on one day (#4089).
  waitOutVietnamMidnight(90);
  for (const e of earlier) {
    const meeting = seedMeeting(slug, email, e.title, { daysAgo: 7, seriesId: e.series, segments: [] });
    publishOutcome(meeting, [e.decision], ['Gửi báo giá bản cuối']);
    seedTodayEvent(slug, email, e.event, e.series, e.hours);
  }
  const event = (title: string) => page.getByTestId('meeting-agenda-event').filter({ hasText: title });

  await test.step('the Today view lists the events with the facts of each brief, and opening it runs nothing', async () => {
    await page.goto(`/o/${slug}/meetings`);
    await expect(page.getByTestId('meeting-agenda')).toBeVisible();
    await expect(page.getByTestId('meeting-agenda-event')).toHaveCount(3);
    const first = event('Giao ban đầu tuần');
    await expect(first.getByTestId('meeting-agenda-brief')).toContainText('Chốt giá gói kế toán 15.000.000 đồng');
    await expect(first.getByTestId('meeting-agenda-brief')).toContainText('Gửi báo giá bản cuối');
    await expect(first.getByTestId('brief-write')).toBeVisible();
    await expect(page.getByTestId('brief-answer')).toHaveCount(0);
    expect(runsOf(slug, 'meetings.brief')).toBe(0);
  });

  await test.step('one click on one event makes one run: the sentence that quotes its fact is kept, the other three are dropped and counted', async () => {
    const first = event('Giao ban đầu tuần');
    await first.getByTestId('brief-write').click();
    const sentences = first.getByTestId('brief-sentence');
    await expect(sentences).toHaveCount(1);
    // The fact reaches the model with a lead of its own ("Decision of the last meeting: "), and the fake model writes the fact as it is.
    await expect(sentences.nth(0)).toContainText('Đã chốt: Decision of the last meeting: Chốt giá gói kế toán 15.000.000 đồng');
    await expect(sentences.nth(0)).toContainText('Căn cứ: 1');
    const answer = first.getByTestId('brief-answer');
    await expect(answer).toContainText('Đã bỏ 3 câu vì không có mục nào ở trên xác nhận.');
    await expect(answer).not.toContainText('999.000.000');
    await expect(answer).not.toContainText('example.com');
    await expect(answer).not.toContainText('đồng ý với mọi điều khoản');
    // The other events got nothing: one click, one run.
    await expect(page.getByTestId('brief-answer')).toHaveCount(1);
    expect(runsOf(slug, 'meetings.brief')).toBe(1);
  });

  await test.step('nothing but counts is stored for the run', async () => {
    const rows = runRows(slug, 'meetings.brief');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('ready');
    expect(rows[0]?.body ?? '').not.toContain('15.000.000');
    expect(rows[0]?.body ?? '').not.toContain('Chốt giá');
  });

  await test.step('when every sentence fails the checks Vy has nothing to add for that event', async () => {
    const second = event('Họp khách C');
    await second.getByTestId('brief-write').click();
    await expect(second.getByTestId('brief-none')).toContainText('Vy không có gì thêm để viết từ những mục này.');
    await expect(second.getByTestId('brief-sentence')).toHaveCount(0);
    expect(runsOf(slug, 'meetings.brief')).toBe(2);
  });

  await test.step('when the model service is down the member is told in words, and the run says it failed with a code', async () => {
    const third = event('Họp nhà cung cấp');
    await third.getByTestId('brief-write').click();
    await expect(third.getByTestId('brief-failed')).toContainText('Vy chưa viết được lần này.');
    await expect(third.getByTestId('brief-failed')).toContainText('Dịch vụ AI trả lời không đúng.');
    await expect(third.getByTestId('brief-sentence')).toHaveCount(0);
    const rows = runRows(slug, 'meetings.brief');
    expect(rows).toHaveLength(3);
    expect(rows[2]).toMatchObject({ status: 'failed', error_code: 'BRIEF_FAILED' });
    // The first event's answer is still there, and nothing else ran.
    await expect(event('Giao ban đầu tuần').getByTestId('brief-answer')).toBeVisible();
  });
});
